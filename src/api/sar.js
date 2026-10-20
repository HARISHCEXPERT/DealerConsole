// ============================================================
//  SAR — Workshop Service Absorption Ratio (P&L)
//  Goal: workshop ka revenue − kharcha >= 0 (SAR >= 100%).
//  Revenue: jahan DC ke paas data hai wahan AUTO bhar deta hai (FSC credit, Paid/Joyride labour,
//           Parts/Oil margin, Warranty labour). Baaki + saare EXPENSES manual (Tally/accounts ka data).
//  Har cell editable: auto value override ho sakti hai. Manual + override 'sar' table me save.
//  Month = financial year (Apr..Mar), + Q1..Q4 + YTD.
// ============================================================
import { db } from '../db/index.js';
import { tableExists } from '../db/engine.js';
import { toDMY } from '../db/types.js';
import { SERVICE_TYPES, DEFAULT_TYPE } from '../config/serviceTypes.js';

const MONTHS = ['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar'];
// month index 0=Apr .. 11=Mar  ->  'YYYY-MM'
const ymOf = (Y, i) => { const mo = ((3 + i) % 12) + 1; const y = i <= 8 ? Y : Y + 1; return `${y}-${String(mo).padStart(2, '0')}`; };

export const SAR_REVENUE = [
  { k: 'fscLabour',     label: 'FSC labour (Hero credit)',          auto: true },
  { k: 'paidLabour',    label: 'Paid Labour',                       auto: true },
  { k: 'partsMargin',   label: 'Parts margin (Workshop+Counter)',   auto: true },
  { k: 'oilMargin',     label: 'Oil margin',                        auto: true },
  { k: 'joyride',       label: 'Hero Joyride Labour',               auto: true },
  { k: 'warrantyLabour',label: 'Warranty labour',                   auto: true },
  { k: 'oldOil',        label: 'Old oil retail' },
  { k: 'scrap',         label: 'Scrap' },
  { k: 'incentives',    label: 'Incentives (Goodlife)' },
  { k: 'outsideLabour', label: 'Outside labour margin' },
  { k: 'insComm',       label: 'Insurance renewal commission' },
  { k: 'otherIncome',   label: 'Any other income (Workshop & Parts)' },
];
export const SAR_EXPENSE = [
  { k: 'bankCharge', label: 'Bank Charge' }, { k: 'fuel', label: 'Fuel Expenses' },
  { k: 'insuranceCharges', label: 'Insurance Charges' }, { k: 'postage', label: 'Postage and Courier' },
  { k: 'professional', label: 'Professional Expenses' }, { k: 'publicity', label: 'Publicity and Advertisement' },
  { k: 'rentShop', label: 'Rent of Shop' }, { k: 'repair', label: 'Repair and Maintenance' },
  { k: 'salary', label: 'Salary and Wages' }, { k: 'staffWelfare', label: 'Staff Welfare' },
  { k: 'stationery', label: 'Stationery and Printing' }, { k: 'sundry', label: 'Sundry Exp.' },
  { k: 'telephone', label: 'Telephone Expenses' }, { k: 'training', label: 'Training Exp' },
  { k: 'depreciation', label: 'Depreciation' }, { k: 'freight', label: 'Freight & Forwarding' },
  { k: 'goodlifeRedeem', label: 'Goodlife Reward Redeemed' }, { k: 'incidental', label: 'Incidental Charges' },
  { k: 'internet', label: 'Internet Bandwidth' }, { k: 'interest', label: 'Interest Paid' },
  { k: 'electric', label: 'Electric Exp.' }, { k: 'partnerRem', label: 'Partner Remuneration' },
];
// operating SAR me se ye expenses hata diye jaate hain (workshop operations ke nahi)
const NON_OP = ['partnerRem', 'depreciation', 'interest'];

function ensure() {
  db().exec(`CREATE TABLE IF NOT EXISTS sar (fy INTEGER NOT NULL, mon INTEGER NOT NULL, field TEXT NOT NULL, value REAL, PRIMARY KEY (fy, mon, field))`);
}

// aaj ki FY start year (Apr se Mar). month>=4 -> isi saal, warna pichla.
function curFY() { const t = new Date(Date.now() + 5.5 * 3600e3); const y = t.getUTCFullYear(), m = t.getUTCMonth() + 1; return m >= 4 ? y : y - 1; }

