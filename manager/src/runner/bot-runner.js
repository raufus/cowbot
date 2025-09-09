import 'dotenv/config';
import Discord from 'discord.js';
const { Client, Intents, MessageEmbed } = Discord;
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import Module from 'module';

const token = process.env.BOT_TOKEN || process.env.DISCORD_TOKEN;
const ownerId = process.env.OWNER_DISCORD_ID;
const COMMANDS_ROOT = process.env.COMMANDS_DIR || path.resolve(process.cwd(), '..');
const DATA_DIR = process.env.LOG_DIR || path.resolve('data');
const PREFIX = process.env.DEFAULT_PREFIX || '!';

// Ensure command files (located outside of this package folder) can resolve deps from manager/node_modules
// This augments Node's module resolution paths globally at runtime.
try {
  const extraNodePath = path.resolve('node_modules');
  const delimiter = path.delimiter;
  const existing = process.env.NODE_PATH ? process.env.NODE_PATH.split(delimiter) : [];
  if (!existing.includes(extraNodePath)) {
    process.env.NODE_PATH = [...existing, extraNodePath].filter(Boolean).join(delimiter);
    // Re-initialize module paths so the change takes effect
    Module._initPaths();
  }
} catch (_) {
  // no-op: if this fails, worst case some commands still can't resolve packages
}

// Provide a fallback shim for '../../structures/client' that many commands import for typing.
// We resolve it relative to the COMMANDS_ROOT and prime the require cache so all relative requires work.
try {
  const rootNoop = path.join(COMMANDS_ROOT, '.__noop__.js');
  const rootRequire = createRequire(rootNoop);
  const resolvedClient = rootRequire.resolve('./structures/client');
  const shimModule = { bot: class {} };
  // Prime cache if not already loaded using Module._cache (works in ESM)
  // eslint-disable-next-line no-underscore-dangle
  if (!Module._cache[resolvedClient]) {
    Module._cache[resolvedClient] = { id: resolvedClient, filename: resolvedClient, loaded: true, exports: shimModule };
  }
  // Also prime the absolute paths many command files resolve to: [DriveRoot]/structures/client.js and /index.js
  const driveRoot = path.parse(COMMANDS_ROOT).root; // e.g., 'U:\\'
  const absClientJs = path.join(driveRoot, 'structures', 'client.js');
  const absClientIndex = path.join(driveRoot, 'structures', 'client', 'index.js');
  if (!Module._cache[absClientJs]) {
    Module._cache[absClientJs] = { id: absClientJs, filename: absClientJs, loaded: true, exports: shimModule };
  }
  if (!Module._cache[absClientIndex]) {
    Module._cache[absClientIndex] = { id: absClientIndex, filename: absClientIndex, loaded: true, exports: shimModule };
  }
} catch (_) {
  // Best-effort; commands may still succeed if the actual file exists
}

// Global resolver hook: fix legacy '../../structures/client' paths in command files
try {
  // eslint-disable-next-line no-underscore-dangle
  const originalResolve = Module._resolveFilename;
  // We use a lazy-resolved absolute target to avoid repeated FS lookups
  let targetClientAbs;
  const rootNoop = path.join(COMMANDS_ROOT, '.__noop__.js');
  const rootRequire = createRequire(rootNoop);
  function resolveTarget() {
    if (!targetClientAbs) targetClientAbs = rootRequire.resolve('./structures/client');
    return targetClientAbs;
  }
  // eslint-disable-next-line no-underscore-dangle
  Module._resolveFilename = function patchedResolve(request, parent, isMain, options) {
    if (
      request === '../../structures/client' ||
      request === '../../structures/client.js' ||
      request === '../../structures/client/'
    ) {
      return resolveTarget();
    }
    // Map enhanced-ms to ms to satisfy commands that require('enhanced-ms')
    if (request === 'enhanced-ms') {
      try {
        return rootRequire.resolve('ms');
      } catch (_) {
        // fallthrough to default resolution (may still fail)
      }
    }
    return originalResolve.call(this, request, parent, isMain, options);
  };
} catch (_) {
  // If this fails, normal resolution applies and our shim/cache still covers many cases
}

if (!token) {
  console.error('BOT_TOKEN (or DISCORD_TOKEN) is missing in env');
  process.exit(1);
}

