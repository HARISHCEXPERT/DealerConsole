// Shared Puppeteer launcher — STEALTH + PERSISTENT PROFILE (session/cookies save).
// userDataDir se cookies bach jaate hain -> baar-baar login nahi (khaaskar PowerBI).
import _pe from 'puppeteer-extra';
import _stealth from 'puppeteer-extra-plugin-stealth';
import path from 'node:path';
import fs from 'node:fs';
import { getSetting } from '../config/creds.js';

const puppeteer = _pe.default || _pe;
const StealthPlugin = _stealth.default || _stealth;
puppeteer.use(StealthPlugin());

// alag-alag profile (default: shared). PowerBI ke liye 'pbi' pass karenge.
export async function launchBrowser(profile = 'default') {
  const raw = String(process.env.PUPPETEER_HEADFUL ?? '').trim().replace(/^["']|["']$/g, '');
  // ⚙ Sync Settings ka "Browser dikhao" sabse upar — wahan set hai to .env/terminal ki baat nahi maani jaati
  let ui = null; try { ui = getSetting('showBrowser', '0'); } catch {}   // default BAND — sirf ⚙ se on
  const headful = ui != null ? ui === '1' : /^(1|true|yes|on|haan)$/i.test(raw);
  console.log(`[browser] ${profile}: ${headful ? 'WINDOW DIKHEGI (headful)' : 'chhupa chalega (headless)'} — ${ui != null ? '⚙ Settings: ' + (ui === '1' ? 'ON' : 'OFF') : 'PUPPETEER_HEADFUL="' + raw + '"'}`);
  process.env.DC_SHOW_BROWSER = headful ? '1' : '0';
  const dir = path.resolve('.profiles', profile);
  fs.mkdirSync(dir, { recursive: true });
  return puppeteer.launch({
    // release build: dealer ke PC ka Google Chrome (puppeteer ka alag Chrome download nahi)
    ...(process.env.DC_SYSTEM_CHROME === '1' ? { channel: 'chrome' } : {}),
    headless: headful ? false : 'new',
    slowMo: headful ? 35 : 0,
    defaultViewport: null,
    userDataDir: dir,                 // <-- session/cookies yahan save
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--start-maximized',
    ],
  });
}