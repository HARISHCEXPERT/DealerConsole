// ============================================================
//  MASTER UPLOAD + LIVE STOCK (parts & vehicles)
//
//  Master (DMS stock report) ek baar upload -> "snapshot". Uske baad:
//    Parts:   aaj ka stock = master stock + baad ki purchase − baad ki workshop sale − baad ki counter sale
//    Vehicle: stock = (master 'Available' + purchase ki VIN) − VSR me biki VIN (cancelled nahi)
//
//  "Baad ki" kaun si?  Snapshot ke mode se:
//    start : Master din SHURU hone se pehle ka  -> us din ki saari entries jodo
//    end   : Master din BAND hone ke baad ka    -> agle din se jodo
//    now   : Master din ke BEECH me nikala      -> us din ki jo entries upload ke waqt DB me thi
//            (woh master me pehle se shamil hain) unhe chhod do, baaki jodo
//
//  Naya master upload hone par pehle MILAAN: system ka hisaab vs naye master ka asli stock -> farak list.
// ============================================================
import { Router } from 'express';
import { db, q, tx } from '../db/index.js';
import { ingest, ensureTable, resetColCache, tableExists, compile } from '../db/engine.js';
import { toDate, toDMY } from '../db/types.js';
import { source } from '../sources/index.js';

export const stock = Router();
const nowIso = () => new Date().toISOString();
const PK = (col) => `UPPER(REPLACE(REPLACE(REPLACE(TRIM(${col}),'-',''),' ',''),'.',''))`;   // part no ko ek jaisa karo
const VK = (col) => `UPPER(TRIM(${col}))`;

function ensureMeta() {
  db().exec(`
    CREATE TABLE IF NOT EXISTS stock_snapshots (
      id INTEGER PRIMARY KEY, kind TEXT NOT NULL, uploaded_at TEXT NOT NULL,
      as_of TEXT NOT NULL, mode TEXT NOT NULL, rows INTEGER, file_name TEXT, note TEXT
    );
    CREATE TABLE IF NOT EXISTS stock_snapshot_excl (
      snapshot_id INTEGER NOT NULL, src TEXT NOT NULL, invoice_no TEXT NOT NULL,
      PRIMARY KEY (snapshot_id, src, invoice_no)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS stock_recon (
      snapshot_id INTEGER NOT NULL, part_key TEXT NOT NULL, part_no TEXT, part_desc TEXT,
      system_qty REAL, actual_qty REAL, diff REAL, dlc REAL,
      PRIMARY KEY (snapshot_id, part_key)
    ) WITHOUT ROWID;
  `);
}
export const latestSnap = (kind) => { ensureMeta(); return db().prepare(`SELECT * FROM stock_snapshots WHERE kind=? ORDER BY id DESC LIMIT 1`).get(kind) || null; };

// snapshot ke baad wali entries ka WHERE (alias t, columns date/invoiceNo, src literal)
export function afterSnap(snap, srcExpr) {
  if (!snap) return { sql: '1=1', params: [] };
  const base = `(t.date > ? OR (t.date = ? AND (? = 'start' OR (? = 'now' AND NOT EXISTS (SELECT 1 FROM stock_snapshot_excl e WHERE e.snapshot_id = ? AND e.src = ${srcExpr} AND e.invoice_no = IFNULL(t.invoiceNo,''))))))`;
  return { sql: base, params: [snap.as_of, snap.as_of, snap.mode, snap.mode, snap.id] };
}

