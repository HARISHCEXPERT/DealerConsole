// ============================================================
//  EXTENSION BRIDGE  (/ext)  — localhost pe, bina app-login (CORS allowed)
//  Chrome extension isse baat karta hai: bill PDF parse, deal store, deal fetch.
//  Optional pairing key: Settings me 'ext_key' set ho to extension ko wahi X-DC-Key bhejna hoga.
// ============================================================
import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { db } from '../db/index.js';
import { getSetting } from '../config/creds.js';
import { parseBillPdf } from '../automation/billParser.js';

export const extApi = Router();
const DEALS_DIR = path.join(process.cwd(), 'data', 'deals');
const slug = (s) => String(s || '').replace(/[^A-Za-z0-9]+/g, '').slice(0, 16) || 'NA';
function ensure() { db().exec(`CREATE TABLE IF NOT EXISTS vehicle_deals (chassis TEXT PRIMARY KEY, folder TEXT, billPath TEXT, data TEXT, status TEXT, createdAt TEXT, updatedAt TEXT)`); }

// CORS + optional pairing key
extApi.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-DC-Key');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  const key = getSetting('ext_key', '');
  if (key && req.headers['x-dc-key'] !== key) return res.status(401).json({ error: 'pairing key galat' });
  next();
});

// connection test
extApi.get('/ping', (_req, res) => res.json({ ok: true, app: 'Dealer Console', time: new Date().toISOString() }));

// bill PDF -> fields -> deal store (chassis key) + bill folder me save
extApi.post('/deal/parse', async (req, res) => {
  try {
    const raw = (req.body && req.body.pdfBase64) || '';
    if (!raw) return res.status(400).json({ error: 'pdfBase64 nahi mila' });
    const buf = Buffer.from(String(raw).replace(/^data:.*?base64,/, ''), 'base64');
    const fields = await parseBillPdf(buf);
    if (!fields.chassis) return res.json({ ok: true, warn: 'Chassis nahi mila — shayad ye DMS GST invoice nahi hai', fields });
    ensure();
    const folder = `${slug(fields.customer)}_${(fields.mobile || '').slice(-4)}_${fields.chassis.slice(-5)}`;
    const dir = path.join(DEALS_DIR, folder);
    fs.mkdirSync(dir, { recursive: true });
    const billPath = path.join(dir, 'bill.pdf');
    fs.writeFileSync(billPath, buf);
    const now = new Date().toISOString();
    db().prepare(`INSERT INTO vehicle_deals (chassis, folder, billPath, data, status, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(chassis) DO UPDATE SET folder=excluded.folder, billPath=excluded.billPath, data=excluded.data, updatedAt=excluded.updatedAt`)
      .run(fields.chassis, folder, billPath, JSON.stringify(fields), 'parsed', now, now);
    res.json({ ok: true, deal: { chassis: fields.chassis, folder, billPath, fields } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// deal fetch (extension portal pe isse data lega)
extApi.get('/deal/:chassis', (req, res) => {
  try {
    ensure();
    const d = db().prepare('SELECT * FROM vehicle_deals WHERE chassis = ?').get(String(req.params.chassis || '').toUpperCase());
    if (!d) return res.status(404).json({ error: 'deal nahi mila' });
    res.json({ ok: true, deal: { ...d, data: JSON.parse(d.data || '{}') } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// saare deals (list)
extApi.get('/deals', (_req, res) => {
  try {
    ensure();
    const rows = db().prepare('SELECT chassis, folder, status, updatedAt, data FROM vehicle_deals ORDER BY updatedAt DESC LIMIT 200').all();
    res.json({ ok: true, deals: rows.map((d) => ({ chassis: d.chassis, folder: d.folder, status: d.status, updatedAt: d.updatedAt, fields: JSON.parse(d.data || '{}') })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