const client = new Client({
  intents: [
    Intents.FLAGS.GUILDS,
    Intents.FLAGS.GUILD_MESSAGES,
    Intents.FLAGS.DIRECT_MESSAGES,
    Intents.FLAGS.GUILD_MEMBERS,
    Intents.FLAGS.GUILD_MESSAGE_REACTIONS,
    Intents.FLAGS.GUILD_BANS,
    Intents.FLAGS.GUILD_VOICE_STATES,
    Intents.FLAGS.GUILD_EMOJIS_AND_STICKERS,
  ],
  partials: ['CHANNEL'] // required to receive DMs in v13
});

// --- Lightweight key-value store (JSON) compatible with get/set/push ---
const DB_FILE = path.join(DATA_DIR, 'commands-db.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
function readDB() { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; } }
function writeDB(obj) { fs.writeFileSync(DB_FILE, JSON.stringify(obj, null, 2)); }
const kv = {
  get(key) { const db = readDB(); return key.split('.').reduce((o,k)=>o?.[k], db); },
  set(key, val) { const db = readDB(); const parts = key.split('.'); let o = db; while(parts.length>1){ const p=parts.shift(); o[p]=o[p]??{}; o=o[p]; } o[parts[0]]=val; writeDB(db); },
  push(key, val) { const arr = kv.get(key) || []; arr.push(val); kv.set(key, arr); }
};

// --- Basic config to satisfy commands ---
client.config = {
  buyers: [],
};
client.staff = [];
client.db = kv;

client.once('ready', () => {
  console.log(`Runner online as ${client.user.tag}`);
  client.user.setPresence({ activities: [{ name: 'CrowBot Managed' }], status: 'online' });
  // Ensure the configured owner has full access in the permission system used by commands
  try {
    if (ownerId) {
      // Persist owner flag used by commands (e.g., client.db.get(`owner_${id}`) === true)
      client.db.set(`owner_${ownerId}`, true);
      // Also include as staff and buyer to cover alternative checks
      if (!client.staff.includes(ownerId)) client.staff.push(ownerId);
      if (!client.config.buyers.includes(ownerId)) client.config.buyers.push(ownerId);
    }
  } catch (_) { /* best effort */ }
  // Optionally force all commands public for the configured guild so users can use them immediately
  try {
    const forcePublic = (process.env.FORCE_PUBLIC_COMMANDS ?? 'true').toLowerCase() !== 'false';
    const guildId = process.env.GUILD_ID;
    if (forcePublic && guildId) {
      for (const key of commands.keys()) {
        client.db.set(`perm_${key}.${guildId}`, 'public');
      }
      console.log(`[runner] Commands set to public for guild ${guildId}`);
    }
  } catch (_) { /* best effort */ }
});

// --- Command loader (loads from ../<category>/*.js) ---
const requireCJS = createRequire(import.meta.url);
const commands = new Map();
const aliases = new Map();
const publicInitializedGuilds = new Set();

function loadCommands() {
  const categories = ['moderation', 'gestion', 'antiraid', 'utilitaire', 'logs', 'backup', 'bot gestion'];
  categories.forEach(cat => {
    const dir = path.join(COMMANDS_ROOT, cat);
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
    files.forEach(file => {
      const full = path.join(dir, file);
      try {
        delete requireCJS.cache?.[full];
        const mod = requireCJS(full);
        if (mod && mod.name && typeof mod.run === 'function') {
          commands.set(mod.name, mod);
          if (Array.isArray(mod.aliases)) mod.aliases.forEach(a => aliases.set(a, mod.name));
        }
      } catch (e) {
        // Extra diagnostics to see if '../../structures/client.js' would resolve correctly from this file
        const expectedStructPath = path.resolve(path.dirname(full), '../../structures/client.js');
        const expectedStructIndex = path.resolve(path.dirname(full), '../../structures/client/index.js');
        const existsClientJs = fs.existsSync(expectedStructPath);
        const existsClientIndex = fs.existsSync(expectedStructIndex);
        console.warn('Failed to load command', full, e.message, {
          expectedClientJs: expectedStructPath,
          existsClientJs,
          expectedClientIndex: expectedStructIndex,
          existsClientIndex,
        });
      }
    });
  });
  console.log(`Loaded ${commands.size} commands from ${COMMANDS_ROOT}`);
}