// service invoice ka type (routes.js jaisa) — Paid/Joyride/FSC/GR/Accidental
function classifier() {
  const d = db();
  const PKn = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const jobs = new Map();
  if (tableExists('service_jobs')) for (const j of d.prepare('SELECT invoiceNo, jobCode, jobName FROM service_jobs').all()) {
    const k = PKn(j.invoiceNo); if (!jobs.has(k)) jobs.set(k, []); jobs.get(k).push({ code: String(j.jobCode || '').trim().toUpperCase(), name: String(j.jobName || '') });
  }
  const jcs = new Map();
  if (tableExists('service_jobcards')) for (const j of d.prepare('SELECT jobCardNo, jobCode, jobDesc, nature FROM service_jobcards').all()) {
    const k = PKn(j.jobCardNo); if (!jcs.has(k)) jcs.set(k, []); jcs.get(k).push({ code: String(j.jobCode || '').trim().toUpperCase(), name: String(j.jobDesc || '') + (j.nature ? ' | ' + j.nature : '') });
  }
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
  const RULES = SERVICE_TYPES.map((t) => ({ type: t.type, codes: (t.codes || []).map((c) => String(c).trim().toUpperCase()),
    names: (t.names || []).map((w) => new RegExp('(^|[^A-Z0-9])' + esc(String(w).toUpperCase()) + '(?![A-Z0-9])')) }));
  const jobsOf = (r) => [...[r.invoiceNo, r.jobInvNo, r.partsInvNo].flatMap((x) => (x && jobs.get(PKn(x))) || []), ...((r.jobCardNo && jcs.get(PKn(r.jobCardNo))) || [])];
  return (r) => {
    const js = jobsOf(r);
    for (const R of RULES) if (js.some((j) => R.codes.includes(j.code) || R.names.some((re) => re.test(j.name.toUpperCase())))) return R.type;
    if (r.insuranceCo || Number(r.insuranceAmt) > 0) return 'Accidental';
    return js.length ? DEFAULT_TYPE : DEFAULT_TYPE;
  };
}

function autoRevenue(Y) {
  const out = {}; for (const r of SAR_REVENUE) if (r.auto) out[r.k] = Array(12).fill(0);
  const idx = {}; for (let i = 0; i < 12; i++) idx[ymOf(Y, i)] = i;
  const d = db();
  // FSC labour = Hero credit note (net) — service_month wise
  if (tableExists('fsc_notes')) for (const r of d.prepare('SELECT service_month ym, SUM(net) v FROM fsc_notes GROUP BY service_month').all()) {
    const i = idx[r.ym]; if (i != null) out.fscLabour[i] += r.v || 0;
  }
  // Warranty labour — DCR labour, part_billing_date wise
  if (tableExists('warranty_dcr')) for (const r of d.prepare('SELECT part_billing_date dt, SUM(labour) v FROM warranty_dcr GROUP BY part_billing_date').all()) {
    const i = idx[String(r.dt || '').slice(0, 7)]; if (i != null) out.warrantyLabour[i] += r.v || 0;
  }
  // Parts & Oil margin = bika qty * (MRP - DLC)  [standard dealer margin; rate nahi, isliye free/warranty parts pe bhi minus nahi]
  if (tableExists('parts_sales')) {
    const master = new Map();
    if (tableExists('parts_master')) for (const m of d.prepare('SELECT partNo, MAX(mrp) mrp, MAX(dlc) dlc, MAX(category) cat FROM parts_master GROUP BY partNo').all())
      master.set(String(m.partNo).toUpperCase(), { mrp: m.mrp || 0, dlc: m.dlc || 0, cat: m.cat || '' });
    for (const s of d.prepare('SELECT partNo, category, qty, rate, date FROM parts_sales').all()) {
      const i = idx[String(s.date || '').slice(0, 7)]; if (i == null) continue;
      const r = Number(s.rate) || 0; if (r <= 0) continue;           // free/warranty parts (rate 0) chhodo — unka paisa FSC/warranty me
      const m = master.get(String(s.partNo).toUpperCase()) || { mrp: 0, dlc: 0, cat: '' };
      const margin = (Number(s.qty) || 0) * (r - (m.dlc || 0));       // ASLI bikri (billed rate, discount ke baad) − DLC
      if (/oil|lubric/i.test(s.category || m.cat || '')) out.oilMargin[i] += margin; else out.partsMargin[i] += margin;
    }
  }
  // Paid vs Joyride labour (FSC labour skip — uska credit upar count hua)
  if (tableExists('service_invoices')) {
    const type = classifier();
    for (const r of d.prepare('SELECT * FROM service_invoices').all()) {
      if (/cancel/i.test(r.status || '') || r.cancelDate) continue;
      const i = idx[String(r.invoiceDate || '').slice(0, 7)]; if (i == null) continue;
      const lab = Number(r.labourTotal) || 0; if (!lab) continue;
      const t = type(r);
      if (/joy/i.test(t)) out.joyride[i] += lab;
      else if (/fsc|free/i.test(t)) { /* skip: Hero credit already counted */ }
      else out.paidLabour[i] += lab;
    }
  }
  for (const k in out) out[k] = out[k].map((v) => Math.round(v));
  return out;
}

