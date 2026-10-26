import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { tenant, auth } from './middleware.js';
import { latestSnapshot } from '../db/repo.js';
import { pullSaleToFile } from '../jobs/pullSale.js';
import { pullReports } from '../jobs/pull.js';
import { readTable, lastRun, tableExists } from '../db/engine.js';
import { toDate, toDMY } from '../db/types.js';
import { db, q } from '../db/index.js';
import { SOURCES, source } from '../sources/index.js';
import { renderPdf } from './exportPdf.js';
import { stock } from './stock.js';
import { orders } from './orders.js';
import { soqApi } from './soq.js';
import { guideApi } from './guide.js';
import { focusApi } from './focus.js';
import { khaataApi } from './khaata.js';
import { sarApi } from './sar.js';
import { whatsappApi } from './whatsapp.js';
import { billingApi } from './billing.js';
import { afterSaleApi } from './afterSale.js';
import { SERVICE_TYPES, DEFAULT_TYPE } from '../config/serviceTypes.js';
import { claims } from './claims.js';
import { pullServiceInvoices } from '../jobs/pullService.js';
import { status as syncStatus, startCatchup, autoSyncConfig, setAutoSync } from '../jobs/catchup.js';
import { listCreds, saveCreds, getSetting, setSetting } from '../config/creds.js';

export const api = Router();
api.use(auth, tenant);

// CORS (taaki file:// se bhi UI data le sake) + error -> JSON
const h = (fn) => (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  return fn(req, res).catch(e => res.status(503).json({ ok: false, error: e.message }));
};

// ============================================================
//  READ — DB se. ?from=dd/mm/yyyy&to=dd/mm/yyyy diya to sirf utne din ka.
//  Shape wahi jo pehle JSON me tha (dates dd/mm/yyyy).
// ============================================================
function rangeWhere(req, dateCol) {
  const f = toDate(req.query.from), t = toDate(req.query.to || req.query.from);
  if (!f || !dateCol) return { where: '', params: [] };
  return { where: `${q(dateCol)} BETWEEN ? AND ?`, params: [f, t] };
}
const rowsOf = (req, table, dateCol, order) => readTable(SOURCES, table, { ...rangeWhere(req, dateCol), order });
const pulledAt = (names) => lastRun(names)?.finished_at || null;
function sumOf(req, table, col, dateCol, extraWhere = '') {
  if (!tableExists(table)) return { n: 0, s: 0 };
  const r = rangeWhere(req, dateCol);
  const w = [r.where, extraWhere].filter(Boolean).join(' AND ');
  return db().prepare(`SELECT COUNT(*) n, IFNULL(SUM(${q(col)}),0) s FROM ${q(table)} ${w ? 'WHERE ' + w : ''}`).get(...r.params);
}

// ============================================================
//  SYNC — PowerBI se pull -> DB. Body: { from, to } (dd/mm/yyyy)
// ============================================================
const rangeOf = (req) => { const { from, to } = req.body || {}; return from ? { from, to: to || from } : null; };
const fail = (res, out) => res.status(502).json({ ok: false, error: out.errors.join(' | '), warning: out.warnings.join(' | ') || null, results: out.results });
const got = (st) => (st && !st.error ? st.rowsIn - st.skipped : 0);

// ---- DMS Sale (Siebel) — aaj ka temp sync (purana flow, JSON file) ----
const readJson = (name) => {
  const p = path.resolve('data', name);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
};
api.get('/sale', h(async (req, res) => {
  const f = readJson('sale-today.json');
  if (f && Array.isArray(f.rows)) return res.json(f.rows);
  try { return res.json(await latestSnapshot(req.dealerId, 'sale')); }
  catch { return res.json([]); }
}));
api.get('/sale/summary', h(async (_req, res) => {
  const f = readJson('sale-today.json');
  res.json(f ? { count: f.count, totalAmount: f.totalAmount, pulledAt: f.pulledAt } : { count: 0, totalAmount: 0 });
}));
api.post('/sale/clear', h(async (_req, res) => {
  const empty = { pulledAt: null, source: 'hero_dms', count: 0, totalAmount: 0, rows: [] };
  fs.writeFileSync(path.resolve('data', 'sale-today.json'), JSON.stringify(empty, null, 2));
  res.json({ ok: true });
}));
api.post('/sync', h(async (_req, res) => {
  const out = await pullSaleToFile();
  res.json({ ok: true, count: out.count, totalAmount: out.totalAmount, pulledAt: out.pulledAt, note: out.note || null });
}));

