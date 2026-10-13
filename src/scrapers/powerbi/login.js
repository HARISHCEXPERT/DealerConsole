// PowerBI (Microsoft OAuth) login + sahi tenant.
// PBI_EMAIL / PBI_PASS / PBI_CTID env se. MFA nahi (confirmed).
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitAny(page, sels, timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    for (const s of sels) { const el = await page.$(s); if (el) return s; }
    await sleep(400);
  }
  return null;
}

export async function loginPowerBI(page, creds) {
  const { email, pass, ctid } = creds;

  // COOKIE/SESSION CHECK: pehle se logged-in? -> login skip
  await page.goto('https://app.powerbi.com/home' + (ctid ? ('?ctid=' + ctid + '&experience=power-bi') : ''),
    { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(4000);
  let already = /app\.powerbi\.com/i.test(page.url()) && !/login|signin/i.test(page.url())
    && !(await page.$('input#email.pbi-text-input, input#i0116, input[type="email"]'));
  if (already) {
    console.log('  [pbi] session mila — login skip');
    return { url: page.url(), loggedIn: true, cached: true };
  }
  console.log('  [pbi] session nahi/expire — login kar rahe');

  await page.goto('https://app.powerbi.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });

  // PowerBI apna email box (Microsoft se pehle)
  const pbiEmail = await waitAny(page, ['input#email.pbi-text-input', 'input#email', 'input[type="email"]'], 12000);
  if (pbiEmail) {
    await page.type(pbiEmail, email, { delay: 25 });
    const sub = await waitAny(page, ['button[type="submit"]', 'input[type="submit"]', 'button'], 6000);
    if (sub) await page.click(sub);
    await sleep(3000);
  }
  // Microsoft email (agar dobara maange)
  const msEmail = await waitAny(page, ['input[type="email"]', 'input[name="loginfmt"]', '#i0116'], 8000);
  if (msEmail) {
    const val = await page.$eval(msEmail, el => el.value).catch(() => '');
    if (!val) await page.type(msEmail, email, { delay: 25 });
    const nx = await waitAny(page, ['#idSIButton9', 'input[type="submit"]'], 6000);
    if (nx) await page.click(nx);
    await sleep(2500);
  }
  // Password
  const passSel = await waitAny(page, ['input#i0118', 'input[type="password"]', 'input[name="passwd"]'], 20000);
  if (passSel) {
    await page.type(passSel, pass, { delay: 25 });
    const si = await waitAny(page, ['#idSIButton9', 'input[type="submit"]'], 6000);
    if (si) await page.click(si);
    await sleep(3500);
  }
  // "Stay signed in?" -> Yes
  const stay = await waitAny(page, ['#idSIButton9'], 8000);
  if (stay) {
    const txt = await page.evaluate(() => /stay signed in/i.test(document.body.innerText || ''));
    if (txt) { await page.click('#idSIButton9'); await sleep(3000); }
  }
  // sahi tenant pe (ctid URL)
  if (ctid) {
    await page.goto(`https://app.powerbi.com/home?ctid=${ctid}&experience=power-bi`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
  }
  const loggedIn = /app\.powerbi\.com/i.test(page.url()) && !/login/i.test(page.url());
  return { url: page.url(), loggedIn };
}