function savedMap(Y) {
  ensure();
  const m = {};
  for (const r of db().prepare('SELECT mon, field, value FROM sar WHERE fy = ?').all(Y)) m[`${r.field}:${r.mon}`] = r.value;
  return m;
}

export function sarApi(api) {
  api.get('/sar', (req, res) => {
    try {
      const Y = Number(req.query.fy) || curFY();
      const auto = autoRevenue(Y);
      const sv = savedMap(Y);
      const pick = (k, autoVals) => Array.from({ length: 12 }, (_, i) => {
        const o = sv[`${k}:${i}`];
        return o != null ? o : (autoVals ? autoVals[i] : 0);
      });
      const revenue = SAR_REVENUE.map((r) => ({ k: r.k, label: r.label, auto: !!r.auto,
        values: pick(r.k, r.auto ? auto[r.k] : null), autoValues: r.auto ? auto[r.k] : null }));
      const expense = SAR_EXPENSE.map((e) => ({ k: e.k, label: e.label, values: pick(e.k, null) }));
      const rent = pick('rentWorkshop', null);
      res.json({ fy: Y, fyLabel: `${Y}-${String((Y + 1) % 100).padStart(2, '0')}`, months: MONTHS,
        revenue, expense, rent, nonOp: NON_OP });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // kisi revenue line ka detail: "itna becha, aise margin bana"  /sar/detail?fy&mon&line
  api.get('/sar/detail', (req, res) => {
    try {
      const Y = Number(req.query.fy) || curFY();
      const mon = Number(req.query.mon); const line = String(req.query.line || '');
      const ym = ymOf(Y, mon); const d = db();
      let rows = [], columns = [], title = '', note = '';
      if (line === 'partsMargin' || line === 'oilMargin') {
        const oil = line === 'oilMargin';
        const master = new Map();
        if (tableExists('parts_master')) for (const m of d.prepare('SELECT partNo, MAX(mrp) mrp, MAX(dlc) dlc, MAX(category) cat FROM parts_master GROUP BY partNo').all())
          master.set(String(m.partNo).toUpperCase(), { mrp: m.mrp || 0, dlc: m.dlc || 0, cat: m.cat || '' });
        const agg = new Map();
        if (tableExists('parts_sales')) for (const s of d.prepare('SELECT partNo, partName, category, qty, rate, date FROM parts_sales').all()) {
          if (String(s.date || '').slice(0, 7) !== ym) continue;
          const r = Number(s.rate) || 0; if (r <= 0) continue;         // free/warranty parts chhodo
          const m = master.get(String(s.partNo).toUpperCase()) || { mrp: 0, dlc: 0, cat: '' };
          if ((/oil|lubric/i.test(s.category || m.cat || '')) !== oil) continue;
          const q = Number(s.qty) || 0;
          const k = String(s.partNo); let x = agg.get(k);
          if (!x) agg.set(k, x = { partNo: s.partNo, partName: s.partName || '', qty: 0, mrp: m.mrp, dlc: m.dlc, sold: 0, cost: 0 });
          x.qty += q; x.sold += q * r; x.cost += q * (m.dlc || 0);     // sold = ASLI bikri (billed, discount ke baad)
        }
        rows = [...agg.values()].map((x) => { const margin = x.sold - x.cost; return {
          partNo: x.partNo, partName: x.partName, qty: Math.round(x.qty), mrp: Math.round(x.mrp), dlc: Math.round(x.dlc),
          rate: x.qty ? Math.round(x.sold / x.qty) : 0, sold: Math.round(x.sold), cost: Math.round(x.cost),
          margin: Math.round(margin), pct: x.sold ? Math.round(margin / x.sold * 100) : 0 }; })
          .sort((a, b) => b.margin - a.margin);
        columns = [{ key: 'partNo', label: 'Part #' }, { key: 'partName', label: 'Part' }, { key: 'qty', label: 'Qty', num: true, sum: true },
          { key: 'rate', label: 'Avg bikri rate ₹', num: true }, { key: 'dlc', label: 'DLC (cost) ₹', num: true },
          { key: 'sold', label: 'Bika (actual) ₹', money: true, sum: true }, { key: 'cost', label: 'Cost (DLC×qty) ₹', money: true, sum: true },
          { key: 'margin', label: 'Margin ₹', money: true, sum: true }, { key: 'pct', label: 'Margin %', num: true }];
        title = (oil ? 'Oil' : 'Parts') + ' margin — ' + ym;
        note = 'Bika = asli bikri (billed rate, discount ke baad) × qty. Margin = Bika − Cost(DLC). Free/warranty parts (rate 0) nahi ginte.';
      } else if (line === 'fscLabour') {
        if (tableExists('fsc_notes')) rows = d.prepare('SELECT invoice_no inv, date, plant, net, tax, total FROM fsc_notes WHERE service_month = ? ORDER BY net DESC').all(ym)
          .map((r) => ({ inv: r.inv, date: toDMY(r.date), plant: r.plant, net: Math.round(r.net || 0), tax: Math.round(r.tax || 0), total: Math.round(r.total || 0) }));
        columns = [{ key: 'inv', label: 'Credit note' }, { key: 'date', label: 'Date' }, { key: 'plant', label: 'Plant' },
          { key: 'net', label: 'Net ₹', money: true, sum: true }, { key: 'tax', label: 'Tax ₹', money: true, sum: true }, { key: 'total', label: 'Total ₹', money: true, sum: true }];
        title = 'FSC credit (Hero) — ' + ym; note = 'Hero ke free-service credit note. SAR me Net gina jaata hai.';
      } else if (line === 'warrantyLabour') {
        if (tableExists('warranty_dcr')) rows = d.prepare('SELECT claim_no, part_billing_date dt, part_desc, labour FROM warranty_dcr WHERE substr(part_billing_date,1,7)=? AND IFNULL(labour,0)<>0 ORDER BY labour DESC').all(ym)
          .map((r) => ({ claim: r.claim_no, date: toDMY(r.dt), part: r.part_desc, labour: Math.round(r.labour || 0) }));
        columns = [{ key: 'claim', label: 'Claim #' }, { key: 'date', label: 'Date' }, { key: 'part', label: 'Part' }, { key: 'labour', label: 'Labour ₹', money: true, sum: true }];
        title = 'Warranty labour — ' + ym;
      } else if (line === 'paidLabour' || line === 'joyride') {
        if (tableExists('service_invoices')) {
          const type = classifier();
          for (const r of d.prepare('SELECT * FROM service_invoices').all()) {
            if (/cancel/i.test(r.status || '') || r.cancelDate) continue;
            if (String(r.invoiceDate || '').slice(0, 7) !== ym) continue;
            const lab = Number(r.labourTotal) || 0; if (!lab) continue;
            const t = type(r); const isJoy = /joy/i.test(t);
            if (/fsc|free/i.test(t)) continue;
            if ((line === 'joyride') !== isJoy) continue;
            rows.push({ inv: r.invoiceNo, date: toDMY(r.invoiceDate), jc: r.jobCardNo || '', cust: [r.firstName, r.lastName].filter(Boolean).join(' ') || r.account || '', type: t, labour: Math.round(lab) });
          }
          rows.sort((a, b) => b.labour - a.labour);
        }
        columns = [{ key: 'inv', label: 'Invoice' }, { key: 'date', label: 'Date' }, { key: 'jc', label: 'Job Card' }, { key: 'cust', label: 'Customer' }, { key: 'type', label: 'Type' }, { key: 'labour', label: 'Labour ₹', money: true, sum: true }];
        title = (line === 'joyride' ? 'Joyride' : 'Paid') + ' labour — ' + ym;
      } else { return res.json({ title: '', columns: [], rows: [], note: 'Is line ka detail nahi (manual entry).' }); }
      res.json({ title, columns, rows, note });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // save overrides / manual. body: { fy, edits:[{mon,field,value}] }  value null/'' -> delete (auto pe wapas)
  api.post('/sar', (req, res) => {
    try {
      ensure();
      const Y = Number(req.body?.fy) || curFY();
      const edits = Array.isArray(req.body?.edits) ? req.body.edits : [];
      const del = db().prepare('DELETE FROM sar WHERE fy=? AND mon=? AND field=?');
      const up = db().prepare('INSERT INTO sar (fy,mon,field,value) VALUES (?,?,?,?) ON CONFLICT(fy,mon,field) DO UPDATE SET value=excluded.value');
      for (const e of edits) {
        const mon = Number(e.mon), field = String(e.field || '');
        if (!(mon >= 0 && mon < 12) || !field) continue;
        const v = e.value === '' || e.value == null ? null : Number(e.value);
        if (v == null || !isFinite(v)) del.run(Y, mon, field); else up.run(Y, mon, field, v);
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}