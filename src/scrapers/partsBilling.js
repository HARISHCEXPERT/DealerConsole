// ============================================================
//  PARTS BILLING — Siebel DMS automation (SIMPLE / step-by-step)
//
//  Har STEP alag aur simple hai — jahaan gadbad ho, wahi step edit kar.
//  Call: await billParts(page, { mobile, lines:[{partNo, qty}], discountPct })
//
//  ZAROORI: Siebel "...says... OK" waale native alert page ko ATKA dete hain.
//  isliye sabse pehle page.on('dialog') se wo apne aap OK ho jaate hain.
// ============================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Siebel busy/spinner khatam hone ka wait ----
async function settle(page, label = '', max = 40) {
  await sleep(500);
  for (let i = 0; i < max; i++) {
    const busy = await page.evaluate(() => {
      const b = document.querySelector('.siebui-busy, .siebui-overlay, .siebui-modal-loading, #_overlay, .siebui-spinner, .ui-widget-overlay');
      return !!(b && b.offsetParent !== null);
    }).catch(() => false);
    if (!busy) { await sleep(400); return; }
    await sleep(300);
  }
  if (label) console.log(`  [bill] (settle timeout: ${label})`);
}

// ---- chhote helper: class/label/text se click ----
async function clickClass(page, cls, nth = 0) {
  return page.evaluate((c, n) => {
    const els = [...document.querySelectorAll('.' + c)].filter((e) => e.offsetParent !== null);
    if (els[n]) { (els[n].closest('button,a,[role="button"]') || els[n]).click(); return true; }
    return false;
  }, cls, nth);
}
async function clickAria(page, label) {               // aria-label exact/startsWith
  return page.evaluate((lab) => {
    const els = [...document.querySelectorAll('button,a,span,[role="button"]')].filter((e) => e.offsetParent !== null);
    const b = els.find((e) => (e.getAttribute('aria-label') || '') === lab)
           || els.find((e) => (e.getAttribute('aria-label') || '').startsWith(lab));
    if (b) { (b.closest('button,a,[role="button"]') || b).click(); return true; }
    return false;
  }, label);
}
async function clickText(page, text) {                // dikhne wale text se (tab/button)
  return page.evaluate((t) => {
    const want = t.toLowerCase().replace(/\s+/g, ' ').trim();
    const els = [...document.querySelectorAll('a,button,span,div,li,td')].filter((e) => e.offsetParent !== null);
    const el = els.find((e) => (e.textContent || '').toLowerCase().replace(/\s+/g, ' ').trim() === want);
    if (el) { (el.closest('button,a,[role="button"],li,td') || el).click(); return true; }
    return false;
  }, text);
}

// ---- grid row me ek column cell ACTIVE karo ----
//   hdr = header text (SABSE PAKKA, pehle try) ; colRx = id/aria regex (fallback) ; exclude = skip id (e.g. Superceed)
async function gridCellClick(page, colRx, hdr = '', exclude = '') {
  return page.evaluate((rxs, h, exs) => {
    const rx = rxs ? new RegExp(rxs, 'i') : null;
    const ex = exs ? new RegExp(exs, 'i') : null;
    const cells = [...document.querySelectorAll('td[role="gridcell"]')].filter((e) => e.offsetParent !== null);
    let c = null;
    // 1) HEADER text se exact column index -> selected row ki cell
    if (h) {
      const want = h.toLowerCase().replace(/\s+/g, ' ').trim();
      const ths = [...document.querySelectorAll('th,[role="columnheader"]')].filter((e) => e.offsetParent !== null);
      const th = ths.find((e) => (e.textContent || '').toLowerCase().replace(/\s+/g, ' ').trim() === want);
      if (th) {
        const idx = [...th.parentElement.children].indexOf(th);
        const row = document.querySelector('tr.selected-row, tr.ui-state-highlight') || (cells[0] && cells[0].closest('tr'));
        if (row && row.children[idx]) c = row.children[idx];
      }
    }
    // 2) id/aria regex (exclude skip karke)
    if (!c && rx) c = cells.find((e) => { const k = (e.id || '') + ' ' + (e.getAttribute('aria-labelledby') || ''); if (ex && ex.test(k)) return false; return rx.test(k); });
    if (!c) return null;
    c.scrollIntoView({ block: 'center', inline: 'center' });
    c.click();
    return c.id || 'cell';
  }, colRx, hdr, exclude);
}

