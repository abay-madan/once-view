import { downloadMediaMessage, downloadContentFromMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import { logger } from '../utils/helpers.js';

// Cache ID pesan yang sudah diproses agar tidak memproses ulang / terjadi loop
const processedIds = new Set();
function markProcessed(id) {
    if (!id) return false;
    if (processedIds.has(id)) return true;
    processedIds.add(id);
    if (processedIds.size > 1000) {
        const first = processedIds.values().next().value;
        processedIds.delete(first);
    }
    return false;
}

// Buka semua lapisan pembungkus pesan (ephemeral, viewOnce, dll)
export function unwrapMessage(m) {
    let current = m?.message || m;
    let isViewOnce = false;

    for (let i = 0; i < 6 && current; i++) {
        if (current.viewOnceMessage?.message) {
            isViewOnce = true;
            current = current.viewOnceMessage.message;
            continue;
        }
        if (current.viewOnceMessageV2?.message) {
            isViewOnce = true;
            current = current.viewOnceMessageV2.message;
            continue;
        }
        if (current.viewOnceMessageV2Extension?.message) {
            isViewOnce = true;
            current = current.viewOnceMessageV2Extension.message;
            continue;
        }
        if (current.ephemeralMessage?.message) {
            current = current.ephemeralMessage.message;
            continue;
        }
        if (current.documentWithCaptionMessage?.message) {
            current = current.documentWithCaptionMessage.message;
            continue;
        }
        if (current.deviceSentMessage?.message) {
            current = current.deviceSentMessage.message;
            continue;
        }
        break;
    }

    return { current, isViewOnce };
}

// Ekstrak media dari objek pesan
export function extractMediaFromMessage(rawMessage, fallbackKey = null) {
    if (!rawMessage) return null;

    const { current, isViewOnce: unwrappedViewOnce } = unwrapMessage(rawMessage);
    if (!current) return null;

    const img = current.imageMessage;
    const vid = current.videoMessage;
    const aud = current.audioMessage;
    const doc = current.documentMessage;

    const isViewOnce = unwrappedViewOnce ||
        Boolean(img?.viewOnce || vid?.viewOnce || aud?.viewOnce || doc?.viewOnce || rawMessage.key?.isViewOnce);

    const media = img || vid || aud || doc;
    if (!media) return null;

    const mediaType = img ? 'image' : vid ? 'video' : aud ? 'audio' : 'document';
    const caption = img?.caption || vid?.caption || doc?.caption || '';

    return {
        isViewOnce,
        mediaType,
        media,
        content: current,
        caption,
        key: rawMessage.key || fallbackKey
    };
}

// Temukan target media: pesan langsung atau quoted message (hingga 5 lapis)
export function getTargetMedia(message, allowAnyQuoted = false) {
    // 1. Cek apakah pesan langsung memiliki media view-once
    const direct = extractMediaFromMessage(message, message.key);
    if (direct && direct.isViewOnce) {
        return direct;
    }

    // 2. Cek quoted message di contextInfo
    const rawMsg = message.message || message;
    const { current: inner } = unwrapMessage(rawMsg);

    let ctx = rawMsg?.extendedTextMessage?.contextInfo ||
        rawMsg?.imageMessage?.contextInfo ||
        rawMsg?.videoMessage?.contextInfo ||
        rawMsg?.audioMessage?.contextInfo ||
        rawMsg?.documentMessage?.contextInfo ||
        inner?.extendedTextMessage?.contextInfo ||
        inner?.imageMessage?.contextInfo ||
        inner?.videoMessage?.contextInfo ||
        inner?.documentMessage?.contextInfo;

    let depth = 0;
    while (ctx?.quotedMessage && depth < 5) {
        const quotedKey = {
            id: ctx.stanzaId || message.key?.id,
            remoteJid: message.key?.remoteJid,
            fromMe: false,
            participant: ctx.participant || undefined
        };

        const quotedMedia = extractMediaFromMessage(ctx.quotedMessage, quotedKey);
        if (quotedMedia) {
            // Jika mode command (allowAnyQuoted=true), ambil media meskipun flag viewOnce tidak eksplisit di quote
            if (quotedMedia.isViewOnce || allowAnyQuoted) {
                return quotedMedia;
            }
        }

        const { current: nextInner } = unwrapMessage(ctx.quotedMessage);
        ctx = nextInner?.extendedTextMessage?.contextInfo ||
            nextInner?.imageMessage?.contextInfo ||
            nextInner?.videoMessage?.contextInfo ||
            nextInner?.documentMessage?.contextInfo;
        depth++;
    }

    // 3. Jika mode command dan pesan langsung memiliki media (misal caption !buka)
    if (direct && allowAnyQuoted) {
        return direct;
    }

    return null;
}

// Unduh media dengan fallback
async function downloadMedia(target, sock) {
    const silentLogger = pino({ level: 'silent' });
    let mediaBuffer = null;

    try {
        mediaBuffer = await downloadMediaMessage(
            { message: target.content, key: target.key },
            'buffer',
            {},
            {
                logger: silentLogger,
                reuploadRequest: sock?.updateMediaMessage
            }
        );
    } catch (err) {
        console.warn('[OV] downloadMediaMessage gagal, mencoba fallback downloadContentFromMessage...', err.message);
        try {
            const stream = await downloadContentFromMessage(
                target.media,
                target.mediaType,
                {}
            );
            const chunks = [];
            for await (const chunk of stream) {
                chunks.push(chunk);
            }
            mediaBuffer = Buffer.concat(chunks);
        } catch (fallbackErr) {
            throw new Error(`Gagal mengunduh media: ${err.message || fallbackErr.message}`);
        }
    }

    if (!mediaBuffer || mediaBuffer.length === 0) {
        throw new Error('Buffer media kosong setelah diunduh.');
    }

    return mediaBuffer;
}

// Kirim media ke tujuan
async function sendMedia(sock, targetJid, buffer, target, captionText, options = {}) {
    const sendOpts = options.quoted ? { quoted: options.quoted } : {};

    if (target.mediaType === 'image') {
        return await sock.sendMessage(targetJid, {
            image: buffer,
            caption: captionText,
            mentions: options.mentions || []
        }, sendOpts);
    } else if (target.mediaType === 'video') {
        return await sock.sendMessage(targetJid, {
            video: buffer,
            caption: captionText,
            mentions: options.mentions || []
        }, sendOpts);
    } else if (target.mediaType === 'audio') {
        const msg = await sock.sendMessage(targetJid, {
            audio: buffer,
            mimetype: target.media?.mimetype || 'audio/ogg; codecs=opus',
            ptt: target.media?.ptt ?? true
        }, sendOpts);

        if (captionText) {
            await sock.sendMessage(targetJid, {
                text: captionText,
                mentions: options.mentions || []
            }, sendOpts);
        }
        return msg;
    } else if (target.mediaType === 'document') {
        return await sock.sendMessage(targetJid, {
            document: buffer,
            mimetype: target.media?.mimetype || 'application/octet-stream',
            fileName: target.media?.fileName || 'viewonce_file',
            caption: captionText,
            mentions: options.mentions || []
        }, sendOpts);
    }
}

export default {
    name: 'onceview',
    description: 'Membuka dan mengambil pesan sekali lihat (view-once: gambar, video, audio, atau dokumen).',
    aliases: ['ov', 'buka', 'open', 'sekali'],

    async execute({ sock, message, args = [], isGroup = false, auto = false, config = null }) {
        try {
            const { key } = message;
            const remoteJid = key?.remoteJid;
            if (!remoteJid) return;

            // Cari target media
            // Jika auto=false (command), allowAnyQuoted=true (agar jika user me-reply media biasa/viewonce yang flagnya di-strip WA tetap bisa dibuka)
            const target = getTargetMedia(message, !auto);

            if (!target) {
                if (!auto) {
                    await sock.sendMessage(remoteJid, {
                        text: '⚠️ *Tidak ditemukan pesan media atau sekali lihat!*\n\nSilakan *reply (balas)* pesan foto/video/suara sekali lihat dengan mengetik *!buka* atau *!ov*.'
                    }, { quoted: message });
                } else {
                    console.log(`[OV] Belum ada media valid pada pesan ${key.id} di ${remoteJid}`);
                }
                return;
            }

            // Jika dalam mode otomatis dan pengirim adalah akun bot/owner sendiri, abaikan agar tidak spam ke diri sendiri
            if (auto && target.key?.fromMe) {
                console.log(`[OV] Media sekali lihat dikirim oleh akun bot/owner sendiri, melewati pengiriman otomatis.`);
                return;
            }

            // Media valid ditemukan! Sekarang tandai ID agar tidak diproses ganda
            const processKey = `${target.key?.id || key.id}_auto`;
            if (markProcessed(processKey)) {
                return;
            }

            // Normalisasi daftar Owner
            const configOwner = config?.bot?.owner || '628xxxxxxxxxx@s.whatsapp.net';
            const ownerNumber = configOwner.replace(/@.*$/, '').split(':')[0];
            const botNumber = sock.user?.id ? sock.user.id.replace(/:.*@/, '@').replace(/@.*$/, '').split(':')[0] : null;

            const ownerJids = new Set([
                `${ownerNumber}@s.whatsapp.net`,
                botNumber ? `${botNumber}@s.whatsapp.net` : null,
                ...((config?.bot?.admins || []).map(a => `${a.replace(/@.*$/, '').split(':')[0]}@s.whatsapp.net`))
            ].filter(Boolean));

            console.log(`[OV] Menemukan media (${target.mediaType}, viewOnce=${target.isViewOnce}) dari ${remoteJid}. Mengunduh...`);

            // Unduh media
            let mediaBuffer = null;
            try {
                mediaBuffer = await downloadMedia(target, sock);
            } catch (err) {
                console.error('[OV] Gagal mengunduh media:', err);
                if (!auto) {
                    await sock.sendMessage(remoteJid, {
                        text: `❌ *Gagal mengunduh media!*\n\nDetail: ${err.message || 'Media sudah kadaluarsa atau tidak dapat diakses dari server WhatsApp.'}`
                    }, { quoted: message });
                }
                return;
            }

            console.log(`[OV] Berhasil mengunduh media (${mediaBuffer.length} bytes). Mengirimkan...`);

            // Tentukan pengirim asli media
            const originalSenderJid = target.key?.participant || target.key?.remoteJid || remoteJid;
            const originalSenderNumber = originalSenderJid.replace(/@.*$/, '').split(':')[0];
            const sourceText = isGroup ? `Grup (${remoteJid})` : `Chat Pribadi (${remoteJid})`;

            const timeStr = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

            // Caption untuk pengiriman ke chat pribadi owner
            const stealthCaption = `📸 *[PESAN SEKALI LIHAT TERDETEKSI]*\n\n` +
                `📍 *Sumber:* ${sourceText}\n` +
                `👤 *Pengirim:* @${originalSenderNumber}\n` +
                (target.caption ? `💬 *Pesan/Caption:* "${target.caption}"\n` : '') +
                `⏰ *Waktu:* ${timeStr} WIB\n\n` +
                `_🔒 Diambil secara otomatis & rahasia (orang lain tidak tahu)._`;

            // Kirim HANYA ke chat pribadi Owner
            for (const destOwner of ownerJids) {
                try {
                    await sendMedia(sock, destOwner, mediaBuffer, target, stealthCaption, {
                        mentions: [originalSenderJid]
                    });
                    console.log(`[OV] Berhasil dikirimkan secara rahasia ke chat pribadi owner: ${destOwner}`);
                } catch (sendErr) {
                    console.error(`[OV] Gagal mengirim ke owner ${destOwner}:`, sendErr);
                }
            }

            // Jika dipanggil via command di grup (misal !buka), HAPUS pesan command dari grup agar tidak ketahuan
            if (!auto && isGroup && message.key) {
                try {
                    await sock.sendMessage(remoteJid, { delete: message.key });
                    console.log(`[OV] Pesan perintah di grup berhasil dihapus agar tidak meninggalkan jejak.`);
                } catch (delErr) {
                    console.warn(`[OV] Tidak dapat menghapus pesan perintah di grup:`, delErr.message);
                }
            } else if (!auto && !isGroup && !ownerJids.has(remoteJid)) {
                // Jika user mengetik !buka di private chat orang lain (bukan grup dan bukan chat owner sendiri)
                try {
                    await sendMedia(sock, remoteJid, mediaBuffer, target, `🔓 *Media Berhasil Diambil!*\n_Salinan juga telah dikirim ke chat pribadi owner._`, {
                        quoted: message,
                        mentions: [originalSenderJid]
                    });
                } catch {}
            }

            logger.info(`View-once (${target.mediaType}) berhasil diproses.`);
        } catch (error) {
            console.error('[OV] Error pada perintah onceview:', error);
            logger.error(error, 'Error pada perintah onceview');
        }
    }
};