loadCommands();

// --- Help builder ---
function chunkString(str, size) {
  const chunks = [];
  for (let i = 0; i < str.length; i += size) chunks.push(str.slice(i, i + size));
  return chunks;
}

async function sendHelp(message) {
  try {
    const names = Array.from(commands.keys()).sort();
    const lines = names.map(n => `${PREFIX}${n}`);
    const all = lines.join('\n');
    const embed = new MessageEmbed()
      .setTitle('📜 Commandes disponibles')
      .setColor('#4c63d2')
      .setDescription(`Préfixe: \`${PREFIX}\`\nTotal: **${names.length}** commandes`)
      .setFooter({ text: 'CrowBot' });
    if (all.length <= 4096) {
      embed.addFields([{ name: 'Commandes', value: all }]);
    } else {
      // Split across multiple fields of up to 1000 chars each
      const chunks = chunkString(all, 1000);
      chunks.forEach((c, i) => embed.addFields([{ name: `Commandes (${i + 1}/${chunks.length})`, value: c }]));
    }
    await message.channel.send({ embeds: [embed] });
  } catch (e) {
    // fallback plain text if embed fails
    const names = Array.from(commands.keys()).sort();
    const lines = names.map(n => `${PREFIX}${n}`);
    const text = `Préfixe: ${PREFIX}\nTotal: ${names.length}\n\n` + lines.join('\n');
    // Discord message limit ~2000, chunk if needed
    for (const chunk of chunkString(text, 1900)) {
      await message.channel.send(chunk);
    }
  }
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;
  const inDM = !message.guild;
  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmdName = args.shift()?.toLowerCase();
  // If OWNER_DISCORD_ID is missing or equals bot client ID, unlock all commands for this guild by default
  try {
    const botClientId = process.env.DISCORD_CLIENT_ID;
    const ownerMissingOrBot = !ownerId || ownerId === botClientId;
    const forcePublic = (process.env.FORCE_PUBLIC_COMMANDS ?? 'true').toLowerCase() !== 'false';
    if (!inDM && (!publicInitializedGuilds.has(message.guild.id)) && (ownerMissingOrBot || forcePublic)) {
      for (const key of commands.keys()) client.db.set(`perm_${key}.${message.guild.id}`, 'public');
      publicInitializedGuilds.add(message.guild.id);
    }
  } catch (_) { /* best effort */ }
  // Show help when only prefix is typed, or when help/commands is requested
  if (!cmdName || cmdName === 'help' || cmdName === 'commands') {
    await sendHelp(message);
    return;
  }
  const name = commands.has(cmdName) ? cmdName : aliases.get(cmdName);
  if (!name) return;
  const cmd = commands.get(name);
  const color = '#2f3136';
  const footer = 'CrowBot';
  const debug = (process.env.DEBUG_COMMANDS || '').toLowerCase() === 'true';
  if (debug) console.log(`[runner] exec ${name} by ${message.author.id} in ${message.guild?.id || 'DM'} args=`, args.join(' '));
  // Elevate privileges for configured owner and server administrators before command permission checks
  try {
    const isOwner = ownerId && message.author.id === ownerId;
    const isAdmin = message.member?.permissions?.has && message.member.permissions.has('ADMINISTRATOR');
    if (isOwner || isAdmin) {
      client.db.set(`owner_${message.author.id}`, true);
      if (!client.staff.includes(message.author.id)) client.staff.push(message.author.id);
      if (!client.config.buyers.includes(message.author.id)) client.config.buyers.push(message.author.id);
    }
  } catch (_) { /* best effort */ }
  try {
    await cmd.run(client, message, args, color, PREFIX, footer, name);
    if (debug) console.log(`[runner] done ${name}`);
  } catch (e) {
    console.error('Command error', name, e);
    const usage = Array.isArray(cmd.usage) && cmd.usage.length ? `${PREFIX}${cmd.usage[0]}` : null;
    if (usage) {
      message.reply(`Utilisation: \`${usage}\``);
    } else if (inDM) {
      message.reply('Cette commande nécessite un serveur (rôles, salons ou permissions). Utilisez-la dans un serveur, ou tapez `+'+ 'help` ici pour la liste.');
    } else {
      message.reply('Une erreur est survenue lors de l\'exécution de la commande.');
    }
  }
});

client.login(token);
