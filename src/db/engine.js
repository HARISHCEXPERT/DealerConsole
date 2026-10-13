// ============================================================
//  INGEST ENGINE — report config (src/sources/*) padh ke:
//   1. table khud banata hai (pehli baar)
//   2. naya field / naya Excel column aaye to column khud jodta hai
//   3. kachchi row raw_rows me rakhta hai (kuch nahi khota)
//   4. saaf row table me likhta hai — upsert ya invoice-replace
//  Naya report jodna = src/sources me ek config. Code nahi.
// ============================================================
import crypto from 'node:crypto';
import { db, tx, q } from './index.js';
import { parse, sqlType, slug, toDMY, toDate } from './types.js';

const META_COLS = { _id: 'INTEGER PRIMARY KEY', _run_id: 'INTEGER', _updated_at: 'TEXT' };
const nowIso = () => new Date().toISOString();
const normH = (h) => String(h).replace(/\s+/g, ' ').trim().toLowerCase();

// ---------- field defs ko ek jaisa banao ----------
// fields: { vin: 'VIN' }  ya  { amount: { from: ['Total Invoice Amount'], type: 'num' } }
export function compile(src) {
  if (src._compiled) return src._compiled;
  const fields = {};
  for (const [name, d0] of Object.entries(src.fields || {})) {
    const d = typeof d0 === 'string' || Array.isArray(d0) ? { from: d0 } : { ...d0 };
    d.type = d.type || 'text';
    if (!parse[d.type]) throw new Error(`[${src.name}] field ${name}: unknown type ${d.type}`);
    d.from = [].concat(d.from || []).map(normH);
    d.from.push(normH(name));                    // field ka apna naam bhi chalega (JSON import ke liye)
    fields[name] = d;
  }
  const consumed = new Set(Object.values(fields).flatMap((d) => d.from));
  for (const h of src.ignore || []) consumed.add(normH(h));
  const key = [].concat(src.key || []);
  const group = [].concat(src.group || []);
  for (const k of [...key, ...group]) if (!fields[k] && !(k in (src.constants || {})) && !(k in (src.derivedTypes || {}))) throw new Error(`[${src.name}] key/group field "${k}" fields me nahi hai`);
  if (!['upsert', 'replace', 'append'].includes(src.mode)) throw new Error(`[${src.name}] mode upsert/replace/append me se ho`);
  if (src.mode === 'upsert' && !key.length) throw new Error(`[${src.name}] upsert ke liye key chahiye`);
  if (src.mode === 'replace' && !group.length) throw new Error(`[${src.name}] replace ke liye group chahiye`);
  src._compiled = { fields, consumed, key, group, auto: src.autoColumns !== false };
  return src._compiled;
}

// ---------- ek kachchi row -> saaf row ----------
export function normalizeRow(src, raw) {
  const c = compile(src);
  const byH = new Map();
  for (const [h, v] of Object.entries(raw)) byH.set(normH(h), v);

  const row = {};
  for (const [name, d] of Object.entries(c.fields)) {
    let v = null;
    for (const h of d.from) { if (byH.has(h)) { const x = byH.get(h); if (x !== '' && x != null) { v = x; break; } } }
    row[name] = parse[d.type](v);
  }
  Object.assign(row, src.constants || {});
  if (src.derive) Object.assign(row, src.derive(row, raw) || {});

  const extra = {};
  if (c.auto) {
    for (const [h, v] of Object.entries(raw)) {
      const nh = normH(h);
      if (c.consumed.has(nh)) continue;
      const col = slug(h);
      if (!col || c.fields[col] || META_COLS[col] || col in (src.constants || {}) || col in (src.derivedTypes || {}) || col in row) continue;
      extra[col] = parse.text(v);
    }
  }
  return { row, extra };
}

// ---------- table + columns ----------
const colCache = new Map();
function tableCols(table) {
  if (!colCache.has(table)) {
    const cols = db().prepare(`PRAGMA table_info(${q(table)})`).all().map((r) => r.name);
    colCache.set(table, new Set(cols));
  }
  return colCache.get(table);
}

