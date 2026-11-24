import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createMemoryRepository } from '../src/repositories/memory/store.js';

// Made-up regimen; no real patient data.
let server;
let base;

before(async () => {
  const app = createApp(createMemoryRepository({ seed: false }));
  await new Promise((resolve) => (server = app.listen(0, resolve)));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const call = (method, path, body) =>
  fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  });
const list = async () => (await (await call('GET', '/medications')).json()).data;

test('add a medication by hand', async () => {
  const res = await call('POST', '/medications', {
    name: '  Examplamab ',
    dose: '10 mg',
    purpose: 'Testing',
    prescriber: { name: 'Dr. Example' },
    schedule: { times: ['20:00', '08:00'], instructions: '1 tablet twice daily' },
  });
  assert.equal(res.status, 201);
  const { data } = await res.json();
  assert.equal(data.name, 'Examplamab');
  assert.deepEqual(data.schedule.times, ['08:00', '20:00']);
  assert.equal(data.prescriber.name, 'Dr. Example');
  assert.equal(data.provenance.system, 'manual');
  assert.equal((await list()).length, 1);
});

test('validation: name required, times must be HH:MM', async () => {
  assert.equal((await call('POST', '/medications', { dose: '1 mg' })).status, 400);
  const bad = await call('POST', '/medications', {
    name: 'X',
    schedule: { times: ['8am'] },
  });
  assert.equal(bad.status, 400);
});

test('edit, then stop, a medication', async () => {
  const [med] = await list();
  const edited = await call('PATCH', `/medications/${med._id}`, { dose: '20 mg' });
  assert.equal(edited.status, 200);
  const { data } = await edited.json();
  assert.equal(data.dose, '20 mg');
  assert.equal(data.name, 'Examplamab'); // untouched fields stay

  const stopped = await call('PATCH', `/medications/${med._id}`, { active: false });
  assert.equal(stopped.status, 200);
  assert.equal((await list()).length, 0);
  assert.equal((await call('PATCH', '/medications/nope', { dose: '1' })).status, 400);
});

test('import a list; re-import updates instead of duplicating', async () => {
  const meds = [
    {
      name: 'Alphazine',
      dose: '5 mg',
      schedule: { times: ['08:00'] },
      purpose: 'Group A',
    },
    {
      name: 'Betamol XR',
      brand: 'Betabrand',
      dose: '50 mg',
      schedule: { asNeeded: true },
    },
    { name: 'alphazine', dose: 'dup' }, // same name: ignored
  ];
  let res = await call('POST', '/medications/import', { medications: meds });
  assert.equal(res.status, 201);
  assert.deepEqual((await res.json()).data, { added: 2, updated: 0, stopped: 0 });
  assert.equal((await list()).length, 2);

  res = await call('POST', '/medications/import', {
    medications: [{ name: 'Alphazine', dose: '10 mg', schedule: { times: ['08:00'] } }],
    replace: true,
  });
  assert.deepEqual((await res.json()).data, { added: 0, updated: 1, stopped: 1 });
  const after = await list();
  assert.equal(after.length, 1);
  assert.equal(after[0].dose, '10 mg');
});

test('import leaves hand-added medications alone', async () => {
  await call('POST', '/medications', {
    name: 'Handadded',
    schedule: { times: ['09:00'] },
  });
  await call('POST', '/medications/import', {
    medications: [{ name: 'Gammacin', schedule: {} }],
    replace: true,
  });
  const names = (await list()).map((m) => m.name).sort();
  assert.deepEqual(names, ['Gammacin', 'Handadded']);
});

test('clinical-trial marker: set on create, validated, cleared on edit', async () => {
  const res = await call('POST', '/medications', {
    name: 'Trialumab',
    trial: { name: 'Example Study', cycleDays: 28 },
  });
  const { data } = await res.json();
  assert.deepEqual(data.trial, { name: 'Example Study', cycleDays: 28 });
  const bad = await call('PATCH', `/medications/${data._id}`, {
    trial: { cycleDays: 0 },
  });
  assert.equal(bad.status, 400);
  const cleared = await call('PATCH', `/medications/${data._id}`, { trial: null });
  assert.equal((await cleared.json()).data.trial, null);
});

test('import rejects an empty list', async () => {
  assert.equal(
    (await call('POST', '/medications/import', { medications: [] })).status,
    400,
  );
});

test('dose diary over HTTP: put, list window, clear, validation', async () => {
  const med = await (
    await call('POST', '/medications', {
      name: 'Diarymab',
      schedule: { times: ['08:00'] },
    })
  ).json();
  const id = med.data._id;
  const slot = '2026-04-01T12:00:00.000Z';
  let res = await call('PUT', `/medications/${id}/doses`, {
    scheduledFor: slot,
    status: 'taken',
    takenAt: '2026-04-01T12:10:00.000Z',
    amount: { tablets: 2, mg: 100 },
  });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).data.amount, { tablets: 2, mg: 100 });
  res = await call(
    'GET',
    '/medications/doses?from=2026-04-01T00:00:00Z&to=2026-04-02T00:00:00Z',
  );
  const doses = (await res.json()).data.filter((d) => d.medicationId === id);
  assert.equal(doses.length, 1);
  assert.equal(
    (await call('PUT', `/medications/${id}/doses`, { scheduledFor: 'nope' })).status,
    400,
  );
  assert.equal(
    (
      await call('PUT', `/medications/${id}/doses`, {
        scheduledFor: slot,
        amount: { tablets: -1 },
      })
    ).status,
    400,
  );
  res = await call(
    'DELETE',
    `/medications/${id}/doses?scheduledFor=${encodeURIComponent(slot)}`,
  );
  assert.deepEqual((await res.json()).data, { removed: true });
});

test('trial cycles are validated and kept in date order', async () => {
  const res = await call('POST', '/medications', {
    name: 'Cyclomab',
    trial: {
      name: 'Study',
      cycleDays: 28,
      cycles: [
        { number: 2, start: '2026-02-01' },
        { number: 1, start: '2026-01-04' },
      ],
    },
  });
  const { data } = await res.json();
  assert.deepEqual(
    data.trial.cycles.map((c) => c.number),
    [1, 2],
  );
  const bad = await call('POST', '/medications', {
    name: 'X',
    trial: { cycles: [{ number: 1, start: 'Jan 4' }] },
  });
  assert.equal(bad.status, 400);
});

test('reports: record a sent report; list newest first; validation', async () => {
  let res = await call('POST', '/reports', {
    periodStart: '2026-01-01T00:00:00Z',
    periodEnd: '2026-01-20T00:00:00Z',
    recipients: [{ name: 'Coordinator', email: 'coord@example.org' }],
    summary: { taken: 40, missed: 2 },
  });
  assert.equal(res.status, 201);
  res = await call('GET', '/reports');
  const { data } = await res.json();
  assert.equal(data[0].recipients[0].email, 'coord@example.org');
  assert.equal(
    (
      await call('POST', '/reports', {
        periodStart: '2026-02-01',
        periodEnd: '2026-01-01',
      })
    ).status,
    400,
  );
});
