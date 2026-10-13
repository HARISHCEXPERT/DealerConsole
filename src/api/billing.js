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

export const billingApi = Router();
const digits = (s) => String(s || '').replace(/\D/g, '');
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
