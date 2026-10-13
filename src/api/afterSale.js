// ============================================================
//  AUTOMATION → bill ho chuki gaadiyon ka INSURANCE aur RTO
//  Gaadi: VSR (vehicle_sales, cancel nahi). Har gaadi (VIN) ka insurance/RTO ka hisaab: after_sale table.
//  DMS / insurance portal / Vahan me abhi kuch nahi likhte — ye sirf jaankari + status.
// ============================================================
import { Router } from 'express';
import { db } from '../db/index.js';
import { tableExists } from '../db/engine.js';
import { toDMY } from '../db/types.js';

export const afterSaleApi = Router();
const ensure = () => db().exec(`CREATE TABLE IF NOT EXISTS after_sale (vin TEXT PRIMARY KEY, ins TEXT, insStatus TEXT, insAt TEXT, rto TEXT, rtoStatus TEXT, rtoAt TEXT)`);
const digits = (s) => String(s || '').replace(/\D/g, '');

afterSaleApi.get('/auto/after/vehicles', (req, res) => {
  try {
    if (!tableExists('vehicle_sales')) return res.json({ rows: [], note: 'VSR abhi sync nahi hua — Quick Sync karo' });
    ensure();
    const kind = req.query.kind === 'rto' ? 'rto' : 'ins';
    const show = String(req.query.show || 'pending');            // pending | done | all
    const q = String(req.query.q || '').trim();
    const days = Math.min(365, Number(req.query.days) || 60);   // kitne din purane bill
    const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    const st = new Map(db().prepare('SELECT * FROM after_sale').all().map((r) => [String(r.vin).toUpperCase(), r]));
    let rows = db().prepare(`SELECT vin, invoiceNo, invoiceDate, customer, phone, model, variant, color, financer, amount, regNo, dse, district
      FROM vehicle_sales WHERE vin IS NOT NULL AND IFNULL(status,'') NOT LIKE '%cancel%' AND invoiceDate >= ? ORDER BY invoiceDate DESC`).all(since)
      .map((r) => {
        const a = st.get(String(r.vin).toUpperCase()) || {};
        const status = (kind === 'ins' ? a.insStatus : a.rtoStatus) || (kind === 'rto' && r.regNo ? 'done' : 'pending');
        return { ...r, invoiceDate: toDMY(r.invoiceDate), status, ins: a.ins ? JSON.parse(a.ins) : null, rto: a.rto ? JSON.parse(a.rto) : null, insStatus: a.insStatus || 'pending', rtoStatus: a.rtoStatus || (r.regNo ? 'done' : 'pending') };
      });
    const counts = { pending: rows.filter((r) => r.status !== 'done').length, done: rows.filter((r) => r.status === 'done').length, all: rows.length };
    if (show === 'pending') rows = rows.filter((r) => r.status !== 'done'); else if (show === 'done') rows = rows.filter((r) => r.status === 'done');
    if (q) { const qd = digits(q), qu = q.toUpperCase();
      rows = rows.filter((r) => (qd.length >= 3 && digits(r.phone).includes(qd)) || String(r.vin).toUpperCase().endsWith(qu) || String(r.customer || '').toUpperCase().includes(qu) || String(r.invoiceNo || '').toUpperCase().includes(qu)); }
    res.json({ counts, rows: rows.slice(0, 500), since: toDMY(since) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// { kind:'ins'|'rto', data:{...}, status:'pending'|'done' }
afterSaleApi.post('/auto/after/:vin', (req, res) => {
  try {
    ensure();
    const vin = String(req.params.vin || '').trim(); if (!vin) throw new Error('VIN nahi');
    const { kind, data = {}, status = 'pending' } = req.body || {};
    if (!['ins', 'rto'].includes(kind)) throw new Error('kind ins/rto');
    const now = new Date().toISOString();
    db().prepare('INSERT INTO after_sale (vin) VALUES (?) ON CONFLICT(vin) DO NOTHING').run(vin);
    if (kind === 'ins') db().prepare('UPDATE after_sale SET ins = ?, insStatus = ?, insAt = ? WHERE vin = ?').run(JSON.stringify(data), status, now, vin);
    else db().prepare('UPDATE after_sale SET rto = ?, rtoStatus = ?, rtoAt = ? WHERE vin = ?').run(JSON.stringify(data), status, now, vin);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// insurance company list (pehle bhari hui) — dropdown ke liye
afterSaleApi.get('/auto/after/companies', (_req, res) => {
  try { ensure(); const m = {}; for (const r of db().prepare('SELECT ins FROM after_sale WHERE ins IS NOT NULL').all()) { try { const c = JSON.parse(r.ins).company; if (c) m[c] = (m[c] || 0) + 1; } catch {} }
    res.json(Object.entries(m).sort((a, b) => b[1] - a[1]).map(([c]) => c)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
