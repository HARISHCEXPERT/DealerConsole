// ============================================================
//  FOCUS PARTS (Hero FPG) — workshop me har FPG kitna laga, target ke saamne, aur kis mechanic ne kitna daala
//
//  Target      : focus_targets table (default = Hero ki "Workshop MTD Performance" mail wale 14 FPG) — screen se badlo
//  Part -> FPG : part ke NAAM se pehchaan (keywords, upar se pehla match) + focus_map (haath se theek kiya, wahi pakka)
//  Actual      : parts_sales (src='service') ki QTY jod, is range me
//  MTD Potential = monthly target × (din ÷ 28), KAI MAHINE ho to har mahine ka jod (poora mahina = 1×)  — Hero ki mail se milaya: 11 Sep ki mail
//                  (data 10 tak) me 123 -> 44 = 123×10/28, 384 -> 137, 7 -> 3 … sab match. 28 screen se badal sakte ho.
//  Mechanic    : parts line ka invoice no -> service_invoices (Invoice# / Parts-Inv# / Job-Inv#) -> Technician
// ============================================================
import { Router } from 'express';
import { db } from '../db/index.js';
import { tableExists } from '../db/engine.js';
import { toDate, toDMY } from '../db/types.js';

export const focusApi = Router();

// ORDER zaroori hai: pehla match jeet-ta hai (BULB HEAD LIGHT -> Bulb, CABLE CLUTCH -> Cable)
// kw me kuch bhi likho — har shabd part ke NAAM aur PART NUMBER dono me dhoondha jaata hai
//   'SM KIT' -> naam me ho to · 'K11113' -> part number me ho to (K11113AAHB000S…)
// Ye list file se hi padhi jaati hai — badlo, server restart karo, bas. (Target screen se badalta hai, DB me)
export const FPG_DEFAULTS = [
  { fpg: 'SM Kit', target: 218, kw: ['K11113', 'SM KIT', 'KIT SM', 'S M KIT'] },
  { fpg: 'SERVICE KIT', target: 83, kw: ['SERVICE KIT', 'KIT SERVICE'] },
  { fpg: 'CHAIN SPROCKET KIT', target: 32, kw: ['CHAIN SPROCKET', 'SPROCKET KIT', 'KIT CHAIN', 'CHAIN KIT', 'DRIVE CHAIN KIT', 'KIT DRIVE CHAIN'] },
  { fpg: 'CYLINDER KIT', target: 7, kw: ['CYLINDER KIT', 'KIT CYLINDER', 'CYL KIT', 'KIT CYL'] },
  { fpg: 'BRAKE SHOE KIT', target: 66, kw: ['BRAKE SHOE', 'SHOE BRAKE', 'SHOE SET BRAKE', 'SHOE KIT', 'KIT SHOE'] },
  { fpg: 'AIR CLEANER', target: 123, kw: ['AIR CLEANER', 'AIR FILTER', 'ELEMENT AIR', 'ELEMENT COMP AIR', 'ELEMENT ASSY AIR', 'FILTER AIR', 'CLEANER AIR'] },
  { fpg: 'SPARK PLUG', target: 40, kw: ['SPARK PLUG', 'PLUG SPARK'] },
  { fpg: 'BULB', target: 66, kw: ['BULB'] },
  { fpg: 'HEAD LIGHT', target: 4, kw: ['HEAD LIGHT', 'HEADLIGHT', 'HEAD LAMP', 'HEADLAMP'] },
  { fpg: 'WINKER ASSY.', target: 28, kw: ['WINKER', 'BLINKER', 'TURN SIGNAL'] },
  { fpg: 'CABLE', target: 92, kw: ['CABLE'] },
  { fpg: 'CLUTCH COMPONENT', target: 172, kw: ['CLUTCH'] },
  { fpg: 'DAMPER', target: 384, kw: ['DAMPER'] },
];
const NORM = (s) => ' ' + String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
const PK = (s) => String(s || '').toUpperCase().replace(/[-\s.]/g, '');

