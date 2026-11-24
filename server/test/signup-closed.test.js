// ALLOW_SIGNUP=false: no new accounts from a signed-out visitor (own process).
process.env.AUTH_REQUIRED = 'true';
process.env.SESSION_SECRET = 'test-session-secret-please-change';
process.env.ALLOW_SIGNUP = 'false';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

let server;
let base;
let repo;

before(async () => {
  const { createApp } = await import('../src/app.js');
  const { createMemoryRepository } = await import('../src/repositories/memory/store.js');
  const { hashPassword } = await import('../src/lib/password.js');
  repo = createMemoryRepository({ seed: false });
  const user = repo.createUser();
  repo.setPasswordLogin(user._id, {
    email: 'owner@example.com',
    passwordHash: await hashPassword('owner passphrase 1'),
  });
  const app = createApp(repo);
  await new Promise((resolve) => (server = app.listen(0, resolve)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const post = (path, body) =>
  fetch(`${base}/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('/auth/me reports sign-up closed', async () => {
  const { data } = await (await fetch(`${base}/api/v1/auth/me`)).json();
  assert.equal(data.signupOpen, false);
  assert.equal(data.hasCredentials, true);
});

test('password sign-up is refused', async () => {
  const res = await post('/auth/password/signup', {
    email: 'stranger@example.com',
    password: 'a long enough password',
  });
  assert.equal(res.status, 403);
  assert.equal(repo.countUsers(), 1);
});

test('passkey sign-up is refused', async () => {
  const res = await fetch(`${base}/api/v1/auth/registration/options`);
  assert.equal(res.status, 403);
});

test('existing accounts can still sign in', async () => {
  const res = await post('/auth/password/login', {
    email: 'owner@example.com',
    password: 'owner passphrase 1',
  });
  assert.equal(res.status, 200);
});