export function ensureTable(src, extraCols = []) {
  const c = compile(src);
  const d = db();
  const t = src.table;
  const cols = tableCols(t);
  const added = [];
  if (!cols.size) {
    const defs = Object.entries(META_COLS).map(([k, v]) => `${q(k)} ${v}`);
    d.exec(`CREATE TABLE IF NOT EXISTS ${q(t)} (${defs.join(', ')})`);
    colCache.delete(t);
  }
  const want = [
    ...Object.entries(c.fields).map(([n, f]) => [n, sqlType[f.type]]),
    ...Object.entries(src.derivedTypes || {}).map(([n, ty]) => [n, sqlType[ty] || 'TEXT']),
    ...Object.keys(src.constants || {}).map((n) => [n, 'TEXT']),
    ...extraCols.map((n) => [n, 'TEXT']),
  ];
  const have = tableCols(t);
  for (const [n, ty] of want) {
    if (have.has(n)) continue;
    d.exec(`ALTER TABLE ${q(t)} ADD COLUMN ${q(n)} ${ty}`);
    have.add(n); added.push(n);
  }
  if (c.key.length) d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${q(`ux_${t}_key`)} ON ${q(t)} (${c.key.map(q).join(', ')})`);
  if (c.group.length) d.exec(`CREATE INDEX IF NOT EXISTS ${q(`ix_${t}_group`)} ON ${q(t)} (${c.group.map(q).join(', ')})`);
  for (const ix of [].concat(src.indexes || [])) {
    const cs = [].concat(ix);
    d.exec(`CREATE INDEX IF NOT EXISTS ${q(`ix_${t}_${cs.join('_')}`)} ON ${q(t)} (${cs.map(q).join(', ')})`);
  }
  return added;
}

// ---------- SQLite value ----------
const sqlVal = (v) => (v === undefined || v === null) ? null : (typeof v === 'boolean' ? (v ? 1 : 0) : (typeof v === 'object' ? JSON.stringify(v) : v));

// ============================================================
//  INGEST — ek pull/import ki saari rows ek transaction me
//  opts: { kind:'pull'|'import'|'reprocess', range:{from,to}, storeRaw:true, pulledAt }
// ============================================================
export function ingest(src, rawRows, opts = {}) {
  const c = compile(src);
  const d = db();
  const kind = opts.kind || 'pull';
  const storeRaw = opts.storeRaw !== false;
  const stats = { rowsIn: rawRows.length, added: 0, updated: 0, replaced: 0, skipped: 0, newColumns: [], dataFrom: null, dataTo: null, warning: null };

  const runId = opts.runId || Number(d.prepare(
    `INSERT INTO sync_runs (source, kind, started_at, range_from, range_to) VALUES (?, ?, ?, ?, ?)`
  ).run(src.name, kind, nowIso(), toDate(opts.range?.from), toDate(opts.range?.to || opts.range?.from)).lastInsertRowid);

  try {
    // 1) normalize + filter
    const items = [];
    rawRows.forEach((raw, seq) => {
      if (src.filter && !src.filter(raw)) { stats.skipped++; return; }
      const { row, extra } = normalizeRow(src, raw);
      if (c.key.length && c.key.every((k) => row[k] == null)) { stats.skipped++; return; }
      if (c.group.length && c.group.every((k) => row[k] == null)) { stats.skipped++; return; }
      if (src.required && src.required.some((k) => row[k] == null)) { stats.skipped++; return; }
      items.push({ raw, row, extra, seq });
    });

    // data asal me kis tareekh se kis tareekh tak aaya? (maangi range se bahar ho to warning)
    if (src.dateField) {
      for (const it of items) {
        const v = it.row[src.dateField];
        if (!v) continue;
        if (!stats.dataFrom || v < stats.dataFrom) stats.dataFrom = v;
        if (!stats.dataTo || v > stats.dataTo) stats.dataTo = v;
      }
      const rf = toDate(opts.range?.from), rt = toDate(opts.range?.to || opts.range?.from);
      if (kind === 'pull' && rf && stats.dataFrom && (stats.dataFrom < rf || stats.dataTo > rt))
        stats.warning = `Range ${rf}..${rt} maangi thi, data ${stats.dataFrom}..${stats.dataTo} ka aaya`;
    }

    tx(() => {
      // 2) columns
      const extraCols = [...new Set(items.flatMap((it) => Object.keys(it.extra)))];
      stats.newColumns = ensureTable(src, extraCols);

      // 3) raw store
      if (storeRaw) {
        const insRaw = d.prepare(`INSERT OR IGNORE INTO raw_rows (source, run_id, row_hash, data) VALUES (?, ?, ?, ?)`);
        const getRaw = d.prepare(`SELECT id FROM raw_rows WHERE source = ? AND row_hash = ?`);
        const link = d.prepare(`INSERT OR IGNORE INTO raw_run_rows (run_id, seq, raw_id) VALUES (?, ?, ?)`);
        rawRows.forEach((raw, seq) => {
          const json = JSON.stringify(raw);
          const h = crypto.createHash('sha1').update(json).digest('hex');
          insRaw.run(src.name, runId, h, json);
          link.run(runId, seq, getRaw.get(src.name, h).id);
        });
      }

      // 4) clean table
      const t = q(src.table);
      const now = nowIso();
      const keyNull = (row) => { for (const k of c.key) if (row[k] == null) row[k] = ''; };  // NULL unique me nahi pakadta

      if (src.mode === 'replace') {
        const groups = new Map();
        for (const it of items) {
          const g = c.group.map((k) => it.row[k] ?? '');
          groups.set(JSON.stringify(g), g);
        }
        const del = d.prepare(`DELETE FROM ${t} WHERE ${c.group.map((k) => `ifnull(${q(k)}, '') = ?`).join(' AND ')}`);
        for (const g of groups.values()) stats.replaced += Number(del.run(...g).changes);
      }

      const stmts = new Map();
      const stmtFor = (cols) => {
        const sig = cols.join('\u0001');
        if (!stmts.has(sig)) {
          let sql = `INSERT INTO ${t} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
          if (src.mode === 'upsert') {
            // naya value khaali ho to purana rakho (kisi report me column na ho to data na mite)
            const upd = cols.filter((x) => !c.key.includes(x)).map((x) => `${q(x)} = COALESCE(excluded.${q(x)}, ${q(x)})`);
            sql += ` ON CONFLICT (${c.key.map(q).join(', ')}) DO UPDATE SET ${upd.join(', ')}`;
          }
          stmts.set(sig, d.prepare(sql));
        }
        return stmts.get(sig);
      };
      const exists = src.mode === 'upsert'
        ? d.prepare(`SELECT 1 FROM ${t} WHERE ${c.key.map((k) => `${q(k)} = ?`).join(' AND ')}`) : null;

      for (const it of items) {
        const row = { ...it.row, ...it.extra, _run_id: runId, _updated_at: now };
        if (src.mode === 'upsert') {
          keyNull(row);
          if (exists.get(...c.key.map((k) => row[k]))) stats.updated++; else stats.added++;
        } else stats.added++;
        const cols = Object.keys(row);
        stmtFor(cols).run(...cols.map((k) => sqlVal(row[k])));
      }
    });

    d.prepare(`UPDATE sync_runs SET finished_at=?, status='ok', rows_in=?, added=?, updated=?, replaced=?, skipped=?, new_columns=?, data_from=?, data_to=?, warning=? WHERE id=?`)
      .run(opts.pulledAt || nowIso(), stats.rowsIn, stats.added, stats.updated, stats.replaced, stats.skipped,
        stats.newColumns.length ? stats.newColumns.join(',') : null, stats.dataFrom, stats.dataTo, stats.warning, runId);
    return { runId, ...stats };
  } catch (e) {
    d.prepare(`UPDATE sync_runs SET finished_at=?, status='error', error=? WHERE id=?`).run(nowIso(), String(e.message || e), runId);
    throw e;
  }
}

