// Chhote cleanup rules — source configs inhe use karte hain.

// "MEHROTRA ENTERPRISES22839-01-DLR-0216-1" -> { name: 'MEHROTRA ENTERPRISES', code: '22839-01-DLR-0216-1' }
export function splitParty(s) {
  if (!s) return { name: s ?? null, code: null };
  const m = String(s).match(/^(.*?)\s*(\d{4,6}-\d{2}-[A-Z]{2,6}-\d{3,4}-\d+)\s*$/);
  return m ? { name: m[1].trim() || null, code: m[2] } : { name: s, code: null };
}

// "CHAIN SPROCKET KIT (SUP. SPLENDOR)-20K710S" -> "CHAIN SPROCKET KIT (SUP. SPLENDOR)"
export function stripPartNo(name, partNo) {
  if (!name || !partNo) return name ?? null;
  const suf = '-' + partNo;
  return name.toUpperCase().endsWith(suf.toUpperCase()) ? name.slice(0, -suf.length).trim() : name;
}

// Model -> segment (heuristic — focus list aane pe master table se aayega)
export function sectionOf(model = '') {
  const s = String(model || '').toUpperCase();
  if (/PLEASURE|DESTINI|MAESTRO|XOOM/.test(s)) return 'Scooter';
  if (/XPULSE|XTREME\s*1[6-9]\d|KARIZMA|160|200|210|440|MAVRICK/.test(s)) return '160cc+';
  if (/125|XTEC|GLAMOUR|SUPER\s*SPLENDOR|XTREME\s*125/.test(s)) return '125cc';
  if (/HF|SPLENDOR|PASSION|100|110/.test(s)) return '100–110cc';
  return '—';
}
