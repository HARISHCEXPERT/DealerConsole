// Loads + lightly validates env. Fail-fast agar zaroori cheez missing ho.
import dotenv from 'dotenv';
dotenv.config();
const need = (k) => { const v = process.env[k]; if (!v) console.warn(`[env] missing: ${k}`); return v; };

// Per-source creds. Alag id ho to DMS_SALE_* daalo, warna shared DMS_* use hoga.
const cred = (p) => ({
  url:  process.env[`DMS_${p}_URL`]  || process.env.DMS_URL,
  user: process.env[`DMS_${p}_USER`] || process.env.DMS_USER,
  pass: process.env[`DMS_${p}_PASS`] || process.env.DMS_PASS,
});

export const env = {
  port: process.env.PORT || 4000,
  // shared (default / back-compat) — Sale isi pe chalta aaya hai
  dms:      { url: process.env.DMS_URL, user: process.env.DMS_USER, pass: process.env.DMS_PASS },
  // per-module (alag id) — na ho to shared pe gir jaata hai
  dmsSale:    cred('SALE'),
  dmsParts:   cred('PARTS'),
  dmsService: cred('SERVICE'),

  warranty: { url: process.env.WARRANTY_URL, user: process.env.WARRANTY_USER, pass: process.env.WARRANTY_PASS },
  supabase: { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_KEY },
  encKey:   process.env.ENCRYPTION_KEY,
  waba:     { token: process.env.WABA_TOKEN, phoneId: process.env.WABA_PHONE_ID },
  pbi:      { email: process.env.PBI_EMAIL, pass: process.env.PBI_PASS, ctid: process.env.PBI_CTID || 'f31980c8-b6a6-482d-a0d5-0f73c49dd4e9' },
  tz:       process.env.TZ || 'Asia/Kolkata',
};

// sirf ek baar warn karo agar sale creds bhi nahi
if (!env.dmsSale.user || !env.dmsSale.pass) console.warn('[env] DMS sale creds missing (DMS_USER/PASS ya DMS_SALE_USER/PASS)');