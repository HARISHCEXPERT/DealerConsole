// ============================================================
//  REPORT CONFIGS — har DMS / PowerBI report ki ek entry.
//
//  Naya report jodna ho to yahan ek object jodo:
//    name     : source ka naam (sync log me yahi dikhega)
//    table    : kis table me jaana hai (pehli baar khud banegi)
//    mode     : 'upsert'  -> key se match, purani row update (status badalta hai)
//               'replace' -> poore invoice ki lines hata ke nayi daalo (line gayab/double nahi)
//    key/group: upsert ki key / replace ka group
//    fields   : { hamaraNaam: 'Excel Header' }  ya  { naam: { from: ['Header1','Header2'], type: 'num|int|date|bool|text' } }
//    derive   : (row, raw) => ({ ...computed })   derivedTypes: { naam: type }
//    ignore   : headers jinka auto-column nahi banana
//    report   : kahan se pull (PowerBI link)   dateField: range check kis date pe
//
//  Jo Excel column fields me nahi hai, uska column KHUD ban jaata hai (text). Kuch nahi phenka jaata.
// ============================================================
import { splitParty, stripPartNo, sectionOf } from './clean.js';

// PowerBI report links (.env me same naam se override kar sakte ho)
const CTID = 'f31980c8-b6a6-482d-a0d5-0f73c49dd4e9';
const pbi = (env, id, section) => ({
  kind: 'powerbi', env,
  url: `https://app.powerbi.com/groups/me/reports/${id}/${section}?ctid=${CTID}&experience=power-bi`,
});

const vsr = {
  name: 'vsr',
  label: 'VSR (Sale)',
  report: pbi('PBI_VSR_URL', '50821d3f-3f45-4555-8b27-5b79a95972b7', 'ReportSection'),
  dateField: 'invoiceDate',
  table: 'vehicle_sales',
  mode: 'upsert',
  key: ['invoiceNo', 'vin'],
  fields: {
    vin:           'VIN',
    engineNo:      'Engine Number',
    invoiceNo:     'Invoice Number',
    invoiceDate:   { from: 'Invoice Date', type: 'date' },
    status:        'Invoice Status',
    cancelledDate: { from: 'Cancelled Date', type: 'date' },
    model:         'Model Name',
    variant:       'Variant',
    color:         'Color',
    customer:      'Contact Name',
    phone:         'Contact Mobile Number',
    dse:           'DSE Name',
    amount:        { from: 'Total Invoice Amount', type: 'num' },
    basicPrice:    { from: 'Basic Price', type: 'num' },
    financer:      'Financer Name',
    fsc:           'FSC Number',
    regNo:         'Registeration Number',
    district:      'Contact District',
  },
  derive: (r) => ({ section: sectionOf(r.model) }),
  derivedTypes: { section: 'text' },
  indexes: ['vin', 'invoiceDate', 'phone'],
};

const purchase = {
  name: 'purchase',
  label: 'Vehicle Purchase',
  report: pbi('PBI_PURCHASE_URL', '2a2dc838-7704-4ec1-81b2-aba97936b824', '8a763af0a71e298d7490'),
  dateField: 'invoiceDate',
  table: 'vehicle_purchase',
  mode: 'upsert',
  key: ['vin', 'invoiceNo'],
  fields: {
    vin:          'Vin No',
    invoiceNo:    'Invoice Number',
    invoiceDate:  { from: 'Invoice Date', type: 'date' },
    stockInDate:  { from: 'Stock In Date', type: 'date' },
    voucherNo:    'Voucher Number',
    poNo:         'Purchase Order #',
    poDate:       { from: 'Purchase Order Date', type: 'date' },
    supplier:     'Supplier Name',
    model:        'Model',
    variant:      'Variant',
    sku:          'SKU',
    skuDesc:      'SKU Description',
    rate:         { from: 'Rate', type: 'num' },            // is gaadi ki value
    invoiceValue: { from: 'Invoice Value', type: 'num' },   // DHYAN: poore invoice ka total (har gaadi pe repeat) — sum mat karna
    qty:          { from: 'Quantity', type: 'num' },
    productType:  'Product Type',
    category:     'Product Category',
    state:        'State',
  },
  derive: (r) => { const p = splitParty(r.supplier); return { supplier: p.name, supplierCode: p.code }; },
  derivedTypes: { supplierCode: 'text' },
  ignore: ['stockInISO'],
  indexes: ['stockInDate', 'invoiceNo'],
};

