// auth.js — sign up / log in with a username + password. No extra dependencies:
// passwords are hashed with scrypt, sessions are random tokens (only their sha256 is stored) in an HttpOnly cookie.
import crypto from 'node:crypto';
import { db, now } from './db.js';

const COOKIE = 'ygo_session';
const SESSION_MS = 30 * 24 * 3600 * 1000;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
export function checkPassword(pw, stored) {
  const [s, h] = String(stored).split(':'); if (!s || !h) return false;
  const a = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function validateCredentials(username, password) {
  if (typeof username !== 'string' || !/^[A-Za-z0-9_-]{3,20}$/.test(username)) return 'Username must be 3–20 characters: letters, numbers, _ or -.';
  if (typeof password !== 'string' || password.length < 8) return 'Password must be at least 8 characters.';
  if (password.length > 200) return 'Password is too long.';
  return null;
}

// ---- cookies ----------------------------------------------------------------------------------
const parseCookies = h => Object.fromEntries(String(h || '').split(';').map(p => p.trim()).filter(Boolean).map(p => { const i = p.indexOf('='); return [p.slice(0, i), decodeURIComponent(p.slice(i + 1))]; }));
const secure = () => process.env.COOKIE_SECURE === '1' || process.env.NODE_ENV === 'production';

export function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)').run(sha(token), userId, now() + SESSION_MS);
  res.append('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure() ? '; Secure' : ''}`);
}
export function endSession(req, res) {
  const t = parseCookies(req.headers.cookie)[COOKIE];
  if (t) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(t));
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

const qUser = db.prepare(`SELECT u.id, u.username, u.avatar, u.frame, u.pvp_wins, u.pvp_losses, u.bot_wins, u.bot_losses
  FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`);

/** Fills req.user (or null) and res.locals.user for the templates. */
export function attachUser(req, res, next) {
  const t = parseCookies(req.headers.cookie)[COOKIE];
  req.user = t ? qUser.get(sha(t), now()) || null : null;
  res.locals.user = req.user;
  next();
}
export const requireUser = (req, res, next) => {
  if (req.user) return next();
  if (req.path.startsWith('/api') || req.originalUrl.startsWith('/api')) return res.status(401).json({ error: 'Please log in first.' });
  res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
};

/** Mutating API calls must carry a custom header: a cross-site form/POST cannot set it, which blocks CSRF. */
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-requested-with') === 'ygo') return next();
  res.status(403).json({ error: 'Missing request header.' });
}

// ---- brute-force throttle (per IP + username) -------------------------------------------------
const fails = new Map();
export const throttle = {
  key: (req, u) => (req.ip || '') + '|' + String(u).toLowerCase(),
  blocked(k) { const f = fails.get(k); return !!f && f.n >= 6 && now() < f.until; },
  fail(k) { const f = fails.get(k) || { n: 0, until: 0 }; f.n++; f.until = now() + 60_000; fails.set(k, f); },
  ok(k) { fails.delete(k); }
};
setInterval(() => { for (const [k, f] of fails) if (now() > f.until) fails.delete(k); }, 120_000).unref();
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now()), 3600_000).unref();
