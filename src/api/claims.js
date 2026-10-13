// ============================================================
//  WARRANTY + FSC (Free Service Credit Note) — Hero warranty portal ki .xls report upload
//
//  Dono file me EK sheet, DO table. Heading ke NAAM se dhoondhte hain (row number se nahi):
//   Warranty: "SAP Claim No | Frame No/VIN No. | Engine No | Model Code | Plant"            -> claims
//             "Billing Document Number | SAP Claim No | Part Code | ... | Status | Remarks" -> part lines
//   FSC:      "Billing Document | Date | Accounting Document | Invoice Number | Net Values ..." -> credit notes
//             "Billing Document Number | Model | Total Quantity | Rate | Amount | TDS"         -> lines
//
//  Warranty: claim no ke 6-7 ank: 20 = Warranty, 70 = Goodwill
//            Status: E = Approve, X = Goodwill (approve ho ke hi banta hai), R = Reject
//  FSC:      Invoice "HHHU22839202607" = plant HHHU + dealer + service month 2026-07
//            Net Values = paisa. Naye note me line Rate/Amount 0 -> rate = TDS(1%) × 100
//  Dobara upload = claim / billing doc se replace (double nahi)
// ============================================================
import { Router } from 'express';
import { db, tx } from '../db/index.js';
import { toDate, toDMY } from '../db/types.js';
import path from 'node:path';
import fs from 'node:fs';
import xlsxPkg from 'xlsx';
import { pullPortal } from '../scrapers/warrantyPortal/portal.js';
const XLSX = xlsxPkg.default || xlsxPkg;

export const claims = Router();
const nowIso = () => new Date().toISOString();
const N = (v) => { const x = Number(String(v ?? '').replace(/[,\s₹]/g, '')); return Number.isFinite(x) ? x : 0; };
const T = (v) => String(v ?? '').replace(/^"+|"+$/g, '').replace(/\s+/g, ' ').trim();
const low = (r) => r.map((c) => T(c).toLowerCase());
const r2 = (n) => Math.round((n || 0) * 100) / 100;
const KEY = (s) => String(s || '').toUpperCase().replace(/[-\s.]/g, '');
const KV = (s) => String(s || '').trim().toUpperCase();
const dmy = (s) => toDate(String(s || '').replace(/-/g, '/'));   // 24-09-2026 -> 2026-09-24

function ensure() {
  db().exec(`
    CREATE TABLE IF NOT EXISTS warranty_claims (
      claim_no TEXT PRIMARY KEY, vin TEXT, engine_no TEXT, model_code TEXT, plant TEXT, type TEXT,
      report_from TEXT, report_to TEXT, file_name TEXT, uploaded_at TEXT);
    CREATE TABLE IF NOT EXISTS warranty_lines (
      id INTEGER PRIMARY KEY, claim_no TEXT, billing_doc TEXT, part_code TEXT, part_desc TEXT, qty REAL, frt REAL,
      status TEXT, remarks TEXT, reason TEXT, note TEXT);
    CREATE INDEX IF NOT EXISTS ix_wl_claim ON warranty_lines(claim_no);
    CREATE TABLE IF NOT EXISTS fsc_notes (
      billing_doc TEXT PRIMARY KEY, date TEXT, acc_doc TEXT, invoice_no TEXT, plant TEXT, service_month TEXT,
      net REAL, tax REAL, service_claim REAL, total REAL, file_name TEXT, uploaded_at TEXT);
    CREATE TABLE IF NOT EXISTS fsc_lines (
      id INTEGER PRIMARY KEY, billing_doc TEXT, service_name TEXT, model TEXT, service_no INTEGER, metro TEXT,
      qty REAL, rate REAL, amount REAL, tds REAL, gross REAL);
    CREATE INDEX IF NOT EXISTS ix_fl_doc ON fsc_lines(billing_doc);
    CREATE TABLE IF NOT EXISTS warranty_dcr (
      id INTEGER PRIMARY KEY, claim_no TEXT, ref_no TEXT, ref_date TEXT, dms_claim_no TEXT, vin TEXT, part_code TEXT, part_desc TEXT,
      status_code TEXT, status_desc TEXT, remark TEXT, part_invoice_no TEXT, part_billing_doc TEXT, part_billing_date TEXT, service_billing_doc TEXT,
      part_amt REAL, gst REAL, total_part REAL, labour REAL, handling REAL, service_tax REAL, tds REAL, total_service REAL,
      rej_debit_no TEXT, rej_debit_date TEXT, rej_part_amt REAL, rej_total_amt REAL, debit_note TEXT, file_name TEXT, uploaded_at TEXT);
    CREATE INDEX IF NOT EXISTS ix_dcr_claim ON warranty_dcr(claim_no);
    CREATE TABLE IF NOT EXISTS account_statement (
      id INTEGER PRIMARY KEY, division TEXT, doc_no TEXT, assignment TEXT, posting_date TEXT, trn_type TEXT,
      debit REAL, credit REAL, narration TEXT, file_name TEXT, uploaded_at TEXT,
      UNIQUE (division, doc_no, assignment, posting_date, trn_type, debit, credit));
    CREATE INDEX IF NOT EXISTS ix_st_asg ON account_statement(assignment);
  `);
}

// heading row dhoondho: jisme saare words hon
const findRow = (rows, words, from = 0) => {
  for (let i = from; i < rows.length; i++) { const l = low(rows[i]); if (words.every((w) => l.some((c) => c === w || c.startsWith(w)))) return i; }
  return -1;
};
const colMap = (row) => { const m = {}; low(row).forEach((c, i) => { if (c && !(c in m)) m[c] = i; }); return m; };
const col = (m, ...names) => { for (const n of names) { const k = Object.keys(m).find((x) => x === n || x.startsWith(n)); if (k != null) return m[k]; } return -1; };
const inputVal = (rows, label) => { const r = rows.slice(0, 15).find((x) => T(x[0]).toLowerCase() === label); return r ? T(r[1]) : ''; };