const enquiry = {
  name: 'enquiry',
  label: 'Enquiry',
  report: pbi('PBI_ENQUIRY_URL', 'b2718ba9-4ffc-478c-a5c6-18e3887eefba', 'ReportSection5300e93bab7e629462ba'),
  dateField: 'date',
  table: 'enquiries',
  mode: 'upsert',
  key: ['enquiryNo'],
  fields: {
    enquiryNo:    'Enquiry No',
    name:         'Full Name',
    phone:        ['Conatct Mobile Number', 'Contact Mobile Number'],
    gender:       'Gender',
    date:         { from: 'Date', type: 'date' },
    source:       'Enquiry Source',
    appSource:    'App Source',
    model:        'Sub Model',
    status:       'Enquiry Status',
    outcome:      'Enquiry WON/LOST/Duplicate',
    dse:          'DSE Full Name',
    followups:    { from: 'Follow Ups Count', type: 'int' },
    testRide:     { from: 'Test Ride Flag', type: 'bool' },
    finance:      { from: 'Finance Required', type: 'bool' },
    exchange:     { from: 'Exchange Required', type: 'bool' },
    buyingIntend: 'Buying Intend',
    city:         'City',
    town:         'Town Name',
    campaign:     'Campaign Name',
    comments:     'Comments',
  },
  ignore: ['dateObj'],
  indexes: ['phone', 'date'],
};

// ---- PARTS: service(-) + counter(-) ek table; purchase(+) alag ----
const partsCommon = (r) => ({ partName: stripPartNo(r.partName, r.partNo) });

const partsService = {
  name: 'parts_service',
  label: 'Parts — Workshop',
  report: pbi('PBI_PARTS_SERVICE_URL', '07135606-f9b8-45c7-a0d5-b987fccd03c8', '8a763af0a71e298d7490'),
  dateField: 'date',
  table: 'parts_sales',
  mode: 'replace',
  group: ['invoiceNo', 'src'],
  required: ['partNo'],
  filter: (raw) => {                       // sirf PART lines (labour/job rows chhod do)
    const k = Object.keys(raw).find((h) => h.trim().toUpperCase() === 'JOB/PART');
    const jp = k ? String(raw[k] || '').trim().toUpperCase() : '';
    return !jp || jp === 'PART';
  },
  fields: {
    partNo:    'SKU #',
    partName:  'SKU Name',
    qty:       { from: 'Quantity', type: 'num' },
    rate:      { from: 'RATE', type: 'num' },
    date:      { from: 'Invoice Date', type: 'date' },
    invoiceNo: 'Invoice Number',
    customer:  'Customer Name',
    category:  'Product/Service Category',
  },
  constants: { src: 'service' },
  alsoIngest: ['service_jobs'],             // ISI file ki JOB (labour) lines alag table me — service type (FSC/Paid/GR/Accidental) inhi se
  derive: (r) => ({ ...partsCommon(r), dir: -1 }),
  derivedTypes: { dir: 'int' },
  ignore: ['dir', 'src', 'JOB/PART'],
  indexes: ['partNo', 'date'],
};

const partsCounter = {
  name: 'parts_counter',
  label: 'Parts — Counter',
  report: pbi('PBI_PARTS_SALE_URL', '1acdebe6-150d-42f5-afbe-d558a12a21ad', 'd24a19003a008e7a44ce'),
  dateField: 'date',
  table: 'parts_sales',
  mode: 'replace',
  group: ['invoiceNo', 'src'],
  required: ['partNo'],
  fields: {
    partNo:    'Part NO',
    partName:  'Part Name',
    qty:       { from: 'Quantity', type: 'num' },
    rate:      { from: 'Unit Price', type: 'num' },
    date:      { from: 'Invoice Date', type: 'date' },
    invoiceNo: 'Invoice Number',
    customer:  'Customer Name',
    executive: 'Executive Name',
    category:  'Product Category',
  },
  constants: { src: 'counter' },
  derive: (r) => { const p = splitParty(r.customer); return { ...partsCommon(r), customer: p.name, customerCode: p.code, dir: -1 }; },
  derivedTypes: { dir: 'int', customerCode: 'text' },
  ignore: ['dir', 'src'],
  indexes: ['partNo', 'date'],
};

