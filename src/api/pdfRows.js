// ============================================================
//  Text wali PDF (copy-paste hone wali) -> table rows  [[cell, cell, ...], ...]
//  Har page ke text ke tukde x/y ke saath aate hain:
//   1) ek hi line (y) ke tukde jodo, paas-paas wale ek cell
//   2) heading wali line (Date + Debit/Credit ya Amount) dhoondho — uske column ki jagah (x) yaad
//   3) neeche ki har line ka har cell us column me jisse sabse zyada milta ho
//   4) bina date + bina amount wali line = upar wali entry ke particulars ka hissa (2 line ka narration)
//  Scan PDF (photo) me text hota hi nahi -> saaf error
// ============================================================
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
let _pdf = null;
async function pdfjs() {
  if (_pdf) return _pdf;
  _pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
  _pdf.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
  return _pdf;
}

const T = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const isDate = (s) => /^\d{1,2}[-/. ](\d{1,2}|[A-Za-z]{3,9})[-/. ]\d{2,4}$/.test(T(s));
const isAmt = (s) => /^\(?-?[\d,]+(\.\d{1,2})?\)?\s*(dr|cr)?\.?$/i.test(T(s)) && /\d/.test(s);

// ek page -> lines -> cells {x0, x1, s}
// items: [{s, x0, x1, y (upar = bada), h}]
function linesOf(items) {
  const its = items.filter((i) => T(i.s));
  its.sort((a, b) => b.y - a.y || a.x0 - b.x0);
  const lines = [];
  for (const it of its) {
    const L = lines.find((l) => Math.abs(l.y - it.y) <= Math.max(2, it.h * 0.35));
    if (L) L.items.push(it); else lines.push({ y: it.y, items: [it] });
  }
  for (const l of lines) {
    l.items.sort((a, b) => a.x0 - b.x0);
    const cells = [];
    for (const it of l.items) {
      const c = cells[cells.length - 1];
      const gap = c ? it.x0 - c.x1 : 99;
      if (c && gap < Math.max(3, it.h * 0.6)) { c.s += (gap > 0.8 && !/\s$/.test(c.s) && !/^\s/.test(it.s) ? ' ' : '') + it.s; c.x1 = Math.max(c.x1, it.x1); }
      else cells.push({ x0: it.x0, x1: it.x1, s: it.s });
    }
    l.cells = cells.map((c) => ({ ...c, s: T(c.s) })).filter((c) => c.s);
  }
  return lines.sort((a, b) => b.y - a.y);
}

const HEAD = /^(date|dt|posting date|doc(ument)? date|vch date|voucher date|txn date|transaction date|value date|bill date|invoice date)$/i;
const MONEY = /^(debit|dr\.?|credit|cr\.?|amount|amt|withdrawal|deposit|debit amount|credit amount)/i;
function isHeader(l) {
  const ss = l.cells.map((c) => c.s.toLowerCase());
  return ss.some((s) => HEAD.test(s)) && ss.filter((s) => MONEY.test(s)).length >= 1;
}

// cell kis column me: x ka overlap sabse zyada, warna sabse paas wala
function colOf(cols, c) {
  let best = -1, bestOv = 0;
  cols.forEach((k, i) => { const ov = Math.min(k.x1, c.x1) - Math.max(k.x0, c.x0); if (ov > bestOv) { bestOv = ov; best = i; } });
  if (best >= 0) return best;
  let d = Infinity;
  cols.forEach((k, i) => { const dist = c.x1 < k.x0 ? k.x0 - c.x1 : c.x0 > k.x1 ? c.x0 - k.x1 : 0; if (dist < d) { d = dist; best = i; } });
  return best;
}

// OCR wale ank: O->0, l/I->1, S->5 ; "1.18.000.00" -> "1,18,000.00"
function fixOcrNum(s) {
  const t = T(s);
  if (!/^[\d,.\sOolIS()-]+\s*(dr|cr)?\.?$/i.test(t) || (t.match(/\d/g) || []).length < 2) return s;
  let x = t.replace(/[Oo]/g, '0').replace(/[lI]/g, '1').replace(/S/g, '5').replace(/\s+(?=[\d,.])/g, '');
  const m = x.match(/^(.*?)([.,])(\d{2})(\s*(dr|cr)?\.?)$/i);   // aakhri . ya , + 2 ank = paise
  if (m) x = m[1].replace(/[.,]/g, ',') + '.' + m[3] + m[4];
  return x;
}

