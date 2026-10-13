// Sale pull: login -> scrapeSale -> data/sale-today.json likho (frontend isko padhega)
// Chalao:  $env:PUPPETEER_HEADFUL=1; node scripts/pull-sale.js
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from '../src/scrapers/browser.js';
import { loginDms } from '../src/scrapers/heroDms/login.js';
import { scrapeSale } from '../src/scrapers/heroDms/sale.js';
import { env } from '../src/config/env.js';

const DL = path.resolve('downloads');
const DATA = path.resolve('data');
fs.mkdirSync(DATA, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  try {
    console.log('login…');
    const res = await loginDms(page, env.dms);
    if (!res.loggedIn) throw new Error('login failed');
    console.log('logged in ✓');

    console.log('sale export…');
    const { sale, file } = await scrapeSale(page, DL);
    console.log('rows:', sale.length, '| file:', path.basename(file));

    const out = {
      pulledAt: new Date().toISOString(),
      source: 'hero_dms',
      count: sale.length,
      totalAmount: sale.reduce((s, r) => s + (r.amount || 0), 0),
      rows: sale,
    };
    fs.writeFileSync(path.join(DATA, 'sale-today.json'), JSON.stringify(out, null, 2));
    console.log('✅ likha -> data/sale-today.json');
    console.log('   aaj:', out.count, 'gaadi | ₹' + out.totalAmount.toLocaleString('en-IN'));
  } catch (e) {
    console.error('❌', e.message);
  } finally {
    if (process.env.PUPPETEER_HEADFUL === '1') { console.log('(8s me band…)'); await sleep(8000); }
    await browser.close();
  }
})();
