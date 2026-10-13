// STEP 2 — LOGIN + SALE EXPORT (end-to-end test)
// Chalao:  $env:PUPPETEER_HEADFUL=1; node scripts/test-login.js
// Flow: login -> Sales view -> applet menu -> Export... -> Comma Separated + All cols -> Next
//       -> file downloads/ me capture -> UTF-16/tab parse -> console pe rows
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser } from '../src/scrapers/browser.js';
import { loginDms } from '../src/scrapers/heroDms/login.js';
import { env } from '../src/config/env.js';

const line = (t) => console.log('\n──────── ' + t + ' ────────');
const DL = path.resolve('downloads');
fs.mkdirSync(DL, { recursive: true });
fs.mkdirSync('screenshots', { recursive: true });

// Sales view — tere address bar wala URL
const SALES_VIEW = 'https://connect.heromotocorp.biz/siebel/app/edealerasc/enu/?SWECmd=GotoView&SWEView=Order+Entry+-+My+Orders+View+(Sales)&SWERF=1&SWEHo=&SWEBU=1';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// pre-download files snapshot -> naya file detect karne ke liye
const listDl = () => new Set(fs.readdirSync(DL).filter(f => !f.endsWith('.crdownload')));

async function waitForDownload(before, timeout = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const now = fs.readdirSync(DL);
    const done = now.filter(f => !f.endsWith('.crdownload'));
    const fresh = done.find(f => !before.has(f));
    // .crdownload hai to abhi chal rahi hai
    if (fresh && !now.includes(fresh + '.crdownload')) return path.join(DL, fresh);
    await sleep(500);
  }
  return null;
}

// Siebel export UTF-16 / TAB deta hai (naam CSV hota hai par andar tab)
function parseSiebelExport(file) {
  let buf = fs.readFileSync(file);
  let text;
  if (buf[0] === 0xFF && buf[1] === 0xFE) text = buf.toString('utf16le');      // UTF-16 LE BOM
  else if (buf[0] === 0xEF && buf[1] === 0xBB) text = buf.toString('utf8');     // UTF-8 BOM
  else text = buf.toString('utf16le');                                          // default guess
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  const delim = (lines[0].match(/\t/g)?.length || 0) >= (lines[0].match(/,/g)?.length || 0) ? '\t' : ',';
  const split = (l) => l.split(delim).map(c => c.replace(/^"|"$/g, '').trim());
  const headers = split(lines[0]);
  const rows = lines.slice(1).map(l => {
    const cells = split(l);
    return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? '']));
  });
  return { headers, rows };
}

(async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);

  // CDP: download ko downloads/ me daalo, Save-As dialog band
  const client = await page.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });

  try {
    line('1) LOGIN');
    const res = await loginDms(page, env.dms);
    console.log('loggedIn:', res.loggedIn, '| url:', res.url);
    if (!res.loggedIn) { console.log('⚠️ login nahi hua — ruk gaye.'); throw new Error('login failed'); }

    line('2) SALES VIEW KHOLO');
    await page.goto(SALES_VIEW, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(3000); // Siebel applet render hone do
    console.log('url:', page.url(), '| title:', await page.title());
    await page.screenshot({ path: 'screenshots/03-sales.png', fullPage: true });

    line('3) APPLET MENU -> EXPORT...');
    // menu button (cog/gear ⚙️ ya applet menu). class/title se dhoondo.
    const openedMenu = await page.evaluate(() => {
      const btn = document.querySelector(
        '.siebui-appletmenu-button, .appletMenu, span.miniBtnUICTop, ' +
        'button[title="Menu"], [title="Menu"], .siebui-icon-appletmenu'
      );
      if (btn) { (btn.tagName === 'BUTTON' ? btn : btn.querySelector('button') || btn).click(); return true; }
      return false;
    });
    console.log('menu button clicked:', openedMenu);
    await sleep(1500);

    // Export... item — EXACT data-caption, andar ka <a role=menuitem> click
    const clickedExport = await page.evaluate(() => {
      // sabse pehle exact
      let a = document.querySelector('li[data-caption="Export..."] a[role="menuitem"]');
      // fallback: role=menuitem jiska text exactly "Export..."
      if (!a) {
        a = [...document.querySelectorAll('a[role="menuitem"]')]
          .find(el => (el.textContent || '').trim().toLowerCase() === 'export...');
      }
      if (a) {
        // hover + click (kabhi Siebel ko real event chahiye)
        a.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        a.click();
        return a.textContent.trim();
      }
      return null;
    });
    console.log('export item clicked:', clickedExport);
    await sleep(2000);
    await page.screenshot({ path: 'screenshots/04-export-dialog.png', fullPage: true });

    // dialog khula ya nahi confirm
    const dialogOpen = await page.evaluate(() =>
      /export/i.test(document.querySelector('.ui-dialog-title, .siebui-popup-title')?.textContent || '') ||
      !!document.querySelector('input[type="radio"]')
    );
    console.log('export dialog open:', dialogOpen);
    if (!dialogOpen) throw new Error('Export dialog nahi khula — 04-export-dialog.png dekh');

    line('4) DIALOG: Comma Separated + All columns');
    await page.evaluate(() => {
      const radios = [...document.querySelectorAll('input[type="radio"]')];
      const byLabel = (re) => radios.find(r => {
        const t = (r.closest('tr,label,div')?.textContent || '');
        return re.test(t);
      });
      byLabel(/all rows/i)?.click();          // All Rows In Current Query
      byLabel(/^\s*all\s*$|columns to export.*all/i)?.click(); // All columns (best-effort)
      byLabel(/comma/i)?.click();             // Comma Separated
    });
    await sleep(500);

    line('5) NEXT -> DOWNLOAD');
    const before = listDl();
    const clickedNext = await page.evaluate(() => {
      let b = document.querySelector('[title="Export Form:Next"], button[name$="_Ctrl"]');
      if (!b) { b = [...document.querySelectorAll('button,a')].find(e => /(^|\s)next(\s|$)/i.test(e.textContent)); }
      if (b) { b.click(); return true; }
      return false;
    });
    console.log('next clicked:', clickedNext);

    const file = await waitForDownload(before, 60000);
    if (!file) { console.log('❌ download nahi aayi (60s). screenshots dekh.'); await page.screenshot({path:'screenshots/05-nodl.png',fullPage:true}); throw new Error('no download'); }
    console.log('✅ downloaded:', file, '(' + fs.statSync(file).size + ' bytes)');

    line('6) PARSE');
    const { headers, rows } = parseSiebelExport(file);
    console.log('columns:', headers.length, '| rows:', rows.length);
    console.log('first 3 rows (chhaanti hui):');
    rows.slice(0, 3).forEach((r, i) => console.log(`  #${i+1}`, {
      order: r['Order #'], date: r['Order Date'], status: r['Status'],
      model: r['Model'], dse: r['DSE Name'], amount: r['Total Cost'], invoice: r['Invoice #'],
    }));
    console.log('\n✅ Aaj total rows:', rows.length);

  } catch (e) {
    console.error('\n❌ FAILED:', e.message);
    await page.screenshot({ path: 'screenshots/99-error.png', fullPage: true }).catch(()=>{});
  } finally {
    if (process.env.PUPPETEER_HEADFUL === '1') { console.log('\n(12s me band...)'); await sleep(12000); }
    await browser.close();
  }
})();
