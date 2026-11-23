// Multi-patient isolation over HTTP: two signed-in patients never see each
// other's data. Auth must be on before config is read (own process).
process.env.AUTH_REQUIRED = 'true';
process.env.SESSION_SECRET = 'test-session-secret-multi-patient';
process.env.RP_ID = 'localhost';
process.env.RP_ORIGIN = 'http://localhost:5173';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { issueSession } from '../src/lib/session.js';

const SECRET = process.env.SESSION_SECRET;
let server;
let base;
let repo;
let alice;
let bob;

before(async () => {
  const { createApp } = await import('../src/app.js');
  const { createMemoryRepository } = await import('../src/repositories/memory/store.js');
  repo = createMemoryRepository({ seed: false });
  alice = repo.createUser()._id;
  bob = repo.createUser()._id;
  const app = createApp(repo);
  await new Promise((resolve) => (server = app.listen(0, resolve)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const as = (userId) => ({ cookie: `mt_session=${issueSession(userId, SECRET)}` });
const get = (path, userId) => fetch(`${base}${path}`, { headers: as(userId) });
const post = (path, body, userId) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...as(userId) },
    body: JSON.stringify(body),
  });

test("one patient's check-in is invisible to another", async () => {
  const res = await post('/api/v1/symptoms', { items: { fatigue: 7 }, note: 'A' }, alice);
  assert.equal(res.status, 201);

  const mine = (await (await get('/api/v1/symptoms', alice)).json()).data;
  const theirs = (await (await get('/api/v1/symptoms', bob)).json()).data;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].note, 'A');
  assert.equal(theirs.length, 0);
});

test("a patient can't read another patient's pallor reading by id", async () => {
  const created = await post('/api/v1/pallor', { pallorScore: 0.3 }, alice);
  const { data } = await created.json();
  const res = await get(`/api/v1/pallor/${data._id}/image`, bob);
  assert.equal(res.status, 400); // not found in bob's scope
  const bobs = (await (await get('/api/v1/pallor', bob)).json()).data;
  assert.equal(bobs.length, 0);
});

test("erasing one account leaves the other patient's data intact", async () => {
  await post('/api/v1/symptoms', { items: { fatigue: 2 }, note: 'B' }, bob);
  const del = await fetch(`${base}/api/v1/account`, {
    method: 'DELETE',
    headers: as(alice),
  });
  assert.equal(del.status, 200);

  assert.equal((await (await get('/api/v1/symptoms', alice)).json()).data.length, 0);
  const bobs = (await (await get('/api/v1/symptoms', bob)).json()).data;
  assert.equal(bobs.length, 1);
  assert.equal(bobs[0].note, 'B');
});

test('audit entries carry the acting patient', async () => {
  await get('/api/v1/labs', bob);
  const entries = repo.getAuditLog({ userId: bob });
  assert.ok(entries.length > 0);
  assert.ok(entries.every((e) => e.userId === bob));
});

test('WebAuthn challenges are single-use and purpose-bound', () => {
  repo.saveChallenge('c1', { purpose: 'authentication' });
  assert.equal(repo.consumeChallenge('c1', 'registration'), null);
  repo.saveChallenge('c2', { purpose: 'registration', userId: alice });
  assert.deepEqual(repo.consumeChallenge('c2', 'registration'), {
    purpose: 'registration',
    userId: alice,
  });
  assert.equal(repo.consumeChallenge('c2', 'registration'), null);
});

test('sign-in options use discoverable credentials (no allow-list)', async () => {
  const { data } = await (
    await fetch(`${base}/api/v1/auth/authentication/options`)
  ).json();
  assert.ok(data.challenge);
  assert.ok(!data.allowCredentials || data.allowCredentials.length === 0);
});
