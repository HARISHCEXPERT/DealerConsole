// ============================================================
//  HERO SSP PORTAL (webpp.heromotocorp.biz — SAP NetWeaver) -> Warranty Claim Report + Free Service Credit Note
//  URL login ke baad nahi badalta -> sab CLICK se:
//    login -> Reports (#tabIndex1) -> Services (subtab title="Services") -> left menu (naam se)
//    -> andar ke frame me From/To date (dd/MM/yyyy) -> Submit -> .xls download
//  Har step ka screenshot: screenshots/wpp-*.png  (atke to wahi dekho)
//  .env: WARRANTY_URL (default portal), WARRANTY_USER, WARRANTY_PASS    PUPPETEER_HEADFUL=1 = browser dikhega
// ============================================================
import { maskId } from '../../config/creds.js';
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from '../browser.js';
import { env } from '../../config/env.js';
import { log } from '../../utils/logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let URL = env.warranty.url || 'https://webpp.heromotocorp.biz/irj/portal?saml2=disabled';
if (!/saml2=disabled/i.test(URL)) URL += (URL.includes('?') ? '&' : '?') + 'saml2=disabled';   // .env me purana URL ho to bhi   // saml2=disabled = seedha user/password login
export const REPORTS = {
  fsc:      { menu: 'Free Service Credit Note' },
  warranty: { menu: 'Warranty Claim Status' },   // isi screen se 'Warranty Claim Details' .xls aati hai
  dcr:      { menu: 'Warranty Claim Report' },
  stmt:     { menu: 'Account Statement', sub: 'Accounts' },   // paisa aana-jaana (MM/YYYY period)   // DealerClaimReport.xls — har part ka paisa + Hold/Accept
};

async function shot(page, name) { fs.mkdirSync('screenshots', { recursive: true }); await page.screenshot({ path: `screenshots/wpp-${name}.png` }).catch(() => {}); }

// saare frames me pehla match (SAP portal ke andar iframe ke andar iframe hota hai)
async function inFrames(page, fn, arg) {
  for (const f of page.frames()) {
    try { const r = await f.evaluate(fn, arg); if (r) return { frame: f, r }; } catch {}
  }
  return null;
}
async function waitFrames(page, fn, arg, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const x = await inFrames(page, fn, arg); if (x) return x; await sleep(700); }
  await shot(page, 'atka');
  throw new Error(`${what} nahi mila (${Math.round(ms / 1000)}s) — screenshots/wpp-atka.png dekho`);
}
// ---------- LOGIN ----------
async function login(page) {
  log('[wpp] khol rahe:', URL);
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 90000 }).catch(() => page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 }));
  await sleep(2500);
  await shot(page, '0-open');
  const loggedIn = async () => !!(await inFrames(page, () => !!document.querySelector('#tabIndex1') || /welcome:/i.test(document.body?.innerText || '')));
  if (await loggedIn()) { log('[wpp] pehle se login (session)'); return; }
  if (!env.warranty.user || !env.warranty.pass) throw new Error('.env me WARRANTY_USER / WARRANTY_PASS daalo (SSP portal ki ID)');
  const findPass = () => { const p = document.querySelector('#logonpassfield, input[type="password"]'); return p ? true : null; };
  let form = await inFrames(page, findPass);
  for (let i = 0; !form && i < 2; i++) {        // page aadha khula / redirect -> dobara kholo
    await sleep(8000); form = await inFrames(page, findPass);
    if (!form) { log('[wpp] login box nahi dikha, dobara khol rahe…', page.url()); await page.goto(URL, { waitUntil: 'networkidle2', timeout: 90000 }).catch(() => {}); await sleep(3000); form = await inFrames(page, findPass); }
  }
  if (!form) {
    await shot(page, 'atka');
    const title = await page.title().catch(() => '');
    throw new Error(`Login page (password box) nahi mila — browser yahan hai: ${page.url()} "${title}" · screenshots/wpp-atka.png dekho`);
  }
  const f = form.frame;
  // SAP portal default ids: #logonuidfield / #logonpassfield; warna pehla text box + password box
  const uSel = (await f.$('#logonuidfield')) ? '#logonuidfield' : 'input[type="text"]:not([type="hidden"]), input:not([type])';
  const pSel = (await f.$('#logonpassfield')) ? '#logonpassfield' : 'input[type="password"]';
  const u = await f.$(uSel), p = await f.$(pSel);
  console.log('  [portal] login ID:', maskId(env.warranty.user));
  await u.click({ clickCount: 3 }); await u.type(env.warranty.user, { delay: 30 });
  await p.click({ clickCount: 3 }); await p.type(env.warranty.pass, { delay: 30 });
  await shot(page, '1-login');
  const btn = await f.$('input[name="uidPasswordLogon"], button[type="submit"], input[type="submit"], .urBtnStdNew');
  if (btn) await btn.click(); else await p.press('Enter');
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    await sleep(1500);
    if (await loggedIn()) { log('[wpp] login ho gaya'); await shot(page, '2-home'); return; }
    const err = await inFrames(page, () => { const e = document.querySelector('.urMsgBarErr, .urTxtMsg, #logonMessage, .error'); return e && e.innerText.trim() ? e.innerText.trim() : null; });
    if (err && /password|user|invalid|locked|galat|incorrect/i.test(err.r)) { await shot(page, 'login-fail'); throw new Error('Portal login fail: ' + err.r); }
  }
  await shot(page, 'login-fail');
  throw new Error('Login ke baad portal nahi khula (60s) — screenshots/wpp-login-fail.png');
}

