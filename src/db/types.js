// Value parsers — Excel/DMS ki kachchi value -> DB ki saaf value.
// Dates hamesha 'YYYY-MM-DD' (IST calendar date) me store hoti hain — timezone ka jhanjhat khatam.

const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => (y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31) ? `${y}-${pad(m)}-${pad(d)}` : null;

export function toDate(v) {
  if (v === '' || v == null) return null;
  if (v instanceof Date) return isNaN(v) ? null : ymd(v.getFullYear(), v.getMonth() + 1, v.getDate());
  const s = String(v).trim();
  if (!s) return null;
  // Excel serial (46236 / 46236.73) — sirf din ka hissa, UTC me gino (TZ shift nahi)
  if (/^\d{4,6}(\.\d+)?$/.test(s)) {
    const n = Math.floor(Number(s));
    if (n > 20000 && n < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
      return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
  }
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) {
    // ISO. Agar time + Z hai (jaise 2026-08-09T18:30:00.000Z) to IST me badlo
    if (/T\d{2}:\d{2}/.test(s) && /Z|[+-]\d{2}:?\d{2}$/.test(s)) {
      const d = new Date(new Date(s).getTime() + 5.5 * 3600000);
      if (!isNaN(d)) return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    return ymd(+m[1], +m[2], +m[3]);
  }
  if ((m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/))) return ymd(+m[3], +m[2], +m[1]);       // dd/mm/yyyy
  if ((m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-](\d{2,4})/))) {                           // 26-Aug-2025
    const mo = MONTHS[m[2].toLowerCase()]; let y = +m[3]; if (y < 100) y += 2000;
    return mo ? ymd(y, mo, +m[1]) : null;
  }
  if ((m = s.match(/^([A-Za-z]{3})[A-Za-z]*[\s-](\d{4})$/))) {                                          // Aug-2025 (Manufacturing Month)
    const mo = MONTHS[m[1].toLowerCase()];
    return mo ? ymd(+m[2], mo, 1) : null;
  }
  return null;
}

// 'YYYY-MM-DD' -> 'dd/mm/yyyy' (frontend purane format me hi padhta hai)
export const toDMY = (s) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s)) ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : (s || '');

export function toNum(v) {
  if (v === '' || v == null) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return isFinite(n) && String(v).match(/\d/) ? n : null;
}

export function toBool(v) {
  if (v === true || v === false) return v ? 1 : 0;
  if (v === '' || v == null) return null;
  const s = String(v).trim().toUpperCase();
  return ['Y', 'YES', 'TRUE', '1'].includes(s) ? 1 : ['N', 'NO', 'FALSE', '0'].includes(s) ? 0 : null;
}

export function toText(v) {
  if (v == null) return null;
  const s = String(v).replace(/\r\n?/g, '\n').replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').trim();
  return s === '' ? null : s;
}

export const parse = { text: toText, num: toNum, int: (v) => { const n = toNum(v); return n == null ? null : Math.round(n); }, date: toDate, bool: toBool };
export const sqlType = { text: 'TEXT', num: 'REAL', int: 'INTEGER', date: 'TEXT', bool: 'INTEGER' };

// "Customer Code " -> "customerCode"  (naye auto-columns ka naam)
export function slug(h) {
  const words = String(h).replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return null;
  const s = words.map((w, i) => i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()).join('');
  return /^\d/.test(s) ? 'c' + s : s;
}
