// ============================================================
//  ORDER GUIDE — Hero ka SOQ (Suggested Order Quantity) report
//  Roj update hota hai. Jab chaho "SOQ Fetch" -> PowerBI se poori list (date filter nahi).
//  Har fetch UPDATE DATE ke naam se rakha jaata hai (itihaas), screen pe latest.
//
//  Cross-check (hamare data se):
//    Stock farak : Hero ka "Stock In Hand" vs hamara stock usi din ka
//                  (hamara aaj ka live stock − UPDATE DATE ke baad aaya + UPDATE DATE ke baad gaya)
//                  Hero ka stock kis din ke band hone tak ka hai -> SOQ_STOCK_LAG (default 1 = update date se pichhla din)
//    PO farak    : Hero ka Pending+Backorder vs hamari PO report ka baaki; Hero ka GIT vs hamara "bill hua, GRN nahi"
// ============================================================
import { Router } from 'express';
import { db } from '../db/index.js';
import { tableExists } from '../db/engine.js';
import { toDMY } from '../db/types.js';
import { pullReports } from '../jobs/pull.js';
import { partsLive, latestSnap } from './stock.js';

export const soqApi = Router();
const r3 = (n) => (n == null ? null : Math.round(n * 1000) / 1000);
const KEY = (s) => String(s || '').toUpperCase().replace(/[-\s.]/g, '');
const PKSQL = (c) => `REPLACE(REPLACE(REPLACE(UPPER(TRIM(${c})),'-',''),' ',''),'.','')`;
const LAG = Number(process.env.SOQ_STOCK_LAG ?? 1);
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

export function soqDates() {
  if (!tableExists('parts_soq')) return [];
  return db().prepare(`SELECT updateDate d, COUNT(*) n, SUM(CASE WHEN IFNULL(soq,0)>0 THEN 1 ELSE 0 END) k FROM parts_soq GROUP BY updateDate ORDER BY updateDate DESC`).all();
}

// latest SOQ row per part (tracking card ke liye)
export function soqLatestMap() {
  const m = new Map();
  const dates = soqDates();
  if (!dates.length) return m;
  for (const r of db().prepare(`SELECT partNo, abc, fms, movA, movB, soq, dlp, moq1, lotSize FROM parts_soq WHERE updateDate = ?`).all(dates[0].d)) m.set(KEY(r.partNo), r);
  return m;
}

// hamara stock "asOf" din ke band hone par = live aaj − (asOf ke baad aaya) + (asOf ke baad gaya)
function ourStockAsOf(asOf) {
  if (!latestSnap('parts')) return null;
  const m = new Map(partsLive().rows.map((r) => [KEY(r.partNo), r.stock]));
  const d = db();
  if (tableExists('parts_purchase'))
    for (const r of d.prepare(`SELECT ${PKSQL('partNo')} k, SUM(IFNULL(qty,0)) q FROM parts_purchase WHERE date > ? GROUP BY k`).all(asOf))
      if (m.has(r.k)) m.set(r.k, m.get(r.k) - r.q);
  if (tableExists('parts_sales'))
    for (const r of d.prepare(`SELECT ${PKSQL('partNo')} k, SUM(IFNULL(qty,0)) q FROM parts_sales WHERE date > ? GROUP BY k`).all(asOf))
      if (m.has(r.k)) m.set(r.k, m.get(r.k) + r.q);
  return m;
}

// hamari PO report: har part ka baaki (order − bill, cancel chhod ke) + raste me (bill hua, GRN nahi)
export function ourPO() {
  const m = new Map();
  if (!tableExists('parts_orders')) return null;
  const d = db();
  for (const r of d.prepare(`SELECT k, SUM(MAX(0, oq - bq)) p FROM (
        SELECT ${PKSQL('partNo')} k, poNo, MAX(IFNULL(orderQty,0)) oq, SUM(IFNULL(invoiceQty,0)) bq, MAX(IFNULL(orderStatus,'')) st
        FROM parts_orders GROUP BY k, poNo) WHERE st NOT LIKE '%cancel%' GROUP BY k`).all())
    m.set(r.k, { pending: r.p || 0, git: 0 });
  for (const r of d.prepare(`SELECT ${PKSQL('partNo')} k, SUM(IFNULL(invoiceQty,0)) g FROM parts_orders
        WHERE IFNULL(invoiceNo,'')<>'' AND IFNULL(grnInvoiceNo,'')='' GROUP BY k`).all()) {
    const x = m.get(r.k) || { pending: 0, git: 0 }; x.git = r.g || 0; m.set(r.k, x);
  }
  const range = d.prepare(`SELECT MIN(orderDate) a, MAX(orderDate) b FROM parts_orders`).get();
  return { m, from: range.a, to: range.b };
}

