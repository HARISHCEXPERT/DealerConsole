export function normalizeService(raw) {
  return {
    jobCardNo: raw.jobCardNo,
    chassis:   raw.chassis,
    regNo:     raw.regNo,
    model:     raw.model,
    customer:  raw.customer,     // encrypt
    technician:raw.technician,
    type:      raw.type,         // free(FSC) / paid / running-repair
    labour:    raw.labour,
    partsAmt:  raw.partsAmt,
    partsUsed: raw.partsUsed,    // [{partNo, qty}]  <- consumption yahin
    oilQty:    raw.oilQty,
    date:      raw.date,
  };
}