// ---------- WARRANTY ----------
function parseWarranty(rows) {
  const hi = findRow(rows, ['sap claim no', 'frame no']);
  const li = findRow(rows, ['billing document number', 'sap claim no', 'part code']);
  if (hi < 0 || li < 0) return null;
  const hm = colMap(rows[hi]), lm = colMap(rows[li]);
  const c = { claim: col(hm, 'sap claim no'), vin: col(hm, 'frame no'), eng: col(hm, 'engine no'), model: col(hm, 'model code'), plant: col(hm, 'plant') };
  const claimsOut = [];
  for (let i = hi + 1; i < rows.length && i !== li; i++) {
    const r = rows[i]; const no = T(r[c.claim]);
    if (!no) { if (claimsOut.length && low(r).some(Boolean)) break; continue; }
    if (!/^\d{8,}$/.test(no)) break;
    claimsOut.push({ no, vin: T(r[c.vin]), eng: T(r[c.eng]), model: T(r[c.model]), plant: T(r[c.plant]) });
  }
  const d = { bill: col(lm, 'billing document'), claim: col(lm, 'sap claim no'), part: col(lm, 'part code'), desc: col(lm, 'part description'),
    qty: col(lm, 'quantity'), frt: col(lm, 'frt'), st: col(lm, 'status'), rem: col(lm, 'remarks') };
  const lines = [];
  for (let i = li + 1; i < rows.length; i++) {
    const r = rows[i]; const no = T(r[d.claim]);
    if (!no || !/^\d{8,}$/.test(no)) continue;
    const rem = T(r[d.rem]);
    const st = T(r[d.st]).toUpperCase();
    const note = (rem.match(/\(([^)]*)\)\s*$/) || [])[1] || '';
    const reason = st === 'R' ? rem.replace(/\([^)]*\)\s*$/, '').replace(/^REJECT\s*\/?\s*/i, '').replace(/\//g, ' · ').trim() : '';
    lines.push({ no, bill: T(r[d.bill]), part: T(r[d.part]), desc: T(r[d.desc]), qty: N(r[d.qty]), frt: N(r[d.frt]), st, rem, reason, note });
  }
  return { kind: 'warranty', from: dmy(inputVal(rows, 'from date')), to: dmy(inputVal(rows, 'to date')), claims: claimsOut, lines };
}
const claimType = (no) => (String(no).slice(5, 7) === '70' ? 'Goodwill' : 'Warranty');
const statusName = (s) => ({ E: 'Approve', X: 'Approve (Goodwill)', R: 'Reject' }[s] || (s || '—'));

// ---------- FSC ----------
function parseFsc(rows) {
  const hi = findRow(rows, ['billing document', 'date', 'invoice number', 'net values']);
  const li = findRow(rows, ['billing document number', 'model', 'total quantity']);
  if (hi < 0 || li < 0) return null;
  const hm = colMap(rows[hi]), lm = colMap(rows[li]);
  const c = { bill: col(hm, 'billing document'), date: col(hm, 'date'), acc: col(hm, 'accounting document'), inv: col(hm, 'invoice number'),
    net: col(hm, 'net values', 'net value'), tax: col(hm, 'tax'), sc: col(hm, 'service claim'), tot: col(hm, 'total value') };
  const notes = [];
  for (let i = hi + 1; i < li; i++) {
    const r = rows[i]; const bill = T(r[c.bill]);
    if (!/^\d{6,}$/.test(bill)) continue;
    const inv = T(r[c.inv]);
    const m = inv.match(/^([A-Z0-9]*?)22839(\d{4})(\d{2})$/i) || inv.match(/^([A-Z]*)\d*?(\d{4})(\d{2})$/i);
    notes.push({ bill, date: dmy(r[c.date]), acc: T(r[c.acc]), inv, plant: m ? (m[1] || '—').toUpperCase() : '—', month: m ? `${m[2]}-${m[3]}` : null,
      net: N(r[c.net]), tax: N(r[c.tax]), sc: N(r[c.sc]), tot: N(r[c.tot]) });
  }
  const d = { bill: col(lm, 'billing document'), model: col(lm, 'model'), qty: col(lm, 'total quantity'), rate: col(lm, 'rate'), amt: col(lm, 'amount'), tds: col(lm, 'tds') };
  const lines = [];
  for (let i = li + 1; i < rows.length; i++) {
    const r = rows[i]; const bill = T(r[d.bill]);
    if (!/^\d{6,}$/.test(bill)) continue;
    const name = T(r[d.model]), qty = N(r[d.qty]), amt = N(r[d.amt]), tds = N(r[d.tds]);
    const sm = name.match(/(\d)\s*(?:st|nd|rd|th)?\s*(?:ser|serv|servcie|service)/i) || name.match(/(\d)(?:st|nd|rd|th)\b/i);
    const model = name.replace(/\b(non\s*metro|metro)\b.*$/i, '').replace(/\s+\d\s*(st|nd|rd|th)?\s*(ser\w*)?\s*$/i, '').trim() || name;
    const gross = amt > 0 ? amt : r2(Math.abs(tds) * 100);           // naye note: Amount 0, TDS 1% se nikalo
    lines.push({ bill, name, model: model.toUpperCase(), sno: sm ? Number(sm[1]) : null, metro: /non\s*metro/i.test(name) ? 'Non Metro' : /metro/i.test(name) ? 'Metro' : '',
      qty, rate: N(r[d.rate]) || (qty ? r2(gross / qty) : 0), amt, tds, gross });
  }
  return { kind: 'fsc', from: dmy(inputVal(rows, 'from date')), to: dmy(inputVal(rows, 'to date')), notes, lines };
}