function ensure() {
  db().exec(`CREATE TABLE IF NOT EXISTS focus_targets (fpg TEXT PRIMARY KEY, target REAL, kw TEXT, sort INTEGER);
             CREATE TABLE IF NOT EXISTS focus_map (partKey TEXT PRIMARY KEY, partNo TEXT, fpg TEXT, updatedAt TEXT);
             CREATE TABLE IF NOT EXISTS focus_settings (key TEXT PRIMARY KEY, value REAL);`);
  const n = db().prepare('SELECT COUNT(*) c FROM focus_targets').get().c;
  if (!n) {
    const ins = db().prepare('INSERT INTO focus_targets (fpg, target, kw, sort) VALUES (?, ?, ?, ?)');
    FPG_DEFAULTS.forEach((f, i) => ins.run(f.fpg, f.target, JSON.stringify(f.kw), i));
  }
}
function targets() {
  ensure();
  return db().prepare('SELECT fpg, target, kw, sort FROM focus_targets ORDER BY sort, fpg').all()
    .map((r) => ({ fpg: r.fpg, target: r.target || 0, kw: FPG_DEFAULTS.find((d) => d.fpg === r.fpg)?.kw || [], sort: r.sort }));   // kw hamesha FILE se
}
function manualMap() {
  ensure();
  const m = new Map();
  for (const r of db().prepare('SELECT partKey, fpg FROM focus_map').all()) m.set(r.partKey, r.fpg);   // fpg '' = "FPG nahi"
  return m;
}
// part -> { fpg, how: 'haath' | 'naam' | null }
function classifier() {
  const T = targets(), M = manualMap();
  // har keyword NAAM aur PART NUMBER dono me dekha jaata hai
  const rules = T.map((t) => ({ fpg: t.fpg, kw: t.kw.map((w) => ({ n: NORM(w), p: PK(w).replace(/[^A-Z0-9]/g, '') })).filter((w) => w.n.trim()) }));
  return (partNo, name) => {
    const k = PK(partNo);
    if (M.has(k)) return { fpg: M.get(k) || null, how: 'haath' };
    const n = NORM(name), kp = k.replace(/[^A-Z0-9]/g, '');
    for (const r of rules) for (const w of r.kw) {
      if (n.includes(w.n)) return { fpg: r.fpg, how: 'naam' };
      if (w.p && kp.includes(w.p)) return { fpg: r.fpg, how: 'number' };
    }
    return { fpg: null, how: null };
  };
}
// invoice no -> mechanic
function techMap() {
  const m = new Map();
  if (!tableExists('service_invoices')) return m;
  const cols = db().prepare('PRAGMA table_info(service_invoices)').all().map((c) => c.name);
  if (!cols.includes('technician')) return m;
  const sel = ['invoiceNo', 'partsInvNo', 'jobInvNo'].filter((c) => cols.includes(c));
  for (const r of db().prepare(`SELECT ${sel.join(', ')}, technician, jobCardNo FROM service_invoices WHERE technician IS NOT NULL AND technician <> ''`).all()) {
    for (const c of sel) if (r[c]) m.set(PK(r[c]), { tech: r.technician, jc: r.jobCardNo });
  }
  return m;
}
const monthDays = () => { ensure(); const r = db().prepare("SELECT value FROM focus_settings WHERE key = 'monthDays'").get(); return r && r.value > 0 ? r.value : 28; };
const todayIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
function rangeISO(q) {
  const t = toDate(q.to) || todayIST();
  const f = toDate(q.from) || t.slice(0, 8) + '01';
  return { f, t };
}