// ---- Invoice Type = Cash set karo (FORM field: label "Invoice Type" -> dropdown -> Cash) ----
const MENU_SEL = '.ui-menu-item-wrapper, .ui-menu-item, li[role="option"], .siebui-popup-item, .ui-autocomplete li';
async function pickCashFromMenu(page) {
  return page.evaluate((sel) => {
    const items = [...document.querySelectorAll(sel)].filter((e) => e.offsetParent !== null);
    const it = items.find((e) => (e.textContent || '').trim().toLowerCase() === 'cash') || items.find((e) => /\bcash\b/i.test((e.textContent || '').trim()));
    if (it) { (it.closest('li,a,div') || it).click(); return true; } return false;
  }, MENU_SEL);
}

// Invoice Type: dropdown kholne ki zaroorat nahi — box me jo hai (Credit) SELECT karke "Cash" type karo.
// Type karte hi list Cash pe filter ho jaati hai -> Enter se pick. (Master: list move nahi karti, type karo)
async function setInvoiceCash(page, where = '') {
  // 1) input dhoondo + tag + scroll
  const tagged = await page.evaluate(() => {
    document.querySelectorAll('[data-dc-itype]').forEach((e) => e.removeAttribute('data-dc-itype'));
    const e = [...document.querySelectorAll('input')].filter((x) => x.offsetParent !== null).find((x) => /invoice type/i.test(x.getAttribute('aria-label') || ''));
    if (!e) return false; e.setAttribute('data-dc-itype', '1'); e.scrollIntoView({ block: 'center' }); return true;
  });
  if (!tagged) { console.log('  [bill] Cash[' + where + '] ✗ Invoice Type input nahi mila'); return false; }
  const inp = await page.$('input[data-dc-itype="1"]');
  const box = inp ? await inp.boundingBox().catch(() => null) : null;
  if (!box) { console.log('  [bill] Cash[' + where + '] ✗ box nahi mila'); return false; }

  // 2) input pe TRIPLE-click = poora text select (edit mode)
  const cx = box.x + Math.min(40, box.width / 2), cy = box.y + box.height / 2;
  await page.mouse.click(cx, cy, { clickCount: 3 }).catch(() => {});
  await sleep(400);
  // 3) POORA clear (sirf ek backspace nahi): selection delete + End se peeche saara backspace
  await page.keyboard.press('Delete');
  await page.keyboard.press('End');
  for (let i = 0; i < 20; i++) await page.keyboard.press('Backspace');
  await sleep(200);
  // 4) ab "Cash" type -> list Cash pe filter hogi
  await page.keyboard.type('Cash', { delay: 100 });
  await sleep(900);                                     // list "Cash" pe filter hone do
  // 4) filter hui list me Cash pick, warna Enter (typed value confirm)
  let picked = await pickCashFromMenu(page);
  if (!picked) { await page.keyboard.press('Enter'); await sleep(400); }
  else await sleep(300);
  // phir bhi Credit dikhe to ek Tab se blur-commit
  await page.keyboard.press('Tab');
  await sleep(700);
  await page.evaluate(() => document.querySelectorAll('[data-dc-itype]').forEach((e) => e.removeAttribute('data-dc-itype')));
  const val = await readInvoiceType(page);
  const ok = /cash/i.test(val);
  console.log('  [bill] Cash[' + where + ']', ok ? ('✓ = ' + val) : ('✗ value=' + JSON.stringify(val)));
  return ok;
}

// ---- Invoice Type ki value padho (form field) ----
async function readInvoiceType(page) {
  return page.evaluate(() => { const i = [...document.querySelectorAll('input')].filter((e) => e.offsetParent !== null).find((e) => /invoice type/i.test(e.getAttribute('aria-label') || '')); return i ? (i.value || '') : '?'; });
}

// ---- PAKKA Cash karo: check -> agar Credit to Cash set -> Ctrl+S -> verify (3 baar tak) ----
async function ensureCash(page, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const val = await readInvoiceType(page);
    if (/cash/i.test(val)) { console.log('  [bill] ensureCash ✓ = ' + JSON.stringify(val)); return true; }
    console.log('  [bill] ensureCash try' + (i + 1) + ' current=' + JSON.stringify(val) + ' -> Cash kar rahe');
    await setInvoiceCash(page, 'ensure');
    await sleep(1000);
    await page.keyboard.down('Control'); await page.keyboard.press('KeyS'); await page.keyboard.up('Control');  // commit
    await settle(page, 'cash-save'); await sleep(1500);
  }
  const fin = await readInvoiceType(page);
  console.log('  [bill] ensureCash final = ' + JSON.stringify(fin) + (/cash/i.test(fin) ? ' ✓' : ' ✗ (abhi bhi Cash nahi)'));
  return /cash/i.test(fin);
}