const partsPurchase = {
  name: 'parts_purchase',
  label: 'Parts — Purchase',
  report: pbi('PBI_PARTS_PURCHASE_URL', '387b3d27-dcea-4fd7-8fe9-0b2797c9ab17', '8a763af0a71e298d7490'),
  dateField: 'date',
  table: 'parts_purchase',
  mode: 'replace',
  group: ['invoiceNo'],
  required: ['partNo'],
  fields: {
    partNo:    'Part No',
    partName:  'Part Name',
    qty:       { from: 'Actual Received Quantity', type: 'num' },
    rate:      { from: 'Rate', type: 'num' },
    date:      { from: ['Invoice Date', 'GRN Date'], type: 'date' },
    invoiceNo: 'Invoice Number',
    supplier:  'Supplier Name',
    category:  'Product Category',
  },
  constants: { src: 'purchase' },
  derive: (r) => { const p = splitParty(r.supplier); return { ...partsCommon(r), supplier: p.name, supplierCode: p.code, dir: 1 }; },
  derivedTypes: { dir: 'int', supplierCode: 'text' },
  ignore: ['dir', 'src'],
  indexes: ['partNo', 'date'],
};

// ---- PARTS PURCHASE ORDER (jo order lagaye) — isi report me invoice/GRN bhi aata hai, alag matching nahi ----
const partsOrder = {
  name: 'parts_order',
  label: 'Parts — Purchase Order',
  report: pbi('PBI_PARTS_ORDER_URL', '839e1e65-0586-4180-af63-e7ffe2fa425e', 'ReportSectionfa7018411a9ce93db572'),
  dateField: 'orderDate',
  table: 'parts_orders',
  mode: 'replace',
  group: ['poNo'],                      // har pull pe poora order naye sire se (line gayab/double nahi)
  required: ['partNo'],
  fields: {
    poNo:         'PURCHASE ORDER NUMBER',
    orderDate:    { from: 'ORDER SUBMIT DATE', type: 'date' },
    orderStatus:  'ORDER STATUS',
    orderSubtype: 'ORDER SUBTYPE',
    category:     'PRODUCT CATEGORY',
    partNo:       'PART NUMBER',
    partDesc:     'PRODUCT DESCRIPTION',
    orderQty:     { from: 'ORDER QUANTITY', type: 'num' },
    orderValue:   { from: 'ORDER VALUE', type: 'num' },
    supplier:     'SUPPLIER NAME',
    supplierCode: 'SUPPLIER CODE',
    psaoNo:       'PSAO ORDER NUM',
    invoiceNo:    'INVOICE NUMBER',
    invoiceDate:  { from: 'INVOICE DATE', type: 'date' },
    invoiceQty:   { from: 'INVOICE QUANTITY', type: 'num' },
    invoiceValue: { from: 'INVOICE VALUE', type: 'num' },
    grnInvoiceNo: 'GRN INVOICE NUMBER',
    grnDate:      { from: 'GRN INVOICE DATE', type: 'date' },
  },
  indexes: ['partNo', 'orderDate'],
};