// ---------- report kholo ----------
async function openReport(page, menu, sub = 'Services') {
  // Reports tab
  await waitFrames(page, () => { const t = document.querySelector('#tabIndex1'); if (!t) return null; (t.querySelector('.TabText') || t).click(); return true; }, null, 20000, 'Reports tab');
  await sleep(2000);
  // Services / Accounts subtab
  await waitFrames(page, (sb) => {
    const rx = new RegExp('^\\s*' + sb + '\\s*$', 'i');
    const t = [...document.querySelectorAll('[title], .SubTabStandard, .SubTabDown, .TabText')].find((e) => /SubTab|TabText/.test(e.className || '') && rx.test(e.getAttribute('title') || e.textContent || ''));
    if (!t) return null; (t.querySelector?.('.TabText') || t).click(); return true;
  }, sub, 20000, `${sub} sub-tab`);
  await sleep(2500);
  // left menu item (naam se)
  const ok = await waitFrames(page, (m) => {
    const rx = new RegExp('^\\s*' + m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'i');
    const el = [...document.querySelectorAll('a, span, div, td')].find((e) => e.children.length === 0 && rx.test(e.textContent || '') && e.offsetParent !== null);
    if (!el) return null; el.scrollIntoView({ block: 'center' }); el.click(); (el.closest('a') || el).click?.(); return true;
  }, menu, 25000, `Left menu "${menu}"`);
  await sleep(3500);
  await shot(page, '3-report-' + menu.split(' ')[0].toLowerCase());
  return ok;
}