function saveWarranty(p, fileName) {
  const d = db(); const at = nowIso();
  const insC = d.prepare(`INSERT INTO warranty_claims (claim_no, vin, engine_no, model_code, plant, type, report_from, report_to, file_name, uploaded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(claim_no) DO UPDATE SET vin=excluded.vin, engine_no=excluded.engine_no, model_code=excluded.model_code,
    plant=excluded.plant, type=excluded.type, report_from=excluded.report_from, report_to=excluded.report_to, file_name=excluded.file_name, uploaded_at=excluded.uploaded_at`);
  const delL = d.prepare('DELETE FROM warranty_lines WHERE claim_no=?');
  const insL = d.prepare(`INSERT INTO warranty_lines (claim_no, billing_doc, part_code, part_desc, qty, frt, status, remarks, reason, note) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  let newC = 0;
  const exists = d.prepare('SELECT 1 FROM warranty_claims WHERE claim_no=?');
  tx(() => {
    const seen = new Set(p.claims.map((c) => c.no));
    for (const c of p.claims) { if (!exists.get(c.no)) newC++; insC.run(c.no, c.vin, c.eng, c.model, c.plant, claimType(c.no), p.from, p.to, fileName, at); }
    for (const no of new Set(p.lines.map((l) => l.no))) {
      delL.run(no);
      if (!seen.has(no) && !exists.get(no)) { insC.run(no, '', '', '', '', claimType(no), p.from, p.to, fileName, at); newC++; }
    }
    for (const l of p.lines) insL.run(l.no, l.bill, l.part, l.desc, l.qty, l.frt, l.st, l.rem, l.reason, l.note);
  });
  return { kind: 'warranty', claims: p.claims.length, lines: p.lines.length, newClaims: newC, from: toDMY(p.from), to: toDMY(p.to) };
}
function saveFsc(p, fileName) {
  const d = db(); const at = nowIso();
  const exists = d.prepare('SELECT 1 FROM fsc_notes WHERE billing_doc=?');
  const insN = d.prepare(`INSERT INTO fsc_notes (billing_doc, date, acc_doc, invoice_no, plant, service_month, net, tax, service_claim, total, file_name, uploaded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(billing_doc) DO UPDATE SET date=excluded.date, acc_doc=excluded.acc_doc, invoice_no=excluded.invoice_no,
    plant=excluded.plant, service_month=excluded.service_month, net=excluded.net, tax=excluded.tax, service_claim=excluded.service_claim, total=excluded.total,
    file_name=excluded.file_name, uploaded_at=excluded.uploaded_at`);
  const delL = d.prepare('DELETE FROM fsc_lines WHERE billing_doc=?');
  const insL = d.prepare(`INSERT INTO fsc_lines (billing_doc, service_name, model, service_no, metro, qty, rate, amount, tds, gross) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  let newN = 0;
  tx(() => {
    for (const n of p.notes) { if (!exists.get(n.bill)) newN++; insN.run(n.bill, n.date, n.acc, n.inv, n.plant, n.month, n.net, n.tax, n.sc, n.tot, fileName, at); }
    for (const b of new Set(p.lines.map((l) => l.bill))) delL.run(b);
    for (const l of p.lines) insL.run(l.bill, l.name, l.model, l.sno, l.metro, l.qty, l.rate, l.amt, l.tds, l.gross);
  });
  return { kind: 'fsc', notes: p.notes.length, lines: p.lines.length, newNotes: newN, from: toDMY(p.from), to: toDMY(p.to) };
}

// ---------- DEALER CLAIM REPORT (tab wala text, naam .xls) — har part: paisa + Hold/Accept/Reject ----------
// numbers: "0.15-" = -0.15 · date: 19.07.2026 · "00000000" = khaali
const NS = (v) => { let x = String(v ?? '').trim().replace(/,/g, ''); const neg = x.endsWith('-'); x = x.replace(/-$/, ''); const n = Number(x); return Number.isFinite(n) ? (neg ? -n : n) : 0; };
const DD = (v) => { const x = String(v ?? '').trim(); if (!x || /^0+$/.test(x)) return null; const m = x.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/); if (!m) return toDate(x); const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; };
function parseDcr(rows) {
  const hi = findRow(rows, ['sap claim no', 'claim status code']);
  if (hi < 0) return null;
  const m = colMap(rows[hi]);
  const g = (r, ...n) => { const i = col(m, ...n); return i < 0 ? '' : r[i]; };
  const lines = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i]; const no = T(g(r, 'sap claim no'));
    if (!/^\d{8,}$/.test(no)) continue;
    lines.push({ no, ref: T(g(r, 'refrence no', 'reference no')), refDate: DD(g(r, 'reference date')), dms: T(g(r, 'dms claim no')), vin: T(g(r, 'frame no')),
      part: T(g(r, 'part code')), desc: T(g(r, 'part des')), code: T(g(r, 'claim status code')).toUpperCase(), sdesc: T(g(r, 'claim status description')), remark: T(g(r, 'wty remark')),
      pinv: T(g(r, 'part invoice no')), pbill: T(g(r, 'part billing doc')), pbillDate: DD(g(r, 'part billing date')), sbill: T(g(r, 'service billing doc')),
      partAmt: NS(g(r, 'part amount')), gst: NS(g(r, 'lst/gst')), totalPart: NS(g(r, 'total part amt')), labour: NS(g(r, 'labour amount')), handling: NS(g(r, 'handling charge')),
      stax: NS(g(r, 'service tax')), tds: NS(g(r, 'tds')), totalService: NS(g(r, 'total service amt')),
      rejNo: T(g(r, 'rej debit number')), rejDate: DD(g(r, 'rej debit date')), rejPart: NS(g(r, 'rej debited part amount')), rejTotal: NS(g(r, 'rej debited total amount')), debitNote: T(g(r, 'debit note')) });
  }
  return { kind: 'dcr', lines };
}
function saveDcr(p, fileName) {
  const d = db(); const at = nowIso();
  const del = d.prepare('DELETE FROM warranty_dcr WHERE claim_no=?');
  const ins = d.prepare(`INSERT INTO warranty_dcr (claim_no, ref_no, ref_date, dms_claim_no, vin, part_code, part_desc, status_code, status_desc, remark, part_invoice_no,
    part_billing_doc, part_billing_date, service_billing_doc, part_amt, gst, total_part, labour, handling, service_tax, tds, total_service, rej_debit_no, rej_debit_date,
    rej_part_amt, rej_total_amt, debit_note, file_name, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const hasC = d.prepare('SELECT 1 FROM warranty_claims WHERE claim_no=?');
  const insC = d.prepare(`INSERT INTO warranty_claims (claim_no, vin, type, file_name, uploaded_at) VALUES (?,?,?,?,?)`);
  let newC = 0;
  tx(() => {
    for (const no of new Set(p.lines.map((l) => l.no))) { del.run(no); const l = p.lines.find((x) => x.no === no); if (!hasC.get(no)) { insC.run(no, l.vin, claimType(no), fileName, at); newC++; } }
    for (const l of p.lines) ins.run(l.no, l.ref, l.refDate, l.dms, l.vin, l.part, l.desc, l.code, l.sdesc, l.remark, l.pinv, l.pbill, l.pbillDate, l.sbill,
      l.partAmt, l.gst, l.totalPart, l.labour, l.handling, l.stax, l.tds, l.totalService, l.rejNo, l.rejDate, l.rejPart, l.rejTotal, l.debitNote, fileName, at);
  });
  return { kind: 'dcr', claims: new Set(p.lines.map((l) => l.no)).size, lines: p.lines.length, newClaims: newC };
}
// ---------- ACCOUNT STATEMENT (Reports > Accounts) — paisa aana/jaana ----------
// Assignment No se judta hai:  22839P2026xxxx / 22839S2026xxxx = warranty claim ka part/service invoice (DCR)
//                              HHHU22839202603 = FSC credit note invoice      Credit = minus (aaya), Debit = plus (kata)
const addDaysIso = (iso, n) => { const x = new Date(iso + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
export const TRN = { DW: 'Warranty credit', DS: 'Free service credit', DH: 'GST debit (2A me data nahi)', DG: 'TDS / other debit' };
function parseStmt(rows) {
  const hi = findRow(rows, ['document number', 'assignment number', 'posting date']);
  if (hi < 0) return null;
  const m = colMap(rows[hi]);
  const g = (r, ...n) => { const i = col(m, ...n); return i < 0 ? '' : r[i]; };
  const lines = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i]; const doc = T(g(r, 'document number'));
    if (!doc) continue;
    lines.push({ div: T(g(r, 'division')), doc, asg: T(g(r, 'assignment number')), date: DD(g(r, 'posting date')), trn: T(g(r, 'trn type')).toUpperCase(),
      debit: NS(g(r, 'debit amount')), credit: NS(g(r, 'credit amount')), narr: T(g(r, 'narration')) });
  }
  return { kind: 'stmt', lines };
}
function saveStmt(p, fileName) {
  const d = db(); const at = nowIso();
  const ins = d.prepare(`INSERT OR IGNORE INTO account_statement (division, doc_no, assignment, posting_date, trn_type, debit, credit, narration, file_name, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  let added = 0;
  tx(() => { for (const l of p.lines) added += Number(ins.run(l.div, l.doc, l.asg, l.date, l.trn, l.debit, l.credit, l.narr, fileName, at).changes); });
  const ds = p.lines.map((l) => l.date).filter(Boolean).sort();
  return { kind: 'stmt', lines: p.lines.length, added, from: toDMY(ds[0] || ''), to: toDMY(ds[ds.length - 1] || '') };
}

// Statement me jis invoice (22839P… / 22839S…) pe credit aa chuka -> woh claim ka paisa aa gaya (Claim Report ka Hold purana ho sakta hai)
function creditedInvoices() {
  if (!db().prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_statement'`).get()) return new Map();
  return new Map(db().prepare(`SELECT assignment a, -SUM(credit) c, MAX(posting_date) d FROM account_statement WHERE credit < 0 GROUP BY assignment`).all().map((r) => [r.a, r]));
}
// line ka haal
const dcrState = (l) => (l.rej_total_amt > 0 || /reject/i.test(l.status_desc || '') || /^R/.test(l.status_code || '')) ? 'reject'
  : (/accept/i.test(l.status_desc || '') || ['SYST', 'X000'].includes(l.status_code)) ? 'ok'
  : (/hold/i.test(l.status_desc || '') || /^H/.test(l.status_code || '')) ? 'hold' : 'pending';
const lineAmt = (l) => r2((l.total_part || 0) + (l.total_service || 0));

// text file (tab) -> rows  (browser/portal dono)
export function rowsFromBuffer(buf) {
  const b = Buffer.from(buf);
  const isOle = b[0] === 0xd0 && b[1] === 0xcf, isZip = b[0] === 0x50 && b[1] === 0x4b;
  if (!isOle && !isZip) {
    const txt = b.toString('latin1').replace(/^\uFEFF/, '');
    if (/\t/.test(txt.slice(0, 2000)) && !/<html|<table/i.test(txt.slice(0, 500)))
      return txt.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split('\t'));
  }
  const wb = XLSX.read(b, { type: 'buffer' });
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '', dateNF: 'dd/mm/yyyy' }).map((r) => r.map((v) => String(v ?? '')));
}