// ---- SOQ (Hero ka Suggested Order Qty / order guide) — roj update hota hai, date filter nahi.
//      Har fetch = us UPDATE DATE ki poori list (same date dobara fetch = replace). Purani dates rehti hain (itihaas).
const todayIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const N = (h) => ({ from: [].concat(h), type: 'num' });
const soq = {
  name: 'soq',
  label: 'Parts — SOQ (Order Guide)',
  report: pbi('PBI_SOQ_URL', 'eda21234-232c-4596-89d1-01957ccef28d', 'ReportSection7d8ff11a062866b008dc'),
  table: 'parts_soq',
  mode: 'replace',
  group: ['updateDate'],
  required: ['partNo'],
  fields: {
    updateDate:   { from: 'UPDATE DATE', type: 'date' },
    dealer:       'Dealer Name',
    category:     'Product Category',
    partNo:       'Part Number',
    partDesc:     'Product Description',
    abc:          'ABC',
    fms:          'FMS',
    stock:        N('Stock In Hand'),
    b2bPending:   N('B2B PENDING'),
    b2bBackorder: N('B2B BACK ORDER'),
    b2bGit:       N('B2B GIT'),
    ancBackorder: N(['ANC/AFM BACKORDER', 'ANC/AFM BACK ORDER']),
    avgDemand:    N('Average Demand'),
    forecast:     N('Forecast'),
    safetyStock:  N('Safety Stock Qty'),
    rop:          N('ROP'),
    lotSize:      N('LOT Size'),
    soq:          N('SOQ'),
    moq1:         N('Primary MOQ'),
    moq2:         N('Secondary MOQ'),
    leadDays:     N(['Lead Time (Days)', 'Lead Time(Days)', 'Lead Time']),
    transitDays:  N(['Transport Length(Days)', 'Transport Length (Days)', 'Transport Length']),
    mrp:          N('MRP'),
    dlp:          N('DLP'),
    valueDlp:     N(['Value(DLP)', 'Value (DLP)']),
    maxStock:     N('MAX Stock'),
    movA:         'Movement Code A',      // 6 mahine me kitne mahine bika
    movB:         'Movement Code B',      // 3 mahine me kitni baar bika
    pg:           'PG',
    spg:          'SPG',
    hierarchy:    ['Product Heirarchy', 'Product Hierarchy'],
    orderType:    'Order Type',
  },
  derive: (r) => ({ updateDate: r.updateDate || todayIST() }),   // date na aaye to aaj ki
  indexes: ['partNo', 'updateDate'],
};

// ---- SERVICE: JobCard Invoices (Hero Connect / Siebel export). Siebel se aata hai (PowerBI nahi) -> src/jobs/pullService.js
const serviceInvoice = {
  name: 'service_invoice',
  label: 'Service — JobCard Invoices',
  dateField: 'invoiceDate',
  table: 'service_invoices',
  mode: 'upsert',
  key: ['invoiceNo'],
  required: ['invoiceNo'],
  fields: {
    invoiceNo:   ['Invoice#', 'Invoice #', 'Invoice Number'],
    invoiceDate: { from: ['Invoice Created Date', 'Invoice Date'], type: 'date' },
    invoiceTime: ['Invoice Created Date'],
    cancelDate:  { from: ['Invoice Cancel Date'], type: 'date' },
    status:      'Status',
    invoiceType: 'Invoice Type',
    jobCardNo:   ['Job Card #', 'Job Card Number', 'Jobcard #', 'JobCard #', 'Jobcard Number'],
    firstName:   'Contact First Name',
    lastName:    'Contact Last Name',
    account:     'Account',
    createdBy:   'Created By',
    partsTotal:  { from: ['Total Parts Amount', 'Total Parts Amt'], type: 'num' },
    labourTotal: { from: ['Total Labour Amount', 'Total Labor Amount', 'Total Labour Amt'], type: 'num' },
    oilTotal:    { from: ['Total Engine Oil Amount'], type: 'num' },
    total:       { from: ['Total'], type: 'num' },
    labourPre:   { from: ['Pre Tax Labour Amt'], type: 'num' },
    partsPre:    { from: ['Pre Tax Part Amt', 'Pre Tax  Part Amt'], type: 'num' },
    oilPre:      { from: ['Pre Tax Engine Oil Amt'], type: 'num' },
    labourDisc:  { from: ['Jobs Discount Total'], type: 'num' },
    partsDisc:   { from: ['Parts Discount Total'], type: 'num' },
    oilDisc:     { from: ['Engine Oil Discount Total'], type: 'num' },
    technician:  'Technician',
    vin:         ['VIN#', 'VIN'],
    mobile:      ['Contact Mobile No.', 'Contact Mobile No'],
    campaign:    'Campaign',
    insuranceCo: 'Insurance Company Name',
    insuranceAmt:{ from: ['Insurance Amount'], type: 'num' },
    ewParty:     'Extended Warranty Party Name',
    realized:    { from: ['Realized Amount'], type: 'num' },
    shortAmt:    { from: ['Short Amount'], type: 'num' },
    voucher:     { from: ['Voucher Value'], type: 'num' },
    cancelReason:'Invoice Cancel Reason',
    jobInvNo:    'Job-Inv#',
    partsInvNo:  'Parts-Inv#',
    creditNote:  'Credit Note#',
    irn:         'IRN#',
  },
  indexes: ['invoiceDate', 'jobCardNo'],
};

