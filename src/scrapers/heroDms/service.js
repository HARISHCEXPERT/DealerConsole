// ============================================================
//  HERO CONNECT (Siebel) — JobCard Invoices (service)
//  Login (DMS_SERVICE_USER/PASS) -> HHML JC Invoice View -> Query (🔍) -> "Invoice Created Date" me
//  >= from AND <= to  -> Enter (Go) -> applet menu -> Export... -> All rows + Comma -> Next -> file
//  Har step ka screenshot: screenshots/svc-*.png
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { log } from '../../utils/logger.js';

// URL se view NAHI kholte (SBL-DAT-00329: ID ko HHML JC Invoice View ki permission nahi). Tab click -> HMCL JC Invoice View BIP.
const JC_VIEW = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(page, name) { fs.mkdirSync('screenshots', { recursive: true }); await page.screenshot({ path: `screenshots/svc-${name}.png` }).catch(() => {}); }

// Siebel export: UTF-16 / UTF-8, tab ya comma
export function parseSiebelExport(file) {
  const buf = fs.readFileSync(file);
  let text;
  if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.toString('utf16le');
  else if (buf[0] === 0xef && buf[1] === 0xbb) text = buf.toString('utf8').slice(1);
  else if (buf.length > 1 && buf[1] === 0) text = buf.toString('utf16le');
  else text = buf.toString('utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return [];
  const delim = (lines[0].match(/\t/g)?.length || 0) >= (lines[0].match(/,/g)?.length || 0) ? '\t' : ',';
  const split = (l) => {
    if (delim === '\t') return l.split('\t').map((c) => c.replace(/^"|"$/g, '').trim());
    const out = []; let cur = '', q = false;                      // comma + "quoted, value"
    for (let i = 0; i < l.length; i++) { const ch = l[i];
      if (ch === '"') { if (q && l[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (ch === ',' && !q) { out.push(cur.trim()); cur = ''; } else cur += ch; }
    out.push(cur.trim()); return out;
  };
  const headers = split(lines[0]);
  return lines.slice(1).map((l) => { const c = split(l); return Object.fromEntries(headers.map((h, i) => [h, c[i] ?? ''])); });
}

// Siebel "ready": body me content ho, applet/grid bana ho, busy/mask overlay hat gaya ho
async function waitSiebel(page, timeout = 60000) {
  const t0 = Date.now();
  let calm = 0;
  while (Date.now() - t0 < timeout) {
    const st = await page.evaluate(() => {
      const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 20 && r.height > 20 && cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.05; };
      const busy = [...document.querySelectorAll('.siebui-busy, .siebui-mask-outer, #maskoverlay')].some(vis);
      const ready = !!document.querySelector('span.siebui-row-counter, td[role="gridcell"], table.ui-jqgrid-btable, button.siebui-icon-newquery');
      const text = (document.body?.innerText || '').trim().length;
      return { busy, ready, text };
    }).catch(() => ({ busy: true, ready: false, text: 0 }));
    if (st.ready && !st.busy && st.text > 50) { if (++calm >= 2) return true; } else calm = 0;   // 2 baar lagatar theek = pakka ready
    await sleep(700);
  }
  return false;
}

// Step dikhao: terminal log + (PUPPETEER_HEADFUL=1 pe) browser ke upar peeli patti me likha aata hai, aur thoda rukta hai
const SHOW = () => process.env.DC_SHOW_BROWSER === '1';
async function say(page, msg) {
  log('[service] ' + msg);
  if (!SHOW()) return;
  await page.evaluate((m) => {
    let d = document.getElementById('__dc_step');
    if (!d) { d = document.createElement('div'); d.id = '__dc_step';
      d.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#ffeb3b;color:#000;font:bold 18px Arial;padding:8px 14px;border-bottom:3px solid #f57f17;pointer-events:none';
      document.body.appendChild(d); }
    d.textContent = 'Dealer Console ▶ ' + m;
  }, msg).catch(() => {});
  await sleep(1500);
}

// dd/mm/yyyy -> Siebel query: >= '01/04/2026' AND <= '24/09/2026'
const q = ({ from, to }) => `>=${from} AND <=${to || from}`;   // bilkul aise: >=01/04/2026 AND <=24/09/2026

export async function scrapeJobCardInvoices(page, range, downloadDir) {
  fs.mkdirSync(downloadDir, { recursive: true });
  for (const f of fs.readdirSync(downloadDir)) { try { fs.unlinkSync(path.join(downloadDir, f)); } catch {} }
  // DOWNLOAD: poore browser pe allow + events on -> log me dikhega download shuru hua / kitna aaya / cancel hua
  const dl = { started: null, state: null, bytes: 0, total: 0 };
  const bc = await page.browser().target().createCDPSession();
  const pcdp = await page.target().createCDPSession();                // sale.js wala tareeka (DMS pe chalta hai)
  await pcdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir }).catch(() => {});
  await bc.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true }).catch(() => {});
  bc.on('Browser.downloadWillBegin', (e) => { dl.started = e.suggestedFilename || 'file'; log(`[service] download shuru: ${dl.started}`); });
  bc.on('Browser.downloadProgress', (e) => { dl.state = e.state; dl.bytes = e.receivedBytes; dl.total = e.totalBytes; if (e.state !== 'inProgress') log(`[service] download ${e.state} (${Math.round(e.receivedBytes / 1024)} KB)`); });
  // Siebel kabhi file ko NAYE TAB me text ki tarah khol deta hai (download nahi) -> us tab ka text utha lenge
  let popup = null;
  const onTarget = async (t) => { if (t.type() === 'page') { try { popup = await t.page(); } catch {} } };
  page.browser().on('targetcreated', onTarget);
  // Siebel ke alert (jaise "Error retrieving next record from the database (SBL-DBC-00104)") — OK dabao, yaad rakho
  const alerts = [];
  const onDialog = async (d) => { alerts.push(d.message()); log('[service] Hero Connect alert: ' + d.message()); await d.accept().catch(() => {}); };
  page.on('dialog', onDialog);

  // Siebel dheere load hota hai (blank screen) — har step ke baad "ready" ka intezaar
  await sleep(4000);                                                // login ke baad Siebel ko settle hone do
  // URL se seedha nahi — login ke baad "JobCard Invoices" TAB pe click (jaise haath se). Tab na mile tabhi URL.
  const clickTab = async (text) => {
    const r = await page.evaluate((T) => {
      const norm = (x) => (x || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 2 && b.height > 2 && getComputedStyle(e).visibility !== 'hidden'; };
      // Siebel screen tab: <li role="tab" aria-label="JobCard Invoices ..."><a class="ui-tabs-anchor" data-tabindex="tabScreenN">JobCard Invoices</a>
      const cands = [
        ...[...document.querySelectorAll('a.ui-tabs-anchor')].filter((e) => norm(e.textContent) === norm(T)),
        ...[...document.querySelectorAll('li[role="tab"]')].filter((e) => norm(e.getAttribute('aria-label')).startsWith(norm(T))).map((li) => li.querySelector('a') || li),
        ...[...document.querySelectorAll('[role="tab"] a, .siebui-nav-tab a, li a, a, span')].filter((e) => norm(e.textContent) === norm(T)),
      ];
      const v = cands.find(vis);
      if (v) { v.scrollIntoView({ block: 'center' }); const b = v.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }
      // tab overflow (▼) wali list: <select> ke option me ho
      for (const sel of document.querySelectorAll('select')) {
        const o = [...sel.options].find((op) => norm(op.text) === norm(T));
        if (o) { sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return { select: true }; }
      }
      return null;
    }, text).catch(() => null);
    if (r && r.x) await page.mouse.click(r.x, r.y);
    return !!r;
  };
  // Tab tabhi dabao jab poora dikh raha ho (page load ho chuka). URL se seedha NAHI — us ID ko view ki permission nahi milti.
  const tabVisible = (T) => page.evaluate((T) => {
    const norm = (x) => (x || '').replace(/\s+/g, ' ').trim().toLowerCase();
    return [...document.querySelectorAll('a, li, span, [role="tab"]')].some((e) => { const b = e.getBoundingClientRect(); return (norm(e.textContent) === norm(T) || (e.getAttribute('role') === 'tab' && norm(e.getAttribute('aria-label')).startsWith(norm(T)))) && b.width > 2 && b.height > 2; })
      || [...document.querySelectorAll('select option')].some((o) => norm(o.text) === norm(T));   // ▼ wali list me chhupa ho
  }, T).catch(() => false);
  for (let t = 0; t < 3; t++) {
    await say(page, 'Home page load hone ka intezaar — "JobCard Invoices" tab dikhe tab click');
    const t0 = Date.now(); let seenTab = false;
    while (Date.now() - t0 < 90000) { if (await tabVisible('JobCard Invoices')) { seenTab = true; break; } await sleep(1000); }
    if (!seenTab) { await shot(page, 'atka'); throw new Error('"JobCard Invoices" tab 90 sec me nahi dikha — screenshots/svc-atka.png'); }
    await sleep(2500);                                                // tab dikhne ke baad bhi thoda ruko (fields settle)
    await clickTab('JobCard Invoices'); await say(page, '"JobCard Invoices" tab pe click');
    await sleep(4000); await waitSiebel(page, 60000);
    // is ID ko "Invoices" (HHML JC Invoice View) ki permission nahi — "Invoices BIP" (HMCL JC Invoice View BIP) wala chalta hai
    if (await tabVisible('Invoices BIP')) { await sleep(1500); await clickTab('Invoices BIP'); await say(page, '"Invoices BIP" pe click'); await sleep(3000); }
    if (await waitSiebel(page, 45000)) break;
    const seen = await page.evaluate(() => ({ url: location.href.slice(0, 90), title: document.title, txt: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 140),
      login: !!document.querySelector('input[name="SWEPassword"]') })).catch((e) => ({ err: e.message }));
    log('[service] page pe dikh raha: ' + JSON.stringify(seen));
    const deny = /responsibility of user '([^']+)' does not allow accessing view/i.exec(seen.txt || '');
    if (deny) throw new Error(`Hero Connect ne mana kiya: ID "${deny[1]}" ko is view ki permission nahi mili (tab click ke baad bhi) — screenshots/svc-blank-*.png dekho`);
    if (seen.login) throw new Error('Hero Connect wapas LOGIN page pe bhej raha hai — Service ID/password galat/expire, ya ye ID kisi aur jagah (browser) me khuli hai');
    await say(page, `page blank/loading — dobara khol raha hu (${t + 1}/3)`);
    await shot(page, `blank-${t + 1}`);
  }
  if (!(await waitSiebel(page, 5000))) { await shot(page, 'atka'); throw new Error('JobCard Invoice page 3 baar me bhi load nahi hua (Hero Connect dheema/band?) — screenshots/svc-atka.png'); }
  await sleep(2000);
  await shot(page, '1-view'); await say(page, '1/5 JobCard Invoice page khula');

  // Query (🔍) — pehle visible button, warna hidden wala bhi (JS click), warna Alt+Q
  const clickQuery = () => page.evaluate(() => {
    const all = [...document.querySelectorAll('button.siebui-icon-newquery, button[title="Query"], button[aria-label*="Query" i]')];
    const b = all.find((e) => e.offsetParent !== null) || all[0];
    if (b) { b.click(); return true; } return false;
  });
  await say(page, '🔍 Query button daba raha hu');
  let qClicked = await clickQuery();
  if (!qClicked) { await page.keyboard.down('Alt'); await page.keyboard.press('KeyQ'); await page.keyboard.up('Alt'); }
  await sleep(1500);
  await waitSiebel(page, 20000);

  // Invoice Created Date: query row ka cell <td id="1_s_2_l_HHML_Invoice_Date" role="gridcell"> — click karo tab input banta hai
  const sel = 'input[name="HHML_Invoice_Date"], input[id$="_HHML_Invoice_Date"]';
  const cellSel = 'td[role="gridcell"][id$="_HHML_Invoice_Date"], td[id^="1_"][id$="HHML_Invoice_Date"], td[id$="HHML_Invoice_Date"]';
  let ok = false;
  for (let i = 0; i < 5 && !ok; i++) {
    if (await page.$(sel)) { ok = true; break; }
    await waitSiebel(page, 10000);
    const cell = await page.waitForSelector(cellSel, { visible: true, timeout: 15000 }).catch(() => null);
    if (cell) { await say(page, 'Invoice Created Date ke khaane pe click'); await cell.click().catch(() => {}); await sleep(1500); }
    ok = !!(await page.waitForSelector(sel, { visible: true, timeout: 10000 }).catch(() => null));
    if (!ok && (i === 1 || i === 3)) {                              // query mode shayad laga hi nahi — dobara
      qClicked = await clickQuery();
      if (!qClicked) { await page.keyboard.down('Alt'); await page.keyboard.press('KeyQ'); await page.keyboard.up('Alt'); }
      await sleep(3000);
    }
  }
  if (!ok) {
    await shot(page, 'atka');
    const ids = await page.evaluate(() => [...document.querySelectorAll('[id*="Invoice" i]')].slice(0, 6).map((e) => e.tagName + '#' + e.id).join(', ')).catch(() => '');
    throw new Error(`Query mode me "Invoice Created Date" box nahi mila — screenshots/svc-atka.png${ids ? ' | page pe: ' + ids : ' | page khali tha (load nahi hua)'}`);
  }
  const box = await page.$(sel);
  await box.click({ clickCount: 3 }); await sleep(200);
  await box.type(q(range), { delay: 25 });
  const typed = await box.evaluate((e) => e.value).catch(() => '?');
  await shot(page, '2-query'); await say(page, '2/5 date likhi — box me ab hai: "' + typed + '"');
  // SIRF "Invoice List" applet ka Go / counter — neeche "Invoice Line Items" applet ka apna Go aur "No Records" hota hai (wahi dhoka de raha tha)
  const ap = await page.evaluate(() => {                              // td id "1_s_2_l_HHML_Invoice_Date" -> "s_2"
    const td = document.querySelector('input[name="HHML_Invoice_Date"]')?.closest('td') || document.querySelector('td[id$="HHML_Invoice_Date"]');
    return (td?.id.match(/(s_\d+)_l_/) || [])[1] || 's_2';
  });
  const GO = `button[title="Invoice List:Go"], button[aria-label="Invoice List:Go"], button[id^="${ap}_1_"].siebui-icon-executequery`;
  const goVisible = () => page.evaluate((G) => [...document.querySelectorAll(G)].some((e) => e.offsetParent !== null), GO).catch(() => false);
  const clickGo = async () => {
    const id = await page.evaluate((G) => [...document.querySelectorAll(G)].find((e) => e.offsetParent !== null)?.id || null, GO);
    if (id) { await page.click(`[id="${id}"]`).catch(() => {}); return true; } return false;
  };
  await say(page, `Go (→) daba raha hu [Invoice List applet ${ap}]`);
  if (!(await clickGo())) { await say(page, 'Invoice List ka Go nahi mila — Enter dabaya'); await page.keyboard.press('Enter'); }   // sirf EK baar

  // result: query mode me counter <span id="s_2_rc" class="siebui-row-counter siebui-no-display hidden"> chhupa hota hai.
  // Result aate hi wo DIKHNE lagta hai ("1 - 10 of 57" / "No Records") -> turant aage
  let empty = false, counter = '';
  const t0q = Date.now();
  while (Date.now() - t0q < 120000) {
    await sleep(500);
    const st = await page.evaluate((AP) => {
      const c = document.getElementById(AP + '_rc');
      const shown = !!c && c.offsetParent !== null && !/siebui-no-display|hidden/.test(c.className);
      return { shown, text: (c?.textContent || '').trim() };
    }, ap).catch(() => ({ shown: false, text: '' }));
    if (st.shown && /of\s*\d|no records/i.test(st.text)) { counter = st.text; break; }
  }
  await sleep(800);
  counter = (await page.evaluate((AP) => (document.getElementById(AP + '_rc')?.textContent || '').trim(), ap).catch(() => counter)) || counter;
  if (/no records|^0\s*-\s*0/i.test(counter)) empty = true;           // No Records = data nahi -> export mat karo
  await shot(page, '3-result'); await say(page, '3/5 result aaya ' + (empty ? '(koi record nahi)' : counter));
  if (empty) return { file: null, rows: [], empty: true };

  // applet menu (⚙ gear) -> Export...
  // <button id="s_at_m_2" class="siebui-appletmenu-btn" title="Invoice List: Menu"> -> <ul id="s_at_m_2-menu">
  //   <li data-caption="Export..." aria-disabled="false"><a class="ui-menu-item-wrapper">Export...</a>
  let ex = 'notfound';
  for (let i = 0; i < 3 && ex !== 'ok'; i++) {
    const btnId = await page.evaluate(() => {
      const all = [...document.querySelectorAll('button.siebui-appletmenu-btn, button[id^="s_at_m_"]')].filter((e) => e.offsetParent !== null);
      const b = all.find((e) => /invoice list/i.test(e.title || e.getAttribute('aria-label') || '')) || all[0];
      if (!b) return null;
      b.scrollIntoView({ block: 'center' });
      return b.id;
    });
    if (!btnId) { await sleep(2000); continue; }
    await page.click(`[id="${btnId}"]`).catch(() => {});          // real mouse click (jQuery UI menu)
    const li = await page.waitForSelector(`[id="${btnId}-menu"] li[data-caption="Export..."]`, { timeout: 8000 }).catch(() => null);
    if (!li) { await page.keyboard.press('Escape'); await sleep(1500); continue; }
    if (await li.evaluate((e) => e.getAttribute('aria-disabled') === 'true')) { ex = 'disabled'; break; }   // Export band = data nahi
    const a = (await li.$('a')) || li;
    await a.evaluate((e) => e.scrollIntoView({ block: 'center' }));   // menu lamba hai, Export neeche hai
    await sleep(400);
    await a.hover().catch(() => {});
    await a.click().catch(async () => { await a.evaluate((e) => e.click()); });
    ex = 'ok';
  }
  if (ex === 'disabled') { await shot(page, 'atka'); await say(page, 'Export band (disabled) — is date me data nahi'); return { file: null, rows: [], empty: true }; }
  if (ex !== 'ok') { await shot(page, 'atka'); throw new Error(`Export... menu ${ex === 'disabled' ? 'band (disabled)' : 'nahi mila'} — screenshots/svc-atka.png`); }
  // Export dialog: <button id="s_3_1_89_0_Ctrl" title="Export Form:Next" class="siebui-icon-export">
  const NEXT = 'button[title="Export Form:Next"], button[aria-label="Export Form:Next"], button[data-display="Next"].siebui-icon-export';
  const nextBtn = await page.waitForSelector(NEXT, { visible: true, timeout: 30000 }).catch(() => null);
  if (!nextBtn) { await shot(page, 'atka'); throw new Error('Export dialog ka Next button nahi aaya — screenshots/svc-atka.png'); }
  await sleep(800);
  // radio: "All Rows In Current Query" + "Comma Separated" — label text radio ke theek baad hota hai
  const picked = await page.evaluate(() => {
    const txt = (r) => {
      const lab = (r.id && document.querySelector(`label[for="${r.id}"]`)) || r.closest('label');
      if (lab) return lab.textContent || '';
      let t = '', n = r.nextSibling; while (n && t.length < 60) { t += n.textContent || ''; if (n.nodeType === 1 && n.matches('input')) break; n = n.nextSibling; }
      return t || r.parentElement?.textContent || '';
    };
    const radios = [...document.querySelectorAll('input[type="radio"]')].filter((r) => r.offsetParent !== null);
    const out = [];
    for (const re of [/all rows/i, /comma/i]) { const r = radios.find((x) => re.test(txt(x))); if (r) { r.click(); out.push(txt(r).trim().slice(0, 25)); } }
    // Columns To Export = "All" (Visible nahi) — tabhi technician ka naam aata hai
    // <input type="radio" name="s_5_1_46_0" value="All" aria-label="All"> ... <input value="Visible Columns">
    const colAll = radios.find((x) => (x.value === 'All' || x.getAttribute('aria-label') === 'All')
      && radios.some((y) => y.name === x.name && /visible columns/i.test(y.value || y.getAttribute('aria-label') || '')));
    if (colAll) { colAll.click(); out.push('Columns: All'); } else out.push('⚠ Columns All NAHI mila');
    return out;
  });
  await say(page, 'export options: ' + (picked.join(' + ') || 'default (Tab)'));   // Tab bhi chalega, parser dono padhta hai
  await sleep(500);
  await shot(page, '4-export'); await say(page, '4/5 Export dialog — Next dabaya, file ka intezaar');
  await sleep(1500);                                                  // radio badalne pe Siebel dialog refresh karta hai
  const nb = await page.waitForSelector(NEXT, { visible: true, timeout: 10000 }).catch(() => null);   // TAAZA Next
  if (!nb) { await shot(page, 'atka'); throw new Error('Next button gayab — screenshots/svc-atka.png'); }
  await nb.click().catch(async () => { await page.evaluate((N) => document.querySelector(N)?.click(), NEXT); });
  await sleep(2500);
  const stillOpen = await page.$(NEXT).then((e) => e && e.evaluate((x) => x.offsetParent !== null)).catch(() => false);
  await say(page, stillOpen ? '⚠ Next dabaya par dialog abhi bhi khula hai' : 'Next daba — dialog band, file aa rahi hai');
  let file = null; const t0 = Date.now(); let lastLog = 0;
  const LIMIT = 6 * 60000;                                             // 6 mahine ka data bada hota hai — 6 min tak
  while (Date.now() - t0 < LIMIT) {
    const el = Date.now() - t0;
    const now = fs.readdirSync(downloadDir);
    const busyDl = now.some((f) => /\.(crdownload|tmp)$/i.test(f)) || dl.state === 'inProgress';
    const got = now.filter((f) => !/\.(crdownload|tmp)$/i.test(f) && !f.startsWith('.'));
    if (got.length && !busyDl) { file = path.join(downloadDir, got[0]); break; }
    // file galti se PC ke normal Downloads folder me chali gayi? -> wahan se utha lo
    if (el > 4000) {
      const home = path.join(os.homedir(), 'Downloads');
      try {
        const fresh = fs.readdirSync(home).filter((f) => !/\.(crdownload|tmp)$/i.test(f))
          .map((f) => ({ f, t: fs.statSync(path.join(home, f)).mtimeMs })).filter((x) => x.t > t0 - 2000).sort((x, y) => y.t - x.t)[0];
        if (fresh && !now.some((f) => /\.crdownload$/i.test(f))) {
          file = path.join(downloadDir, fresh.f); fs.copyFileSync(path.join(home, fresh.f), file);
          await say(page, `file PC ke Downloads folder me mili (${fresh.f}) — wahan se utha li`); break;
        }
      } catch {}
    }
    if (alerts.length && !dl.started && el > 4000) {
      page.off('dialog', onDialog);
      await shot(page, 'atka');
      throw new Error('Export pe Hero Connect ne error diya: "' + alerts[alerts.length - 1] + '" — ye Hero ke server ki taraf se hai. Thodi der baad ya chhoti date range (10-15 din) se dobara karo');
    }
    if (dl.state === 'canceled') { await shot(page, 'atka'); throw new Error('Download CANCEL ho gaya (Chrome ne roka) — screenshots/svc-atka.png'); }
    // naya tab khula jisme text hai? -> wahi file hai
    if (popup && !dl.started && el > 5000) {
      const txt = await popup.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (txt && txt.split('\n').length > 1 && /[\t,]/.test(txt.split('\n')[0])) {
        file = path.join(downloadDir, 'jc-invoices-popup.txt'); fs.writeFileSync(file, txt, 'utf8');
        await say(page, 'file naye tab me khuli thi — text utha liya'); await popup.close().catch(() => {}); break;
      }
    }
    if (el - lastLog > 20000) {
      lastLog = el;
      await say(page, `5/5 intezaar ${Math.round(el / 1000)}s | download: ${dl.started ? dl.state + ' ' + Math.round(dl.bytes / 1024) + ' KB' : 'abhi shuru nahi hua'} | folder: ${now.join(', ') || 'khaali'}`);
      await shot(page, '5-wait');
    }
    await sleep(700);
  }
  page.browser().off('targetcreated', onTarget);
  page.off('dialog', onDialog);
  if (!file) {
    await shot(page, 'atka');
    throw new Error(dl.started ? `Download shuru hua (${dl.started}) par poora nahi hua — ${Math.round(dl.bytes / 1024)} KB aaya` : 'Next ke baad download shuru hi nahi hua — screenshots/svc-5-wait.png dekho');
  }
  await sleep(500);
  await say(page, `file mili: ${path.basename(file)} (${Math.round(fs.statSync(file).size / 1024)} KB)`);
  return { file, rows: parseSiebelExport(file) };
}

// purana stub (index.js use karta hai)
export async function scrapeService() { return []; }
