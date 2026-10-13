// Service JobCard Invoices: Hero Connect (Siebel) -> export -> DB (service_invoices)
import path from 'node:path';
import { launchBrowser } from '../scrapers/browser.js';
import { loginDms } from '../scrapers/heroDms/login.js';
import { scrapeJobCardInvoices } from '../scrapers/heroDms/service.js';
import { ingest, logFailedRun } from '../db/engine.js';
import { source } from '../sources/index.js';
import { env } from '../config/env.js';
import { toDate } from '../db/types.js';
import { log } from '../utils/logger.js';
import { pullReports, pullBusy } from './pull.js';

let busy = false;
export const serviceBusy = () => busy;
// range: { from:'dd/mm/yyyy', to:'dd/mm/yyyy' }
export async function pullServiceInvoices(range) {
  if (busy) throw new Error('Service sync pehle se chal raha hai');
  const f = toDate(range?.from), t = toDate(range?.to || range?.from);
  if (!f || !t || f > t) throw new Error('Date galat');
  if ((Date.parse(t) - Date.parse(f)) / 864e5 > 366) throw new Error('1 saal se zyada ek saath nahi — mahine-wise karo');
  const creds = env.dmsService;
  if (!creds.user || !creds.pass) throw new Error('.env me DMS_SERVICE_USER / DMS_SERVICE_PASS daalo (service wali ID)');
  busy = true;
  let browser, result;
  try {
    browser = await launchBrowser('dms-service');
    const page = await browser.newPage();
    page.setDefaultTimeout(60000);
    const r = await loginDms(page, { ...creds, url: creds.url || 'https://connect.heromotocorp.biz/siebel/app/edealerasc/enu/' });
    if (!r.loggedIn) throw new Error('Hero Connect login fail (service ID/password dekho)');
    log(`[service] ${range.from} -> ${range.to}`);
    const out = await scrapeJobCardInvoices(page, range, path.resolve('downloads', 'service'));
    if (out.empty) { const st = ingest(source('service_invoice'), [], { range, kind: 'pull' }); result = { ...st, empty: true }; }
    else {
      const st = ingest(source('service_invoice'), out.rows, { range, kind: 'pull' });
      log(`[service] ${out.rows.length} rows | +${st.added} ~${st.updated}`);
      result = st;
    }
  } catch (e) {
    logFailedRun('service_invoice', range, e);
    throw e;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (!result) busy = false;
  }
  // USI date range ka PowerBI JobCards (service type / supervisor / odometer) — chupchaap, alag se dikhta nahi.
  // Fail ho to bhi invoice sync safal hi maana jaata hai.
  try {
    if (!pullBusy()) { const jc = await pullReports(['service_jc'], range); const x = jc?.results?.service_jc; log(`[service] + jobcards: ${x?.error ? 'FAIL ' + x.error : 'ok'}`); }
    else log('[service] + jobcards: PowerBI busy — agli baar');
  } catch (e) { log('[service] + jobcards FAIL: ' + e.message); }
  finally { busy = false; }
  return result;
}