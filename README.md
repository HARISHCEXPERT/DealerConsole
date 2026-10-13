# Dealer Console — Full Stack

Dealership Business Management System.
Source-of-truth = Hero DMS (Sale/Service/Parts) + separate Warranty portal (Warranty/FSC).
Zero manual entry — Puppeteer roz data laata hai, normalize hoke append-only ledger me jaata hai.

## Layout

```
dealer-console/
├── frontend/index.html   # UI shell (4 module + dashboard). API se data, warna dummy fallback.
├── src/
│   ├── server.js         # Express: /api + frontend serve
│   ├── scrapers/
│   │   ├── heroDms/       # Source 1: login, sale, service, parts
│   │   └── warrantyPortal/# Source 2 (alag): login, warranty, fsc
│   ├── normalize/         # raw -> clean. FIELD SHAPES yahin (frontend binding se match)
│   ├── ledger/            # append.js (append-only) + reconcile.js (parts antar)
│   ├── crypto/            # app-level encrypt (key app-server pe, Supabase pe nahi)
│   ├── api/               # routes + tenant/auth middleware
│   ├── jobs/              # dailyPull + eveningReport (WhatsApp)
│   └── delivery/          # whatsapp.js (BotSaathi pipe)
├── db/schema.sql
└── scripts/
    ├── test-login.js      # STEP 1: recon spike
    └── run-pull.js
```

## Frontend <-> Backend seam

`frontend/index.html` pehle API maangta hai, na mile to embedded dummy pe girta hai:
- **`npm start`** se serve karo -> `http://localhost:4000` -> same-origin `/api/...` (real data jab backend bharega)
- **File double-click** -> localhost try, fail -> dummy (offline bhi dikhta hai)

Puppeteer ka asli data aayega to render code waisa ka waisa — sirf source badlega.

## Build order (yahi se shuru)

1. `scripts/test-login.js` — DMS login + navigate prove karo. Selectors abhi TODO.
2. Report ka **export/download button** hai kya? Mila to scraping se bacho (10x tikau).
3. Raw data shape dekh ke `normalize/*` final karo.
4. `db/schema.sql` Supabase pe apply.
5. Sale module ka full loop: scrape -> normalize -> ledger -> API -> frontend.
6. Baaki module usi pattern pe.

## Database (local SQLite — db/dealer.db)

Dealer ka saara data ek file me, usi ke PC pe. Node 22.13+ ka built-in `node:sqlite` — koi install nahi.

- `src/sources/index.js` — har report ki config (table, key, fields). **Naya report = yahan ek entry.**
- `src/db/engine.js` — table khud banata hai, naya Excel column aaye to column khud jodta hai,
  kachchi row `raw_rows` me rakhta hai, har sync `sync_runs` me likhta hai.
- Modes: `upsert` (key se update — VSR, enquiry, purchase) · `replace` (poora invoice hata ke naya — parts)

```bash
npm run import-json   # ek baar: purane data/*.json -> DB
npm run db-status     # har table: rows, date range, KHAALI MAHINE, last syncs
npm run reprocess     # config/cleanup badla? DMS dobara pull kiye bina tables dobara banao
```

## Run

```bash
npm install
cp .env.example .env      # DMS creds, Supabase, enc key bharo
npm start                 # http://localhost:4000  (UI + API)
node scripts/test-login.js
```
Node 18+ (global fetch built-in — node-fetch ESM jhamela nahi).
