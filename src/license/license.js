// ============================================================
//  LICENSE — app side
//  - Pehli baar: dealer ka Login ID/Password -> Supabase Edge Function 'license' -> signed token
//  - Token ko PUBLIC key se jaancha jaata hai (koi bana/badal nahi sakta)
//  - Token sirf issi PC pe chalta hai (deviceId)
//  - Har 6 ghante online refresh. Bina internet 3 din tak chalega, phir ek baar online chahiye
//  - Ghadi peeche ki (clock tamper) to lock
//  - Expiry ke baad: sirf expiry tak ka data dikhega, sync/export band
//  .env:  LICENSE_URL=https://xxxx.supabase.co   LICENSE_ANON_KEY=eyJ...   (LICENSE_SUPPORT=renew ke liye phone, optional)
// ============================================================
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { LICENSE_PUBLIC_KEY } from './pubkey.js';
import { getSetting, setSetting } from '../config/creds.js';

export const GRACE_DAYS = 3;            // bina internet kitne din
export const WARN_DAYS = 7;             // expiry se kitne din pehle banner
const REFRESH_MS = 6 * 3600e3;          // har 6 ghante
const CLOCK_SLACK_MS = 15 * 60e3;       // 15 min tak ghadi ka farak chalega
const DAY = 86400e3;

const APP_VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).version || ''; } catch { return ''; } })();
const fnUrl = () => (process.env.LICENSE_URL || '').replace(/\/+$/, '') + '/functions/v1/license';

// ---------- is PC ki pehchaan ----------
let _dev = null;
export function deviceId() {
  if (_dev) return _dev;
  let mid = '';
  try {
    if (process.platform === 'win32') {
      const out = execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      mid = (out.match(/MachineGuid\s+REG_SZ\s+([\w-]+)/i) || [])[1] || '';
    } else if (fs.existsSync('/etc/machine-id')) mid = fs.readFileSync('/etc/machine-id', 'utf8').trim();
  } catch { /* fallback neeche */ }
  if (!mid) mid = [os.hostname(), os.cpus()[0]?.model || '', os.totalmem()].join('|');
  _dev = crypto.createHash('sha256').update('dealer-console|' + mid).digest('hex').slice(0, 40);
  return _dev;
}
const deviceName = () => `${os.hostname()} (${os.userInfo().username})`.slice(0, 80);

// ---------- token ----------
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
export function verifyToken(tok) {
  if (!tok || /REPLACE_ME/.test(LICENSE_PUBLIC_KEY)) return null;
  const [p, s] = String(tok).split('.');
  if (!p || !s) return null;
  try {
    const body = unb64u(p);
    if (!crypto.verify(null, body, LICENSE_PUBLIC_KEY, unb64u(s))) return null;
    const pl = JSON.parse(body.toString('utf8'));
    if (pl.dev !== deviceId()) return null;          // doosre PC ka token
    return pl;
  } catch { return null; }
}

// state secure.db me: lic_token, lic_ok_at (aakhri safal online check, local ms), lic_iat (server ka sabse naya samay)
function saveToken(tok, pl) {
  setSetting('lic_token', tok);
  setSetting('lic_ok_at', String(Date.now()));
  const iat = Date.parse(pl.iat) || 0;
  if (iat > Number(getSetting('lic_iat', '0'))) setSetting('lic_iat', String(iat));
}
function clearToken() { setSetting('lic_token', null); setSetting('lic_ok_at', null); }

