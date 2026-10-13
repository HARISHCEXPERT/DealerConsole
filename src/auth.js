// Simple session auth. Password .env se (DC_PASSWORD), hashed compare. Token cookie me.
import crypto from 'node:crypto';

const USER = process.env.DC_USER || 'admin';
const PASS = process.env.DC_PASSWORD || 'balaji@22839';   // .env me badlo!
const SECRET = process.env.DC_SECRET || 'dealer-console-secret-change-me';

// active tokens (memory) — server restart pe logout. Simple.
const tokens = new Set();

function makeToken(){ const t=crypto.randomBytes(24).toString('hex'); tokens.add(t); return t; }
function validToken(t){ return t && tokens.has(t); }
function dropToken(t){ tokens.delete(t); }

// cookie parse
function getCookie(req, name){
  const raw = req.headers.cookie || '';
  const m = raw.split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='));
  return m ? decodeURIComponent(m.split('=').slice(1).join('=')) : null;
}

export function checkLogin(user, pass){
  return user===USER && pass===PASS;
}
export { makeToken, validToken, dropToken, getCookie };

// middleware: API ko protect karo (login/health chhod ke)
export function requireAuth(req, res, next){
  const t = getCookie(req, 'dc_session');
  if (validToken(t)) return next();
  res.status(401).json({ error: 'auth required' });
}