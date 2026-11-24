import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { createMemoryRepository } from '../src/repositories/memory/store.js';

let server;
let base;

before(async () => {
  const app = createApp(createMemoryRepository());
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

const importLabs = (body) =>
  fetch(`${base}/api/v1/labs/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const labsFor = async (analyte) =>
  (await (await fetch(`${base}/api/v1/labs?analyte=${analyte}`)).json()).data;

// Invented values — never real results in tests.
const ldh = (day, value, extra = {}) => ({
  analyte: 'ldh',
  value,
  refLow: 130,
  refHigh: 250,
  collectedAt: `${day}T17:00:00.000Z`,
  day,
  dateOnly: true,
  ...extra,
});

test('imports new analytes with server-derived unit, LOINC, and flag', async () => {
  const res = await importLabs({
    source: 'msk',
    results: [
      ldh('2026-01-05', 300),
      {
        analyte: 'egfr',
        value: 52,
        refLow: 60,
        refHigh: null,
        collectedAt: '2026-01-05T19:47:00.000Z',
        day: '2026-01-05',
        dateOnly: false,
      },
      {
        analyte: 'ast',
        value: 30,
        refLow: null,
        refHigh: 37,
        collectedAt: '2026-01-05T19:47:00.000Z',
        day: '2026-01-05',
        dateOnly: false,
      },
    ],
  });
  assert.equal(res.status, 201);
  assert.deepEqual((await res.json()).data, { added: 3, updated: 0, unchanged: 0 });

  const [l] = await labsFor('ldh');
  assert.equal(l.value, 300);
  assert.equal(l.unit, 'U/L');
  assert.equal(l.loinc, '2532-0');
  assert.equal(l.flag, 'high');
  assert.equal(l.source, 'msk');
  assert.equal(l.provenance.system, 'mychart-pdf');
  assert.equal(l.provenance.externalId, 'mychart:msk:ldh:2026-01-05');

  const [e] = await labsFor('egfr');
  assert.equal(e.flag, 'low'); // one-sided "60 or above"
  const [a] = await labsFor('ast');
  assert.equal(a.flag, 'normal'); // one-sided "37 or below"
});

test('re-importing is idempotent; a timed draw beats a date-only row', async () => {
  // Same printout again → nothing changes.
  let res = await importLabs({ source: 'msk', results: [ldh('2026-01-05', 300)] });
  assert.deepEqual((await res.json()).data, { added: 0, updated: 0, unchanged: 1 });

  // The exact-time Details printout for that draw replaces the date-only row…
  res = await importLabs({
    source: 'msk',
    results: [
      ldh('2026-01-05', 300, {
        collectedAt: '2026-01-05T19:47:00.000Z',
        dateOnly: false,
      }),
    ],
  });
  assert.deepEqual((await res.json()).data, { added: 0, updated: 1, unchanged: 0 });

  // …and a later Trends printout can't overwrite it back to date-only.
  res = await importLabs({ source: 'msk', results: [ldh('2026-01-05', 300)] });
  assert.deepEqual((await res.json()).data, { added: 0, updated: 0, unchanged: 1 });

  const rows = (await labsFor('ldh')).filter(
    (l) => l.provenance?.system === 'mychart-pdf',
  );
  assert.equal(rows.length, 1);
  assert.equal(new Date(rows[0].collectedAt).toISOString(), '2026-01-05T19:47:00.000Z');
});

test('the same test on the same day at another care team is a separate draw', async () => {
  const res = await importLabs({
    source: 'capital-health',
    results: [ldh('2026-01-05', 280)],
  });
  assert.deepEqual((await res.json()).data, { added: 1, updated: 0, unchanged: 0 });
  const rows = (await labsFor('ldh')).filter(
    (l) => l.provenance?.system === 'mychart-pdf',
  );
  assert.equal(rows.length, 2);
});

test('rejects bad input', async () => {
  const cases = [
    [{ source: 'elsewhere', results: [ldh('2026-01-05', 1)] }, /source/],
    [{ source: 'msk', results: [] }, /non-empty/],
    [
      { source: 'msk', results: [{ ...ldh('2026-01-05', 1), analyte: 'sodium' }] },
      /not supported/,
    ],
    [{ source: 'msk', results: [{ ...ldh('2026-01-05', 1), value: '1' }] }, /value/],
    [{ source: 'msk', results: [{ ...ldh('2026-01-05', 1), day: '01/05/2026' }] }, /day/],
    [
      { source: 'msk', results: [{ ...ldh('2026-01-05', 1), day: '2026-03-01' }] },
      /does not match/,
    ],
    [{ source: 'msk', results: [ldh('2999-01-05', 1)] }, /future/],
    [{ source: 'msk', results: [{ ...ldh('2026-01-05', 1), refHigh: 'x' }] }, /refHigh/],
  ];
  for (const [body, message] of cases) {
    const res = await importLabs(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(JSON.stringify(await res.json()), message);
  }
});