// ---------------- LIVE PARTS STOCK ----------------
export function partsLive() {
  const d = db();
  const snap = latestSnap('parts');
  const hasM = tableExists('parts_master'), hasP = tableExists('parts_purchase'), hasS = tableExists('parts_sales');
  const map = new Map();
  if (hasM) {
    for (const r of d.prepare(`SELECT ${PK('partNo')} k, MIN(partNo) partNo, MAX(partDesc) descr, SUM(IFNULL(stock,0)) stock,
        MAX(mrp) mrp, MAX(dlc) dlc, MAX(moq) moq, MAX(category) cat FROM parts_master GROUP BY k`).all())
      map.set(r.k, { partNo: r.partNo, desc: r.descr || '', opening: r.stock || 0, inQ: 0, outService: 0, outCounter: 0, mrp: r.mrp || 0, dlc: r.dlc || 0, moq: r.moq || 0, cat: r.cat || '', inMaster: true });
  }
  const get = (k, pn, name) => { if (!map.has(k)) map.set(k, { partNo: pn, desc: name || '', opening: 0, inQ: 0, outService: 0, outCounter: 0, mrp: 0, dlc: 0, moq: 0, cat: '', inMaster: false }); return map.get(k); };
  if (snap && hasP) {
    const w = afterSnap(snap, `'purchase'`);
    for (const r of d.prepare(`SELECT ${PK('t.partNo')} k, MIN(t.partNo) pn, MAX(t.partName) nm, SUM(IFNULL(t.qty,0)) q FROM parts_purchase t WHERE ${w.sql} GROUP BY k`).all(...w.params))
      get(r.k, r.pn, r.nm).inQ += r.q;
  }
  if (snap && hasS) {
    const w = afterSnap(snap, `t.src`);
    for (const r of d.prepare(`SELECT ${PK('t.partNo')} k, MIN(t.partNo) pn, MAX(t.partName) nm, t.src s, SUM(IFNULL(t.qty,0)) q FROM parts_sales t WHERE ${w.sql} GROUP BY k, t.src`).all(...w.params)) {
      const x = get(r.k, r.pn, r.nm);
      if (r.s === 'counter') x.outCounter += r.q; else x.outService += r.q;
    }
  }
  const round = (n) => Math.round(n * 1000) / 1000;
  const rows = [...map.values()].map((x) => ({ ...x, stock: round(x.opening + x.inQ - x.outService - x.outCounter) }));
  return { snapshot: snap ? { ...snap, as_of: toDMY(snap.as_of) } : null, rows };
}

// ek part ka poora hisaab (opening + har entry)
function partLedger(partNo) {
  const d = db();
  const snap = latestSnap('parts');
  const k = String(partNo || '').toUpperCase().replace(/[-\s.]/g, '');
  const live = partsLive().rows.find((r) => String(r.partNo).toUpperCase().replace(/[-\s.]/g, '') === k);
  const out = [];
  if (tableExists('parts_purchase')) {
    const w = afterSnap(snap, `'purchase'`);
    out.push(...d.prepare(`SELECT t.date, t.invoiceNo, 'Purchase' type, t.supplier party, t.qty q FROM parts_purchase t WHERE ${PK('t.partNo')} = ? AND ${w.sql}`).all(k, ...w.params));
  }
  if (tableExists('parts_sales')) {
    const w = afterSnap(snap, `t.src`);
    out.push(...d.prepare(`SELECT t.date, t.invoiceNo, CASE t.src WHEN 'counter' THEN 'Counter sale' ELSE 'Workshop' END type, t.customer party, -t.qty q FROM parts_sales t WHERE ${PK('t.partNo')} = ? AND ${w.sql}`).all(k, ...w.params));
  }
  out.sort((a, b) => (a.date || '').localeCompare(b.date || '') || String(a.invoiceNo).localeCompare(String(b.invoiceNo)));
  let bal = live ? live.opening : 0;
  const rows = [{ date: snap ? toDMY(snap.as_of) : '', invoiceNo: '', type: 'Opening (Master)', party: snap ? `mode: ${snap.mode}` : 'Master nahi', q: bal, bal }];
  for (const r of out) { bal += r.q || 0; rows.push({ ...r, date: toDMY(r.date), bal: Math.round(bal * 1000) / 1000 }); }
  return { part: live || { partNo }, rows };
}

