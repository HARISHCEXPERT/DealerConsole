import { applyCreds } from './config/creds.js';
import { licenseGate, licenseRoutes, licenseActive, startLicenseLoop } from './license/license.js';
import { autoSyncTick, autoSyncConfig } from './jobs/catchup.js';
import express from 'express';
import cron from 'node-cron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { env } from './config/env.js';
import { api } from './api/routes.js';
import { pullSaleToFile } from './jobs/pullSale.js';
import { eveningReport } from './jobs/eveningReport.js';
import { log, err } from './utils/logger.js';
import { checkLogin, makeToken, validToken, dropToken, getCookie, requireAuth } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dev: frontend root me (../frontend). release build: server.mjs ke bagal (app/frontend). cwd bhi dekho (.bat app me cd karta hai).
const pick = (sub, cands) => cands.find((d) => { try { return fs.existsSync(path.join(d, sub)); } catch { return false; } }) || cands[0];
const ASSET = pick('frontend', [__dirname, process.cwd(), path.join(__dirname, '..')]);
const NM = pick('@supabase', [path.join(ASSET, 'node_modules'), path.join(__dirname, 'node_modules'), path.join(process.cwd(), 'node_modules'), path.join(__dirname, '..', 'node_modules')]);
log(`[paths] frontend: ${path.join(ASSET, 'frontend')}`);

const app = express();
app.use(express.json({ limit: '25mb' }));   // PDF export me poori list aati hai
app.get('/health', (_req, res) => res.json({ ok: true }));

// ---- AUTH ----
app.post('/auth/login', (req, res) => {
  const { user, pass } = req.body || {};
  if (checkLogin(user, pass)) {
    const t = makeToken();
    res.setHeader('Set-Cookie', `dc_session=${t}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax`);
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, error: 'Galat username ya password' });
});
app.post('/auth/logout', (req, res) => {
  const t = getCookie(req, 'dc_session'); if (t) dropToken(t);
  res.setHeader('Set-Cookie', 'dc_session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/auth/check', (req, res) => {
  res.json({ ok: validToken(getCookie(req, 'dc_session')) });
});

// License admin panel — sirf tumhare PC pe (.env me ADMIN_PANEL=1). Dealer ke PC pe ye page hota hi nahi.
// Login Supabase admin email/password se (app ka login nahi chahiye).
if (process.env.ADMIN_PANEL === '1') {
  app.get(['/admin', '/admin.html'], (_req, res) => {
    const cfg = JSON.stringify({ url: process.env.LICENSE_URL || '', key: process.env.LICENSE_ANON_KEY || '' }).replace(/</g, '\\u003c');
    const html = fs.readFileSync(path.join(ASSET, 'admin', 'admin.html'), 'utf8')
      .replace('<script>\nconst $', `<script>window.DC_ADMIN_CFG=${cfg};</script>\n<script>\nconst $`);
    res.type('html').send(html);
  });
  // supabase-js apne node_modules se (CDN/internet block ho to bhi chale)
  app.get('/admin/supabase.js', (_req, res) => res.sendFile(path.join(NM, '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js')));
  log('License admin panel: http://localhost:' + env.port + '/admin');
}

// login page + its assets — bina auth ke
app.get('/login', (_req, res) => res.sendFile(path.join(ASSET, 'frontend', 'login.html')));

// Dealer build: app ka alag admin/password login nahi — LICENSE hi ekmaatra login.
// DC_NO_APP_LOGIN=1 (release .env) -> auth gate khula; license.js ki screen + licenseGate hi rok hai.
const noAppLogin = process.env.DC_NO_APP_LOGIN === '1';
const authGate = noAppLogin ? (_req, _res, next) => next() : requireAuth;
if (noAppLogin) log('[auth] app login band — sirf License se (dealer build)');

// API protected
// License: status/activate hamesha khule; baaki /api license ke peeche
const lic = express.Router(); licenseRoutes(lic);
app.use('/api', authGate, lic);
app.use('/api', authGate, licenseGate, api);

// Frontend: agar login nahi -> login page bhej do (index/master/etc.)
app.use((req, res, next) => {
  if (noAppLogin) return next();                       // dealer build: seedha page do, license.js khud gate karega
  // login page/assets allow
  if (req.path === '/login' || req.path.startsWith('/auth')) return next();
  if (!validToken(getCookie(req, 'dc_session'))) {
    // html page maang raha hai to login pe bhejo
    if (req.method === 'GET' && (req.path === '/' || req.path.endsWith('.html'))) {
      return res.redirect('/login');
    }
    return res.status(401).send('auth required');
  }
  next();
});
app.use(express.static(path.join(ASSET, 'frontend')));
// Excel library local se (internet ke bina bhi export chale)
app.use('/vendor', express.static(path.join(NM, 'xlsx', 'dist')));

// ---- AUTO-SYNC: har 3 ghante, 9am–9pm IST (9,12,15,18,21) ----
// Sirf tab jab sale creds ho. Sale na ho to guard "No sales" handle karta hai (crash nahi).
// Band by default (abhi reports pe kaam, live DMS nahi). Chahiye to .env me DMS_SALE_CRON=1
const haveSale = env.dmsSale.user && env.dmsSale.pass && process.env.DMS_SALE_CRON === '1';
if (haveSale) {
  cron.schedule('0 9,12,15,18,21 * * *', async () => {
    try {
      const r = await pullSaleToFile();
      log('[auto-sync] sale:', r.count, r.note ? '· ' + r.note : '');
    } catch (e) { err('[auto-sync] fail:', e.message); }
  }, { timezone: env.tz });
  log(`auto-sync ON — 9,12,15,18,21 ${env.tz}`);
} else {
  log('DMS live sale cron OFF');
}
// cron.schedule('0 21 * * *', () => eveningReport(process.env.DEFAULT_DEALER_ID));

// koi scraper beech me bina pakde error phenke to bhi server band na ho — log karo, chalte raho
process.on('unhandledRejection', (e) => err('[server] unhandled:', e?.stack || e));
process.on('uncaughtException', (e) => err('[server] uncaught:', e?.stack || e));

// ID/password: screen wale (secure.db) .env ke upar
applyCreds();
// subah ka auto sync — har minute dekho, din me ek baar set samay ke baad (⚙ Sync Settings se on/off + samay)
// license chalu ho tabhi auto sync
const tick = () => { if (licenseActive()) autoSyncTick(); };
setTimeout(tick, 20000);
setInterval(tick, 60000);
startLicenseLoop();
{ const c = autoSyncConfig(); log(`auto Quick Sync ${c.on ? 'ON — roz ' + c.at + ' ke baad, din me ek baar' : 'OFF'}`); }

app.listen(env.port, () => log(`Dealer Console API on :${env.port}`));