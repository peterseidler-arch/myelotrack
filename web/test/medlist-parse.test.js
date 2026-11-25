import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMedList, scheduleTimes, splitName } from '../src/lib/medlist/parse.js';

// Made-up list laid out like a saved Google Doc / printed table.
const at = (y, x, str) => ({ y, x, str, w: str.length * 4.5 });
const ITEMS = [
  at(70, 36, 'My Medications'),
  at(118, 40, 'Example Trial'),
  at(118, 205, 'Dr. Alpha'),
  at(144, 40, 'Medication'),
  at(144, 205, 'Dose'),
  at(144, 283, 'Schedule'),
  at(169, 40, 'Fakeinib (XYZ inhibitor)'),
  at(169.5, 205, '25 mg'),
  at(169.5, 283, '2 tablets twice daily x 21 days'),
  at(196, 40, 'Allergy Care'),
  at(222, 40, 'Madeupine (Brandex)'),
  at(222.5, 205, '10 mg'),
  at(222.5, 283, 'At bedtime'),
  at(222, 495, 'Dr. Beta'),
  at(248, 40, 'Rescuepen'),
  at(248.5, 205, '0.3 mg'),
  at(248.5, 283, 'As needed'),
  at(248, 495, 'Dr. Beta'),
  at(274, 40, 'Pretendol XR (Brandy XR)'),
  at(274.5, 205, 'TBD'),
  at(274.5, 283, 'Depends on labs'),
];

test('reads sections, columns, brands and a header-less doctor column', () => {
  const r = parseMedList(ITEMS);
  assert.equal(r.kind, 'medlist');
  assert.equal(r.title, 'My Medications');
  assert.equal(r.medications.length, 4);

  const [a, b, c, d] = r.medications;
  assert.deepEqual(
    {
      name: a.name,
      brand: a.brand,
      dose: a.dose,
      purpose: a.purpose,
      prescriber: a.prescriber,
    },
    {
      name: 'Fakeinib',
      brand: '',
      dose: '25 mg',
      purpose: 'Example Trial · XYZ inhibitor',
      prescriber: 'Dr. Alpha',
    },
  );
  assert.deepEqual(a.schedule.times, ['08:00', '20:00']);
  assert.deepEqual(a.trial, { name: 'Example Trial', cycleDays: 21 });
  assert.equal(b.trial, null);
  assert.equal(a.schedule.instructions, '2 tablets twice daily x 21 days');

  assert.equal(b.brand, 'Brandex');
  assert.equal(b.purpose, 'Allergy Care');
  assert.equal(b.prescriber, 'Dr. Beta');
  assert.deepEqual(b.schedule.times, ['22:00']);

  assert.equal(c.schedule.asNeeded, true);
  assert.deepEqual(c.schedule.times, []);

  assert.equal(d.name, 'Pretendol XR');
  assert.equal(d.brand, 'Brandy XR');
  assert.equal(d.dose, 'TBD');
  assert.deepEqual(d.schedule.times, []);
  assert.equal(d.prescriber, ''); // no row or section doctor
});

test('a PDF without a medication table is reported as unknown', () => {
  const r = parseMedList([at(10, 10, 'Hemoglobin'), at(30, 10, '12.1 g/dL')]);
  assert.equal(r.kind, 'unknown');
  assert.equal(r.medications.length, 0);
});

test('schedule wording → suggested times', () => {
  const cases = {
    'Once daily': ['08:00'],
    'Once daily (morning)': ['08:00'],
    '1 tablet in the evening': ['19:00'],
    'At bedtime': ['22:00'],
    '1 tablet twice daily': ['08:00', '20:00'],
    BID: ['08:00', '20:00'],
    '10 mL 3x daily': ['08:00', '14:00', '20:00'],
    'four times a day': ['08:00', '12:00', '16:00', '20:00'],
    'Every other Tuesday': [],
  };
  for (const [text, times] of Object.entries(cases)) {
    assert.deepEqual(scheduleTimes(text).times, times, text);
  }
  assert.equal(scheduleTimes('As needed, ~3x per week').asNeeded, true);
  assert.deepEqual(scheduleTimes('As needed, ~3x per week').times, []);
});

test('splitName tells brands from drug classes', () => {
  assert.deepEqual(splitName('Examplol (Brandname)'), {
    name: 'Examplol',
    brand: 'Brandname',
    drugClass: '',
  });
  assert.equal(splitName('Examplib (ABC/DEF inhibitor)').drugClass, 'ABC/DEF inhibitor');
  assert.equal(splitName('Plainname').name, 'Plainname');
});
