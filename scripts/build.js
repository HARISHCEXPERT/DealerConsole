// Release build: ek folder jo dealer ko diya ja sake. npm run build -> release/DealerConsole/
// Bundle (esbuild) + minify (terser) + production node_modules + node.exe. src/ scripts/ admin/ .env db/ data/ .profiles/ NAHI jaate.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
import * as esbuild from 'esbuild';
import { minify } from 'terser';

dotenv.config();
const ROOT = process.cwd();
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const OUT = path.join(ROOT, 'release', 'DealerConsole');
const step = (m) => console.log('\n> ' + m);
const die = (m) => { console.error('\nX ' + m); process.exit(1); };

if (!/BEGIN PUBLIC KEY/.test(fs.readFileSync('src/license/pubkey.js', 'utf8'))) die('src/license/pubkey.js me public key nahi - npm run license-keygen');
if (!process.env.LICENSE_URL || !process.env.LICENSE_ANON_KEY) die('.env me LICENSE_URL / LICENSE_ANON_KEY nahi');

step('Purana release saaf');
fs.rmSync(path.join(ROOT, 'release'), { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'app'), { recursive: true });

// native/heavy modules bundle me nahi - node_modules se chalenge
const external = ['puppeteer', 'puppeteer-extra', 'puppeteer-extra-plugin-stealth', '@napi-rs/canvas', 'tesseract.js', 'pdfjs-dist', 'xlsx', 'node:sqlite', 'express', 'node-cron', 'dotenv', '@supabase/supabase-js'];

step('Code ek file me (esbuild)');
const r = await esbuild.build({
  entryPoints: ['src/server.js'], bundle: true, platform: 'node', format: 'esm', target: 'node22',
  outfile: path.join(OUT, 'app', 'server.mjs'), external, legalComments: 'none', minify: false, logLevel: 'warning',
});
if (r.errors?.length) die('esbuild fail');

step('Naam/comment hata ke chhota (terser)');
let code = fs.readFileSync(path.join(OUT, 'app', 'server.mjs'), 'utf8');
const m = await minify(code, { module: true, compress: { passes: 2, drop_debugger: true }, mangle: { toplevel: true }, format: { comments: false } });
fs.writeFileSync(path.join(OUT, 'app', 'server.mjs'), m.code);
console.log('  server.mjs ' + (m.code.length / 1024 | 0) + ' KB');

step('Frontend (script chhote, comment hate)');
fs.mkdirSync(path.join(OUT, 'app', 'frontend'), { recursive: true });
for (const f of fs.readdirSync('frontend')) {
  const src = fs.readFileSync(path.join('frontend', f), 'utf8');
  if (f.endsWith('.html')) {
    const parts = [];
    let i = 0, re = /<script>([\s\S]*?)<\/script>/g, mm;
    let outHtml = '';
    while ((mm = re.exec(src))) {
      outHtml += src.slice(i, mm.index) + '<script>';
      try { const r2 = await minify(mm[1], { compress: true, mangle: true, format: { comments: false } }); outHtml += r2.code || mm[1]; }
      catch { outHtml += mm[1]; }
      outHtml += '</script>'; i = re.lastIndex;
    }
    outHtml += src.slice(i);
    fs.writeFileSync(path.join(OUT, 'app', 'frontend', f), outHtml);
  } else if (f.endsWith('.js')) {
    const r2 = await minify(src, { compress: true, mangle: true, format: { comments: false } }).catch(() => ({ code: src }));
    fs.writeFileSync(path.join(OUT, 'app', 'frontend', f), r2.code || src);
  } else fs.copyFileSync(path.join('frontend', f), path.join(OUT, 'app', 'frontend', f));
}

step('Production packages (npm install --omit=dev)');
const prodPkg = { name: 'dealer-console', version: pkg.version, private: true, type: 'module', dependencies: pkg.dependencies };
fs.writeFileSync(path.join(OUT, 'app', 'package.json'), JSON.stringify(prodPkg, null, 2));
const ni = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: path.join(OUT, 'app'), stdio: 'inherit', env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: '1' }, shell: process.platform === 'win32' });
if (ni.status !== 0) die('npm install fail');

step('.env (sirf license URL/key - password/encryption key dealer ke PC pe banegi)');
fs.writeFileSync(path.join(OUT, 'app', '.env.base'),
`LICENSE_URL=${process.env.LICENSE_URL}\nLICENSE_ANON_KEY=${process.env.LICENSE_ANON_KEY}\n${process.env.LICENSE_SUPPORT ? 'LICENSE_SUPPORT=' + process.env.LICENSE_SUPPORT + '\n' : ''}DC_SYSTEM_CHROME=1\nPORT=4000\n`);

step('Launcher + readme');
fs.writeFileSync(path.join(OUT, 'Dealer Console.bat'), [
  '@echo off', 'chcp 65001 >nul', 'title Dealer Console', 'cd /d "%~dp0app"',
  'where node >nul 2>nul',
  'if errorlevel 1 (if exist "..\\node\\node.exe" (set "PATH=%~dp0node;%PATH%") else (echo Node nahi mila. node\\ folder ke saath chalao. & pause & exit))',
  'if not exist ".env" (',
  '  copy .env.base .env >nul',
  '  for /f %%k in (\'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\') do echo ENCRYPTION_KEY=%%k>>.env',
  '  for /f %%p in (\'node -e "console.log(require(\'crypto\').randomBytes(9).toString(\'base64url\'))"\') do echo DC_PASSWORD=%%p>>.env',
  ')',
  'start "" cmd /c "timeout /t 6 >nul & start http://localhost:4000"',
  'node server.mjs',
  'pause',
].join('\r\n'), 'utf8');
fs.writeFileSync(path.join(OUT, 'PEHLE-PADHO.txt'),
`Dealer Console v${pkg.version}\r\n\r\n1. Chrome install hona chahiye (zyadatar PC me hota hai).\r\n2. "Dealer Console.bat" pe double-click. Pehli baar thoda ruko.\r\n3. Browser me localhost:4000 khulega. Login ID/password Dealer Console se mila hoga.\r\n4. App ka apna login: user admin. Pehli baar ka password app\\.env me DC_PASSWORD= ke aage hai.\r\n`, 'utf8');

// node.exe saath (agar is PC pe hai)
try { const nx = process.execPath; fs.mkdirSync(path.join(OUT, 'node'), { recursive: true }); fs.copyFileSync(nx, path.join(OUT, 'node', path.basename(nx))); console.log('  node.exe daal diya'); }
catch { console.log('  (node.exe copy nahi hua - dealer ke PC pe Node ho ya node\\ folder khud daalo)'); }

// test se bani koi db/.env app me ho to hata do
for (const junk of ['db', '.env', 'downloads', '.profiles', 'logs']) fs.rmSync(path.join(OUT, 'app', junk), { recursive: true, force: true });
step('DONE: ' + OUT);
// Windows pe zip
if (process.platform === 'win32') {
  const zip = path.join(ROOT, 'release', `DealerConsole-${pkg.version}.zip`);
  spawnSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${OUT}' -DestinationPath '${zip}' -Force`], { stdio: 'inherit' });
  console.log('ZIP: ' + zip);
} else console.log('(zip Windows pe banegi)');