// ---------- date set + Submit + download ----------
async function runReport(page, { from, to }, dlDir) {
  // date boxes wala frame (WebDynpro): id me "fromdate" / "todate"
  // date boxes: (1) id me fromdate/todate (FSC, Claim Status)  ya  (2) WebDynpro ABAP (Claim Report): id "WD3D", lsdata me 'DATE'
  //   -> pehle 2 DATE box = From, To ("Reference Date ... To"). Format lsdata se: dd/MM/yyyy ya dd.MM.yyyy
  const found = await waitFrames(page, () => {
    const all = [...document.querySelectorAll('input')].filter((i) => i.offsetParent !== null);
    let f = all.find((i) => /from.?date/i.test(i.id || i.name || '')), t = all.find((i) => /to.?date/i.test(i.id || i.name || ''));
    if (!(f && t)) { const ds = all.filter((i) => /['"]?2['"]?\s*:\s*['"]DATE['"]/.test(i.getAttribute('lsdata') || '')); if (ds.length >= 2) { f = ds[0]; t = ds[1]; } }
    if (!(f && t)) return null;
    const m = (f.getAttribute('lsdata') || '').match(/(?:dd[./-])?MM[./-]yyyy/i);
    return { f: f.id, t: t.id, fmt: m ? m[0] : 'dd/MM/yyyy' };
  }, null, 40000, 'From/To date box');
  const fr = found.frame;
  // 01/04/2026 -> box ke format me: dd/MM/yyyy · dd.MM.yyyy · MM/yyyy (Account Statement)
  const fmtD = (v) => { const [dd, mm, yy] = v.split(/[./-]/); return found.r.fmt.replace(/dd/i, dd).replace('MM', mm).replace(/yyyy/i, yy); };
  const setDate = async (id, v0) => {
    const v = fmtD(v0);
    const el = await fr.$(`[id="${id}"]`);
    await el.click({ clickCount: 3 }); await sleep(150);
    await fr.evaluate((i) => { const e = document.getElementById(i); e.select?.(); }, id);
    await el.type(v, { delay: 40 }); await el.press('Tab'); await sleep(1200);
    const got = await fr.evaluate((i) => document.getElementById(i)?.value, id);
    if (got.replace(/[./-]/g, '') !== v.replace(/[./-]/g, '')) throw new Error(`Date set nahi hui: "${v}" daala, box me "${got}" hai`);
  };
  await setDate(found.r.f, from);
  await setDate(found.r.t, to);
  await shot(page, '4-dates');

  const before = new Set(fs.readdirSync(dlDir));
  // WebDynpro button = <div id="aaaa.V_xxx.Button_submit" class="lsButton"> — asli mouse click chahiye (el.click() se "Press" event nahi chalta)
  // FSC: id "...Button_submit" · Warranty: id "...Button_Button" (text "Submit") -> text se pakka karo
  let btn = null;
  // Claim Report me button ka naam "Proceed"
  { const h = await fr.evaluateHandle(() => [...document.querySelectorAll('[ct="B"], .lsButton')].find((e) => /^\s*(submit|proceed)\s*$/i.test(e.textContent || '') && e.offsetParent !== null) || null); btn = h.asElement(); }
  if (!btn) btn = await fr.$('[id$="Button_submit" i]');
  if (!btn) {
    const h = await fr.evaluateHandle(() => [...document.querySelectorAll('.lsButton, [ct="B"], a, button, div, span, input[type="button"], input[type="submit"]')]
      .find((e) => /^\s*(submit|proceed)\s*$/i.test(e.textContent || e.value || '') && e.offsetParent !== null) || null);
    btn = h.asElement();
  }
  if (!btn) { await shot(page, 'atka'); throw new Error('Submit/Proceed button nahi mila — screenshots/wpp-atka.png'); }
  await btn.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await btn.click({ delay: 60 });
  log('[wpp] submit…');

  // file ka intezaar. Beech me "Export/Excel/Download" button aaye to use bhi dabao (ek baar)
  let exportTried = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    await sleep(1500);
    const now = fs.readdirSync(dlDir).filter((f) => !before.has(f));
    const busy = now.some((f) => /\.crdownload$|\.tmp$/i.test(f));
    const file = now.find((f) => /\.(xls|xlsx|csv)$/i.test(f));
    if (file && !busy) { await sleep(800); await shot(page, '5-done'); return path.join(dlDir, file); }
    if (!exportTried && Date.now() - t0 > 6000) {
      let x = null;
      for (const f of page.frames()) {
        try {
          const h = await f.evaluateHandle(() => [...document.querySelectorAll('.lsButton, [ct="B"], a, button, div[role="button"], span[role="button"], img, input[type="button"]')]
            .find((e) => /^(export|excel|download|export to excel)/i.test((e.textContent || e.title || e.alt || e.value || '').trim()) && e.offsetParent !== null) || null);
          const el = h.asElement();
          if (el) { const t = await el.evaluate((e) => (e.textContent || e.title || e.alt || '').trim()); await el.click({ delay: 60 }); x = { r: t || 'export' }; break; }
        } catch {}
      }
      if (x) { exportTried = true; log('[wpp] export button:', x.r); await shot(page, '5-export'); }
    }
    const msg = await inFrames(page, () => { const e = [...document.querySelectorAll('.lsMessageArea, .urMsgBarErr, [class*="MessageArea"], [class*="lsMessage"]')].find((x) => x.innerText.trim()); return e ? e.innerText.trim() : null; });
    if (msg && /no data|not found|koi|error|invalid/i.test(msg.r)) { await shot(page, 'atka'); throw new Error('Portal: ' + msg.r); }
  }
  await shot(page, 'atka');
  throw new Error('File download nahi hui (3 min) — screenshots/wpp-atka.png dekho (Submit ke baad kya dikha?)');
}

let busy = false;
export const portalBusy = () => busy;
// kinds: ['fsc','warranty']  range: { from:'dd/mm/yyyy', to:'dd/mm/yyyy' }
// return: [{ kind, file } | { kind, error }]
// opts.onStep(kind, 'running') · opts.onFile(kind, file) turant (import ke liye)
export async function pullPortal(kinds, range, opts = {}) {
  if (busy) throw new Error('Portal sync pehle se chal raha hai');
  busy = true;
  const dlDir = path.resolve('downloads', 'wpp');
  fs.mkdirSync(dlDir, { recursive: true });
  for (const f of fs.readdirSync(dlDir)) try { fs.unlinkSync(path.join(dlDir, f)); } catch {}
  const out = [];
  let browser;
  try {
    browser = await launchBrowser('wpp');
    const cdp = await browser.target().createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir, eventsEnabled: true }).catch(() => {});
    const page = (await browser.pages())[0] || await browser.newPage();
    page.setDefaultTimeout(60000);
    await login(page);
    for (const k of kinds) {
      const R = REPORTS[k];
      try {
        log(`[wpp] ${k}: ${range.from} -> ${range.to}`);
        await openReport(page, R.menu, R.sub);
        try { opts.onStep && opts.onStep(k, 'running'); } catch {}
        const file = await runReport(page, range, dlDir);
        out.push({ kind: k, file });
        try { opts.onFile && await opts.onFile(k, file); } catch {}
      } catch (e) { out.push({ kind: k, error: e.message }); log(`[wpp] ${k} FAIL: ${e.message}`); }
    }
  } catch (e) {
    for (const k of kinds) if (!out.find((x) => x.kind === k)) out.push({ kind: k, error: e.message });
  } finally {
    busy = false;
    if (browser) await browser.close().catch(() => {});
  }
  return out;
}
