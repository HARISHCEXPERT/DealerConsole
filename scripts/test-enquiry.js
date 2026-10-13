// Enquiry report export test — VSR engine reuse, URL alag.
// Chalao: $env:PUPPETEER_HEADFUL=1; node scripts/test-enquiry.js
console.log('[1] start');
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import xlsxPkg from 'xlsx';
const XLSX = xlsxPkg.default || xlsxPkg;
import { launchBrowser } from '../src/scrapers/browser.js';
import { loginPowerBI } from '../src/scrapers/powerbi/login.js';
import { scrapeVSR } from '../src/scrapers/powerbi/vsr.js';

// Enquiry Register report URL (tere diye hue se)
const ENQUIRY_URL = 'https://app.powerbi.com/groups/me/reports/b2718ba9-4ffc-478c-a5c6-18e3887eefba/ReportSection5300e93bab7e629462ba?ctid=f31980c8-b6a6-482d-a0d5-0f73c49dd4e9&experience=power-bi';

const DL = path.resolve('downloads');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const creds = { email: process.env.PBI_EMAIL, pass: process.env.PBI_PASS, ctid: process.env.PBI_CTID || 'f31980c8-b6a6-482d-a0d5-0f73c49dd4e9' };
  if (!creds.email || !creds.pass) { console.error('.env me PBI_EMAIL/PBI_PASS bharo'); process.exit(1); }
  const browser = await launchBrowser('pbi');
  const page = await browser.newPage(); page.setDefaultTimeout(60000);
  fs.mkdirSync('screenshots', { recursive: true });
  try {
    console.log('[2] login…');
    const r = await loginPowerBI(page, creds);
    console.log('[3] loggedIn:', r.loggedIn);
    if (!r.loggedIn) throw new Error('login failed');

    console.log('[4] Enquiry export… (~1 min)');
    const { file } = await scrapeVSR(page, DL, null, ENQUIRY_URL);   // Enquiry URL seedhа pass
    console.log('[5] downloaded:', file);

    const wb = XLSX.readFile(file);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    console.log('[6] rows:', rows.length);
    if (rows.length) {
      console.log('\nCOLUMNS:');
      Object.keys(rows[0]).forEach((c,i)=>console.log(`  [${i}] ${c}`));
      console.log('\nFirst row:', rows[0]);
    }
  } catch (e) {
    console.error('[X] FAILED:', e.message);
    await page.screenshot({ path:'screenshots/enquiry-error.png', fullPage:true }).catch(()=>{});
  } finally {
    if (process.env.PUPPETEER_HEADFUL==='1'){ console.log('(15s…)'); await sleep(15000); }
    await browser.close();
  }
})();