import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LatestTaskQueue } from '../src/taskqueue';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('latest task queue bounds cross-document concurrency', async () => {
  const queue = new LatestTaskQueue<string>(2);
  const gates = [deferred(), deferred(), deferred(), deferred()];
  let active = 0;
  let peak = 0;
  const started: number[] = [];
  const finished = deferred();

  for (let i = 0; i < gates.length; i++) {
    queue.schedule(String(i), 0, async () => {
      started.push(i);
      active++;
      peak = Math.max(peak, active);
      await gates[i].promise;
      active--;
      if (started.length === gates.length && active === 0) finished.resolve();
    });
  }

  await tick();
  assert.deepEqual(started, [0, 1]);
  gates[0].resolve();
  await tick();
  assert.deepEqual(started, [0, 1, 2]);
  gates[1].resolve();
  gates[2].resolve();
  await tick();
  gates[3].resolve();
  await finished.promise;
  assert.equal(peak, 2);
});

test('rescheduling a key aborts stale active work and runs only the replacement', async () => {
  const queue = new LatestTaskQueue<string>(1);
  const staleStarted = deferred();
  const replacementDone = deferred();
  let staleAborted = false;
  let replacements = 0;

  queue.schedule('file.pj', 0, async (signal) => {
    staleStarted.resolve();
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => {
        staleAborted = true;
        resolve();
      }, { once: true });
    });
  });
  await staleStarted.promise;
  queue.schedule('file.pj', 0, async () => {
    replacements++;
    replacementDone.resolve();
  });
  await replacementDone.promise;

  assert.equal(staleAborted, true);
  assert.equal(replacements, 1);
});

test('cancel removes debounced work before it starts', async () => {
  const queue = new LatestTaskQueue<string>(1);
  let ran = false;
  queue.schedule('file.pj', 15, async () => {
    ran = true;
  });
  queue.cancel('file.pj');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(ran, false);
});

test('a replacement waits for its aborted same-key process to actually finish', async () => {
  const queue = new LatestTaskQueue<string>(2);
  const staleStarted = deferred();
  const letStaleClose = deferred();
  const otherStarted = deferred();
  const letOtherClose = deferred();
  const replacementStarted = deferred();
  let staleWasAborted = false;

  queue.schedule('same', 0, async (signal) => {
    staleStarted.resolve();
    signal.addEventListener('abort', () => { staleWasAborted = true; }, { once: true });
    await letStaleClose.promise;
  });
  await staleStarted.promise;
  queue.schedule('same', 0, async () => { replacementStarted.resolve(); });
  queue.schedule('other', 0, async () => {
    otherStarted.resolve();
    await letOtherClose.promise;
  });
  await otherStarted.promise;
  await tick();
  assert.equal(staleWasAborted, true);

  let replacementRan = false;
  void replacementStarted.promise.then(() => { replacementRan = true; });
  await tick();
  assert.equal(replacementRan, false, 'same-key work must not overlap while the aborted process is closing');
  letStaleClose.resolve();
  await replacementStarted.promise;
  letOtherClose.resolve();
});
