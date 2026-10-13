// ============================================================
//  DEALER CONSOLE — LICENSE Edge Function
//  Supabase dashboard → Edge Functions → Create function → naam: license → ye poora paste → Deploy
//  Secrets (Edge Functions → Secrets): LICENSE_PRIVATE_KEY = (npm run license-keygen ka PRIVATE wala)
//
//  POST { action:'activate', login, password, deviceId, deviceName, version }
//  POST { action:'refresh',  token, deviceId, version }
//  -> { ok:true, token }   token = base64url(payload).base64url(Ed25519 signature)
//     payload = { dealer, name, plan, exp (ISO), dev, iat (server ISO), status }
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const b64u = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

let privKey: CryptoKey | null = null;
async function key() {
  if (privKey) return privKey;
  const raw = (Deno.env.get("LICENSE_PRIVATE_KEY") || "").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  if (!raw) throw new Error("LICENSE_PRIVATE_KEY secret nahi daala");
  privKey = await crypto.subtle.importKey("pkcs8", unb64(raw), { name: "Ed25519" }, false, ["sign"]);
  return privKey;
}
async function sign(payload: Record<string, unknown>) {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, await key(), body));
  return b64u(body) + "." + b64u(sig);
}
// password: pbkdf2$iter$saltB64$hashB64 (admin panel isi tarah banata hai)
async function checkPass(pass: string, stored: string) {
  const [alg, it, salt, hash] = String(stored || "").split("$");
  if (alg !== "pbkdf2") return false;
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unb64(salt), iterations: Number(it) }, base, 256));
  const want = unb64(hash);
  if (want.length !== bits.length) return false;
  let d = 0; for (let i = 0; i < bits.length; i++) d |= bits[i] ^ want[i];
  return d === 0;
}
const log = (dealer_code: string | null, action: string, detail: string, device_id?: string) =>
  db.from("license_log").insert({ dealer_code, action, detail, device_id: device_id || null }).then(() => {}, () => {});

async function issue(d: Record<string, any>, deviceId: string) {
  return sign({ dealer: d.dealer_code, name: d.name, plan: d.plan, exp: new Date(d.expires_at).toISOString(), dev: deviceId, iat: new Date().toISOString(), status: d.status });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const b = await req.json().catch(() => ({}));
    const deviceId = String(b.deviceId || "").slice(0, 128);
    if (!deviceId) return json({ ok: false, error: "deviceId nahi" }, 400);

    if (b.action === "activate") {
      const login = String(b.login || "").trim().toLowerCase();
      const { data: d } = await db.from("dealers").select("*").eq("login_id", login).maybeSingle();
      if (!d || !(await checkPass(String(b.password || ""), d.pass_hash))) { await log(d?.dealer_code ?? null, "denied", "galat ID/password: " + login, deviceId); return json({ ok: false, error: "Login ID ya password galat" }, 401); }
      if (d.status !== "active") { await log(d.dealer_code, "denied", "suspended", deviceId); return json({ ok: false, error: "License roka gaya hai — Dealer Console se baat karein" }, 403); }
      if (d.device_id && d.device_id !== deviceId) { await log(d.dealer_code, "denied", "doosra PC", deviceId); return json({ ok: false, error: "Ye license doosre PC pe chalu hai. Naye PC pe chalane ke liye device reset karwayein." }, 409); }
      const upd: Record<string, unknown> = { last_seen: new Date().toISOString(), app_version: b.version || null };
      if (!d.device_id) Object.assign(upd, { device_id: deviceId, device_name: String(b.deviceName || "").slice(0, 80), device_bound_at: new Date().toISOString() });
      await db.from("dealers").update(upd).eq("id", d.id);
      await log(d.dealer_code, "activate", b.version || "", deviceId);
      return json({ ok: true, token: await issue(d, deviceId) });
    }

    if (b.action === "refresh") {
      const tok = String(b.token || "");
      const [p] = tok.split(".");
      let pl: any; try { pl = JSON.parse(new TextDecoder().decode(unb64u(p))); } catch { return json({ ok: false, error: "token kharab" }, 400); }
      // token ka asli hona: dealer + device DB se milao (signature app pehle hi check kar chuka; yahan DB hi sach)
      const { data: d } = await db.from("dealers").select("*").eq("dealer_code", pl.dealer).maybeSingle();
      if (!d) return json({ ok: false, error: "Dealer nahi mila", revoke: true }, 404);
      if (d.device_id && d.device_id !== deviceId) { await log(d.dealer_code, "denied", "refresh: doosra PC", deviceId); return json({ ok: false, error: "Ye license doosre PC pe chala gaya / reset hua. Dobara login karein.", revoke: true }, 409); }
      if (!d.device_id) return json({ ok: false, error: "Device reset hua — dobara login karein", revoke: true }, 409);
      await db.from("dealers").update({ last_seen: new Date().toISOString(), app_version: b.version || null }).eq("id", d.id);
      return json({ ok: true, token: await issue(d, deviceId) });   // suspended ho to bhi token (status:'suspended') — app lock karega
    }
    return json({ ok: false, error: "action?" }, 400);
  } catch (e) { return json({ ok: false, error: String((e as Error).message || e) }, 500); }
});
