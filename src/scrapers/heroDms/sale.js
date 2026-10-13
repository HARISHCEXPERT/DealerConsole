// Sale scraper: Sales view -> Export... -> Comma/All -> Next -> download -> parse -> normalize.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeSale } from '../../normalize/sale.js';

const SALES_VIEW = 'https://connect.heromotocorp.biz/siebel/app/edealerasc/enu/?SWECmd=GotoView&SWEView=Order+Entry+-+My+Orders+View+(Sales)&SWERF=1&SWEHo=&SWEBU=1';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseSiebelExport(file) {
  const buf = fs.readFileSync(file);
  let text;
  if (buf[0] === 0xFF && buf[1] === 0xFE) text = buf.toString('utf16le');
  else if (buf[0] === 0xEF && buf[1] === 0xBB) text = buf.toString('utf8');
  else text = buf.toString('utf16le');
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return { headers: [], rows: [] };
  const delim = (lines[0].match(/\t/g)?.length || 0) >= (lines[0].match(/,/g)?.length || 0) ? '\t' : ',';
  const split = (l) => l.split(delim).map(c => c.replace(/^"|"$/g, '').trim());
  const headers = split(lines[0]);
  const rows = lines.slice(1).map(l => {
    const cells = split(l);
    return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? '']));
  });
  return { headers, rows };
}

// page = already logged-in Puppeteer page. downloadDir = jahan file girni hai.
export async function scrapeSale(page, downloadDir) {
  fs.mkdirSync(downloadDir, { recursive: true });
  const client = await page.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });

  // PURANI export file saaf — warna Chrome "data (1).csv" banata hai / already-exists pe fail
  try {
    for (const f of fs.readdirSync(downloadDir)) {
      if (/\.(csv|xls|xlsx|txt|crdownload)$/i.test(f)) { try { fs.unlinkSync(path.join(downloadDir, f)); } catch {} }
    }
  } catch {}

  await page.goto(SALES_VIEW, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(3000);

  // GUARD: aaj sale nahi -> list khaali / "No records" -> Export button aata hi nahi.
  // Aise me crash mat karo, saaf "0 sale" return karo.
  const state = await page.evaluate(() => {
    const txt = (document.body.innerText || '');
    const noRecords = /no records|koi record|0 of 0|1 - 0 of 0/i.test(txt);
    // applet menu me Export item enabled hai kya?
    const exp = document.querySelector('li[data-caption="Export..."]');
    const exportDisabled = exp ? exp.getAttribute('aria-disabled') === 'true' : null;
    // grid me koi data row?
    const rows = document.querySelectorAll('.ui-jqgrid tr.jqgrow, table[summary] tbody tr, .siebui-collapsible-applet tbody tr').length;
    return { noRecords, exportDisabled, rowsSeen: rows };
  });
  if (state.noRecords) {
    return { file: null, headers: [], raw: [], sale: [], empty: true, reason: 'No sales / no records today' };
  }

  // menu -> Export...
  await page.evaluate(() => {
    const btn = document.querySelector('.siebui-appletmenu-button, .appletMenu, span.miniBtnUICTop, [title="Menu"], .siebui-icon-appletmenu');
    if (btn) (btn.tagName === 'BUTTON' ? btn : btn.querySelector('button') || btn).click();
  });
  await sleep(1500);

  // Export item mila aur enabled hai? warna -> no data
  const exportClicked = await page.evaluate(() => {
    const li = document.querySelector('li[data-caption="Export..."]');
    if (li && li.getAttribute('aria-disabled') === 'true') return 'disabled';
    let a = (li && li.querySelector('a[role="menuitem"]'))
         || [...document.querySelectorAll('a[role="menuitem"]')].find(el => (el.textContent||'').trim().toLowerCase() === 'export...');
    if (!a) return 'notfound';
    a.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); a.click(); return 'ok';
  });
  if (exportClicked !== 'ok') {
    return { file: null, headers: [], raw: [], sale: [], empty: true, reason: 'Export unavailable — likely no sales today' };
  }
  await sleep(2000);

  // dialog: All rows + Comma Separated
  await page.evaluate(() => {
    const radios = [...document.querySelectorAll('input[type="radio"]')];
    const byLabel = (re) => radios.find(r => re.test(r.closest('tr,label,div')?.textContent || ''));
    byLabel(/all rows/i)?.click();
    byLabel(/comma/i)?.click();
  });
  await sleep(500);

  // Next -> download
  await page.evaluate(() => {
    let b = document.querySelector('[title="Export Form:Next"], button[name$="_Ctrl"]')
         || [...document.querySelectorAll('button,a')].find(e => /(^|\s)next(\s|$)/i.test(e.textContent));
    if (b) b.click();
  });

  // wait file — dir pehle se export-free hai, to jo data file aaye + crdownload na ho = ready
  let file = null; const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    const now = fs.readdirSync(downloadDir);
    const busy = now.some(f => f.endsWith('.crdownload'));
    const got = now.filter(f => /\.(csv|xls|xlsx|txt)$/i.test(f));
    if (got.length && !busy) { file = path.join(downloadDir, got[0]); break; }
    await sleep(500);
  }
  if (!file) {
    // download nahi aayi — ho sakta hai sale hi na ho. Crash ki jagah empty.
    return { file: null, headers: [], raw: [], sale: [], empty: true, reason: 'No export file (possibly no sales today)' };
  }

  const { headers, rows } = parseSiebelExport(file);
  return { file, headers, raw: rows, sale: rows.map(normalizeSale) };
}