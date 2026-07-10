# CLAUDE.md — Pentagon / Domain Radar

Panduan untuk Claude (dan developer) saat bekerja di repo ini. Baca ini dulu sebelum
menulis kode agar tidak perlu re-eksplorasi arsitektur setiap sesi.

> Repo GitHub bernama **Pentagon**, tapi aplikasinya adalah **Domain Radar**
> (`package.json` → `"name": "domain-radar"`). Kode dikembangkan di Replit lalu
> di-push ke GitHub. Perlakukan "Pentagon" dan "Domain Radar" sebagai hal yang sama.

---

## 1. Apa ini

Domain Radar adalah **dashboard monitoring domain** untuk mendeteksi apakah sebuah
domain **working / warning / blocked** — dengan fokus khusus pada **pemblokiran ISP
Indonesia** (Internet Positif / TrustPositif / Nawala). Fitur inti:

- Cek domain dari banyak sudut: **Direct**, lewat **Proxy**, dan lewat **Provider Node**
  (perangkat nyata di jaringan Telkomsel/XL/Indosat/Tri/IndiHome/Biznet/VPS).
- **TrustPositif / Internet Positif registry check** sebagai bukti pemblokiran resmi.
- **Rank checker / SEO** (posisi domain di Google SERP per keyword group, per node).
- **Alert Telegram**: perubahan status, digest per jam, laporan rank, emergency alert
  berulang untuk domain yang diblokir sampai di-acknowledge.
- **SEO Audit** berbasis OpenAI, analytics, activity tracking (siapa online, watch-hours).
- **Multi-tenant ringan**: akun `admin` (data asli) vs `demo` (read-only sandbox).

Bahasa domain sering campur Indonesia/Inggris (mis. "Ada / Tidak Ada" = status
TrustPositif). Pertahankan gaya itu di UI dan pesan Telegram.

---

## 2. Tech stack

| Layer | Teknologi |
|---|---|
| Backend | Node.js 20, Express 4, `node-cron`, `pg` (PostgreSQL) |
| Frontend | React 18 + Vite 5 (bukan CRA, bukan Next). Ikon `lucide-react`. |
| DB | PostgreSQL (Replit/Neon). SSL `rejectUnauthorized:false` kecuali localhost. |
| Integrasi | Telegram Bot API (via `axios`), OpenAI (`openai` v6), Google SERP scrape (`cheerio`) |
| Proxy | `https-proxy-agent`, `socks-proxy-agent` |
| Node agent | Express kecil terpisah di `agent/` + `provider-node-kit/` (buat Termux/VPS) |
| Deploy | Replit (autoscale). Lihat `.replit`. |

**Tidak ada** TypeScript, tidak ada test runner, tidak ada ORM (SQL mentah lewat `pool.query`),
tidak ada linter yang terkonfigurasi. Jangan berasumsi ada `npm test`.

---

## 3. Cara menjalankan

```bash
npm install
npm run db:init        # buat tabel dari server/db/schema.sql (sekali di awal)
npm run dev            # jalankan server (port 3000) + client Vite (port 5000) paralel
```

Script penting (`package.json`):

| Script | Fungsi |
|---|---|
| `npm run dev` | `concurrently` server + client (dev) |
| `npm run server` | hanya API server → `node server/index.js` (port `PORT`, default 3000) |
| `npm run client` | hanya Vite dev server di `0.0.0.0:5000` |
| `npm run build` | `vite build` → menghasilkan `dist/` |
| `npm start` | production: `node server/index.js` (server juga meng-serve `dist/`) |
| `npm run db:init` | inisialisasi tabel DB |
| `npm run agent` | jalankan provider-node agent (di perangkat provider, bukan di server pusat) |
| `npm run agent:poll` | agent mode polling (untuk node di belakang NAT tanpa public URL) |
| `npm run nodes:seed` | seed polling nodes |

**Production topology:** `server/index.js` meng-serve API **dan** static `dist/`
(SPA fallback ke `dist/index.html`). Vite hanya dipakai saat dev. Di Replit,
`.replit` menjalankan `npm start` dan build-nya `npm run build`.

---

## 4. Struktur direktori