// ---------------- LIVE VEHICLE STOCK ----------------
// RULE: Master ki date = shuruaat. Us date se PEHLE ki purchase/sale ginti me nahi (Master hi sach).
//   Master me Available  -> stock (sirf Master date ya baad ki VSR sale se hategi)
//   Purchase             -> sirf Master date ya baad ki judegi
export function vehiclesLive() {
  const d = db();
  const snap = latestSnap('vehicle');
  const asOf = snap?.as_of || null;
  const soldAny = new Set(), soldAfter = new Set();
  let vsrFrom = null;
  if (tableExists('vehicle_sales')) {
    for (const r of d.prepare(`SELECT ${VK('vin')} k, MAX(invoiceDate) dt FROM vehicle_sales WHERE vin IS NOT NULL AND IFNULL(status,'') NOT LIKE '%cancel%' GROUP BY k`).all()) {
      soldAny.add(r.k);
      if (!asOf || !r.dt || r.dt >= asOf) soldAfter.add(r.k);
    }
    vsrFrom = d.prepare(`SELECT MIN(invoiceDate) m FROM vehicle_sales`).get().m;
  }
  const cand = new Map();
  const masterSold = new Set();
  if (tableExists('vehicle_master')) {
    for (const r of d.prepare(`SELECT ${VK('vin')} k, vin, model, variant, status, invoiceDate, hmclInvoiceDate, mfgMonth, basicPrice FROM vehicle_master WHERE vin IS NOT NULL`).all()) {
      if (/owned|customer|sold|invoiced/i.test(r.status || '')) { masterSold.add(r.k); continue; }
      if (!/available/i.test(r.status || '')) continue;
      cand.set(r.k, { vin: r.vin, model: r.model || '—', variant: r.variant || '—', stockInDate: toDMY(r.invoiceDate || r.hmclInvoiceDate || r.mfgMonth || ''),
        mfgMonth: toDMY(r.mfgMonth || ''), rate: r.basicPrice || 0, supplier: '', src: 'Master' });
    }
  }
  let beforeMaster = 0;
  if (tableExists('vehicle_purchase')) {
    for (const r of d.prepare(`SELECT ${VK('vin')} k, vin, model, variant, stockInDate, invoiceDate, rate, supplier FROM vehicle_purchase WHERE vin IS NOT NULL`).all()) {
      const prev = cand.get(r.k);
      const dt = r.stockInDate || r.invoiceDate || null;
      if (!prev && asOf && dt && dt < asOf) { beforeMaster++; continue; }   // Master se pehle aayi, Master me Available nahi -> bik chuki
      cand.set(r.k, { vin: r.vin, model: r.model || prev?.model || '—', variant: r.variant || prev?.variant || '—', stockInDate: toDMY(r.stockInDate || r.invoiceDate || ''),
        mfgMonth: prev?.mfgMonth || '', rate: r.rate || prev?.rate || 0, supplier: r.supplier || '', src: prev ? 'Master+Purchase' : 'Purchase', fromMaster: !!prev });
    }
  }
  const stock = [];
  let soldHidden = 0;
  for (const [k, v] of cand) {
    const inMaster = v.src !== 'Purchase';
    const gone = masterSold.has(k) || (inMaster && asOf ? soldAfter.has(k) : soldAny.has(k));
    if (gone) soldHidden++; else stock.push(v);
  }
  return { snapshot: snap ? { ...snap, as_of: toDMY(snap.as_of) } : null, stock, soldHidden, beforeMaster, vsrFrom: toDMY(vsrFrom || ''),
    masterRows: tableExists('vehicle_master') ? d.prepare('SELECT COUNT(*) n FROM vehicle_master').get().n : 0 };
}

// ---------------- UPLOAD (chunks -> staging -> commit) ----------------
const KIND = { parts: 'parts_master', vehicle: 'vehicle_master' };
const staging = (kind) => ({ ...source(KIND[kind]), table: KIND[kind] + '__staging' });

