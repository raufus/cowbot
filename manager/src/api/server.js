import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import bodyParser from 'body-parser';
import Stripe from 'stripe';
import fetch from 'node-fetch';
import path from 'path';
import pm2 from 'pm2';
import { exec } from 'child_process';
import fs from 'fs';
import Database from 'better-sqlite3';

const app = express();
const PORT = process.env.PORT || 5000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const LOG_DIR = process.env.LOG_DIR || './data/logs';
const DB_PATH = process.env.SQLITE_PATH || './data/manager.db';
const MANAGER_BOT_TOKEN = process.env.DISCORD_TOKEN || '';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const USE_DOCKER = (process.env.USE_DOCKER || '').toLowerCase() === 'true';
// Simple plan limits (MVP): free=1 bot, paid=5 bots
const FREE_MAX_BOTS = Number(process.env.FREE_MAX_BOTS || 1);
const PAID_MAX_BOTS = Number(process.env.PAID_MAX_BOTS || 5);

// Ensure data directories exist
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

// DB setup
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id TEXT UNIQUE NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS bots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_discord_id TEXT NOT NULL,
  name TEXT,
  token TEXT,
  status TEXT DEFAULT 'stopped',
  pm2_name TEXT UNIQUE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id TEXT NOT NULL,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  status TEXT,
  current_period_end INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS webhook_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT,
  type TEXT,
  received_at TEXT DEFAULT CURRENT_TIMESTAMP,
  raw TEXT
);
-- Per-bot settings table
CREATE TABLE IF NOT EXISTS bot_settings (
  bot_id INTEGER PRIMARY KEY,
  prefix TEXT,
  features TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(bot_id) REFERENCES bots(id) ON DELETE CASCADE
);
`);

// Parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(process.env.COOKIE_SECRET || 'crowbot-dev-secret'));
app.get('/health', (_req, res) => res.json({ ok: true }));

// Stripe
const stripeSecret = process.env.STRIPE_SECRET || '';
const stripe = stripeSecret ? new Stripe(stripeSecret) : null;
const PRODUCT_ID = process.env.PRODUCT_ID || '';

// Optional Discord OAuth for customer auth (MVP)
const OAUTH_CLIENT_ID = process.env.DISCORD_OAUTH_CLIENT_ID || '';
const OAUTH_CLIENT_SECRET = process.env.DISCORD_OAUTH_CLIENT_SECRET || '';
const OAUTH_REDIRECT_URI = process.env.DISCORD_OAUTH_REDIRECT_URI || `${BASE_URL}/auth/callback`;

function oauthEnabled() {
  return Boolean(OAUTH_CLIENT_ID && OAUTH_CLIENT_SECRET);
}

app.get('/auth/login', (req, res) => {
  if (!oauthEnabled()) return res.status(501).send('OAuth not configured');
  const scope = encodeURIComponent('identify');
  const redirect = encodeURIComponent(OAUTH_REDIRECT_URI);
  const url = `https://discord.com/api/oauth2/authorize?response_type=code&client_id=${OAUTH_CLIENT_ID}&scope=${scope}&redirect_uri=${redirect}`;
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  try {
    if (!oauthEnabled()) return res.status(501).send('OAuth not configured');
    const code = req.query.code;
    if (!code) return res.status(400).send('Missing code');
    // Exchange code
    const params = new URLSearchParams();
    params.set('client_id', OAUTH_CLIENT_ID);
    params.set('client_secret', OAUTH_CLIENT_SECRET);
    params.set('grant_type', 'authorization_code');
    params.set('code', String(code));
    params.set('redirect_uri', OAUTH_REDIRECT_URI);
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });
    if (!tokenRes.ok) return res.status(400).send('OAuth token exchange failed');
    const tokenData = await tokenRes.json();
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `${tokenData.token_type} ${tokenData.access_token}` }
    });
    if (!userRes.ok) return res.status(400).send('OAuth user fetch failed');
    const user = await userRes.json();
    // Set signed cookie and redirect to panel
    res.cookie('discord_id', user.id, { httpOnly: true, signed: true });
    // Ensure user exists
    db.prepare('INSERT OR IGNORE INTO users(discord_id) VALUES (?)').run(user.id);
    res.redirect(`/panel`);
  } catch (e) {
    res.status(500).send('OAuth error');
  }
});

// Utility: DM a user via Discord REST without logging a gateway client
async function sendDM(discordId, content) {
  if (!MANAGER_BOT_TOKEN) return;
  try {
    // Create DM channel
    const chRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${MANAGER_BOT_TOKEN}` },
      body: JSON.stringify({ recipient_id: discordId })
    });
    if (!chRes.ok) return;
    const channel = await chRes.json();
    await fetch(`https://discord.com/api/v10/channels/${channel.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${MANAGER_BOT_TOKEN}` },
      body: JSON.stringify({ content })
    });
  } catch (e) {
    console.warn('sendDM failed', e.message);
  }
}

app.post('/api/checkout', async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
    const { discordId } = req.body;
    if (!discordId) return res.status(400).json({ error: 'discordId required' });
    // Determine price: prefer STRIPE_PRICE_ID, otherwise resolve via PRODUCT_ID
    let priceId = process.env.STRIPE_PRICE_ID;
    if (!priceId && PRODUCT_ID) {
      const prices = await stripe.prices.list({ product: PRODUCT_ID, active: true, limit: 1 });
      priceId = prices.data?.[0]?.id || '';
    }
    if (!priceId) return res.status(500).json({ error: 'No Stripe price configured' });
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      success_url: `${BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/cancel`,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { discordId }
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('checkout error', e);
    res.status(500).json({ error: 'checkout failed' });
  }
});