// ---- VSR ----
api.post('/vsr/sync', h(async (req, res) => {
  const range = rangeOf(req);
  const out = await pullReports(['vsr'], range);
  if (!out.ok) return fail(res, out);
  const st = out.results.vsr;
  const r = { query: range ? { from: range.from, to: range.to } : {} };
  res.json({ ok: true, count: got(st), added: st.added, updated: st.updated, totalAmount: sumOf(r, 'vehicle_sales', 'amount', 'invoiceDate').s,
    pulledAt: new Date().toISOString(), range, warning: st.warning, newColumns: st.newColumns });
}));
api.get('/vsr', h(async (req, res) => res.json(rowsOf(req, 'vehicle_sales', 'invoiceDate', 'invoiceDate, invoiceNo'))));
api.get('/vsr/summary', h(async (req, res) => {
  const t = sumOf(req, 'vehicle_sales', 'amount', 'invoiceDate', `IFNULL(status,'') NOT LIKE '%cancel%'`);
  res.json({ count: t.n, totalAmount: t.s, pulledAt: pulledAt('vsr') });
}));

// ---- ENQUIRY ----
api.post('/enquiry/sync', h(async (req, res) => {
  const range = rangeOf(req);
  const out = await pullReports(['enquiry'], range);
  if (!out.ok) return fail(res, out);
  const st = out.results.enquiry;
  res.json({ ok: true, count: got(st), added: st.added, updated: st.updated, pulledAt: new Date().toISOString(), range, warning: st.warning });
}));
api.get('/enquiry', h(async (req, res) => res.json(rowsOf(req, 'enquiries', 'date', 'date, enquiryNo'))));
api.get('/enquiry/summary', h(async (req, res) => {
  res.json({ count: sumOf(req, 'enquiries', 'followups', 'date').n, pulledAt: pulledAt('enquiry') });
}));

// ---- VEHICLE PURCHASE ----
api.post('/purchase/sync', h(async (req, res) => {
  const range = rangeOf(req);
  const out = await pullReports(['purchase'], range);
  if (!out.ok) return fail(res, out);
  const st = out.results.purchase;
  res.json({ ok: true, count: got(st), added: st.added, updated: st.updated, pulledAt: new Date().toISOString(), range, warning: st.warning,
    totalValue: sumOf({ query: range || {} }, 'vehicle_purchase', 'rate', 'invoiceDate').s });
}));
api.get('/purchase', h(async (req, res) => res.json(rowsOf(req, 'vehicle_purchase', 'invoiceDate', 'stockInDate, invoiceNo'))));
api.get('/purchase/summary', h(async (req, res) => {
  const t = sumOf(req, 'vehicle_purchase', 'rate', 'invoiceDate');   // rate = per gaadi; invoiceValue sum mat karna
  res.json({ count: t.n, totalValue: t.s, pulledAt: pulledAt('purchase') });
}));

// ---- PARTS ----
api.post('/parts/sync', h(async (req, res) => {
  const range = rangeOf(req);
  const out = await pullReports(['parts_service', 'parts_counter'], range);
  const s = out.results.parts_service, c = out.results.parts_counter;
  if (!out.ok && !got(s) && !got(c)) return fail(res, out);
  res.json({ ok: true, count: got(s) + got(c), serviceCount: got(s), counterCount: got(c), pulledAt: new Date().toISOString(), range,
    warning: [...out.warnings, ...out.errors].join(' | ') || null });
}));
api.post('/parts/purchase/sync', h(async (req, res) => {
  const range = rangeOf(req);
  const out = await pullReports(['parts_purchase'], range);
  if (!out.ok) return fail(res, out);
  const st = out.results.parts_purchase;
  res.json({ ok: true, count: got(st), pulledAt: new Date().toISOString(), range, warning: st.warning });
}));
api.get('/parts/sales', h(async (req, res) => res.json(rowsOf(req, 'parts_sales', 'date', 'date, invoiceNo, _id'))));
api.get('/parts/purchase', h(async (req, res) => res.json(rowsOf(req, 'parts_purchase', 'date', 'date, invoiceNo, _id'))));

