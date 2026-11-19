// ============================================================
//  Hero DMS "GST Retail Invoice" PDF -> fields (pure-JS, pdf-parse)
//  Template fixed hai -> har bill pe chalta hai. Koi system install nahi.
// ============================================================
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const money = (s) => (s ? Number(String(s).replace(/,/g, '')) : null);
const m = (t, re) => { const x = t.match(re); return x ? clean(x[1]) : ''; };

export function parseBillText(text) {
  const t = String(text || '').replace(/\r/g, '');
  const invoiceNo = m(t, /Invoice #\s*\n?\s*([A-Z0-9]{6,})/i);
  const contactId = m(t, /Contact Id\s*\n?\s*([0-9A-Z\-]+)/i);
  const date = m(t, /\bDate\s*\n?\s*(\d{2}\/\d{2}\/\d{4})/);
  const customer = m(t, /Name of the Customer\s*\n?\s*([^\n]+)/i);
  const sonOf = m(t, /S\/O\s*\n?\s*([A-Z][A-Za-z .]+)/);
  const mobile = m(t, /Mobile\s*\/\s*Home Ph #\s*\n?\s*(\d{10})/i);
  let financier = m(t, /Hypothecation with\s*\n?\s*([^\n]+)/i);
  let address = m(t, /Address\s*([\s\S]*?)\n\s*State Code/i);
  address = clean(address.replace(/\n/g, ' ').replace(/\s*,\s*/g, ', ').replace(/,\s*,/g, ','));
  const pin = m(address, /\b(\d{6})\b/) || m(t, /Address[\s\S]*?\b(\d{6})\b/i);
  // vehicle / item row (pdf-parse me glued aata hai) — pattern se
  const chassis = (t.match(/(MBL[A-Z0-9]{14})/) || [])[1] || '';   // Hero VIN = MBL + 14
  const rowM = t.match(/(\d{8})\s*PC\s*([A-Z0-9]+?)(MBL[A-Z0-9]{14})/i);
  const hsn = rowM ? rowM[1] : m(t, /\b(\d{8})\b/);
  const engine = rowM ? rowM[2] : '';
  const vehicleDesc = m(t, /\n([A-Z][A-Z0-9 ]*(?:SE|STD|DLX|DISC|DRUM|DRSC|SELF|KICK)[A-Z0-9 ]*)\n\s*Sub Total/i)
    || m(t, /Chassis#[\s\S]*?\n([A-Z][A-Z0-9 ]{6,})\n/i);
  const model = m(t, /\n([A-Z][A-Za-z]+ \d{2,4})[A-Z]/) || clean((vehicleDesc.match(/^([A-Z][A-Za-z]+ \d{2,4})/) || [])[1] || '');
  // naam -> first/last (DMS me last name na ho to dots)
  const parts = clean(customer).split(' ');
  const firstName = parts[0] || '';
  const lastName = parts.slice(1).join(' ') || '';

  return {
    invoiceNo, date, contactId,
    customer: clean(customer), firstName, lastName, sonOf,
    address, pin, mobile, financier: clean(financier),
    chassis, engine, hsn, model: clean(model), vehicleDesc: clean(vehicleDesc),
    exShowroom: money(m(t, /Ex Showroom Price\s*\n?\s*([\d,]+\.\d{2})/i)),
    discount: money(m(t, /\bDiscount\s*\n?\s*([\d,]+\.\d{2})/i)),
    taxable: money(m(t, /Taxable Value\s*\n?\s*([\d,]+\.\d{2})/i)),
    grandTotal: money(m(t, /Grand Total \(after Round Off\)\s*\n?\s*([\d,]+\.\d{2})/i)),
  };
}

export async function parseBillPdf(buffer) {
  const d = await pdfParse(buffer);
  return parseBillText(d.text);
}
