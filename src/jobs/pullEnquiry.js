// Wrapper — asli kaam src/jobs/pull.js me.
import { pullReports } from './pull.js';
export const pullEnquiryToFile = (dateRange = null) => pullReports(['enquiry'], dateRange);
