// WhatsApp Cloud API. Node 18+ global fetch — node-fetch ESM jhamela nahi.
import { env } from '../config/env.js';
export async function sendWhatsApp(to, text) {
  if (!env.waba.token) { console.warn('[wa] token missing, skip'); return; }
  const r = await fetch(`https://graph.facebook.com/v20.0/${env.waba.phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.waba.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
  });
  if (!r.ok) console.error('[wa] send failed', await r.text());
}
