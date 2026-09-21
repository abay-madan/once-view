# ONCEVIEW - Bot WhatsApp

ONCEVIEW adalah bot WhatsApp yang dikembangkan menggunakan Node.js dengan pustaka (library) `@whiskeysockets/baileys`. Fungsi utamanya adalah untuk mengekstrak pesan bertipe "view-once" (foto atau video sekali lihat) dan mengirimkannya kepada pemilik (owner) yang telah dikonfigurasi, serta mendukung obrolan pribadi (private chat) maupun grup. Bot ini bersifat modular, ringan, dan mudah disesuaikan.

## Fitur
* **Ekstraksi pesan view-once**: Mengunduh dan mengirimkan media foto o atau video dari pesan "view-once" kepada pemilik.
* **Perintah dengan awalan (prefiks)**: Menggunakan `!` di obrolan pribadi dan `?` di dalam grup.
* **Pembatasan di dalam grup**: Hanya administrator yang dapat menggunakan perintah `onceview`, dan dibatasi hanya satu kali eksekusi per grup.
* **Koneksi ulang otomatis**: Menangani kegagalan koneksi dengan fungsi percobaan ulang otomatis.
* **Basis data JSON**: Menyimpan data dalam file `database.json` untuk mengelola status bot.
* **Konfigurasi fleksibel**: Sesuaikan prefiks, pemilik, dan pengaturan lainnya di dalam file `config.js`.

## Persyaratan Sistem
* **Node.js**: Versi v18.0.0 atau yang lebih baru.
* **WhatsApp**: Akun aktif untuk proses autentikasi melalui kode QR.
* **Dependensi**: Lihat pada file `package.json`.

## Instalasi

1. Klon repositori GitHub:
   ```bash
   git clone https://github.com/mqrk0/onceview-wabot.git
   cd onceview-wabot
   ```

2. Instal semua dependensi yang diperlukan:
   ```bash
   npm install
   ```

3. Konfigurasikan file `config.js`:
   * Sesuaikan JID (ID WhatsApp) pada bagian `bot.owner` dan `bot.admins`.
   * Periksa kembali jalur (path) pada bagian `paths` untuk perintah (commands), penangan (handlers), dan basis data.

4. Jalankan bot:
   ```bash
   npm start
   ```
   Untuk proses pengembangan dengan fitur muat ulang otomatis (auto-reload):
   ```bash
   npm run dev
   ```

5. Autentikasi:
   * Pindai kode QR yang muncul di terminal menggunakan aplikasi WhatsApp Anda (Pengaturan > Perangkat Tautan / Linked Devices).
   * Data sesi akan disimpan secara otomatis di dalam folder `session`.

## Struktur Proyek
```
onceview-wabot/
├── commands/                 # Perintah-perintah bot
│   └── onceview.js          # Mengekstrak pesan view-once
├── handlers/                # Penangan peristiwa (event handlers)
│   ├── commandHandler.js    # Memproses perintah
│   ├── groupHandler.js      # Menangani pesan grup
│   └── messageHandler.js    # Menangani pesan pribadi
├── node_modules/            # Dependensi Node.js
├── session/                 # Data sesi login
├── utils/                   # Utilitas / Fungsi bantuan
│   ├── database.js          # Pengelolaan basis data JSON
│   └── helpers.js           # Pencatat riwayat (logger) kustom
├── config.js                # Konfigurasi bot
├── database.json            # Berkas basis data JSON
├── index.js                 # Titik masuk utama (entry point)
└── package.json             # Skrip dan dependensi proyek
```

## Cara Penggunaan
* **Perintah Utama**:
  * Ini fiturnya udah bisa automatis,jadi kalau ada yang mengirim onceview ,langsung bisa masuk di wa pribadi
  * `!onceview` (obrolan pribadi) atau `?onceview` (grup): Mengekstrak pesan sekali lihat dan mengirimkannya ke pemilik.
  * Di dalam grup, hanya administrator yang dapat menggunakannya dan dibatasi satu kali eksekusi untuk setiap grup.

* **Contoh Kasus**:
  1. Seorang pengguna mengirimkan pesan sekali lihat (view-once) di dalam grup.
  2. Administrator grup membalas (reply) pesan tersebut dengan mengetik `?onceview`.
  3. Bot akan mengunduh media tersebut (foto atau video) dan mengirimkannya ke pemilik bot yang telah dikonfigurasi.

## Konfigurasi
File `config.js` memungkinkan Anda untuk menyesuaikan:
* **session**: Folder dan nama untuk penyimpanan sesi.
* **bot**:
  * `prefix`: Prefiks `!` untuk obrolan pribadi.
  * `groupPrefix`: Prefiks `?` untuk grup.
  * `owner`: JID dari pemilik utama bot.
  * `admins`: Daftar JID dari para administrator.
  * `blockedUsers`: Daftar pengguna yang diblokir.
* **features**:
  * `silentMode`: Mengaktifkan/menonaktifkan mode senyap.
  * `autoRead`: Mengaktifkan/menonaktifkan fitur baca otomatis.
* **paths**: Jalur direktori untuk perintah, penangan, dan basis data.

## Kontribusi
1. Lakukan *fork* pada repositori ini.
2. Buat cabang baru (`git checkout -b feature/fitur-baru`).
3. Lakukan perubahan dan simpan dengan commit (`git commit -m 'Menambahkan fitur baru'`).
4. Unggah cabang tersebut (`git push origin feature/fitur-baru`).
5. Buka sebuah *Pull Request*.

## Lisensi
Lisensi ISC (silakan lihat file `package.json`).

## Penyangkalan (Aviso Legal / Disclaimer)
Bot ini tidak berafiliasi dengan WhatsApp. Gunakan dengan risiko Anda sendiri dan patuhi kebijakan WhatsApp untuk menghindari pemblokiran akun.
