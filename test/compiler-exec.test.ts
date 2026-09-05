import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exec } from '../src/compiler';

test('a pre-aborted compiler task never launches its executable', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await exec('/missing-pj-test-executable', [], { cwd: process.cwd(), signal: controller.signal });
  assert.equal(result.aborted, true);
  assert.equal(result.exitCode, null);
  assert.equal(result.stderr, '', 'there was no spawn attempt and therefore no ENOENT error');
  assert.equal(result.timedOut, false);
});

test('abort tolerates an executable that failed to spawn', async () => {
  const controller = new AbortController();
  const pending = exec('/missing-pj-test-executable', [], { cwd: process.cwd(), signal: controller.signal });
  controller.abort();
  const result = await pending;
  assert.equal(result.aborted, true);
  assert.equal(result.exitCode, null);
  assert.match(result.stderr, /ENOENT/);
});
