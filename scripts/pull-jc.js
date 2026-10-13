// Sirf PowerBI Service JobCards nikaalo (backend, client ko nahi dikhta)
//   npm run pull-jc -- 01/09/2026 27/09/2026
//   (To na do to aaj tak; kuch na do to is mahine ki 1 se aaj tak)
import '../src/config/env.js';
import { pullReports } from '../src/jobs/pull.js';

const dmy = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
const now = new Date();
const from = process.argv[2] || dmy(new Date(now.getFullYear(), now.getMonth(), 1));
const to = process.argv[3] || dmy(now);
console.log(`JobCards: ${from} -> ${to} …`);
const out = await pullReports(['service_jc'], { from, to });
const r = out?.results?.service_jc || {};
if (r.error) { console.log('FAIL:', r.error); process.exit(1); }
console.log(`OK: +${r.added ?? 0} naye, ~${r.updated ?? 0} update, ↺${r.replaced ?? 0} badle`);
process.exit(0);
