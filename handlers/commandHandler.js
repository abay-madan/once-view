import onceViewCommand from '../commands/onceview.js';
import { promises as fs } from 'fs';
import { join } from 'path';

// Cache perintah di memori
const commandsMap = new Map();
let commandsLoaded = false;

async function initCommands(config) {
    if (commandsLoaded) return;

    // Daftarkan onceViewCommand secara default
    registerCommand(onceViewCommand);

    try {
        const commandsDir = config?.paths?.commands || join(process.cwd(), 'commands');
        const files = await fs.readdir(commandsDir);
        const jsFiles = files.filter(f => f.endsWith('.js') && f !== 'onceview.js');

        for (const file of jsFiles) {
            try {
                const mod = await import(`../commands/${file}`);
                const cmd = mod.default || mod;
                if (cmd && cmd.name) {
                    registerCommand(cmd);
                }
            } catch (err) {
                console.error(`[CMD] Gagal memuat perintah ${file}:`, err.message);
            }
        }
    } catch (e) {
        // Abaikan jika folder commands tidak bisa dibaca
    }

    commandsLoaded = true;
}

function registerCommand(cmd) {
    if (!cmd || !cmd.name) return;
    commandsMap.set(cmd.name.toLowerCase(), cmd);
    if (Array.isArray(cmd.aliases)) {
        for (const alias of cmd.aliases) {
            commandsMap.set(alias.toLowerCase(), cmd);
        }
    }
}

export default async function commandHandler(message, sock, config, isGroup) {
    await initCommands(config);

    const { bot } = config;
    const userJid = message.key.remoteJid;
    const rawMsg = message.message || {};

    const messageText = (
        rawMsg.conversation ||
        rawMsg.extendedTextMessage?.text ||
        rawMsg.imageMessage?.caption ||
        rawMsg.videoMessage?.caption ||
        rawMsg.documentMessage?.caption ||
        ''
    ).trim();

    if (!messageText) return;

    // Prefiks yang didukung: !, ?, ., /, atau tanpa prefiks jika me-reply dengan kata buka/ov
    const prefixes = [bot?.prefix, bot?.groupPrefix, '.', '/'].filter(Boolean);
    const matchedPrefix = prefixes.find(p => messageText.startsWith(p));

    let cmdName = '';
    let args = [];

    const hasQuoted = Boolean(
        rawMsg.extendedTextMessage?.contextInfo?.quotedMessage ||
        rawMsg.imageMessage?.contextInfo?.quotedMessage ||
        rawMsg.videoMessage?.contextInfo?.quotedMessage
    );

    if (matchedPrefix) {
        const body = messageText.slice(matchedPrefix.length).trim();
        const parts = body.split(/ +/);
        cmdName = (parts[0] || '').toLowerCase();
        args = parts.slice(1);
    } else if (hasQuoted) {
        // Kemudahan untuk user: jika me-reply media dengan kata "buka", "ov", "open", "sekali"
        const lower = messageText.toLowerCase();
        if (['buka', 'ov', 'open', 'sekali', 'onceview'].includes(lower)) {
            cmdName = lower;
            args = [];
        }
    }

    if (!cmdName) return;

    const command = commandsMap.get(cmdName);
    if (!command) {
        return;
    }

    try {
        console.log(`[CMD] ${cmdName} dijalankan oleh ${userJid}`);
        await command.execute({
            sock,
            message,
            args,
            isGroup,
            config,
            auto: false
        });
    } catch (error) {
        console.error(`[CMD ERROR] ${cmdName}:`, error);
    }
}

