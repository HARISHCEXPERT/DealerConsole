// ============================================================
//  AUTOMATION → BILLING (pehle se bani enquiry ka bill)
//  - Pending enquiry: enquiries table (PowerBI sync) — WON/LOST/Duplicate nahi, aur us mobile pe VSR me bill nahi
//  - VIN: live vehicle stock (Master + purchase − sale) — last 5 ank se dhoondho
//  - Financer list: VSR me ab tak aaye financer
//  - Billing draft: gaadi + cash/finance + paisa kaise aaya — billing_drafts table (DMS me abhi kuch nahi likhte)
// ============================================================
import { Router } from 'express';
import { db } from '../db/index.js';
import { tableExists } from '../db/engine.js';
import { toDMY } from '../db/types.js';
import { vehiclesLive } from './stock.js';
import { launchBrowser } from '../scrapers/browser.js';
import { loginDms } from '../scrapers/heroDms/login.js';
import { billParts } from '../scrapers/partsBilling.js';
import { env } from '../config/env.js';
import { getSetting, setSetting } from '../config/creds.js';

export const billingApi = Router();
const digits = (s) => String(s || '').replace(/\D/g, '');

// ============================================================
//  PARTS BILL — DMS (Siebel) me counter parts ka bill kaato
//  Logged-in DMS session (.profiles) use karta hai, browser VISIBLE (⚙ Settings).
//  Price All + Fulfill All tak jaata hai, phir RUK — staff review/generate kare.
// ============================================================
const PARTS_VIEW = 'https://connect.heromotocorp.biz/siebel/app/edealerasc/enu/?SWECmd=GotoView&SWEView=HMCL+Order+Entry+-+Line+Item+Actions+View&SWERF=1&SWEHo=&SWEBU=1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let billBrowser = null;
let billPage = null;        // hamara ek hi working tab (track karke extra tabs band karte hain)

// view kholo + "Session Warning" aaye to "here" (close old + new session) daba ke view dobara
async function gotoView(page, url) {
  // navigate se PEHLE extra tab band (Create Invoice beech me doosra tab khol de -> doosra session)
  try { for (const p of await page.browser().pages()) { if (p !== page && !p.isClosed()) { try { await p.close(); } catch {} } } } catch {}
  const nav = async () => { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {}); await sleep(3500); };
  await nav();
  for (let i = 0; i < 2; i++) {
    const warned = await page.evaluate(() => {
      const t = document.body ? document.body.innerText : '';
      if (!/Session Warning/i.test(t)) return false;
      const links = [...document.querySelectorAll('a')].filter((a) => /here/i.test(a.textContent || ''));
      const a = links[1] || links[2] || links[0];        // "close it and launch a new session" wala
      if (a) { a.click(); return true; } return false;
    }).catch(() => false);
    if (!warned) break;
    console.log('[bill] ⚠ Session Warning -> naya session');
    await sleep(5000);
    await nav();
  }
}

// logged-in DMS page lao (billing ke liye ALAG profile = P20, V20 sync se alag)
// RULE: pehle DMS base poora OPEN hone do (login/home), uske BAAD view link kholo.
async function dmsBillPage(creds) {
  // REUSE: hamara working tab (billPage) hi use karo; baaki jo tab khule unhe BAND karo
  // (warna doosra tab = doosra Siebel session = "Session Warning" + baar-baar login)
  if (billBrowser && billPage) {
    try {
      if (billBrowser.isConnected() && !billPage.isClosed()) {
        for (const p of (await billBrowser.pages())) { if (p !== billPage && !p.isClosed()) { try { await p.close(); } catch {} } }
        await billPage.bringToFront().catch(() => {});
        const onLogin = (await billPage.$('input[name="SWEUserName"]')) || /SWECmd=Login/i.test(billPage.url());
        if (onLogin) {                                   // session expire -> dobara login, warna reuse (re-login NAHI)
          if (!creds.user || !creds.pass) throw new Error('DMS login ID/password daalo (P20) — Settings me');
          console.log('[bill] session gayab -> dobara login');
          await loginDms(billPage, creds); await sleep(4000);
        }
        return billPage;
      }
    } catch {}
    billBrowser = null; billPage = null;
  }
  // FRESH launch — DEFAULT blank tab hi use karo (naya tab mat kholo), login ek hi baar
  const browser = await launchBrowser('billing');   // .profiles/billing — alag session
  const page = (await browser.pages())[0] || await browser.newPage();
  console.log('[bill] DMS base khul raha…');
  await page.goto(creds.url, { waitUntil: 'networkidle2', timeout: 90000 });
  await sleep(3000);
  if (await page.$('input[name="SWEUserName"]')) {
    if (!creds.user || !creds.pass) throw new Error('DMS login ID/password daalo (P20) — Settings me');
    await loginDms(page, creds);
  }
  await sleep(4000);
  billBrowser = browser; billPage = page;
  return page;
}