```
server/                 # Backend Express — semua logika inti
  index.js              # Entry point: middleware, auth, mount routes, boot migrations, SPA serve
  checker.js            # checkDomain() + calculateGlobalStatus() — INTI penilaian status
  scheduler.js          # Cron loop, digest Telegram, recurring alerts, auto rank check
  confirm.js            # Debounce perubahan status (butuh N konfirmasi berturut)
  nodeChecker.js        # Cek domain via provider node (HTTP langsung / polling)
  providerBlockVerifier.js  # Cek registry TrustPositif/Internet Positif
  reasonClassifier.js   # Klasifikasi tipe alasan (DNS/HTTP/BLOCK/dll)
  telegram.js           # Kirim pesan Telegram (global + per-project)
  telegramDigest.js
  *Routes.js            # Router per fitur (lihat tabel di §6)
  settingsStore.js / runtimeSettings.js  # Setting runtime dari DB (bisa diubah tanpa restart)
  authAllowlist.js      # Whitelist email admin
  demoSeed.js           # Seed data akun demo
  noticeState.js        # State "acknowledged" untuk alert blocked
  db/
    index.js            # Pool pg
    schema.sql          # Skema dasar (domains, proxies, check_results, alerts)
    init.js             # Runner schema.sql
src/                    # Frontend React (Vite)
  App.jsx               # Root SPA: 7 halaman (tab), login, dashboard, node cards
  DefenseCenterPage.jsx # Halaman "defense" (rank defense)
  AnalyticsPage.jsx     # Analytics + SEO audit
  DomainPopup.jsx       # Detail domain
  *.css
public/                 # Aset & UI enhancement JS/CSS yang di-load statis (bukan lewat Vite bundle)
agent/                  # Provider node agent (dijalankan di perangkat jaringan provider)
provider-node-kit/      # Kit distribusi agent (README, setup Replit, runbook Termux)
scripts/                # Skrip maintenance/seed sekali jalan
docs/                   # Dokumentasi fitur (PROVIDER_NODES.md dll)
.agents/memory/         # Catatan pola arsitektur penting — BACA sebelum ubah area terkait
attached_assets/        # Screenshot/gambar histori (bukan kode; aman diabaikan)
dist/                   # Hasil build Vite (di-serve production; tidak di-commit)
```

---

## 5. Data model (PostgreSQL)

Skema **dasar** ada di `server/db/schema.sql`, tapi **banyak tabel & kolom dibuat
secara lazy** di runtime (lihat §8). Jangan berasumsi `schema.sql` lengkap.

Tabel inti:

- **`domains`** — domain yang dimonitor. Kolom penting: `global_status` (working/warning/
  blocked/unknown), `last_status`, `project_name`, `label` (`landing_page`|`ms`|''), `tenant`.
- **`check_results`** — setiap hasil cek per checker. `checker_type` ∈ `direct`, `proxy`,
  `node:<type>`, `provider_registry`. Plus `reason`, `reason_type`, `final_url`, `latency_ms`.
- **`proxies`** — daftar proxy (http/socks) untuk Proxy Center.
- **`alerts`** — riwayat perubahan status + apakah terkirim ke Telegram.
- **`provider_nodes`** — node checker (endpoint URL atau `poll://` untuk mode polling).
- **`node_telemetry`** — sinyal/baterai/operator per node.
- **`user_sessions`** — activity tracking (heartbeat, watch-hours, country via ip-api).
- **`app_settings`** — key/value setting runtime + nickname user.
- **`rank_keyword_groups` / `rank_keyword_domains` / `rank_scan_results`** — fitur rank/SEO.
- **`telegram_digest_state`**, **`telegram_recurring_alerts`** — state alert Telegram.

**Multi-tenant:** hampir semua tabel data punya kolom `tenant TEXT NOT NULL DEFAULT 'admin'`.
Baca `.agents/memory/demo-tenant-isolation.md` **sebelum** menambah tabel/route baru.

---

## 6. Peta API & fitur

Mount di `server/index.js`. Semua di bawah `requireAdmin` (kecuali auth, health,
webhook, agent poll). Write route dilindungi `requireNotDemo`/`requireNotDemoWrite`.

