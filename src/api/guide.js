// ============================================================
//  HAMARA ORDER GUIDE — 6 mahine ki bikri se har part: category, kitna order, safety stock
//
//  1. Bikri (workshop + counter), pichhle 6 mahine (sales data ki aakhri tareekh tak)
//     - Ek bada bill poora nahi ginte: har bill max 3 × (us part ke bill ka median)
//     - 6 hisse (30 din ke): kitne hisson me bika, kitne bill, kitni qty
//  2. Category
//     Running : 6 me se 5-6 mahine bika + mahine me 4+ bill
//     Normal  : 3+ mahine bika
//     Slow    : 1-2 mahine bika (2+ bill)      -> sirf stock 0 ho tab 1 / MOQ
//     Kabhi-kabhi: 6 mahine me sirf 1 bill     -> order 0, customer maange tab
//     Dead    : 6 mahine me 0, stock pada hai  -> order 0 (becho list)
//     Naya    : pehli sale 60 din ke andar     -> min 1
//  3. Roz ki bikri = 60% × (pichhle 3 mahine) + 40% × (usse pehle ke 3 mahine)
//  4. Target = roz × (lead time + order gap) + roz × safety din   (Normal/Slow: max roof mahine ki bikri)
//     Order  = Target − (Stock + PO baaki + raste me)  -> MOQ ke guna me upar
//  Lead time: PO report (order date -> GRN) | Order gap: PO report me order dates ka median gap
//  Settings: guide_settings table (screen se badlo)
// ============================================================
import { Router } from 'express';
import { db } from '../db/index.js';
import { tableExists } from '../db/engine.js';
import { toDMY } from '../db/types.js';
import { partsLive, latestSnap } from './stock.js';
import { ourPO, soqLatestMap } from './soq.js';

export const guideApi = Router();
const KEY = (s) => String(s || '').toUpperCase().replace(/[-\s.]/g, '');
const PKSQL = (c) => `REPLACE(REPLACE(REPLACE(UPPER(TRIM(${c})),'-',''),' ',''),'.','')`;
const r2 = (n) => Math.round((n || 0) * 100) / 100;
const r3 = (n) => Math.round((n || 0) * 1000) / 1000;
const DAY = 864e5;
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const t0 = (s) => Date.parse(s + 'T00:00:00Z');
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const todayIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

export const DEFAULTS = { gap: 0, leadDefault: 7, safeRun: 7, safeNorm: 3, roofMonths: 2, runHits: 4, bigBill: 3 };
const LABELS = { gap: 'Order gap (din, 0 = PO se auto)', leadDefault: 'Lead time (jab PO se na mile)', safeRun: 'Safety din — Running', safeNorm: 'Safety din — Normal',
  roofMonths: 'Roof (Normal/Slow, mahine)', runHits: 'Running = mahine me kitne bill', bigBill: 'Bada bill = median ka kitna guna' };

function ensureSettings() { db().exec(`CREATE TABLE IF NOT EXISTS guide_settings (key TEXT PRIMARY KEY, value REAL)`); }
export function settings() {
  ensureSettings();
  const s = { ...DEFAULTS };
  for (const r of db().prepare('SELECT key, value FROM guide_settings').all()) if (r.key in s && Number.isFinite(r.value)) s[r.key] = r.value;
  return s;
}

// ---------- lead time + order gap (PO report se) ----------
function poTiming() {
  const out = { perPart: new Map(), lead: null, gap: null, leadN: 0 };
  if (!tableExists('parts_orders')) return out;
  const d = db();
  const all = [];
  for (const r of d.prepare(`SELECT ${PKSQL('partNo')} k, orderDate o, MIN(grnDate) g FROM parts_orders
      WHERE orderDate IS NOT NULL AND grnDate IS NOT NULL GROUP BY k, poNo`).all()) {
    const days = Math.round((t0(r.g) - t0(r.o)) / DAY);
    if (days < 0 || days > 120) continue;
    all.push(days);
    if (!out.perPart.has(r.k)) out.perPart.set(r.k, []);
    out.perPart.get(r.k).push(days);
  }
  out.lead = all.length >= 5 ? median(all) : null; out.leadN = all.length;   // 5 se kam GRN -> setting wala lead time
  // order gap: pichhle 120 din me jin dino order laga, unke beech ka median farak
  const dates = d.prepare(`SELECT DISTINCT orderDate d FROM parts_orders WHERE orderDate IS NOT NULL ORDER BY d`).all().map((x) => x.d);
  const last = dates[dates.length - 1];
  const recent = last ? dates.filter((x) => t0(x) >= t0(last) - 120 * DAY) : [];
  const gaps = []; for (let i = 1; i < recent.length; i++) gaps.push(Math.round((t0(recent[i]) - t0(recent[i - 1])) / DAY));
  out.gap = gaps.length >= 5 ? median(gaps) : null;             // 5 se kam order -> andaza nahi, setting/default chalega
  out.gapN = gaps.length;
  return out;
}

