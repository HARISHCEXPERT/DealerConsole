// Parts movement normalize — teeno source: purchase(+), service(-), counter-sale(-)
function pick(row){ const m={}; for(const k of Object.keys(row)) m[k.trim()]=row[k]; return m; }
const num = (s) => Number(String(s ?? '').replace(/[^\d.-]/g,'')) || 0;
function pdate(v){
  if(v===''||v==null) return '';
  const n=Number(v);
  if(isFinite(n)&&n>1000){const d=new Date(Math.round((n-25569)*86400*1000));return isNaN(d)?'':fmt(d);}
  const d=new Date(v);return isNaN(d)?String(v):(/[a-zA-Z]/.test(String(v))?fmt(d):String(v));
}
const fmt=d=>`${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;

// PURCHASE (+)
export function normPartsPurchase(raw){
  const r=pick(raw);
  return {
    src:'purchase', dir:+1,
    partNo:(r['Part No']||'').toString().trim(),
    partName:r['Part Name']||'',
    qty:num(r['Actual Received Quantity']),
    rate:num(r['Rate']),
    date:pdate(r['Invoice Date']||r['GRN Date']),
    invoiceNo:r['Invoice Number']||'', supplier:r['Supplier Name']||'',
    category:r['Product Category']||'',
  };
}
// SERVICE (workshop, -) — sirf JOB/PART == PART wali
export function normPartsService(raw){
  const r=pick(raw);
  const jp=(r['JOB/PART']||'').toString().toUpperCase();
  if(jp && jp!=='PART') return null;                    // job/labour rows skip
  return {
    src:'service', dir:-1,
    partNo:(r['SKU #']||'').toString().trim(),
    partName:r['SKU Name']||'',
    qty:num(r['Quantity']),
    rate:num(r['RATE']),
    date:pdate(r['Invoice Date']),
    invoiceNo:r['Invoice Number']||'', customer:r['Customer Name']||'',
    category:r['Product/Service Category']||'',
  };
}
// COUNTER SALE (-)
export function normPartsSale(raw){
  const r=pick(raw);
  return {
    src:'counter', dir:-1,
    partNo:(r['Part NO']||'').toString().trim(),
    partName:r['Part Name']||'',
    qty:num(r['Quantity']),
    rate:num(r['Unit Price']),
    date:pdate(r['Invoice Date']),
    invoiceNo:r['Invoice Number']||'', customer:r['Customer Name']||'',
    executive:r['Executive Name']||'', category:r['Product Category']||'',
  };
}