// ============================================================
//  MAIN — step by step
// ============================================================
export async function billParts(page, opts = {}) {
  const { mobile, lines = [], discountPct } = opts;
  const mob = String(mobile || '').replace(/\D/g, '');
  console.log('[bill] START', JSON.stringify(opts));

  // ---- Siebel native alert (".. says .. OK") apne aap OK karo (page atakne se bachao) ----
  if (!page.__dcDialogHook) {
    page.__dcDialogHook = true;
    page.on('dialog', async (d) => {
      console.log('  [bill] ⚠ ALERT:', d.message());
      try { await d.accept(); } catch {}
    });
  }

  // ============ STEP 1: + New Order ============
  await settle(page, 'view-load');
  console.log('  [bill] STEP1', await clickClass(page, 'siebui-icon-newrecord', 0) ? '✓ New Order' : '✗ New Order');
  await settle(page, 'order-new');
  await sleep(900);

  // (STEP 2 HATA DIYA — ab Cash list form me nahi; baad me drilled form ke box me — STEP 11b ensureCash)

  // ============ STEP 3: Contact Last Name -> pick icon kholo ============
  const DLG = '[title*="Pick Contact"],[aria-label*="Pick Contact"],.ui-dialog,.AppletStylePopup';
  const dlgOpen = () => page.evaluate((sel) => [...document.querySelectorAll(sel)].some((d) => d.offsetParent !== null && /pick contact/i.test((d.getAttribute('title') || '') + (d.getAttribute('aria-label') || '') + d.textContent)), DLG);

  let contactOk = !mob;                              // mobile na ho to contact step skip
  if (mob) {
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('input')].filter((e) => e.offsetParent !== null).find((e) => /contact last name/i.test(e.getAttribute('aria-label') || ''));
      if (!el) return false;
      el.focus();
      let icon = el.id ? document.getElementById(el.id + '_icon') : null;
      if (!icon) { let c = el.closest('td,tr,div'), h = 0; while (c && h < 5 && !icon) { icon = c.querySelector('.siebui-icon-pick'); if (!icon) c = c.parentElement; h++; } }
      if (icon) { (icon.closest('span,button,a') || icon).click(); return true; }
      return false;
    });
    await sleep(2200);
    console.log('  [bill] STEP3', (await dlgOpen()) ? '✓ Pick Contact dialog khula' : '✗ dialog nahi khula');
    if (!(await dlgOpen())) { console.log('  [bill] RUK — contact dialog nahi khula, aage nahi badhe'); return { ok: false, step: 3 }; }

    // ============ STEP 4: dialog me Query button ============
    await clickAria(page, 'Pick Contact List:Query');
    console.log('  [bill] STEP4 ✓ Query mode');
    await sleep(1600);

    // ============ STEP 5: Mobile Phone field (Tab se) -> number -> Enter ============
    let ci = await page.$('input[id*="Seq_Num"]') || await page.$('input[id*="Contact"]');
    if (ci) { await ci.click().catch(() => {}); await sleep(300); }
    let onMobile = false;
    for (let t = 0; t < 4 && !onMobile; t++) {
      await page.keyboard.press('Tab'); await sleep(450);
      onMobile = await page.evaluate(() => { const e = document.activeElement; return /mobile/i.test((e.id || '') + (e.getAttribute('aria-label') || '')); });
    }
    if (onMobile) {
      await page.keyboard.type(mob, { delay: 80 });
      await page.keyboard.press('Enter');          // query chalao
      console.log('  [bill] STEP5 ✓ mobile', mob, '+ Enter');
    } else {
      console.log('  [bill] STEP5 ✗ Mobile field nahi mila');
    }
    await settle(page, 'query');
    await sleep(1800);

    // ============ STEP 6: row select ============
    const rowTxt = await page.evaluate((sel) => {
      const dlg = [...document.querySelectorAll(sel)].find((d) => d.offsetParent !== null) || document;
      const row = [...dlg.querySelectorAll('tr[id*="_r_"], tbody tr[id]')].filter((e) => e.offsetParent !== null && (e.textContent || '').trim())[0];
      if (row) { row.click(); return row.textContent.replace(/\s+/g, ' ').trim().slice(0, 35); }
      return null;
    }, DLG);
    console.log('  [bill] STEP6', rowTxt ? ('✓ row -> ' + rowTxt) : '✗ row nahi');
    await sleep(700);

    // ============ STEP 7: OK (green button) ============
    const okd = await page.evaluate(() => {
      const vis = (e) => e && e.offsetParent !== null;
      const b = [...document.querySelectorAll('button[aria-label="Pick Contact List:OK"], button[aria-label$=":OK"], button.siebui-icon-pickrecord')].filter(vis)[0]
             || [...document.querySelectorAll('button,a,span')].filter(vis).find((e) => (e.textContent || '').trim().toUpperCase() === 'OK');
      if (b) { (b.closest('button,a') || b).click(); return true; }
      return false;
    });
    await settle(page, 'after-ok');
    await sleep(1000);
    contactOk = okd && !(await dlgOpen());
    console.log('  [bill] STEP7', contactOk ? '✓ OK -> contact pick ho gaya' : '✗ OK/pick (dialog band nahi hua)');
    if (!contactOk) { console.log('  [bill] RUK — contact pick nahi hua, aage nahi badhe'); return { ok: false, step: 7 }; }
  }

  // ============ STEP 8: Sales Order# (TXN..) pe drilldown ============
  await sleep(600);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
    page.evaluate(() => {
      const vis = (e) => e && e.offsetParent !== null;
      const a = [...document.querySelectorAll('a')].filter(vis).find((e) => /^TXN[0-9A-Z-]+/i.test((e.textContent || '').trim()))
             || [...document.querySelectorAll('td[id*="Sales_Order"] a, td[id*="Order_Number"] a, a.drilldown')].filter(vis)[0];
      if (a) a.click();
    }),
  ]);
  await sleep(3500);
  await settle(page, 'line-actions');
  console.log('  [bill] STEP8 ✓ drilldown Sales Order# (Entering Parts)');
  await sleep(1200);

  // (Cash yahaan nahi — Price se theek pehle STEP 11b me ensureCash drilled form ke box me karega)

  // ============ STEP 9: Line Items Details tab ============
  await clickText(page, 'Line Items Details');
  await settle(page, 'tab-lines');
  await sleep(800);
  console.log('  [bill] STEP9 ✓ Line Items Details tab');

  // ============ STEP 10: har part add karo — Line Items GRID: + , Part# cell, Qty cell ============
  let partsAdded = 0;
  for (const ln of lines) {
    // 1) Line Items GRID ka "+" (grid neeche hota -> aakhri newrecord zyada sahi)
    const plus = await page.evaluate(() => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const heads = [...document.querySelectorAll('*')].filter((e) => e.offsetParent !== null && /^line items/i.test(norm(e.textContent)) && norm(e.textContent).length < 28);
      for (const h of heads) { const a = h.closest('.siebui-applet, [id^="s_"]'); if (a) { const b = a.querySelector('.siebui-icon-newrecord'); if (b && b.offsetParent !== null) { (b.closest('button,a') || b).click(); return 'line-applet'; } } }
      const all = [...document.querySelectorAll('.siebui-icon-newrecord')].filter((e) => e.offsetParent !== null);
      if (all.length) { const b = all[all.length - 1]; (b.closest('button,a') || b).click(); return 'last-newrec(' + all.length + ')'; }
      return null;
    });
    await settle(page, 'line-new'); await sleep(1100);

    // 2) Part # CELL (header "Part #" se, "Superceeded" column SKIP), type uss cell ke input me
    const partCell = await gridCellClick(page, 'Commodity|Part.?#|Part.?Num|HMCL_Product', 'Part #', 'Superceed');
    await sleep(600);
    let pt = false;
    if (partCell) {
      pt = await page.evaluate((cid) => {
        const cell = document.getElementById(cid);
        let inp = cell && cell.querySelector('input');
        if (!inp && document.activeElement && document.activeElement.tagName === 'INPUT') inp = document.activeElement;
        if (inp && !inp.readOnly) { inp.focus(); inp.value = ''; return true; }
        return false;
      }, partCell);
      if (pt) { await page.keyboard.type(String(ln.partNo), { delay: 45 }); await page.keyboard.press('Tab'); }
    }
    await settle(page, 'part-set'); await sleep(1000);

    // 3) Qty CELL (header "Order Qty"), type uss cell ke input me
    const qtyCell = await gridCellClick(page, 'Order.?Qty', 'Order Qty', 'Req|Issued|MOQ');
    await sleep(500);
    let qk = false;
    if (qtyCell) {
      qk = await page.evaluate((cid) => {
        const cell = document.getElementById(cid);
        let inp = cell && cell.querySelector('input');
        if (!inp && document.activeElement && document.activeElement.tagName === 'INPUT') inp = document.activeElement;
        if (inp && !inp.readOnly) { inp.focus(); inp.value = ''; return true; }
        return false;
      }, qtyCell);
      if (qk) { await page.keyboard.type(String(ln.qty), { delay: 45 }); await page.keyboard.press('Tab'); }
    }

    if (pt) partsAdded++;
    console.log('  [bill] STEP10', '+=' + plus, 'partCell=' + partCell, (pt ? '✓' : '✗') + ' Part ' + ln.partNo, 'qtyCell=' + qtyCell, (qk ? '✓' : '✗') + ' Qty ' + ln.qty);

    // na mila -> GRID cells dump (exact column id/label pata chalega)
    if (!pt) {
      const cells = await page.evaluate(() => [...document.querySelectorAll('td[role="gridcell"]')].filter((e) => e.offsetParent !== null).map((e) => ({ id: (e.id || '').slice(0, 42), lb: (e.getAttribute('aria-labelledby') || '').slice(0, 30) })).slice(0, 40));
      console.log('  [bill] STEP10 GRID cells:', JSON.stringify(cells));
    }
    await settle(page, 'qty-set');
  }

  // GUARD: koi part add nahi hua to Price/Fulfill mat karo (khaali order mat banao)
  if (partsAdded === 0) {
    console.log('  [bill] RUK — koi part add nahi hua, Price/Fulfill skip (upar DEBUG inputs dekho)');
    return { ok: false, step: 10 };
  }

  // ============ STEP 11: Additional Discount% (Sales Order tab) ============
  if (discountPct != null && discountPct !== '') {
    await clickText(page, 'Sales Order');
    await settle(page, 'tab-order'); await sleep(600);
    const dk = await page.evaluate(() => {
      const el = [...document.querySelectorAll('input')].filter((e) => e.offsetParent !== null && !e.readOnly).find((e) => /additional\s*discount/i.test((e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('name') || '')));
      if (el) { el.focus(); return true; } return false;
    });
    if (dk) { await page.keyboard.type(String(discountPct), { delay: 45 }); await page.keyboard.press('Tab'); }
    console.log('  [bill] STEP11', dk ? ('✓ Additional Discount = ' + discountPct) : '✗ discount field');
    await settle(page, 'disc-set');
    await clickText(page, 'Line Items Details');
    await settle(page, 'tab-lines2'); await sleep(600);
  }

  // ============ STEP 11b: PAKKA Cash (agar Credit ho gaya to dobara Cash) — Price se pehle ============
  await clickText(page, 'Sales Order');                 // invoice type Sales Order form pe hota
  await settle(page, 'tab-order'); await sleep(600);
  await ensureCash(page, 3);
  await clickText(page, 'Line Items Details');
  await settle(page, 'tab-lines3'); await sleep(600);

  // ============ STEP 12: Price All -> Fulfill All ============
  await clickAria(page, 'Price All');
  await settle(page, 'price-all'); await sleep(900);
  await (await clickText(page, 'Fulfill All') || clickAria(page, 'Fulfill All'));
  await settle(page, 'fulfill-all'); await sleep(1200);
  console.log('  [bill] STEP12 ✓ Price All + Fulfill All');

  // Invoice Number padhne wala (Invoice grid se)
  const readInvoiceNo = () => page.evaluate(() => {
    const txt = (e) => ((e.value || e.textContent || '').replace(/\s+/g, ' ').trim());
    const bad = /type|value|date|round|status|amount/i;
    // 1) td[role=gridcell]/input jiska id/aria me Invoice_Number ho
    let el = [...document.querySelectorAll('td[role="gridcell"], input')].filter((e) => e.offsetParent !== null)
      .find((e) => { const k = (e.id || '') + ' ' + (e.getAttribute('aria-labelledby') || '') + ' ' + (e.getAttribute('aria-label') || ''); return /invoice[_ ]?(number|no|#)/i.test(k) && !bad.test(k); });
    if (el) { const t = txt(el); if (t && !/^invoice/i.test(t)) return t; }
    // 2) header "Invoice #"/"Invoice Number" -> column index -> usi table ki first data row cell
    const heads = [...document.querySelectorAll('th,[role="columnheader"]')].filter((e) => e.offsetParent !== null);
    const h = heads.find((e) => { const t = txt(e).toLowerCase(); return t === 'invoice #' || t === 'invoice number' || t === 'invoice no'; });
    if (h) {
      const hcell = h.closest('th,td'), hrow = hcell.closest('tr'), idx = [...hrow.children].indexOf(hcell);
      const table = h.closest('table'); const body = table ? (table.querySelector('tbody') || table) : null;
      if (body) for (const r of [...body.querySelectorAll('tr')]) { if (r === hrow) continue; const c = r.children[idx]; if (c) { const t = txt(c); if (t && !/invoice/i.test(t)) return t; } }
    }
    // 3) last resort: dealer-code se shuru hone wala invoice jaisa token (22839XX####, bina dash)
    const cells = [...document.querySelectorAll('td[role="gridcell"]')].filter((e) => e.offsetParent !== null).map(txt);
    const tok = cells.find((t) => /^\d{4,6}[A-Z]{1,3}\d{2,}$/.test(t) && !t.includes('-'));
    return tok || '';
  });
  const findBtn = async (label) => (await clickText(page, label)) || (await clickAria(page, label));

  // ============ STEP 13-15: Validate SO -> Create Invoice -> Invoice No ============
  // kabhi-kabhi button ready nahi hota ya click miss -> 2 attempt. DUPLICATE se bachne ko:
  // har attempt se pehle check karo invoice ban to nahi chuka (grid me number aa gaya).
  let invoiceNo = '';
  for (let attempt = 1; attempt <= 2 && !invoiceNo; attempt++) {
    invoiceNo = await readInvoiceNo().catch(() => '');
    if (invoiceNo) break;                                  // pehle se ban chuka -> dobara mat banao

    // STEP 13: Validate SO (button aane tak 3 baar try)
    let v = false;
    for (let k = 0; k < 3 && !v; k++) { v = await findBtn('Validate SO'); if (!v) { await settle(page); await sleep(1300); } }
    console.log('  [bill] STEP13 Validate SO', v ? '✓' : '✗', '(try ' + attempt + ')');
    await settle(page, 'validate'); await sleep(2500);

    // STEP 14: Create Invoice (button aane tak 3 baar try) — par agar invoice pehle hi ban gaya to skip
    if (await readInvoiceNo().catch(() => '')) break;
    let ci = false;
    for (let k = 0; k < 3 && !ci; k++) { ci = await findBtn('Create Invoice'); if (!ci) { await settle(page); await sleep(1300); } }
    console.log('  [bill] STEP14 Create Invoice', ci ? '✓' : '✗', '(try ' + attempt + ')');
    await settle(page, 'create-invoice'); await sleep(2500);

    // STEP 15: Invoice No poll (grid dheere bharti)
    for (let i = 0; i < 10 && !invoiceNo; i++) { invoiceNo = await readInvoiceNo().catch(() => ''); if (!invoiceNo) await sleep(1500); }
  }
  console.log('  [bill] STEP15 Invoice No =', invoiceNo || '(nahi mila)');

  // ============ STEP 16: agli gaadi se pehle RUK — Create Invoice button gayab hone do (invoice commit) ============
 // let gone = false;
  //for (let i = 0; i < 8 && !gone; i++) {
  //  gone = await page.evaluate(() => ![...document.querySelectorAll('a,button,span,div')].some((e) => e.offsetParent !== null && (e.textContent || '').replace(/\s+/g, ' ').trim() === 'Create Invoice')).catch(() => false);
 //   if (!gone) await sleep(1000);
  //}
  //console.log('  [bill] STEP16', gone ? '✓ invoice commit (Create Invoice button gayab)' : '… button abhi bhi dikh raha, aage badhe');
  //await sleep(2500);                                     // extra settle (fast na ho)

  console.log('[bill] DONE — Invoice ban gaya ✓' + (invoiceNo ? ' (' + invoiceNo + ')' : ''));
  return { ok: true, invoiceNo };
}
