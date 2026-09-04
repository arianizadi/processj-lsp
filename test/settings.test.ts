import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/settings';

test('initialization settings use safe defaults and bounded numeric values', () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({
    installDir: '  /opt/processj  ',
    javaBin: '',
    debounceMs: -20,
    timeoutMs: Number.POSITIVE_INFINITY,
    runTimeoutMs: 9_000_000,
    checkOnChange: 'yes',
    lint: false,
    codeLens: false,
  }), {
    installDir: '/opt/processj',
    javaBin: undefined,
    debounceMs: 0,
    timeoutMs: 20_000,
    runTimeoutMs: 3_600_000,
    checkOnChange: false,
    lint: false,
    codeLens: false,
  });
});
