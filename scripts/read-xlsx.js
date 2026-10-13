// Downloaded xlsx padho:  node scripts/read-xlsx.js  [file]
// default: downloads/data.xlsx
import xlsxPkg from 'xlsx';
const XLSX = xlsxPkg.default || xlsxPkg;
import path from 'node:path';
import fs from 'node:fs';

const file = process.argv[2] || path.resolve('downloads', 'data.xlsx');
if (!fs.existsSync(file)) { console.error('File nahi mili:', file); process.exit(1); }

const wb = XLSX.readFile(file);
console.log('Sheets:', wb.SheetNames);
const ws = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
console.log('Rows:', rows.length);
if (rows.length) {
  console.log('\nCOLUMNS:');
  Object.keys(rows[0]).forEach((c, i) => console.log(`  [${i}] ${c}`));
  console.log('\nFirst row:');
  console.log(rows[0]);
  // VIN/chassis column hai kya?
  const vinCol = Object.keys(rows[0]).find(c => /vin|chassis|frame/i.test(c));
  console.log('\nVIN/chassis column:', vinCol || '⚠️ nahi mila — column names dekh');
}