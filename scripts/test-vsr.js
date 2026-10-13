// VSR export test — VERBOSE (har step print, koi error chhupega nahi)
console.log('[1] script start');
process.on('unhandledRejection', e => { console.error('[unhandledRejection]', e); });
process.on('uncaughtException', e => { console.error('[uncaughtException]', e); });

import 'dotenv/config';
console.log('[2] dotenv loaded | PBI_EMAIL:', process.env.PBI_EMAIL ? 'set' : 'MISSING', '| PBI_PASS:', process.env.PBI_PASS ? 'set' : 'MISSING');

import fs from 'node:fs';
import path from 'node:path';
console.log('[3] fs/path ok');

let XLSX;
try { const m = await import('xlsx'); XLSX = m.default || m; console.log('[4] xlsx ok'); }
catch (e) { console.error('[4] xlsx FAIL:', e.message); process.exit(1); }

let launchBrowser, loginPowerBI, scrapeVSR;
try {
  ({ launchBrowser } = await import('../src/scrapers/browser.js')); console.log('[5] browser.js ok');
  ({ loginPowerBI } = await import('../src/scrapers/powerbi/login.js')); console.log('[6] login.js ok');
  ({ scrapeVSR } = await import('../src/scrapers/powerbi/vsr.js')); console.log('[7] vsr.js ok');
} catch (e) { console.error('[5-7] import FAIL:', e); process.exit(1); }

const DL = path.resolve('downloads');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const creds = { email: process.env.PBI_EMAIL, pass: process.env.PBI_PASS, ctid: process.env.PBI_CTID || 'f31980c8-b6a6-482d-a0d5-0f73c49dd4e9' };
  if (!creds.email || !creds.pass) { console.error('creds missing'); return; }

  console.log('[8] launching browser…');
  const browser = await launchBrowser('pbi');
  console.log('[9] browser launched');
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  fs.mkdirSync('screenshots', { recursive: true });

  try {
    console.log('[10] login…');
    const r = await loginPowerBI(page, creds);
    console.log('[11] loggedIn:', r.loggedIn, '| url:', r.url);
    if (!r.loggedIn) { await page.screenshot({ path:'screenshots/vsr-login-fail.png', fullPage:true }); throw new Error('login failed — screenshots/vsr-login-fail.png dekh'); }

    console.log('[12] VSR export… (render+hover+export ~1min)');
    const { file } = await scrapeVSR(page, DL);
    console.log('[13] downloaded:', file, '(' + fs.statSync(file).size + ' bytes)');

    const wb = XLSX.readFile(file);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    console.log('[14] sheet:', wb.SheetNames[0], '| rows:', rows.length);
    if (rows.length) { console.log('COLUMNS:', Object.keys(rows[0])); console.log('first row:', rows[0]); }
  } catch (e) {
    console.error('[X] FAILED:', e.message);
    await page.screenshot({ path: 'screenshots/vsr-error.png', fullPage: true }).catch(()=>{});
    console.log('shot -> screenshots/vsr-error.png');
  } finally {
    if (process.env.PUPPETEER_HEADFUL === '1') { console.log('(15s me band…)'); await sleep(15000); }
    await browser.close();
    console.log('[done]');
  }
})();