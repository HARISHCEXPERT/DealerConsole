// Sale pull -> data/sale-today.json. Script aur /api/sync dono isko use karte hain.
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from '../scrapers/browser.js';
import { loginDms } from '../scrapers/heroDms/login.js';
import { scrapeSale } from '../scrapers/heroDms/sale.js';
import { env } from '../config/env.js';

export async function pullSaleToFile() {
  const DL = path.resolve('downloads');
  const DATA = path.resolve('data');
  fs.mkdirSync(DATA, { recursive: true });

  const browser = await launchBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  try {
    const res = await loginDms(page, env.dmsSale);
    if (!res.loggedIn) throw new Error('login failed');
    const result = await scrapeSale(page, DL);
    const sale = result.sale || [];
    const out = {
      pulledAt: new Date().toISOString(),
      source: 'hero_dms',
      count: sale.length,
      totalAmount: sale.reduce((s, r) => s + (r.amount || 0), 0),
      note: result.empty ? (result.reason || 'No sales today') : null,
      rows: sale,
    };
    fs.writeFileSync(path.join(DATA, 'sale-today.json'), JSON.stringify(out, null, 2));
    return out;
  } finally {
    await browser.close();
  }
}
