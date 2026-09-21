import { join } from 'path';

export default {
    session: {
        name: 'session',
        path: join(process.cwd(), 'session'),
        saveInterval: 60_000
    },
    bot: {
        prefix: '!',
        groupPrefix: '?',
        owner: '6285217161933@s.whatsapp.net',
        admins: [
            '6285217161933@s.whatsapp.net'
        ],
        blockedUsers: [] // Daftar pengguna yang diblokir
    },
    features: {
        silentMode: false,
        autoRead: false,
        limits: {
            stickerSize: 10000000
        }
    },
    paths: {
        commands: join(process.cwd(), 'commands'),
        handlers: join(process.cwd(), 'handlers'),
        database: join(process.cwd(), 'database.json')
    }

};
