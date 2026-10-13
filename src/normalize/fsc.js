export function normalizeFsc(raw) {
  return { couponNo: raw.couponNo, chassis: raw.chassis, model: raw.model,
    type: raw.type, soldOn: raw.soldOn, dueBy: raw.dueBy, status: raw.status };
}