| Prefix | File | Isi |
|---|---|---|
| `/api/auth/*` | index.js | login/logout/me/users/nickname |
| `/api/domains`, `/api/proxies`, `/api/results`, `/api/overview`, `/api/alerts`, `/api/export/*.csv`, `/api/check/*` | index.js | CRUD domain/proxy, cek manual, export |
| `/api/settings` | settingsRoutes.js | setting runtime (token diredaksi untuk demo) |
| `/api/projects` | projectRoutes.js | grup project |
| `/api/rank` | rankRoutes.js | keyword groups, hasil rank, cek per node, intel, klasifikasi (15 endpoint) |
| `/api/analytics` | analyticsRoutes.js | summary, SEO audit (OpenAI), suggestion completion, score history |
| `/api/nodes` | nodeRoutes.js | CRUD provider node + preset + ping |
| `/api/agent` | agentPollRoutes.js | endpoint polling untuk node di belakang NAT |
| `/api/project-telegram` | projectTelegramRoutes.js | mapping project → chat Telegram |
| `/api/trustpositif` (`/api`) | trustpositifRoutes.js | cek registry TrustPositif |
| `/api/telegram/webhook` | index.js | callback tombol "Noticed" |
| `/api/activity/*` | index.js | heartbeat, sessions, watch-hours |

Frontend `src/App.jsx` punya 7 halaman: `dashboard`, `projects`, `rank`, `analytics`,
`defense`, `users`, `settings`.

---

## 7. Konsep domain yang WAJIB dipahami sebelum ubah logika

### a. Penilaian status — `checker.js` → `calculateGlobalStatus(results)`
Status global sebuah domain **tidak** sekadar "ada yang blocked". Aturannya konservatif
untuk menghindari false positive:
- **`blocked`** hanya jika ada **bukti keyword** (halaman memuat `internetpositif`/`nawala`/
  `trustpositif`) ATAU **registry evidence** (TrustPositif) — dan **jika ada node**, SEMUA
  node harus blocked.
- Hasil "blocked" yang tidak memenuhi kriteria penuh → **diturunkan ke `warning`**.
- Keyword deteksi diambil dari setting runtime `status_keywords` (bisa diubah dari UI).

### b. Debounce konfirmasi — `confirm.js` → `decide()`
Perubahan status hanya diterapkan setelah **N cek berturut** memberi hasil sama
(default 3, setting `retry_confirmations`). Selama pending, `last_status` diisi
`pending:<status>:<count>/<max>` dan UI menampilkan "⏳ Confirming". Ini mencegah alert
berkedip. **Jangan** apply status langsung tanpa lewat `decide()` di jalur scheduler.

### c. Provider nodes — `nodeChecker.js`
Dua mode:
- **HTTP langsung**: server pusat POST ke `<endpoint>/check` dengan header
  `x-domain-radar-secret`.
- **Polling** (`poll://...`): node yang di belakang NAT menarik task lewat `/api/agent`
  (`enqueueNodeTask`/`waitForNodeTask`). Dipakai untuk perangkat Termux tanpa public URL.

Agent-nya ada di `agent/provider-agent.js` (+ `provider-poll-agent.js`) dan didistribusikan
via `provider-node-kit/`. Setup lihat `docs/PROVIDER_NODES.md`.

### d. Alur pembuktian blokir (scheduler.js)
Direct/Node warning atau blocked → `maybeAddProviderRegistryResult()` memanggil
`verifyProviderBlock()` (TrustPositif). Kalau terkonfirmasi blocked → **emergency alert
Telegram berulang tiap ~60 detik** (`telegram_recurring_alerts`) sampai user klik tombol
**"Noticed"** (callback `noticed:<id>:blocked` → `noticeState.markAcknowledged`).

### e. Telegram digest — scheduler.js
Watchdog `setInterval` mengirim: **laporan status per jam** dan, berselang-seling,
**laporan rank per project**. State disimpan di `telegram_digest_state` supaya idempoten
antar proses/restart. Alert pakai HTML parse mode + tabel monospace (`<pre>`).

### f. Rank/SEO
`rank_keyword_groups` berisi keyword; scheduler `runAutoRankChecks` mengecek posisi
domain whitelisted di SERP via VPS + tiap node. Domain berlabel `landing_page` (LP) /
`ms` (money site) otomatis disinkron ke whitelist rank saat di-`PATCH`.

---

## 8. Konvensi & gotcha (penting saat mengedit)

