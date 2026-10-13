// ============================================================
//  PARTS PURCHASE ORDER TRACKING — order laga, bill hua ya nahi, kya bacha
//  Ek order line ke kai invoice ho sakte (split billing) -> (order no + part no) pe jod ke dekhte hain.
//  Line status:
//    Cancel        : ORDER STATUS me cancel
//    Bill nahi hua : invoice qty 0
//    Adhoora       : thoda bill hua, baaki pending
//    Raste me      : poora bill hua par GRN invoice number khaali (maal abhi aaya nahi)
//    Bill ho gaya  : poora bill + GRN
// ============================================================
import { Router } from 'express';
import { db } from '../db/index.js';
import { tableExists } from '../db/engine.js';
import { toDate, toDMY } from '../db/types.js';
import { pullReports } from '../jobs/pull.js';

export const orders = Router();
const r3 = (n) => Math.round((n || 0) * 1000) / 1000;

function lines(where = '', params = []) {
  if (!tableExists('parts_orders')) return [];
  const rows = db().prepare(`
    SELECT poNo, MIN(orderDate) orderDate, MAX(orderStatus) orderStatus, MAX(orderSubtype) orderSubtype, MAX(supplier) supplier,
           partNo, MAX(partDesc) partDesc, MAX(IFNULL(orderQty,0)) orderQty, SUM(IFNULL(invoiceQty,0)) billQty,
           GROUP_CONCAT(DISTINCT NULLIF(invoiceNo,'')) invoices, MAX(invoiceDate) lastInvoiceDate,
           SUM(CASE WHEN IFNULL(invoiceNo,'')<>'' AND IFNULL(grnInvoiceNo,'')='' THEN 1 ELSE 0 END) grnMissing,
           GROUP_CONCAT(DISTINCT NULLIF(grnInvoiceNo,'')) grns
    FROM parts_orders ${where ? 'WHERE ' + where : ''}
    GROUP BY poNo, partNo ORDER BY orderDate, poNo, partNo`).all(...params);
  const today = new Date();
  return rows.map((x) => {
    const pending = r3(Math.max(0, x.orderQty - x.billQty));
    const status = /cancel/i.test(x.orderStatus || '') ? 'Cancel'
      : x.billQty <= 0 ? 'Bill nahi hua'
      : pending > 0 ? 'Adhoora'
      : x.grnMissing > 0 ? 'Raste me' : 'Bill ho gaya';
    const d = x.orderDate ? new Date(x.orderDate + 'T00:00:00') : null;
    return { ...x, orderDate: toDMY(x.orderDate), lastInvoiceDate: toDMY(x.lastInvoiceDate), billQty: r3(x.billQty), pending, status,
      days: d ? Math.floor((today - d) / 864e5) : null };
  });
}
function rangeWhere(q) {
  const f = toDate(q.from), t = toDate(q.to || q.from);
  return f ? { where: 'orderDate BETWEEN ? AND ?', params: [f, t] } : { where: '', params: [] };
}

