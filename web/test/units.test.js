import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weightOut, weightIn, tempOut, tempIn } from '../src/lib/units.js';

test('weight and temperature convert both ways', () => {
  assert.equal(Math.round(weightOut(70, 'lb') * 10) / 10, 154.3);
  assert.equal(weightOut(70, 'kg'), 70);
  assert.ok(Math.abs(weightIn(weightOut(81.3, 'lb'), 'lb') - 81.3) < 1e-9);
  assert.equal(tempOut(37, 'F'), 98.6);
  assert.equal(tempOut(37, 'C'), 37);
  assert.ok(Math.abs(tempIn(98.6, 'F') - 37) < 1e-9);
});