// ---- SERVICE: JobCard Invoices (Hero Connect / Siebel) ----
api.post('/service/sync', h(async (req, res) => {
  const range = rangeOf(req); if (!range) throw new Error('From/To date do');
  const st = await pullServiceInvoices(range);
  res.json({ ok: true, count: got(st), added: st.added, updated: st.updated, empty: !!st.empty, range });
}));
// ---- FSC VIN-wise tracking (PowerBI snapshot) ----
// har VIN: Max FSC Count eligible, jitni claimed date hai wo availed; baaki yet-to-avail.
// yet-to-avail me: expiry nikli = nikal gayi (missed), warna abhi avail ho sakti (open)
api.get('/service/fsc-vin', h(async (_req, res) => {
  if (!tableExists('fsc_vin')) return res.json({ rows: [], summary: {}, byFsc: [], byDue: [], months: [], pulledAt: null });
  const d = db();
  const all = d.prepare('SELECT * FROM fsc_vin').all();
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const R = ['I', 'II', 'III', 'IV', 'V'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monKey = (ymd) => (ymd && /^\d{4}-\d{2}/.test(ymd)) ? ymd.slice(0, 7) : '';
  const monLbl = (k) => k ? `${MON[+k.slice(5, 7) - 1]} ${k.slice(0, 4)}` : '';
  let totalElig = 0, totalAvail = 0, totalOpen = 0, totalMissed = 0;
  const perN = R.map(() => ({ elig: 0, avail: 0, open: 0, missed: 0 }));
  const rows = all.map((v) => {
    const max = Math.max(0, Math.min(5, Math.round(v.maxFsc || 0)));
    let avail = 0, open = 0, missed = 0, dueNum = 0, dueExp = '';
    for (let i = 1; i <= max; i++) {
      const claimed = v['fsc' + i], exp = v['fsc' + i + 'Exp'];
      perN[i - 1].elig++;
      if (claimed) { avail++; perN[i - 1].avail++; }
      else if (exp && exp < today) { missed++; perN[i - 1].missed++; }
      else { open++; perN[i - 1].open++; if (!dueNum) { dueNum = i; dueExp = exp || ''; } }   // sabse pehli jo abhi avail ho sakti = due
    }
    totalElig += max; totalAvail += avail; totalOpen += open; totalMissed += missed;
    const dueLabel = dueNum ? `FSC ${R[dueNum - 1]} due` : (max && avail >= max ? 'Saari ho gayi' : missed ? 'Sab nikal gayi' : '—');
    return { asset: v.asset, model: v.model, customer: v.customer, mobile: v.mobile, max, avail, open, missed,
      pct: max ? Math.round(avail / max * 100) : 0,
      dueNum, due: dueLabel, dueExp: toDMY(dueExp), dueExpYmd: dueExp || '', dueMonth: monKey(dueExp), dueMonthLabel: monLbl(monKey(dueExp)),
      warrantyStart: toDMY(v.warrantyStart || ''), paidAmc: v.paidAmc || '' };
  });
  // FSC I due .. V due (sorted I->V), + months (expiry) for filter
  const byDue = R.map((n, i) => ({ dueNum: i + 1, label: `FSC ${n} due`, n: rows.filter((r) => r.dueNum === i + 1).length }));
  const mset = {}; for (const r of rows) if (r.dueNum && r.dueMonth) mset[r.dueMonth] = (mset[r.dueMonth] || 0) + 1;
  const months = Object.keys(mset).sort().map((k) => ({ key: k, label: monLbl(k), n: mset[k] }));
  res.json({
    rows, pulledAt: (lastRun('fsc_vin') || {}).finished_at || null,
    byFsc: R.map((n, i) => ({ fsc: 'FSC ' + n, ...perN[i], pct: perN[i].elig ? Math.round(perN[i].avail / perN[i].elig * 100) : 0 })),
    byDue, months,
    summary: { vehicles: all.length, eligible: totalElig, availed: totalAvail, open: totalOpen, missed: totalMissed,
      pct: totalElig ? Math.round(totalAvail / totalElig * 100) : 0, dueVehicles: rows.filter((r) => r.dueNum > 0).length },
  });
}));

// ---- Paid VIN-wise tracking (PowerBI snapshot) ----
api.get('/service/paid-vin', h(async (_req, res) => {
  if (!tableExists('paid_vin')) return res.json({ rows: [], summary: {}, byDue: [], pulledAt: null });
  const d = db();
  // sirf wo gaadi jinka Due Service Type hai (blank "—" wali, jinme koi paid due nahi, count/list me nahi aayengi)
  const all = d.prepare('SELECT * FROM paid_vin').all().filter((v) => { const t = String(v.dueType || '').trim(); return t && t !== '-'; });
  // "Due Service Type" khud state batata hai: Availed / Yet To Avail / Expired  +  1st/2nd/3rd
  const parseDue = (s) => {
    const t = String(s || '').trim();
    const state = /^availed/i.test(t) ? 'availed' : /yet\s*to\s*avail/i.test(t) ? 'yet' : /^expired/i.test(t) ? 'expired' : '';
    const num = /\b1st\b|\bfirst\b/i.test(t) ? 1 : /\b2nd\b|\bsecond\b/i.test(t) ? 2 : /\b3rd\b|\bthird\b/i.test(t) ? 3 : 0;
    return { state, num };
  };
  const rows = all.map((v) => {
    const p = parseDue(v.dueType);
    return { asset: v.asset, model: v.model, customer: v.customer, mobile: v.mobile,
      saleDate: toDMY(v.saleDate || ''), paid1: toDMY(v.paid1 || ''), paid2: toDMY(v.paid2 || ''), paid3: toDMY(v.paid3 || ''),
      count: [v.paid1, v.paid2, v.paid3].filter(Boolean).length, status: v.status || '', due: v.dueType || '',
      state: p.state, num: p.num };
  });
  const cnt = (st) => rows.filter((r) => r.state === st).length;
  const byDue = {}; for (const r of rows) { const k = r.due || '—'; byDue[k] = (byDue[k] || 0) + 1; }
  res.json({
    rows, pulledAt: (lastRun('paid_vin') || {}).finished_at || null,
    byDue: Object.entries(byDue).map(([due, n]) => ({ due, n })).sort((a, b) => b.n - a.n),
    summary: { vehicles: all.length, yet: cnt('yet'), availed: cnt('availed'), expired: cnt('expired'),
      paid1: rows.filter((r) => r.paid1).length, paid2: rows.filter((r) => r.paid2).length, paid3: rows.filter((r) => r.paid3).length },
  });
}));

// ---- PowerBI se seedha laao (snapshot — date range nahi) ----
api.post('/service/fsc-vin/sync', h(async (_req, res) => {
  const out = await pullReports(['fsc_vin'], null);
  const r = out.results?.fsc_vin || {};
  if (r.error) throw new Error(r.error);
  res.json({ ok: true, rows: (r.added || 0) + (r.updated || 0) + (r.replaced || 0), st: r });
}));
api.post('/service/paid-vin/sync', h(async (_req, res) => {
  const out = await pullReports(['paid_vin'], null);
  const r = out.results?.paid_vin || {};
  if (r.error) throw new Error(r.error);
  res.json({ ok: true, rows: (r.added || 0) + (r.updated || 0) + (r.replaced || 0), st: r });
}));

// ---- VIN / gaadi-number se model (Where-to-use confirmation ke liye) ----
// jo bhi mile — VIN (chassis) ya registration number — usse gaadi ka model.
// Source: service_jobcards (assetNo=VIN, rcNo=reg), vehicle_sales, fsc_vin, paid_vin.
api.get('/vehicle/model', h(async (req, res) => {
  const raw = String(req.query.q || req.query.vin || '').trim();
  const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const Q = norm(raw);
  if (Q.length < 4) return res.json({ found: false, error: 'VIN ya gaadi number daalo' });
  const d = db();
  const rows = [];
  const grab = (sql, map) => { try { for (const r of d.prepare(sql).all()) { const m = map(r); if (m && (m.vin || m.reg)) rows.push(m); } } catch (e) {} };
  grab('SELECT assetNo, rcNo, model FROM service_jobcards', (r) => ({ vin: r.assetNo, reg: r.rcNo, model: r.model }));
  grab('SELECT vin, model FROM vehicle_sales', (r) => ({ vin: r.vin, reg: '', model: r.model }));
  grab('SELECT asset, model, customer FROM fsc_vin', (r) => ({ vin: r.asset, reg: '', model: r.model, customer: r.customer }));
  grab('SELECT asset, model, customer FROM paid_vin', (r) => ({ vin: r.asset, reg: '', model: r.model, customer: r.customer }));
  const pick = (test) => rows.find((r) => test(norm(r.vin), norm(r.reg)));
  let hit = pick((v, g) => (v && v === Q) || (g && g === Q))                       // exact VIN ya reg
         || pick((v, g) => (v && Q.length >= 8 && v.endsWith(Q)) || (g && g.endsWith(Q)))   // end match
         || pick((v, g) => (v && v.includes(Q)) || (g && g.includes(Q)));          // andar kahin
  if (!hit || !hit.model) return res.json({ found: false, q: raw });
  res.json({ found: true, q: raw, vin: hit.vin || '', reg: hit.reg || '', model: hit.model, customer: hit.customer || '' });
}));

api.get('/service/invoices', h(async (req, res) => {
  if (!tableExists('service_invoices')) return res.json({ rows: [], summary: {}, pulledAt: null });
  const rows = rowsOf(req, 'service_invoices', 'invoiceDate', 'invoiceDate DESC, invoiceNo DESC');
  const isCancel = (r) => /cancel/i.test(r.status || '') || !!r.cancelDate;
  // ---- SERVICE TYPE: labour (JOB) lines se — rules: src/config/serviceTypes.js (code ya naam)
  const PKn = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const jobs = new Map();
  if (tableExists('service_jobs')) for (const j of db().prepare('SELECT invoiceNo, jobCode, jobName FROM service_jobs').all()) {
    const k = PKn(j.invoiceNo); if (!jobs.has(k)) jobs.set(k, []); jobs.get(k).push({ code: String(j.jobCode || '').trim().toUpperCase(), name: String(j.jobName || '') });
  }
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
  const RULES = SERVICE_TYPES.map((t) => ({ type: t.type, codes: (t.codes || []).map((c) => String(c).trim().toUpperCase()),
    names: (t.names || []).map((w) => new RegExp('(^|[^A-Z0-9])' + esc(String(w).toUpperCase()) + '(?![A-Z0-9])')) }));
  // PowerBI JobCards (job lines + supervisor/odometer/model) — Job Card Number se
  const jcs = new Map();
  if (tableExists('service_jobcards')) for (const j of db().prepare('SELECT * FROM service_jobcards').all()) {
    const k = PKn(j.jobCardNo); let x = jcs.get(k);
    if (!x) jcs.set(k, x = { info: j, lines: [] });
    x.lines.push({ code: String(j.jobCode || '').trim().toUpperCase(), name: String(j.jobDesc || '') + (j.nature ? ' | ' + j.nature : '') });
  }
  const dd = (a, b) => (a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 864e5) : null);
  const jobsOf = (r) => [...[r.invoiceNo, r.jobInvNo, r.partsInvNo].flatMap((x) => (x && jobs.get(PKn(x))) || []), ...((r.jobCardNo && jcs.get(PKn(r.jobCardNo))?.lines) || [])];
  const svType = (r) => {
    const js = jobsOf(r);
    for (const R of RULES) if (js.some((j) => R.codes.includes(j.code) || R.names.some((re) => re.test(j.name.toUpperCase())))) return R.type;
    if (r.insuranceCo || Number(r.insuranceAmt) > 0) return 'Accidental';
    return js.length ? DEFAULT_TYPE : '— (labour data nahi)';
  };
  for (const r of rows) {
    const J = r.jobCardNo && jcs.get(PKn(r.jobCardNo));
    if (J) { const i = J.info; Object.assign(r, { supervisor: i.supervisor, odometer: i.odometer, model: i.model, rcNo: i.rcNo, assetNo: i.assetNo, saleDate: toDMY(i.saleDate), nature: i.nature,
      openDate: toDMY(i.openDate), closeDate: toDMY(i.closeDate), billable: i.billable, daysIn: dd(i.openDate, i.closeDate || i.completeDate) }); }
  }
  for (const r of rows) { r.serviceType = svType(r); r.jobNames = jobsOf(r).map((j) => (j.code ? j.code + ' ' : '') + j.name).join(', '); }
  const live = rows.filter((r) => !isCancel(r));
  const n = (v) => Number(v) || 0;
  const lab = (r) => n(r.labourTotal), prt = (r) => n(r.partsTotal), oil = (r) => n(r.oilTotal);
  const tot = (r) => n(r.total) || lab(r) + prt(r) + oil(r);            // "Total" column; na ho to jod
  const grp = (keyFn) => {
    const m = {};
    for (const r of live) {
      const k = (keyFn(r) || '').trim() || '—';
      const x = m[k] || (m[k] = { name: k, n: 0, jc: new Set(), labour: 0, parts: 0, oil: 0, total: 0 });
      x.n++; if (r.jobCardNo) x.jc.add(r.jobCardNo); x.labour += lab(r); x.parts += prt(r); x.oil += oil(r); x.total += tot(r);
    }
    return Object.values(m).map((x) => ({ ...x, jc: x.jc.size || x.n })).sort((a, b) => b.total - a.total);
  };
  const cash = live.filter((r) => /cash/i.test(r.invoiceType || ''));
  const credit = live.filter((r) => !/cash/i.test(r.invoiceType || ''));
  const S = (l) => ({ n: l.length, total: l.reduce((s, r) => s + tot(r), 0) });
  const STORD = (n) => { const o = [...SERVICE_TYPES.map((t) => t.type).filter((t) => t !== 'Accidental'), DEFAULT_TYPE, 'Accidental']; const i = o.indexOf(n); return i < 0 ? 99 : i; };
  const has = (k) => live.some((r) => r[k] != null && r[k] !== '');       // column DB me aaya ya nahi (naya sync chahiye?)
  res.json({ rows, pulledAt: pulledAt('service_invoice'),
    types: grp((r) => r.invoiceType).map((x) => ({ ...x, type: x.name })),
    technicians: has('technician') ? grp((r) => r.technician) : null,
    campaigns: has('campaign') ? grp((r) => r.campaign).filter((x) => x.name !== '—') : null,
    serviceTypes: grp((r) => r.serviceType).sort((a, b) => STORD(a.name) - STORD(b.name)),
    techTypes: has('technician') ? (() => { const m = {}; for (const r of live) { const k = (r.technician || '').trim() || '—'; const x = m[k] || (m[k] = { tech: k, total: 0, t: {} }); x.t[r.serviceType] = (x.t[r.serviceType] || 0) + 1; x.total++; } return Object.values(m).sort((a, b) => b.total - a.total); })() : null,
    jobsLoaded: jobs.size > 0 || jcs.size > 0, jcLoaded: jcs.size > 0,
    supervisors: live.some((r) => r.supervisor) ? grp((r) => r.supervisor) : null,
    cols: { technician: has('technician'), oil: has('oilTotal'), total: has('total'), vin: has('vin') },
    summary: {
      invoices: live.length, cancelled: rows.length - live.length, jobCards: new Set(live.map((r) => r.jobCardNo)).size,
      labour: live.reduce((s, r) => s + lab(r), 0), parts: live.reduce((s, r) => s + prt(r), 0), oil: live.reduce((s, r) => s + oil(r), 0),
      total: live.reduce((s, r) => s + tot(r), 0),
      cash: S(cash), credit: S(credit),
    } });
}));

