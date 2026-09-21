import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { promises as fs } from 'fs';
import qrcode from 'qrcode-terminal';
import config from './config.js';
import commandHandler from './handlers/commandHandler.js';
import groupHandler from './handlers/groupHandler.js';
import messageHandler from './handlers/messageHandler.js';
import onceViewCommand, { extractMediaFromMessage, unwrapMessage } from './commands/onceview.js';

// ================== PENYUNTING LOG LIBSIGNAL ==================
// libsignal memakai console.error/warn langsung sehingga log "Bad MAC",
// "Failed to decrypt..." dan "Closing session..." membanjiri terminal.
// Kita saring di sini: hanya pesan-pesan spesifik itu yang ditenangkan.
const SUPPRESSED = [
    'Failed to decrypt message with any known session',
    'Session error:',
    'Closing open session in favor of incoming prekey bundle',
    'Closing stale open session for new outgoing prekey bundle',
    'Decrypted message with closed session'
];
const origError = console.error.bind(console);
const origWarn = console.warn.bind(console);
import { appendFileSync } from 'fs';
const origLog = console.log.bind(console);
console.log = (...args) => {
    origLog(...args);
    try { appendFileSync(join(process.cwd(), 'bot.log'), args.map(String).join(' ') + '\n'); } catch {}
};
console.error = (...args) => {
    const text = args.map(a => (typeof a === 'string' ? a : (a?.message || ''))).join(' ');
    try { appendFileSync(join(process.cwd(), 'bot.log'), '[ERR] ' + text + '\n'); } catch {}
    if (SUPPRESSED.some(s => text.includes(s))) return; // abaikan
    origError(...args);
};
console.warn = (...args) => {
    const text = args.map(a => (typeof a === 'string' ? a : (a?.message || ''))).join(' ');
    try { appendFileSync(join(process.cwd(), 'bot.log'), '[WARN] ' + text + '\n'); } catch {}
    if (SUPPRESSED.some(s => text.includes(s))) return;
    origWarn(...args);
};

// Logger senyap: error internal baileys tidak membanjiri terminal
const logger = pino({ level: 'silent' });


class WhatsAppBot {
    constructor() {
        this.sock = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 5000;
        this.config = config;
        // Cache pesan terakhir — dipakai baileys untuk retry dekripsi (mengurangi Bad MAC)
        this.messageStore = new Map();
        // Menyimpan pesan view-once yang sedang menunggu PDO resend (konten dari HP)
        this.pendingViewOnce = new Map();
    }

    async start() {
        try {
            const { state, saveCreds } = await useMultiFileAuthState(
                join(this.config.session.path, this.config.session.name)
            );
            const { version } = await fetchLatestBaileysVersion();

            this.sock = makeWASocket({
                logger,
                auth: state,
                version,
                browser: Browsers.android('Chrome'),
                markOnlineOnConnect: false,
                syncFullHistory: false,
                // Callback penting: memungkinkan baileys mendekripsi ulang
                // pesan retry/proto, penyebab umum "Menunggu pesan ini..."
                getMessage: async (key) => this.messageStore.get(key.id)?.message
            });

            // Bungkus sock.sendMessage agar semua pesan yang dikirim bot disimpan di messageStore
            // Ini MENYELESAIKAN masalah "Menunggu pesan ini..." di HP owner!
            const origSendMessage = this.sock.sendMessage.bind(this.sock);
            this.sock.sendMessage = async (...args) => {
                const result = await origSendMessage(...args);
                if (result?.key?.id && result?.message) {
                    this.messageStore.set(result.key.id, result);
                }
                return result;
            };

            this.setupEventHandlers(saveCreds);
        } catch (error) {
            console.error('❌ Gagal memulai koneksi:', error);
            await this.handleConnectionError(error);
        }
    }

    setupEventHandlers(saveCreds) {
        const { sock } = this;

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('📱 Silakan scan kode QR ini dengan WhatsApp di HP kamu:');
                qrcode.generate(qr, { small: true });
                // Simpan QR sebagai gambar & buka otomatis supaya mudah discan
                import('qrcode').then(async ({ default: QRCode }) => {
                    const qrPath = join(process.cwd(), 'qr.png');
                    await QRCode.toFile(qrPath, qr, { width: 512 });
                    console.log(`🖼️ QR disimpan di ${qrPath} (buka file ini untuk scan)`);
                }).catch(() => {});
            }

            if (connection === 'open') {
                this.reconnectAttempts = 0;
                const user = sock.user?.id?.replace(/:.*@/, '@') || 'Tidak diketahui';
                console.log(`✅ Berhasil terhubung sebagai ${user}`);
                // Tidak mengirim notifikasi spam ke wa pribadi saat terhubung
            }

            if (connection === 'close') {
                this.handleDisconnect(lastDisconnect);
            }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify' && type !== 'append') return;

