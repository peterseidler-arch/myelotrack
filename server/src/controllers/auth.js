import { randomUUID } from 'node:crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { asyncHandler, badRequest } from '../lib/async-handler.js';
import { config } from '../config/index.js';
import { issueSession, verifySession } from '../lib/session.js';
import {
  setSessionCookie,
  clearSessionCookie,
  readSessionToken,
} from '../middleware/auth.js';

const repo = (req) => req.app.locals.repo;

const b64 = (u8) => Buffer.from(u8).toString('base64url');
const fromB64 = (s) => new Uint8Array(Buffer.from(s, 'base64url'));

/** The signed-in user id, or null (also null if the account was deleted). */
async function sessionUser(req) {
  const userId = verifySession(readSessionToken(req), config.auth.sessionSecret);
  if (!userId) return null;
  return (await repo(req).getUser(userId)) ? userId : null;
}

/**
 * Pull the challenge out of a WebAuthn response's clientDataJSON so we can
 * find (and consume) the ceremony it belongs to. Returns null if malformed.
 */
function challengeFrom(body) {
  try {
    const json = Buffer.from(body?.response?.clientDataJSON || '', 'base64url');
    return JSON.parse(json.toString('utf8')).challenge || null;
  } catch {
    return null;
  }
}

/** GET /api/v1/auth/me — auth state for the client to decide what UI to show. */
export const me = asyncHandler(async (req, res) => {
  const userId = await sessionUser(req);
  // hasCredentials drives the gate's default button. Signed out, it reports
  // whether any account exists on this server (sign in vs. first-run sign up).
  const hasCredentials = userId
    ? (await repo(req).listCredentials(userId)).length > 0
    : (await repo(req).countCredentials()) > 0;
  res.json({
    data: {
      authenticated: Boolean(userId),
      required: config.auth.required,
      hasCredentials,
    },
  });
});

/** POST /api/v1/auth/logout */
export const logout = asyncHandler(async (req, res) => {
  clearSessionCookie(res);
  res.json({ data: { ok: true } });
});

/**
 * GET /api/v1/auth/registration/options — begin passkey registration.
 * Signed in: adds another passkey to the current account. Signed out: creates
 * a new patient account, which owns the passkey once verified.
 */
export const registrationOptions = asyncHandler(async (req, res) => {
  const currentUser = await sessionUser(req);
  // A random WebAuthn user handle for new accounts; never an email or PHI.
  const userId = currentUser || null;
  const userHandle = currentUser || `pending_${randomUUID()}`;
  const existing = currentUser ? await repo(req).listCredentials(currentUser) : [];
  const options = await generateRegistrationOptions({
    rpName: config.auth.rpName,
    rpID: config.auth.rpId,
    userID: new TextEncoder().encode(userHandle),
    userName: 'MyeloTrack account',
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
  await repo(req).saveChallenge(options.challenge, { purpose: 'registration', userId });
  res.json({ data: options });
});

/** POST /api/v1/auth/registration/verify — finish passkey registration. */
export const registrationVerify = asyncHandler(async (req, res) => {
  const challenge = challengeFrom(req.body);
  const ceremony = challenge
    ? await repo(req).consumeChallenge(challenge, 'registration')
    : null;
  if (!ceremony) throw badRequest('no registration in progress');

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge: challenge,
      expectedOrigin: config.auth.origin,
      expectedRPID: config.auth.rpId,
    });
  } catch (err) {
    throw badRequest(`registration failed: ${err.message}`);
  }
  if (!verification.verified || !verification.registrationInfo) {
    throw badRequest('registration could not be verified');
  }

  const userId = ceremony.userId || (await repo(req).createUser())._id;
  const { credential } = verification.registrationInfo;
  await repo(req).addCredential(userId, {
    id: credential.id,
    publicKey: b64(credential.publicKey),
    counter: credential.counter,
    transports: req.body.response?.transports || [],
  });

  setSessionCookie(res, issueSession(userId, config.auth.sessionSecret));
  res.status(201).json({ data: { verified: true } });
});

/**
 * GET /api/v1/auth/authentication/options — begin passkey sign-in. Uses
 * discoverable credentials (no allow-list), so the authenticator picks the
 * account and the server learns who it is from the credential id.
 */
export const authenticationOptions = asyncHandler(async (req, res) => {
  const options = await generateAuthenticationOptions({
    rpID: config.auth.rpId,
    userVerification: 'preferred',
  });
  await repo(req).saveChallenge(options.challenge, { purpose: 'authentication' });
  res.json({ data: options });
});

/** POST /api/v1/auth/authentication/verify — finish passkey sign-in. */
export const authenticationVerify = asyncHandler(async (req, res) => {
  const challenge = challengeFrom(req.body);
  const ceremony = challenge
    ? await repo(req).consumeChallenge(challenge, 'authentication')
    : null;
  if (!ceremony) throw badRequest('no sign-in in progress');

  const stored = await repo(req).getCredential(req.body?.id);
  if (!stored) throw badRequest('unknown credential');

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: req.body,
      expectedChallenge: challenge,
      expectedOrigin: config.auth.origin,
      expectedRPID: config.auth.rpId,
      credential: {
        id: stored.id,
        publicKey: fromB64(stored.publicKey),
        counter: stored.counter,
        transports: stored.transports,
      },
    });
  } catch (err) {
    throw badRequest(`sign-in failed: ${err.message}`);
  }
  if (!verification.verified) throw badRequest('sign-in could not be verified');

  await repo(req).updateCredentialCounter(
    stored.id,
    verification.authenticationInfo.newCounter,
  );

  setSessionCookie(res, issueSession(stored.userId, config.auth.sessionSecret));
  res.json({ data: { verified: true } });
});
