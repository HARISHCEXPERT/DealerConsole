// Ek DMS pull orchestrate karta hai: login -> sale/service/parts.
import { launchBrowser } from '../browser.js';
import { loginDms } from './login.js';
import { scrapeSale } from './sale.js';
import { scrapeService } from './service.js';
import { scrapeParts } from './parts.js';

export async function pullDms() {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await loginDms(page);
    const sale = await scrapeSale(page);
    const service = await scrapeService(page);
    const parts = await scrapeParts(page);
    return { sale, service, parts };
  } finally {
    await browser.close();
  }
}
