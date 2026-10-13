// VSR (PowerBI) row -> clean sale record. Column names me trailing space hota hai -> trim.
const num = (s) => Number(String(s ?? '').replace(/[^\d.-]/g, '')) || 0;

// Date: Excel serial (46236) ya "26-Aug-2025" ya "dd/mm/yyyy" -> dd/mm/yyyy
function parseDate(v){
  if(v===''||v==null) return '';
  const n=Number(v);
  if(isFinite(n) && n>1000){                       // Excel serial
    const d=new Date(Math.round((n-25569)*86400*1000));
    if(isNaN(d)) return String(v);
    return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  }
  const d=new Date(v);
  if(!isNaN(d) && /[a-zA-Z]/.test(String(v))){      // "26-Aug-2025"
    return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  }
  return String(v);                                 // already dd/mm/yyyy
}

// row ke keys trim karke lookup (kyunki 'VIN ', 'DSE Name ' aise aate hain)
function pick(row) {
  const m = {};
  for (const k of Object.keys(row)) m[k.trim()] = row[k];
  return m;
}
function sectionOf(model = '') {
  const s = model.toUpperCase();
  if (/PLEASURE|DESTINI|MAESTRO|XOOM/.test(s)) return 'Scooter';
  if (/XPULSE|XTREME\s*1[6-9]\d|KARIZMA|160|200|210|440|MAVRICK/.test(s)) return '160cc+';
  if (/125|XTEC|GLAMOUR|SUPER\s*SPLENDOR|XTREME\s*125/.test(s)) return '125cc';
  if (/HF|SPLENDOR|PASSION|100|110/.test(s)) return '100–110cc';
  return '—';
}

export function normalizeVSR(raw) {
  const r = pick(raw);
  return {
    vin:        r['VIN'] || '',
    engineNo:   r['Engine Number'] || '',
    invoiceNo:  r['Invoice Number'] || '',
    invoiceDate:parseDate(r['Invoice Date']),
    status:     r['Invoice Status'] || '',
    cancelledDate: parseDate(r['Cancelled Date']),
    model:      r['Model Name'] || '',
    variant:    r['Variant'] || '',
    color:      r['Color'] || '',
    section:    sectionOf(r['Model Name']),
    customer:   r['Contact Name'] || '',
    phone:      r['Contact Mobile Number'] || '',
    dse:        r['DSE Name'] || '',
    amount:     num(r['Total Invoice Amount']),
    basicPrice: num(r['Basic Price']),
    financer:   r['Financer Name'] || '',
    fsc:        r['FSC Number'] || '',
    regNo:      r['Registeration Number'] || '',
    district:   r['Contact District'] || '',
  };
}