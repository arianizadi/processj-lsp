import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

/**
 * A process that makes two sandboxes, starts the background removal of one
 * and keeps the other in use, under `tmp` as its temporary directory; then
 * it exits, or waits for a signal.
 */
function sandboxProcess(tmp: string, ending: 'exit' | 'signal'): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const script = `
const { makeSandbox } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'compiler.js'))});
const install = { installDir: '/nonexistent', includeDir: '/nonexistent/include', javaBin: 'java', classpath: '' };
const done = makeSandbox(install, '/nonexistent/done.pj', 'public void main(string[] args) { }');
makeSandbox(install, '/nonexistent/busy.pj', 'public void main(string[] args) { }');
done.cleanup();
if (process.argv[1] === 'exit') process.exit(0);
process.stdout.write('ready\\n');
setInterval(() => {}, 1000);
`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', script, ending], { env: { ...process.env, TMPDIR: tmp }, stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.on('data', () => child.kill('SIGTERM'));
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

test('a process that exits removes its sandboxes at once, also the ones still being removed in the background', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-sandbox-exit-'));
  try {
    assert.deepEqual(await sandboxProcess(tmp, 'exit'), { code: 0, signal: null });
    assert.deepEqual(fs.readdirSync(tmp), [], 'no processj-lsp-* directory is left');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a server stopped by a signal (an editor ending its subprocesses) removes its sandboxes too', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-sandbox-signal-'));
  try {
    const ended = await sandboxProcess(tmp, 'signal');
    assert.equal(ended.signal, null, 'it exits by itself, not killed by the signal');
    assert.deepEqual(fs.readdirSync(tmp), [], 'no processj-lsp-* directory is left');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