// ---- Kisi bhi report ka generic sync (naye reports ke liye — route likhne ki zaroorat nahi) ----
// POST /api/pull { sources:['vsr','enquiry'], from, to }
api.post('/pull', h(async (req, res) => {
  const names = [].concat(req.body?.sources || []);
  if (!names.length) return res.status(400).json({ ok: false, error: 'sources do' });
  names.forEach((n) => { if (!source(n).report) throw new Error(`${n} ka DMS report nahi (upload wala master hai)`); });
  const out = await pullReports(names, rangeOf(req));
  res.status(out.ok ? 200 : 502).json(out);
}));

// ---- AUTO CATCH-UP: app khulte hi aakhri sync se aaj tak, sab reports queue me (background) ----
api.get('/sync/status', h(async (_req, res) => res.json(syncStatus())));
api.post('/sync/catchup', h(async (req, res) => res.json({ ok: true, job: startCatchup({ force: !!req.body?.force, only: req.body?.only || null, ranges: req.body?.ranges || null }) })));
// ---- ⚙ Sync Settings: login ID/password (alag secure DB) + subah ka auto sync ----
api.get('/settings/sync', h(async (_req, res) => res.json({ creds: listCreds(), auto: autoSyncConfig(), showBrowser: getSetting('showBrowser', '0') === '1' })));
api.post('/settings/browser', h(async (req, res) => { setSetting('showBrowser', req.body?.on ? '1' : '0'); res.json({ ok: true, showBrowser: !!req.body?.on }); }));
api.post('/settings/creds', h(async (req, res) => {
  const { key, user, pass } = req.body || {};
  if (!user) throw new Error('ID khaali nahi ho sakti');
  saveCreds(key, user, pass || null);
  res.json({ ok: true, creds: listCreds() });
}));
api.post('/settings/auto', h(async (req, res) => res.json({ ok: true, auto: setAutoSync(req.body || {}) })));

