// Hero Connect (Siebel) login.
// Fields: SWEUserName / SWEPassword. Trigger: a[onclick*="SWEExecuteLogin"].
// KEY: Siebel field value tabhi commit hoti hai jab blur/change fire ho.
// Isliye type ke baad Tab (blur) zaroori — warna login khaali submit hota hai.
import { env } from '../../config/env.js';
import { maskId } from '../../config/creds.js';

const U = 'input[name="SWEUserName"]';
const P = 'input[name="SWEPassword"]';

export async function loginDms(page, creds = env.dms) {
  await page.goto(creds.url, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector(U, { timeout: 20000 });

  // User ID: clear -> type -> commit (blur)
  await page.click(U, { clickCount: 3 });
  await page.type(U, creds.user, { delay: 45 });
  await page.keyboard.press('Tab');                 // blur -> Siebel value commit

  // Password: type -> commit
  await page.click(P, { clickCount: 3 });
  await page.type(P, creds.pass, { delay: 45 });
  await page.keyboard.press('Tab');                 // blur -> commit

  // sanity: value DOM me baithi? (debug)
  const filled = await page.evaluate((u,p) => ({
    user: (document.querySelector(u)||{}).value?.length || 0,
    pass: (document.querySelector(p)||{}).value?.length || 0,
  }), U, P);
  console.log('  [login] filled lengths:', filled, '· ID:', maskId(creds.user));

  // login form gaya = andar aa gaye — isi ka intezaar karenge
  const done = page.waitForFunction(
    () => !document.querySelector('input[name="SWEPassword"]'),
    { timeout: 60000 }
  ).then(() => true).catch(() => false);

  // trigger: SWEExecuteLogin wala anchor click
  const trigger = await page.evaluate(() => {
    let a = document.querySelector('a[onclick*="SWEExecuteLogin"]');
    if (!a) { const img = [...document.images].find(i => /login/i.test(i.src)); a = img ? img.closest('a') : null; }
    if (a) { a.click(); return 'clicked'; }
    if (typeof SWEExecuteLogin === 'function') { SWEExecuteLogin(document.SWEEntryForm, '/siebel/app/edealerasc/enu/', ''); return 'called-fn'; }
    return 'not-found';
  });

  const loggedIn = await done;
  return { url: page.url(), trigger, loggedIn };
}
