// Enquiry (PowerBI) row -> clean record. Excel serial date -> dd/mm/yyyy. Trim keys.
function pick(row){ const m={}; for(const k of Object.keys(row)) m[k.trim()]=row[k]; return m; }

// Excel serial (46236.73) -> JS Date
function excelDate(v){
  if(v===''||v==null) return '';
  const n=Number(v);
  if(!isFinite(n)) { const d=new Date(v); return isNaN(d)?String(v):d; }
  // Excel epoch 1899-12-30
  const d=new Date(Math.round((n-25569)*86400*1000));
  return isNaN(d)?'':d;
}
const dmy=(d)=> d instanceof Date && !isNaN(d)
  ? `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`
  : (d||'');

export function normalizeEnquiry(raw){
  const r=pick(raw);
  const dObj=excelDate(r['Date']);
  return {
    enquiryNo:  r['Enquiry No'] || '',
    name:       r['Full Name'] || '',
    phone:      r['Conatct Mobile Number'] || r['Contact Mobile Number'] || '',
    gender:     r['Gender'] || '',
    dateObj:    dObj instanceof Date ? dObj.toISOString() : '',
    date:       dmy(dObj),                          // dd/mm/yyyy
    source:     r['Enquiry Source'] || '',
    appSource:  r['App Source'] || '',
    model:      r['Sub Model'] || '',
    status:     r['Enquiry Status'] || '',          // Open / Closed
    outcome:    r['Enquiry WON/LOST/Duplicate'] || '', // WON/LOST/Duplicate/Open
    dse:        r['DSE Full Name'] || '',
    followups:  Number(r['Follow Ups Count']) || 0,
    testRide:   (r['Test Ride Flag']||'').toString().toUpperCase()==='Y',
    finance:    (r['Finance Required']||'').toString().toUpperCase()==='Y',
    exchange:   (r['Exchange Required']||'').toString().toUpperCase()==='Y',
    buyingIntend: r['Buying Intend'] || '',
    city:       r['City'] || '',
    town:       r['Town Name'] || '',
    campaign:   r['Campaign Name'] || '',
    comments:   r['Comments'] || '',
  };
}