// upload: body { fileName, rows: [[...], ...] }  (browser ne .xls padh ke 2D list bheji)
export function importRows(rows, fileName = '') {
  ensure();
  if (!rows.length) throw new Error('File khaali');
  const st = parseStmt(rows);
  if (st) { if (!st.lines.length) throw new Error('Account Statement me ek bhi entry nahi mili'); return saveStmt(st, fileName); }
  const dc = parseDcr(rows);
  if (dc) { if (!dc.lines.length) throw new Error('Dealer Claim Report me ek bhi line nahi mili'); return saveDcr(dc, fileName); }
  const w = parseWarranty(rows);
  if (w) { if (!w.claims.length && !w.lines.length) throw new Error('Warranty file me ek bhi claim nahi mila (is range me claim nahi?)'); return saveWarranty(w, fileName); }
  const f = parseFsc(rows);
  if (f) { if (!f.notes.length) throw new Error('FSC file me ek bhi credit note nahi mila (is range me note nahi?)'); return saveFsc(f, fileName); }
  throw new Error('Ye Warranty Claim / Dealer Claim Report / Free Service Credit Note nahi lagti — heading "SAP Claim No" / "Billing Document … Net Values" nahi mili');
}
claims.post('/claims/upload', (req, res) => {
  try {
    const { rows, fileB64, fileName = '' } = req.body || {};
    const r = fileB64 ? rowsFromBuffer(Buffer.from(fileB64, 'base64')) : (rows || []);
    res.json({ ok: true, ...importRows(r, fileName) });
  }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// PORTAL SE SYNC: { kinds:['fsc','warranty'], from, to }  -> login, report, .xls, import
claims.post('/claims/sync', async (req, res) => {
  try {
    const { kinds = ['fsc', 'warranty', 'dcr', 'stmt'], from, to } = req.body || {};
    if (!from || !to) throw new Error('From/To date do');
    const f = toDate(from), t = toDate(to);
    if (!f || !t || f > t) throw new Error('Date galat');
    if ((Date.parse(t) - Date.parse(f)) / 864e5 > 366) throw new Error('1 saal se zyada ek saath nahi — FY-wise karo');
    const out = await pullPortal([].concat(kinds).filter((k) => ['fsc', 'warranty', 'dcr', 'stmt'].includes(k)), { from, to });
    const results = out.map((x) => {
      if (x.error) return x;
      try {
        const rows = rowsFromBuffer(fs.readFileSync(x.file));
        return { kind: x.kind, ...importRows(rows, path.basename(x.file)) };
      } catch (e) { return { kind: x.kind, error: e.message }; }
    });
    res.status(results.every((r) => r.error) ? 502 : 200).json({ ok: !results.some((r) => r.error), results });
  } catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});

// ---------- WARRANTY read ----------
claims.get('/warranty', (req, res) => {
  try {
    ensure();
    const d = db();
    // date range = claim BHEJNE ki date (Claim Report ka Reference date). Range na ho = sab
    const f = toDate(req.query.from), t = toDate(req.query.to || req.query.from) || f;
    const hasVsr = !!d.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='vehicle_sales'`).get();
    const vsr = new Map(hasVsr ? d.prepare(`SELECT UPPER(TRIM(vin)) k, MAX(customer) customer, MAX(phone) phone, MAX(model) model, MIN(invoiceDate) sold FROM vehicle_sales WHERE vin IS NOT NULL GROUP BY k`).all().map((r) => [r.k, r]) : []);
    let lines = d.prepare('SELECT * FROM warranty_lines ORDER BY claim_no, id').all();
    let dcr = d.prepare('SELECT * FROM warranty_dcr ORDER BY claim_no, id').all();
    const dByClaim = new Map();
    // ---- asli haal: (1) Claim Status me Reject (R) = reject  (2) Statement me invoice ka paisa POORA aaya = paid, THODA = partial
    const paidInv = creditedInvoices();
    const rejSet = new Set(lines.filter((l) => l.status === 'R').map((l) => l.claim_no + '|' + KEY(l.part_code)));
    for (const l of dcr) { l.state = dcrState(l); if (rejSet.has(l.claim_no + '|' + KEY(l.part_code))) l.state = 'reject'; l.amt = lineAmt(l); }
    // invoice-wise: parts = 22839P… (total part amt), labour = 22839S… (total service amt). Reject wale parts ginti se bahar
    const inv = new Map();
    for (const l of dcr) {
      if (!l.part_invoice_no) continue;
      const x = inv.get(l.part_invoice_no) || { pInv: l.part_invoice_no, sInv: String(l.part_invoice_no).replace(/P(\d+)$/, 'S$1'), claimP: 0, claimS: 0, rejAmt: 0, lines: [] };
      if (l.state === 'reject') x.rejAmt += l.amt; else { x.claimP += l.total_part || 0; x.claimS += l.total_service || 0; }
      x.lines.push(l); inv.set(l.part_invoice_no, x);
    }
    for (const x of inv.values()) {
      const cp = paidInv.get(x.pInv)?.c || 0, cs = paidInv.get(x.sInv)?.c || 0;
      x.credited = r2(cp + cs); x.claim = r2(x.claimP + x.claimS); x.paidOn = [paidInv.get(x.pInv)?.d, paidInv.get(x.sInv)?.d].filter(Boolean).sort().pop() || null;
      x.status = !x.credited ? 'none' : x.credited >= x.claim * 0.98 - 5 ? 'full' : 'partial';
      for (const l of x.lines) if (l.state !== 'reject') {
        l.dcrState = l.state;
        if (x.status === 'full') { l.state = 'paid'; l.paidOn = x.paidOn; } else if (x.status === 'partial') l.partial = true;
      }
    }
    // range filter — paisa ka hisaab (invoice-wise) upar poore data se ho chuka, ab sirf range ke claim
    const sentOn = new Map();
    for (const l of dcr) if (l.ref_date && (!sentOn.has(l.claim_no) || l.ref_date < sentOn.get(l.claim_no))) sentOn.set(l.claim_no, l.ref_date);
    const keep = (no) => !f || (sentOn.has(no) && sentOn.get(no) >= f && sentOn.get(no) <= t);
    const allClaims = d.prepare('SELECT claim_no FROM warranty_claims').all().map((r) => r.claim_no);
    const noDate = f ? allClaims.filter((no) => !sentOn.has(no)).length : 0;
    lines = lines.filter((l) => keep(l.claim_no)); dcr = dcr.filter((l) => keep(l.claim_no));
    const invIn = new Set(dcr.map((l) => l.part_invoice_no));
    const invList = [...inv.values()].filter((x) => invIn.has(x.pInv));
    const byClaim = new Map();
    for (const l of lines) { if (!byClaim.has(l.claim_no)) byClaim.set(l.claim_no, []); byClaim.get(l.claim_no).push(l); }
    for (const l of dcr) { if (!dByClaim.has(l.claim_no)) dByClaim.set(l.claim_no, []); dByClaim.get(l.claim_no).push(l); }
    const today = Date.now();
    const list = d.prepare('SELECT * FROM warranty_claims ORDER BY claim_no DESC').all().filter((c) => keep(c.claim_no)).map((c) => {
      const ls = byClaim.get(c.claim_no) || [];
      const dl = dByClaim.get(c.claim_no) || [];
      const sum = (st) => r2(dl.filter((l) => !st || l.state === st).reduce((s, l) => s + l.amt, 0));
      const refDate = dl.map((l) => l.ref_date).filter(Boolean).sort()[0] || null;
      const dcrInfo = dl.length ? { amount: sum(), okAmt: r2(sum('ok') + sum('paid')), paidAmt: sum('paid'), holdAmt: r2(dl.filter((l) => l.state === 'hold' && !l.partial).reduce((s, l) => s + l.amt, 0)), rejAmt: sum('reject'),
        invoices: [...new Set(dl.map((l) => l.part_invoice_no))].map((i) => { const x = inv.get(i); return x ? `${i}: aaya ${Math.round(x.credited)} / claim ${Math.round(x.claim)}` : i; }).join(' · '),
        holdParts: dl.filter((l) => l.state === 'hold').length, holdCodes: [...new Set(dl.filter((l) => l.state === 'hold').map((l) => l.status_code))].join(', '),
        refNo: [...new Set(dl.map((l) => l.ref_no))].join(', '), refDate: toDMY(refDate || ''), days: refDate ? Math.floor((today - Date.parse(refDate)) / 864e5) : null,
        billDate: toDMY(dl.map((l) => l.part_billing_date).filter(Boolean).sort().pop() || '') } : null;
      const rej = ls.filter((l) => l.status === 'R'), ok = ls.filter((l) => l.status === 'E' || l.status === 'X');
      const v = vsr.get(KV(c.vin));
      let st = !ls.length ? '—' : rej.length === ls.length ? 'Reject' : rej.length ? 'Adhoora reject' : 'Approve';
      if (dl.length) {   // Dealer Claim Report ho to wahi asli haal (har part ka)
        const n = (x) => dl.filter((l) => l.state === x).length;
        const rj = n('reject'), part = dl.some((l) => l.partial);
        st = rj === dl.length ? 'Reject' : n('paid') + rj === dl.length ? (rj ? 'Paisa aaya (reject chhod ke)' : 'Paisa aaya') : part ? 'Kuch aaya' : n('reject') === dl.length ? 'Reject' : n('hold') === dl.length ? 'Hold' : n('ok') + n('paid') === dl.length ? 'Approve' : n('hold') ? 'Kuch hold' : n('reject') ? 'Adhoora reject' : 'Pending';
      }
      return { claimNo: c.claim_no, type: c.type, vin: c.vin, engineNo: c.engine_no, modelCode: c.model_code, plant: c.plant,
        model: v?.model || '', customer: v?.customer || '', phone: v?.phone || '', soldOn: toDMY(v?.sold || ''),
        parts: ls.length || dl.length, qty: ls.reduce((s, l) => s + (l.qty || 0), 0), okParts: ok.length, rejParts: rej.length + dl.filter((l) => l.state === 'reject').length, status: st,
        ...(dcrInfo || {}), hasDcr: !!dl.length,
        partList: (ls.length ? ls : dl).map((l) => l.part_desc).join(', '), note: [...new Set(ls.map((l) => l.note).filter(Boolean))].join(' · '),
        reason: [...new Set(rej.map((l) => l.reason).filter(Boolean))].join(' · '), billingDoc: [...new Set(ls.map((l) => l.billing_doc))].join(', ') };
    });
    const partAgg = new Map();
    for (const l of lines) {
      const k = l.part_code; const x = partAgg.get(k) || { partCode: k, partDesc: l.part_desc, claims: new Set(), qty: 0, rej: 0 };
      x.claims.add(l.claim_no); x.qty += l.qty || 0; if (l.status === 'R') x.rej++; partAgg.set(k, x);
    }
    const parts = [...partAgg.values()].map((x) => ({ ...x, claims: x.claims.size })).sort((a, b) => b.claims - a.claims || b.qty - a.qty);
    const rejects = lines.filter((l) => l.status === 'R').map((l) => {
      const c = list.find((x) => x.claimNo === l.claim_no) || {};
      return { claimNo: l.claim_no, vin: c.vin, modelCode: c.modelCode, partCode: l.part_code, partDesc: l.part_desc, qty: l.qty, reason: l.reason || l.remarks, billingDoc: l.billing_doc };
    });
    const last = d.prepare('SELECT MAX(uploaded_at) at, MIN(report_from) f, MAX(report_to) t FROM warranty_claims').get();
    const holds = dcr.filter((l) => l.state === 'hold').map((l) => ({ partial: !!l.partial, claimNo: l.claim_no, vin: l.vin, refNo: l.ref_no, refDate: toDMY(l.ref_date || ''),
      days: l.ref_date ? Math.floor((today - Date.parse(l.ref_date)) / 864e5) : null, partCode: l.part_code, partDesc: l.part_desc, code: l.status_code, reason: l.status_desc,
      remark: l.remark, amount: l.amt })).sort((a, b) => (b.days ?? 0) - (a.days ?? 0) || b.amount - a.amount);
    const holdByCode = {};
    for (const h of holds) { const k = h.code + ' · ' + h.reason; const x = holdByCode[k] || { code: h.code, reason: h.reason, lines: 0, amount: 0 }; x.lines++; x.amount = r2(x.amount + h.amount); holdByCode[k] = x; }
    const batches = {};
    for (const l of dcr) { const x = batches[l.ref_no] || { refNo: l.ref_no, refDate: toDMY(l.ref_date || ''), billDate: toDMY(l.part_billing_date || ''), invs: new Set(), claims: new Set(), lines: 0, amount: 0, okAmt: 0, holdAmt: 0, rejAmt: 0 };
      x.claims.add(l.claim_no); x.invs.add(l.part_invoice_no); x.lines++; x.amount += l.amt; if (l.state === 'ok' || l.state === 'paid') x.okAmt += l.amt; if (l.state === 'hold') x.holdAmt += l.amt; if (l.state === 'reject') x.rejAmt += l.amt; batches[l.ref_no] = x; }
    for (const x of Object.values(batches)) { const iv = [...x.invs].map((i) => inv.get(i)).filter(Boolean);
      x.invoice = [...x.invs].join(', '); x.credited = r2(iv.reduce((s, i) => s + i.credited, 0)); x.claimNet = r2(iv.reduce((s, i) => s + i.claim, 0));
      x.paidOn = toDMY(iv.map((i) => i.paidOn).filter(Boolean).sort().pop() || ''); x.payStatus = iv.every((i) => i.status === 'full') ? 'full' : iv.some((i) => i.credited) ? 'partial' : 'none'; delete x.invs; }
    const dcrSum = (st) => r2(dcr.filter((l) => l.state === st).reduce((s, l) => s + l.amt, 0));
    res.json({
      claims: list, parts, rejects, holds, holdCodes: Object.values(holdByCode).sort((a, b) => b.amount - a.amount),
      batches: Object.values(batches).map((x) => ({ ...x, claims: x.claims.size, amount: r2(x.amount), okAmt: r2(x.okAmt), holdAmt: r2(x.holdAmt) })).sort((a, b) => String(b.refNo).localeCompare(String(a.refNo))),
      hasDcr: dcr.length > 0,
      upload: { at: last.at, from: toDMY(last.f || ''), to: toDMY(last.t || '') },
      range: f ? { from: toDMY(f), to: toDMY(t), noDate } : null,
      summary: { claims: list.length, warranty: list.filter((c) => c.type === 'Warranty').length, goodwill: list.filter((c) => c.type === 'Goodwill').length,
        lines: lines.length, okLines: lines.filter((l) => l.status === 'E' || l.status === 'X').length, rejLines: rejects.length,
        rejClaims: list.filter((c) => c.rejParts > 0).length,
        amount: r2(dcr.reduce((s, l) => s + l.amt, 0)), okAmt: r2(dcrSum('ok') + dcrSum('paid')), paidAmt: dcrSum('paid'), holdAmt: r2(dcr.filter((l) => l.state === 'hold' && !l.partial).reduce((s, l) => s + l.amt, 0)), rejAmt: dcrSum('reject'),
        credited: r2(invList.reduce((s, x) => s + x.credited, 0)), partialInv: invList.filter((x) => x.status === 'partial').length,
        partialPending: r2(invList.filter((x) => x.status === 'partial').reduce((s, x) => s + (x.claim - x.credited), 0)),
        holdLines: holds.filter((h) => !h.partial).length, holdClaims: new Set(holds.filter((h) => !h.partial).map((h) => h.claimNo)).size, dcrLines: dcr.length },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
claims.get('/warranty/claim', (req, res) => {
  try {
    ensure();
    const no = String(req.query.no || '');
    const dl = db().prepare('SELECT * FROM warranty_dcr WHERE claim_no=? ORDER BY id').all(no);
    if (dl.length) {
      const nm = { ok: '✅ Accept', hold: '⏸ Hold', reject: '❌ Reject', pending: '… Pending' };
      const paid = creditedInvoices();
      const rj = new Set(db().prepare(`SELECT part_code FROM warranty_lines WHERE claim_no=? AND status='R'`).all(no).map((r) => KEY(r.part_code)));
      const invSt = (pi) => { const all = db().prepare('SELECT * FROM warranty_dcr WHERE part_invoice_no=?').all(pi); const rjAll = new Set(db().prepare(`SELECT claim_no||'|'||part_code k FROM warranty_lines WHERE status='R'`).all().map((r) => r.k));
        const claim = all.filter((l) => !rjAll.has(l.claim_no + '|' + l.part_code)).reduce((s, l) => s + (l.total_part || 0) + (l.total_service || 0), 0);
        const cr = (paid.get(pi)?.c || 0) + (paid.get(String(pi).replace(/P(\d+)$/, 'S$1'))?.c || 0);
        return !cr ? null : cr >= claim * 0.98 - 5 ? `💰 Paisa aaya ${toDMY(paid.get(pi)?.d || '')}` : `🟡 Invoice me kuch aaya (₹${Math.round(cr)} / ₹${Math.round(claim)})`; };
      return res.json(dl.map((l) => ({ partCode: l.part_code, partDesc: l.part_desc,
        status: rj.has(KEY(l.part_code)) ? '❌ Reject (Claim Status)' : (invSt(l.part_invoice_no) ? invSt(l.part_invoice_no) + (dcrState(l) === 'hold' ? ' · report me hold' : '') : nm[dcrState(l)]), code: l.status_code, reason: l.status_desc, note: l.remark,
        partAmt: l.total_part, serviceAmt: l.total_service, amount: lineAmt(l), billingDoc: l.part_billing_doc, billDate: toDMY(l.part_billing_date || ''), refNo: l.ref_no })));
    }
    const rows = db().prepare('SELECT * FROM warranty_lines WHERE claim_no=? ORDER BY id').all(no);
    res.json(rows.map((l) => ({ billingDoc: l.billing_doc, partCode: l.part_code, partDesc: l.part_desc, qty: l.qty, frt: l.frt, status: statusName(l.status), reason: l.reason, note: l.note, remarks: l.remarks })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- FSC read ----------
const ym = (iso) => (iso ? iso.slice(0, 7) : null);
const monthName = (m) => { if (!m) return '—'; const [y, mo] = m.split('-'); return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+mo - 1] + ' ' + y; };
const addMonth = (m, n) => { let [y, mo] = m.split('-').map(Number); mo += n; while (mo > 12) { mo -= 12; y++; } while (mo < 1) { mo += 12; y--; } return `${y}-${String(mo).padStart(2, '0')}`; };
claims.get('/fsc', (req, res) => {
  try {
    ensure();
    const d = db();
    const f = toDate(req.query.from), t = toDate(req.query.to || req.query.from);
    const fm = f ? ym(f) : null, tm = t ? ym(t) : null;
    const inR = (m) => !fm || (m && m >= fm && m <= tm);           // range = SERVICE MONTH ki
    const notes = d.prepare('SELECT * FROM fsc_notes ORDER BY service_month, plant').all();
    const lineAgg = new Map(d.prepare('SELECT billing_doc b, SUM(qty) q, SUM(gross) g FROM fsc_lines GROUP BY b').all().map((r) => [r.b, r]));
    const plants = [...new Set(notes.filter((n) => inR(n.service_month || ym(n.date))).map((n) => n.plant))].filter((p) => p && p !== '—').sort();
    const months = new Map();
    for (const n of notes) {
      const m = n.service_month || ym(n.date);
      const x = months.get(m) || { month: m, label: monthName(m), total: 0, qty: 0, notes: 0, creditDates: new Set(), byPlant: {} };
      const la = lineAgg.get(n.billing_doc);
      x.total += n.net || 0; x.qty += la?.q || 0; x.notes++; x.creditDates.add(n.date);
      x.byPlant[n.plant] = (x.byPlant[n.plant] || 0) + (n.net || 0);
      months.set(m, x);
    }
    const monthRows = [...months.values()].filter((x) => inR(x.month)).sort((a, b) => b.month.localeCompare(a.month)).map((x) => {
      const cd = [...x.creditDates].filter(Boolean).sort();
      const lag = cd.length && x.month ? Math.round((Date.parse(cd[cd.length - 1]) - Date.parse(addMonth(x.month, 1) + '-01')) / 864e5) : null;
      return { month: x.month, label: x.label, total: r2(x.total), qty: x.qty, perService: x.qty ? r2(x.total / x.qty) : null, notes: x.notes,
        creditOn: cd.map(toDMY).join(', '), daysAfter: lag, ...Object.fromEntries(plants.map((p) => ['p_' + p, r2(x.byPlant[p] || 0)])) };
    });
    // kaunse mahine ka credit nahi aaya: data ke pehle mahine se pichhle mahine tak
    const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 7);
    const all = [...months.keys()].filter(Boolean).sort();
    const missing = [];
    if (all.length) {
      const start = fm && fm > all[0] ? fm : all[0];
      for (let m = start; m < today; m = addMonth(m, 1)) {
        if (tm && m > tm) break;
        if (!months.has(m)) { const age = (Date.parse(today + '-01') - Date.parse(m + '-01')) / (30.4 * 864e5); missing.push({ month: m, label: monthName(m), late: age >= 2 }); }
      }
    }
    // model + service wise (range ke notes)
    const docs = new Set(notes.filter((n) => inR(n.service_month || ym(n.date))).map((n) => n.billing_doc));
    const ms = new Map();
    for (const l of d.prepare('SELECT * FROM fsc_lines').all()) {
      if (!docs.has(l.billing_doc)) continue;
      const k = l.model + '|' + (l.service_no ?? '');
      const x = ms.get(k) || { model: l.model, serviceNo: l.service_no, qty: 0, amount: 0 };
      x.qty += l.qty || 0; x.amount += l.gross || 0; ms.set(k, x);
    }
    const models = [...ms.values()].map((x) => ({ ...x, amount: r2(x.amount), rate: x.qty ? r2(x.amount / x.qty) : null })).sort((a, b) => b.qty - a.qty);
    const inRange = monthRows;
    const last = d.prepare('SELECT MAX(uploaded_at) at FROM fsc_notes').get();
    const lastM = all[all.length - 1];
    res.json({
      plants, months: monthRows, missing, models,
      upload: { at: last.at },
      summary: { total: r2(inRange.reduce((s, x) => s + x.total, 0)), qty: inRange.reduce((s, x) => s + x.qty, 0), months: inRange.length,
        perService: (() => { const q = inRange.reduce((s, x) => s + x.qty, 0); return q ? r2(inRange.reduce((s, x) => s + x.total, 0) / q) : null; })(),
        lastMonth: monthName(lastM), lastCredit: toDMY(notes.map((n) => n.date).filter(Boolean).sort().pop() || ''),
        missing: missing.length, late: missing.filter((m) => m.late).length },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
claims.get('/fsc/month', (req, res) => {
  try {
    ensure();
    const m = String(req.query.month || '');
    const rows = db().prepare(`SELECT n.plant, n.invoice_no, n.date, l.service_name, l.model, l.service_no, l.qty, l.rate, l.gross, l.tds
      FROM fsc_lines l JOIN fsc_notes n ON n.billing_doc = l.billing_doc WHERE n.service_month = ? ORDER BY n.plant, l.model, l.service_no`).all(m);
    res.json(rows.map((r) => ({ ...r, date: toDMY(r.date) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- STATEMENT read + milaan ----------
claims.get('/statement', (req, res) => {
  try {
    ensure();
    const d = db();
    const f = toDate(req.query.from), t = toDate(req.query.to || req.query.from);
    const rows = d.prepare(`SELECT * FROM account_statement ${f ? 'WHERE posting_date BETWEEN ? AND ?' : ''} ORDER BY posting_date DESC, doc_no`).all(...(f ? [f, t] : []));
    const byType = {};
    for (const r of rows) { const k = r.trn_type || '—'; const x = byType[k] || { type: k, label: TRN[k] || k, n: 0, debit: 0, credit: 0 }; x.n++; x.debit += r.debit || 0; x.credit += -(r.credit || 0); byType[k] = x; }
    const credit = -rows.reduce((s, r) => s + (r.credit || 0), 0), debit = rows.reduce((s, r) => s + (r.debit || 0), 0);
    // saari entries assignment-wise (milaan ke liye poora itihaas)
    const asg = new Map();
    for (const r of d.prepare('SELECT assignment, trn_type, debit, credit, posting_date FROM account_statement').all()) {
      const x = asg.get(r.assignment) || { credit: 0, debit: 0, gstDebit: 0, dates: [] };
      x.credit += -(r.credit || 0); x.debit += r.debit || 0; if (r.trn_type === 'DH') x.gstDebit += r.debit || 0; x.dates.push(r.posting_date); asg.set(r.assignment, x);
    }
    // WARRANTY milaan: DCR ka part/service invoice -> statement credit
    const dcrInv = d.prepare(`SELECT part_invoice_no inv, 'Parts' kind, SUM(CASE WHEN status_code IN ('SYST','X000') OR status_desc LIKE '%ACCEPT%' THEN total_part ELSE 0 END) ok, SUM(total_part) claimed, COUNT(DISTINCT claim_no) claims, MIN(ref_date) ref
        FROM warranty_dcr WHERE IFNULL(part_invoice_no,'')<>'' GROUP BY part_invoice_no`).all();
    const svc = d.prepare(`SELECT part_invoice_no pinv, SUM(CASE WHEN status_code IN ('SYST','X000') OR status_desc LIKE '%ACCEPT%' THEN total_service ELSE 0 END) ok, SUM(total_service) claimed FROM warranty_dcr GROUP BY part_invoice_no`).all();
    const svcMap = new Map(svc.map((x) => [x.pinv, x]));
    const warranty = [];
    for (const x of dcrInv) {
      const sInv = String(x.inv).replace(/P(\d+)$/, 'S$1');
      const sp = svcMap.get(x.inv) || { ok: 0, claimed: 0 };
      for (const [inv, kind, ok, claimed] of [[x.inv, 'Parts', x.ok, x.claimed], [sInv, 'Labour', sp.ok, sp.claimed]]) {
        const a = asg.get(inv);
        warranty.push({ invoice: inv, kind, claims: x.claims, sentOn: toDMY(x.ref || ''), claimed: r2(claimed), accepted: r2(ok), credited: r2(a?.credit || 0), gstDebit: r2(a?.gstDebit || 0),
          net: r2((a?.credit || 0) - (a?.debit || 0)), creditOn: a ? toDMY(a.dates.filter(Boolean).sort().pop() || '') : '', diff: r2((a?.credit || 0) - ok) });
      }
    }
    // statement me warranty credit (DW) jiska claim data (DCR) nahi — purane claim
    const seen = new Set(warranty.map((w) => w.invoice));
    for (const [inv, a] of asg) if (/^22839[PS]\d+$/.test(inv) && !seen.has(inv) && a.credit)
      warranty.push({ invoice: inv, kind: /S\d+$/.test(inv) ? 'Labour' : 'Parts', claims: null, sentOn: '', claimed: null, accepted: null, credited: r2(a.credit), gstDebit: r2(a.gstDebit),
        net: r2(a.credit - a.debit), creditOn: toDMY(a.dates.filter(Boolean).sort().pop() || ''), diff: null, noClaim: true });
    warranty.sort((a, b) => String(b.invoice).localeCompare(String(a.invoice)));
    // FSC milaan: credit note invoice -> statement DS
    // note Net = gross − 1% TDS  ->  statement me aata hai gross + 18% GST − 1% TDS = note / 0.99 × 1.17
    const stFrom = d.prepare('SELECT MIN(posting_date) m FROM account_statement').get().m;
    const fF = f || (stFrom ? addDaysIso(stFrom, -45) : null), fT = t || '9999-12-31';
    const fsc = d.prepare(`SELECT invoice_no inv, service_month m, net, date FROM fsc_notes ${fF ? 'WHERE date BETWEEN ? AND ?' : ''} ORDER BY service_month DESC, plant`).all(...(fF ? [fF, fT] : [])).map((n) => {
      const a = asg.get(n.inv); const exp = r2((n.net || 0) / 0.99 * 1.17);
      return { invoice: n.inv, month: n.m, noteDate: toDMY(n.date || ''), note: r2(n.net), expected: exp, credited: r2(a?.credit || 0), gstDebit: r2(a?.gstDebit || 0), net: r2((a?.credit || 0) - (a?.debit || 0)),
        creditOn: a ? toDMY(a.dates.filter(Boolean).sort().pop() || '') : '', diff: a ? r2((a.credit || 0) - exp) : null };
    });
    const last = d.prepare('SELECT MAX(uploaded_at) at, MIN(posting_date) a, MAX(posting_date) b FROM account_statement').get();
    res.json({
      rows: rows.map((r) => ({ ...r, posting_date: toDMY(r.posting_date || ''), credit: r2(-(r.credit || 0)), debit: r2(r.debit || 0), label: TRN[r.trn_type] || r.trn_type })),
      types: Object.values(byType).map((x) => ({ ...x, debit: r2(x.debit), credit: r2(x.credit) })).sort((a, b) => (b.credit + b.debit) - (a.credit + a.debit)),
      warranty, fsc,
      upload: { at: last.at, from: toDMY(last.a || ''), to: toDMY(last.b || '') },
      summary: { credit: r2(credit), debit: r2(debit), net: r2(credit - debit), entries: rows.length, gstDebit: r2(rows.filter((r) => r.trn_type === 'DH').reduce((s, r) => s + (r.debit || 0), 0)),
        warrantyPending: r2(warranty.filter((w) => w.accepted > 0 && !w.credited).reduce((s, w) => s + w.accepted, 0)), fscMissing: fsc.filter((x) => x.note > 0 && !x.credited).length },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});