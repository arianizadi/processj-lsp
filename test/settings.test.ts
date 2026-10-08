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
    liveViewer: 'no',
    fdrPath: ' /Applications/FDR4.app ',
    fdrTimeoutMs: 10,
    fdrMemoryMb: -5,
    fdrWorkers: 2.4,
    fdrShowGraph: 'sometimes',
  }), {
    installDir: '/opt/processj',
    javaBin: undefined,
    debounceMs: 0,
    timeoutMs: 20_000,
    runTimeoutMs: 3_600_000,
    checkOnChange: false,
    lint: false,
    codeLens: false,
    liveViewer: true,
    fdrPath: '/Applications/FDR4.app',
    fdrTimeoutMs: 1_000,
    fdrMemoryMb: 0,
    fdrWorkers: 2,
    fdrShowGraph: 'onFailure',
  });
  assert.equal(normalizeSettings({ liveViewer: false }).liveViewer, false);
  // When Check with FDR opens the graph: one of three words, anything else is the default.
  assert.deepEqual(['always', 'never', 'onFailure', 'Always', 1].map((value) => normalizeSettings({ fdrShowGraph: value }).fdrShowGraph), ['always', 'never', 'onFailure', 'onFailure', 'onFailure']);
});