// Stripe webhook requires raw body
app.post('/api/stripe/webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe) return res.status(500).end();
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed.', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  try {
    db.prepare('INSERT INTO webhook_logs(event_id, type, raw) VALUES (?, ?, ?)')
      .run(event.id, event.type, JSON.stringify(event));
    const data = event.data.object;
    if (event.type === 'checkout.session.completed') {
      const discordId = data.metadata?.discordId;
      if (discordId) {
        db.prepare('INSERT OR IGNORE INTO users(discord_id) VALUES (?)').run(discordId);
        // Save subscription/customer if available via session
        const customer = data.customer;
        const subscriptionId = data.subscription;
        if (customer && subscriptionId) {
          db.prepare(`INSERT INTO subscriptions(discord_id, stripe_customer_id, stripe_subscription_id, status, current_period_end)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(discord_id) DO UPDATE SET stripe_customer_id=excluded.stripe_customer_id, stripe_subscription_id=excluded.stripe_subscription_id, status=excluded.status, current_period_end=excluded.current_period_end`)
            .run(discordId, customer, subscriptionId, 'active', null);
        }
        sendDM(discordId, '✅ Paiement confirmé. Utilisez /mybots pour voir vos bots, puis /changetoken et /start pour démarrer votre bot.');
      }
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.created') {
      const sub = event.data.object;
      const discordId = sub.metadata?.discordId; // if you set it on subscription
      if (discordId) {
        db.prepare(`INSERT INTO subscriptions(discord_id, stripe_customer_id, stripe_subscription_id, status, current_period_end)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(discord_id) DO UPDATE SET status=excluded.status, current_period_end=excluded.current_period_end, stripe_customer_id=excluded.stripe_customer_id, stripe_subscription_id=excluded.stripe_subscription_id`)
          .run(discordId, sub.customer, sub.id, sub.status, sub.current_period_end);
        // Enable bot(s)
        const bots = db.prepare('SELECT * FROM bots WHERE owner_discord_id = ?').all(discordId);
        bots.forEach(b => ensureBotRunning(b));
        sendDM(discordId, '🟢 Abonnement actif. Vos bots ont été activés.');
      }
    } else if (event.type === 'invoice.payment_failed' || event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const discordId = sub.metadata?.discordId || null;
      if (discordId) {
        // Disable all bots for this user
        const bots = db.prepare('SELECT * FROM bots WHERE owner_discord_id = ?').all(discordId);
        bots.forEach(b => stopBot(b));
        sendDM(discordId, '🔴 Paiement échoué. Vos bots ont été désactivés. Mettez à jour votre paiement pour les réactiver.');
      }
    }
  } catch (e) {
    console.error('webhook handling failed', e);
  }
  res.json({ received: true });
});

// Bot lifecycle endpoints
app.post('/api/bots', (req, res) => {
  const { discordId, name } = req.body;
  if (!discordId) return res.status(400).json({ error: 'discordId required' });

  // Enforce plan limits: determine if user is paid
  const sub = db.prepare('SELECT status FROM subscriptions WHERE discord_id = ? ORDER BY id DESC LIMIT 1').get(discordId);
  const isPaid = sub?.status === 'active';
  const maxBots = isPaid ? PAID_MAX_BOTS : FREE_MAX_BOTS;
  const currentCount = db.prepare('SELECT COUNT(1) AS c FROM bots WHERE owner_discord_id = ?').get(discordId)?.c || 0;
  if (currentCount >= maxBots) {
    return res.status(403).json({ error: `plan limit reached (${currentCount}/${maxBots})` });
  }

  const info = db.prepare('INSERT INTO bots(owner_discord_id, name, pm2_name, status) VALUES (?, ?, ?, ?)')
    .run(discordId, name || 'CrowBot', `bot_${discordId}_${Date.now()}`, 'stopped');
  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(info.lastInsertRowid);
  // Initialize settings with defaults
  db.prepare('INSERT OR IGNORE INTO bot_settings(bot_id, prefix, features) VALUES (?, ?, ?)')
    .run(bot.id, null, JSON.stringify({ moderation: true, utilitaire: true, antiraid: true, logs: true, backup: true, gestion: true, botcontrol: true }));
  res.json(bot);
});

app.post('/api/bots/:id/token', (req, res) => {
  const { token } = req.body;
  const id = req.params.id;
  if (!token) return res.status(400).json({ error: 'token required' });
  db.prepare('UPDATE bots SET token = ? WHERE id = ?').run(token, id);
  res.json({ ok: true });
});

