// ============================================================
//  WhatsApp reminders — TTS voice note (free, no Cloud API)
//  POST /auto/whatsapp/tts { text, voice? } -> mp3 (audio/mpeg) download
//  Microsoft Edge ki free TTS (msedge-tts) — Hindi neural voice. Internet chahiye.
//  Staff audio download kar ke WhatsApp chat me khud attach karke bhejta hai.
// ============================================================
import { Router } from 'express';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { log } from '../utils/logger.js';
import { db } from '../db/index.js';
import { tableExists } from '../db/engine.js';
import { toDMY } from '../db/types.js';
import { classifier } from './sar.js';

export const whatsappApi = Router();

// gaadi ka model VIN se (jobcards/vehicle_sales)
function modelByVin() {
  const d = db(); const model = new Map();
  if (tableExists('service_jobcards')) for (const r of d.prepare('SELECT assetNo, MAX(model) model FROM service_jobcards WHERE assetNo IS NOT NULL GROUP BY assetNo').all()) model.set(String(r.assetNo).toUpperCase(), r.model || '');
  if (tableExists('vehicle_sales')) for (const r of d.prepare('SELECT vin, MAX(model) model FROM vehicle_sales WHERE vin IS NOT NULL GROUP BY vin').all()) { const k = String(r.vin).toUpperCase(); if (!model.get(k)) model.set(k, r.model || ''); }
  return model;
}