// ---- SERVICE JOBS (labour lines) — Parts Workshop wali PowerBI file ki JOB rows. Inhi se service type:
//      FSC I–IV -> FSC 1..4 · Regular Service / Joyride -> Paid · Accident -> Accidental · baaki -> General Repair
const serviceJobs = {
  name: 'service_jobs',
  label: 'Service — Labour (jobs)',
  dateField: 'date',
  table: 'service_jobs',
  mode: 'replace',
  group: ['invoiceNo'],
  required: ['invoiceNo'],
  filter: (raw) => {
    const k = Object.keys(raw).find((h) => h.trim().toUpperCase() === 'JOB/PART');
    return k ? String(raw[k] || '').trim().toUpperCase() === 'JOB' : false;
  },
  fields: {
    jobCode:   'SKU #',
    jobName:   'SKU Name',
    qty:       { from: 'Quantity', type: 'num' },
    rate:      { from: 'RATE', type: 'num' },
    date:      { from: 'Invoice Date', type: 'date' },
    invoiceNo: 'Invoice Number',
    customer:  'Customer Name',
  },
  ignore: ['JOB/PART', 'Product/Service Category'],
  indexes: ['invoiceNo', 'date'],
};

// ---- SERVICE JOBCARDS (PowerBI) — har job card ki job lines: Nature Of Job, Job Code/Description (FSC IV-SPLENDOR +),
//      Supervisor, Odometer, Model, Dt. of Sale, RC. Job Card Number se service_invoices ke saath judta hai.
const serviceJobcards = {
  name: 'service_jc',
  label: 'Service — JobCards (PowerBI)',
  report: pbi('PBI_SERVICE_JC_URL', 'e3631c11-540f-49d1-92ad-006eaa141831', 'ac155f98ed5c14ae22c0'),
  dateField: 'openDate',
  table: 'service_jobcards',
  mode: 'replace',
  group: ['jobCardNo'],
  required: ['jobCardNo'],
  fields: {
    jobCardNo:    ['JobCard Number', 'Job Card Number'],
    openDate:     { from: ['JobCard Open Date'], type: 'date' },
    completeDate: { from: ['Jobcard Completion Date', 'JobCard Completion Date'], type: 'date' },
    closeDate:    { from: ['JobCard Close Date'], type: 'date' },
    odometer:     { from: ['Odometer Reading'], type: 'num' },
    nature:       'Nature Of Job',
    monthName:    'Month Name',
    assetNo:      'Asset Number',
    model:        'Model',
    saleDate:     { from: ['Dt. Of Sale', 'Dt Of Sale', 'Date Of Sale'], type: 'date' },
    jobCode:      'Job Code',
    jobDesc:      ['Job Dscription', 'Job Description'],
    billable:     ['BillableType', 'Billable Type'],
    invoiceValue: { from: ['Invoice Value'], type: 'num' },
    valueBucket:  'Invoice value Bucketization',
    tmService:    'TM Service',
    rcNo:         'RC Number',
    supervisor:   'Supervisor Name',
    supervisorId: 'Supervisor ID',
    supervisorPos:'Supervisor Position',
    zonal:        'Zonal Office',
    area:         'Area Office',
    dealer:       'Dealer Name',
    town:         'Town Name',
  },
  indexes: ['jobCardNo', 'openDate'],
};

// ---- MASTERS (DMS stock report — file upload se, pull nahi). Har upload = naya snapshot (poori table badalti hai) ----
const partsMaster = {
  name: 'parts_master',
  label: 'Parts Master (stock)',
  table: 'parts_master',
  mode: 'append',                       // ek part ki kai rows (location-wise) ho sakti — stock SUM hota hai
  required: ['partNo'],
  fields: {
    partNo:   ['Part #', 'Part No', 'Part No.', 'Part Number', 'Part Code'],
    partDesc: ['Part Description', 'Part Name', 'Description'],
    stock:    { from: ['Actual Stock on Hand', 'Stock on Hand', 'Stock', 'Qty On Hand', 'Closing Stock'], type: 'num' },
    mrp:      { from: ['MRP', 'MRP Price'], type: 'num' },
    dlc:      { from: ['DLC', 'Dealer Landed Cost', 'NDP'], type: 'num' },
    moq:      { from: ['MOQ', 'Min Order Qty'], type: 'num' },
    category: ['Category', 'Part Category', 'Product Category'],
  },
};
const vehicleMaster = {
  name: 'vehicle_master',
  label: 'Vehicle Master',
  table: 'vehicle_master',
  mode: 'append',
  required: ['vin'],
  fields: {
    vin:         ['VIN', 'Vin No', 'VIN Number', 'Chassis No', 'Chassis Number', 'Frame No'],
    model:       ['Model', 'Model Name', 'SKU Description'],
    variant:     ['SKU', 'Variant'],
    color:       'Color',
    status:      'Status',
    engineNo:    ['Engine#', 'Engine Number', 'Engine No'],
    invoiceDate: { from: 'Invoice Date', type: 'date' },
    hmclInvoiceDate: { from: 'HMCL Invoice Date', type: 'date' },
    mfgMonth:    { from: ['Manufacturing Month', 'Manufacturing Date'], type: 'date' },
    basicPrice:  { from: 'Basic Price', type: 'num' },
  },
};

