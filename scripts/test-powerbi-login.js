// PowerBI (Microsoft OAuth) login test — self-diagnosing.
// Chalao:  $env:PUPPETEER_HEADFUL=1; node scripts/test-powerbi-login.js
// .env me chahiye:
//    PBI_URL=https://app.powerbi.com/     (ya tera report URL)
//    PBI_EMAIL=teri-email@...
//    PBI_PASS="tera#pass"
import 'dotenv/config';
import fs from 'node:fs';
import { launchBrowser } from '../src/scrapers/browser.js';

const line = (t) => console.log('\n──────── ' + t + ' ────────');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
fs.mkdirSync('screenshots', { recursive: true });

const URL   = process.env.PBI_URL || 'https://app.powerbi.com/';
const EMAIL = process.env.PBI_EMAIL;
const PASS  = process.env.PBI_PASS;

const shot = async (page, n) => { await page.screenshot({ path: `screenshots/pbi-${n}.png`, fullPage: true }).catch(()=>{}); console.log('  shot -> screenshots/pbi-'+n+'.png'); };

// kisi bhi selector ka intezaar (jo pehle mile)
async function waitAny(page, sels, timeout=25000){
  const t0=Date.now();
  while(Date.now()-t0<timeout){
    for(const s of sels){ const el=await page.$(s); if(el) return s; }
    await sleep(400);
  }
  return null;
}

(async () => {
  if(!EMAIL||!PASS){ console.error('.env me PBI_EMAIL / PBI_PASS bharo (aur PBI_URL optional).'); process.exit(1); }
  const browser = await launchBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(45000);
  try{
    line('1) OPEN'); 
    await page.goto(URL, { waitUntil:'networkidle2', timeout:60000 });
    console.log('url:', page.url()); await shot(page,'01-open');

    line('1b) PowerBI email box (Microsoft se pehle)');
    // PowerBI apna email box: input#email.pbi-text-input -> Submit
    const pbiEmail = await waitAny(page, ['input#email.pbi-text-input','input#email','input[type="email"]'], 12000);
    if(pbiEmail){
      await page.type(pbiEmail, EMAIL, {delay:30});
      await shot(page,'01b-pbi-email');
      const sub = await waitAny(page, ['button[type="submit"]','input[type="submit"]','button'], 6000);
      if(sub) await page.click(sub);
      await sleep(3000);
      console.log('  PowerBI email submit -> url:', page.url());
    } else {
      console.log('  (PowerBI email box nahi mila — shayad seedha MS pe gaya)');
    }

    line('2) EMAIL step (Microsoft)');
    const emailSel = await waitAny(page, ['input[type="email"]','input[name="loginfmt"]','#i0116']);
    if(!emailSel){ console.log('⚠️ email box nahi mila — shayad pehle se logged-in? shot dekh.'); await shot(page,'02-noemail'); }
    else{
      await page.type(emailSel, EMAIL, {delay:30});
      await shot(page,'02-email');
      // Next button
      const nextSel = await waitAny(page, ['#idSIButton9','input[type="submit"]','button[type="submit"]'], 8000);
      if(nextSel) await page.click(nextSel);
      await sleep(2500);
      console.log('  email daal ke Next -> url:', page.url());
    }

    line('3) PASSWORD step');
    const passSel = await waitAny(page, ['input#i0118','input[type="password"]','input[name="passwd"]']);
    if(!passSel){ console.log('⚠️ password box nahi mila. shot dekh (shayad SSO/redirect/aur page).'); await shot(page,'03-nopass'); }
    else{
      await page.type(passSel, PASS, {delay:30});
      await shot(page,'03-pass');
      const signSel = await waitAny(page, ['#idSIButton9','input[type="submit"]','button[type="submit"]'], 8000);
      if(signSel) await page.click(signSel);
      await sleep(3500);
      console.log('  sign-in -> url:', page.url());
    }

    line('4) POST-LOGIN (MFA? / Stay signed in? / andar?)');
    await shot(page,'04-after');
    const state = await page.evaluate(() => {
      const t = (document.body.innerText||'').slice(0,400);
      return {
        mfa: /verify your identity|approve|authenticator|code|one-time|otp/i.test(document.body.innerText||''),
        staySignedIn: /stay signed in/i.test(document.body.innerText||''),
        snippet: t.replace(/\s+/g,' ')
      };
    });
    if(state.staySignedIn){
      console.log('  "Stay signed in?" aaya — Yes dabа rahe...');
      const y = await waitAny(page, ['#idSIButton9','input[type="submit"]'], 6000);
      if(y){ await page.click(y); await sleep(3000); await shot(page,'05-stay'); }
    }
    console.log('  MFA lagta hai?:', state.mfa);
    console.log('  page text (short):', state.snippet.slice(0,200));
    console.log('  final url:', page.url());

    const inApp = /app\.powerbi\.com/i.test(page.url()) && !/login/i.test(page.url());
    console.log(inApp ? '✅ PowerBI ke andar aa gaye lagta hai.' : '⚠️ Abhi login/verify pe atke lagte hain — shots dekh.');
    await shot(page,'06-final');

    line('7) SAHI TENANT (heromotocorp) pe jao');
    // Shortcut: ctid URL se seedha sahi tenant. (Profile > Switch tenant ki zaroorat nahi)
    const CTID = process.env.PBI_CTID || 'f31980c8-b6a6-482d-a0d5-0f73c49dd4e9';
    await page.goto(`https://app.powerbi.com/home?ctid=${CTID}&experience=power-bi`, { waitUntil:'networkidle2', timeout:60000 });
    await sleep(4000);
    console.log('  tenant url:', page.url());
    await shot(page,'07-tenant-home');

    // asli reports dikh rahe? (Hero-NPD / Sales Cockpit)
    const reports = await page.evaluate(() =>
      [...document.querySelectorAll('h3.tri-card-title, .tri-card-title, [class*="card-title"]')]
        .map(e => (e.textContent||'').trim()).filter(Boolean).slice(0,20)
    );
    console.log('  dikhte reports/cards:', reports);
    console.log('\n👉 Ismein "Hero-NPD Reports" / "Sales Cockpit" dikhe to sahi tenant pe aa gaye.');

  }catch(e){
    console.error('❌ FAILED:', e.message); await shot(page,'99-error');
  }finally{
    if(process.env.PUPPETEER_HEADFUL==='1'){ console.log('\n(15s me band…)'); await sleep(15000); }
    await browser.close();
  }
})();