async function callFn(body) {
  if (!process.env.LICENSE_URL || !process.env.LICENSE_ANON_KEY) throw Object.assign(new Error('.env me LICENSE_URL / LICENSE_ANON_KEY nahi hai'), { config: true });
  const key = process.env.LICENSE_ANON_KEY;
  const r = await fetch(fnUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: key, Authorization: 'Bearer ' + key },
    body: JSON.stringify({ ...body, deviceId: deviceId(), version: APP_VERSION }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  return { http: r.status, ...j };
}

// ---------- status (har request pe — sasta hai) ----------
const ymdIST = (ms) => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);
export function licenseStatus() {
  const support = process.env.LICENSE_SUPPORT || '';
  if (/REPLACE_ME/.test(LICENSE_PUBLIC_KEY)) return { state: 'none', msg: 'App me license key nahi (npm run license-keygen)', support };
  const pl = verifyToken(getSetting('lic_token'));
  if (!pl) return { state: 'none', support, lastError: getSetting('lic_err') || '' };
  const now = Date.now();
  const base = { dealer: pl.dealer, name: pl.name, plan: pl.plan, exp: pl.exp, expDate: ymdIST(Date.parse(pl.exp)), support };
  const lastIat = Number(getSetting('lic_iat', '0'));
  if (lastIat && now < lastIat - CLOCK_SLACK_MS) return { ...base, state: 'clock', msg: 'Computer ki tareekh/samay galat hai — sahi karke dobara kholo' };
  if (pl.status !== 'active') return { ...base, state: 'suspended', msg: 'License roka gaya hai' };
  const okAt = Number(getSetting('lic_ok_at', '0'));
  const offDays = (now - okAt) / DAY;
  if (!okAt || offDays > GRACE_DAYS) return { ...base, state: 'offline', msg: `${GRACE_DAYS} din se internet pe license check nahi hua — internet chalu karke "Dobara check" dabao` };
  const left = Math.ceil((Date.parse(pl.exp) - now) / DAY);
  if (left <= 0) return { ...base, state: 'expired', daysLeft: 0 };
  return { ...base, state: 'active', daysLeft: left, warn: left <= WARN_DAYS, offlineDays: Math.floor(offDays) };
}
export const licenseActive = () => licenseStatus().state === 'active';

// ---------- online ----------
export async function activate(login, password) {
  const r = await callFn({ action: 'activate', login, password, deviceName: deviceName() });
  if (!r.ok || !r.token) throw new Error(r.error || 'License server se jawab nahi (HTTP ' + r.http + ')');
  const pl = verifyToken(r.token);
  if (!pl) throw new Error('Server ka token is app ki key se match nahi hua (pubkey.js / LICENSE_PRIVATE_KEY alag?)');
  saveToken(r.token, pl); setSetting('lic_err', null);
  console.log(`[license] chalu: ${pl.name} (${pl.dealer}) · ${pl.plan} · ${ymdIST(Date.parse(pl.exp))} tak`);
  return licenseStatus();
}

export async function refresh() {
  const tok = getSetting('lic_token');
  if (!verifyToken(tok)) return licenseStatus();
  try {
    const r = await callFn({ action: 'refresh', token: tok });
    if (r.ok && r.token) {
      const pl = verifyToken(r.token);
      if (pl) { saveToken(r.token, pl); setSetting('lic_err', null); }
    } else if (r.revoke) {
      console.log('[license] hata diya gaya: ' + (r.error || '')); clearToken(); setSetting('lic_err', r.error || 'Dobara login karein');
    } else console.log('[license] refresh fail: ' + (r.error || r.http));
  } catch (e) { console.log('[license] offline: ' + e.message); }   // internet nahi — grace chalega
  return licenseStatus();
}

export function startLicenseLoop() {
  const s = licenseStatus();
  console.log(`[license] ${s.state}${s.name ? ' · ' + s.name : ''}${s.expDate ? ' · ' + s.expDate + ' tak' : ''}`);
  setTimeout(refresh, 5000);
  setInterval(refresh, REFRESH_MS);
}

// ---------- Express ----------
const LOCKED = new Set(['none', 'suspended', 'offline', 'clock']);
const dmy = (iso) => iso.split('-').reverse().join('/');
function clamp(v, max) {          // expiry ke baad ki tareekh -> expiry (format wahi rakho)
  const s = String(v || '');
  let iso = null, m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) iso = `${m[1]}-${m[2]}-${m[3]}`;
  else if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/))) iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (!iso || iso <= max) return v;
  return /^\d{4}-/.test(s) ? max : dmy(max);
}

// /api ke aage lagao (license routes ke baad)
export function licenseGate(req, res, next) {
  const s = licenseStatus();
  if (s.state === 'active') return next();
  if (LOCKED.has(s.state)) return res.status(402).json({ error: 'license', license: s });
  // expired: sirf dekhna, expiry tak ka
  if (req.method !== 'GET') return res.status(402).json({ error: 'payment_due', license: s, msg: `License ${dmy(s.expDate)} ko khatam — renew karein` });
  for (const k of ['from', 'to', 'date']) if (req.query[k]) req.query[k] = clamp(req.query[k], s.expDate);
  next();
}

export function licenseRoutes(router) {
  router.get('/license/status', (_req, res) => res.json(licenseStatus()));
  router.post('/license/activate', async (req, res) => {
    try { res.json({ ok: true, license: await activate(String(req.body?.login || ''), String(req.body?.password || '')) }); }
    catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });
  router.post('/license/refresh', async (_req, res) => res.json({ ok: true, license: await refresh() }));
}
