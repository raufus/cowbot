# CrowBot Manager - Complete Deployment & Setup Guide

## Overview

CrowBot Manager is a Discord bot hosting service that allows customers to purchase subscriptions through Stripe, get their own isolated bot instances, and manage them via Discord slash commands and modern web panels. The system includes comprehensive moderation, anti-raid, and utility commands.

## System Architecture

- **Manager Bot**: Handles customer commands (`/buy`, `/mybots`, `/start`, `/stop`, etc.)
- **API Server**: REST API for bot management and web panels
- **Customer Bots**: Individual Discord bots for each customer
- **Web Panels**: Customer dashboard and admin interface
- **Database**: SQLite for data persistence

---

## 🚀 Quick Start Deployment

### Prerequisites

- Node.js 18+ installed
- Python 3.11+ (for SQLite compilation)
- Discord Developer Account
- Stripe Account (for payments)
- VPS/Server with port 5000 available

### 1. Initial Setup

```bash
# Clone the project
git clone <your-repository>
cd commands/manager

# Install dependencies
npm install

# Create data directory
mkdir -p data/logs
```

### 2. Environment Configuration

Create `.env` file with your credentials:

```env
# Server Configuration
PORT=5000
BASE_URL=http://your-domain.com:5000

# Discord Manager Bot (Main bot that handles /buy, /mybots commands)
DISCORD_TOKEN=your_manager_bot_token_here
DISCORD_CLIENT_ID=your_manager_bot_client_id
GUILD_ID=your_discord_server_id

# Stripe Payment Integration
STRIPE_SECRET=sk_live_your_stripe_secret_key
STRIPE_PRICE_ID=price_your_product_price_id
STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret

# Panel Access
PANEL_URL=http://your-domain.com:5000

# Database & Storage
SQLITE_PATH=./data/manager.db
LOG_DIR=./data/logs

# Admin Access
ADMIN_KEY=your_secure_admin_key
```

### 3. Discord Bot Setup

#### Manager Bot Setup:
1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to "Bot" section and create a bot
4. Copy the bot token and client ID to your `.env` file
5. Enable these bot permissions:
   - Send Messages
   - Use Slash Commands
   - Embed Links
   - Read Message History

#### Bot Invite:
```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=2147484672&scope=bot%20applications.commands
```

### 4. Stripe Integration Setup

1. **Create Stripe Product:**
   ```bash
   # Login to Stripe Dashboard
   # Create a new product (e.g., "Discord Bot Hosting")
   # Create a price (e.g., $9.99/month)
   # Copy the price ID to STRIPE_PRICE_ID
   ```

2. **Configure Webhook:**
   - URL: `http://your-domain.com:5000/api/stripe/webhook`
   - Events: `checkout.session.completed`
   - Copy webhook secret to `STRIPE_WEBHOOK_SECRET`

### 5. Start the Service

```bash
# Development mode
npm start

# Production mode with PM2
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

---

## 🎮 Discord Commands Reference

### Customer Commands

| Command | Description | Usage | Example |
|---------|-------------|-------|---------|
| `/buy` | Purchase bot subscription | `/buy` | Opens Stripe payment link |
| `/mybots` | List your bots | `/mybots` | Shows bot status and configuration |
| `/changetoken` | Configure bot token | `/changetoken bot_id:1 token:YOUR_TOKEN` | Sets Discord token for your bot |
| `/start` | Start your bot | `/start bot_id:1` | Starts your Discord bot |
| `/stop` | Stop your bot | `/stop bot_id:1` | Stops your Discord bot |

### Bot Instance Commands (Customer's Bots)

Once customers start their bots, these commands are available in their servers:

#### Moderation Commands
- `!ban @user [reason]` - Ban a user
- `!kick @user [reason]` - Kick a user  
- `!mute @user [time] [reason]` - Mute a user
- `!unmute @user` - Unmute a user
- `!warn @user [reason]` - Warn a user
- `!clear [number]` - Delete messages
- `!lock #channel` - Lock a channel
- `!unlock #channel` - Unlock a channel

