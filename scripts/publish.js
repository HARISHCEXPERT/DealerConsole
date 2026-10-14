// ============================================================
//  PUBLISH — compiled release ko ALAG release-repo me daal ke GitHub pe push.
//    npm run publish
//  Source (src/) kabhi release-repo me nahi jaata. node_modules bhi nahi (dealer ke PC pe npm install).
//  release-repo path: .env me RELEASE_REPO=... , warna ..\DealerConsole-release
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
dotenv.config();

const ROOT = process.cwd();
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const OUT = path.join(ROOT, 'release', 'DealerConsole', 'app');
const REPO = process.env.RELEASE_REPO || path.resolve(ROOT, '..', 'DealerConsole-release');
const step = (m) => console.log('\n> ' + m);
const die = (m) => { console.error('\nX ' + m); process.exit(1); };
const run = (cmd, args, cwd, useShell = false) => { const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: useShell }); return r.status === 0; };
const npm = (args, cwd) => run('npm', args, cwd, true);   // npm .cmd hai -> Windows pe shell chahiye (args me space nahi, safe)

step('Build (npm run build)');
if (!npm(['run', 'build'], ROOT)) die('build fail');
if (!fs.existsSync(path.join(OUT, 'server.mjs'))) die('build output nahi mila');

if (!fs.existsSync(REPO)) die(`Release repo folder nahi: ${REPO}\n  Pehle banao: ek baar\n    cd ..\n    git clone https://github.com/<tum>/DealerConsole-release.git\n  (ya khaali folder me: git init + git remote add origin <url>)`);
if (!fs.existsSync(path.join(REPO, '.git'))) die(`${REPO} git repo nahi hai (git clone/init karo)`);

step('Compiled files release-repo me copy');
const appDir = path.join(REPO, 'app');
// purani app saaf (node_modules/.env/db dealer ke rehne do — wo .gitignore me hain, yahan copy nahi karte)
for (const f of ['server.mjs', 'frontend']) fs.rmSync(path.join(appDir, f), { recursive: true, force: true });
fs.mkdirSync(appDir, { recursive: true });
const copy = (s, d) => fs.cpSync(s, d, { recursive: true });
copy(path.join(OUT, 'server.mjs'), path.join(appDir, 'server.mjs'));
copy(path.join(OUT, 'frontend'), path.join(appDir, 'frontend'));
copy(path.join(OUT, 'package.json'), path.join(appDir, 'package.json'));
copy(path.join(OUT, 'package-lock.json'), path.join(appDir, 'package-lock.json'));
copy(path.join(OUT, '.env.base'), path.join(appDir, '.env.base'));

step('Launcher + readme + gitignore (release-repo)');
fs.writeFileSync(path.join(REPO, '.gitignore'),
  ['app/node_modules/', 'app/.env', 'app/db/', 'app/downloads/', 'app/.profiles/', 'app/logs/', 'app/.ocr-cache/'].join('\n') + '\n');
// dealer ka launcher: launch pe update le, zaroorat ho to npm install, phir chalu
fs.writeFileSync(path.join(REPO, 'Dealer Console.bat'), [
  '@echo off', 'chcp 65001 >nul', 'title Dealer Console', 'cd /d "%~dp0"',
  'where git >nul 2>nul || (echo Git nahi mila - ek baar install karo: git-scm.com & pause & exit /b)',
  'where node >nul 2>nul || (echo Node nahi mila - ek baar install karo: nodejs.org & pause & exit /b)',
  'echo Naya update dekh rahe...',
  'git fetch --quiet origin',
  'git reset --hard origin/main --quiet',
  'cd app',
  'if not exist "node_modules" ( echo Pehli baar setup... thoda ruko & npm install --omit=dev --no-audit --no-fund --loglevel=error )',
  'node -e "const fs=require(\'fs\'),c=require(\'crypto\');const h=c.createHash(\'md5\').update(fs.readFileSync(\'package.json\')).digest(\'hex\');let o=\'\';try{o=fs.readFileSync(\'node_modules/.pkghash\',\'utf8\')}catch{};process.exit(h===o?0:3)"',
  'if errorlevel 3 ( echo Nayi cheezein aayi, update kar rahe... & npm install --omit=dev --no-audit --no-fund --loglevel=error & node -e "const fs=require(\'fs\'),c=require(\'crypto\');fs.writeFileSync(\'node_modules/.pkghash\',c.createHash(\'md5\').update(fs.readFileSync(\'package.json\')).digest(\'hex\'))" )',
  'if not exist ".env" ( copy .env.base .env >nul & for /f %%k in (\'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\') do echo ENCRYPTION_KEY=%%k>>.env )',
  'start "" cmd /c "timeout /t 6 >nul & start http://localhost:4000"',
  'node server.mjs',
  'pause',
].join('\r\n'), 'utf8');
// dealer ko bhejne wali ek-click setup file bhi repo me rakho (latest copy)
const setupSrc = path.join(ROOT, 'scripts', 'DealerConsole-Setup.bat');
if (fs.existsSync(setupSrc)) fs.copyFileSync(setupSrc, path.join(REPO, 'DealerConsole-Setup.bat'));
fs.writeFileSync(path.join(REPO, 'PEHLE-PADHO.txt'),
  `Dealer Console\r\n\r\nEk baar: is PC pe Node (nodejs.org) aur Git (git-scm.com) install hone chahiye, aur Chrome.\r\n"Dealer Console.bat" pe double-click. Ye khud naya update le aata hai.\r\nPehli screen par Dealer Console se mili License ID aur Password daalo.\r\n`, 'utf8');

step('Git push');
run('git', ['add', '-A'], REPO);
run('git', ['commit', '-m', `release v${pkg.version} ${new Date().toISOString().slice(0, 16)}`], REPO);
if (!run('git', ['push', '-u', 'origin', 'HEAD'], REPO)) die('push fail - release repo ka remote set hai? (git remote -v)');
step('DONE — dealer ke app me agle launch par update aa jayega');