// Vehicle Sale Register (VSR) export from PowerBI.
// Flow: report URL -> render wait -> table pe hover -> "More options" (⋯) -> "Export data"
//       -> "Data with current layout" + xlsx -> Export -> file download.
// CATCH: table pe HOVER karna padta hai tabhi ⋯ (more options) aata hai.
import fs from 'node:fs';
import path from 'node:path';
import { setDateRange } from './dateSlicer.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// tera VSR report URL (env se override kar sakte ho: PBI_VSR_URL)
const VSR_URL = process.env.PBI_VSR_URL ||
  'https://app.powerbi.com/groups/me/reports/50821d3f-3f45-4555-8b27-5b79a95972b7/ReportSection?ctid=f31980c8-b6a6-482d-a0d5-0f73c49dd4e9&experience=power-bi';

// Left "Pages" panel me naam se page kholo (URL section kabhi switch nahi karta — ye pakka hai).
async function gotoPageByName(page, name, tag = 'pbi') {
  if (!name) return false;
  try {
    const clicked = await page.evaluate((nm) => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const want = norm(nm);
      // naya PowerBI pages-pane (Angular Material) + purana — dono ke candidate
      const items = [...document.querySelectorAll(
        '[class*="item__primary-text"], .itemName, mat-list-item, [class*="pageButton"], ' +
        'button[role="tab"], [role="tab"], nav [role="button"], .navigation-wrapper button, cdkvirtualscrollviewport [role="button"]'
      )].filter((e) => e.offsetParent !== null);
      let el = items.find((e) => norm(e.textContent) === want)
            || items.find((e) => norm(e.textContent).includes(want))
            || items.find((e) => want.includes(norm(e.textContent)) && norm(e.textContent).length > 6);
      if (el) { (el.closest('button, a, mat-list-item, [role="tab"], [role="button"], li') || el).click(); return norm(el.textContent); }
      return null;
    }, name);
    if (clicked) { console.log(`  [${tag}] page -> "${clicked}"`); await sleep(3500); return true; }
    console.log(`  [${tag}] page "${name}" pages-panel me nahi mila — URL section pe hi`);
  } catch (e) { console.log(`  [${tag}] gotoPage skip: ${e.message}`); }
  return false;
}

// Saare dropdown slicer (Year / Month / Model / MAX FSC Count...) ko "All" karo — poora data aaye.
// Jo pehle se "All" hai use chhedte nahi (safe). Fail ho to crash nahi — best effort.
async function setSlicersAll(page, tag = 'pbi') {
  try {
    // DOM (user ke screenshot se): div.slicer-dropdown-menu  role=combobox  (naam = field ka naam)
    const boxes = await page.$$('.slicer-dropdown-menu, .slicerContainer [role="combobox"], .slicer-dropdown-content');
    let changed = 0, already = 0;
    for (const b of boxes) {
      const cur = ((await page.evaluate((el) => el.textContent || '', b)) || '').replace(/\s+/g, ' ').trim();
      if (/\ball\b/i.test(cur)) { already++; continue; }                 // pehle se All -> chhodo
      try {
        await b.click(); await sleep(900);                              // dropdown kholo
        const ok = await page.evaluate(() => {
          const items = [...document.querySelectorAll(
            '.slicer-dropdown-popup [role="option"], .slicerItemContainer, [role="menuitemcheckbox"], [role="option"], .slicerText'
          )].filter((i) => i.offsetParent !== null);
          const all = items.find((i) => /^\s*(select all|all)\s*$/i.test((i.textContent || '').trim()));
          if (all) { (all.closest('[role="option"], .slicerItemContainer') || all).click(); return true; }
          return false;
        });
        await sleep(800);
        await page.keyboard.press('Escape').catch(() => {});            // popup band
        await sleep(400);
        if (ok) changed++;
      } catch { await page.keyboard.press('Escape').catch(() => {}); }
    }
    console.log(`  [${tag}] slicers -> All: ${changed} set, ${already} pehle se All`);
    if (changed) await sleep(2500);                                     // naye filter pe table re-render
  } catch (e) { console.log(`  [${tag}] setSlicersAll skip: ${e.message}`); }
}