stock.post('/master/:kind/chunk', (req, res) => {
  try {
    const kind = req.params.kind; if (!KIND[kind]) throw new Error('kind parts/vehicle');
    const { index = 0, rows = [] } = req.body || {};
    const st = staging(kind);
    if (index === 0) { if (tableExists(st.table)) db().exec(`DROP TABLE ${q(st.table)}`); resetColCache(); }
    const r = ingest(st, rows, { kind: 'master', storeRaw: false });
    res.json({ ok: true, got: r.rowsIn - r.skipped, skipped: r.skipped });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

stock.post('/master/:kind/commit', (req, res) => {
  try {
    ensureMeta();
    const kind = req.params.kind; if (!KIND[kind]) throw new Error('kind parts/vehicle');
    const { asOf, mode = 'end', fileName = '' } = req.body || {};
    const asOfIso = toDate(asOf) || toDate(new Date());
    if (!['start', 'end', 'now'].includes(mode)) throw new Error('mode start/end/now');
    const real = source(KIND[kind]), st = staging(kind);
    if (!tableExists(st.table)) throw new Error('Pehle file upload karo (staging khaali)');
    const d = db();
    const n = d.prepare(`SELECT COUNT(*) n FROM ${q(st.table)}`).get().n;
    if (!n) throw new Error('File me ek bhi sahi row nahi mili');

    // ---- MILAAN (sirf parts, aur jab pehle ka master ho) ----
    let recon = null;
    const prevSnap = latestSnap(kind);
    const reconRows = [];
    if (kind === 'parts' && prevSnap) {
      const sys = new Map(partsLive().rows.map((r) => [String(r.partNo).toUpperCase().replace(/[-\s.]/g, ''), r]));
      const act = d.prepare(`SELECT ${PK('partNo')} k, MIN(partNo) pn, MAX(partDesc) ds, SUM(IFNULL(stock,0)) s, MAX(dlc) dlc FROM ${q(st.table)} GROUP BY k`).all();
      const seen = new Set();
      for (const a of act) { seen.add(a.k); const s = sys.get(a.k); const sq = s ? s.stock : 0;
        if (Math.abs(sq - a.s) > 0.0001) reconRows.push([a.k, a.pn, a.ds || s?.desc || '', sq, a.s, a.s - sq, a.dlc || s?.dlc || 0]); }
      for (const [k2, s] of sys) if (!seen.has(k2) && Math.abs(s.stock) > 0.0001) reconRows.push([k2, s.partNo, s.desc, s.stock, 0, -s.stock, s.dlc]);
      recon = { checked: act.length, diffs: reconRows.length, valueDiff: Math.round(reconRows.reduce((t, r) => t + r[5] * (r[6] || 0), 0)) };
    }

    let snapId;
    tx(() => {
      if (tableExists(real.table)) d.exec(`DROP TABLE ${q(real.table)}`);
      for (const ix of d.prepare(`PRAGMA index_list(${q(st.table)})`).all()) if (!ix.name.startsWith('sqlite_')) d.exec(`DROP INDEX IF EXISTS ${q(ix.name)}`);
      d.exec(`ALTER TABLE ${q(st.table)} RENAME TO ${q(real.table)}`);
      resetColCache();
      ensureTable(real);
      snapId = Number(d.prepare(`INSERT INTO stock_snapshots (kind, uploaded_at, as_of, mode, rows, file_name) VALUES (?,?,?,?,?,?)`)
        .run(kind, nowIso(), asOfIso, mode, n, fileName).lastInsertRowid);
      if (mode === 'now') {   // upload ke waqt us din ki jo entries DB me thi -> master me shamil maano
        const ins = d.prepare(`INSERT OR IGNORE INTO stock_snapshot_excl (snapshot_id, src, invoice_no) VALUES (?,?,?)`);
        if (tableExists('parts_purchase')) for (const r of d.prepare(`SELECT DISTINCT IFNULL(invoiceNo,'') i FROM parts_purchase WHERE date = ?`).all(asOfIso)) ins.run(snapId, 'purchase', r.i);
        if (tableExists('parts_sales')) for (const r of d.prepare(`SELECT DISTINCT src, IFNULL(invoiceNo,'') i FROM parts_sales WHERE date = ?`).all(asOfIso)) ins.run(snapId, r.src, r.i);
      }
      const ir = d.prepare(`INSERT INTO stock_recon (snapshot_id, part_key, part_no, part_desc, system_qty, actual_qty, diff, dlc) VALUES (?,?,?,?,?,?,?,?)`);
      for (const r of reconRows) ir.run(snapId, ...r);
    });
    const excl = d.prepare('SELECT COUNT(*) n FROM stock_snapshot_excl WHERE snapshot_id=?').get(snapId).n;
    res.json({ ok: true, snapshotId: snapId, rows: n, asOf: toDMY(asOfIso), mode, excluded: excl, recon });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ---------------- READ ----------------
stock.get('/stock/parts', (_req, res) => { try { res.json(partsLive()); } catch (e) { res.status(500).json({ error: e.message }); } });
stock.get('/stock/parts/ledger', (req, res) => { try { res.json(partLedger(req.query.partNo)); } catch (e) { res.status(500).json({ error: e.message }); } });
stock.get('/stock/vehicles', (_req, res) => { try { res.json(vehiclesLive()); } catch (e) { res.status(500).json({ error: e.message }); } });
stock.get('/stock/recon', (req, res) => {
  try {
    ensureMeta();
    const snap = req.query.id ? db().prepare('SELECT * FROM stock_snapshots WHERE id=?').get(req.query.id)
      : db().prepare(`SELECT s.* FROM stock_snapshots s WHERE kind='parts' AND EXISTS (SELECT 1 FROM stock_recon r WHERE r.snapshot_id=s.id) ORDER BY id DESC LIMIT 1`).get();
    if (!snap) return res.json({ snapshot: null, rows: [] });
    const rows = db().prepare('SELECT part_no partNo, part_desc "desc", system_qty system, actual_qty actual, diff, dlc, ROUND(diff*IFNULL(dlc,0)) value FROM stock_recon WHERE snapshot_id=? ORDER BY ABS(diff*IFNULL(dlc,0)) DESC').all(snap.id);
    res.json({ snapshot: { ...snap, as_of: toDMY(snap.as_of) }, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
stock.get('/master/snapshots', (_req, res) => { ensureMeta(); res.json(db().prepare('SELECT * FROM stock_snapshots ORDER BY id DESC LIMIT 50').all()); });
