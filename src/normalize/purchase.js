// Purchase (PowerBI) row -> clean record. Har row = ek VIN (Quantity 1).
// Date do format: "26-Aug-2025" (text) aur Excel serial (45896.19). Dono handle.
function pick(row){ const m={}; for(const k of Object.keys(row)) m[k.trim()]=row[k]; return m; }
const num = (s) => Number(String(s ?? '').replace(/[^\d.-]/g, '')) || 0;

function parseDate(v){
  if(v===''||v==null) return null;
  const n=Number(v);
  if(isFinite(n) && n>1000){                       // Excel serial
    const d=new Date(Math.round((n-25569)*86400*1000));
    return isNaN(d)?null:d;
  }
  const d=new Date(v);                             // "26-Aug-2025"
  return isNaN(d)?null:d;
}
const dmy=(d)=> d instanceof Date && !isNaN(d)
  ? `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`
  : '';

export function normalizePurchase(raw){
  const r=pick(raw);
  const stockIn=parseDate(r['Stock In Date']);
  const invDate=parseDate(r['Invoice Date']);
  const poDate=parseDate(r['Purchase Order Date']);
  return {
    vin:         r['Vin No'] || '',
    invoiceNo:   r['Invoice Number'] || '',
    invoiceDate: dmy(invDate),
    stockInDate: dmy(stockIn),
    stockInISO:  stockIn ? stockIn.toISOString() : '',
    voucherNo:   r['Voucher Number'] || '',
    poNo:        r['Purchase Order #'] || '',
    poDate:      dmy(poDate),
    supplier:    r['Supplier Name'] || '',
    model:       r['Model'] || '',
    variant:     r['Variant'] || '',
    sku:         r['SKU'] || '',
    skuDesc:     r['SKU Description'] || '',
    rate:        num(r['Rate']),
    invoiceValue:num(r['Invoice Value']),
    qty:         num(r['Quantity']) || 1,
    productType: r['Product Type'] || '',
    category:    r['Product Category'] || '',
    state:       r['State'] || '',
  };
}