function soqList(date) {
  const dates = soqDates();
  if (!dates.length) return { dates: [], rows: [], summary: {} };
  const ud = date && dates.some((x) => x.d === date) ? date : dates[0].d;
  const d = db();
  const raw = d.prepare(`SELECT * FROM parts_soq WHERE updateDate = ? ORDER BY IFNULL(soq,0) DESC, partNo`).all(ud);
  const asOf = addDays(ud, -LAG);
  const ours = ourStockAsOf(asOf);
  const po = ourPO();
  const run = d.prepare(`SELECT finished_at FROM sync_runs WHERE source='soq' AND status='ok' AND kind='pull' ORDER BY id DESC LIMIT 1`).get();

  const rows = raw.map((r) => {
    const k = KEY(r.partNo);
    const heroPend = (r.b2bPending || 0) + (r.b2bBackorder || 0);
    const ourStock = ours ? (ours.has(k) ? r3(ours.get(k)) : 0) : null;
    const p = po ? (po.m.get(k) || { pending: 0, git: 0 }) : null;
    const value = r.valueDlp ?? ((r.soq || 0) * (r.dlp || 0));
    const stockDiff = ourStock == null ? null : r3((r.stock || 0) - ourStock);
    const pendDiff = p ? r3(heroPend - p.pending) : null;
    const gitDiff = p ? r3((r.b2bGit || 0) - p.git) : null;
    const flags = [];
    if ((r.soq || 0) > 0) flags.push('order');
    if (stockDiff != null && Math.abs(stockDiff) >= 1) flags.push('stockDiff');
    if (p && (Math.abs(pendDiff) >= 1 || Math.abs(gitDiff) >= 1)) flags.push('poDiff');
    return {
      partNo: r.partNo, partDesc: r.partDesc || '', category: r.category || '', abc: r.abc || '', fms: r.fms || '', movA: r.movA ?? '', movB: r.movB ?? '',
      stock: r3(r.stock), ourStock, stockDiff, b2bPending: r3(r.b2bPending), b2bBackorder: r3(r.b2bBackorder), b2bGit: r3(r.b2bGit), ancBackorder: r3(r.ancBackorder),
      ourPending: p ? r3(p.pending) : null, ourGit: p ? r3(p.git) : null, pendDiff, gitDiff,
      avgDemand: r3(r.avgDemand), forecast: r3(r.forecast), safetyStock: r3(r.safetyStock), rop: r3(r.rop), maxStock: r3(r.maxStock),
      lotSize: r3(r.lotSize), moq1: r3(r.moq1), moq2: r3(r.moq2), leadDays: r.leadDays, transitDays: r.transitDays,
      soq: r3(r.soq), mrp: r.mrp, dlp: r.dlp, value: Math.round(value || 0), orderType: r.orderType || '', pg: r.pg || '', spg: r.spg || '', flags,
    };
  });
  const cnt = (f) => rows.filter((x) => x.flags.includes(f)).length;
  const by = (k) => { const o = {}; for (const x of rows) { const v = x[k] || '—'; o[v] = (o[v] || 0) + 1; } return o; };
  return {
    updateDate: toDMY(ud), dates: dates.map((x) => ({ d: x.d, label: toDMY(x.d), n: x.n, k: x.k })),
    fetchedAt: run?.finished_at || null, stockAsOf: toDMY(asOf), hasMaster: !!ours,
    poRange: po ? { from: toDMY(po.from), to: toDMY(po.to) } : null,
    rows,
    summary: { parts: rows.length, order: cnt('order'), value: rows.filter((x) => x.soq > 0).reduce((s, x) => s + x.value, 0),
      stockDiff: cnt('stockDiff'), poDiff: cnt('poDiff'), abc: by('abc'), fms: by('fms') },
  };
}

// ek part ka SOQ itihaas (har fetch)
function soqPart(partNo) {
  if (!tableExists('parts_soq')) return { rows: [] };
  const rows = db().prepare(`SELECT updateDate, stock, b2bPending, b2bBackorder, b2bGit, avgDemand, forecast, rop, maxStock, soq, abc, fms, movA, movB
    FROM parts_soq WHERE ${PKSQL('partNo')} = ? ORDER BY updateDate DESC`).all(KEY(partNo));
  return { rows: rows.map((r) => ({ ...r, updateDate: toDMY(r.updateDate) })) };
}

soqApi.get('/parts/soq', (req, res) => { try { res.json(soqList(req.query.date)); } catch (e) { res.status(500).json({ error: e.message }); } });
soqApi.get('/parts/soq/part', (req, res) => { try { res.json(soqPart(req.query.partNo)); } catch (e) { res.status(500).json({ error: e.message }); } });
soqApi.post('/parts/soq/sync', async (_req, res) => {
  try {
    const out = await pullReports(['soq'], null);          // date nahi — report kholo, export karo
    const st = out.results.soq;
    if (!out.ok) return res.status(502).json({ ok: false, error: out.errors.join(' | ') });
    const dates = soqDates();
    res.json({ ok: true, count: st.rowsIn - st.skipped, updateDate: dates[0] ? toDMY(dates[0].d) : null, newColumns: st.newColumns || [] });
  } catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});
