// Parts reconciliation — do din ke closing ka antar.
// calc_closing = opening + inQty - (serviceOut + counterOut)
// Agar calc != actual closing  => leakage/error flag. YE khud ek killer feature hai.
export function reconcilePart(p) {
  const calc = (p.opening ?? 0) + (p.inQty ?? 0) - ((p.serviceOut ?? 0) + (p.counterOut ?? 0));
  return { ...p, calcClosing: calc, reconciled: calc === p.closing, gap: (p.closing ?? 0) - calc };
}
