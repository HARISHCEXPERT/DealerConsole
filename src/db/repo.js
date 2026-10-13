// Read side — ledger ka projection -> current state jo API/frontend ko chahiye.
import { requireSupabase } from '../config/supabase.js';
export async function latestSnapshot(dealerId, entity) {
  const { data, error } = await requireSupabase()
    .from('ledger').select('*')
    .eq('dealer_id', dealerId).eq('entity', entity)
    .order('fetched_at', { ascending: false }).limit(500);
  if (error) throw error;
  return data;
}
// TODO: dashboard aggregates, DSE rollup, dead-stock query, "sold but no FSC" list.
