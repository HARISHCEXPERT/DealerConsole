// ============================================================
//  KHAATA — party ka statement (Vehicle purchase / Parts purchase / koi bhi supplier)
//
//  Har mahine party ki statement (Excel / CSV / Tally export) daalo:
//   - opening, bill, payment, debit note, credit note, journal, closing — mahine-wise
//   - pichhli closing = agli opening (chain). Statement ki opening na mile to warning
//   - har bill DMS ke purchase invoice se milao (bill number se):
//        dono me / sirf statement me / sirf DMS me / amount farak
//   - aakhri statement ke baad: DMS ki nayi purchase jod ke andaaze ka balance
//
//  Format: koi bhi — heading ke NAAM se column dhoondhte hain (Date, Vch Type, Vch No, Particulars, Debit, Credit / Amount, Balance)
//  Dobara / overlap wali file daalo to wahi entry dobara nahi judti
// ============================================================
import { Router } from 'express';
import { db, tx } from '../db/index.js';
import { toDate, toDMY } from '../db/types.js';
import { rowsFromBuffer } from './claims.js';
import { pdfRows } from './pdfRows.js';

export const khaataApi = Router();
const nowIso = () => new Date().toISOString();
const r2 = (n) => Math.round((n || 0) * 100) / 100;
const T = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const KEY = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+/, '');
const ym = (iso) => (iso ? iso.slice(0, 7) : null);
const monthName = (m) => { if (!m) return '—'; const [y, mo] = m.split('-'); return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+mo - 1] + ' ' + y; };

function ensure() {
  db().exec(`
    CREATE TABLE IF NOT EXISTS kh_parties (
      id INTEGER PRIMARY KEY, name TEXT UNIQUE, kind TEXT, dms_supplier TEXT, bill_side TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS kh_files (
      id INTEGER PRIMARY KEY, party_id INTEGER, file TEXT, from_date TEXT, to_date TEXT,
      opening REAL, closing REAL, rows INTEGER, added INTEGER, uploaded_at TEXT);
    CREATE TABLE IF NOT EXISTS kh_entries (
      id INTEGER PRIMARY KEY, party_id INTEGER, file_id INTEGER, date TEXT, vtype TEXT, vno TEXT, bill_no TEXT,
      particulars TEXT, debit REAL, credit REAL, kind TEXT,
      UNIQUE (party_id, date, vno, particulars, debit, credit));
    CREATE INDEX IF NOT EXISTS ix_khe_party ON kh_entries(party_id, date);`);
}

// ---------- padhna ----------
// "1,23,456.50 Dr" -> 123456.5 ; "(500)" -> -500
function num(v) {
  const s = T(v); if (!s) return 0;
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s);
  const n = Number(s.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? (neg ? -n : n) : 0;
}
const drcr = (v) => (/\bcr\b/i.test(T(v)) ? 'cr' : /\bdr\b/i.test(T(v)) ? 'dr' : '');
function date(v) {
  const s = T(v); if (!s) return null;
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2})$/);          // 01/04/26
  if (m) return toDate(`${m[1]}/${m[2]}/20${m[3]}`);
  return toDate(s);
}

