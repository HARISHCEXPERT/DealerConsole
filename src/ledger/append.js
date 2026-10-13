// Append-only write. Kabhi update/delete nahi.
import { requireSupabase } from '../config/supabase.js';
export async function appendEvents(dealerId, source, entity, records, eventType = 'snapshot') {
  const rows = records.map(r => ({
    dealer_id: dealerId, source, entity, event_type: eventType,
    ref_no: r.invoiceNo || r.jobCardNo || r.claimNo || r.couponNo || r.partNo || null,
    chassis: r.chassis || null,
    payload: r,                    // TODO: encrypt PII fields inside before insert
    occurred_at: r.date || r.soldOn || null,
  }));
  const { error } = await requireSupabase().from('ledger').insert(rows);
  if (error) throw error;
  return rows.length;
}
