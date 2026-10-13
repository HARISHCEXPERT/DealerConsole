// ============================================================
//  AUTO CATCH-UP SYNC — app khulte hi: har report ki aakhri safal sync se aaj tak ka data, ek queue me.
//
//  Har report ki range:
//    from = aakhri safal sync ki "To" date − 1 din (thoda overlap, taaki us din baad me aaye bill na chhooten;
//           replace/upsert ki wajah se double nahi hota)
//    to   = aaj
//    Pehli baar (koi sync nahi) -> is mahine ki 1 tareekh se
//    1 saal se purana -> aaj − 365 din se (baaki mahine-wise haath se)
//  Parts Order (PO): hamesha pichhle 90 din (order date) — purane order baad me bill hote hain (backorder)
//  Jo report AAJ safal sync ho chuki -> app kholne pe dobara nahi (din me ek baar). "Sync now" = zabardasti dobara
//  Ek login, reports ek ke baad ek. Tab tak UI purana data dikhata rahe.
// ============================================================
import { db } from '../db/index.js';
import { toDMY } from '../db/types.js';
import { source } from '../sources/index.js';
import { pullReports, pullBusy } from './pull.js';
import { log, err } from '../utils/logger.js';
import fs from 'node:fs';
import { env } from '../config/env.js';
import { pullPortal } from '../scrapers/warrantyPortal/portal.js';
import { importRows, rowsFromBuffer } from '../api/claims.js';
import { pullServiceInvoices } from './pullService.js';
import { getSetting, setSetting } from '../config/creds.js';

// Hero SSP portal (Warranty/FSC) bhi Quick Sync me — aakhri sync se aage (pehli baar pichhle PORTAL_DAYS din)
const PORTAL = [
  { name: 'wpp_fsc', kind: 'fsc', label: 'Portal — Free Service (FSC)' },
  { name: 'wpp_warranty', kind: 'warranty', label: 'Portal — Warranty Claim Status' },
  { name: 'wpp_dcr', kind: 'dcr', label: 'Portal — Warranty Claim Report' },
  { name: 'wpp_stmt', kind: 'stmt', label: 'Portal — Account Statement' },
];
const PORTAL_DAYS = Number(process.env.CATCHUP_PORTAL_DAYS || 180);
const portalOn = () => !!(env.warranty.user && env.warranty.pass);
const serviceOn = () => !!(env.dmsService.user && env.dmsService.pass);
function logRun(name, range, st) {
  db().prepare(`INSERT INTO sync_runs (source, kind, started_at, finished_at, status, range_from, range_to, rows_in, error) VALUES (?, 'pull', ?, ?, ?, ?, ?, ?, ?)`)
    .run(name, st.startedAt || new Date().toISOString(), new Date().toISOString(), st.error ? 'error' : 'ok', range.fromIso, range.toIso, st.rows || 0, st.error || null);
}

// queue ka kram (pehle parts — stock/guide inpe chalta hai)
export const QUEUE = ['parts_service', 'parts_counter', 'parts_purchase', 'parts_order', 'vsr', 'purchase', 'enquiry'];
// auto (app khulne pe) din me EK baar: aaj ki safal sync ho chuki to dobara nahi. Din me dobara chahiye to "Sync now" (force).
// .env CATCHUP_FRESH_HOURS=6 daalo to har 6 ghante baad bhi auto chalega (0 = sirf din me ek baar)
const FRESH_HOURS = Number(process.env.CATCHUP_FRESH_HOURS || 0);
const PO_DAYS = Number(process.env.CATCHUP_PO_DAYS || 90);

const todayIso = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

let job = null;   // { running, startedAt, finishedAt, steps: [{name,label,from,to,status,rows,error}] }

function lastOk(name) {
  // sabse aage tak ki safal sync (purana mahina baad me bhara ho to bhi aakhri date wahi jo sabse aage hai)
  const d = db();
  const top = d.prepare(`SELECT MAX(range_to) t FROM sync_runs WHERE source = ? AND kind IN ('pull','import') AND status = 'ok'`).get(name)?.t;
  const last = d.prepare(`SELECT finished_at, range_from, range_to, rows_in FROM sync_runs
    WHERE source = ? AND kind IN ('pull','import') AND status = 'ok' ORDER BY ${top ? '(range_to = ?) DESC,' : ''} id DESC LIMIT 1`).get(...(top ? [name, top] : [name]));
  if (!last) return null;
  const lastAt = d.prepare(`SELECT MAX(finished_at) f FROM sync_runs WHERE source = ? AND kind = 'pull' AND status = 'ok'`).get(name)?.f;
  return { ...last, finished_at: lastAt || last.finished_at };
}
function lastFail(name) {
  return db().prepare(`SELECT finished_at, error FROM sync_runs WHERE source = ? AND kind = 'pull' AND status = 'error' ORDER BY id DESC LIMIT 1`).get(name) || null;
}

