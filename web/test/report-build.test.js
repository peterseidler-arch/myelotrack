import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, reportDigest } from '../src/lib/report/build.js';
import { slotIso } from '../src/lib/dose-slots.js';

// Made-up patient data only.
const trial = {
  name: 'Example Study',
  cycleDays: 28,
  cycles: [{ number: 3, start: '2026-03-01' }],
};
const meds = [
  {
    _id: 'a',
    name: 'Alphanib',
    dose: '5 mg',
    active: true,
    schedule: { times: ['08:00', '20:00'], instructions: '3 tablets twice daily' },
    trial,
    createdAt: '2026-02-01T00:00:00Z',
    provenance: { system: 'medication-list' },
  },
  {
    _id: 'b',
    name: 'Betacycline',
    dose: '10 mg',
    active: true,
    schedule: { times: ['08:00'] },
    createdAt: '2026-03-02T10:00:00Z',
    provenance: { system: 'manual' },
  },
  {
    _id: 'c',
    name: 'Gonezol',
    dose: '1 mg',
    active: false,
    stoppedAt: '2026-03-02T15:00:00Z',
    schedule: { times: [] },
    createdAt: '2026-01-01T00:00:00Z',
  },
];
// Period: two local days, Mar 1–2 2026.
const periodStart = new Date(2026, 2, 1, 0, 0);
const periodEnd = new Date(2026, 2, 2, 23, 59);
const doses = [
  {
    medicationId: 'a',
    scheduledFor: slotIso('2026-03-01', '08:00'),
    status: 'taken',
    takenAt: slotIso('2026-03-01', '08:15'),
    amount: { tablets: 3, mg: 15 },
  },
  { medicationId: 'a', scheduledFor: slotIso('2026-03-01', '20:00'), status: 'skipped' },
  {
    medicationId: 'a',
    scheduledFor: slotIso('2026-03-02', '08:00'),
    status: 'taken',
    amount: { tablets: 2, mg: 10 },
  },
  // 2026-03-02 20:00 not logged.
];
const labs = [
  {
    analyte: 'hemoglobin',
    value: 9.1,
    unit: 'g/dL',
    refLow: 13,
    refHigh: 17,
    flag: 'low',
    collectedAt: new Date(2026, 2, 2, 9).toISOString(),
    source: 'msk',
  },
  { analyte: 'ldh', value: 200, unit: 'U/L', collectedAt: '2025-12-01T00:00:00Z' },
];
const symptoms = [
  {
    date: new Date(2026, 2, 1, 9).toISOString(),
    total: 30,
    weightKg: 70,
    items: { fatigue: 5 },
    note: 'tired',
  },
  {
    date: new Date(2026, 2, 2, 9).toISOString(),
    total: 40,
    weightKg: 69.5,
    items: { fatigue: 7 },
    note: '',
  },
];

const build = (extra = {}) =>
  buildReport({ periodStart, periodEnd, meds, doses, labs, symptoms, ...extra });

test('trial adherence counts taken, missed and unlogged per scheduled dose', () => {
  const r = build();
  assert.equal(r.trials.length, 1);
  const [t] = r.trials;
  assert.equal(t.name, 'Example Study');
  const [d] = t.drugs;
  assert.equal(d.scheduled, 4);
  assert.equal(d.taken, 2);
  assert.equal(d.missed, 1);
  assert.equal(d.unlogged, 1);
  assert.equal(d.mgTaken, 25);
  assert.equal(d.perDoseMg, 15);
  assert.deepEqual(d.missedList, [{ day: '2026-03-01', time: '20:00' }]);
  assert.equal(t.days[0].cycle, 3);
  assert.equal(t.days[1].cycleDay, 2);
  assert.equal(t.days[0].slots[0].entries[0].mg, 15);
});

test('symptoms, weight, labs in period, and medication changes', () => {
  const r = build();
  assert.equal(r.symptoms.entries, 2);
  assert.equal(r.symptoms.first, 30);
  assert.equal(r.symptoms.last, 40);
  assert.equal(r.symptoms.average, 35);
  assert.equal(r.symptoms.weightLastKg, 69.5);
  assert.deepEqual(r.symptoms.notes, [{ day: '2026-03-01', note: 'tired' }]);
  assert.equal(r.labs.length, 1); // the December LDH is outside the period
  assert.equal(r.labs[0].flag, 'low');
  assert.equal(r.labs[0].range, '13–17');
  assert.deepEqual(
    r.changes.map((c) => `${c.what} ${c.med}`),
    ['Started Betacycline', 'Stopped Gonezol'],
  );
  assert.equal(r.current.length, 2); // stopped one not listed
});

test('first report: no "Started" noise; digest is small', () => {
  const r = build({ firstReport: true });
  assert.deepEqual(
    r.changes.map((c) => c.what),
    ['Stopped'],
  );
  const digest = reportDigest(r);
  assert.equal(digest.trials[0].drugs[0].taken, 2);
  assert.ok(JSON.stringify(digest).length < 600);
});