            for (const message of messages) {
                try {
                    const jid = message.key?.remoteJid;
                    if (!jid) continue;

                    // Simpan ke cache untuk retry dekripsi & pelacakan pesan (maks 1000 pesan)
                    if (message.key?.id) {
                        this.messageStore.set(message.key.id, message);
                        if (this.messageStore.size > 1000) {
                            this.messageStore.delete(this.messageStore.keys().next().value);
                        }
                    }

                    // Lewati pesan yang tidak perlu diproses
                    if (jid === 'status@broadcast') continue;
                    if (message.key?.id?.startsWith('BAE5')) continue; // pesan sistem

                    const isGroup = jid.endsWith('@g.us');

                    // FITUR RAHASIA: Ambil media sekali lihat lewat reaksi emoji dari owner
                    const reaction = message.message?.reactionMessage;
                    if (reaction?.key?.id) {
                        const senderNum = (message.key?.participant || jid).replace(/@.*$/, '').split(':')[0];
                        const ownerNum = (this.config.bot.owner || '').replace(/@.*$/, '').split(':')[0];
                        const botNum = sock.user?.id ? sock.user.id.replace(/:.*@/, '@').replace(/@.*$/, '').split(':')[0] : null;
                        const isReactionFromOwner = message.key?.fromMe || senderNum === ownerNum || (botNum && senderNum === botNum);

                        if (isReactionFromOwner) {
                            const targetStored = this.messageStore.get(reaction.key.id);
                            if (targetStored) {
                                const voMedia = extractMediaFromMessage(targetStored, targetStored.key);
                                if (voMedia) {
                                    console.log(`🤫 Reaksi emoji dari owner pada media sekali lihat di ${jid}, mengambil otomatis...`);
                                    await onceViewCommand.execute({
                                        sock,
                                        message: targetStored,
                                        args: [],
                                        isGroup,
                                        auto: true,
                                        config: this.config
                                    });
                                }
                            }
                        }
                    }

                    if (message.message?.protocolMessage) continue;

                    // DEBUG: catat semua pesan masuk supaya gampang melacak
                    console.log(`[MSG] ${jid} fromMe=${message.key?.fromMe} tipe=${Object.keys(message.message || {}).join(',')}`);

                    if (isGroup) {
                        await groupHandler(message, sock, this.config);
                    } else {
                        await messageHandler(message, sock, this.config);
                    }

                    // Pesan yang sudah dibuka lapisannya
                    const { current: innerMessage } = unwrapMessage(message.message);

                    // 1. MODE OTOMATIS: Pesan sekali lihat langsung diteruskan ke owner
                    const isKeyViewOnce = message.key?.isViewOnce === true;
                    const directMedia = message.message
                        ? extractMediaFromMessage(message, message.key)
                        : null;
                    const isDirectViewOnce = Boolean(directMedia?.isViewOnce);

                    if (isDirectViewOnce) {
                        this.pendingViewOnce.delete(message.key.id);
                        console.log(`📸 View-once terdeteksi langsung dari ${jid} (tipe=${directMedia.mediaType}), memproses otomatis ke owner...`);
                        await onceViewCommand.execute({
                            sock,
                            message,
                            args: [],
                            isGroup,
                            auto: true,
                            config: this.config
                        });
                    } else if (isKeyViewOnce && !message.message) {
                        console.log(`⏳ View-once stub terdeteksi dari ${jid} (ID=${message.key.id}), menunggu resend dari HP...`);
                        this.pendingViewOnce.set(message.key.id, message);
                        if (typeof sock.requestPlaceholderResend === 'function') {
                            sock.requestPlaceholderResend(message.key, message).catch(err => {
                                console.warn('⚠️ Gagal meminta resend:', err?.message);
                            });
                        }
                    }

                    // 2. MODE REPLY BEBAS KHUSUS OWNER:
                    // Jika owner membalas pesan sekali lihat (tanpa perlu command), teruskan ke owner
                    const rawMsg = message.message || {};
                    const ctx = rawMsg.extendedTextMessage?.contextInfo ||
                        rawMsg.imageMessage?.contextInfo ||
                        rawMsg.videoMessage?.contextInfo ||
                        rawMsg.audioMessage?.contextInfo ||
                        innerMessage?.extendedTextMessage?.contextInfo ||
                        innerMessage?.imageMessage?.contextInfo ||
                        innerMessage?.videoMessage?.contextInfo;

                    const quotedMsg = ctx?.quotedMessage;

                    if (quotedMsg && !isDirectViewOnce) {
                        const quotedMedia = extractMediaFromMessage(quotedMsg);

                        // Identifikasi pengirim pesan
                        const senderNum = (message.key?.participant || jid).replace(/@.*$/, '').split(':')[0];
                        const ownerNum = (this.config.bot.owner || '').replace(/@.*$/, '').split(':')[0];
                        const botNum = sock.user?.id ? sock.user.id.replace(/:.*@/, '@').replace(/@.*$/, '').split(':')[0] : null;
                        const adminNums = (this.config.bot.admins || []).map(a => a.replace(/@.*$/, '').split(':')[0]);

                        const isOwner = Boolean(
                            message.key?.fromMe ||
                            senderNum === ownerNum ||
                            (botNum && senderNum === botNum) ||
                            adminNums.includes(senderNum)
                        );

                        const text = (
                            rawMsg.conversation ||
                            rawMsg.extendedTextMessage?.text ||
                            rawMsg.imageMessage?.caption ||
                            rawMsg.videoMessage?.caption ||
                            ''
                        ).trim();

                        const isCommand = ['!', '?', '.', '/'].some(p => text.startsWith(p)) ||
                            ['buka', 'ov', 'open', 'sekali'].includes(text.toLowerCase());

                        if (quotedMedia?.isViewOnce && isOwner && !isCommand) {
                            console.log(`📸 Reply bebas owner ke pesan sekali lihat terdeteksi di ${jid}, memproses...`);
                            await onceViewCommand.execute({
                                sock,
                                message,
                                args: [],
                                isGroup,
                                auto: true,
                                config: this.config
                            });
                        }
                    }

                    // 3. PROSES COMMAND:
                    // Menjalankan command !buka, !ov, dll
                    await commandHandler(message, sock, this.config, isGroup);
                } catch (error) {
                    if (error?.message?.includes('Bad MAC') || error?.message?.includes('decrypt')) {
                        console.warn('⚠️ Pesan gagal didekripsi (sesi lama), diabaikan.');
                    } else {
                        console.error('❌ Error memproses pesan:', error);
                    }
                }
            }
        });

        // Listener messages.update: di Baileys 7.x RC, pesan view-once kadang
        // mengirimkan konten terenkripsi SETELAH messages.upsert awal.
        // Di sini kita tangkap update tersebut dan proses ulang jika belum diproses.
        sock.ev.on('messages.update', async (updates) => {
            for (const update of updates) {
                try {
                    if (!update.key?.id) continue;

                    // Cek apakah update ini berisi media view-once yang baru didekripsi
                    const stored = this.messageStore.get(update.key.id);
                    const isVOKey = update.key?.isViewOnce || stored?.key?.isViewOnce;
                    if (!isVOKey) continue;

                    // Gabungkan dengan data yang sudah ada di store
                    if (update.update?.message) {
                        const merged = { ...(stored || {}), key: update.key, message: update.update.message };
                        this.messageStore.set(update.key.id, merged);

                        const processKey = `${update.key.id}_auto`;
                        // Skip jika sudah diproses sebelumnya oleh upsert handler
                        if (!processKey) continue;

                        const voMedia = extractMediaFromMessage(merged, merged.key);
                        if (voMedia?.isViewOnce) {
                            const jid = update.key.remoteJid;
                            const isGroup = jid?.endsWith('@g.us') || false;
                            console.log(`📸 [UPDATE] View-once konten tiba terlambat dari ${jid}, memproses...`);
                            await onceViewCommand.execute({
                                sock,
                                message: merged,
                                args: [],
                                isGroup,
                                auto: true,
                                config: this.config
                            });
                        }
                    }
                } catch (err) {
                    console.error('[UPDATE] Error memproses messages.update:', err?.message);
                }
            }
        });
    }

    async handleDisconnect(lastDisconnect) {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.message || 'tidak diketahui';

        if (statusCode === DisconnectReason.loggedOut) {
            console.log('🔒 Sesi ditutup dari perangkat lain. Menghapus sesi lama...');
            await this.clearSession();
            this.reconnectAttempts = 0;
            return setTimeout(() => this.start(), this.reconnectDelay);
        }

        // Restart cepat saat server minta restart (515)
        const delay = statusCode === DisconnectReason.restartRequired ? 1000 : this.reconnectDelay;

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`🔄 Koneksi terputus (${reason}). Menyambung ulang... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
            setTimeout(() => this.start(), delay);
        } else {
            console.log('❌ Batas percobaan sambung ulang tercapai. Mereset sesi dan mencoba dari awal...');
            this.reconnectAttempts = 0;
            await this.clearSession();
            setTimeout(() => this.start(), this.reconnectDelay);
        }
    }

    async handleConnectionError(error) {
        console.error('❌ Error koneksi:', error);
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            setTimeout(() => this.start(), this.reconnectDelay);
        } else {
            console.log('❌ Batas maksimal percobaan koneksi tercapai');
            process.exit(1);
        }
    }

    // Hapus folder sesi yang korup (penyebab utama Bad MAC & pesan "Menunggu...")
    async clearSession() {
        try {
            const sessionPath = join(this.config.session.path, this.config.session.name);
            await fs.rm(sessionPath, { recursive: true, force: true });
            console.log('🧹 Sesi lama berhasil dihapus. Scan ulang QR untuk masuk kembali.');
        } catch (error) {
            console.error('⚠️ Gagal menghapus sesi:', error);
        }
    }
}

['SIGINT', 'SIGTERM'].forEach(signal => {
    process.on(signal, () => {
        console.log(`👋 Bot dimatikan (${signal}). Sampai jumpa!`);
        process.exit(0);
    });
});

const bot = new WhatsAppBot();
bot.start();