const COLS = {
  date: /^(date|dt|posting date|post date|doc(ument)? date|vch date|voucher date|txn date|transaction date|value date|bill date|invoice date)$/,
  vtype: /^(v[ce]h\.? ?type|voucher type|doc(ument)? type|trn type|transaction type|type)$/,
  vno: /^(v[ce]h\.? ?no\.?|voucher no\.?|doc(ument)? no\.?|bill no\.?|invoice no\.?|inv no\.?|ref(erence)? no\.?|ref\.? no\.?|chq\.?\/ref\.? no\.?|assignment|document number)$/,
  part: /^(particulars|narration|description|text|remarks|details|account|ledger)$/,
  debit: /^(debit|dr\.?|debit amount|debit amt|withdrawal|withdrawal amt\.?|debit \(rs\.?\)|debit \(inr\))$/,
  credit: /^(credit|cr\.?|credit amount|credit amt|deposit|deposit amt\.?|credit \(rs\.?\)|credit \(inr\))$/,
  amount: /^(amount|amt|amount \(rs\.?\)|amount in local currency|amount in lc)$/,
  bal: /^(balance|closing balance|running balance|bal\.?)$/,
  ref: /^(new\s*ref\.?( no\.?)?|bill\s*ref\.?( no\.?)?|bill\s*wise( details)?|ref\.? bill|bill name)$/,   // Tally bill-wise "New Ref" = asli bill number
};
function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    const low = rows[i].map((c) => T(c).toLowerCase());
    const col = {};
    low.forEach((c, j) => { for (const [k, re] of Object.entries(COLS)) if (col[k] == null && re.test(c)) col[k] = j; });
    if (col.date != null && ((col.debit != null && col.credit != null) || col.amount != null)) return { i, col };
  }
  return null;
}
function kindOf(vtype, part) {
  const s = (vtype + ' ' + part).toLowerCase();
  if (/debit note|\bdn\b|\bd\/n\b/.test(s)) return 'dn';
  if (/credit note|\bcn\b|\bc\/n\b/.test(s)) return 'cn';
  if (/journal|\bjv\b/.test(s)) return 'jv';
  if (/receipt|payment|\bbank\b|neft|rtgs|imps|upi|cheque|chq|\bcash\b|\btrf\b|transfer|hdfc|\bsbi\b|icici|axis|pnb/.test(s)) return 'pay';
  if (/invoice|\bbill\b|purchase|\bsales?\b|\binv\b/.test(s)) return 'bill';
  return 'other';
}
// Tally bill-wise: "New Ref P8045" = asli bill number (Vch No se pehle isi ko maano)
const REF = /\bnew\s*ref\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9/-]*)/i;
const CARRY = /carried\s*(over|forward|fwd)|brought\s*(over|forward|fwd)|\bc\s*\/\s*[fo]\b|\bb\s*\/\s*[fo]\b/i;
const billNo = (vno, part) => {
  const r = T(part).match(REF); if (r) return r[1];
  if (T(vno)) return T(vno);
  const m = T(part).match(/\b(?=[A-Z0-9/-]*\d)(?=[A-Z0-9/-]*[A-Z])[A-Z0-9/-]{5,}\b/i);   // P8045 / 22839P1234
  return m ? m[0] : '';
};

