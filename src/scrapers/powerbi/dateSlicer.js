// PowerBI date slicer (Start date / End date boxes) set karna — VERIFY ke saath.
//
// Purani dikkat: box na mile to chup-chaap aage badh jaata tha (poori report download),
// aur End pehle set karne pe agar naya End purane Start se pehle ho (jaise June se April pe jaana)
// to PowerBI End ko clamp kar deta tha. Isliye:
//   1. dono box na mile -> ERROR (range ke bina pull nahi)
//   2. order khud decide: naya Start purane End ke baad ho to End pehle, warna Start pehle
//   3. type karne ke baad dono box wapas padh ke match karo, 3 baar tak retry
//   4. phir bhi match nahi -> ERROR (galat range ka data DB me nahi jaayega)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 'dd/mm/yyyy' -> {d,m,y}
function parseDMY(s) {
  const p = String(s || '').trim().split(/[\/.-]/).map((x) => parseInt(x, 10));
  if (p.length !== 3 || p.some(isNaN)) throw new Error(`Date galat format me: "${s}" (dd/mm/yyyy chahiye)`);
  const y = p[2] < 100 ? 2000 + p[2] : p[2];
  return { d: p[0], m: p[1], y };
}
// PowerBI box ki value (m/d/yyyy — en-US) -> {d,m,y}. Kuch reports "d/m/yyyy" ya "Jun 1, 2026" bhi dikha sakte.
function parseBox(s, hint) {
  const t = String(s || '').trim();
  const mon = t.match(/^([A-Za-z]{3})[A-Za-z]*\s+(\d{1,2}),?\s+(\d{4})$/);
  if (mon) {
    const m = 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(mon[1].toLowerCase()) / 3 + 1;
    return { d: +mon[2], m, y: +mon[3] };
  }
  const p = t.split(/[\/.-]/).map((x) => parseInt(x, 10));
  if (p.length !== 3 || p.some(isNaN)) return null;
  // default m/d/yyyy; agar hint (jo type kiya) d/m se match kare to wahi maan lo
  const md = { m: p[0], d: p[1], y: p[2] };
  if (hint && md.d === hint.d && md.m === hint.m && md.y === hint.y) return md;
  const dm = { d: p[0], m: p[1], y: p[2] };
  if (hint && dm.d === hint.d && dm.m === hint.m && dm.y === hint.y) return dm;
  return md;
}
const same = (a, b) => a && b && a.d === b.d && a.m === b.m && a.y === b.y;
const num = (x) => x.y * 10000 + x.m * 100 + x.d;
const mdy = (x) => `${x.m}/${x.d}/${x.y}`;
const show = (x) => (x ? `${String(x.d).padStart(2, '0')}/${String(x.m).padStart(2, '0')}/${x.y}` : '?');

async function findBox(page, which) {
  const h = await page.evaluateHandle((which) => {
    const inputs = [...document.querySelectorAll('input')].filter((i) => i.offsetParent !== null);
    const re = new RegExp(which + '\\s*date', 'i');
    return inputs.find((i) => re.test(i.getAttribute('aria-label') || '') || re.test(i.getAttribute('placeholder') || '')) || null;
  }, which);
  return h.asElement();
}
const readBox = (page, el) => page.evaluate((e) => e.value, el).catch(() => '');

async function blurOutside(page) {
  const p = await page.evaluate(() => {
    const t = document.querySelector('.visualTitle, .reportTitle, .displayArea, .canvasFlexBox');
    const r = (t || document.body).getBoundingClientRect();
    return { x: Math.max(20, r.x + 40), y: Math.max(80, r.y + 10) };
  });
  await page.mouse.click(p.x, p.y);
}

async function typeInto(page, el, val) {
  await el.click();
  await sleep(400);
  await page.keyboard.press('Escape');            // calendar popup band
  await sleep(300);
  await page.evaluate((e) => { e.focus(); e.select && e.select(); }, el);
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
  await page.keyboard.press('Delete');
  await sleep(300);
  for (const ch of val) { await page.keyboard.type(ch); await sleep(45); }
  await sleep(400);
  await page.keyboard.press('Enter');
  await sleep(600);
  await page.keyboard.press('Escape');
  await blurOutside(page);
  await sleep(1500);
}

// dateRange = { from:'dd/mm/yyyy', to:'dd/mm/yyyy' }. Return: { from, to } jo box me confirm hua.
export async function setDateRange(page, dateRange, tag = 'pbi') {
  const want = { s: parseDMY(dateRange.from), e: parseDMY(dateRange.to || dateRange.from) };
  if (num(want.s) > num(want.e)) throw new Error(`From (${dateRange.from}) To (${dateRange.to}) ke baad hai`);

  for (let attempt = 1; attempt <= 3; attempt++) {
    const sEl = await findBox(page, 'Start');
    const eEl = await findBox(page, 'End');
    if (!sEl || !eEl) {
      await page.screenshot({ path: 'screenshots/pbi-nodate.png', fullPage: true }).catch(() => {});
      throw new Error(`Report me ${!sEl ? 'Start' : 'End'} date box nahi mila — range lagaye bina pull nahi karenge (screenshots/pbi-nodate.png dekho)`);
    }
    const cur = { s: parseBox(await readBox(page, sEl)), e: parseBox(await readBox(page, eEl)) };
    // naya Start purane End ke baad -> pehle End badhao; warna pehle Start
    const endFirst = cur.e && num(want.s) > num(cur.e);
    const order = endFirst ? [['End', eEl, want.e], ['Start', sEl, want.s]] : [['Start', sEl, want.s], ['End', eEl, want.e]];
    for (const [, el, val] of order) await typeInto(page, el, mdy(val));

    await sleep(2500);
    const s2 = await findBox(page, 'Start'), e2 = await findBox(page, 'End');
    const got = { s: parseBox(await readBox(page, s2), want.s), e: parseBox(await readBox(page, e2), want.e) };
    console.log(`  [${tag}] date try ${attempt}: chahiye ${show(want.s)} -> ${show(want.e)} | box me ${show(got.s)} -> ${show(got.e)}`);
    const skipVerify = process.env.PBI_DATE_VERIFY === 'off';   // emergency: .env me PBI_DATE_VERIFY=off
    if (skipVerify || (same(got.s, want.s) && same(got.e, want.e))) {
      if (skipVerify) console.log(`  [${tag}] PBI_DATE_VERIFY=off — verify skip`);
      await sleep(5000);   // report refresh
      await page.screenshot({ path: 'screenshots/vsr-dated.png', fullPage: true }).catch(() => {});
      return { from: show(got.s), to: show(got.e) };
    }
  }
  await page.screenshot({ path: 'screenshots/vsr-dated.png', fullPage: true }).catch(() => {});
  throw new Error(`Date range PowerBI me set nahi hui (3 try). screenshots/vsr-dated.png dekho`);
}
