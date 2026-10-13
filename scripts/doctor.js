// ============================================================
//  DOCTOR — bug dhoondhne ke liye ek jaanch.  npm run doctor   (ya Debug.bat)
//    ✓ theek   ⚠ dekh lo   ✗ galti (isko theek kiye bina app nahi chalega)
//  --report <run.log>  ->  logs/bug-report-<samay>/ folder (doctor + log + sync ki galtiyan + screenshots)
//  Password / key kabhi print nahi hote — sirf "hai / nahi hai".
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();
const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const out = [];
let bad = 0, warn = 0;
const say = (s) => { out.push(s); console.log(s); };
const ok = (m) => say('  ✓ ' + m);
const wr = (m) => { warn++; say('  ⚠ ' + m); };
const no = (m) => { bad++; say('  ✗ ' + m); };
const head = (m) => say('\n== ' + m + ' ==');
const ts = () => { const d = new Date(Date.now() + 5.5 * 3600e3).toISOString(); return d.slice(0, 10).replace(/-/g, '') + '-' + d.slice(11, 19).replace(/:/g, ''); };

say(`Dealer Console — Doctor · ${new Date().toLocaleString('en-IN')} · ${ROOT}`);

// ---------- 1. Node + packages ----------
head('Node aur packages');
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj > 22 || (maj === 22 && min >= 13)) ok('Node ' + process.versions.node);
else no(`Node ${process.versions.node} purana hai — 22.13 ya naya chahiye (node:sqlite)`);
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const missing = Object.keys(pkg.dependencies || {}).filter((d) => { try { require.resolve(d + '/package.json'); return false; } catch { try { require.resolve(d); return false; } catch { return true; } } });
if (missing.length) no('Package install nahi: ' + missing.join(', ') + '  ->  npm install chalao');
else ok(`Saare ${Object.keys(pkg.dependencies || {}).length} package install hain`);
say('  · App version ' + (pkg.version || '?'));

// ---------- 2. .env ----------
head('.env (sirf hai / nahi — value nahi dikhate)');
if (!fs.existsSync('.env')) no('.env file nahi hai');
const has = (k) => !!(process.env[k] && String(process.env[k]).trim());
if (has('ENCRYPTION_KEY')) (/^[0-9a-f]{64}$/i.test(process.env.ENCRYPTION_KEY) ? ok('ENCRYPTION_KEY theek (64 hex)') : wr('ENCRYPTION_KEY hai par 64 hex akshar nahi — password save/padhne me dikkat ho sakti'));
else no('ENCRYPTION_KEY nahi — ⚙ me save password nahi khulenge');
for (const k of ['LICENSE_URL', 'LICENSE_ANON_KEY']) has(k) ? ok(k + ' hai') : no(k + ' nahi — license chalu nahi hoga');
if (has('LICENSE_URL') && /\/(functions|rest)\/v1|\/$/.test(process.env.LICENSE_URL)) wr('LICENSE_URL ke end me /functions/v1 ya / nahi hona chahiye');
if (!has('DC_PASSWORD')) wr('DC_PASSWORD nahi — app ka login default password se chal raha (badlo)');
for (const k of ['PBI_EMAIL', 'DMS_USER', 'DMS_SERVICE_USER', 'WARRANTY_USER']) say(`  · ${k}: ${has(k) ? 'hai' : 'khaali'} (⚙ screen se bhi daal sakte ho)`);
if (has('ADMIN_PANEL')) say('  · ADMIN_PANEL=' + process.env.ADMIN_PANEL + ' (sirf tumhare PC pe hona chahiye)');

