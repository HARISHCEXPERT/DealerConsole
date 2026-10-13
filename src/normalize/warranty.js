export function normalizeWarranty(raw) {
  return { claimNo: raw.claimNo, chassis: raw.chassis, model: raw.model,
    partReplaced: raw.partReplaced, defectCode: raw.defectCode, amount: raw.amount, status: raw.status, date: raw.date };
}