// order-wise summary
orders.get('/parts/orders', (req, res) => {
  try {
    const { where, params } = rangeWhere(req.query);
    const by = new Map();
    for (const l of lines(where, params)) {
      if (!by.has(l.poNo)) by.set(l.poNo, { poNo: l.poNo, orderDate: l.orderDate, days: l.days, orderSubtype: l.orderSubtype, supplier: l.supplier, orderStatus: l.orderStatus,
        lines: 0, orderQty: 0, billQty: 0, pendingLines: 0, rasteLines: 0, notBilledLines: 0, cancelLines: 0 });
      const o = by.get(l.poNo);
      o.lines++; o.orderQty = r3(o.orderQty + l.orderQty); o.billQty = r3(o.billQty + l.billQty);
      if (l.status === 'Cancel') o.cancelLines++;
      else if (l.status === 'Bill nahi hua') { o.notBilledLines++; o.pendingLines++; }
      else if (l.status === 'Adhoora') o.pendingLines++;
      else if (l.status === 'Raste me') o.rasteLines++;
    }
    const list = [...by.values()].map((o) => {
      const live = o.lines - o.cancelLines;
      o.status = live <= 0 ? 'Cancel'
        : o.notBilledLines === live ? 'Bill nahi hua'
        : o.pendingLines > 0 ? 'Adhoora'
        : o.rasteLines > 0 ? 'Raste me' : 'Poora bill';
      return o;
    }).sort((a, b) => (b.days ?? 0) - (a.days ?? 0));
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// lines: ?po=XXX (ek order)  |  ?pending=1 (saare baaki)  + from/to
orders.get('/parts/orders/lines', (req, res) => {
  try {
    const w = rangeWhere(req.query);
    const cond = [w.where].filter(Boolean), params = [...w.params];
    if (req.query.po) { cond.push('poNo = ?'); params.push(req.query.po); }
    let rows = lines(cond.join(' AND '), params);
    if (req.query.pending) rows = rows.filter((l) => l.status === 'Bill nahi hua' || l.status === 'Adhoora');
    if (req.query.status) rows = rows.filter((l) => l.status === req.query.status);
    const FF = fifoAll();
    rows = rows.map((l) => {
      const all = (FF.get(KEY(l.partNo))?.lots || []).filter((x) => x.poNo === l.poNo);
      const ls = all.filter((x) => !x.inMaster && x.grn);
      if (!ls.length) return { ...l, sold: null, left: null,
        sellNote: all.some((x) => !x.grn) ? 'Raste me (abhi aaya nahi)' : l.billQty > 0 ? 'Master se pehle aaya' : '' };
      const sold = r3(ls.reduce((t, x) => t + x.sold, 0)), left = r3(ls.reduce((t, x) => t + x.left, 0));
      const lying = Math.max(...ls.map((x) => x.daysLying ?? 0));
      const out = ls.filter((x) => x.soldOut).map((x) => x.soldOut).sort().pop();
      return { ...l, sold, left, sellNote: left <= 0 ? `Poora bika (${toDMY(out)})` : sold > 0 ? `${left} bacha · ${lying} din` : `Nahi bika · ${lying} din` };
    });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

orders.post('/parts/orders/sync', async (req, res) => {
  try {
    const { from, to } = req.body || {};
    const out = await pullReports(['parts_order'], from ? { from, to: to || from } : null);
    const st = out.results.parts_order;
    if (!out.ok) return res.status(502).json({ ok: false, error: out.errors.join(' | ') });
    res.json({ ok: true, count: st.rowsIn - st.skipped, replaced: st.replaced, warning: st.warning || null });
  } catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});

// ============================================================
//  PART-WISE: har part ke saare orders + backorder + aaj ka stock + FIFO "aaya to bika ya nahi"
//
//  FIFO (pehle aaya, pehle bika):
//    lot 1 = Master ka opening stock (snapshot date)
//    lot 2.. = har bill hui order line (invoice-wise), GRN date (warna invoice date) ke kram me — sirf snapshot ke BAAD wali
//              (snapshot se pehle aaya maal Master ke opening me pehle se shamil hai)
//    Snapshot ke baad ki saari sale (workshop + counter) pehle lot se ghatti hai, phir agle se.
//  Discontinue: part_alternates table (old -> new, haath se). Auto flag "Shayad band": 30+ din backorder,
//  2+ baar order, aaj tak ek bhi piece bill nahi.
// ============================================================
import { partsLive, latestSnap, afterSnap } from './stock.js';
import { soqLatestMap } from './soq.js';

const KEY = (s) => String(s || '').toUpperCase().replace(/[-\s.]/g, '');
const days = (iso) => (iso ? Math.floor((Date.now() - new Date(iso + 'T00:00:00').getTime()) / 864e5) : null);
function ensureAlt() {
  db().exec(`CREATE TABLE IF NOT EXISTS part_alternates (old_key TEXT PRIMARY KEY, old_part TEXT, new_part TEXT NOT NULL, note TEXT, created_at TEXT)`);
}


// ---------- FIFO (tareekh ke hisaab se) ----------
// Har part: lot = Master opening (snapshot date) + har bill hui order line invoice-wise (GRN date, warna invoice date).
// Sale (workshop + counter, snapshot ke baad) tareekh ke kram me: us din tak aa chuke sabse PURANE lot se ghatti hai.
// Har lot ke liye: kitna bika, kitna bacha, pehli sale kab, poora kab bika, kitne din me, abhi kitne din se pada.
export function fifoAll() {
  const d = db();
  const snap = latestSnap('parts');
  const out = new Map();
  if (!tableExists('parts_orders')) return out;
  const get = (k) => { if (!out.has(k)) out.set(k, { lots: [], unmatched: 0 }); return out.get(k); };
  const live = new Map(partsLive().rows.map((r) => [KEY(r.partNo), r]));
  for (const r of d.prepare(`SELECT partNo, poNo, invoiceNo, MAX(COALESCE(grnDate, invoiceDate)) dt, MAX(grnDate) grn, SUM(IFNULL(invoiceQty,0)) q
      FROM parts_orders WHERE IFNULL(invoiceQty,0) > 0 GROUP BY partNo, poNo, invoiceNo`).all()) {
    const inMaster = !!(snap && r.dt && r.dt <= snap.as_of);
    get(KEY(r.partNo)).lots.push({ poNo: r.poNo, invoiceNo: r.invoiceNo, dt: r.dt, grn: !!r.grn, q: r.q, sold: 0, left: inMaster ? 0 : r.q, firstSale: null, lastSale: null, inMaster });
  }
  const sales = new Map();
  if (tableExists('parts_sales')) {
    const w = afterSnap(snap, 't.src');
    for (const r of d.prepare(`SELECT partNo, date, SUM(IFNULL(t.qty,0)) q FROM parts_sales t WHERE ${w.sql} GROUP BY partNo, date ORDER BY date`).all(...w.params)) {
      const k = KEY(r.partNo); if (!out.has(k)) continue;
      if (!sales.has(k)) sales.set(k, []); sales.get(k).push(r);
    }
  }
  for (const [k, P] of out) {
    P.lots.sort((a, b) => String(a.dt).localeCompare(String(b.dt)));
    let opening = snap && live.get(k) ? Math.max(0, live.get(k).opening || 0) : 0;
    for (const s of (sales.get(k) || [])) {
      let q = s.q;
      const o = Math.min(q, opening); opening -= o; q -= o;                    // pehle Master ka purana stock
      for (const lt of P.lots) {
        if (q <= 0) break;
        if (lt.inMaster || !lt.grn || lt.left <= 0 || !lt.dt || lt.dt > s.date) continue;  // jo abhi aaya hi nahi (GRN nahi / baad me aaya), usse nahi bik sakta
        const t = Math.min(q, lt.left); lt.left -= t; lt.sold += t; q -= t;
        if (!lt.firstSale) lt.firstSale = s.date; lt.lastSale = s.date;
      }
      if (q > 0) P.unmatched += q;
    }
    for (const lt of P.lots) {
      lt.sold = r3(lt.sold); lt.left = r3(lt.left);
      lt.soldOut = !lt.inMaster && lt.left <= 0 ? lt.lastSale : null;
      lt.daysToSell = lt.soldOut && lt.dt ? Math.round((new Date(lt.soldOut) - new Date(lt.dt)) / 864e5) : null;
      lt.daysLying = !lt.inMaster && lt.grn && lt.left > 0 ? days(lt.dt) : null;
    }
  }
  return out;
}

function partWise(q) {
  if (!tableExists('parts_orders')) return { rows: [], summary: {} };
  ensureAlt();
  const d = db();
  const f = toDate(q.from), t = toDate(q.to || q.from);
  const snap = latestSnap('parts');
  // saari order lines (range filter baad me — FIFO ke liye poora itihaas chahiye)
  const allLines = lines();
  const inRange = (l) => { if (!f) return true; const iso = l.orderDate ? l.orderDate.split('/').reverse().join('-') : null; return iso && iso >= f && iso <= t; };
  const FF = fifoAll();
  const live = new Map(partsLive().rows.map((r) => [KEY(r.partNo), r]));
  const alts = new Map(d.prepare('SELECT * FROM part_alternates').all().map((a) => [a.old_key, a]));

  const byPart = new Map();
  for (const l of allLines) { const k = KEY(l.partNo); if (!byPart.has(k)) byPart.set(k, []); byPart.get(k).push(l); }

  const rows = [];
  for (const [k, pls] of byPart) {
    const shown = pls.filter(inRange);
    if (!shown.length) continue;
    const lv = live.get(k);
    const lotInfo = new Map();                           // poNo -> jod (us order ke saare invoice lots)
    for (const lt of (FF.get(k)?.lots || [])) {
      const x = lotInfo.get(lt.poNo) || { sold: 0, left: 0, leftSince: null };
      if (!lt.inMaster) { x.sold += lt.sold; x.left += lt.left; if (lt.left > 0 && (!x.leftSince || lt.dt < x.leftSince)) x.leftSince = lt.dt; }
      lotInfo.set(lt.poNo, x);
    }
    const orderQty = r3(shown.reduce((s, l) => s + l.orderQty, 0));
    const billQty = r3(shown.reduce((s, l) => s + l.billQty, 0));
    const backorder = r3(shown.filter((l) => l.status !== 'Cancel').reduce((s, l) => s + l.pending, 0));
    const pendingLines = shown.filter((l) => l.status === 'Adhoora' || l.status === 'Bill nahi hua');
    const oldestPendingDays = pendingLines.length ? Math.max(...pendingLines.map((l) => l.days ?? 0)) : null;
    const everBilled = pls.reduce((s, l) => s + l.billQty, 0);
    let unsold = 0, unsoldDays = null, soldAfter = 0;
    for (const l of shown) { const x = lotInfo.get(l.poNo); if (!x) continue; soldAfter += x.sold; unsold += x.left;
      if (x.left > 0 && x.leftSince) { const dd = days(x.leftSince); unsoldDays = Math.max(unsoldDays ?? 0, dd); } }
    const alt = alts.get(k);
    const altLive = alt ? live.get(KEY(alt.new_part)) : null;
    const maybeBand = !alt && backorder > 0 && (oldestPendingDays ?? 0) >= 30 && everBilled === 0 && pls.length >= 2;
    const stock = lv && snap ? lv.stock : null;   // Master (snapshot) ke bina stock ka pata nahi
    const icon = { 'Bill ho gaya': '✅', 'Raste me': '🚚', 'Adhoora': '🟡', 'Bill nahi hua': '🔴', 'Cancel': '⚪' };
    rows.push({
      partNo: pls[0].partNo, partDesc: pls.find((l) => l.partDesc)?.partDesc || lv?.desc || '',
      orderCount: shown.length, orderQty, billQty, backorder, oldestPendingDays,
      stock, soldAfter: r3(soldAfter), unsold: r3(unsold), unsoldDays,
      status: billQty <= 0 ? 'Bill nahi hua' : backorder > 0 ? 'Adhoora' : 'Bill hua',
      orders: shown.map((l) => `${l.poNo} ${icon[l.status] || ''} ${l.billQty}/${l.orderQty}`).join(' · '),
      altPart: alt?.new_part || '', altStock: altLive ? altLive.stock : (alt ? 0 : null),
      flags: [
        backorder > 0 ? 'backorder' : null,
        backorder > 0 && stock != null && stock <= 0 ? 'stock0' : null,   // stock pata ho tabhi (Master na ho to null)
        unsold > 0 && (unsoldDays ?? 0) >= 30 ? 'notSold' : null,
        maybeBand ? 'maybeBand' : null,
        (alt || maybeBand) && stock != null && stock > 0 ? 'sellOld' : null,
      ].filter(Boolean),
    });
  }
  rows.sort((a, b) => (b.flags.includes('stock0') - a.flags.includes('stock0')) || (b.backorder - a.backorder) || (b.unsold - a.unsold));
  const cnt = (fl) => rows.filter((r) => r.flags.includes(fl)).length;
  return { snapshot: snap ? toDMY(snap.as_of) : null, rows,
    summary: { parts: rows.length, backorder: cnt('backorder'), stock0: cnt('stock0'), notSold: cnt('notSold'), maybeBand: cnt('maybeBand'), sellOld: cnt('sellOld') } };
}

// ek part ki har order line + us line ka maal bika ya nahi
function partDetail(partNo) {
  const d = db();
  const k = KEY(partNo);
  const snap = latestSnap('parts');
  const pw = partWise({});
  const lots = new Map((fifoAll().get(k)?.lots || []).map((l) => [`${l.poNo}|${l.invoiceNo}`, l]));
  const rows = d.prepare(`SELECT poNo, orderDate, partNo, MAX(orderQty) orderQty, invoiceNo, MAX(invoiceDate) invoiceDate, SUM(IFNULL(invoiceQty,0)) invoiceQty,
      MAX(grnInvoiceNo) grnInvoiceNo, MAX(grnDate) grnDate
    FROM parts_orders WHERE REPLACE(REPLACE(REPLACE(UPPER(TRIM(partNo)),'-',''),' ',''),'.','') = ?
    GROUP BY poNo, invoiceNo ORDER BY orderDate, poNo, invoiceDate`).all(k);
  return { part: pw.rows.find((r) => KEY(r.partNo) === k) || { partNo }, snapshot: snap ? toDMY(snap.as_of) : null,
    rows: rows.map((r) => {
      const lt = lots.get(`${r.poNo}|${r.invoiceNo}`);
      let haal;
      if (!r.invoiceNo) haal = 'Backorder (bill baaki)';
      else if (!lt) haal = '—';
      else if (lt.inMaster) haal = 'Master se pehle aaya (opening me shamil)';
      else if (lt.left <= 0) haal = `Poora bika ${lt.daysToSell ?? '?'} din me`;
      else if (lt.sold > 0) haal = `${lt.left} bacha · ${lt.daysLying} din se`;
      else haal = `Ek bhi nahi bika · ${lt.daysLying} din se pada`;
      if (r.invoiceNo && !r.grnInvoiceNo) haal = 'Raste me (GRN baaki) — abhi aaya nahi';
      return { ...r, orderDate: toDMY(r.orderDate), invoiceDate: toDMY(r.invoiceDate), grnDate: toDMY(r.grnDate),
        sold: lt && !lt.inMaster && lt.grn ? lt.sold : null, left: lt && !lt.inMaster && lt.grn ? lt.left : null,
        firstSale: lt ? toDMY(lt.firstSale) : '', soldOut: lt ? toDMY(lt.soldOut) : '', haal };
    }) };
}

orders.get('/parts/orders/parts', (req, res) => { try { res.json(partWise(req.query)); } catch (e) { res.status(500).json({ error: e.message }); } });
orders.get('/parts/orders/parts/detail', (req, res) => { try { res.json(partDetail(req.query.partNo)); } catch (e) { res.status(500).json({ error: e.message }); } });
orders.post('/parts/alternates', (req, res) => {
  try {
    ensureAlt();
    const { oldPart, newPart, note = '' } = req.body || {};
    if (!oldPart) throw new Error('purana part number do');
    if (!newPart) { db().prepare('DELETE FROM part_alternates WHERE old_key=?').run(KEY(oldPart)); return res.json({ ok: true, removed: true }); }
    db().prepare(`INSERT INTO part_alternates (old_key, old_part, new_part, note, created_at) VALUES (?,?,?,?,?)
      ON CONFLICT(old_key) DO UPDATE SET new_part=excluded.new_part, note=excluded.note`).run(KEY(oldPart), oldPart, String(newPart).trim(), note, new Date().toISOString());
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
orders.get('/parts/alternates', (_req, res) => { ensureAlt(); res.json(db().prepare('SELECT * FROM part_alternates ORDER BY created_at DESC').all()); });

// ============================================================
//  PART TRACKING (seedha hisaab) — har part: kitna bill hua (order report se), pehla GRN kab,
//  uske baad kitna bika (sales data se), kitni baar bika, aakhri sale kab, chal raha hai ya nahi.
//    Running  : mahine me 4+ baar bikta hai (aur 60 din ke andar bika)
//    Dheema   : bikta hai par mahine me 4 se kam
//    Ruka hua : pehle bika, par 60+ din se ek bhi nahi
//    Nahi bika: aane ke baad ek bhi nahi
// ============================================================
function tracking(q) {
  if (!tableExists('parts_orders')) return { rows: [], summary: {} };
  const d = db();
  const f = toDate(q.from), t = toDate(q.to || q.from);
  const where = f ? 'AND orderDate BETWEEN ? AND ?' : '';
  const billed = d.prepare(`SELECT partNo, MAX(partDesc) partDesc, SUM(IFNULL(invoiceQty,0)) billQty,
      COUNT(DISTINCT poNo) orders, MIN(COALESCE(grnDate, invoiceDate)) firstIn, MAX(COALESCE(grnDate, invoiceDate)) lastIn
    FROM parts_orders WHERE IFNULL(invoiceQty,0) > 0 ${where} GROUP BY partNo`).all(...(f ? [f, t] : []));
  const ordered = new Map(d.prepare(`SELECT partNo, SUM(q) orderQty FROM (SELECT partNo, poNo, MAX(IFNULL(orderQty,0)) q FROM parts_orders WHERE 1=1 ${where} GROUP BY partNo, poNo) GROUP BY partNo`)
    .all(...(f ? [f, t] : [])).map((r) => [KEY(r.partNo), r.orderQty]));
  const snapT = latestSnap('parts');
  const live = new Map(snapT ? partsLive().rows.map((r) => [KEY(r.partNo), r]) : []);
  const hasS = tableExists('parts_sales');
  const saleQ = hasS ? d.prepare(`SELECT SUM(IFNULL(qty,0)) q, COUNT(DISTINCT invoiceNo) n, MAX(date) last,
      SUM(CASE WHEN src='counter' THEN IFNULL(qty,0) ELSE 0 END) cq, SUM(CASE WHEN src<>'counter' THEN IFNULL(qty,0) ELSE 0 END) wq
    FROM parts_sales WHERE REPLACE(REPLACE(REPLACE(UPPER(TRIM(partNo)),'-',''),' ',''),'.','') = ? AND date >= ?`) : null;
  const hero = soqLatestMap();   // Hero SOQ ka ABC/FMS/Movement (fetch kiya ho to)
  const rows = billed.map((b) => {
    const k = KEY(b.partNo);
    const h = hero.get(k);
    const s = saleQ && b.firstIn ? saleQ.get(k, b.firstIn) : { q: 0, n: 0, last: null, cq: 0, wq: 0 };
    const sold = r3(s.q || 0), times = s.n || 0;
    const sinceDays = Math.max(1, days(b.firstIn) ?? 1);
    const perMonth = Math.round((times / (sinceDays / 30)) * 10) / 10;
    const lastDays = s.last ? days(s.last) : null;
    const status = !times ? 'Nahi bika' : lastDays > 60 ? 'Ruka hua' : perMonth >= 4 ? 'Running' : 'Dheema';
    const lv = live.get(k);
    return { partNo: b.partNo, partDesc: b.partDesc || lv?.desc || '', orders: b.orders, orderQty: r3(ordered.get(k) || 0), billQty: r3(b.billQty),
      firstIn: toDMY(b.firstIn), lastIn: toDMY(b.lastIn), sold, workshop: r3(s.wq || 0), counter: r3(s.cq || 0), times, perMonth,
      lastSale: toDMY(s.last || ''), lastDays, left: r3(Math.max(0, b.billQty - sold)), stock: lv ? lv.stock : null, status,
      abc: h?.abc || '', fms: h?.fms || '', movA: h?.movA ?? '', movB: h?.movB ?? '', heroSoq: h ? h.soq : null };
  });
  const order = { 'Nahi bika': 0, 'Ruka hua': 1, 'Dheema': 2, 'Running': 3 };
  rows.sort((a, b) => order[a.status] - order[b.status] || b.left - a.left);
  const c = (st) => rows.filter((r) => r.status === st).length;
  return { hasSoq: hero.size > 0, rows, summary: { parts: rows.length, running: c('Running'), slow: c('Dheema'), stopped: c('Ruka hua'), never: c('Nahi bika') } };
}
orders.get('/parts/orders/tracking', (req, res) => { try { res.json(tracking(req.query)); } catch (e) { res.status(500).json({ error: e.message }); } });
