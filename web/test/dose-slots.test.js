import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  daysBetween,
  strengthMg,
  tabletsPerDose,
  cycleDayFor,
  slotIso,
  localDay,
} from '../src/lib/dose-slots.js';

test('day arithmetic across month ends', () => {
  assert.equal(addDays('2026-01-30', 3), '2026-02-02');
  assert.equal(daysBetween('2026-02-27', '2026-03-02'), 3);
  assert.equal(localDay(new Date(slotIso('2026-05-04', '20:00'))), '2026-05-04');
});

test('strength and tablets from label text', () => {
  assert.equal(strengthMg('5 mg'), 5);
  assert.equal(strengthMg('0.4 mg'), 0.4);
  assert.equal(strengthMg('100 mg/5 mL'), null);
  assert.equal(tabletsPerDose('3 tablets twice daily x 28 days'), 3);
  assert.equal(tabletsPerDose('Once daily'), 1);
});

test('cycle and day for a date', () => {
  const cycles = [
    { number: 16, start: '2026-10-13' },
    { number: 17, start: '2026-11-10' },
  ];
  assert.deepEqual(cycleDayFor(cycles, 28, '2026-11-24'), {
    cycle: 17,
    day: 15,
    start: '2026-11-10',
  });
  assert.equal(cycleDayFor(cycles, 28, '2026-11-09').cycle, 16);
  assert.equal(cycleDayFor(cycles, 28, '2026-10-01'), null);
  assert.equal(cycleDayFor(cycles, 28, '2026-12-08'), null); // past day 28
});
