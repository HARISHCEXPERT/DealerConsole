// Wrapper — asli kaam src/jobs/pull.js me. Parts: service(-) + counter(-) ek saath, purchase(+) alag.
import { pullReports } from './pull.js';
export const pullPartsSales = (dateRange = null) => pullReports(['parts_service', 'parts_counter'], dateRange);
export const pullPartsPurchase = (dateRange = null) => pullReports(['parts_purchase'], dateRange);
