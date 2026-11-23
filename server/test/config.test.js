import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeToServe } from '../src/config/index.js';

const prodConfig = (overrides = {}) => ({
  isProduction: true,
  dataBackend: 'postgres',
  databaseUrl: 'postgres://x',
  fieldEncryptionKey: 'k',
  auth: { required: true },
  ...overrides,
});

test('production refuses to start without sign-in or on the sample store', () => {
  const prev = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 's';
  try {
    assert.doesNotThrow(() => assertSafeToServe(prodConfig()));
    assert.throws(
      () => assertSafeToServe(prodConfig({ auth: { required: false } })),
      /AUTH_REQUIRED must be true/,
    );
    assert.throws(
      () => assertSafeToServe(prodConfig({ dataBackend: 'memory' })),
      /DATA_BACKEND must be postgres/,
    );
    assert.throws(
      () => assertSafeToServe(prodConfig({ fieldEncryptionKey: '' })),
      /FIELD_ENCRYPTION_KEY/,
    );
  } finally {
    if (prev === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = prev;
  }
});

test('outside production the dev defaults are allowed', () => {
  assert.doesNotThrow(() =>
    assertSafeToServe(prodConfig({ isProduction: false, auth: { required: false } })),
  );
});