#### Anti-Raid Protection
- `!antiraid on/off` - Toggle anti-raid protection
- `!antibot on/off/max` - Anti-bot protection
- `!antichannel on/off/max` - Anti-channel creation
- `!antirole on/off/max` - Anti-role manipulation
- `!antiban on/off/max` - Anti-mass ban protection
- `!antieveryone on/off/max` - Anti @everyone spam
- `!antiwebhook on/off/max` - Anti-webhook creation
- `!antijoin on/off/max` - Anti-rapid join protection
- `!antilink on/off/max` - Anti-link spam
- `!antivanity on/off/max` - Vanity URL protection

#### Utility Commands
- `!help` - Show help menu
- `!ping` - Check bot latency
- `!serverinfo` - Server information
- `!userinfo @user` - User information
- `!avatar @user` - Show user avatar
- `!botinfo` - Bot statistics
- `!uptime` - Bot uptime

#### Backup Commands
- `!backup create [name]` - Create server backup
- `!backup list` - List available backups
- `!backup load [backup_id]` - Restore server backup
- `!backup delete [backup_id]` - Delete backup

---

## 🌐 Web Panel Access

### Customer Panel
```
URL: http://your-domain.com:5000/panel?discord_id=USER_DISCORD_ID
```

**Features:**
- View bot status
- Configure bot settings
- Start/stop bots
- View logs
- Manage subscriptions

### Admin Panel
```
URL: http://your-domain.com:5000/admin?key=YOUR_ADMIN_KEY
```

**Features:**
- Manage all customer bots
- View system statistics
- Manual bot creation
- User management
- System monitoring

---

## 🔧 Production Configuration

### 1. PM2 Ecosystem Configuration

Create `ecosystem.config.js`:

```javascript
module.exports = {
  apps: [{
    name: 'crowbot-manager',
    script: 'npm',
    args: 'start',
    cwd: './commands/manager',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production'
    }
  }]
}
```

### 2. Nginx Reverse Proxy (Optional)

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

### 3. Docker Deployment (Alternative)

```bash
# Build image
docker build -t crowbot-manager .

# Run container
docker run -d \
  --name crowbot-manager \
  -p 5000:5000 \
  -v $(pwd)/data:/app/data \
  --env-file .env \
  crowbot-manager
```

---

## 🔐 Client Credential Setup Guide

When clients want to use their own Discord and Stripe credentials:

### Step 1: Discord Setup for Client