// Minimal Customer Panel (no auth for MVP; uses discord_id query param)
app.get(['/panel', '/customer'], (req, res) => {
  // Determine user either from OAuth cookie or query (back-compat)
  let discordId = null;
  if (oauthEnabled()) {
    discordId = req.signedCookies?.discord_id || null;
    if (!discordId) return res.redirect('/auth/login');
  } else {
    discordId = req.query.discord_id;
    if (!discordId) return res.status(400).send('Missing discord_id');
  }
  const user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId);
  const bots = db.prepare('SELECT * FROM bots WHERE owner_discord_id = ?').all(discordId);
  const sub = db.prepare('SELECT * FROM subscriptions WHERE discord_id = ?').get(discordId);
  const html = `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CrowBot Dashboard</title>
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      color: #333;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
    }
    .header {
      background: rgba(255, 255, 255, 0.95);
      backdrop-filter: blur(10px);
      border-radius: 20px;
      padding: 30px;
      margin-bottom: 30px;
      box-shadow: 0 8px 32px rgba(31, 38, 135, 0.37);
      border: 1px solid rgba(255, 255, 255, 0.18);
    }
    .header h1 {
      color: #4c63d2;
      font-size: 2.5rem;
      margin-bottom: 10px;
      display: flex;
      align-items: center;
      gap: 15px;
    }
    .header .user-info {
      color: #666;
      font-size: 1.1rem;
    }
    .card {
      background: rgba(255, 255, 255, 0.95);
      backdrop-filter: blur(10px);
      border-radius: 20px;
      padding: 30px;
      margin-bottom: 30px;
      box-shadow: 0 8px 32px rgba(31, 38, 135, 0.37);
      border: 1px solid rgba(255, 255, 255, 0.18);
      transition: transform 0.3s ease, box-shadow 0.3s ease;
    }
    .card:hover {
      transform: translateY(-5px);
      box-shadow: 0 15px 40px rgba(31, 38, 135, 0.5);
    }
    .card h3 {
      color: #4c63d2;
      font-size: 1.8rem;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .billing-status {
      display: flex;
      align-items: center;
      gap: 15px;
      margin: 20px 0;
      padding: 15px;
      border-radius: 12px;
      background: ${sub?.status === 'active' ? 'linear-gradient(45deg, #a8edea 0%, #fed6e3 100%)' : 'linear-gradient(45deg, #ffecd2 0%, #fcb69f 100%)'};
    }
    .status-indicator {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: ${sub?.status === 'active' ? '#4CAF50' : '#FF9800'};
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0% { opacity: 1; }
      50% { opacity: 0.5; }
      100% { opacity: 1; }
    }
    .btn-row {
      display: flex;
      gap: 15px;
      flex-wrap: wrap;
      margin-top: 20px;
    }
    .btn {
      padding: 12px 24px;
      border: none;
      border-radius: 12px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.3s ease;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 140px;
      justify-content: center;
    }
    .btn-primary {
      background: linear-gradient(45deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 25px rgba(102, 126, 234, 0.4);
    }
    .btn-success {
      background: linear-gradient(45deg, #4CAF50 0%, #8BC34A 100%);
      color: white;
    }
    .btn-success:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 25px rgba(76, 175, 80, 0.4);
    }
    .btn-danger {
      background: linear-gradient(45deg, #f44336 0%, #e91e63 100%);
      color: white;
    }
    .btn-danger:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 25px rgba(244, 67, 54, 0.4);
    }
    .btn-info {
      background: linear-gradient(45deg, #2196F3 0%, #21CBF3 100%);
      color: white;
    }
    .btn-info:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 25px rgba(33, 150, 243, 0.4);
    }
    .bot-card {
      background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
      border-radius: 15px;
      padding: 25px;
      margin: 20px 0;
      border-left: 5px solid #4c63d2;
    }
    .bot-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
    }
    .bot-info h4 {
      color: #4c63d2;
      font-size: 1.4rem;
      margin-bottom: 5px;
    }
    .bot-status {
      padding: 8px 16px;
      border-radius: 20px;
      font-weight: bold;
      text-transform: uppercase;
      font-size: 0.8rem;
      letter-spacing: 1px;
    }
    .status-running {
      background: linear-gradient(45deg, #4CAF50, #8BC34A);
      color: white;
    }
    .status-stopped {
      background: linear-gradient(45deg, #f44336, #e91e63);
      color: white;
    }
    .token-form {
      margin: 20px 0;
    }
    .form-group {
      margin-bottom: 15px;
    }
    .form-group label {
      display: block;
      margin-bottom: 8px;
      color: #555;
      font-weight: 600;
    }
    .form-control {
      width: 100%;
      padding: 12px 16px;
      border: 2px solid #e1e5e9;
      border-radius: 10px;
      font-size: 1rem;
      transition: border-color 0.3s ease;
    }
    .form-control:focus {
      outline: none;
      border-color: #4c63d2;
      box-shadow: 0 0 0 3px rgba(76, 99, 210, 0.1);
    }
    .bot-controls {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 20px;
    }
    .loading {
      display: none;
      text-align: center;
      padding: 20px;
    }
    .spinner {
      border: 3px solid #f3f3f3;
      border-top: 3px solid #4c63d2;
      border-radius: 50%;
      width: 30px;
      height: 30px;
      animation: spin 1s linear infinite;
      margin: 0 auto 10px;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    @media (max-width: 768px) {
      .header h1 { font-size: 2rem; }
      .container { padding: 15px; }
      .btn-row { flex-direction: column; }
      .bot-header { flex-direction: column; gap: 15px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1><i class="fas fa-robot"></i> CrowBot Dashboard</h1>
      <p class="user-info"><i class="fas fa-user"></i> Connecté en tant que: <strong>${discordId}</strong></p>
    </div>

    <div class="card">
      <h3><i class="fas fa-credit-card"></i> Facturation</h3>
      <div class="billing-status">
        <div class="status-indicator"></div>
        <div>
          <strong>Statut: ${sub?.status || 'Aucun abonnement'}</strong>
          ${sub?.current_period_end ? '<br><small>Valide jusqu\'au: '+new Date((sub.current_period_end||0)*1000).toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' })+'</small>' : ''}
        </div>
      </div>
      <div class="btn-row">
        ${stripe ? `
          <a class="btn btn-primary" href="/api/checkout/link?discord_id=${encodeURIComponent(discordId)}">
            <i class="fas fa-shopping-cart"></i> Acheter/S'abonner
          </a>
          <a class="btn btn-info" href="/billing/portal?discord_id=${encodeURIComponent(discordId)}">
            <i class="fas fa-cog"></i> Gérer la facturation
          </a>
        ` : `
          <a class="btn btn-primary" style="opacity:.6;pointer-events:none" href="#" title="Stripe non configuré">
            <i class="fas fa-shopping-cart"></i> Acheter/S'abonner
          </a>
          <a class="btn btn-info" style="opacity:.6;pointer-events:none" href="#" title="Stripe non configuré">
            <i class="fas fa-cog"></i> Gérer la facturation
          </a>
        `}
      </div>
    </div>

    <div class="card">
      <h3><i class="fas fa-bots"></i> Vos Bots</h3>
      ${bots.length ? bots.map(b => `
        <div class="bot-card">
          <div class="bot-header">
            <div class="bot-info">
              <h4><i class="fas fa-robot"></i> ${b.name || 'CrowBot'} #${b.id}</h4>
              <small class="text-muted">ID: ${b.pm2_name}</small>
            </div>
            <span class="bot-status ${b.status === 'running' ? 'status-running' : 'status-stopped'}">
              <i class="fas fa-${b.status === 'running' ? 'play' : 'stop'}"></i> ${b.status === 'running' ? 'En ligne' : 'Arrêté'}
            </span>
          </div>
          
          <form method="post" action="/panel/bot/${b.id}/token" class="token-form">
            <div class="form-group">
              <label for="token-${b.id}"><i class="fas fa-key"></i> Token du Bot:</label>
              <input type="password" id="token-${b.id}" name="token" class="form-control" placeholder="Entrez le token de votre bot Discord" />
            </div>
            <button class="btn btn-primary" type="submit">
              <i class="fas fa-save"></i> Sauvegarder Token
            </button>
          </form>

          <form method="post" action="/api/bots/${b.id}/settings" class="token-form" onsubmit="return saveSettings(event, ${b.id})">
            <div class="form-group">
              <label for="prefix-${b.id}"><i class="fas fa-hashtag"></i> Préfixe:</label>
              <input type="text" id="prefix-${b.id}" name="prefix" class="form-control" placeholder="ex: !" />
            </div>
            <div class="form-group">
              <label><i class="fas fa-toggle-on"></i> Modules:</label>
              <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px">
                <label><input type="checkbox" name="features.moderation" checked /> Moderation</label>
                <label><input type="checkbox" name="features.utilitaire" checked /> Utilitaire</label>
                <label><input type="checkbox" name="features.antiraid" checked /> AntiRaid</label>
                <label><input type="checkbox" name="features.logs" checked /> Logs</label>
                <label><input type="checkbox" name="features.backup" checked /> Backup</label>
                <label><input type="checkbox" name="features.gestion" checked /> Gestion</label>
                <label><input type="checkbox" name="features.botcontrol" checked /> Bot Control</label>
              </div>
            </div>
            <button class="btn btn-primary" type="submit">
              <i class="fas fa-save"></i> Sauvegarder Réglages
            </button>
          </form>
          
          <div class="bot-controls">
            <form method="post" action="/panel/bot/${b.id}/start" style="display: inline;">
              <button class="btn btn-success" type="submit">
                <i class="fas fa-play"></i> Démarrer
              </button>
            </form>
            <form method="post" action="/panel/bot/${b.id}/stop" style="display: inline;">
              <button class="btn btn-danger" type="submit">
                <i class="fas fa-stop"></i> Arrêter
              </button>
            </form>
            <a class="btn btn-info" href="/panel/bot/${b.id}/logs">
              <i class="fas fa-file-alt"></i> Voir les logs
            </a>
            <a class="btn btn-info" href="/panel/bot/${b.id}/metrics" target="_blank">
              <i class="fas fa-chart-line"></i> Metrics
            </a>
          </div>
        </div>
      `).join('') : '<div class="bot-card"><h4><i class="fas fa-info-circle"></i> Aucun bot trouvé</h4><p>Utilisez <strong>/buy</strong> dans Discord pour commencer, puis <strong>/mybots</strong> pour voir vos bots.</p></div>'}
    </div>
    
    <div class="loading">
      <div class="spinner"></div>
      <p>Chargement...</p>
    </div>
  </div>

  <script>
    // Add loading states for forms
    document.querySelectorAll('form').forEach(form => {
      form.addEventListener('submit', function() {
        document.querySelector('.loading').style.display = 'block';
      });
    });
    
    // Auto-refresh page every 30 seconds
    setTimeout(() => {
      window.location.reload();
    }, 30000);

    async function saveSettings(ev, botId){
      ev.preventDefault();
      const form = ev.target;
      const prefixInput = form.querySelector('[name="prefix"]');
      const prefix = prefixInput ? (prefixInput.value || '').trim() || null : null;
      const features = {
        moderation: !!(form.querySelector('[name="features.moderation"]') && form.querySelector('[name="features.moderation"]').checked),
        utilitaire: !!(form.querySelector('[name="features.utilitaire"]') && form.querySelector('[name="features.utilitaire"]').checked),
        antiraid: !!(form.querySelector('[name="features.antiraid"]') && form.querySelector('[name="features.antiraid"]').checked),
        logs: !!(form.querySelector('[name="features.logs"]') && form.querySelector('[name="features.logs"]').checked),
        backup: !!(form.querySelector('[name="features.backup"]') && form.querySelector('[name="features.backup"]').checked),
        gestion: !!(form.querySelector('[name="features.gestion"]') && form.querySelector('[name="features.gestion"]').checked),
        botcontrol: !!(form.querySelector('[name="features.botcontrol"]') && form.querySelector('[name="features.botcontrol"]').checked)
      };
      await fetch('/api/bots/' + botId + '/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefix: prefix, features: features })
      });
      alert('Réglages enregistrés');
      return false;
    }
  </script>
</body>
</html>`;
  res.set('Content-Type','text/html').send(html);
});

