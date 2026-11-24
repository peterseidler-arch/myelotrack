// Password sign-in with auth required (own process: config is read at import).
process.env.AUTH_REQUIRED = 'true';
process.env.SESSION_SECRET = 'test-session-secret-please-change';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword,
  verifyPassword,
  normalizeEmail,
  passwordProblem,
} from '../src/lib/password.js';
import { createAttemptLimiter } from '../src/lib/rate-limit.js';

const PASSWORD = 'correct horse battery';

// --- unit ---
test('hashes verify, are salted, and reject wrong or malformed input', async () => {
  const h1 = await hashPassword(PASSWORD);
  const h2 = await hashPassword(PASSWORD);
  assert.match(h1, /^scrypt\$32768\$8\$1\$/);
  assert.notEqual(h1, h2);
  assert.equal(await verifyPassword(PASSWORD, h1), true);
  assert.equal(await verifyPassword('wrong password!!', h1), false);
  assert.equal(await verifyPassword(PASSWORD, 'garbage'), false);
  assert.equal(await verifyPassword(PASSWORD, null), false);
});

test('emails normalize; password rules', () => {
  assert.equal(normalizeEmail('  Peter@Example.COM '), 'peter@example.com');
  assert.equal(normalizeEmail('not-an-email'), null);
  assert.match(passwordProblem('short'), /at least 12/);
  assert.match(passwordProblem('x'.repeat(257)), /at most 256/);
  assert.equal(passwordProblem(PASSWORD), null);
});

test('limiter locks a key after the limit and unlocks after the window', () => {
  const l = createAttemptLimiter({ limit: 3, windowMs: 1000 });
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) l.fail(['k'], t0 + i);
  assert.ok(l.retryAfter(['k'], t0 + 10) > 0);
  assert.equal(l.retryAfter(['other'], t0 + 10), 0);
  assert.equal(l.retryAfter(['k'], t0 + 1001), 0);
});

// --- HTTP ---
let server;
let base;

before(async () => {
  const { createApp } = await import('../src/app.js');
  const { createMemoryRepository } = await import('../src/repositories/memory/store.js');
  const app = createApp(createMemoryRepository(), {
    loginLimiter: createAttemptLimiter({ limit: 3 }),
  });
  await new Promise((resolve) => (server = app.listen(0, resolve)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const post = (path, body, cookie) =>
  fetch(`${base}/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
const put = (path, body, cookie) =>
  fetch(`${base}/api/v1${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
const sessionCookie = (res) =>
  /mt_session=[^;]+/.exec(res.headers.get('set-cookie'))?.[0];
const me = async (cookie) =>
  (
    await (
      await fetch(`${base}/api/v1/auth/me`, { headers: cookie ? { cookie } : {} })
    ).json()
  ).data;

test('signup validates input', async () => {
  assert.equal(
    (await post('/auth/password/signup', { email: 'x', password: PASSWORD })).status,
    400,
  );
  assert.equal(
    (await post('/auth/password/signup', { email: 'a@b.co', password: 'short' })).status,
    400,
  );
});

test('signup creates an isolated account and signs in', async () => {
  assert.equal((await me()).hasCredentials, false);
  const res = await post('/auth/password/signup', {
    email: 'Pat@Example.com',
    password: PASSWORD,
  });
  assert.equal(res.status, 201);
  const cookie = sessionCookie(res);
  assert.ok(cookie);
  assert.match(res.headers.get('set-cookie'), /HttpOnly/i);

  const state = await me(cookie);
  assert.equal(state.authenticated, true);
  assert.equal(state.email, 'pat@example.com');
  assert.equal(state.signupOpen, true);
  assert.equal((await me()).hasCredentials, true);

  // A brand-new account: none of the seeded sample patient's data.
  const labs = await (await fetch(`${base}/api/v1/labs`, { headers: { cookie } })).json();
  assert.deepEqual(labs.data, []);
});

test('the same email cannot sign up twice, in any letter case', async () => {
  const res = await post('/auth/password/signup', {
    email: 'PAT@example.com',
    password: PASSWORD,
  });
  assert.equal(res.status, 409);
});

test('login works with the right password and fails generically otherwise', async () => {
  const ok = await post('/auth/password/login', {
    email: 'pat@example.com',
    password: PASSWORD,
  });
  assert.equal(ok.status, 200);
  assert.ok(sessionCookie(ok));

  const wrong = await post('/auth/password/login', {
    email: 'pat@example.com',
    password: 'not the password',
  });
  const unknown = await post('/auth/password/login', {
    email: 'nobody@example.com',
    password: 'not the password',
  });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  // Same message whether or not the email exists.
  assert.equal((await wrong.json()).message, (await unknown.json()).message);
});

test('repeated failures are rate limited with Retry-After', async () => {
  const body = { email: 'victim@example.com', password: 'guessing wrong' };
  for (let i = 0; i < 3; i++) await post('/auth/password/login', body);
  const res = await post('/auth/password/login', body);
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
});

test('a signed-in user can change the password only with the current one', async () => {
  // Fresh account so the IP lockout from the previous test doesn't apply to login.
  const res = await post('/auth/password/signup', {
    email: 'sam@example.com',
    password: PASSWORD,
  });
  const cookie = sessionCookie(res);

  const noCurrent = await put(
    '/auth/password',
    { newPassword: 'a brand new passphrase' },
    cookie,
  );
  assert.equal(noCurrent.status, 401);

  const changed = await put(
    '/auth/password',
    { currentPassword: PASSWORD, newPassword: 'a brand new passphrase' },
    cookie,
  );
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).data.email, 'sam@example.com');

  // Taking another account's email is refused.
  const clash = await put(
    '/auth/password',
    {
      email: 'pat@example.com',
      currentPassword: 'a brand new passphrase',
      newPassword: PASSWORD,
    },
    cookie,
  );
  assert.equal(clash.status, 409);
});

test('changing a password needs a session', async () => {
  const res = await put('/auth/password', { newPassword: PASSWORD });
  assert.equal(res.status, 401);
});

test('signup while signed in is refused', async () => {
  const res = await post('/auth/password/signup', {
    email: 'new@example.com',
    password: PASSWORD,
  });
  const cookie = sessionCookie(res);
  const again = await post(
    '/auth/password/signup',
    { email: 'other@example.com', password: PASSWORD },
    cookie,
  );
  assert.equal(again.status, 409);
});
