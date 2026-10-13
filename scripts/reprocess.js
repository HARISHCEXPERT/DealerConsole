// Cleanup rule / field config badla? DMS dobara pull kiye bina saaf tables dobara banao.
//   node scripts/reprocess.js            -> saari tables
//   node scripts/reprocess.js parts_sales -> sirf ek table
// raw_rows (kachcha data) ko haath nahi lagta — sirf saaf tables naye sire se bante hain.
import { db, q } from '../src/db/index.js';
import { ingest, rawRowsOfRun, tableExists, resetColCache } from '../src/db/engine.js';
import { SOURCES, source } from '../src/sources/index.js';

const only = process.argv[2];
// sirf DMS-report wali tables (Master snapshot tables upload se bante hain, unhe mat chhedo)
const tables = [...new Set(SOURCES.filter((s) => s.report).map((s) => s.table))].filter((t) => !only || t === only);
if (!tables.length) { console.log(`table "${only}" nahi mili. Tables: ${[...new Set(SOURCES.map((s) => s.table))].join(', ')}`); process.exit(1); }

for (const t of tables) {
  const names = SOURCES.filter((s) => s.table === t).map((s) => s.name);
  const runs = db().prepare(
    `SELECT id, source, kind, range_from, range_to FROM sync_runs
     WHERE status='ok' AND kind IN ('pull','import') AND source IN (${names.map(() => '?').join(',')}) ORDER BY id`
  ).all(...names);
  if (tableExists(t)) db().exec(`DROP TABLE ${q(t)}`);
  resetColCache();
  let rows = 0;
  for (const r of runs) {
    const raw = rawRowsOfRun(r.id);
    if (!raw.length) continue;
    const st = ingest(source(r.source), raw, { kind: 'reprocess', storeRaw: false, range: { from: r.range_from, to: r.range_to } });
    rows += st.rowsIn - st.skipped;
  }
  const n = tableExists(t) ? db().prepare(`SELECT COUNT(*) n FROM ${q(t)}`).get().n : 0;
  console.log(`  ✓ ${t}: ${runs.length} runs dobara process, ab ${n} rows`);
}