// Post-service feedback — aakhri billing din ki FSC/Paid/Joyride gaadiyan (CSI call ke liye)
whatsappApi.get('/auto/whatsapp/postservice', (req, res) => {
  try {
    if (!tableExists('service_invoices')) return res.json({ rows: [], note: 'Service data nahi — Service Sync karo' });
    const d = db();
    const valid = (r) => !(/cancel/i.test(r.status || '') || r.cancelDate);
    // bill-date range. Kuch na aaye to data ki aakhri billing date (ek din).
    let from = String(req.query.from || '').slice(0, 10);
    let to = String(req.query.to || '').slice(0, 10);
    if (!from && !to) {
      let latest = '';
      for (const r of d.prepare('SELECT DISTINCT invoiceDate FROM service_invoices WHERE invoiceDate IS NOT NULL ORDER BY invoiceDate DESC LIMIT 60').all()) {
        latest = String(r.invoiceDate || '').slice(0, 10); if (/^\d{4}-\d{2}-\d{2}/.test(latest)) break;
      }
      from = to = latest;
    } else { if (!from) from = to; if (!to) to = from; }
    if (!from || !to) return res.json({ rows: [], note: 'Koi billing date nahi mili' });
    if (from > to) { const t = from; from = to; to = t; }
    const cls = classifier();
    const model = modelByVin();
    const typeOf = (t) => /joy/i.test(t) ? 'Joyride' : /fsc|free/i.test(t) ? 'FSC' : /paid/i.test(t) ? 'Paid' : null;
    const rows = [];
    for (const r of d.prepare("SELECT * FROM service_invoices WHERE substr(invoiceDate,1,10) >= ? AND substr(invoiceDate,1,10) <= ?").all(from, to)) {
      if (!valid(r)) continue;
      const amt = Number(r.total) || (Number(r.partsTotal) || 0) + (Number(r.labourTotal) || 0) + (Number(r.oilTotal) || 0);
      if (amt <= 0) continue;                                           // 0-amount dummy/khaali bill chhodo
      const kind = typeOf(cls(r)); if (!kind) continue;                 // sirf FSC / Paid / Joyride
      const ph = String(r.mobile || '').replace(/\D/g, '');
      if (ph.length < 10) continue;                                     // farzi / mobile-less chhodo
      const customer = [r.firstName, r.lastName].filter(Boolean).join(' ') || r.account || '';
      if (!customer) continue;
      const vin = String(r.vin || '').trim();
      const ymd = String(r.invoiceDate || '').slice(0, 10);
      rows.push({ customer, mobile: r.mobile, model: model.get(vin.toUpperCase()) || '', asset: vin, type: kind, date: toDMY(ymd), dateYmd: ymd });
    }
    rows.sort((a, b) => (a.dateYmd < b.dateYmd ? 1 : a.dateYmd > b.dateYmd ? -1 : 0));   // naye bill pehle
    res.json({ rows, from: toDMY(from), to: toDMY(to), fromYmd: from, toYmd: to, count: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
//  Click-to-call bridge — PC ka button -> staff ke phone pe dialer
//  KDE Connect ke zariye (phone pe KDE Connect app + PC pe KDE Connect,
//  dono same wifi pe ek baar pair). PC se tel: URL phone ko bhejte hain,
//  phone ka dialer number ke saath khul jaata hai — staff green dabaye.
//  CLI path env se override: KDECONNECT_CLI (warna PATH ka kdeconnect-cli)
//  Fix device: env KDE_DEVICE (warna pehla reachable phone).
// ============================================================
// kdeconnect-cli dhoondo: pehle env, phir Windows ke aam install paths, warna PATH wala
function resolveKdeCli() {
  const cand = [
    process.env.KDECONNECT_CLI,
    'C:\\Program Files\\KDE Connect\\bin\\kdeconnect-cli.exe',
    'C:\\Program Files (x86)\\KDE Connect\\bin\\kdeconnect-cli.exe',
  ].filter(Boolean);
  for (const p of cand) { try { if (fs.existsSync(p)) return p; } catch {} }
  return 'kdeconnect-cli';   // PATH pe ho to chal jaayega
}
const KDE_CLI = resolveKdeCli();
const maskPh = (d) => 'xxxxxx' + String(d).slice(-4);
function kdeRun(args) {
  return new Promise((resolve, reject) => {
    execFile(KDE_CLI, args, { timeout: 12000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') return reject(new Error('kdeconnect-cli nahi mila — PC pe KDE Connect install karo (ya KDECONNECT_CLI me poora path do)'));
        return reject(new Error(((stderr || '') + (err.message || '')).trim() || 'kdeconnect-cli fail'));
      }
      resolve((stdout || '').trim());
    });
  });
}
async function kdeFirstDevice() {
  const out = await kdeRun(['-a', '--id-only']);
  const ids = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return ids[0] || null;
}

// paired + reachable phone list (setup check ke liye)
// ============================================================
//  Follow-up / call log (mini CRM) — har call/baat ka status + time + note
//  DB me rehta hai (dealer ke PC pe). VIN ho to VIN se, warna mobile se track.
// ============================================================
let _waFuReady = false;
function waFuTable() {
  if (_waFuReady) return;
  db().exec(`
    CREATE TABLE IF NOT EXISTS wa_followups (
      id INTEGER PRIMARY KEY,
      ts TEXT NOT NULL,
      vin TEXT, mobile TEXT,
      customer TEXT, model TEXT,
      mode TEXT, outcome TEXT, note TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_wafu_vin ON wa_followups(vin);
    CREATE INDEX IF NOT EXISTS ix_wafu_mob ON wa_followups(mobile);
  `);
  _waFuReady = true;
}
const waKey = (vin, mob) => (String(vin || '').trim().toUpperCase()) || ('m:' + String(mob || '').replace(/\D/g, '').slice(-10));

// ek follow-up save
whatsappApi.post('/auto/whatsapp/log', (req, res) => {
  try {
    waFuTable();
    const b = req.body || {};
    const vin = String(b.vin || '').trim();
    const mobile = String(b.mobile || '').replace(/\D/g, '').slice(-10);
    if (!vin && !mobile) throw new Error('VIN ya mobile zaroori hai');
    const outcome = String(b.outcome || '').trim();
    if (!outcome) throw new Error('Status chuno');
    const ts = new Date().toISOString();
    const r = db().prepare(
      'INSERT INTO wa_followups (ts,vin,mobile,customer,model,mode,outcome,note) VALUES (?,?,?,?,?,?,?,?)'
    ).run(ts, vin || null, mobile || null, String(b.customer || ''), String(b.model || ''), String(b.mode || ''), outcome, String(b.note || '').slice(0, 500));
    log(`[whatsapp] followup #${r.lastInsertRowid} ${outcome} (${maskPh(mobile || vin)})`);
    res.json({ ok: true, id: Number(r.lastInsertRowid), ts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ek customer ki history (VIN+mobile dono se match)
whatsappApi.get('/auto/whatsapp/log', (req, res) => {
  try {
    waFuTable();
    const vin = String(req.query.vin || '').trim().toUpperCase();
    const mobile = String(req.query.mobile || '').replace(/\D/g, '').slice(-10);
    const where = [], params = [];
    if (vin) { where.push('upper(vin)=?'); params.push(vin); }
    if (mobile) { where.push('mobile=?'); params.push(mobile); }
    if (!where.length) return res.json({ rows: [] });
    const rows = db().prepare(
      `SELECT id,ts,vin,mobile,customer,model,mode,outcome,note FROM wa_followups WHERE ${where.join(' OR ')} ORDER BY ts DESC, id DESC`
    ).all(...params).map((r) => ({ ...r, dt: toDMY((r.ts || '').slice(0, 10)), tm: (r.ts || '').slice(11, 16) }));
    res.json({ rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// har customer ka AAKHRI status — list me pill ke liye (vin + mobile dono key)
whatsappApi.get('/auto/whatsapp/log/latest', (req, res) => {
  try {
    waFuTable();
    const all = db().prepare('SELECT ts,vin,mobile,outcome,note FROM wa_followups ORDER BY ts ASC, id ASC').all();
    const map = {};
    for (const r of all) {
      const rec = { outcome: r.outcome, ts: r.ts, dt: toDMY((r.ts || '').slice(0, 10)), note: r.note || '' };
      const kv = String(r.vin || '').trim().toUpperCase();
      const km = String(r.mobile || '').replace(/\D/g, '').slice(-10);
      if (kv) map[kv] = rec;
      if (km) map['m:' + km] = rec;   // mobile se bhi dhundh sake
    }
    res.json({ latest: map });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

whatsappApi.get('/auto/whatsapp/call/devices', async (req, res) => {
  try {
    const ids = (await kdeRun(['-a', '--id-only'])).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const named = await kdeRun(['-a']).catch(() => '');
    res.json({ ids, count: ids.length, raw: named, cli: KDE_CLI });
  } catch (e) {
    res.status(500).json({ error: e.message, hint: 'KDE Connect PC pe chaalu? phone same wifi pe pair? ' });
  }
});

// number phone ko bhejo -> wahan dialer khulega
whatsappApi.post('/auto/whatsapp/call', async (req, res) => {
  try {
    const digits = String(req.body?.mobile || '').replace(/\D/g, '').slice(-10);
    if (digits.length !== 10) throw new Error('Mobile number sahi nahi (10 ank chahiye)');
    let device = String(req.body?.device || process.env.KDE_DEVICE || '').trim();
    if (!device) {
      device = await kdeFirstDevice();
      if (!device) throw new Error('Koi phone pair/reachable nahi — KDE Connect me phone pair karo aur same wifi pe rakho');
    }
    await kdeRun(['-d', device, '--share', 'tel:+91' + digits]);
    log(`[whatsapp] call push -> device ${device} (${maskPh(digits)})`);
    res.json({ ok: true, device });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lost / purane customer — jinki aakhri service N mahine se purani (service data se)
whatsappApi.get('/auto/whatsapp/lost', (req, res) => {
  try {
    if (!tableExists('service_invoices')) return res.json({ rows: [], note: 'Service data nahi — Service Sync karo' });
    const months = Math.max(1, Math.min(36, Number(req.query.months) || 6));
    const t = new Date(Date.now() + 5.5 * 3600e3); const cut = new Date(t); cut.setMonth(cut.getMonth() - months);
    const cutYmd = cut.toISOString().slice(0, 10);
    const d = db();
    // model by VIN (jobcards ya vehicle_sales se)
    const model = new Map();
    if (tableExists('service_jobcards')) for (const r of d.prepare('SELECT assetNo, MAX(model) model FROM service_jobcards WHERE assetNo IS NOT NULL GROUP BY assetNo').all()) model.set(String(r.assetNo).toUpperCase(), r.model || '');
    if (tableExists('vehicle_sales')) for (const r of d.prepare('SELECT vin, MAX(model) model FROM vehicle_sales WHERE vin IS NOT NULL GROUP BY vin').all()) { const k = String(r.vin).toUpperCase(); if (!model.get(k)) model.set(k, r.model || ''); }
    // har gaadi/customer ki aakhri service
    const agg = new Map();
    for (const r of d.prepare('SELECT vin, firstName, lastName, account, mobile, invoiceDate, status, cancelDate FROM service_invoices').all()) {
      if (/cancel/i.test(r.status || '') || r.cancelDate) continue;
      const vin = String(r.vin || '').trim();
      const ph = String(r.mobile || '').replace(/\D/g, '').slice(-10);
      const key = vin || ('m:' + ph); if (!key || key === 'm:') continue;
      const dt = String(r.invoiceDate || ''); if (!/^\d{4}-\d{2}-\d{2}/.test(dt)) continue;
      const x = agg.get(key);
      if (!x || dt > x.last) agg.set(key, { vin, last: dt.slice(0, 10), customer: [r.firstName, r.lastName].filter(Boolean).join(' ') || r.account || '', mobile: r.mobile });
    }
    const rows = [...agg.values()]
      .filter((x) => x.last < cutYmd && String(x.mobile || '').replace(/\D/g, '').length >= 10)
      .map((x) => ({ customer: x.customer, mobile: x.mobile, model: model.get(String(x.vin).toUpperCase()) || '', asset: x.vin, last: toDMY(x.last), lastYmd: x.last }));
    rows.sort((a, b) => (a.lastYmd < b.lastYmd ? -1 : 1));   // sabse purani service pehle
    rows.forEach((r) => delete r.lastYmd);
    res.json({ rows, months, cutoff: toDMY(cutYmd) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const VOICES = {
  female: 'hi-IN-SwaraNeural',
  male: 'hi-IN-MadhurNeural',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const is429 = (e) => /\b429\b|too many requests/i.test(String(e && e.message || e || ''));

// ek baar audio banao (Microsoft Edge free TTS)
async function synthOnce(voice, text) {
  const mod = await import('msedge-tts');
  const MsEdgeTTS = mod.MsEdgeTTS || mod.default?.MsEdgeTTS;
  const OUTPUT_FORMAT = mod.OUTPUT_FORMAT || mod.default?.OUTPUT_FORMAT;
  if (!MsEdgeTTS) throw new Error('TTS module load nahi hua');
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const out = tts.toStream(text);
  const stream = out?.audioStream || out;    // v2: { audioStream, metadataStream }
  if (!stream || typeof stream.on !== 'function') throw new Error('TTS stream nahi mila');
  const chunks = [];
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('TTS timeout — net slow?')), 25000);
      stream.on('data', (c) => { chunks.push(Buffer.isBuffer(c) ? c : (c?.data ? Buffer.from(c.data) : Buffer.alloc(0))); });
      stream.on('end', () => { clearTimeout(timer); resolve(); });
      stream.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
  } finally { try { tts.close(); } catch {} }
  return Buffer.concat(chunks);
}

whatsappApi.post('/auto/whatsapp/tts', async (req, res) => {
  try {
    const text = String(req.body?.text || '').replace(/\*/g, '').trim().slice(0, 900);   // * (WhatsApp bold) bol me nahi
    if (!text) throw new Error('Message khaali hai');
    const voice = VOICES[req.body?.voice] || (req.body?.voice && /neural/i.test(req.body.voice) ? req.body.voice : VOICES.female);

    // Microsoft free TTS kabhi 429 (too many requests) deta hai — ruk ke dobara
    const waits = [0, 1500, 4000, 8000];
    let buf = null, lastErr = null;
    for (let i = 0; i < waits.length; i++) {
      if (waits[i]) await sleep(waits[i]);
      try { buf = await synthOnce(voice, text); if (buf && buf.length) break; lastErr = new Error('Audio khaali aaya'); }
      catch (e) { lastErr = e; if (!is429(e)) break; log(`[whatsapp] TTS 429 — retry ${i + 1}`); }
    }
    if (!buf || !buf.length) {
      if (is429(lastErr)) throw new Error('Microsoft ne abhi rok diya (429 — too many requests). 1-2 minute ruk ke dobara, aur ek saath kai Voice mat dabao.');
      throw lastErr || new Error('Audio nahi bana');
    }
    log(`[whatsapp] TTS ${buf.length} bytes (${voice})`);
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', buf.length);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});