export function parseLedger(rows) {
  const h = findHeader(rows);
  if (!h) throw new Error('Statement ki heading nahi mili — Date + Debit/Credit (ya Amount) wali line chahiye');
  const { col } = h;
  // Tally: "Particulars" heading ke neeche 2 column — "To/By" + asli naam (dusre ki heading khaali). Dono jodo, To/By hatao
  const head = rows[h.i].map(T);
  const partCols = [];
  if (col.part != null) { partCols.push(col.part); for (let j = col.part + 1; j < head.length && !head[j]; j++) partCols.push(j); }
  const g = (r, k) => (k === 'part' && partCols.length ? T(partCols.map((j) => T(r[j])).join(' ')).replace(/^(to|by)\s+/i, '').replace(/^(to|by)$/i, '') : col[k] == null ? '' : r[col[k]]);
  const out = { opening: null, closing: null, lines: [], pFrom: null, pTo: null };
  // heading ke upar "1-Apr-26 to 30-Apr-26" jaisa period
  for (const r of rows.slice(0, h.i)) {
    const m = r.map(T).join(' ').match(/(\d{1,2}[-/. ][A-Za-z0-9]{1,9}[-/. ]\d{2,4})\s*(?:to|-|–)\s*(\d{1,2}[-/. ][A-Za-z0-9]{1,9}[-/. ]\d{2,4})/i);
    if (m && date(m[1]) && date(m[2])) { out.pFrom = date(m[1]); out.pTo = date(m[2]); break; }
  }
  let lastBal = null;
  for (const r of rows.slice(h.i + 1)) {
    const part = T(g(r, 'part')), vtype = T(g(r, 'vtype')), txt = (part + ' ' + vtype).toLowerCase();
    let dr = 0, cr = 0;
    if (col.debit != null) { dr = Math.abs(num(g(r, 'debit'))); cr = Math.abs(num(g(r, 'credit'))); }
    else { const a = num(g(r, 'amount')), s = drcr(g(r, 'amount')); if (s === 'cr' || (!s && a < 0)) cr = Math.abs(a); else dr = Math.abs(a); }
    if (col.bal != null && drcr(g(r, 'bal'))) { const b = Math.abs(num(g(r, 'bal'))); lastBal = drcr(g(r, 'bal')) === 'cr' ? -b : b; }   // sirf Dr/Cr likha ho tab
    if (CARRY.test(r.map(T).join(' '))) continue;          // page ke neeche/upar "Carried Forward / Brought Forward" — entry nahi
    const d0 = date(g(r, 'date'));
    const refv = T(g(r, 'ref')).replace(/^(new|agst)\s*ref\.?\s*[:\-]?\s*/i, '');
    if (!d0 && out.lines.length && (REF.test(r.map(T).join(' ')) || (refv && !/agst/i.test(T(g(r, 'ref')))))) {   // date ke bina "New Ref P8045 …" wali line = upar wali entry ka bill
      const last = out.lines[out.lines.length - 1], txt2 = r.map(T).filter(Boolean).join(' ');
      if (!last.refSet) { last.bill = refv || txt2.match(REF)[1]; last.refSet = true; }
      last.part = T(last.part + ' ' + txt2); continue;
    }
    if (!d0 && out.lines.length && /agst\s*ref|on\s*account/i.test(r.map(T).join(' '))) { const last = out.lines[out.lines.length - 1]; last.part = T(last.part + ' ' + r.map(T).filter(Boolean).join(' ')); continue; }
    if (/opening/.test(txt)) { out.opening = { dr, cr }; if (!out.pFrom) out.pFrom = date(g(r, 'date')); continue; }
    if (/closing/.test(txt)) { out.closing = { dr, cr }; if (!out.pTo) out.pTo = date(g(r, 'date')); continue; }
    if (/^(grand )?total|current total|total$/i.test(part) || /^total/i.test(T(r[0]))) continue;
    const d = date(g(r, 'date'));
    if (!d || (!dr && !cr)) continue;
    out.lines.push({ date: d, vtype, vno: T(g(r, 'vno')), bill: (!/agst/i.test(T(g(r, 'ref'))) && refv) || billNo(g(r, 'vno'), part), refSet: !!refv, part, dr: r2(dr), cr: r2(cr), kind: kindOf(vtype, part) });
  }
  if (!out.lines.length) throw new Error('Statement me ek bhi entry nahi mili');
  out.lastBal = lastBal;
  return out;
}

// bill kis taraf (Dr/Cr) — party ke statement me bill Dr, hamare Tally me party ka bill Cr. Jis taraf bill zyada wahi.
function billSide(lines) {
  const b = lines.filter((l) => l.kind === 'bill');
  const d = b.reduce((s, l) => s + l.dr, 0), c = b.reduce((s, l) => s + l.cr, 0);
  if (d || c) return d >= c ? 'dr' : 'cr';
  const p = lines.filter((l) => l.kind === 'pay');
  return p.reduce((s, l) => s + l.cr, 0) >= p.reduce((s, l) => s + l.dr, 0) ? 'dr' : 'cr';
}
// + = hamein dena (bill wali taraf)
const signed = (side, dr, cr) => (side === 'dr' ? dr - cr : cr - dr);

// ---------- DMS purchase ----------
const hasTable = (n) => !!db().prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(n);
function dmsInvoices(kind, supplier) {
  const d = db(), out = [];
  if ((kind === 'vehicle' || kind === 'other') && hasTable('vehicle_purchase'))
    out.push(...d.prepare(`SELECT invoiceNo inv, MIN(invoiceDate) date, MAX(invoiceValue) amount, SUM(COALESCE(rate,0)) rateSum, COUNT(*) n, MAX(supplier) supplier, 'vehicle' src
      FROM vehicle_purchase WHERE IFNULL(invoiceNo,'')<>'' ${supplier ? 'AND supplier = ?' : ''} GROUP BY invoiceNo`).all(...(supplier ? [supplier] : [])));
  if ((kind === 'parts' || kind === 'other') && hasTable('parts_purchase'))
    out.push(...d.prepare(`SELECT invoiceNo inv, MIN(date) date, SUM(COALESCE(qty,0)*COALESCE(rate,0)) amount, COUNT(*) n, MAX(supplier) supplier, 'parts' src
      FROM parts_purchase WHERE IFNULL(invoiceNo,'')<>'' ${supplier ? 'AND supplier = ?' : ''} GROUP BY invoiceNo`).all(...(supplier ? [supplier] : [])));
  for (const x of out) { if (!x.amount && x.rateSum) x.amount = x.rateSum; x.amount = r2(x.amount); }
  return out;
}
// amount milaan: barabar / GST ka farak (DMS me bina tax?) / farak
function amtState(st, dms) {
  if (!dms) return 'nodms';
  const diff = st - dms;
  if (Math.abs(diff) <= Math.max(2, dms * 0.005)) return 'ok';
  const ratio = st / dms;
  if (ratio >= 1.04 && ratio <= 1.30) return 'tax';
  return 'diff';
}

