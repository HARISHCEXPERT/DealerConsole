// Purana naam, naya kaam: ab src/jobs/pull.js (ek runner, seedha DB me). Ye sirf wrapper hai.
import { pullReports } from './pull.js';
export const pullVSRToFile = (dateRange = null) => pullReports(['vsr'], dateRange);
