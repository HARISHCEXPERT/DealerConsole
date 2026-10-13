// ALAG source. Apna login, apne selectors.
import { env } from '../../config/env.js';
export async function loginWarranty(page) {
  await page.goto(env.warranty.url, { waitUntil: 'networkidle2' });
  // TODO real selectors
  return page;
}