// Pull DB tak pahunchi hi nahi (login/scrape fail) — tab bhi log me dikhe
export function logFailedRun(sourceName, range, error) {
  db().prepare(`INSERT INTO sync_runs (source, kind, started_at, finished_at, status, range_from, range_to, error) VALUES (?, 'pull', ?, ?, 'error', ?, ?, ?)`)
    .run(sourceName, nowIso(), nowIso(), toDate(range?.from), toDate(range?.to || range?.from), String(error?.message || error));
}

// ============================================================
//  READ helpers — API ke liye (purana JSON shape: dates dd/mm/yyyy)
// ============================================================
export function dateColsOf(sources, table) {
  const s = new Set();
  for (const src of sources) {
    if (src.table !== table) continue;
    for (const [n, f] of Object.entries(compile(src).fields)) if (f.type === 'date') s.add(n);
    for (const [n, ty] of Object.entries(src.derivedTypes || {})) if (ty === 'date') s.add(n);
  }
  return s;
}
export function boolColsOf(sources, table) {
  const s = new Set();
  for (const src of sources) if (src.table === table)
    for (const [n, f] of Object.entries(compile(src).fields)) if (f.type === 'bool') s.add(n);
  return s;
}

export function tableExists(table) {
  return !!db().prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(table);
}

export function readTable(sources, table, { where = '', params = [], order = '_id' } = {}) {
  if (!tableExists(table)) return [];
  const dates = dateColsOf(sources, table), bools = boolColsOf(sources, table);
  const rows = db().prepare(`SELECT * FROM ${q(table)} ${where ? 'WHERE ' + where : ''} ORDER BY ${order}`).all(...params);
  return rows.map((r) => {
    const o = {};
    for (const [k, v] of Object.entries(r)) {
      if (k[0] === '_') continue;
      o[k] = dates.has(k) ? toDMY(v) : bools.has(k) ? v === 1 : v;
    }
    return o;
  });
}

export function lastRun(sourceNames) {
  const names = [].concat(sourceNames);
  return db().prepare(
    `SELECT * FROM sync_runs WHERE status='ok' AND kind IN ('pull','import') AND source IN (${names.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`
  ).get(...names) || null;
}

// raw_rows se ek run ki rows wapas (reprocess ke liye)
export function rawRowsOfRun(runId) {
  return db().prepare(
    `SELECT r.data FROM raw_run_rows l JOIN raw_rows r ON r.id = l.raw_id WHERE l.run_id = ? ORDER BY l.seq`
  ).all(runId).map((x) => JSON.parse(x.data));
}

export function resetColCache() { colCache.clear(); }
