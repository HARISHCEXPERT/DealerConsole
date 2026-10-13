// Siebel export row (keys = Siebel headers) -> clean sale record (frontend binding shape).
const num = (s) => Number(String(s ?? '').replace(/[^\d.-]/g, '')) || 0;

// Model -> section (HEURISTIC — tera focus-list aane pe isko replace karenge)
function sectionOf(model = '') {
  const m = model.toUpperCase();
  if (/PLEASURE|DESTINI|MAESTRO|XOOM/.test(m)) return 'Scooter';
  if (/XPULSE|XTREME\s*1[6-9]\d|KARIZMA|160|200|210|440|MAVRICK/.test(m)) return '160cc+';
  if (/125|XTEC|GLAMOUR|SUPER\s*SPLENDOR|XTREME\s*125/.test(m)) return '125cc';
  if (/HF|SPLENDOR|PASSION|100|110/.test(m)) return '100–110cc';
  return '—';
}

export function normalizeSale(r) {
  const name = `${r['Contact First Name'] || ''} ${r['Contact Last Name'] || ''}`.trim();
  return {
    invoiceNo: r['Invoice #'] || r['Order #'] || '',
    orderNo:   r['Order #'] || '',
    chassis:   '',                       // Sale export me nahi — baad me Service/master se jodenge
    model:     r['Model'] || '',
    variant:   r['Variant'] || '',
    section:   sectionOf(r['Model']),
    customer:  name,
    phone:     r['Mobile Phone #'] || '',
    dse:       r['DSE Name'] || '',
    amount:    num(r['Total Cost']),
    finance:   r['Finance Checklist'] || '',
    status:    r['Status'] || '',
    date:      r['Order Date'] || '',
  };
}
