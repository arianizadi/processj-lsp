/**
 * The compiler and FDR on a client's runner (src/remote.ts): the jobs the
 * server sends (the runner accepts files of the project only, by their paths
 * in it) and how their answers become what a local run would have given.
 */
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { CspmDocument } from '../src/cspm/document';
import { explainCspm } from '../src/cspm/explain';
import { compileJob, compilerOutput, fdrRunFromFrames, NO_FDR_ANSWER, refinesJob, remoteOptions, remoteRefines, type Project, type RunRefinesParams, type RunRefinesResult } from '../src/remote';

const ROOT = path.resolve('/w');
const at = (...parts: string[]): string => path.join(ROOT, ...parts);

function project(files: Record<string, string>): Project {
  const byPath = new Map(Object.entries(files).map(([name, text]) => [at(...name.split('/')), text]));
  return { roots: [ROOT], read: (file) => byPath.get(path.resolve(file)) };
}

test('the client offers its runner in initializationOptions.browser', () => {
  assert.deepEqual(remoteOptions({ browser: { remoteFdr: true, remoteCompile: true } }), { fdr: true, compile: true });
  assert.deepEqual(remoteOptions({ browser: { remoteFdr: 'yes' } }), { fdr: false, compile: false });
  assert.deepEqual(remoteOptions(undefined), { fdr: false, compile: false });
});

test('an FDR job: the model at the top, includes rewritten to project paths, included files with theirs', () => {
  const files = project({
    'specs/spec.csp': 'include "common.csp"\ninclude "' + at('lib', 'more.csp').split(path.sep).join('/') + '"\nSPEC = STOP\n',
    'specs/common.csp': 'channel a\n',
    'lib/more.csp': '-- nothing to include\n',
    'model.csp': 'clash\n',
  });
  const job = refinesJob({ name: 'model.csp', includeBase: at('src'), text: 'include "../specs/spec.csp"\ninclude "/etc/passwd"\ninclude "nowhere.csp"\nP = STOP\n' }, files);
  // Outside the project, or no such file: left as written, for the runner to refuse.
  assert.equal(job.model, 'include "specs/spec.csp"\ninclude "/etc/passwd"\ninclude "nowhere.csp"\nP = STOP\n');
  assert.deepEqual(job.files.map((file) => file.path), ['specs/spec.csp', 'specs/common.csp', 'lib/more.csp']);
  // An included file's includes are relative to itself, as FDR reads them; an absolute one is made so.
  assert.equal(job.files[0].text, 'include "common.csp"\ninclude "../lib/more.csp"\nSPEC = STOP\n');
  assert.equal(job.name, 'model.csp');
  // A model named like an included file at the top is renamed; names are ones the runner accepts.
  const clash = refinesJob({ name: 'model.csp', includeBase: ROOT, text: 'include "model.csp"\n' }, files);
  assert.equal(clash.name, 'model.2.csp');
  assert.equal(refinesJob({ name: 'my model', text: 'P = STOP\n' }, files).name, 'my_model.csp');
});

test('a runner\'s frames are read as refines\' output; its failure as refines\' stderr', () => {
  const frames = [
    { copyright_notice: 'FDR Version 4.2.7 copyright', errors: [], warnings: [] },
    { results: [{ assertion_string: 'P :[deadlock free]', result: 0, is_negated: 0, errors: [], visited_states: 6, visited_transitions: 9, counterexamples: [{ type: 'deadlock' }] }], event_map: { 1: 'a' } },
  ];
  const run = fdrRunFromFrames({ exitCode: 0, frames }, 42);
  assert.deepEqual(run, { results: [{ assertion: 'P :[deadlock free]', passed: false, errors: [], states: 6, transitions: 9, counterexamples: [{ type: 'deadlock' }] }], errors: [], warnings: [], eventMap: { 1: 'a' }, version: '4.2.7', timedOut: false, aborted: false, exitCode: 0, durationMs: 42, stderr: '' });
  const failed = fdrRunFromFrames({ exitCode: -1, frames: [], error: 'Stopped: took longer than 120s.' }, 1);
  assert.deepEqual({ results: failed.results, errors: failed.errors, stderr: failed.stderr, exitCode: failed.exitCode }, { results: [], errors: [], stderr: 'Stopped: took longer than 120s.', exitCode: -1 });
  // refines always prints a frame: none, even with exit code 0, is no answer rather than nothing to report.
  const silent = fdrRunFromFrames({ exitCode: 0, frames: [] }, 1);
  assert.deepEqual({ results: silent.results, errors: silent.errors, stderr: silent.stderr, exitCode: silent.exitCode }, { results: [], errors: [], stderr: NO_FDR_ANSWER, exitCode: 0 });
});

