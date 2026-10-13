// Wrapper — asli kaam src/jobs/pull.js me.
import { pullReports } from './pull.js';
export const pullPurchaseToFile = (dateRange = null) => pullReports(['purchase'], dateRange);
