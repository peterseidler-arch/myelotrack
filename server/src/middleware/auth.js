import { config } from '../config/index.js';
import { verifySession } from '../lib/session.js';

const COOKIE_NAME = 'mt_session';

/** Parse the Cookie header into a plain object (no cookie-parser dependency). */
export function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map((part) => {
      const idx = part.indexOf('=');
      const k = part.slice(0, idx).trim();
      const v = decodeURIComponent(part.slice(idx + 1).trim());
      return [k, v];
    }),
  );
}

/** Read a session token from the cookie or an Authorization: Bearer header. */
export function readSessionToken(req) {
  const cookies = parseCookies(req);
  if (cookies[COOKIE_NAME]) return cookies[COOKIE_NAME];
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

/** Set / clear the session cookie (httpOnly, SameSite=Lax). */
export function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 14 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}
export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

/** Subject used for every request when AUTH_REQUIRED=false (local dev only). */
export const DEV_USER_ID = 'user_1';

/**
 * Gate PHI routes and bind the request to one patient. When enabled, a valid
 * session is required or the request is rejected 401. When auth is disabled
 * (local dev on sample data), every request acts as the seeded dev user.
 *
 * Either way, `req.repo` is the repository scoped to `req.authUserId`, so a
 * controller can only ever reach the signed-in patient's data.
 */
export function requireAuth(req, res, next) {
  let subject = DEV_USER_ID;
  if (config.auth.required) {
    subject = verifySession(readSessionToken(req), config.auth.sessionSecret);
    if (!subject) {
      res.status(401).json({ error: 'unauthorized', message: 'Sign in required' });
      return;
    }
  }
  req.authUserId = subject;
  req.repo = req.app.locals.repo.forUser(subject);
  next();
}
