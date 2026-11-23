import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANALYTES as SERVER, computeFlag } from '../src/data/analytes.js';
import { ANALYTES as WEB } from '../../web/src/data/analytes.js';
import {
  LOINC_TO_ANALYTE,
  normalizeObservation,
} from '../src/integrations/fhir/index.js';

test('server and web analyte catalogs stay in sync', () => {
  assert.deepEqual(Object.keys(SERVER).sort(), Object.keys(WEB).sort());
  for (const [key, meta] of Object.entries(SERVER)) {
    const { unit, refLow, refHigh, loinc } = WEB[key];
    assert.deepEqual(meta, { unit, refLow, refHigh, loinc }, key);
  }
});

test('every catalog LOINC maps back to its analyte for FHIR sync', () => {
  for (const [key, meta] of Object.entries(SERVER)) {
    assert.equal(LOINC_TO_ANALYTE[meta.loinc], key);
  }
});

test('computeFlag: one-sided ranges and a result’s own range win', () => {
  assert.equal(computeFlag('ast', 91), 'high');
  assert.equal(computeFlag('ast', 10), 'normal'); // no lower bound
  assert.equal(computeFlag('egfr', 47), 'low');
  assert.equal(computeFlag('egfr', 120), 'normal'); // no upper bound
  assert.equal(computeFlag('hemoglobin', 13, { refLow: 12.5, refHigh: 16.2 }), 'normal');
  assert.equal(computeFlag('hemoglobin', 13), 'low'); // catalog default 13.5
  assert.equal(computeFlag('hematocrit', 40), 'normal'); // unknown analyte, no crash
});

test('FHIR: a mapped chemistry Observation flags against its own range', () => {
  const lab = normalizeObservation(
    {
      id: 'obs1',
      code: { coding: [{ system: 'http://loinc.org', code: '2160-0' }] },
      valueQuantity: { value: 1.2, unit: 'mg/dL' },
      referenceRange: [{ low: { value: 0.7 }, high: { value: 1.1 } }],
      effectiveDateTime: '2026-01-05T14:00:00Z',
    },
    'msk',
  );
  assert.equal(lab.analyte, 'creatinine');
  assert.equal(lab.flag, 'high');
});