// har report: aakhri sync + agli range + chalani hai ya nahi
export function plan() {
  const today = todayIso();
  const monthStart = today.slice(0, 8) + '01';
  const portal = portalOn() ? PORTAL.map((x) => {
    const last = lastOk(x.name), fail = lastFail(x.name);
    const lastDay = last?.finished_at ? new Date(Date.parse(last.finished_at) + 5.5 * 3600e3).toISOString().slice(0, 10) : null;
    return { name: x.name, label: x.label, portal: x.kind,
      lastAt: last?.finished_at || null, lastFrom: toDMY(last?.range_from || ''), lastTo: toDMY(last?.range_to || ''), lastRows: last?.rows_in ?? null,
      lastError: fail && (!last || fail.finished_at > last.finished_at) ? fail.error : null,
      // baaki reports ki tarah: aakhri sync ki To − 1 din se aaj tak. Pehli baar (koi sync nahi) = pichhle PORTAL_DAYS din
      next: { from: toDMY((() => { let f = last?.range_to ? addDays(last.range_to, -1) : addDays(today, -PORTAL_DAYS); if (f > today) f = today; return f; })()), to: toDMY(today) },
      due: !(last?.range_to >= today && lastDay === today), note: '' };
  }) : [];
  // Service JobCard invoices (Siebel) — aakhri sync ki To − 1 din se aaj tak
  const svc = serviceOn() ? [(() => {
    const last = lastOk('service_invoice'), fail = lastFail('service_invoice');
    let from = last?.range_to ? addDays(last.range_to, -1) : monthStart; if (from < addDays(today, -365)) from = addDays(today, -365);
    const lastDay = last?.finished_at ? new Date(Date.parse(last.finished_at) + 5.5 * 3600e3).toISOString().slice(0, 10) : null;
    return { name: 'service_invoice', label: 'Service — JobCard Invoices (Hero Connect)', service: true,
      lastAt: last?.finished_at || null, lastFrom: toDMY(last?.range_from || ''), lastTo: toDMY(last?.range_to || ''), lastRows: last?.rows_in ?? null,
      lastError: fail && (!last || fail.finished_at > last.finished_at) ? fail.error : null,
      next: { from: toDMY(from), to: toDMY(today) }, due: !(last?.range_to >= today && lastDay === today), note: '' };
  })()] : [];
  return [...QUEUE.map((name) => {
    const src = source(name);
    const last = lastOk(name);
    const fail = lastFail(name);
    let from;
    if (name === 'parts_order') from = addDays(today, -PO_DAYS);
    else if (last?.range_to) from = addDays(last.range_to, -1);
    else from = monthStart;
    let note = '';
    if (from < addDays(today, -365)) { from = addDays(today, -365); note = '1 saal se purana — baaki mahine-wise haath se'; }
    if (from > today) from = today;
    const lastDay = last?.finished_at ? new Date(Date.parse(last.finished_at) + 5.5 * 3600e3).toISOString().slice(0, 10) : null;   // IST din
    const freshMs = last?.finished_at ? Date.now() - Date.parse(last.finished_at) : Infinity;
    const syncedToday = last?.range_to >= today && lastDay === today;
    const due = !(syncedToday && (!FRESH_HOURS || freshMs < FRESH_HOURS * 3600e3));
    return {
      name, label: src.label,
      lastAt: last?.finished_at || null, lastFrom: toDMY(last?.range_from || ''), lastTo: toDMY(last?.range_to || ''), lastRows: last?.rows_in ?? null,
      lastError: fail && (!last || fail.finished_at > last.finished_at) ? fail.error : null,
      next: { from: toDMY(from), to: toDMY(today) }, due, note,
    };
  }), ...portal, ...svc];
}

export function status() {
  return { job, busy: pullBusy(), sources: plan(), auto: autoSyncConfig() };
}

