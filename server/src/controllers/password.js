import { asyncHandler, badRequest, httpError } from '../lib/async-handler.js';
import { config } from '../config/index.js';
import { issueSession, verifySession } from '../lib/session.js';
import {
  hashPassword,
  verifyPassword,
  dummyVerify,
  normalizeEmail,
  passwordProblem,
} from '../lib/password.js';
import { setSessionCookie, readSessionToken } from '../middleware/auth.js';

/**
 * Email + password sign-in, alongside passkeys. Passwords are hashed with
 * scrypt; failed sign-ins are rate-limited per IP and per email; error
 * messages never reveal whether an email has an account.
 */

const repo = (req) => req.app.locals.repo;
const limiter = (req) => req.app.locals.loginLimiter;

const SIGNIN_FAILED = 'Email or password is incorrect';

function readCredentials(body) {
  const email = normalizeEmail(body?.email);
  if (!email) throw badRequest('enter a valid email address');
  return { email, password: body?.password };
}

/**
 * POST /api/v1/auth/password/signup — create a new account with an email and
 * password, and sign in. Signed-out only; closed when ALLOW_SIGNUP=false.
 */
export const signup = asyncHandler(async (req, res) => {
  if (verifySession(readSessionToken(req), config.auth.sessionSecret)) {
    throw httpError(409, 'signed_in', 'already signed in; set a password in Settings');
  }
  if (!config.auth.allowSignup) {
    throw httpError(403, 'signup_closed', 'new accounts are not being accepted');
  }
  const { email, password } = readCredentials(req.body);
  const problem = passwordProblem(password);
  if (problem) throw badRequest(problem);

  if (await repo(req).getPasswordLogin(email)) {
    throw httpError(409, 'email_taken', 'an account with that email already exists');
  }
  const passwordHash = await hashPassword(password);
  const user = await repo(req).createUser();
  try {
    await repo(req).setPasswordLogin(user._id, { email, passwordHash });
  } catch (err) {
    // Lost a race for the same email: drop the empty account we just made.
    await repo(req).deleteUser(user._id);
    if (err.code === 'EMAIL_TAKEN') throw httpError(409, 'email_taken', err.message);
    throw err;
  }

  setSessionCookie(res, issueSession(user._id, config.auth.sessionSecret));
  res.status(201).json({ data: { verified: true } });
});

/** POST /api/v1/auth/password/login — sign in with email and password. */
export const login = asyncHandler(async (req, res) => {
  const { email, password } = readCredentials(req.body);
  if (typeof password !== 'string' || !password) throw badRequest('password is required');

  const keys = [`ip:${req.ip}`, `email:${email}`];
  const wait = limiter(req).retryAfter(keys);
  if (wait) {
    res.setHeader('Retry-After', String(wait));
    throw httpError(429, 'too_many_attempts', 'Too many attempts. Try again later.');
  }

  const login = await repo(req).getPasswordLogin(email);
  const ok = login
    ? await verifyPassword(password, login.passwordHash)
    : await dummyVerify(password);
  if (!ok) {
    limiter(req).fail(keys);
    throw httpError(401, 'invalid_credentials', SIGNIN_FAILED);
  }

  limiter(req).clear(`email:${email}`);
  setSessionCookie(res, issueSession(login.userId, config.auth.sessionSecret));
  res.json({ data: { verified: true } });
});

/**
 * PUT /api/v1/auth/password — add a password to the signed-in account, or
 * change its email or password. Changing an existing password requires the
 * current one. Mounted behind requireAuth.
 */
export const setPassword = asyncHandler(async (req, res) => {
  const userId = req.authUserId;
  const existing = await repo(req).getPasswordLoginForUser(userId);

  const email = normalizeEmail(req.body?.email ?? existing?.email);
  if (!email) throw badRequest('enter a valid email address');
  const { newPassword, currentPassword } = req.body || {};
  const problem = passwordProblem(newPassword);
  if (problem) throw badRequest(problem);

  if (existing) {
    const keys = [`user:${userId}`];
    const wait = limiter(req).retryAfter(keys);
    if (wait) {
      res.setHeader('Retry-After', String(wait));
      throw httpError(429, 'too_many_attempts', 'Too many attempts. Try again later.');
    }
    const ok =
      typeof currentPassword === 'string' &&
      (await verifyPassword(currentPassword, existing.passwordHash));
    if (!ok) {
      limiter(req).fail(keys);
      throw httpError(401, 'invalid_credentials', 'Current password is incorrect');
    }
  }

  try {
    await repo(req).setPasswordLogin(userId, {
      email,
      passwordHash: await hashPassword(newPassword),
    });
  } catch (err) {
    if (err.code === 'EMAIL_TAKEN') throw httpError(409, 'email_taken', err.message);
    throw err;
  }
  res.json({ data: { email } });
});