- **Migrasi lazy, bukan file migrasi.** Banyak `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE
  ADD COLUMN IF NOT EXISTS` dijalankan saat `boot()` di `index.js` dan di awal beberapa
  modul (`getActiveNodes`, `ensureRankTables`, `ensureReasonTypeColumn`, dll). Kalau
  menambah kolom/tabel, ikuti pola ini agar aman idempoten — **jangan** hanya edit
  `schema.sql` (itu tidak dijalankan ulang setelah init).
- **Gaya kode padat satu baris.** Banyak route ditulis one-liner. Ikuti gaya file yang
  Anda sentuh; jangan reformat besar-besaran tanpa alasan.
- **SQL mentah + parameterized query** (`$1,$2`). Selalu pakai parameter, jangan string
  concat nilai user (kecuali interval literal yang sudah divalidasi seperti di watch-hours).
- **Multi-tenant.** Route GET filter `WHERE tenant=$1` (`getTenant(req)`); route write
  pakai `requireNotDemo`. Lihat `.agents/memory/demo-tenant-isolation.md`.
- **Setting runtime dari DB**, bukan hanya env. `getRuntimeSettings()` dibaca ulang tiap
  cek — perubahan dari UI langsung berlaku tanpa restart.
- **`public/*.js`** adalah patch UI yang di-load terpisah (bukan bagian bundle Vite `src/`).
  Perubahan di sana tidak butuh rebuild, tapi juga tidak ikut tree-shaking React.
- **`.agents/memory/`** = catatan keputusan arsitektur. Kalau menyelesaikan tugin yang
  mengubah pola penting, update/ tambah catatan di sana.
- **Timezone** laporan pakai WIB (`Asia/Jakarta`).
- **Rahasia**: jangan commit `.env`, token, atau `attached_assets` yang sensitif. Repo ini
  **public**. `env.sample` hanya berisi placeholder.

---

## 9. Environment variables

Wajib untuk fungsi penuh (set sebagai Replit Secrets / `.env`):

```
DATABASE_URL              # koneksi PostgreSQL (wajib)
TELEGRAM_BOT_TOKEN        # bot untuk alert
TELEGRAM_CHAT_ID          # chat/grup tujuan alert
CHECK_INTERVAL_SECONDS    # interval cron (default 60)
STATUS_KEYWORDS           # keyword blokir, koma: internetpositif,trustpositif,nawala
PORT                      # default 3000
```

Opsional (punya default di kode): `SESSION_SECRET`, `ADMIN_PASSWORD` (kalau kosong = tanpa
auth), `ADMIN_EMAIL`, `DEMO_PASSWORD` (default `Domainradar123`), `OPENAI_API_KEY`
(untuk SEO audit), `ALERT_COOLDOWN_MINUTES`, `DIGEST_INTERVAL_MINUTES`,
`HOURLY_DIGEST_MINUTES`, `DOMAIN_CHECK_CONCURRENCY` (default 5),
`RANK_CHECK_INTERVAL_MINUTES` (default 20), `TRUSTPOSITIF_ON_DIRECT_WARNING`,
`DOMAIN_RADAR_DASHBOARD_URL`.

Agent (provider-node-kit): `PROVIDER_NAME`, `NETWORK_TYPE`, `AGENT_SECRET`, `AGENT_PORT`.

---

## 10. Deploy (Replit)

`.replit`: modules `nodejs-20`; port internal 5000 → external 80; `build = npm run build`,
`run = node server/index.js`, target `autoscale`. Ada hook `postMerge` →
`scripts/post-merge.sh`. Untuk import dari GitHub ke Replit dan set Secrets, lihat
`README.md` / `SETUP.md`.

---

## 11. Saat menyelesaikan tugas di sini

1. Server dan client terpisah — pastikan tahu apakah perubahanmu di API (`server/`) atau
   UI (`src/`). Perubahan UI butuh `npm run build` agar terlihat di production.
2. Tidak ada test otomatis: verifikasi manual dengan menjalankan `npm run dev` dan
   memeriksa endpoint/halaman terkait. Kalau menambah dependency, update `package.json`.
3. Ikuti pola migrasi lazy untuk perubahan schema.
4. Jaga isolasi tenant demo untuk setiap route/tabel baru.
5. Commit dengan pesan deskriptif; jangan push rahasia.