// Customer actions via HTML forms
app.post('/panel/bot/:id/token', (req, res) => {
  const id = Number(req.params.id);
  const token = req.body.token || '';
  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(id);
  if (!bot) return res.status(404).send('Not found');
  db.prepare('UPDATE bots SET token = ? WHERE id = ?').run(token, id);
  res.redirect('back');
});

app.post('/panel/bot/:id/start', (req, res) => {
  req.params.id && db.prepare('SELECT 1').get(); // keep db handle warm
  req.originalUrl; // noop
  // call existing start handler via local request logic
  const id = Number(req.params.id);
  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(id);
  if (!bot) return res.status(404).send('Not found');
  try {
    // Enforce plan at start-time too
    const sub = db.prepare('SELECT status FROM subscriptions WHERE discord_id = ? ORDER BY id DESC LIMIT 1').get(bot.owner_discord_id);
    const isPaid = sub?.status === 'active';
    const maxBots = isPaid ? PAID_MAX_BOTS : FREE_MAX_BOTS;
    const runningCount = db.prepare("SELECT COUNT(1) AS c FROM bots WHERE owner_discord_id = ? AND status = 'running'").get(bot.owner_discord_id)?.c || 0;
    if (runningCount >= maxBots) return res.status(403).send(`Plan limit reached (${runningCount}/${maxBots})`);
    ensureBotRunning(bot);
    res.redirect('back');
  } catch (e) {
    res.status(500).send('Start failed: '+e.message);
  }
});

