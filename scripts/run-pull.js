// Manual full pull for testing (scrapers TODO hone tak khaali chalega).
import { dailyPull } from '../src/jobs/dailyPull.js';
(async () => {
  const dealerId = process.env.DEFAULT_DEALER_ID || 'test-dealer';
  console.log(await dailyPull(dealerId));
})();
