// Single Supabase client (service key — server side only).
// Guarded: env na ho to null. Isse UI bina Supabase setup ke bhi serve ho jaata hai
// (API calls fail -> frontend dummy pe gir jaata hai).
import { createClient } from '@supabase/supabase-js';
import { env } from './env.js';

export const supabase = (env.supabase.url && env.supabase.key)
  ? createClient(env.supabase.url, env.supabase.key, { auth: { persistSession: false } })
  : null;

export function requireSupabase() {
  if (!supabase) throw new Error('Supabase not configured — set SUPABASE_URL & SUPABASE_SERVICE_KEY in .env');
  return supabase;
}