export function rowsFromPages(pages, { ocr = false } = {}) {
  const out = [];
  let cols = null, header = null;
  for (const items of pages) {
    for (const l of linesOf(items)) {
      if (ocr) for (const c of l.cells) c.s = fixOcrNum(c.s);
      if (isHeader(l)) {
        // column ki chaudai: agle column ke shuru tak phailao (number right-aligned hote hain)
        const hc = l.cells.map((c) => ({ ...c }));
        for (let i = 0; i < hc.length; i++) {
          const prev = hc[i - 1], next = hc[i + 1];
          const isNum = MONEY.test(hc[i].s) || /balance/i.test(hc[i].s);
          if (isNum && prev) hc[i].x0 = Math.min(hc[i].x0, prev.x1 + 2);   // amount column ko baayein phailao
          if (!isNum && next && !MONEY.test(next.s) && !/balance/i.test(next.s)) hc[i].x1 = Math.max(hc[i].x1, next.x0 - 2);
        }
        if (!header) { header = hc.map((c) => c.s); out.push(header); }
        cols = hc;
        continue;
      }
      if (!cols) { out.push([l.cells.map((c) => c.s).join(' ')]); continue; }   // heading se pehle: party ka naam, period
      const row = new Array(cols.length).fill('');
      for (const c of l.cells) { const i = colOf(cols, c); if (i >= 0) row[i] = row[i] ? row[i] + ' ' + c.s : c.s; }
      const hasDate = row.some((v, i) => HEAD.test(header[i] || '') && isDate(v));
      const hasAmt = row.some((v, i) => MONEY.test(header[i] || '') && isAmt(v));
      const prev = out[out.length - 1];
      if (!hasDate && !hasAmt && prev && prev.length === cols.length && !/total|closing|opening|carried|brought|new\s*ref|agst\s*ref/i.test(row.join(' '))) {
        // 2 line ka narration — upar wali entry me jodo
        row.forEach((v, i) => { if (v) prev[i] = prev[i] ? prev[i] + ' ' + v : v; });
        continue;
      }
      out.push(row);
    }
  }
  if (!header) throw new Error(`PDF me statement ki heading (Date + Debit/Credit) nahi mili${ocr ? ' (scan padh ke bhi)' : ''}`);
  return out;
}

async function openPdf(buf) {
  const pdf = await pdfjs();
  return pdf.getDocument({ data: new Uint8Array(buf), disableFontFace: true, isEvalSupported: false, useSystemFonts: false, verbosity: 0, CanvasFactory: NapiCanvasFactory }).promise;
}

// text wali PDF: seedha text. Text na mile (scan / image) to OCR
export async function pdfRows(buf, { onStep } = {}) {
  const doc = await openPdf(buf);
  const pages = [];
  let textCount = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    const items = tc.items.filter((i) => T(i.str)).map((i) => ({ s: i.str, x0: i.transform[4], x1: i.transform[4] + (i.width || 0), y: i.transform[5], h: Math.abs(i.transform[3]) || 8 }));
    textCount += items.length; pages.push(items);
  }
  if (textCount > 20) return { rows: rowsFromPages(pages), ocr: false };
  return { rows: rowsFromPages(await ocrPages(doc, onStep), { ocr: true }), ocr: true };
}

// ---------- OCR (scan PDF) ----------
//  page -> photo (3x) -> Tesseract (offline, English) -> har shabd ki jagah -> wahi table banana
class NapiCanvasFactory {
  constructor() {}
  create(w, h) { const { createCanvas } = require('@napi-rs/canvas'); const canvas = createCanvas(Math.ceil(w), Math.ceil(h)); return { canvas, context: canvas.getContext('2d') }; }
  reset(cc, w, h) { cc.canvas.width = Math.ceil(w); cc.canvas.height = Math.ceil(h); }
  destroy(cc) { cc.canvas.width = 0; cc.canvas.height = 0; cc.canvas = null; cc.context = null; }
}
let _worker = null;
async function ocrWorker() {
  if (_worker) return _worker;
  const { createWorker } = await import('tesseract.js');
  const path = await import('node:path');
  const langPath = path.dirname(require.resolve('@tesseract.js-data/eng/package.json')) + '/4.0.0_best_int';
  const cachePath = path.resolve('db', '.ocr-cache'); (await import('node:fs')).mkdirSync(cachePath, { recursive: true });
  _worker = await createWorker('eng', 1, { langPath, gzip: true, cachePath });
  await _worker.setParameters({ preserve_interword_spaces: '1' });
  return _worker;
}
async function ocrPages(doc, onStep) {
  const w = await ocrWorker();
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    onStep?.(`scan padh raha: page ${p}/${doc.numPages}`);
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 3 });
    const f = new NapiCanvasFactory();
    const cc = f.create(vp.width, vp.height);
    cc.context.fillStyle = '#fff'; cc.context.fillRect(0, 0, vp.width, vp.height);
    await page.render({ canvasContext: cc.context, viewport: vp, canvasFactory: f }).promise;
    const png = await cc.canvas.encode('png');
    f.destroy(cc);
    const { data } = await w.recognize(png);
    const H = vp.height;
    pages.push((data.words || []).filter((x) => x.confidence > 20 || /\d/.test(x.text)).map((x) => ({ s: x.text, x0: x.bbox.x0, x1: x.bbox.x1, y: H - x.bbox.y1, h: x.bbox.y1 - x.bbox.y0 })));
  }
  if (!pages.some((pg) => pg.length)) throw new Error('Scan PDF me kuch padha nahi gaya — saaf scan / Excel bhejo');
  return pages;
}