// Shaam ki report banao -> WhatsApp bhejo (BotSaathi pipe).
import { sendWhatsApp } from '../delivery/whatsapp.js';
export async function eveningReport(dealerId) {
  // TODO: aggregates -> readable summary
  const text = 'Aaj ka summary — (TODO)';
  await sendWhatsApp(process.env.OWNER_PHONE, text);
}
