// Parts reports column check — Service invoice + Parts. Date 01/08/2026 - 18/08/2026.
// Chalao: $env:PUPPETEER_HEADFUL=1; node scripts/test-parts.js
console.log('[1] start');
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import xlsxPkg from 'xlsx';
const XLSX = xlsxPkg.default || xlsxPkg;
import { launchBrowser } from '../src/scrapers/browser.js';
import { loginPowerBI } from '../src/scrapers/powerbi/login.js';
import { scrapeVSR } from '../src/scrapers/powerbi/vsr.js';

const REPORTS = {
  service: 'https://app.powerbi.com/groups/me/reports/07135606-f9b8-45c7-a0d5-b987fccd03c8/8a763af0a71e298d7490?ctid=f31980c8-b6a6-482d-a0d5-0f73c49dd4e9&experience=power-bi',
  parts:   'https://app.powerbi.com/groups/me/reports/1acdebe6-150d-42f5-afbe-d558a12a21ad/d24a19003a008e7a44ce?ctid=f31980c8-b6a6-482d-a0d5-0f73c49dd4e9&experience=power-bi',
  purchase:'https://app.powerbi.com/groups/me/reports/387b3d27-dcea-4fd7-8fe9-0b2797c9ab17/8a763af0a71e298d7490?ctid=f31980c8-b6a6-482d-a0d5-0f73c49dd4e9&experience=power-bi',
};
const DR = { from:'01/08/2026', to:'18/08/2026' };
const DL = path.resolve('downloads');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const creds = { email: process.env.PBI_EMAIL, pass: process.env.PBI_PASS, ctid: process.env.PBI_CTID || 'f31980c8-b6a6-482d-a0d5-0f73c49dd4e9' };
  if (!creds.email || !creds.pass) { console.error('.env me PBI_EMAIL/PBI_PASS'); process.exit(1); }
  const browser = await launchBrowser('pbi');
  const page = await browser.newPage(); page.setDefaultTimeout(60000);
  fs.mkdirSync('screenshots', { recursive: true });
  try {
    console.log('[2] login…');
    const r = await loginPowerBI(page, creds);
    if (!r.loggedIn) throw new Error('login failed');

    for (const [name, url] of Object.entries(REPORTS)) {
      try {
        console.log(`\n===== ${name.toUpperCase()} =====`);
        const { file } = await scrapeVSR(page, DL, DR, url);
        const wb = XLSX.readFile(file);
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
        console.log(`[${name}] rows:`, rows.length);
        if (rows.length) {
          console.log('COLUMNS:'); Object.keys(rows[0]).forEach((c,i)=>console.log(`  [${i}] ${c}`));
          console.log('first row:', rows[0]);
        }
      } catch(e){ console.error(`[${name}] FAIL:`, e.message); await page.screenshot({path:`screenshots/parts-${name}-err.png`,fullPage:true}).catch(()=>{}); }
    }
  } catch (e) {
    console.error('[X] FAILED:', e.message);
  } finally {
    if (process.env.PUPPETEER_HEADFUL==='1'){ console.log('(15s…)'); await sleep(15000); }
    await browser.close();
  }
})();