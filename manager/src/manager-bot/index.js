import 'dotenv/config';
import Discord from 'discord.js';
const { Client, Intents, MessageEmbed } = Discord;
import { SlashCommandBuilder } from '@discordjs/builders';
import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import fetch from 'node-fetch';

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.GUILD_ID; // optional for guild registration during dev
const API_BASE = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;

if (!token || !clientId) {
  console.error('DISCORD_TOKEN or DISCORD_CLIENT_ID missing in env');
  process.exit(1);
}

const client = new Client({
  intents: [Intents.FLAGS.GUILDS, Intents.FLAGS.GUILD_MESSAGES, Intents.FLAGS.DIRECT_MESSAGES]
});

// Register slash commands
const commands = [
  new SlashCommandBuilder().setName('mybots').setDescription('List and manage your bots'),
  new SlashCommandBuilder()
    .setName('changetoken')
    .setDescription('Set or update the token for your bot')
    .addStringOption(o => o.setName('bot_id').setDescription('Your bot id').setRequired(true))
    .addStringOption(o => o.setName('token').setDescription('Bot token').setRequired(true)),
  new SlashCommandBuilder()
    .setName('start')
    .setDescription('Start your bot')
    .addStringOption(o => o.setName('bot_id').setDescription('Your bot id').setRequired(true)),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop your bot')
    .addStringOption(o => o.setName('bot_id').setDescription('Your bot id').setRequired(true)),
  new SlashCommandBuilder().setName('buy').setDescription('Get payment link to subscribe')
];

async function registerCommandsWithRetry(maxAttempts = 5) {
  const rest = new REST({ version: '10' }).setToken(token);
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (guildId) {
        await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands.map(c => c.toJSON()) });
        console.log('Registered guild commands');
      } else {
        await rest.put(Routes.applicationCommands(clientId), { body: commands.map(c => c.toJSON()) });
        console.log('Registered global commands');
      }
      return true;
    } catch (e) {
      lastErr = e;
      const waitMs = Math.min(30000, 3000 * attempt);
      console.error(`Failed to register commands (attempt ${attempt}/${maxAttempts})`, e?.code || e?.name || e?.message || e);
      if (attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, waitMs));
      }
    }
  }
  console.error('Giving up registering commands after retries.', lastErr);
  return false;
}