app.post('/panel/bot/:id/stop', (req, res) => {
  const id = Number(req.params.id);
  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(id);
  if (!bot) return res.status(404).send('Not found');
  try {
    stopBot(bot);
    res.redirect('back');
  } catch (e) {
    res.status(500).send('Stop failed: '+e.message);
  }
});

app.get('/panel/bot/:id/logs', (req, res) => {
  const id = Number(req.params.id);
  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(id);
  if (!bot) return res.status(404).send('Not found');
  try {
    const outPath = path.join(LOG_DIR, `${bot.pm2_name}.out.log`);
    const errPath = path.join(LOG_DIR, `${bot.pm2_name}.err.log`);
    const out = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
    const err = fs.existsSync(errPath) ? fs.readFileSync(errPath, 'utf8') : '';
    res.set('Content-Type','text/plain').send((out+"\n\n=== ERR ===\n\n"+err).slice(-4000));
  } catch (e) {
    res.status(500).send('Cannot read logs: '+e.message);
  }
});

// Create a checkout link for panel button (GET for convenience)
app.get('/api/checkout/link', async (req, res) => {
  try {
    if (!stripe) return res.status(500).send('Stripe not configured');
    const discordId = req.query.discord_id;
    if (!discordId) return res.status(400).send('discord_id required');
    // Determine price: prefer STRIPE_PRICE_ID, otherwise resolve via PRODUCT_ID
    let priceId = process.env.STRIPE_PRICE_ID;
    if (!priceId && PRODUCT_ID) {
      const prices = await stripe.prices.list({ product: PRODUCT_ID, active: true, limit: 1 });
      priceId = prices.data?.[0]?.id || '';
    }
    if (!priceId) return res.status(500).send('No Stripe price configured');
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      success_url: `${BASE_URL}/panel?discord_id=${encodeURIComponent(discordId)}`,
      cancel_url: `${BASE_URL}/panel?discord_id=${encodeURIComponent(discordId)}`,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { discordId },
    });
    res.redirect(session.url);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// Stripe customer portal
app.get('/billing/portal', async (req, res) => {
  try {
    if (!stripe) return res.status(500).send('Stripe not configured');
    const discordId = req.query.discord_id;
    if (!discordId) return res.status(400).send('discord_id required');
    const sub = db.prepare('SELECT * FROM subscriptions WHERE discord_id = ?').get(discordId);
    if (!sub?.stripe_customer_id) return res.status(400).send('No customer found. Purchase first.');
    const portal = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${BASE_URL}/panel?discord_id=${encodeURIComponent(discordId)}`,
    });
    res.redirect(portal.url);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// Minimal Admin Panel (simple key check)
app.get(['/admin', '/panel/admin'], (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.status(401).send('Unauthorized');
  const users = db.prepare('SELECT * FROM users').all();
  const bots = db.prepare('SELECT * FROM bots').all();
  const subs = db.prepare('SELECT * FROM subscriptions').all();
  const logs = db.prepare('SELECT id, event_id, type, received_at FROM webhook_logs ORDER BY id DESC LIMIT 50').all();
  const html = `<!doctype html>
  <html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CrowBot Admin Dashboard</title>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        background: linear-gradient(135deg, #1e3c72 0%, #2a5298 100%);
        min-height: 100vh;
        color: #fff;
      }
      .container {
        max-width: 1400px;
        margin: 0 auto;
        padding: 20px;
      }
      .header {
        background: rgba(255, 255, 255, 0.1);
        backdrop-filter: blur(10px);
        border-radius: 20px;
        padding: 30px;
        margin-bottom: 30px;
        border: 1px solid rgba(255, 255, 255, 0.2);
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .header h1 {
        color: #fff;
        font-size: 2.5rem;
        display: flex;
        align-items: center;
        gap: 15px;
      }
      .admin-badge {
        background: linear-gradient(45deg, #ff6b6b, #ee5a24);
        padding: 8px 16px;
        border-radius: 20px;
        font-size: 0.9rem;
        font-weight: bold;
      }
      .stats-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
        gap: 20px;
        margin-bottom: 30px;
      }
      .stat-card {
        background: rgba(255, 255, 255, 0.1);
        backdrop-filter: blur(10px);
        border-radius: 15px;
        padding: 25px;
        border: 1px solid rgba(255, 255, 255, 0.2);
        text-align: center;
        transition: transform 0.3s ease;
      }
      .stat-card:hover {
        transform: translateY(-5px);
      }
      .stat-number {
        font-size: 2.5rem;
        font-weight: bold;
        margin-bottom: 10px;
        background: linear-gradient(45deg, #4facfe, #00f2fe);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        background-clip: text;
      }
      .stat-label {
        font-size: 1.1rem;
        opacity: 0.9;
      }
      .card {
        background: rgba(255, 255, 255, 0.1);
        backdrop-filter: blur(10px);
        border-radius: 20px;
        padding: 30px;
        margin-bottom: 30px;
        border: 1px solid rgba(255, 255, 255, 0.2);
      }
      .card h3 {
        color: #fff;
        font-size: 1.8rem;
        margin-bottom: 20px;
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .table-container {
        overflow-x: auto;
        border-radius: 12px;
        background: rgba(0, 0, 0, 0.2);
      }
      .table {
        width: 100%;
        border-collapse: collapse;
        background: transparent;
      }
      .table th {
        background: rgba(0, 0, 0, 0.3);
        color: #fff;
        padding: 15px 12px;
        text-align: left;
        font-weight: 600;
        font-size: 0.9rem;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .table td {
        padding: 12px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        font-size: 0.9rem;
      }
      .table tr:hover {
        background: rgba(255, 255, 255, 0.05);
      }
      .badge {
        display: inline-block;
        padding: 4px 12px;
        border-radius: 20px;
        font-size: 0.8rem;
        font-weight: bold;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .badge-success {
        background: linear-gradient(45deg, #4CAF50, #8BC34A);
        color: white;
      }
      .badge-danger {
        background: linear-gradient(45deg, #f44336, #e91e63);
        color: white;
      }
      .badge-warning {
        background: linear-gradient(45deg, #ff9800, #ffc107);
        color: white;
      }
      .badge-info {
        background: linear-gradient(45deg, #2196F3, #21CBF3);
        color: white;
      }
      .btn {
        padding: 8px 16px;
        border: none;
        border-radius: 8px;
        font-size: 0.9rem;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.3s ease;
        text-decoration: none;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin: 2px;
      }
      .btn-success {
        background: linear-gradient(45deg, #4CAF50, #8BC34A);
        color: white;
      }
      .btn-danger {
        background: linear-gradient(45deg, #f44336, #e91e63);
        color: white;
      }
      .btn-info {
        background: linear-gradient(45deg, #2196F3, #21CBF3);
        color: white;
      }
      .btn:hover {
        transform: translateY(-2px);
        box-shadow: 0 5px 15px rgba(0, 0, 0, 0.2);
      }
      .action-buttons {
        display: flex;
        gap: 5px;
        flex-wrap: wrap;
      }
      .refresh-btn {
        background: linear-gradient(45deg, #667eea, #764ba2);
        color: white;
        border: none;
        padding: 10px 20px;
        border-radius: 10px;
        cursor: pointer;
        font-weight: 600;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .code {
        font-family: 'Courier New', monospace;
        background: rgba(0, 0, 0, 0.3);
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 0.8rem;
      }
      @media (max-width: 768px) {
        .header {
          flex-direction: column;
          gap: 15px;
          text-align: center;
        }
        .header h1 {
          font-size: 2rem;
        }
        .stats-grid {
          grid-template-columns: 1fr;
        }
        .table-container {
          font-size: 0.8rem;
        }
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h1><i class="fas fa-shield-alt"></i> CrowBot Admin Dashboard</h1>
        <div class="admin-badge">
          <i class="fas fa-crown"></i> Administrateur
        </div>
      </div>
      
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-number">${users.length}</div>
          <div class="stat-label"><i class="fas fa-users"></i> Utilisateurs</div>
        </div>
        <div class="stat-card">
          <div class="stat-number">${bots.length}</div>
          <div class="stat-label"><i class="fas fa-robot"></i> Bots Total</div>
        </div>
        <div class="stat-card">
          <div class="stat-number">${bots.filter(b => b.status === 'running').length}</div>
          <div class="stat-label"><i class="fas fa-play"></i> Bots Actifs</div>
        </div>
        <div class="stat-card">
          <div class="stat-number">${subs.filter(s => s.status === 'active').length}</div>
          <div class="stat-label"><i class="fas fa-credit-card"></i> Abonnements</div>
        </div>
      </div>
        <div class="toolbar">
          <a class="btn" href="/health" target="_blank">Health</a>
          <button class="btn" onclick="location.reload()">Refresh</button>
        </div>
      </header>

      <section class="grid">
        <div class="card half">
          <h3>Users</h3>
          <table class="table">
            <thead><tr><th>discord_id</th><th>created_at</th></tr></thead>
            <tbody>
              ${users.map(u=>`<tr><td><code>${u.discord_id}</code></td><td>${u.created_at}</td></tr>`).join('')}
            </tbody>
          </table>
        </div>

        <div class="card half">
          <h3>Bots</h3>
          <div class="muted" style="margin-bottom:8px">Total: ${bots.length}</div>
          <table class="table">
            <thead><tr><th>id</th><th>owner</th><th>name</th><th>status</th><th>pm2</th><th>created</th><th style="width:260px">actions</th></tr></thead>
            <tbody>
              ${bots.map(b=>`<tr>
                <td>${b.id}</td>
                <td><code>${b.owner_discord_id}</code></td>
                <td>${b.name||''}</td>
                <td><span class="badge ${b.status==='running'?'status-running':'status-stopped'}">${b.status}</span></td>
                <td><code>${b.pm2_name||''}</code></td>
                <td>${b.created_at||''}</td>
                <td>
                  <div style="display:flex;flex-wrap:wrap;gap:6px">
                    <button class="btn" onclick="startBot(${b.id})">Start</button>
                    <button class="btn" onclick="stopBot(${b.id})">Stop</button>
                    <a class="btn" href="/panel/bot/${b.id}/logs" target="_blank">Logs</a>
                    <button class="btn" onclick="setToken(${b.id})">Set Token</button>
                  </div>
                </td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>

        <div class="card half">
          <h3>Subscriptions</h3>
          <table class="table">
            <thead><tr><th>discord_id</th><th>status</th><th>customer</th><th>subscription</th><th>period_end</th></tr></thead>
            <tbody>
              ${subs.map(s=>`<tr>
                <td><code>${s.discord_id}</code></td>
                <td><span class="pill">${s.status||'none'}</span></td>
                <td><code>${s.stripe_customer_id||''}</code></td>
                <td><code>${s.stripe_subscription_id||''}</code></td>
                <td>${s.current_period_end? new Date(s.current_period_end*1000).toLocaleString(): ''}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>

        <div class="card half">
          <h3>Webhook Logs</h3>
          <table class="table">
            <thead><tr><th>id</th><th>event</th><th>type</th><th>received</th></tr></thead>
            <tbody>
              ${logs.map(l=>`<tr>
                <td>${l.id}</td>
                <td><code>${l.event_id}</code></td>
                <td>${l.type}</td>
                <td>${l.received_at}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>

        <div class="card" style="grid-column:span 12">
          <h3>Create Bot</h3>
          <form onsubmit="return createBot(event)">
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <input id="newOwner" type="text" placeholder="owner discord_id" style="flex:1;min-width:240px;padding:8px;border-radius:8px;border:1px solid var(--ring);background:#0b1220;color:var(--fg)" />
              <input id="newName" type="text" placeholder="bot name (optional)" style="flex:1;min-width:200px;padding:8px;border-radius:8px;border:1px solid var(--ring);background:#0b1220;color:var(--fg)" />
              <button class="btn" type="submit">Create</button>
            </div>
          </form>
          <p class="muted" style="margin-top:8px">After creating, use “Set Token”, then Start.</p>
        </div>
      </section>
    </div>
    <script>
      async function postJson(url, body){
        const res = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body: JSON.stringify(body||{})});
        if(!res.ok){
          const text = await res.text();
          throw new Error(text || ('HTTP '+res.status));
        }
        return res.json().catch(()=>({ok:true}));
      }
      async function startBot(id){
        try{ await postJson('/api/bots/'+id+'/start'); location.reload(); }
        catch(e){ alert('Start failed: '+e.message); }
      }
      async function stopBot(id){
        try{ await postJson('/api/bots/'+id+'/stop'); location.reload(); }
        catch(e){ alert('Stop failed: '+e.message); }
      }
      async function setToken(id){
        const token = prompt('Enter bot token');
        if(!token) return;
        try{ await postJson('/api/bots/'+id+'/token', { token }); alert('Token saved. Start the bot.'); }
        catch(e){ alert('Save failed: '+e.message); }
      }
      async function createBot(ev){
        ev.preventDefault();
        const owner = document.getElementById('newOwner').value.trim();
        const name = document.getElementById('newName').value.trim();
        if(!owner){ alert('owner discord_id is required'); return false; }
        try{ await postJson('/api/bots', { discordId: owner, name }); location.reload(); }
        catch(e){ alert('Create failed: '+e.message); }
        return false;
      }
    </script>
  </body>
  </html>`;
  res.set('Content-Type','text/html').send(html);
});

app.post('/api/bots/:id/start', (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(req.params.id);
  if (!bot) return res.status(404).json({ error: 'bot not found' });
  // Enforce plan
  const sub = db.prepare('SELECT status FROM subscriptions WHERE discord_id = ? ORDER BY id DESC LIMIT 1').get(bot.owner_discord_id);
  const isPaid = sub?.status === 'active';
  const maxBots = isPaid ? PAID_MAX_BOTS : FREE_MAX_BOTS;
  const runningCount = db.prepare("SELECT COUNT(1) AS c FROM bots WHERE owner_discord_id = ? AND status = 'running'").get(bot.owner_discord_id)?.c || 0;
  if (runningCount >= maxBots) return res.status(403).json({ error: `plan limit reached (${runningCount}/${maxBots})` });
  ensureBotRunning(bot, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    const updated = db.prepare('SELECT * FROM bots WHERE id = ?').get(req.params.id);
    res.json({ ok: true, bot: updated });
  });
});

app.post('/api/bots/:id/stop', (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(req.params.id);
  if (!bot) return res.status(404).json({ error: 'bot not found' });
  stopBot(bot, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

app.get('/api/bots/:id', (req, res) => {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(req.params.id);
  if (!bot) return res.status(404).json({ error: 'bot not found' });
  res.json(bot);
});

// List bots by owner
app.get('/api/bots', (req, res) => {
  const owner = req.query.owner;
  if (owner) {
    const bots = db.prepare('SELECT * FROM bots WHERE owner_discord_id = ? ORDER BY id DESC').all(owner);
    return res.json(bots);
  }
  const bots = db.prepare('SELECT * FROM bots ORDER BY id DESC').all();
  const users = db.prepare('SELECT DISTINCT owner_discord_id FROM bots').all();
  res.json(bots);
});

// --- Bot settings API ---
app.post('/api/bots/:id/settings', (req, res) => {
  const id = Number(req.params.id);
  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(id);
  if (!bot) return res.status(404).json({ error: 'bot not found' });
  const { prefix, features } = req.body || {};
  const featuresStr = features ? JSON.stringify(features) : undefined;
  const stmt = db.prepare('INSERT INTO bot_settings(bot_id, prefix, features) VALUES(?, ?, ?) ON CONFLICT(bot_id) DO UPDATE SET prefix=COALESCE(excluded.prefix, bot_settings.prefix), features=COALESCE(excluded.features, bot_settings.features), updated_at=CURRENT_TIMESTAMP');
  stmt.run(id, prefix ?? null, featuresStr ?? null);
  res.json({ ok: true });
});

app.get('/api/bots/:id/settings', (req, res) => {
  const id = Number(req.params.id);
  const s = db.prepare('SELECT prefix, features FROM bot_settings WHERE bot_id = ?').get(id) || { prefix: null, features: null };
  try { s.features = s.features ? JSON.parse(s.features) : null; } catch { s.features = null; }
  res.json(s);
});

function ensureBotRunning(bot, cb = () => {}) {
  if (!bot.token) return cb(new Error('token not set'));
  const commandsRoot = process.env.COMMANDS_DIR || path.resolve(process.cwd(), '..');
  const logsDirAbs = path.resolve(LOG_DIR);
  // Read per-bot settings
  const settings = db.prepare('SELECT prefix, features FROM bot_settings WHERE bot_id = ?').get(bot.id) || {};
  let defaultPrefix = settings?.prefix || process.env.DEFAULT_PREFIX || '+';
  if (USE_DOCKER) {
    // Run a detached container that mounts the whole workspace to keep using host node_modules and command files
    // Redirect stdout/stderr to files under logsDirAbs so the panel Logs view works unchanged
    const image = process.env.DOCKER_NODE_IMAGE || 'node:18-alpine';
    const containerName = bot.pm2_name; // reuse pm2_name as docker name
    const outLog = path.join(logsDirAbs, `${containerName}.out.log`).replace(/\\/g, '/');
    const errLog = path.join(logsDirAbs, `${containerName}.err.log`).replace(/\\/g, '/');
    // On Windows, docker expects drive paths like C:\\ to be quoted; use double quotes around -v arguments
    const hostWorkspace = commandsRoot;
    const workDir = '/workspace/manager';
    const cmd = [
      'docker', 'run', '-d', '--restart', 'unless-stopped',
      '--name', JSON.stringify(containerName),
      '-e', `BOT_TOKEN=${bot.token}`,
      '-e', `OWNER_DISCORD_ID=${bot.owner_discord_id}`,
      '-e', `COMMANDS_DIR=/workspace`,
      '-e', `LOG_DIR=${workDir}/data/logs`,
      '-e', `DEFAULT_PREFIX=${defaultPrefix}`,
      '-v', `"${hostWorkspace}":/workspace`,
      '-w', workDir,
      image,
      'sh', '-c', `node src/runner/bot-runner.js > ${workDir}/data/logs/${containerName}.out.log 2> ${workDir}/data/logs/${containerName}.err.log`
    ].join(' ');
    // Ensure logs dir exists on host
    fs.mkdirSync(logsDirAbs, { recursive: true });
    exec(cmd, (error, stdout, stderr) => {
      if (error) return cb(new Error(`docker run failed: ${error.message}`));
      // Mark running
      db.prepare('UPDATE bots SET status = ? WHERE id = ?').run('running', bot.id);
      cb();
    });
    return;
  }
  // Fallback to PM2
  pm2.connect((err) => {
    if (err) return cb(err);
    const script = path.resolve('src/runner/bot-runner.js');
    pm2.start({
      name: bot.pm2_name,
      script,
      env: {
        BOT_TOKEN: bot.token,
        OWNER_DISCORD_ID: bot.owner_discord_id,
        COMMANDS_DIR: commandsRoot, // root where commands/ live (parent of manager/)
        LOG_DIR: logsDirAbs,
        DEFAULT_PREFIX: defaultPrefix
      },
      out_file: path.join(LOG_DIR, `${bot.pm2_name}.out.log`),
      error_file: path.join(LOG_DIR, `${bot.pm2_name}.err.log`),
      autorestart: true,
      max_restarts: 10
    }, (e) => {
      if (e) return cb(e);
      db.prepare('UPDATE bots SET status = ? WHERE id = ?').run('running', bot.id);
      pm2.disconnect();
      cb();
    });
  });
}

function stopBot(bot, cb = () => {}) {
  if (USE_DOCKER) {
    const cmd = `docker rm -f ${JSON.stringify(bot.pm2_name)}`;
    exec(cmd, (_e) => {
      // Even if removal fails (e.g., container not found), mark stopped
      db.prepare('UPDATE bots SET status = ? WHERE id = ?').run('stopped', bot.id);
      cb();
    });
    return;
  }
  pm2.connect((err) => {
    if (err) return cb(err);
    pm2.delete(bot.pm2_name, (e) => {
      if (e) console.warn('pm2 delete', e.message);
      db.prepare('UPDATE bots SET status = ? WHERE id = ?').run('stopped', bot.id);
      pm2.disconnect();
      cb();
    });
  });
}

app.listen(PORT, () => {
  console.log(`Manager API listening on ${BASE_URL}`);
});

// --- Simple PM2 metrics route for a bot ---
app.get('/panel/bot/:id/metrics', (req, res) => {
  const id = Number(req.params.id);
  const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(id);
  if (!bot) return res.status(404).send('Not found');
  pm2.connect((err) => {
    if (err) return res.status(500).send('PM2 connect failed');
    pm2.describe(bot.pm2_name, (e, list) => {
      pm2.disconnect();
      if (e) return res.status(500).send('PM2 describe failed');
      const info = (list && list[0]) || {};
      const pm2env = info.pm2_env || {};
      const monit = info.monit || {};
      const text = [
        `name: ${bot.pm2_name}`,
        `status: ${pm2env.status}`,
        `restarts: ${pm2env.restart_time}`,
        `uptime_ms: ${Date.now() - (pm2env.pm_uptime || Date.now())}`,
        `cpu: ${monit.cpu}%`,
        `memory: ${monit.memory}`
      ].join('\n');
      res.set('Content-Type','text/plain').send(text);
    });
  });
});
