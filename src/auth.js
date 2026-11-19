// Session auth — MULTI-USER.
//  - Admin: .env (DC_USER/DC_PASSWORD) — hamesha admin, saare tab (tabs:'*').
//  - Staff: secure DB (users table), admin banata hai, per-user tab access.
//  Token cookie me; token -> user info map (memory, restart pe logout).
import crypto from 'node:crypto';
import { verifyUser } from './config/creds.js';

const ADMIN_USER = process.env.DC_USER || 'admin';
const ADMIN_PASS = process.env.DC_PASSWORD || 'balaji@22839';   // .env me badlo!

// token -> { user, role, tabs }
const tokens = new Map();

function makeToken(userInfo) { const t = crypto.randomBytes(24).toString('hex'); tokens.set(t, userInfo); return t; }
function validToken(t) { return !!(t && tokens.has(t)); }
function tokenUser(t) { return t ? (tokens.get(t) || null) : null; }
function dropToken(t) { tokens.delete(t); }

function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const m = raw.split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.split('=').slice(1).join('=')) : null;
}

// login -> user object {user, role, tabs} ya null
export function checkLogin(user, pass) {
  user = String(user || '').trim();
  if (user === ADMIN_USER && pass === ADMIN_PASS) return { user: ADMIN_USER, role: 'admin', tabs: '*' };  // '*' = saare tab
  return verifyUser(user, pass);                     // staff (DB se)
}

export { makeToken, validToken, tokenUser, dropToken, getCookie };

// middleware: login zaroori (req.user set)
export function requireAuth(req, res, next) {
  const u = tokenUser(getCookie(req, 'dc_session'));
  if (u) { req.user = u; return next(); }
  res.status(401).json({ error: 'auth required' });
}
// middleware: sirf admin
export function requireAdmin(req, res, next) {
  const u = tokenUser(getCookie(req, 'dc_session'));
  if (u && u.role === 'admin') { req.user = u; return next(); }
  res.status(403).json({ error: 'admin only' });
}