client.on('ready', () => {
  console.log(`Manager bot logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  // Support both discord.js v13 (isCommand) and v14 (isChatInputCommand)
  const isSlash = typeof interaction.isChatInputCommand === 'function'
    ? interaction.isChatInputCommand()
    : (typeof interaction.isCommand === 'function' && interaction.isCommand());
  if (!isSlash) return;
  const discordId = interaction.user.id;

  try {
    if (interaction.commandName === 'buy') {
      // Reply immediately to avoid 10062 Unknown interaction if defer is delayed
      await interaction.reply({ content: '⏳ Génération du lien de paiement...', ephemeral: true });
      try {
        const r = await fetch(`${API_BASE}/api/checkout`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ discordId })
        });
        if (r.ok) {
          const data = await r.json();
          if (data.url) {
            await interaction.editReply({ content: `✅ Procéder au paiement: ${data.url}` });
          } else {
            await interaction.editReply({ content: '❌ Lien de paiement indisponible. Veuillez réessayer plus tard.' });
          }
        } else {
          await interaction.editReply({ content: '⚠️ Service de paiement temporairement indisponible. Pour tester, utilisez d\'abord /mybots pour créer un bot.' });
        }
      } catch (error) {
        console.error('Buy command error:', error);
        await interaction.editReply({ content: '⚠️ Service de paiement temporairement indisponible. Pour tester, utilisez d\'abord /mybots pour créer un bot.' });
      }
    }

    if (interaction.commandName === 'mybots') {
      await interaction.reply({ content: '⏳ Récupération de vos bots...', ephemeral: true });
      try {
        let list = await fetch(`${API_BASE}/api/bots?owner=${discordId}`);
        let bots = list && list.ok ? await list.json() : [];
        
        if (!bots.length) {
          // Create a default bot entry for this user for quicker onboarding
          const createResponse = await fetch(`${API_BASE}/api/bots`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ discordId, name: 'CrowBot' })
          });
          
          if (createResponse.ok) {
            list = await fetch(`${API_BASE}/api/bots?owner=${discordId}`);
            bots = list && list.ok ? await list.json() : [];
          }
        }
        
        const embed = new MessageEmbed()
          .setTitle('🤖 Vos bots')
          .setColor('#4c63d2')
          .setDescription(bots.length ? 
            bots.map(b => `**#${b.id}** • ${b.name || 'CrowBot'} • ${b.status === 'running' ? '🟢 En ligne' : '🔴 Arrêté'}\n` +
                        `Token: ${b.token ? '✅ Configuré' : '❌ Non configuré'}`).join('\n\n') :
            '❌ Aucun bot trouvé.\n\n**Instructions:**\n1. Utilisez `/changetoken` pour configurer le token\n2. Utilisez `/start` pour démarrer votre bot')
          .setFooter({ text: 'CrowBot Manager' });
          
        await interaction.editReply({ embeds: [embed] });
      } catch (error) {
        console.error('MyBots command error:', error);
        await interaction.editReply({ content: '❌ Erreur lors de la récupération de vos bots. Veuillez réessayer.' });
      }
    }

    if (interaction.commandName === 'changetoken') {
      await interaction.reply({ content: '⏳ Mise à jour du token...', ephemeral: true });
      const botId = interaction.options.getString('bot_id');
      const token = interaction.options.getString('token');
      
      if (!botId || !token) {
        await interaction.editReply({ content: '❌ Bot ID et token sont requis.' });
        return;
      }
      
      try {
        const r = await fetch(`${API_BASE}/api/bots/${botId}/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });
        
        if (r.ok) {
          await interaction.editReply({ content: `✅ **Token mis à jour avec succès!**\n\n**Bot ID:** ${botId}\n**Étape suivante:** Utilisez \`/start bot_id:${botId}\` pour démarrer votre bot.` });
        } else {
          await interaction.editReply({ content: `❌ **Échec de la mise à jour du token**\n\nVérifiez que le Bot ID \`${botId}\` existe. Utilisez \`/mybots\` pour voir vos bots.` });
        }
      } catch (error) {
        console.error('ChangeToken command error:', error);
        await interaction.editReply({ content: '❌ Erreur lors de la mise à jour du token. Veuillez réessayer.' });
      }
    }

    if (interaction.commandName === 'start') {
      await interaction.reply({ content: '⏳ Démarrage du bot...', ephemeral: true });
      const botId = interaction.options.getString('bot_id');
      
      if (!botId) {
        await interaction.editReply({ content: '❌ Bot ID est requis.' });
        return;
      }
      
      try {
        const r = await fetch(`${API_BASE}/api/bots/${botId}/start`, { method: 'POST' });
        
        if (r.ok) {
          const data = await r.json().catch(() => ({}));
          await interaction.editReply({ 
            content: `✅ **Bot démarré avec succès!**\n\n**Bot ID:** ${botId}\n**Statut:** 🟢 En ligne\n\n**Votre bot est maintenant actif et répond aux commandes!**` 
          });
        } else {
          const errorText = await r.text().catch(() => 'Erreur inconnue');
          await interaction.editReply({ 
            content: `❌ **Échec du démarrage**\n\n**Bot ID:** ${botId}\n**Raison:** ${errorText}\n\n**Vérifiez:**\n1. Le token est configuré (\`/changetoken\`)\n2. Le Bot ID existe (\`/mybots\`)` 
          });
        }
      } catch (error) {
        console.error('Start command error:', error);
        await interaction.editReply({ content: '❌ Erreur lors du démarrage. Veuillez réessayer.' });
      }
    }

    if (interaction.commandName === 'stop') {
      await interaction.reply({ content: '⏳ Arrêt du bot...', ephemeral: true });
      const botId = interaction.options.getString('bot_id');
      
      if (!botId) {
        await interaction.editReply({ content: '❌ Bot ID est requis.' });
        return;
      }
      
      try {
        const r = await fetch(`${API_BASE}/api/bots/${botId}/stop`, { method: 'POST' });
        
        if (r.ok) {
          await interaction.editReply({ 
            content: `✅ **Bot arrêté avec succès!**\n\n**Bot ID:** ${botId}\n**Statut:** 🔴 Arrêté\n\n**Pour redémarrer:** Utilisez \`/start bot_id:${botId}\`` 
          });
        } else {
          const errorText = await r.text().catch(() => 'Erreur inconnue');
          await interaction.editReply({ 
            content: `❌ **Échec de l'arrêt**\n\n**Bot ID:** ${botId}\n**Raison:** ${errorText}\n\nVérifiez que le Bot ID existe avec \`/mybots\`` 
          });
        }
      } catch (error) {
        console.error('Stop command error:', error);
        await interaction.editReply({ content: '❌ Erreur lors de l\'arrêt. Veuillez réessayer.' });
      }
    }
  } catch (e) {
    console.error('interaction error', e);
    const errorMessage = '❌ **Erreur système détectée**\n\nVeuillez réessayer dans quelques instants. Si le problème persiste, contactez le support.';
    if (interaction.deferred || interaction.replied) {
      interaction.editReply({ content: errorMessage });
    } else {
      interaction.reply({ content: errorMessage, ephemeral: true });
    }
  }
});

await registerCommandsWithRetry();
client.login(token);
