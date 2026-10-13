// Ek baar chalao: purane data/*.json -> db/dealer.db
//   node scripts/import-json.js
// Dobara chalana safe hai (upsert / invoice-replace — double nahi hoga).
import fs from 'node:fs';
import path from 'node:path';
import { ingest } from '../src/db/engine.js';
import { source } from '../src/sources/index.js';
import { DB_PATH } from '../src/db/index.js';

const DATA = path.resolve('data');
const read = (f) => {
  const p = path.join(DATA, f);
  if (!fs.existsSync(p)) { console.log(`  - ${f}: file nahi mili, skip`); return null; }
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  return Array.isArray(j.rows) ? j : null;
};

const plan = [
  ['vsr.json',            (r) => 'vsr'],
  ['purchase.json',       (r) => 'purchase'],
  ['enquiry.json',        (r) => 'enquiry'],
  ['parts-sales.json',    (r) => (r.src === 'counter' ? 'parts_counter' : 'parts_service')],
  ['parts-purchase.json', (r) => 'parts_purchase'],
];

console.log(`DB: ${DB_PATH}\n`);
for (const [file, route] of plan) {
  const j = read(file);
  if (!j) continue;
  const buckets = new Map();
  for (const r of j.rows) {
    const s = route(r);
    if (!buckets.has(s)) buckets.set(s, []);
    buckets.get(s).push(r);
  }
  for (const [name, rows] of buckets) {
    const st = ingest(source(name), rows, { kind: 'import', range: j.range || null, pulledAt: j.pulledAt || null });
    const src = source(name);
    const what = src.mode === 'replace'
      ? `likhi ${st.added} (purani ${st.replaced} lines hata ke)`
      : `nayi ${st.added}, update ${st.updated}`;
    console.log(`  ✓ ${file} -> ${src.table} [${name}]: ${st.rowsIn} rows | ${what}${st.skipped ? `, skip ${st.skipped}` : ''}` +
      (st.newColumns.length ? ` | columns: ${st.newColumns.length}` : ''));
  }
}
console.log('\nHo gaya. Ab `npm start` karo.');
