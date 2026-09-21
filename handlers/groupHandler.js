import config from '../config.js';

export default async function groupHandler(message, sock, config) {
    const { bot } = config;
    const groupJid = message.key.remoteJid;
    const raw = message.message || {};

    const messageText = (
        raw.conversation ||
        raw.extendedTextMessage?.text ||
        raw.imageMessage?.caption ||
        raw.videoMessage?.caption ||
        ''
    ).trim();

    if (!messageText) return;

    if (messageText.startsWith(bot.groupPrefix) || messageText.startsWith(bot.prefix)) {
        console.log(`[GRUP] ${groupJid} - Perintah terdeteksi: ${messageText}`);
    }
}