// background me chalao (await mat karo) — turant job lautao
// only  = sirf ye reports (jaise fail wali) · ranges = { name: {from,to} } har report ki apni date (screen se badli)
export function startCatchup({ force = false, only = null, ranges = null, auto = false } = {}) {
  if (job?.running) return job;
  if (pullBusy()) throw new Error(`Ek sync pehle se chal raha hai (${pullBusy()}) — khatam hone do`);
  const want = Array.isArray(only) && only.length ? new Set(only) : null;
  const p = plan().filter((x) => (want ? want.has(x.name) : (force || x.due)))
    .map((x) => (ranges && ranges[x.name]?.from ? { ...x, next: { from: ranges[x.name].from, to: ranges[x.name].to || ranges[x.name].from } } : x));
  if (want && !p.length) throw new Error('Koi report chuni nahi (ya login ID nahi daali)');
  if (!p.length) { job = { running: false, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), steps: [], note: 'Sab reports aaj tak sync hain' }; return job; }
  job = {
    running: true, startedAt: new Date().toISOString(), finishedAt: null,
    steps: p.map((x) => ({ name: x.name, label: x.label, from: x.next.from, to: x.next.to, status: 'waiting', rows: null, error: null })),
    auto, retry: !!want,
  };
  const pbi = p.filter((x) => !x.portal && !x.service), wpp = p.filter((x) => x.portal), svcSteps = p.filter((x) => x.service);
  const each = Object.fromEntries(pbi.map((x) => [x.name, { from: x.next.from, to: x.next.to }]));
  const cur = job;
  log(`[catchup] ${p.length} reports: ${p.map((x) => `${x.name} ${x.next.from}->${x.next.to}`).join(' | ')}`);
  const runPortal = async () => {
    if (!wpp.length) return;
    const iso = (d) => d.split('/').reverse().join('-');                 // portal ek hi login me sab — sabse chaudi range
    const fr = wpp.map((x) => x.next.from).sort((a, b) => iso(a).localeCompare(iso(b)))[0];
    const to = wpp.map((x) => x.next.to).sort((a, b) => iso(b).localeCompare(iso(a)))[0];
    const range = { from: fr, to };
    const rr = { fromIso: range.from.split('/').reverse().join('-'), toIso: range.to.split('/').reverse().join('-') };
    const stepOf = (k) => cur.steps.find((x) => x.name === wpp.find((w) => w.portal === k)?.name);
    const out = await pullPortal(wpp.map((x) => x.portal), range, {
      onStep: (k) => { const s = stepOf(k); if (s) { s.status = 'running'; s.startedAt = new Date().toISOString(); } },
      onFile: async (k, file) => {
        const s = stepOf(k); if (!s) return;
        try { const r = importRows(rowsFromBuffer(fs.readFileSync(file)), file.split(/[\\/]/).pop()); s.rows = r.lines ?? r.notes ?? r.claims; s.status = 'ok'; }
        catch (e) { s.status = 'fail'; s.error = e.message; }
        s.doneAt = new Date().toISOString(); logRun(s.name, rr, s);
      },
    }).catch((e) => wpp.map((w) => ({ kind: w.portal, error: e.message })));
    for (const o of out) if (o.error) { const s = stepOf(o.kind); if (s && s.status !== 'ok') { s.status = 'fail'; s.error = o.error; s.doneAt = new Date().toISOString(); logRun(s.name, rr, s); } }
  };
  (pbi.length ? pullReports(pbi.map((x) => x.name), { __each: each }, {
    onStep: (name, st, info) => {
      const s = cur.steps.find((x) => x.name === name); if (!s) return;
      s.status = st;
      if (st === 'running') s.startedAt = new Date().toISOString();
      if (st === 'ok') { s.rows = info.rowsIn - info.skipped; s.warning = info.warning || null; s.doneAt = new Date().toISOString(); }
      if (st === 'fail') { s.error = info.error; s.doneAt = new Date().toISOString(); }
    },
  }).catch((e) => { err('[catchup] fail:', e.message); for (const s of cur.steps) if (!wpp.find((w) => w.name === s.name) && (s.status === 'waiting' || s.status === 'running')) { s.status = 'fail'; s.error = e.message; } }) : Promise.resolve())
    .then(runPortal).catch((e) => err('[catchup] portal fail:', e.message))
    .then(async () => {
      for (const x of svcSteps) {
        const stp = cur.steps.find((z) => z.name === x.name); if (!stp) continue;
        stp.status = 'running'; stp.startedAt = new Date().toISOString();
        try { const st = await pullServiceInvoices({ from: x.next.from, to: x.next.to }); stp.status = 'ok'; stp.rows = st.rowsIn - st.skipped; }
        catch (e) { stp.status = 'fail'; stp.error = e.message; }
        stp.doneAt = new Date().toISOString();
      }
    })
    .finally(() => { cur.running = false; cur.finishedAt = new Date().toISOString(); log('[catchup] khatam'); });
  return job;
}

// ============================================================
//  SUBAH KA AUTO SYNC — din me EK baar, set samay ke baad (default 09:00). PC/server us waqt band tha to
//  jab khulega tab chalega. Fail hua to apne aap dobara NAHI — screen pe "Fail wali dobara" se.
// ============================================================
export function autoSyncConfig() { return { on: getSetting('autoSync', '1') === '1', at: getSetting('autoSyncAt', '09:00'), lastDate: getSetting('autoSyncDate', null) }; }
export function setAutoSync({ on, at }) {
  if (on != null) setSetting('autoSync', on ? '1' : '0');
  if (at && /^\d{1,2}:\d{2}$/.test(at)) setSetting('autoSyncAt', at.padStart(5, '0'));
  return autoSyncConfig();
}
export function autoSyncTick() {
  const c = autoSyncConfig(); if (!c.on) return;
  const now = new Date(Date.now() + 5.5 * 3600e3);
  const today = now.toISOString().slice(0, 10), hhmm = now.toISOString().slice(11, 16);
  if (c.lastDate === today || hhmm < c.at) return;
  if (job?.running || pullBusy()) return;
  setSetting('autoSyncDate', today);                 // pehle likho — fail ho to bhi aaj dobara nahi
  try { const j = startCatchup({ auto: true }); log(`[auto-sync] ${today} ${hhmm}: ${j.steps.length} reports`); }
  catch (e) { err('[auto-sync] shuru nahi hua:', e.message); }
}