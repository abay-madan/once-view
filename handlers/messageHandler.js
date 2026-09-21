export default async function messageHandler(message, sock, config) {
    const { bot } = config;
    const userJid = message.key.remoteJid;
    const raw = message.message || {};

    const messageText = (
        raw.conversation ||
        raw.extendedTextMessage?.text ||
        raw.imageMessage?.caption ||
        raw.videoMessage?.caption ||
        ''
    ).trim();

    const senderNumber = userJid.replace(/@.*$/, '').split(':')[0];
    if (bot.blockedUsers && bot.blockedUsers.includes(senderNumber)) {
        console.log(`⚠️ Pesan dari pengguna yang diblokir: ${userJid}`);
        return;
    }

    if (messageText) {
        console.log(`[PRIVATE] ${userJid}: ${messageText}`);
    }
}