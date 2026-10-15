// ============================================================
//  EK HI PULL RUNNER — saare PowerBI reports ke liye.
//  Ek login, phir har report: date set (verify) -> export -> parse -> DB (ingest).
//  Report ka link / table / fields sab src/sources/index.js me. Yahan kuch report-specific nahi.
// ============================================================
import path from 'node:path';
import fs from 'node:fs';
import xlsxPkg from 'xlsx';
const XLSX = xlsxPkg.default || xlsxPkg;
import { launchBrowser } from '../scrapers/browser.js';
import { loginPowerBI } from '../scrapers/powerbi/login.js';
import { scrapeVSR as exportReport } from '../scrapers/powerbi/vsr.js';
import { ingest, logFailedRun } from '../db/engine.js';
import { toDate } from '../db/types.js';
import { source } from '../sources/index.js';
import { env } from '../config/env.js';
import { log, err } from '../utils/logger.js';
import { maskId } from '../config/creds.js';

let busy = null;   // ek waqt me ek hi browser pull (PowerBI session ek hai)

function readSheet(file) {
  const wb = XLSX.readFile(file);
  return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
}

// names: ['vsr'] ya ['parts_service','parts_counter']
// dateRange: { from:'dd/mm/yyyy', to:'dd/mm/yyyy' } ya null (report ka default)
//            ya har report ki alag range: { __each: { vsr: {from,to}, enquiry: {from,to}, soq: null } }
// opts.onStep(name, 'running' | 'ok' | 'fail', info) — queue/progress ke liye
// Return: { ok, results: { name: stats | { error } } }
function checkRange(r) {
  if (!r || !r.from) return;
  const f = toDate(r.from), t = toDate(r.to || r.from);
  if (!f || !t) throw new Error('Date sahi nahi (dd/mm/yyyy)');
  if (f > t) throw new Error(`From (${r.from}) To (${r.to}) se baad ki hai`);
  const days = (Date.parse(t) - Date.parse(f)) / 864e5;
  // 1 saal se lambi range ek baar me nahi (PowerBI export atakta hai / galti se purana data aa jaata hai)
  if (days > 366) throw new Error(`${Math.round(days)} din ki range — 1 saal se zyada ek saath nahi. Mahine-mahine karke daalo.`);
}
export const pullBusy = () => busy;
export async function pullReports(names, dateRange = null, opts = {}) {
  const rangeOf = (n) => (dateRange && dateRange.__each ? (dateRange.__each[n] ?? null) : dateRange);
  for (const n of names) checkRange(rangeOf(n));
  const step = (n, st, info) => { try { opts.onStep && opts.onStep(n, st, info); } catch {} };
  if (busy) throw new Error(`Ek pull pehle se chal raha hai (${busy}) — khatam hone do`);
  busy = names.join('+');
  const DL = path.resolve('downloads');
  fs.mkdirSync(DL, { recursive: true });
  fs.mkdirSync(path.resolve('screenshots'), { recursive: true });
  const results = {};
  let browser;
  try {
    browser = await launchBrowser('pbi');
    const page = await browser.newPage();
    page.setDefaultTimeout(60000);
    log(`[pull] PowerBI login: ${maskId(env.pbi.email)}`);
    const r = await loginPowerBI(page, { email: env.pbi.email, pass: env.pbi.pass, ctid: env.pbi.ctid });
    if (!r.loggedIn) throw new Error('PowerBI login failed (.env me PBI_EMAIL / PBI_PASS dekho)');

    for (const name of names) {
      const src = source(name);
      const url = process.env[src.report.env] || src.report.url;
      const range = rangeOf(name);
      step(name, 'running');
      try {
        log(`[pull] ${name} ${range ? range.from + ' -> ' + (range.to || range.from) : '(default range)'}`);
        const { file } = await exportReport(page, DL, range, url, { allSlicers: !!src.allSlicers, pageName: src.report.page || null });
        const rows = readSheet(file);
        const st = ingest(src, rows, { range });
        for (const extra of src.alsoIngest || []) {                       // wahi file doosri table me bhi (jaise labour lines)
          try { const x = ingest(source(extra), rows, { range }); log(`[pull]   + ${extra}: +${x.added} ~${x.updated} ↺${x.replaced}`); }
          catch (e) { err(`[pull]   + ${extra} FAIL:`, e.message); }
        }
        log(`[pull] ${name}: ${rows.length} rows | +${st.added} ~${st.updated} ↺${st.replaced}` + (st.warning ? ` | ⚠ ${st.warning}` : ''));
        results[name] = st;
        step(name, 'ok', st);
      } catch (e) {
        err(`[pull] ${name} FAIL:`, e.message);
        logFailedRun(name, range, e);
        results[name] = { error: e.message };
        step(name, 'fail', { error: e.message });
      }
    }
  } catch (e) {
    for (const name of names) if (!results[name]) { logFailedRun(name, rangeOf(name), e); results[name] = { error: e.message }; step(name, 'fail', { error: e.message }); }
  } finally {
    busy = null;
    if (browser) await browser.close().catch(() => {});
  }
  const errors = Object.entries(results).filter(([, v]) => v.error).map(([k, v]) => `${source(k).label}: ${v.error}`);
  const warnings = Object.entries(results).filter(([, v]) => v.warning).map(([k, v]) => `${source(k).label}: ${v.warning}`);
  return { ok: errors.length === 0, results, errors, warnings };
}