test('an FDR check the runner answered with no frames is not decided', () => {
  const doc = new CspmDocument('file:///w/p.csp', 'channel a\nP = a -> Q\nassert P :[deadlock free]\n');
  const report = explainCspm({ uri: doc.uri, text: doc.text, file: doc.file, globals: doc.globals, viewFor: (a) => doc.viewForAssertion(a), run: fdrRunFromFrames({ exitCode: 0, frames: [] }, 1) });
  assert.equal(report.checks.length, 1);
  assert.equal(report.checks[0].status, 'error');
  assert.match(report.checks[0].message ?? '', /FDR gave no answer/);
});

test('a remote refines reports results as they would arrive, and a cancelled check ends without waiting', async () => {
  const asked: RunRefinesParams[] = [];
  let release: ((result: RunRefinesResult) => void) | undefined;
  let cancelled: AbortSignal | undefined;
  const runner = remoteRefines((params, signal) => {
    asked.push(params);
    cancelled = signal;
    return new Promise((resolve) => (release = resolve));
  }, project({}));
  const seen: string[] = [];
  const running = runner({ name: 'p.csp', text: 'P = STOP\n' }, { timeoutMs: 5_000, onResult: (index, result) => seen.push(`${index}:${result.assertion}`) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(asked, [{ model: 'P = STOP\n', name: 'p.csp', files: [], mode: 'check', timeoutMs: 5_000 }]);
  release!({ exitCode: 0, frames: [{ results: [{ assertion_string: 'P :[deadlock free]', result: 1, errors: [], counterexamples: [] }] }] });
  const run = await running;
  assert.deepEqual(seen, ['0:P :[deadlock free]']);
  assert.equal(run.results[0].passed, true);

  const stop = new AbortController();
  const typecheck = runner({ name: 'p.csp', text: 'P = STOP\n' }, { typecheckOnly: true, signal: stop.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(asked[1].mode, 'typecheck');
  stop.abort();
  assert.equal((await typecheck).aborted, true);
  assert.equal(cancelled?.aborted, true, 'the request to the client is cancelled too');

  const unreachable = remoteRefines(() => Promise.reject(new Error('Unhandled method processj/runRefines')), project({}));
  assert.match((await unreachable({ name: 'p.csp', text: '' }, {})).stderr, /the runner could not be asked \(Unhandled method processj\/runRefines\)/);
});

test('a compile job: the file and its imports, where the compiler resolves them from the file\'s folder', () => {
  const files = project({ 'app/lib/util.pj': 'util', 'shared/geo/shapes.pj': 'shapes', 'tools.pj': 'tools' });
  const job = compileJob(
    { file: at('app', 'main.pj'), text: 'main (as compiled)' },
    [at('app', 'lib', 'util.pj'), at('shared', 'geo', 'shapes.pj'), at('tools.pj'), path.resolve('/elsewhere/x.pj')],
    // `import geo.shapes;` found under the workspace root `shared`, `import tools;` at the root itself.
    [{ name: 'geo', target: at('shared', 'geo') }, { name: 'tools.pj', target: at('tools.pj') }],
    files,
  );
  assert.ok(job);
  assert.equal(job.root, ROOT);
  assert.deepEqual(job.params, {
    entry: 'app/main.pj',
    mode: 'check',
    files: [
      { path: 'app/main.pj', text: 'main (as compiled)' },
      { path: 'app/lib/util.pj', text: 'util' },
      { path: 'app/geo/shapes.pj', text: 'shapes' },
      { path: 'app/tools.pj', text: 'tools' },
    ],
  });
  assert.equal(compileJob({ file: path.resolve('/elsewhere/main.pj'), text: '' }, [], [], files), undefined);
});

test('the runner\'s own notes are not compiler output', () => {
  const output = '\x1b[2mprocessjc main.pj\x1b[0m\n\x1b[31merror[405]\x1b[0m: x\nmain.pj:3: y\nError number: 1\n\x1b[2mcompilation failed\x1b[0m\n';
  assert.equal(compilerOutput(output), '\x1b[31merror[405]\x1b[0m: x\nmain.pj:3: y\nError number: 1\n');
});