export function buildGuide() {
  const S = settings();
  const d = db();
  const snap = latestSnap('parts');
  if (!snap) return { error: 'Parts Master server pe nahi — Master page se upload karo', rows: [], summary: {} };
  if (!tableExists('parts_sales')) return { error: 'Parts sale data nahi — Sales Sync karo', rows: [], summary: {} };

  // ---- window ----
  const rng = d.prepare(`SELECT MIN(date) a, MAX(date) b FROM parts_sales WHERE date IS NOT NULL`).get();
  if (!rng.b) return { error: 'Parts sale data khaali', rows: [], summary: {} };
  const end = rng.b > todayIST() ? todayIST() : rng.b;
  const endT = t0(end);
  const startT = endT - 181 * DAY;                               // 182 din = 6 × ~30
  const dataStartT = Math.max(startT, t0(rng.a));
  const covered = Math.round((endT - dataStartT) / DAY) + 1;     // kitne din ka data asal me hai
  const bOf = (dt) => Math.min(5, Math.floor((endT - t0(dt)) / DAY / 30.33));
  // kaunse 30-din ke hisse me data SACH me hai (sync chhoota ho to wo hissa ginti se bahar — warna bikri kam dikhegi)
  const bDays = [0, 0, 0, 0, 0, 0];
  for (const r of d.prepare(`SELECT DISTINCT date FROM parts_sales WHERE date BETWEEN ? AND ?`).all(iso(startT), end)) bDays[bOf(r.date)]++;
  const valid = bDays.map((n) => n >= 8);
  const monthsCov = Math.max(1, valid.filter(Boolean).length);
  const bLabel = (i) => `${toDMY(iso(endT - Math.floor((i + 1) * 30.33 - 1) * DAY))} – ${toDMY(iso(endT - Math.floor(i * 30.33) * DAY))}`;

  // ---- bikri: har part, har bill (invoice) ki qty ----
  const P = new Map();   // key -> stats
  const get = (k, pn, nm) => {
    if (!P.has(k)) P.set(k, { k, partNo: pn, name: nm || '', bills: [], first: null, last: null, wq: 0, cq: 0 });
    return P.get(k);
  };
  for (const r of d.prepare(`SELECT ${PKSQL('partNo')} k, MIN(partNo) pn, MAX(partName) nm, invoiceNo inv, src, MIN(date) dt, SUM(IFNULL(qty,0)) q
      FROM parts_sales WHERE date BETWEEN ? AND ? GROUP BY k, invoiceNo, src`).all(iso(startT), end)) {
    if (!(r.q > 0)) continue;
    const x = get(r.k, r.pn, r.nm);
    x.bills.push({ dt: r.dt, q: r.q });
    if (!x.first || r.dt < x.first) x.first = r.dt;
    if (!x.last || r.dt > x.last) x.last = r.dt;
    if (r.src === 'counter') x.cq += r.q; else x.wq += r.q;
  }

  // ---- stock, PO, master info ----
  const live = new Map(partsLive().rows.map((r) => [KEY(r.partNo), r]));
  const po = ourPO();
  const tm = poTiming();
  const hero = soqLatestMap();
  const gapUsed = S.gap > 0 ? S.gap : Math.min(30, Math.max(1, tm.gap ?? 7));   // na setting, na PO -> 7 din
  const leadAll = tm.lead != null ? Math.min(60, Math.max(1, tm.lead)) : S.leadDefault;

  // ---- alternates: purane part ki bikri + stock naye part me jodo ----
  const alts = new Map();
  if (d.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='part_alternates'`).get())
    for (const a of d.prepare('SELECT old_key, old_part, new_part FROM part_alternates').all()) alts.set(a.old_key, a);

  const keys = new Set([...P.keys(), ...[...live.entries()].filter(([, v]) => (v.stock || 0) > 0).map(([k]) => k)]);
  for (const [ok, a] of alts) { keys.add(ok); keys.add(KEY(a.new_part)); }

  const stat = (k) => {
    const x = P.get(k) || { bills: [], first: null, last: null, wq: 0, cq: 0 };
    const med = median(x.bills.map((b) => b.q)) || 1;
    const cap = Math.max(2, S.bigBill * med);
    const buckets = [0, 0, 0, 0, 0, 0], hitsB = [0, 0, 0, 0, 0, 0];
    let raw = 0, capped = 0, bigBills = 0;
    for (const b of x.bills) {
      const i = bOf(b.dt);
      const q = Math.min(b.q, cap);
      if (b.q > cap) bigBills++;
      buckets[i] += q; hitsB[i]++; raw += b.q; capped += q;
    }
    return { x, buckets, hitsB, raw, capped, bigBills, cap };
  };

  const rows = [];
  for (const k of keys) {
    const lv = live.get(k);
    let st = stat(k);
    let stock = Math.max(0, lv?.stock || 0);
    const alt = alts.get(k);
    const fromOld = [...alts.values()].filter((a) => KEY(a.new_part) === k);
    for (const a of fromOld) {             // naya part: purane ki bikri + stock bhi iska
      const o = stat(a.old_key);
      st.buckets = st.buckets.map((v, i) => v + o.buckets[i]); st.hitsB = st.hitsB.map((v, i) => v + o.hitsB[i]);
      st.raw += o.raw; st.capped += o.capped; st.bigBills += o.bigBills;
      if (o.x.first && (!st.x.first || o.x.first < st.x.first)) st.x = { ...st.x, first: o.x.first };
      stock += Math.max(0, live.get(a.old_key)?.stock || 0);
    }
    const monthsSold = st.buckets.filter((v, i) => valid[i] && v > 0).length;
    const hits = st.hitsB.reduce((a, b) => a + b, 0);
    const hitsPerMonth = hits / monthsCov;
    const firstT = st.x.first ? t0(st.x.first) : null;
    const isNew = firstT != null && endT - firstT < 60 * DAY && valid.slice(2).some(Boolean);   // pehle ka data hai, par tab nahi bika

    // roz ki bikri — sirf un hisson se jinka data hai. 60% pichhle 3, 40% usse pehle ke 3
    const part = (from, to) => { let q = 0, n = 0; for (let i = from; i <= to; i++) if (valid[i]) { q += st.buckets[i]; n++; } return n ? q / (n * 30.33) : null; };
    const dR = part(0, 2), dO = part(3, 5);
    let daily = dR != null && dO != null ? 0.6 * dR + 0.4 * dO : (dR ?? dO ?? 0);
    if (isNew) daily = st.capped / Math.max(14, Math.round((endT - firstT) / DAY) + 1);

    let cat;
    if (alt) cat = 'Band';
    else if (!hits) cat = 'Dead';
    else if (monthsSold >= Math.max(1, Math.round(monthsCov * 5 / 6)) && hitsPerMonth >= S.runHits) cat = 'Running';
    else if (hits < 2) cat = 'Kabhi-kabhi';                            // 6 mahine me sirf 1 bill -> maang pe mangao
    else if (isNew && hits >= 3) cat = 'Naya';
    else if (monthsSold >= Math.ceil(monthsCov / 2) && hits >= 3) cat = 'Normal';
    else cat = 'Slow';

    const p = po ? (po.m.get(k) || { pending: 0, git: 0 }) : { pending: 0, git: 0 };
    let pipe = (p.pending || 0) + (p.git || 0);
    for (const a of fromOld) { const q = po?.m.get(a.old_key); if (q) pipe += (q.pending || 0) + (q.git || 0); }
    const h = hero.get(k);
    const moq = Math.max(1, lv?.moq || h?.moq1 || h?.lotSize || 1);
    const tl = tm.perPart.get(k);
    const lead = tl && tl.length >= 2 ? Math.min(60, Math.max(1, median(tl))) : leadAll;
    const safetyDays = cat === 'Running' ? S.safeRun : cat === 'Normal' ? S.safeNorm : 0;

    let need = daily * (lead + gapUsed), safety = daily * safetyDays, target = 0, why = '';
    if (cat === 'Running' || cat === 'Normal') {
      target = need + safety;
      if (cat === 'Normal') { const roof = daily * S.roofMonths * 30; if (target > roof) { target = roof; why = 'roof'; } }
      target = Math.max(1, Math.ceil(target - 1e-9));
    } else if (cat === 'Naya') { target = Math.max(1, Math.ceil(need - 1e-9)); }
    else if (cat === 'Slow') { target = stock + pipe <= 0 ? 1 : 0; need = 0; safety = 0; }
    else { need = 0; safety = 0; }                                   // Dead / Band / Kabhi-kabhi
    let order = Math.max(0, target - stock - pipe);
    if (order > 0) order = Math.ceil(order / moq) * moq;

    if (!lv && !hits && cat !== 'Band') continue;                    // na stock, na bikri
    if (cat === 'Dead' && stock <= 0 && !fromOld.length) continue;
    const rate = lv?.dlc || h?.dlp || 0;
    const heroSoq = h ? h.soq ?? 0 : null;
    const flags = [];
    if (order > 0) flags.push('order');
    if (heroSoq != null && ((order > 0) !== (heroSoq > 0) || (Math.max(order, heroSoq) >= 3 && Math.max(order, heroSoq) > 2 * Math.min(order, heroSoq)))) flags.push('heroDiff');
    if (st.bigBills) flags.push('bigBill');
    rows.push({
      partNo: lv?.partNo || st.x.partNo || alt?.old_part || fromOld[0]?.new_part || k, partDesc: lv?.desc || st.x.name || '', cat,
      monthsSold, monthsCov, hits, perMonthHits: r2(hitsPerMonth), sold6: r3(st.raw), soldUsed: r3(st.capped), bigBills: st.bigBills,
      months: st.buckets.map((v, i) => (valid[i] ? r3(v) : null)), perMonthQty: r2(daily * 30), daily: r3(daily),
      workshopPct: st.raw ? Math.round((st.x.wq / (st.x.wq + st.x.cq || 1)) * 100) : null,
      lastSale: toDMY(st.x.last || ''), firstSale: toDMY(st.x.first || ''),
      lead: r2(lead), leadOwn: !!(tl && tl.length >= 2), gap: gapUsed, safetyDays, need: r2(need), safety: r2(safety), target, roofHit: why === 'roof',
      stock: r3(stock), pending: r3(p.pending), git: r3(p.git), pipe: r3(pipe), order, moq, rate, value: Math.round(order * rate), stockValue: Math.round(stock * rate),
      heroSoq, abc: h?.abc || '', fms: h?.fms || '',
      altTo: alt?.new_part || '', altFrom: fromOld.map((a) => a.old_part).join(', '), flags,
    });
  }
  const catRank = { Running: 0, Normal: 1, Naya: 2, Slow: 3, 'Kabhi-kabhi': 4, Band: 5, Dead: 6 };
  rows.sort((a, b) => (b.value - a.value) || (catRank[a.cat] - catRank[b.cat]) || (b.daily - a.daily));
  const c = (k) => rows.filter((r) => r.cat === k);
  return {
    settings: S, labels: LABELS,
    window: { from: toDMY(iso(dataStartT)), to: toDMY(end), days: covered, months: monthsCov,
      parts: bDays.map((n, i) => ({ label: bLabel(i), days: n, ok: valid[i] })) },
    snapshot: toDMY(snap.as_of), leadAll: r2(leadAll), leadFromPO: tm.lead != null, leadN: tm.leadN, gapUsed, gapAuto: tm.gap, hasPO: !!po,
    poRange: po ? { from: toDMY(po.from), to: toDMY(po.to) } : null, hasSoq: hero.size > 0,
    rows,
    summary: {
      parts: rows.length, order: rows.filter((r) => r.order > 0).length, orderValue: rows.reduce((s, r) => s + r.value, 0),
      Running: c('Running').length, Normal: c('Normal').length, Slow: c('Slow').length, Naya: c('Naya').length, Band: c('Band').length, Rare: c('Kabhi-kabhi').length,
      Dead: c('Dead').length, deadValue: c('Dead').reduce((s, r) => s + r.stockValue, 0), heroDiff: rows.filter((r) => r.flags.includes('heroDiff')).length,
    },
  };
}

guideApi.get('/parts/guide', (_req, res) => { try { res.json(buildGuide()); } catch (e) { res.status(500).json({ error: e.message }); } });
guideApi.get('/parts/guide/settings', (_req, res) => { res.json({ settings: settings(), defaults: DEFAULTS, labels: LABELS }); });
guideApi.post('/parts/guide/settings', (req, res) => {
  try {
    ensureSettings();
    const b = req.body || {};
    const up = db().prepare('INSERT INTO guide_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const k of Object.keys(DEFAULTS)) if (k in b) {
      const v = b[k] === '' || b[k] == null ? DEFAULTS[k] : Number(b[k]);
      if (!Number.isFinite(v) || v < 0 || v > 365) throw new Error(`${LABELS[k]}: galat number`);
      up.run(k, v);
    }
    res.json({ ok: true, settings: settings() });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
