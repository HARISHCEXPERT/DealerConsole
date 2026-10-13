// Tenant resolver + basic auth (abhi Mehrotra = single dealer, par ready).
export function tenant(req, res, next) {
  req.dealerId = req.header('x-dealer-id') || process.env.DEFAULT_DEALER_ID || null;
  next();
}
export function auth(req, res, next) {
  // TODO: real auth (token). Abhi passthrough.
  next();
}