billingApi.post('/auto/billing/parts', async (req, res) => {
  const b = req.body || {};
  const mobile = digits(b.mobile);
  const partNo = String(b.partNo || '').trim();
  const qty = Number(b.qty || 1) || 1;
  const discountPct = (b.discountPct === '' || b.discountPct == null) ? null : b.discountPct;
  const lines = Array.isArray(b.lines) && b.lines.length ? b.lines : (partNo ? [{ partNo, qty }] : []);
  if (mobile.length < 10) return res.status(400).json({ error: 'Mobile number sahi do (10 ank)' });
  if (!lines.length) return res.status(400).json({ error: 'Part number do' });
  // billing login (P20) — abhi box se; na ho to .env/settings wali DMS creds
  const creds = {
    url: env.dms.url,
    user: String(b.user || '').trim() || env.dms.user,
    pass: (b.pass != null && b.pass !== '') ? String(b.pass) : env.dms.pass,
  };

  const logs = [];
  const orig = console.log;
  console.log = (...a) => { const s = a.map(String).join(' '); if (/\[(bill|login|browser)\]/.test(s)) logs.push(s); orig(...a); };
  try {
    const page = await dmsBillPage(creds);           // DMS base khul chuka
    await page.bringToFront().catch(() => {});
    // 3) ab (app khulne ke BAAD) view link kholo (+ Session Warning handle)
    console.log('[bill] view link khul raha…');
    await gotoView(page, PARTS_VIEW);
    await billParts(page, { mobile, lines, discountPct });
    res.json({ ok: true, logs, note: 'Price All + Fulfill All ho gaya. Browser khula hai — review karke bill generate karo.' });
  } catch (e) {
    logs.push('[bill] ERROR: ' + e.message);
    res.status(500).json({ error: e.message, logs });
  } finally {
    console.log = orig;
  }
});

// ============================================================
//  HELMET BILLING — bikī gaadiyon pe free-helmet (2) ka bill
//  Settings se part#/qty/disc + P20 id/pass; vehicle_sales list; batch (ek login);
//  bill ke baad helmet_bills (VIN key) me status -> dubara na kate.
// ============================================================
function ensureHelmet() {
  db().exec(`CREATE TABLE IF NOT EXISTS helmet_bills (vin TEXT PRIMARY KEY, phone TEXT, name TEXT, soNo TEXT, billedAt TEXT)`);
  try { db().exec(`ALTER TABLE helmet_bills ADD COLUMN invoiceNo TEXT`); } catch (e) { /* column pehle se hai */ }
}
function helmetCfg() {
  return {
    user: (getSetting('helmet_user', '') || '').trim(),
    pass: getSetting('helmet_pass', '') || '',
    partNo: (getSetting('helmet_part', '') || '').trim(),
    qty: Number(getSetting('helmet_qty', '2')) || 2,
    disc: getSetting('helmet_disc', '99.9') || '99.9',
  };
}

// --- settings get (pass masked) / save ---
billingApi.get('/auto/helmet/settings', (_req, res) => {
  const c = helmetCfg();
  res.json({ user: c.user, hasPass: !!c.pass, partNo: c.partNo, qty: c.qty, disc: c.disc });
});
billingApi.post('/auto/helmet/settings', (req, res) => {
  const b = req.body || {};
  if (b.user != null) setSetting('helmet_user', String(b.user).trim());
  if (b.pass != null && b.pass !== '') setSetting('helmet_pass', String(b.pass));
  if (b.partNo != null) setSetting('helmet_part', String(b.partNo).trim());
  if (b.qty != null) setSetting('helmet_qty', String(Number(b.qty) || 2));
  if (b.disc != null) setSetting('helmet_disc', String(b.disc));
  res.json({ ok: true });
});

