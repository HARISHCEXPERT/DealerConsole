// Roz ka full pull: scrape -> normalize -> reconcile -> ledger append.
import { pullDms } from '../scrapers/heroDms/index.js';
import { pullWarranty } from '../scrapers/warrantyPortal/index.js';
import { normalizeSale } from '../normalize/sale.js';
import { normalizeService } from '../normalize/service.js';
import { normalizeParts } from '../normalize/parts.js';
import { normalizeWarranty } from '../normalize/warranty.js';
import { normalizeFsc } from '../normalize/fsc.js';
import { reconcilePart } from '../ledger/reconcile.js';
import { appendEvents } from '../ledger/append.js';

export async function dailyPull(dealerId) {
  const dms = await pullDms();
  const war = await pullWarranty();

  const sale    = dms.sale.map(normalizeSale);
  const service = dms.service.map(normalizeService);
  const parts   = dms.parts.map(normalizeParts).map(reconcilePart);
  const warranty= war.warranty.map(normalizeWarranty);
  const fsc     = war.fsc.map(normalizeFsc);

  await appendEvents(dealerId, 'hero_dms', 'sale', sale);
  await appendEvents(dealerId, 'hero_dms', 'service', service);
  await appendEvents(dealerId, 'hero_dms', 'part_stock', parts);
  await appendEvents(dealerId, 'warranty_portal', 'warranty', warranty);
  await appendEvents(dealerId, 'warranty_portal', 'fsc', fsc);

  return { sale: sale.length, service: service.length, parts: parts.length,
           warranty: warranty.length, fsc: fsc.length,
           flagged: parts.filter(p => !p.reconciled).length };
}