export async function scrapeVSR(page, downloadDir, dateRange = null, reportUrl = null, opts = {}) {
  fs.mkdirSync(downloadDir, { recursive: true });
  const client = await page.target().createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });

  const URL = reportUrl || process.env.PBI_VSR_URL || VSR_URL;

  // PURANI xlsx saaf karo — warna Chrome "data (1).xlsx" banata hai / "already exists" pe fail
  try {
    for (const f of fs.readdirSync(downloadDir)) {
      if (/\.(xlsx|crdownload)$/i.test(f)) { try { fs.unlinkSync(path.join(downloadDir, f)); } catch {} }
    }
    console.log('  [vsr] purani xlsx clear');
  } catch {}

  // PowerBI SPA kabhi networkidle nahi hota -> domcontentloaded + table render ka poll
  // ZAROORI: ek hi report ke alag-alag PAGE (FSC vs Paid = same reportId, alag ReportSection) —
  // seedha goto karne pe PowerBI SPA page switch nahi karta (purana page khula rehta hai, galat data).
  // isliye pehle about:blank -> fir real URL (cross-document reload) taaki sahi ReportSection khule.
  await page.goto('about:blank').catch(() => {});
  await sleep(400);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });

  // report/table render hone ka intezaar (spinner khatam + data rows aaye) — max 90s
  let rendered = false;
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    const st = await page.evaluate(() => {
      const rows = document.querySelectorAll('[role="row"], [class*="bodyCell"], .pivotTableCellWrap').length;
      const spinner = document.querySelector('.powerbi-spinner, [class*="spinner"], .circularProgress');
      const visuals = document.querySelectorAll('visual-container-modern, .visualContainer').length;
      return { rows, spinnerVisible: !!(spinner && spinner.offsetParent !== null), visuals };
    });
    if (st.rows > 5) { rendered = true; console.log('  [vsr] table rendered, rows-ish:', st.rows); break; }
    if (i === 5 || i === 15 || i === 30) console.log(`  [vsr] waiting render… rows:${st.rows} visuals:${st.visuals} spinner:${st.spinnerVisible}`);
  }
  await page.screenshot({ path: 'screenshots/vsr-loaded.png', fullPage: true }).catch(()=>{});
  if (!rendered) throw new Error('Report/table render nahi hua (90s) — screenshots/vsr-loaded.png dekh (spinner? blank? block?)');

  // ---- sahi PAGE pe jao (naam se) — URL section bharosemand nahi ----
  if (opts.pageName) await gotoPageByName(page, opts.pageName, 'pbi');

  // ---- SLICERS -> ALL (FSC/Paid VIN jaise snapshot reports) — poora data ----
  if (opts.allSlicers) await setSlicersAll(page, 'pbi');

  // ---- DATE SET — verify ke saath (dateSlicer.js). Box na mile / set na ho to ERROR, galat data nahi ----
  let appliedRange = null;
  if (dateRange && dateRange.from) appliedRange = await setDateRange(page, dateRange, 'pbi');

  // table visual dhoondo — jisme DATA ROWS hain (filter boxes nahi)
  await page.waitForSelector('visual-container-modern, .visualContainer', { timeout: 30000 }).catch(() => null);
  await sleep(2000);

  // wo visual jisme sabse zyada row-jaisा content ho = table. Uske header pe hover.
  const box = await page.evaluate(() => {
    const vis = [...document.querySelectorAll('visual-container-modern, .visualContainer')];
    let best = null, score = 0;
    for (const el of vis) {
      const r = el.getBoundingClientRect();
      if (r.width < 200 || r.height < 150) continue;
      // table ka andaza: bahut saare row-cells / pivot rows
      const cells = el.querySelectorAll('[class*="row"], [role="row"], .pivotTableCellWrap, [class*="bodyCell"]').length;
      const s = cells * 1000 + r.width * r.height;   // cells ko zyada weight
      if (s > score) { score = s; best = r; }
    }
    return best ? { x: best.x + best.width / 2, y: best.y, w: best.width, cx: best.x + best.width - 24 } : null;
  });
  if (!box) throw new Error('Table visual nahi mila');

  // header/top-right corner pe hover taaki visual ka apna ⋯ appear ho
  await page.mouse.move(box.x, box.y + 60); await sleep(700);          // body pe pehle
  await page.mouse.move(box.cx, box.y + 8);  await sleep(1200);         // top-right corner (⋯ wahin)
  await page.mouse.move(box.cx - 4, box.y + 10); await sleep(1200);

  // VISUAL ka ⋯ (report-level appbar wala NAHI). visual-more-options / vcMenuBtn.
  const moreClicked = await page.evaluate(() => {
    // report-level buttons ko explicitly chhodo
    const isReportLevel = (el) => el.closest('#appbar, .appBar, [class*="app-bar"], [data-testid*="appbar"]');
    const cands = [...document.querySelectorAll(
      'button.vcMenuBtn, button.visual-more-options, ' +
      'visual-container-modern button[aria-label*="More options"], ' +
      '.visualHeaderItemContainer button, .vcHeader button'
    )].filter(b => !isReportLevel(b) && b.offsetParent !== null);
    if (cands.length) { cands[cands.length - 1].click(); return 'visual-btn'; }
    return null;
  });
  if (!moreClicked) throw new Error('Table ka ⋯ (visual more-options) nahi mila — hover table tak nahi pahuncha');
  await sleep(1500);

  // "Export data"
  const exportClicked = await page.evaluate(() => {
    const items = [...document.querySelectorAll('button[role="menuitem"], .pbi-menu-item')];
    const ex = items.find(el => /export data/i.test(el.getAttribute('title') || el.textContent || ''));
    if (ex) { ex.click(); return true; }
    return false;
  });
  if (!exportClicked) throw new Error('"Export data" menu item nahi mila');
  await sleep(3000);

  // dialog: "Data with current layout" (default) + xlsx, phir Export
  await page.evaluate(() => {
    // "Data with current layout" radio (pehla) — usually default; ensure select
    const radios = [...document.querySelectorAll('input[type="radio"], [role="radio"]')];
    if (radios[0]) radios[0].click();
  });
  await sleep(800);

  // Export button
  const before = new Set(fs.readdirSync(downloadDir).filter(f => !f.endsWith('.crdownload')));
  const exp = await page.evaluate(() => {
    const b = document.querySelector('button.exportButton, button[class*="exportButton"]')
           || [...document.querySelectorAll('button')].find(x => /^export$/i.test((x.textContent||'').trim()));
    if (b) { b.click(); return true; }
    return false;
  });
  if (!exp) throw new Error('Export (confirm) button nahi mila');

  // download wait — dir pehle se xlsx-free hai, to jo xlsx aaye + .crdownload na ho = ready
  let file = null; const t0 = Date.now();
  while (Date.now() - t0 < 150000) {
    const now = fs.readdirSync(downloadDir);
    const busy = now.some(f => f.endsWith('.crdownload'));      // abhi download ho rahi
    const xlsx = now.filter(f => /\.xlsx$/i.test(f));
    if (xlsx.length && !busy) { file = path.join(downloadDir, xlsx[0]); break; }
    await sleep(700);
  }
  if (!file) throw new Error('VSR export download nahi aayi (150s)');
  await sleep(500); // file handle release
  console.log('  [vsr] downloaded:', path.basename(file));
  return { file, appliedRange };
}