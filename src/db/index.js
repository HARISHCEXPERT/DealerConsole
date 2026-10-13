// Ek hi local SQLite file — db/dealer.db. Dealer ka data usi ke PC pe rehta hai.
// Node 22.13+ ka built-in node:sqlite — koi native package install nahi.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DB_FILE = process.env.DB_FILE || path.resolve('db', 'dealer.db');
let _db = null;

export function db() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  _db = new DatabaseSync(DB_FILE);
  _db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;

    -- Har sync/import ka hisaab: kab, kya, kitna, error
    CREATE TABLE IF NOT EXISTS sync_runs (
      id          INTEGER PRIMARY KEY,
      source      TEXT NOT NULL,
      kind        TEXT NOT NULL DEFAULT 'pull',   -- pull | import | reprocess
      started_at  TEXT NOT NULL,
      finished_at TEXT,
      status      TEXT NOT NULL DEFAULT 'running', -- running | ok | error
      range_from  TEXT,
      range_to    TEXT,
      rows_in     INTEGER DEFAULT 0,
      added       INTEGER DEFAULT 0,
      updated     INTEGER DEFAULT 0,
      replaced    INTEGER DEFAULT 0,
      skipped     INTEGER DEFAULT 0,
      new_columns TEXT,
      error       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_source ON sync_runs(source, id);

    -- Kachcha data: DMS ki har row jaisi aayi waisi. Kabhi delete nahi.
    -- Cleanup rule badle to yahin se dobara process (scripts/reprocess.js).
    CREATE TABLE IF NOT EXISTS raw_rows (
      id       INTEGER PRIMARY KEY,
      source   TEXT NOT NULL,
      run_id   INTEGER NOT NULL,
      row_hash TEXT NOT NULL,
      data     TEXT NOT NULL,
      UNIQUE(source, row_hash)
    );
    -- Kaunsi run me kaunsi raw row aayi (same row dobara aaye to data dobara save nahi hota, sirf link)
    CREATE TABLE IF NOT EXISTS raw_run_rows (
      run_id INTEGER NOT NULL,
      seq    INTEGER NOT NULL,   -- file me row ka kram
      raw_id INTEGER NOT NULL,
      PRIMARY KEY (run_id, seq)
    ) WITHOUT ROWID;
  `);
  // ---- chhote migrations (purani DB file me naye columns) ----
  const runCols = new Set(_db.prepare('PRAGMA table_info(sync_runs)').all().map((r) => r.name));
  for (const [c, t] of [['data_from', 'TEXT'], ['data_to', 'TEXT'], ['warning', 'TEXT']])
    if (!runCols.has(c)) _db.exec(`ALTER TABLE sync_runs ADD COLUMN ${c} ${t}`);
  return _db;
}

export function tx(fn) {
  const d = db();
  d.exec('BEGIN');
  try { const r = fn(d); d.exec('COMMIT'); return r; }
  catch (e) { try { d.exec('ROLLBACK'); } catch {} throw e; }
}

export const q = (name) => `"${String(name).replace(/"/g, '""')}"`;
export const DB_PATH = DB_FILE;
