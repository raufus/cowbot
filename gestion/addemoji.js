const Discord = require('discord.js');
const {bot} = require('../../structures/client'); 

module.exports = {
    name: "addemoji",
    aliases: ["create"],
    description: "Permet de créer un émoji sur le serveur",
    usage: ["addemoji <nom> <emoji>"],
    category: "gestion",
    
    run: async(client, message, args, color, prefix, footer, commandName) => {
let pass = false

let staff = client.staff

if(!staff.includes(message.author.id) && !client.config.buyers.includes(message.author.id) && client.db.get(`owner_${message.author.id}`) !== true){
    if(client.db.get(`perm_${commandName}.${message.guild.id}`) === "1" && message.member.roles.cache.some(r => client.db.get(`perm1.${message.guild.id}`)?.includes(r.id))) pass = true;
    if(client.db.get(`perm_${commandName}.${message.guild.id}`) === "2" && message.member.roles.cache.some(r => client.db.get(`perm2.${message.guild.id}`)?.includes(r.id))) pass = true;
    if(client.db.get(`perm_${commandName}.${message.guild.id}`) === "3" && message.member.roles.cache.some(r => client.db.get(`perm3.${message.guild.id}`)?.includes(r.id))) pass = true;
    if(client.db.get(`perm_${commandName}.${message.guild.id}`) === "4" && message.member.roles.cache.some(r => client.db.get(`perm4.${message.guild.id}`)?.includes(r.id))) pass = true;
    if(client.db.get(`perm_${commandName}.${message.guild.id}`) === "5" && message.member.roles.cache.some(r => client.db.get(`perm5.${message.guild.id}`)?.includes(r.id))) pass = true; 
    if(client.db.get(`perm_${commandName}.${message.guild.id}`) === "public") pass = "oui";   
} else pass = true;

if (pass === false) return message.channel.send(`Vous n'avez pas la permission d'utiliser cette commande.`)

        if (message.attachments.size <= 0) {
        // Expecting a custom emoji like <:name:id> and optional name after it
        const emojiarg = args[0];
        let name = args[1];
        if (!emojiarg) {
            return message.channel.send("Utilisation: `" + prefix + "addemoji <emoji> [nom]` ou joignez une image avec `" + prefix + "addemoji <nom>`");
        }
        const emojiparse = Discord.Util.parseEmoji(String(emojiarg));
        if(!emojiparse || !emojiparse.id){
            return message.channel.send("Format de l'émoji incorrect. Utilisez un émoji personnalisé (ex: `<:nom:id>`)");
        }
        const emojiExt = emojiparse.animated ? ".gif" : ".png";
        const emojiURL = `https://cdn.discordapp.com/emojis/${emojiparse.id}${emojiExt}`;
        if(!name) name = emojiparse.name || 'emoji';
        message.guild.emojis.create(emojiURL, `${name}`).then((em) => {
            message.channel.send(`L'émoji ${em} (**${name}**) a été créé avec succès`);
        }).catch(() => message.channel.send("Impossible de créer l'émoji. Vérifiez que le bot a la permission de gérer les émojis."));
    } else if (message.attachments.size > 0) {
        let emojiUrll = message.attachments.first().url;
        if (!emojiUrll) return;
        let nom = args[0];
        if (!nom) nom = 'emoji';
        message.guild.emojis.create(emojiUrll, `${nom}`).then((aaa) => {
            message.channel.send(`L'émoji ${aaa} (**${nom}**) a été créé avec succès`);
        }).catch(() => message.channel.send("Impossible de créer l'émoji. Vérifiez que le bot a la permission de gérer les émojis."));
    }

    }
}