// ---------- 3. Files / syntax ----------
head('Code files');
const pub = fs.existsSync('src/license/pubkey.js') ? fs.readFileSync('src/license/pubkey.js', 'utf8') : '';
/BEGIN PUBLIC KEY/.test(pub) ? ok('License public key lagi hai') : no('src/license/pubkey.js me key nahi (REPLACE_ME) — npm run license-keygen');
const jsFiles = [];
const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.m?js$/.test(f.name)) jsFiles.push(p); } };
for (const d of ['src', 'scripts']) if (fs.existsSync(d)) walk(d);
const syntaxBad = jsFiles.filter((f) => spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' }).status !== 0);
syntaxBad.length ? syntaxBad.forEach((f) => no('Syntax galti: ' + f + ' — file adhoori copy hui? dobara daalo')) : ok(`${jsFiles.length} JS file — syntax theek`);
// frontend ke <script> bhi
for (const f of ['frontend/index.html', 'frontend/license.js', 'admin/admin.html']) {
  if (!fs.existsSync(f)) { f === 'frontend/index.html' ? no(f + ' nahi') : wr(f + ' nahi'); continue; }
  const txt = fs.readFileSync(f, 'utf8');
  const scripts = f.endsWith('.js') ? [txt] : [...txt.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const errs = []; scripts.forEach((s, i) => { try { new Function(s); } catch (e) { errs.push(`script #${i + 1}: ${e.message}`); } });
  errs.length ? errs.forEach((e) => no(`${f} ${e}`)) : ok(`${f} — ${(fs.statSync(f).size / 1024).toFixed(0)} KB, script theek · badla ${fs.statSync(f).mtime.toLocaleString('en-IN')}`);
}
// zaroori files jo pichhle zip me aayi thi
for (const f of ['src/api/khaata.js', 'src/api/pdfRows.js', 'src/license/license.js', 'src/config/creds.js', 'src/jobs/catchup.js']) if (!fs.existsSync(f)) no(f + ' nahi hai');

// ---------- 4. Database ----------
head('Database');
const { DatabaseSync } = await import('node:sqlite');
const dbFile = process.env.DB_FILE || path.resolve('db', 'dealer.db');
let sync = [];
if (!fs.existsSync(dbFile)) wr('db/dealer.db abhi nahi bani (pehli sync ke baad banegi)');
else {
  try {
    const d = new DatabaseSync(dbFile, { readOnly: true });
    ok(`dealer.db ${(fs.statSync(dbFile).size / 1048576).toFixed(1)} MB`);
    const tables = d.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map((r) => r.name);
    const counts = tables.map((t) => { try { return `${t} ${d.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n}`; } catch { return t + ' ?'; } });
    say('  · ' + counts.join(' · '));
    if (tables.includes('sync_runs')) {
      sync = d.prepare(`SELECT source, status, range_from, range_to, rows_in, finished_at, error FROM sync_runs ORDER BY id DESC LIMIT 200`).all();
      const last = new Map(); for (const r of sync) if (!last.has(r.source)) last.set(r.source, r);
      for (const [src, r] of last) {
        const when = r.finished_at ? new Date(r.finished_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '?';
        r.status === 'ok' ? ok(`${src}: ${when} · ${r.range_from} → ${r.range_to} · ${r.rows_in} row`) : wr(`${src}: FAIL ${when} — ${String(r.error || '').replace(/\s+/g, ' ').slice(0, 160)}`);
      }
    }
    d.close();
  } catch (e) { no('dealer.db khul nahi rahi: ' + e.message); }
}

// ---------- 5. License ----------
head('License');
try {
  const { licenseStatus, deviceId } = await import(pathToFileURL(path.join(ROOT, 'src', 'license', 'license.js')).href);
  const s = licenseStatus();
  const line = `${s.state}${s.name ? ' · ' + s.name : ''}${s.expDate ? ' · ' + s.expDate + ' tak' : ''}${s.daysLeft != null ? ' · ' + s.daysLeft + ' din' : ''}`;
  s.state === 'active' ? ok(line) : s.state === 'expired' ? wr(line) : no(line + (s.msg ? ' — ' + s.msg : '') + (s.lastError ? ' — ' + s.lastError : ''));
  say('  · Is PC ki pehchaan: ' + deviceId().slice(0, 10) + '…');
} catch (e) { wr('License jaanch nahi hui: ' + e.message); }

// ---------- 6. Network / port ----------
head('Port aur internet');
const port = Number(process.env.PORT || 4000);
const free = await new Promise((r) => { const s = net.createServer().once('error', () => r(false)).once('listening', () => s.close(() => r(true))).listen(port); });
free ? ok(`Port ${port} khaali`) : wr(`Port ${port} pe kuch chal raha hai — app pehle se khula? (doosri window band karo)`);
const probe = async (name, url) => { try { const t = Date.now(); const r = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(8000) }); ok(`${name} pahunch (${r.status}, ${Date.now() - t} ms)`); } catch (e) { wr(`${name} nahi pahunch: ${e.cause?.code || e.message}`); } };
if (has('LICENSE_URL')) await probe('License server', process.env.LICENSE_URL.replace(/\/+$/, '') + '/functions/v1/license');
await probe('PowerBI', 'https://app.powerbi.com');

// ---------- 7. Folders ----------
head('Folders');
for (const d of ['db', 'downloads', 'screenshots', 'logs']) {
  try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); ok(d + '/ likh sakte'); } catch (e) { no(d + '/ me likh nahi sakte: ' + e.message); }
}
const shots = fs.existsSync('screenshots') ? fs.readdirSync('screenshots').map((f) => ({ f, t: fs.statSync(path.join('screenshots', f)).mtimeMs })).sort((a, b) => b.t - a.t) : [];
if (shots.length) say(`  · screenshots: ${shots.length} (sabse naya ${shots[0].f})`);

say(`\nNateeja: ${bad} ✗ galti · ${warn} ⚠ dekh lo`);

// ---------- report ----------
fs.mkdirSync('logs', { recursive: true });
fs.writeFileSync(path.join('logs', `doctor-${ts()}.txt`), out.join('\n'));
const ri = process.argv.indexOf('--report');
if (ri > -1) {
  const dir = path.join('logs', 'bug-report-' + ts());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'doctor.txt'), out.join('\n'));
  const logArg = process.argv[ri + 1];
  const logs = logArg && fs.existsSync(logArg) ? [logArg] : fs.readdirSync('logs').filter((f) => /^run-.*\.log$/.test(f)).sort().slice(-1).map((f) => path.join('logs', f));
  for (const l of logs) { const lines = fs.readFileSync(l, 'utf8').split(/\r?\n/); fs.writeFileSync(path.join(dir, path.basename(l)), lines.slice(-4000).join('\n')); }
  fs.writeFileSync(path.join(dir, 'sync-errors.txt'), sync.filter((r) => r.status !== 'ok').slice(0, 50).map((r) => `${r.finished_at} ${r.source} ${r.range_from}->${r.range_to}\n  ${r.error}`).join('\n\n') || 'koi nahi');
  if (shots.length) { fs.mkdirSync(path.join(dir, 'screenshots')); for (const s of shots.slice(0, 20)) fs.copyFileSync(path.join('screenshots', s.f), path.join(dir, 'screenshots', s.f)); }
  console.log('\nBug report folder: ' + dir);
  fs.writeFileSync(path.join('logs', 'last-report.txt'), dir);
}
process.exit(bad ? 2 : 0);
