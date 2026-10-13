// ============================================================
//  LOGIN ID / PASSWORD — alag database (db/secure.db), main data DB se alag.
//  Screen se badlo (⚙ Sync Settings). Password encrypt hoke rakha jaata hai (ENCRYPTION_KEY se), wapas kabhi screen pe nahi jaata.
//  Pehle yahan dekhte hain; yahan khaali ho to .env wala chalta hai (purana tareeka bhi chalta rahe).
//  Auto-sync ki setting (on/off, samay) bhi isi DB me.
// ============================================================
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { env } from './env.js';
import { encrypt, decrypt } from '../crypto/encrypt.js';

const FILE = process.env.SECURE_DB_FILE || path.resolve('db', 'secure.db');
let _db = null;
function sdb() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  _db = new DatabaseSync(FILE);
  _db.exec(`CREATE TABLE IF NOT EXISTS creds (key TEXT PRIMARY KEY, user TEXT, pass TEXT, url TEXT, updatedAt TEXT);
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);`);
  return _db;
}

// kaunsi ID kis kaam ki — screen pe yahi dikhta hai
export const CRED_KEYS = [
  { key: 'pbi', label: 'PowerBI (Hero reports)', userLabel: 'Email', uses: 'Sale, Purchase, Enquiry, Parts reports, JobCards' },
  { key: 'dms', label: 'Hero Connect — DMS (Sale / Parts)', userLabel: 'User ID', uses: 'DMS sale (live)' },
  { key: 'dms_service', label: 'Hero Connect — Service', userLabel: 'User ID', uses: 'Service JobCard Invoices' },
  { key: 'warranty', label: 'Warranty Portal (SSP)', userLabel: 'User ID', uses: 'FSC, Warranty, Claim Report, Statement' },
];

// env object me daal do — saare scrapers env.* call ke waqt padhte hain, isliye turant lag jaata hai
const target = (key) => key === 'pbi' ? [env.pbi, 'email'] : key === 'dms' ? [env.dms, 'user'] : key === 'dms_service' ? [env.dmsService, 'user'] : key === 'warranty' ? [env.warranty, 'user'] : [null];
const ENV0 = {};   // .env wali asli value (DB se hatao to wapas yahi)
function remember() {
  for (const { key } of CRED_KEYS) { const [o, uf] = target(key); if (o && !ENV0[key]) ENV0[key] = { user: o[uf] || '', pass: o.pass || '' }; }
}
const mask = (u) => { u = String(u || ''); return u.length <= 4 ? (u ? u[0] + '***' : '(khaali)') : u.slice(0, 3) + '***' + u.slice(-2); };
// kaunsi ID kahan se aa rahi — terminal me dikhane ke liye
export function credSummary() {
  return CRED_KEYS.map((c) => { const [o, uf] = target(c.key); const r = sdb().prepare('SELECT user FROM creds WHERE key = ?').get(c.key);
    return `${c.label}: ${mask(o?.[uf])} (${r?.user ? '⚙ screen' : o?.[uf] ? '.env' : 'KHAALI'})`; }).join(' | ');
}
export { mask as maskId };
export function applyCreds() {
  remember();
  for (const { key } of CRED_KEYS) {
    const [o, uf] = target(key); if (!o) continue;
    const r = sdb().prepare('SELECT user, pass FROM creds WHERE key = ?').get(key);
    let pass = null;
    if (r?.pass) { try { pass = decrypt(r.pass); } catch { pass = null; } }
    o[uf] = r?.user || ENV0[key].user;
    o.pass = pass || ENV0[key].pass;
    if (key === 'dms') {                         // DMS sale/parts: alag .env ID na ho to shared wali
      for (const x of [env.dmsSale, env.dmsParts]) {
        if (r?.user) { x.user = r.user; if (pass) x.pass = pass; }
      }
    }
  }
  console.log('[creds] ' + credSummary());
}
export function listCreds() {
  return CRED_KEYS.map((c) => {
    const r = sdb().prepare('SELECT user, pass, updatedAt FROM creds WHERE key = ?').get(c.key);
    const [o, uf] = target(c.key);
    return { ...c, user: o?.[uf] || '', hasPass: !!o?.pass, from: r?.user || r?.pass ? 'screen' : (o?.[uf] ? '.env' : ''), updatedAt: r?.updatedAt || null };
  });
}
// pass khaali = purana password hi rakho (sirf ID badli)
export function saveCreds(key, user, pass) {
  if (!CRED_KEYS.find((c) => c.key === key)) throw new Error('galat key');
  const old = sdb().prepare('SELECT pass FROM creds WHERE key = ?').get(key);
  const enc = pass ? encrypt(String(pass)) : (old?.pass || null);
  sdb().prepare(`INSERT INTO creds (key, user, pass, updatedAt) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET user = excluded.user, pass = excluded.pass, updatedAt = excluded.updatedAt`)
    .run(key, String(user || '').trim(), enc, new Date().toISOString());
  applyCreds();
}

// ---- auto sync setting ----
export function getSetting(k, def = null) { const r = sdb().prepare('SELECT value FROM settings WHERE key = ?').get(k); return r ? r.value : def; }
export function setSetting(k, v) { sdb().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v == null ? null : String(v)); }
