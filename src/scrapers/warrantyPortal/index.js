import { launchBrowser } from '../browser.js';
import { loginWarranty } from './login.js';
import { scrapeWarranty } from './warranty.js';
import { scrapeFsc } from './fsc.js';
export async function pullWarranty() {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await loginWarranty(page);
    return { warranty: await scrapeWarranty(page), fsc: await scrapeFsc(page) };
  } finally { await browser.close(); }
}