1. **Create Discord Application:**
   - Go to [Discord Developer Portal](https://discord.com/developers/applications)
   - Click "New Application"
   - Name it (e.g., "MyBot Manager")

2. **Create Manager Bot:**
   - Go to "Bot" section
   - Click "Add Bot"
   - Copy the token → Replace `DISCORD_TOKEN` in `.env`
   - Copy Application ID → Replace `DISCORD_CLIENT_ID` in `.env`

3. **Set Bot Permissions:**
   - Enable these intents in Discord Developer Portal:
     - Server Members Intent
     - Message Content Intent
   - Bot permissions needed:
     - Administrator (recommended for full functionality)
     - Or specific permissions: Manage Channels, Manage Roles, Ban Members, etc.

4. **Invite Manager Bot:**
   ```
   https://discord.com/api/oauth2/authorize?client_id=CLIENT_ID&permissions=8&scope=bot%20applications.commands
   ```

5. **Update Guild ID:**
   - Get your Discord server ID
   - Replace `GUILD_ID` in `.env`

### Step 2: Stripe Setup for Client

1. **Create Stripe Account:**
   - Sign up at [Stripe](https://stripe.com)
   - Complete business verification

2. **Create Product:**
   - Go to Stripe Dashboard → Products
   - Create new product: "Discord Bot Hosting"
   - Add pricing: $9.99/month (or your price)
   - Copy Price ID → Replace `STRIPE_PRICE_ID` in `.env`

3. **Get API Keys:**
   - Go to Developers → API Keys
   - Copy Secret Key → Replace `STRIPE_SECRET` in `.env`
   - **Important:** Use `sk_live_` for production, `sk_test_` for testing

4. **Setup Webhook:**
   - Go to Developers → Webhooks
   - Add endpoint: `https://your-domain.com/api/stripe/webhook`
   - Select events: `checkout.session.completed`
   - Copy webhook secret → Replace `STRIPE_WEBHOOK_SECRET` in `.env`

### Step 3: Domain Configuration

1. **Update Base URL:**
   ```env
   BASE_URL=https://your-client-domain.com
   PANEL_URL=https://your-client-domain.com
   ```

2. **SSL Certificate:**
   - Use Let's Encrypt with Certbot
   - Or configure your hosting provider's SSL

### Step 4: Admin Access

1. **Generate Secure Admin Key:**
   ```bash
   # Generate random 32-character key
   openssl rand -hex 16
   ```
   
2. **Update Environment:**
   ```env
   ADMIN_KEY=your_generated_secure_key
   ```

### Step 5: Testing Configuration

1. **Test Manager Bot:**
   ```bash
   # Check if bot connects
   npm start
   # Look for: "Manager bot logged in as YourBot#1234"
   ```

2. **Test Stripe Integration:**
   ```bash
   # Use /buy command in Discord
   # Check if payment link generates correctly
   ```

3. **Test Web Panels:**
   ```bash
   # Customer panel
   curl http://your-domain.com/panel?discord_id=123456789

   # Admin panel  
   curl http://your-domain.com/admin?key=your_admin_key
   ```

---

## 📊 Monitoring & Maintenance

### System Health Checks

```bash
# Check API health
curl http://localhost:5000/health

# Check PM2 status
pm2 status

# View logs
pm2 logs crowbot-manager

# Check disk space
df -h

# Monitor memory usage
free -h
```

### Database Maintenance

```bash
# Backup database
cp data/manager.db data/manager.db.backup

# Check database size
ls -lh data/manager.db

# Vacuum database (optimize)
sqlite3 data/manager.db "VACUUM;"
```

### Regular Updates

```bash
# Update dependencies
npm update

# Restart services
pm2 restart crowbot-manager

# Update system packages
sudo apt update && sudo apt upgrade
```

---

## 🆘 Troubleshooting

### Common Issues

1. **Bot Not Responding:**
   - Check bot token validity
   - Verify bot permissions
   - Check internet connectivity

2. **Stripe Errors:**
   - Verify API keys are correct
   - Check webhook configuration
   - Ensure HTTPS for production webhooks

3. **Database Issues:**
   - Check file permissions on `data/` directory
   - Verify SQLite installation
   - Check disk space

4. **Port Issues:**
   - Ensure port 5000 is available
   - Check firewall settings
   - Verify no other services using the port

### Support Commands

```bash
# Check system status
systemctl status crowbot-manager

# View detailed logs
journalctl -u crowbot-manager -f

# Check network connectivity
netstat -tlnp | grep 5000

# Test Discord API connectivity
curl -H "Authorization: Bot YOUR_TOKEN" https://discord.com/api/users/@me
```

---

## 📝 Notes

- **Security:** Always use HTTPS in production
- **Backups:** Regular database backups recommended
- **Updates:** Keep dependencies updated for security
- **Monitoring:** Set up uptime monitoring for production
- **Scaling:** For high traffic, consider load balancing

---

## 📞 Support

For technical support or questions:
- Check logs first: `pm2 logs crowbot-manager`
- Review this documentation
- Test with minimal configuration
- Contact system administrator if issues persist

---

*Last Updated: September 2025*
*Version: 1.0.0*