const fscVin = {
  name: 'fsc_vin',
  label: 'Service — FSC VIN tracking (PowerBI)',
  report: { ...pbi('PBI_FSC_VIN_URL', 'd45c4ab1-794d-4630-958c-c0ef72559f33', 'f4b57acced065ec36c55'), page: 'VIN Wise Service Tracker' },
  table: 'fsc_vin',
  mode: 'replace',
  allSlicers: true,   // scrape se pehle saare slicer 'All' kar do (poora data)
  group: ['asset'],
  required: ['asset'],
  fields: {
    asset:         ['Asset Number'],
    model:         'Model',
    customer:      'Customer Full Name',
    mobile:        'Customer Mobile Number',
    maxFsc:        { from: ['Max FSC Count'], type: 'num' },
    warrantyStart: { from: ['Warranty Start Date'], type: 'date' },
    fsc1:          { from: ['FSC I Claimed Date'], type: 'date' },
    fsc2:          { from: ['FSC II Claimed Date'], type: 'date' },
    fsc3:          { from: ['FSC III Claimed Date'], type: 'date' },
    fsc4:          { from: ['FSC IV Claimed Date'], type: 'date' },
    fsc5:          { from: ['FSC V Claimed Date'], type: 'date' },
    paidAmc:       'Latest Paid/AMC Availed',
    joyrideExp:    { from: ['Joyride Expiry Date'], type: 'date' },
    fsc1Exp:       { from: ['FSC I Expiry Date'], type: 'date' },
    fsc2Exp:       { from: ['FSC II Expiry Date'], type: 'date' },
    fsc3Exp:       { from: ['FSC III Expiry Date'], type: 'date' },
    fsc4Exp:       { from: ['FSC IV Expiry Date'], type: 'date' },
    fsc5Exp:       { from: ['FSC V Expiry Date'], type: 'date' },
    odometer:      { from: ['Odometer Reading'], type: 'num' },
    monthName:     'Month Name',
  },
  indexes: ['asset'],
};

const paidVin = {
  name: 'paid_vin',
  label: 'Service — Paid VIN tracking (PowerBI)',
  report: { ...pbi('PBI_PAID_VIN_URL', 'd45c4ab1-794d-4630-958c-c0ef72559f33', 'c79f8760084c65a2161b'), page: 'Paid Redemption Vin Wise' },
  table: 'paid_vin',
  mode: 'replace',
  allSlicers: true,   // scrape se pehle saare slicer 'All' kar do (poora data)
  group: ['asset'],
  required: ['asset'],
  fields: {
    asset:    ['Asset Number'],
    model:    'Model',
    customer: 'Customer Full Name',
    mobile:   'Customer Mobile Number',
    saleDate: { from: ['Vehicle Sale Date'], type: 'date' },
    paid1:    { from: ['First Paid Service Date'], type: 'date' },
    paid2:    { from: ['Second Paid Service Date'], type: 'date' },
    paid3:    { from: ['Third Paid Service Date'], type: 'date' },
    status:   'Status',
    dueType:  'Due Service Type',
  },
  indexes: ['asset'],
};

export const SOURCES = [vsr, purchase, enquiry, partsService, partsCounter, partsPurchase, partsOrder, soq, serviceInvoice, serviceJobs, serviceJobcards, fscVin, paidVin, partsMaster, vehicleMaster];
export const source = (name) => {
  const s = SOURCES.find((x) => x.name === name);
  if (!s) throw new Error(`unknown source: ${name}`);
  return s;
};