// --- bikī gaadiyon ki list + helmet-billed status (filter: pending|billed|all) ---
billingApi.get('/auto/helmet/vehicles', (req, res) => {
  try {
    if (!tableExists('vehicle_sales')) return res.json({ rows: [], counts: { pending: 0, billed: 0, all: 0 } });
    ensureHelmet();
    const filter = String(req.query.filter || 'pending');
    const q = String(req.query.q || '').trim();
    const billed = new Map(db().prepare('SELECT vin, billedAt, invoiceNo FROM helmet_bills').all().map((r) => [String(r.vin).toUpperCase(), r]));
    let rows = db().prepare(`SELECT vin, customer, phone, model, variant, invoiceNo, invoiceDate, status FROM vehicle_sales
      WHERE IFNULL(status,'') NOT LIKE '%cancel%' AND phone IS NOT NULL AND TRIM(phone) <> '' ORDER BY invoiceDate DESC`).all();
    const seen = new Set();                                   // ek VIN ek baar (latest)
    rows = rows.filter((r) => { const k = String(r.vin).toUpperCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    rows = rows.map((r) => { const b = billed.get(String(r.vin).toUpperCase()); return { vin: r.vin, customer: r.customer, phone: r.phone, model: [r.model, r.variant].filter(Boolean).join(' '), date: toDMY(r.invoiceDate), billed: !!b, billedAt: b ? b.billedAt : null, helmetInvoiceNo: b ? (b.invoiceNo || '') : '' }; });
    const counts = { all: rows.length, billed: rows.filter((r) => r.billed).length, pending: rows.filter((r) => !r.billed).length };
    let out = rows;
    if (filter === 'pending') out = rows.filter((r) => !r.billed);
    else if (filter === 'billed') out = rows.filter((r) => r.billed);
    if (q) { const qd = q.replace(/\D/g, ''), ql = q.toLowerCase(); out = out.filter((r) => (qd.length >= 3 && String(r.phone).replace(/\D/g, '').includes(qd)) || String(r.customer || '').toLowerCase().includes(ql) || String(r.vin || '').toLowerCase().includes(ql) || String(r.model || '').toLowerCase().includes(ql)); }
    res.json({ rows: out.slice(0, 500), counts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- RESET: billing browser band karo (naye batch se pehle fresh session) ---
billingApi.post('/auto/helmet/reset', async (_req, res) => {
  try { if (billBrowser) { await billBrowser.close().catch(() => {}); } } catch (e) { /* ignore */ }
  billBrowser = null; billPage = null;
  console.log('[helmet] browser reset (fresh session)');
  res.json({ ok: true });
});

// --- PROCEED: selected VINs ka helmet bill (EK login me saare) ---
billingApi.post('/auto/helmet/bill', async (req, res) => {
  const vins = Array.isArray(req.body?.vins) ? req.body.vins.filter(Boolean) : [];
  if (!vins.length) return res.status(400).json({ error: 'Koi gaadi select nahi hui' });
  const cfg = helmetCfg();
  if (!cfg.partNo) return res.status(400).json({ error: 'Pehle Settings me helmet Part Number save karo' });
  ensureHelmet();
  const creds = { url: env.dms.url, user: cfg.user || env.dms.user, pass: cfg.pass || env.dms.pass };
  const billedSet = new Set(db().prepare('SELECT vin FROM helmet_bills').all().map((r) => String(r.vin).toUpperCase()));
  // selected VIN -> vehicle (mobile yahi se)
  const cars = [];
  for (const vin of vins) {
    const v = db().prepare(`SELECT vin, customer, phone, model FROM vehicle_sales WHERE UPPER(vin)=UPPER(?) ORDER BY invoiceDate DESC LIMIT 1`).get(vin);
    if (v) cars.push(v);
  }
  const logs = [], results = [];
  const orig = console.log;
  console.log = (...a) => { const s = a.map(String).join(' '); if (/\[(bill|login|browser|helmet)\]/.test(s)) logs.push(s); orig(...a); };
  try {
    const page = await dmsBillPage(creds);                  // EK hi login (base khulī)
    await page.bringToFront().catch(() => {});
    for (const v of cars) {
      const vinU = String(v.vin).toUpperCase(), mob = digits(v.phone);
      if (billedSet.has(vinU)) { results.push({ vin: v.vin, ok: false, skip: 'already billed' }); continue; }
      if (mob.length < 10) { results.push({ vin: v.vin, ok: false, error: 'mobile galat' }); console.log('[helmet] ✗ ' + v.vin + ' mobile galat'); continue; }
      console.log('[helmet] ===== ' + v.vin + ' | ' + (v.customer || '') + ' | ' + mob + ' =====');
      // RULE: view link base khulne ke BAAD + Session Warning handle
      await gotoView(page, PARTS_VIEW);
      let r;
      try { r = await billParts(page, { mobile: mob, lines: [{ partNo: cfg.partNo, qty: cfg.qty }], discountPct: cfg.disc }); }
      catch (e) { r = { ok: false, error: e.message }; }
      if (r && r.ok) {
        const invNo = r.invoiceNo || '';
        db().prepare(`INSERT INTO helmet_bills (vin, phone, name, soNo, billedAt, invoiceNo) VALUES (?,?,?,?,?,?)
          ON CONFLICT(vin) DO UPDATE SET phone=excluded.phone, name=excluded.name, soNo=excluded.soNo, billedAt=excluded.billedAt, invoiceNo=excluded.invoiceNo`)
          .run(v.vin, mob, v.customer || '', invNo, new Date().toISOString(), invNo);
        billedSet.add(vinU);
        results.push({ vin: v.vin, ok: true, invoiceNo: invNo });
        console.log('[helmet] ✓ BILLED ' + v.vin + (invNo ? ' — Invoice ' + invNo : ''));
      } else {
        results.push({ vin: v.vin, ok: false, error: (r && r.error) || ('ruk gaya' + (r && r.step ? ' (step ' + r.step + ')' : '')) });
        console.log('[helmet] ✗ ' + v.vin + ' — ' + ((r && r.error) || ('step ' + (r && r.step))));
      }
    }
    const done = results.filter((x) => x.ok).length;
    res.json({ ok: true, done, total: cars.length, results, logs });
  } catch (e) {
    logs.push('[helmet] ERROR: ' + e.message);
    res.status(500).json({ error: e.message, results, logs });
  } finally {
    console.log = orig;
  }
});
const ensure = () => db().exec(`CREATE TABLE IF NOT EXISTS billing_drafts (enquiryNo TEXT PRIMARY KEY, name TEXT, phone TEXT, vin TEXT, model TEXT,
  payType TEXT, financer TEXT, price REAL, received REAL, financeAmt REAL, balance REAL, data TEXT, status TEXT, updatedAt TEXT)`);

billingApi.get('/auto/billing/enquiries', (req, res) => {
  try {
    if (!tableExists('enquiries')) return res.json({ rows: [], note: 'Enquiry abhi sync nahi hui — Quick Sync karo' });
    const q = String(req.query.q || '').trim();
    const billed = new Set();
    if (tableExists('vehicle_sales')) for (const r of db().prepare(`SELECT phone FROM vehicle_sales WHERE phone IS NOT NULL AND IFNULL(status,'') NOT LIKE '%cancel%'`).all()) { const p = digits(r.phone).slice(-10); if (p) billed.add(p); }
    ensure();
    const drafts = new Map(db().prepare('SELECT enquiryNo, status, vin, updatedAt FROM billing_drafts').all().map((d) => [d.enquiryNo, d]));
    let rows = db().prepare('SELECT * FROM enquiries ORDER BY date DESC').all()
      .filter((r) => !/won|lost|dupl/i.test(r.outcome || '') && !/closed|lost|cancel/i.test(r.status || ''));
    const all = rows.length;
    rows = rows.filter((r) => !billed.has(digits(r.phone).slice(-10)));
    const hiddenBilled = all - rows.length;
    if (q) {
      const qd = digits(q), ql = q.toLowerCase();
      rows = rows.filter((r) => (qd.length >= 3 && digits(r.phone).includes(qd)) || String(r.name || '').toLowerCase().includes(ql) || String(r.enquiryNo || '').toLowerCase().includes(ql));
    }
    res.json({ total: rows.length, hiddenBilled, rows: rows.slice(0, 300).map((r) => ({ ...r, date: toDMY(r.date), draft: drafts.get(r.enquiryNo) || null })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// available VIN — q = last 5 (ya koi bhi hissa), model = enquiry ka model (optional)
billingApi.get('/auto/billing/vins', (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toUpperCase(), model = String(req.query.model || '').trim().toUpperCase();
    ensure();
    const taken = new Map(db().prepare(`SELECT vin, enquiryNo, name FROM billing_drafts WHERE vin IS NOT NULL AND vin <> ''`).all().map((d) => [d.vin.toUpperCase(), d]));
    const now = Date.now();
    const age = (dmy) => { const m = String(dmy || '').split('/'); if (m.length !== 3) return null; return Math.floor((now - Date.parse(`${m[2]}-${m[1]}-${m[0]}T00:00:00`)) / 864e5); };
    let rows = vehiclesLive().stock.map((v) => ({ ...v, age: age(v.stockInDate), takenBy: taken.get(String(v.vin).toUpperCase()) || null }));
    if (q) rows = rows.filter((v) => String(v.vin).toUpperCase().endsWith(q) || String(v.vin).toUpperCase().includes(q));
    const words = model.split(/[^A-Z0-9]+/).filter((w) => w.length >= 2);
    if (model && words.length) rows = rows.filter((v) => { const m = String(v.model + ' ' + v.variant).toUpperCase(); return words.every((w) => m.includes(w)); });
    rows.sort((a, b) => (b.age ?? -1) - (a.age ?? -1));        // purani gaadi pehle (pehle wahi becho)
    res.json({ total: rows.length, rows: rows.slice(0, 200) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

billingApi.get('/auto/billing/financers', (_req, res) => {
  try {
    if (!tableExists('vehicle_sales')) return res.json([]);
    res.json(db().prepare(`SELECT TRIM(financer) f, COUNT(*) n FROM vehicle_sales WHERE financer IS NOT NULL AND TRIM(financer) <> '' AND UPPER(TRIM(financer)) NOT IN ('CASH','NA','N/A','-') GROUP BY TRIM(financer) ORDER BY n DESC`).all().map((r) => r.f));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

billingApi.get('/auto/billing/drafts', (_req, res) => {
  try { ensure(); res.json(db().prepare('SELECT * FROM billing_drafts ORDER BY updatedAt DESC LIMIT 300').all().map((d) => ({ ...d, data: JSON.parse(d.data || '{}') }))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

billingApi.post('/auto/billing/draft', (req, res) => {
  try {
    ensure();
    const b = req.body || {};
    if (!b.enquiryNo) throw new Error('Enquiry chuno');
    if (!b.vin) throw new Error('VIN chuno');
    const pays = Array.isArray(b.payments) ? b.payments.filter((p) => Number(p.amount) > 0) : [];
    const received = pays.reduce((s, p) => s + Number(p.amount || 0), 0);
    const financeAmt = b.payType === 'finance' ? Number(b.financeAmt || 0) : 0;
    const price = Number(b.price || 0);
    const balance = Math.round((price - received - financeAmt) * 100) / 100;
    const other = db().prepare('SELECT enquiryNo, name FROM billing_drafts WHERE UPPER(vin) = UPPER(?) AND enquiryNo <> ?').get(b.vin, b.enquiryNo);
    if (other) throw new Error(`Ye VIN pehle se ${other.name || other.enquiryNo} ke draft me hai`);
    db().prepare(`INSERT INTO billing_drafts (enquiryNo, name, phone, vin, model, payType, financer, price, received, financeAmt, balance, data, status, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)
      ON CONFLICT(enquiryNo) DO UPDATE SET name=excluded.name, phone=excluded.phone, vin=excluded.vin, model=excluded.model, payType=excluded.payType, financer=excluded.financer,
        price=excluded.price, received=excluded.received, financeAmt=excluded.financeAmt, balance=excluded.balance, data=excluded.data, updatedAt=excluded.updatedAt`)
      .run(b.enquiryNo, b.name || '', b.phone || '', b.vin, b.model || '', b.payType || 'cash', b.payType === 'finance' ? (b.financer || '') : '', price, received, financeAmt, balance,
        JSON.stringify({ ...b, payments: pays }), new Date().toISOString());
    res.json({ ok: true, received, financeAmt, balance });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

billingApi.delete('/auto/billing/draft/:enq', (req, res) => {
  try { ensure(); db().prepare('DELETE FROM billing_drafts WHERE enquiryNo = ?').run(req.params.enq); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