// ---------- poora hisaab ----------
function partyReport(p, f, t) {
  const d = db();
  const all = d.prepare('SELECT * FROM kh_entries WHERE party_id = ? ORDER BY date, id').all(p.id);
  const files = d.prepare('SELECT * FROM kh_files WHERE party_id = ? ORDER BY from_date, id').all(p.id);
  const side = p.bill_side || 'dr';
  const first = files[0];
  let bal = first ? (first.opening || 0) : 0;
  const startDate = first?.from_date || all[0]?.date || null;
  // chain: har date tak ka balance
  const months = new Map();
  const balBefore = new Map();   // date -> us din se pehle ka balance
  for (const e of all) {
    if (!balBefore.has(e.date)) balBefore.set(e.date, bal);
    const m = ym(e.date);
    const x = months.get(m) || { month: m, label: monthName(m), opening: bal, bill: 0, pay: 0, dn: 0, cn: 0, jv: 0, other: 0, n: 0 };
    const v = signed(side, e.debit || 0, e.credit || 0);     // + = dena badha, − = ghata
    x[e.kind] = (x[e.kind] || 0) + v;
    x.n++; bal += v; x.closing = bal; months.set(m, x);
  }
  const balAt = (iso) => { let b = first ? (first.opening || 0) : 0; for (const e of all) { if (e.date > iso) break; b += signed(side, e.debit || 0, e.credit || 0); } return b; };
  const warnings = [];
  const fileRows = files.map((fl, i) => {
    const prev = i ? balAt(addDay(fl.from_date, -1)) : null;
    const calcClose = balAt(fl.to_date);
    const openOk = i === 0 || fl.opening == null || Math.abs(prev - fl.opening) <= 1;
    const closeOk = fl.closing == null || Math.abs(calcClose - fl.closing) <= 1;
    if (!openOk) warnings.push(`${fl.file}: statement ki opening ${r2(fl.opening)} hai, par pichhle hisaab se ${r2(prev)} honi chahiye (farak ${r2(fl.opening - prev)}) — beech ki statement chhooti?`);
    if (!closeOk) warnings.push(`${fl.file}: statement ki closing ${r2(fl.closing)}, entries jod ke ${r2(calcClose)} (farak ${r2(fl.closing - calcClose)}) — koi entry padhi nahi gayi?`);
    return { id: fl.id, file: fl.file, from: toDMY(fl.from_date), to: toDMY(fl.to_date), opening: fl.opening == null ? null : r2(fl.opening), closing: fl.closing == null ? null : r2(fl.closing),
      calcClose: r2(calcClose), openOk, closeOk, rows: fl.rows, added: fl.added, uploadedAt: fl.uploaded_at };
  });
  // gap: ek file ke to aur agli ke from ke beech din chhoote
  for (let i = 1; i < files.length; i++) if (files[i].opening == null && files[i].from_date > addDay(files[i - 1].to_date, 1)) warnings.push(`${toDMY(addDay(files[i - 1].to_date, 1))} se ${toDMY(addDay(files[i].from_date, -1))} tak ki statement nahi hai`);

  const inR = (iso) => (!f || iso >= f) && (!t || iso <= t);
  const monthRows = [...months.values()].filter((x) => (!f || x.month >= ym(f)) && (!t || x.month <= ym(t)))
    .map((x) => ({ ...x, opening: r2(x.opening), closing: r2(x.closing), bill: r2(x.bill), pay: r2(-x.pay), dn: r2(x.dn), cn: r2(-x.cn), jv: r2(-x.jv), other: r2(x.other) }))
    .sort((a, b) => b.month.localeCompare(a.month));
  const entries = all.filter((e) => inR(e.date)).map((e) => ({ id: e.id, date: toDMY(e.date), vtype: e.vtype, vno: e.vno, bill: e.bill_no, particulars: e.particulars,
    debit: r2(e.debit), credit: r2(e.credit), kind: e.kind })).reverse();

  // ---- DMS milaan ----
  const lastTo = files.map((x) => x.to_date).sort().pop() || all[all.length - 1]?.date || null;
  const dms = p.kind ? dmsInvoices(p.kind, p.dms_supplier || null) : [];
  const allDms = p.kind ? (p.dms_supplier ? dmsInvoices(p.kind, null) : dms) : [];
  const dmsBy = new Map(); for (const x of allDms) dmsBy.set(KEY(x.inv), x);
  const dmsDigits = new Map(); for (const x of allDms) { const k = KEY(x.inv).replace(/\D/g, ''); if (k.length >= 5) dmsDigits.set(k, dmsDigits.has(k) ? null : x); }
  const stBills = all.filter((e) => e.kind === 'bill' && inR(e.date));
  const matchedDms = new Set();
  const both = [], stOnly = [];
  for (const e of stBills) {
    const k = KEY(e.bill_no);
    const x = dmsBy.get(k) || (k.replace(/\D/g, '').length >= 5 ? dmsDigits.get(k.replace(/\D/g, '')) : null);
    const amt = Math.abs(signed(side, e.debit || 0, e.credit || 0));
    if (x) { matchedDms.add(x.inv); const st = amtState(amt, x.amount); both.push({ bill: e.bill_no, date: toDMY(e.date), dmsDate: toDMY(x.date), stAmt: r2(amt), dmsAmt: x.amount, diff: r2(amt - x.amount), state: st, qty: x.n, src: x.src }); }
    else stOnly.push({ bill: e.bill_no, date: toDMY(e.date), stAmt: r2(amt), particulars: e.particulars });
  }
  // sirf DMS: party ka supplier set ho tabhi (warna har supplier ka aa jayega). Statement ki range ke andar
  const stFrom = files[0]?.from_date || all[0]?.date, stTo = lastTo;
  const lo = f && f > (stFrom || '') ? f : stFrom || '0000', hi = t && stTo && t < stTo ? t : stTo || '9999';
  const dmsOnly = p.dms_supplier ? dms.filter((x) => !matchedDms.has(x.inv) && x.date && x.date >= lo && x.date <= hi)
    .map((x) => ({ bill: x.inv, date: toDMY(x.date), dmsAmt: x.amount, qty: x.n, src: x.src })).sort((a, b) => a.date.localeCompare(b.date)) : [];
  // aakhri statement ke baad DMS ki purchase -> andaaze ka balance
  const after = p.dms_supplier && lastTo ? dms.filter((x) => x.date && x.date > lastTo) : [];
  const finalBal = all.length || first ? bal : null;
  const provisional = finalBal == null ? null : r2(finalBal + after.reduce((s, x) => s + x.amount, 0));

  const sum = (k) => r2(monthRows.reduce((s, x) => s + (x[k] || 0), 0));
  // chuni hui range ki opening / closing (range na ho to poora)
  const firstOpen = first ? (first.opening || 0) : 0;
  const rOpen = f ? balAt(addDay(f, -1)) : firstOpen;
  const rClose = t ? balAt(t) : (finalBal ?? firstOpen);
  return {
    party: { id: p.id, name: p.name, kind: p.kind, dmsSupplier: p.dms_supplier, billSide: side },
    summary: { files: files.length, lastUpload: files.map((x) => x.uploaded_at).sort().pop() || null, rOpen: all.length ? r2(rOpen) : null, rClose: all.length ? r2(rClose) : null, rFrom: toDMY(f || startDate || ''), rTo: toDMY(t && lastTo && t > lastTo ? lastTo : t || lastTo || ''), closing: finalBal == null ? null : r2(finalBal), lastTo: toDMY(lastTo || ''), start: toDMY(startDate || ''), provisional, afterCount: after.length, afterAmt: r2(after.reduce((s, x) => s + x.amount, 0)),
      bill: sum('bill'), pay: sum('pay'), dn: sum('dn'), cn: sum('cn'), jv: sum('jv'),
      matched: both.filter((x) => x.state === 'ok').length, tax: both.filter((x) => x.state === 'tax').length, diff: both.filter((x) => x.state === 'diff').length,
      stOnly: stOnly.length, dmsOnly: dmsOnly.length, warnings: warnings.length },
    months: monthRows, entries, files: fileRows.reverse(), warnings,
    match: { both, stOnly, dmsOnly, after: after.map((x) => ({ bill: x.inv, date: toDMY(x.date), dmsAmt: x.amount, qty: x.n })) },
  };
}
function addDay(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

// ---------- routes ----------
const h = (fn) => (req, res) => { try { ensure(); fn(req, res); } catch (e) { res.status(400).json({ ok: false, error: e.message }); } };
const getParty = (id) => { const p = db().prepare('SELECT * FROM kh_parties WHERE id = ?').get(Number(id)); if (!p) throw new Error('Party nahi mili'); return p; };

khaataApi.get('/khaata/parties', h((_req, res) => {
  const ps = db().prepare('SELECT * FROM kh_parties ORDER BY name').all();
  res.json(ps.map((p) => { const r = partyReport(p, null, null); return { id: p.id, name: p.name, kind: p.kind, dmsSupplier: p.dms_supplier, ...r.summary }; }));
}));
khaataApi.get('/khaata/suppliers', h((req, res) => {
  const kind = String(req.query.kind || '');
  const out = new Set();
  if (kind !== 'parts' && hasTable('vehicle_purchase')) for (const r of db().prepare(`SELECT DISTINCT supplier s FROM vehicle_purchase WHERE IFNULL(supplier,'')<>''`).all()) out.add(r.s);
  if (kind !== 'vehicle' && hasTable('parts_purchase')) for (const r of db().prepare(`SELECT DISTINCT supplier s FROM parts_purchase WHERE IFNULL(supplier,'')<>''`).all()) out.add(r.s);
  res.json([...out].sort());
}));
khaataApi.post('/khaata/party', h((req, res) => {
  const { id, name, kind = 'other', dmsSupplier = '' } = req.body || {};
  const nm = T(name); if (!nm) throw new Error('Party ka naam do');
  if (!['vehicle', 'parts', 'other'].includes(kind)) throw new Error('kind galat');
  if (id) db().prepare('UPDATE kh_parties SET name=?, kind=?, dms_supplier=? WHERE id=?').run(nm, kind, dmsSupplier || null, Number(id));
  else db().prepare('INSERT INTO kh_parties (name, kind, dms_supplier, created_at) VALUES (?,?,?,?)').run(nm, kind, dmsSupplier || null, nowIso());
  res.json({ ok: true, party: db().prepare('SELECT * FROM kh_parties WHERE name = ?').get(nm) });
}));
khaataApi.post('/khaata/upload', async (req, res) => { try {
  ensure();
  const { partyId, fileB64, fileName = '', override = false } = req.body || {};
  const p = getParty(partyId);
  const buf = Buffer.from(String(fileB64 || ''), 'base64');
  const isPdf = buf.subarray(0, 5).toString('latin1') === '%PDF-';
  const pr = isPdf ? await pdfRows(buf) : null;
  const L = parseLedger(pr ? pr.rows : rowsFromBuffer(buf));
  const side = p.bill_side || billSide(L.lines);
  const lo = [...L.lines].sort((a, b) => a.date.localeCompare(b.date));
  const from = L.pFrom && L.pFrom <= lo[0].date ? L.pFrom : lo[0].date, to = L.pTo && L.pTo >= lo[lo.length - 1].date ? L.pTo : lo[lo.length - 1].date;
  const opening = L.opening ? signed(side, L.opening.dr, L.opening.cr) : null;
  let closing = L.closing && (L.closing.dr || L.closing.cr) ? signed(side, L.closing.dr, L.closing.cr) : null;   // khaali / 0 closing = nahi likhi
  if (closing == null && L.lastBal != null) closing = side === 'dr' ? L.lastBal : -L.lastBal;
  // Tally me "Closing Balance" ulti taraf likha hota hai (total barabar karne ko) — entries jod ke ulta aaye to palat do
  if (closing != null) { const calc = (opening || 0) + L.lines.reduce((s, l) => s + signed(side, l.dr, l.cr), 0); if (Math.abs(closing) > 1 && Math.abs(closing + calc) <= 1) closing = -closing; }
  let added = 0, fileId, replaced = 0;
  tx(() => {
    if (!p.bill_side) db().prepare('UPDATE kh_parties SET bill_side=? WHERE id=?').run(side, p.id);
    if (override) {   // is statement ki tareekhon ki purani entry hatao, nayi file wali hi rahe
      replaced = Number(db().prepare('DELETE FROM kh_entries WHERE party_id=? AND date BETWEEN ? AND ?').run(p.id, from, to).changes);
      db().prepare('DELETE FROM kh_files WHERE party_id=? AND from_date >= ? AND to_date <= ?').run(p.id, from, to);
      db().prepare(`DELETE FROM kh_files WHERE party_id=? AND NOT EXISTS (SELECT 1 FROM kh_entries e WHERE e.file_id = kh_files.id)`).run(p.id);
    }
    fileId = Number(db().prepare('INSERT INTO kh_files (party_id, file, from_date, to_date, opening, closing, rows, added, uploaded_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(p.id, fileName, from, to, opening, closing, L.lines.length, 0, nowIso()).lastInsertRowid);
    const ins = db().prepare(`INSERT OR IGNORE INTO kh_entries (party_id, file_id, date, vtype, vno, bill_no, particulars, debit, credit, kind) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (const l of L.lines) added += Number(ins.run(p.id, fileId, l.date, l.vtype, l.vno, l.bill, l.part, l.dr, l.cr, l.kind).changes);
    db().prepare('UPDATE kh_files SET added=? WHERE id=?').run(added, fileId);
    if (!added) db().prepare('DELETE FROM kh_files WHERE id=?').run(fileId);   // sab pehle se tha — file ka record mat banao
  });
  const kinds = {}; for (const l of L.lines) kinds[l.kind] = (kinds[l.kind] || 0) + 1;
  res.json({ ok: true, pdf: isPdf, ocr: !!pr?.ocr, lines: L.lines.length, added, replaced, override: !!override, already: !added, from: toDMY(from), to: toDMY(to), opening: opening == null ? null : r2(opening), closing: closing == null ? null : r2(closing), side, kinds });
} catch (e) { res.status(400).json({ ok: false, error: e.message }); } });
khaataApi.get('/khaata/party/:id', h((req, res) => {
  const f = toDate(req.query.from), t = toDate(req.query.to || req.query.from) || null;
  res.json(partyReport(getParty(req.params.id), f, t));
}));
khaataApi.delete('/khaata/file/:id', h((req, res) => {
  const fl = db().prepare('SELECT * FROM kh_files WHERE id=?').get(Number(req.params.id)); if (!fl) throw new Error('File nahi mili');
  tx(() => { db().prepare('DELETE FROM kh_entries WHERE file_id=?').run(fl.id); db().prepare('DELETE FROM kh_files WHERE id=?').run(fl.id); });
  res.json({ ok: true });
}));
// CLEAR: party rahe (naam, DMS supplier), saari statement + entry hatao — shuru se daalo
khaataApi.post('/khaata/party/:id/clear', h((req, res) => {
  const id = Number(req.params.id); getParty(id);
  let n = 0;
  tx(() => { n = Number(db().prepare('DELETE FROM kh_entries WHERE party_id=?').run(id).changes); db().prepare('DELETE FROM kh_files WHERE party_id=?').run(id); db().prepare('UPDATE kh_parties SET bill_side=NULL WHERE id=?').run(id); });
  res.json({ ok: true, removed: n });
}));
khaataApi.delete('/khaata/party/:id', h((req, res) => {
  const id = Number(req.params.id);
  tx(() => { for (const tb of ['kh_entries', 'kh_files']) db().prepare(`DELETE FROM ${tb} WHERE party_id=?`).run(id); db().prepare('DELETE FROM kh_parties WHERE id=?').run(id); });
  res.json({ ok: true });
}));