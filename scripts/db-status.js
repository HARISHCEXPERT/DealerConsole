// DB ka haal ek nazar me:  npm run db-status
// Har table: kitni rows, kis tareekh se kis tareekh tak, kaunse mahine khaali hain. Aur last syncs.
import { db, q, DB_PATH } from '../src/db/index.js';
import { SOURCES, } from '../src/sources/index.js';
import { tableExists, dateColsOf } from '../src/db/engine.js';

const d = db();
console.log(`DB: ${DB_PATH}\n`);
for (const t of [...new Set(SOURCES.map((s) => s.table))]) {
  if (!tableExists(t)) { console.log(`  ${t}: (abhi khaali — table nahi bani)`); continue; }
  const n = d.prepare(`SELECT COUNT(*) n FROM ${q(t)}`).get().n;
  const cols = d.prepare(`PRAGMA table_info(${q(t)})`).all().length - 3;
  const dc = [...dateColsOf(SOURCES, t)][0];
  let line = `  ${t}: ${n} rows, ${cols} columns`;
  if (dc && n) {
    const r = d.prepare(`SELECT MIN(${q(dc)}) a, MAX(${q(dc)}) b FROM ${q(t)} WHERE ${q(dc)} IS NOT NULL`).get();
    const months = new Set(d.prepare(`SELECT DISTINCT substr(${q(dc)},1,7) m FROM ${q(t)} WHERE ${q(dc)} IS NOT NULL`).all().map((x) => x.m));
    const gaps = [];
    if (r.a) {
      let [y, m] = r.a.split('-').map(Number);
      const [by, bm] = r.b.split('-').map(Number);
      while (y < by || (y === by && m <= bm)) {
        const k = `${y}-${String(m).padStart(2, '0')}`;
        if (!months.has(k)) gaps.push(k);
        if (++m > 12) { m = 1; y++; }
      }
    }
    line += ` | ${dc}: ${r.a} -> ${r.b}` + (gaps.length ? ` | ⚠ KHAALI MAHINE: ${gaps.join(', ')}` : '');
  }
  console.log(line);
}

console.log('\nLast 10 sync:');
for (const r of d.prepare(`SELECT * FROM sync_runs ORDER BY id DESC LIMIT 10`).all()) {
  console.log(`  #${r.id} ${r.started_at.slice(0, 16).replace('T', ' ')} ${r.source.padEnd(15)} ${r.kind.padEnd(9)} ${r.status.padEnd(5)} ` +
    `in ${r.rows_in} +${r.added} ~${r.updated} ↺${r.replaced}` +
    (r.range_from ? ` maanga [${r.range_from}..${r.range_to}]` : '') +
    (r.data_from ? ` aaya [${r.data_from}..${r.data_to}]` : '') +
    (r.warning ? ` ⚠ ${r.warning}` : '') +
    (r.new_columns ? ` naye columns: ${r.new_columns.split(',').length}` : '') + (r.error ? ` ERROR: ${r.error}` : ''));
}