focusApi.get('/parts/focus', (req, res) => {
  const { f, t } = rangeISO(req.query);
  const T = targets();
  // MTD potential: range ka aakhri din mahine ka kaunsa din hai
  // KAI MAHINE: har mahine ka hissa alag — poora mahina = 1× target, adhoora = din ÷ 28. Sab jod ke potential.
  //   01/08 – 27/09  ->  Aug poora (1) + Sep 27 din (27/28)  = 1.96× target
  const dim = monthDays();
  const months = [];
  for (let [y, mo] = f.split('-').map(Number); ; ) {
    const ms = `${y}-${String(mo).padStart(2, '0')}-01`, last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const me = `${y}-${String(mo).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
    if (ms > t) break;
    const a = f > ms ? f : ms, b = t < me ? t : me;
    const days = Math.round((Date.parse(b) - Date.parse(a)) / 864e5) + 1;
    months.push({ m: ms.slice(0, 7), days, part: Math.min(days, dim) / dim });
    if (++mo > 12) { mo = 1; y++; }
  }
  const frac = months.reduce((s2, x) => s2 + x.part, 0);
  const d = months.length ? months[months.length - 1].days : 0;
  const out = { from: toDMY(f), to: toDMY(t), dayOfMonth: Math.min(d, dim), daysInMonth: dim, months, factor: Math.round(frac * 100) / 100, rows: [], techs: [], lines: [], unmatchedTech: 0, hasTech: false };
  if (!tableExists('parts_sales')) return res.json({ ...out, rows: T.map((x) => ({ fpg: x.fpg, target: x.target, rangeTarget: x.target * months.length, mtd: Math.round(x.target * frac + 1e-9), actual: 0, perf: 0 })) });

  const cls = classifier(), TM = techMap();
  out.hasTech = TM.size > 0;
  const sales = db().prepare(`SELECT partNo, partName, qty, date, invoiceNo, customer FROM parts_sales WHERE src = 'service' AND date >= ? AND date <= ?`).all(f, t);
  const byF = {}, byT = {};
  for (const s of sales) {
    const c = cls(s.partNo, s.partName);
    if (!c.fpg) continue;
    const q = Number(s.qty) || 0;
    const tm = TM.get(PK(s.invoiceNo));
    const tech = tm?.tech || '— (mechanic pata nahi)';
    if (!tm) out.unmatchedTech += q;
    byF[c.fpg] = (byF[c.fpg] || 0) + q;
    const x = byT[tech] || (byT[tech] = { tech, total: 0, f: {} });
    x.f[c.fpg] = (x.f[c.fpg] || 0) + q; x.total += q;
    out.lines.push({ date: toDMY(s.date), fpg: c.fpg, partNo: s.partNo, partName: s.partName, qty: q, invoiceNo: s.invoiceNo, jobCardNo: tm?.jc || '', tech, customer: s.customer, how: c.how });
  }
  out.rows = T.map((x) => {
    const mtd = Math.round(x.target * frac + 1e-9), actual = byF[x.fpg] || 0;
    return { fpg: x.fpg, target: x.target, rangeTarget: x.target * months.length, mtd, actual, perf: mtd ? Math.round(actual / mtd * 100) : (actual ? 100 : 0) };
  });
  out.techs = Object.values(byT).sort((a, b) => b.total - a.total);
  out.lines.sort((a, b) => (a.date < b.date ? 1 : -1));
  res.json(out);
});

// workshop me bike saare parts (6 mahine) + unka FPG -> mapping screen
focusApi.get('/parts/focus/parts', (req, res) => {
  if (!tableExists('parts_sales')) return res.json({ rows: [], fpgs: targets().map((x) => x.fpg) });
  const cls = classifier();
  const since = new Date(Date.now() - 183 * 864e5).toISOString().slice(0, 10);
  const rows = db().prepare(`SELECT partNo, MAX(partName) partName, SUM(qty) qty, COUNT(*) bills FROM parts_sales WHERE src = 'service' AND date >= ? GROUP BY partNo ORDER BY SUM(qty) DESC`).all(since)
    .map((r) => ({ ...r, ...cls(r.partNo, r.partName) }));
  res.json({ rows, fpgs: targets().map((x) => x.fpg) });
});

// ek part ka FPG haath se: { partNo, fpg }  (fpg '' = "FPG nahi", fpg null = wapas naam se pehchaan)
focusApi.post('/parts/focus/map', (req, res) => {
  ensure();
  const { partNo, fpg } = req.body || {};
  if (!partNo) return res.status(400).json({ error: 'partNo do' });
  const k = PK(partNo);
  if (fpg === null || fpg === undefined || fpg === 'auto') db().prepare('DELETE FROM focus_map WHERE partKey = ?').run(k);
  else db().prepare(`INSERT INTO focus_map (partKey, partNo, fpg, updatedAt) VALUES (?, ?, ?, ?)
    ON CONFLICT(partKey) DO UPDATE SET fpg = excluded.fpg, partNo = excluded.partNo, updatedAt = excluded.updatedAt`).run(k, partNo, String(fpg), new Date().toISOString());
  res.json({ ok: true });
});

// targets: [{ fpg, target }]
focusApi.post('/parts/focus/targets', (req, res) => {
  ensure();
  const list = Array.isArray(req.body?.targets) ? req.body.targets : [];
  const up = db().prepare('UPDATE focus_targets SET target = ? WHERE fpg = ?');
  for (const x of list) if (x && x.fpg && Number.isFinite(Number(x.target))) up.run(Number(x.target), x.fpg);
  res.json({ ok: true, targets: targets() });
});

// { monthDays } — MTD potential ka bhaajak (Hero 28 leta hai)
focusApi.post('/parts/focus/settings', (req, res) => {
  ensure();
  const v = Number(req.body?.monthDays);
  if (!(v >= 20 && v <= 31)) return res.status(400).json({ error: '20 se 31 ke beech do' });
  db().prepare("INSERT INTO focus_settings (key, value) VALUES ('monthDays', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(v);
  res.json({ ok: true, monthDays: v });
});