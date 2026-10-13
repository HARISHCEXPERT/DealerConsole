// App-level encryption. Key SIRF app server pe (env), Supabase pe kabhi nahi.
// Sirf sensitive PII (naam/phone/amount). Chassis/part-no/dates PLAIN — warna search marega.
import crypto from 'node:crypto';
import { env } from '../config/env.js';

const ALGO = 'aes-256-gcm';
const key = () => crypto.createHash('sha256').update(env.encKey || 'dev-only').digest();

export function encrypt(text) {
  if (text == null) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}
export function decrypt(b64) {
  if (b64 == null) return null;
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), data = buf.subarray(28);
  const d = crypto.createDecipheriv(ALGO, key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}