// ---- Master upload + live stock (parts / vehicle) ----
api.use(stock);
api.use(orders);   // parts purchase order tracking
api.use(soqApi);   // order guide (Hero SOQ)
api.use(guideApi); // order guide (hamara — 6 mahine ki bikri se)
api.use(afterSaleApi); // automation → insurance + RTO (bill ho chuki gaadi)
api.use(billingApi); // automation → billing (pending enquiry, VIN, paisa)
api.use(focusApi); // focus parts (Hero FPG) — target vs workshop, mechanic-wise
api.use(khaataApi); // party statement (vehicle / parts purchase) + DMS bill milaan
sarApi(api);        // Workshop SAR (Service Absorption Ratio) — P&L: auto revenue + manual kharche
api.use(whatsappApi); // WhatsApp reminders — TTS voice note
api.use(claims);   // warranty + FSC credit note (portal .xls upload)

// ---- PDF export (koi bhi report) ----
api.post('/export/pdf', h(async (req, res) => {
  const pdf = await renderPdf(req.body || {});
  const name = String(req.body?.filename || req.body?.title || 'report').replace(/[^\w.-]+/g, '_').slice(0, 120);
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${name}.pdf"`);
  res.end(Buffer.from(pdf));
}));

// ---- DB health ----
api.get('/db/status', h(async (req, res) => {
  const tables = [...new Set(SOURCES.map((s) => s.table))].map((t) => ({ table: t, rows: sumOf({ query: {} }, t, '_id').n }));
  const runs = db().prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 30').all();
  res.json({ tables, runs });
}));

api.get('/dashboard', h(async (_req, res) => res.json({ ok: true })));
api.get('/service', h(async (req, res) => { try { res.json(await latestSnapshot(req.dealerId, 'service')); } catch { res.json([]); } }));
api.get('/parts',   h(async (req, res) => { try { res.json(await latestSnapshot(req.dealerId, 'part_stock')); } catch { res.json([]); } }));
api.get('/misc/warranty', h(async (req, res) => { try { res.json(await latestSnapshot(req.dealerId, 'warranty')); } catch { res.json([]); } }));
api.get('/misc/fsc',      h(async (req, res) => { try { res.json(await latestSnapshot(req.dealerId, 'fsc')); } catch { res.json([]); } }));