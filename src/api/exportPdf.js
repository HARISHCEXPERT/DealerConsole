// ============================================================
//  PDF EXPORT — koi bhi report (title + columns + rows + totals) -> A4 PDF.
//  Offline: wahi Chrome jo Puppeteer scraping ke liye use karta hai. Internet nahi chahiye.
//  POST /api/export/pdf  { title, subtitle, columns:[{key,label,num,money}], rows:[{...}], totals:{key:val}, orientation }
// ============================================================
import puppeteer from 'puppeteer';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const inr = (n) => (n == null || n === '' || isNaN(n)) ? '' : '₹' + Math.round(Number(n)).toLocaleString('en-IN');
const cell = (c, v) => c.money ? inr(v) : c.num ? (v == null || v === '' ? '' : Number(v).toLocaleString('en-IN')) : esc(v);

function html({ title, subtitle, columns, rows, totals, dealer = process.env.DEALER_NAME }) {
  const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const many = columns.length > 8;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:"Segoe UI",Arial,sans-serif;color:#111;font-size:${many ? 8.6 : 10}px}
    header{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #0e7490;padding-bottom:6px;margin-bottom:8px}
    h1{font-size:15px;color:#0e7490}
    .sub{color:#444;font-size:10px;margin-top:2px}
    .meta{text-align:right;color:#555;font-size:9px}
    table{width:100%;border-collapse:collapse}
    thead{display:table-header-group}
    th{background:#e6f4f8;color:#0b4f60;text-align:left;font-weight:600;padding:4px 5px;border:1px solid #c9dfe6}
    td{padding:3px 5px;border:1px solid #ddd;vertical-align:top}
    tr:nth-child(even) td{background:#fafafa}
    .n{text-align:right;white-space:nowrap}
    tfoot td{font-weight:700;background:#f1f5f9;border-top:2px solid #0e7490}
    tr{page-break-inside:avoid}
    tbody tr:nth-child(20n):not(:last-child){page-break-after:always}   /* har page pe max 20 record */
  </style></head><body>
  <header><div><h1>${esc(title)}</h1><div class="sub">${esc(subtitle || '')}</div></div>
  <div class="meta">${esc(dealer || 'Dealer Console')}<br>${esc(now)} · ${rows.length} rows</div></header>
  <table><thead><tr><th class="n">#</th>${columns.map((c) => `<th${c.num || c.money ? ' class="n"' : ''}>${esc(c.label)}</th>`).join('')}</tr></thead>
  <tbody>${rows.map((r, i) => `<tr><td class="n">${i + 1}</td>${columns.map((c) => `<td${c.num || c.money ? ' class="n"' : ''}>${cell(c, r[c.key])}</td>`).join('')}</tr>`).join('')}</tbody>
  ${totals ? `<tfoot><tr><td></td>${columns.map((c, i) => `<td${c.num || c.money ? ' class="n"' : ''}>${i === 0 && totals[c.key] == null ? 'TOTAL' : (totals[c.key] == null ? '' : cell(c, totals[c.key]))}</td>`).join('')}</tr></tfoot>` : ''}
  </table></body></html>`;
}

let browserP = null;
async function browser() {
  if (browserP) { const b = await browserP.catch(() => null); if (b && b.connected !== false) return b; }
  browserP = puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const b = await browserP;
  b.on('disconnected', () => { browserP = null; });
  return b;
}

export async function renderPdf(body) {
  const columns = Array.isArray(body?.columns) ? body.columns : [];
  const rows = Array.isArray(body?.rows) ? body.rows : [];
  if (!columns.length) throw new Error('columns nahi diye');
  if (rows.length > 20000) throw new Error('20,000 se zyada rows — range chhoti karo');
  const landscape = body.orientation ? body.orientation === 'landscape' : columns.length > 6;
  const b = await browser();
  const page = await b.newPage();
  try {
    await page.setContent(html({ ...body, columns, rows }), { waitUntil: 'load' });
    return await page.pdf({
      format: 'A4', landscape, printBackground: true,
      margin: { top: '12mm', bottom: '14mm', left: '8mm', right: '8mm' },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="font-size:8px;color:#666;width:100%;text-align:center;font-family:Arial">${esc(body.title)} · Page <span class="pageNumber"></span> / <span class="totalPages"></span></div>`,
    });
  } finally { await page.close().catch(() => {}); }
}
