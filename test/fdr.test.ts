/**
 * FDR's answers in ProcessJ terms: explain(), the diagnostics and text report
 * derived from it, the FDR runner and the server commands.
 *
 * The explanation tests run on refines output recorded in
 * test/fixtures/fdr/<case>.json, so they need no FDR. Each recording names
 * a hash of the model it was made for: when the translator changes what it
 * generates, the tests say so, and the recordings are made again with FDR
 * installed:
 *
 *   PJ_RECORD_FDR=1 npm test
 *
 * Recordings use one BFS worker, so refines finds the same counterexample
 * every time. Tests that run refines themselves are skipped when it is not
 * installed.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  checkWithFdr,
  explain,
  fdrDiagnostics,
  matchResults,
  findRefines,
  formatFdrReport,
  lensVerdict,
  parseState,
  processNames,
  translateProcedure,
  translateProgram,
  type CspModel,
  type FdrRun,
} from '../src/csp/index';
import { recordedRun } from './fdr-recordings';
import { stopServer } from './server-process';
import { loadProgram } from '../src/csp/load';
import { blockAssertions } from '../src/csp/translate';
import { story, stuckForGood } from '../src/graph/overlay';
import type { Counterexample, ProcessSnapshot, VerificationReport } from '../src/verification';
import { samePath } from '../src/verification';

const ROOT = path.join(__dirname, '..', '..');
const INCLUDE = path.join(ROOT, 'test', 'fixtures', 'include');
const refines = findRefines();
const NO_FDR = !refines && 'FDR (refines) is not installed';

// ---------------------------------------------------------------------------
// The programs
// ---------------------------------------------------------------------------

interface Case {
  name: string;
  source: string;
  procedure?: string;
}

const COMMSTIME = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'processj', 'commstime.pj'), 'utf8').replace(/1000000/g, '5').replace(/999999/g, '4');

const CASES: Record<string, Case> = {
  // Each branch writes first: both wait for a reader that is itself waiting.
  crossed: { name: 'crossed', source: fs.readFileSync(path.join(ROOT, 'examples', 'par_deadlock.pj'), 'utf8') },
  // consume stops after three values: delta's first branch waits forever to write a.
  readerEnded: { name: 'reader_ended', source: COMMSTIME.replace(/(public void consume[\s\S]*?while \(l < )5/, '$13') },
  // c() ends while both a(b) wait at the barrier: in the ProcessJ runtime a resignation never completes it.
  barrier: {
    name: 'barrier_resign',
    source: [
      'public void a(barrier b) {',
      '    b.sync();',
      '}',
      'public void c() {',
      '}',
      'public void main(string[] args) {',
      '    barrier b;',
      '    par enroll (b) {',
      '        a(b);',
      '        a(b);',
      '        c();',
      '    }',
      '}',
    ].join('\n'),
  },
  // The second answer, 2 * 2, does not fit the integers the model uses (0..3). The first
  // answer decides whether the second question is asked, so the answers are exact values.
  range: {
    name: 'range',
    source: [
      '//@csp int 0..3',
      'public void server(chan<int>.read in, chan<int>.write out) {',
      '    while (true) {',
      '        int v = in.read();',
      '        out.write(v * 2);',
      '    }',
      '}',
      'public void main(string[] args) {',
      '    chan<int> c;',
      '    chan<int> d;',
      '    par {',
      '        server(c.read, d.write);',
      '        { c.write(1); int r = d.read(); if (r == 2) c.write(2); r = d.read(); }',
      '    }',
      '}',
    ].join('\n'),
  },
  // A loop that never communicates.
  spin: {
    name: 'spin',
    procedure: 'spin',
    source: ['public void spin(chan<int>.read in) {', '    while (true) {', '        int x = 0;', '    }', '}', 'public void main(string[] args) { }'].join('\n'),
  },
  // The skip guard is always ready: the procedure may refuse a value it could have read.
  choosy: {
    name: 'choosy',
    procedure: 'choosy',
    source: [
      'public void choosy(chan<int>.read a, chan<int>.write out) {',
      '    int x;',
      '    alt {',
      '        x = a.read() : { out.write(x); }',
      '        skip : { out.write(0); }',
      '    }',
      '}',
      'public void main(string[] args) { }',
    ].join('\n'),
  },
  // A checked procedure with a data parameter: v + k leaves 0..1 for k = 1.
  scale: {
    name: 'scale',
    procedure: 'scale',
    source: [
      'public void scale(int k, chan<int>.read in, chan<int>.write out) {',
      '    while (true) {',
      '        int v = in.read();',
      '        out.write(v + k);',
      '    }',
      '}',
      'public void main(string[] args) { }',
    ].join('\n'),
  },
  // The writer stays in the rendezvous until the reader's block is done, but the block writes to it.
  extended: {
    name: 'extended',
    source: [
      'public void main(string[] args) {',
      '    chan<int> c;',
      '    chan<int> d;',
      '    par {',
      '        { c.write(5); int z = d.read(); }',
      '        { int v = c.read({ d.write(1); }); }',
      '    }',
      '}',
    ].join('\n'),
  },
  // Three iterations share one channel: two write, one reads.
  shared: {
    name: 'shared',
    source: [
      'import std.*;',
      // A call decides which iterations write (not a condition elaboration can work out), so every iteration may do both.
      'public boolean even(int k) { return k % 2 == 0; }',
      'public void main(string[] args) {',
      '    shared chan<int> c;',
      '    par for (int i = 0; i < 3; i++) {',
      '        if (even(i)) c.write(i);',
      '        else println("odd read " + c.read());',
      '    }',
      '}',
    ].join('\n'),
  },
  // Three writers share one end; their reader stops after five of the six values.
  sharedWriters: {
    name: 'shared_writers',
    source: [
      'public void reader(chan<int>.read in) {',
      '    for (int k = 0; k < 5; k++) {',
      '        int v = in.read();',
      '    }',
      '}',
      'public void writer(int id, shared chan<int>.write out) {',
      '    for (int i = 0; i < 2; i++) out.write(id);',
      '}',
      'public void main(string[] args) {',
      '    shared write chan<int> c;',
      '    par {',
      '        reader(c.read);',
      '        writer(1, c.write);',
      '        writer(2, c.write);',
      '        writer(3, c.write);',
      '    }',
      '}',
    ].join('\n'),
  },
  // The alt may take skip before the writer is ready; the writer then waits forever.
  altSkip: { name: 'alt_skip', source: fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'processj', 'alttest.pj'), 'utf8') },
  // The user's own specification: a only ever carries 1.
  userSpec: {
    name: 'user_spec',
    source: [
      '//@csp int 0..3',
      '/*@csp',
      'ONLY_ONES = a.1 -> ONLY_ONES',
      'assert ONLY_ONES [T= MAIN',
      '*/',
      'public void main(string[] args) {',
      '    chan<int> a;',
      '    par {',
      '        { a.write(1); a.write(2); }',
      '        { int x = a.read(); x = a.read(); }',
      '    }',
      '}',
    ].join('\n'),
  },
  // Nothing ever writes c.
  noWriter: { name: 'no_writer', source: fs.readFileSync(path.join(ROOT, 'examples', 'deadlock_read.pj'), 'utf8') },
  // No deadlock in the language; this ProcessJ build takes no lock for the inline writes and hangs.
  unlocked: { name: 'unlocked', source: fs.readFileSync(path.join(ROOT, 'examples', 'shared_unlocked_end.pj'), 'utf8') },
  // Every iteration writes before it reads: a deadlock in the language, while this build runs the two statements as separate processes.
  parForBody: { name: 'par_for_body', source: fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'processj', 'fibonacci.pj'), 'utf8') },
  // The language stops branch 1 at `stop` (this ProcessJ build ignores it): the par never ends.
  stop: { name: 'stop', source: fs.readFileSync(path.join(ROOT, 'test', 'differential', 'stop_ignored.pj'), 'utf8') },
  // A real runtime error: the divisor read from c is 0.
  divide: {
    name: 'divide',
    source: [
      'import std.*;',
      'public void main(string[] args) {',
      '    chan<int> c;',
      '    par {',
      '        c.write(0);',
      '        { int d = c.read(); int q = 6 / d; println(q); }',
      '    }',
      '}',
    ].join('\n'),
  },
  // Each iteration declares its own channels and deadlocks on them: no wait crosses iterations.
  parForLocal: {
    name: 'par_for_local',
    source: [
      'public void main(string[] args) {',
      '    par for (int i = 0; i < 2; i++) {',
      '        chan<int> e, f;',
      '        par {',
      '            { e.write(1); int x = f.read(); }',
      '            { f.write(2); int y = e.read(); }',
      '        }',
      '    }',
      '}',
    ].join('\n'),
  },
  // The third branch is enrolled on b but waits on its own channel forever: b never completes.
  barrierNever: {
    name: 'barrier_never',
    source: [
      'public void main(string[] args) {',
      '    barrier b;',
      '    chan<int> c;',
      '    par enroll (b) {',
      '        b.sync();',
      '        b.sync();',
      '        { int x = c.read(); }',
      '    }',
      '}',
    ].join('\n'),
  },
  // Each iteration has its own barrier; in iteration 1 the middle branch resigns while the others wait.
  parForBarrier: {
    name: 'par_for_barrier',
    source: [
      'public void main(string[] args) {',
      '    par for (int i = 0; i < 2; i++) {',
      '        barrier b;',
      '        par enroll (b) {',
      '            b.sync();',
      '            { if (i == 0) b.sync(); }',
      '            b.sync();',
      '        }',
      '    }',
      '}',
    ].join('\n'),
  },
  // The reader has done its only read of c: the second write waits for nobody (no circle through d).
  pastRead: {
    name: 'past_read',
    source: [
      'public void main(string[] args) {',
      '    chan<int> c, d;',
      '    par {',
      '        { c.write(1); c.write(2); d.write(3); }',
      '        { int x = c.read(); int y = d.read(); }',
      '    }',
      '}',
    ].join('\n'),
  },
  // Two guards on one channel, told apart by their preconditions: the one enabled is the one taken and waiting.
  altPreconditions: {
    name: 'alt_preconditions',
    source: [
      'import std.*;',
      'public void main(string[] args) {',
      '    chan<int> a;',
      '    par {',
      '        a.write(1);',
      '        {',
      '            int n = 0;',
      '            int x = 0;',
      '            while (n < 2) {',
      '                alt {',
      '                    (n == 0) && x = a.read() : { println("first"); }',
      '                    (n == 1) && x = a.read() : { println("second"); }',
      '                }',
      '                n = n + 1;',
      '            }',
      '        }',
      '    }',
      '}',
    ].join('\n'),
  },
  // Nothing reads c, while two other branches talk forever: no deadlock of the whole program, but a write waits for good.
  partial: {
    name: 'partial',
    source: [
      'public void ticker(chan<int>.write out) { while (true) out.write(0); }',
      'public void sink(chan<int>.read in) { while (true) { int v = in.read(); } }',
      'public void main(string[] args) {',
      '    chan<int> a, c;',
      '    par {',
      '        ticker(a.write);',
      '        sink(a.read);',
      '        c.write(1);',
      '    }',
      '}',
    ].join('\n'),
  },
  // A par for whose bound arrives as an argument: the iterations past it do not exist.
  computedBounds: {
    name: 'computed_bounds',
    source: [
      'import std.*;',
      'public void work(int n, chan<int>.write out) { par for (int i = 0; i < n; i++) out.write(i); }',
      'public void main(string[] args) {',
      '    chan<int> c;',
      '    par {',
      '        work(2, c.write);',
      '        { int x = c.read(); println(x); }',
      '    }',
      '}',
    ].join('\n'),
  },
  // The two branches talk forever on the procedure's own channel and never write out: a livelock to its caller.
  livelock: {
    name: 'livelock',
    procedure: 'chatter',
    source: [
      'public void chatter(chan<int>.write out) {',
      '    chan<int> x;',
      '    par {',
      '        while (true) x.write(1);',
      '        while (true) { int v = x.read(); }',
      '    }',
      '    out.write(5);',
      '}',
      'public void main(string[] args) { }',
    ].join('\n'),
  },
  // Which internal writer the alt meets first decides what the caller sees.
  race: {
    name: 'race',
    procedure: 'race',
    source: [
      'public void race(chan<int>.write out) {',
      '    chan<int> a, b;',
      '    par {',
      '        a.write(1);',
      '        b.write(2);',
      '        {',
      '            int x = 0;',
      '            alt {',
      '                x = a.read() : { out.write(1); x = b.read(); }',
      '                x = b.read() : { out.write(2); x = a.read(); }',
      '            }',
      '        }',
      '    }',
      '}',
      'public void main(string[] args) { }',
    ].join('\n'),
  },
  // Your own assertions, negated and plain, one of them inside a CSPm comment (not an assertion).
  userAssertions: {
    name: 'user_assertions',
    source: [
      '//@csp assert MAIN :[deadlock free [F]]',
      '//@csp assert not MAIN :[deadlock free [F]]',
      '/*@csp',
      '{- switched off:',
      'assert MAIN [T= STOP',
      '-}',
      'assert not MAIN :[has trace]: <c.1>',
      '*/',
      'public void main(string[] args) {',
      '    chan<int> c;',
      '    par { c.write(1); { int x = c.read(); } }',
      '}',
    ].join('\n'),
  },
  // consume stops early and delta's branches are compressed (//@csp compress): their state is not known.
  compressed: {
    name: 'compressed',
    source: ['//@csp compress', COMMSTIME.replace(/(public void consume[\s\S]*?while \(l < )5/, '$13')].join('\n'),
  },
  // c has an extended read, so every read of c is acknowledged; the first read is plain, and the third write has no reader.
  ackAfterRead: {
    name: 'ack_after_read',
    source: [
      'public void main(string[] args) {',
      '    chan<int> c;',
      '    par {',
      '        { c.write(1); c.write(2); c.write(3); }',
      '        { int x = c.read(); int y = c.read({ x = 0; }); }',
      '    }',
      '}',
    ].join('\n'),
  },
  // The values only get printed: they outgrow 0..3 without an error, and the writer outlives its reader.
  saturated: {
    name: 'saturated',
    source: [
      '//@csp int 0..3',
      'import std.*;',
      'public void main(string[] args) {',
      '    chan<int> c;',
      '    par {',
      '        { int v = 3; while (true) { c.write(v); v = v * 2; } }',
      '        { for (int i = 0; i < 3; i++) println(c.read()); }',
      '    }',
      '}',
    ].join('\n'),
  },
};

function load(c: Case) {
  const file = path.join(os.tmpdir(), 'processj-fdr-test', `${c.name}.pj`);
  const loaded = loadProgram(file, INCLUDE, c.source);
  assert.deepEqual(loaded.syntaxErrors, [], `${c.name} must parse`);
  return { file, uri: pathToFileURL(file).href, input: { units: loaded.units, index: loaded.index } };
}

function modelOf(c: Case): { model: CspModel; uri: string } {
  const { uri, input } = load(c);
  const model = c.procedure ? translateProcedure(input, c.procedure) : translateProgram(input);
  assert.deepEqual(model.unsupported, [], `${c.name}: the model is complete`);
  return { model, uri };
}

/** refines' output for a case: recorded, or recorded afresh with PJ_RECORD_FDR=1 (fdr-recordings.ts). */
function recorded(c: Case, model: CspModel): Promise<FdrRun> {
  return recordedRun(c.name, model);
}

async function reportOf(c: Case): Promise<{ report: VerificationReport; model: CspModel; uri: string }> {
  const { model, uri } = modelOf(c);
  const run = await recorded(c, model);
  assert.equal(run.results.length, model.assertions.length, `${c.name}: one recorded result per assertion (re-record with PJ_RECORD_FDR=1)`);
  return { report: explain(model, run, { uri, documentVersion: 7 }), model, uri };
}

function failed(report: VerificationReport, id: string): Counterexample {
  const check = report.checks.find((c) => c.id === id);
  assert.ok(check, `no check ${id}`);
  assert.equal(check.status, 'failed', `${id}: ${check.message}`);
  assert.ok(check.counterexample, `${id} has a counterexample`);
  return check.counterexample;
}

function line(snap: ProcessSnapshot | undefined): number | undefined {
  return snap?.at ? snap.at.span.start.line + 1 : undefined;
}

function byLabel(cx: Counterexample, label: string): ProcessSnapshot {
  const found = cx.final.find((s) => s.process.label === label);
  assert.ok(found, `no process ${label} among ${cx.final.map((s) => s.process.label).join(', ')}`);
  return found;
}

// ---------------------------------------------------------------------------
// explain(): recorded counterexamples
// ---------------------------------------------------------------------------

test('a crossed-order deadlock: both writes are stuck, each waits for the other, and that circle is reported', async () => {
  const { report, model } = await reportOf(CASES.crossed);
  assert.equal(report.producer, 'fdr');
  assert.equal(report.documentVersion, 7);
  assert.equal(report.tool?.name, 'FDR');
  assert.deepEqual(report.checks.map((c) => [c.id, c.status]), [['deadlock-free', 'failed'], ['no-runtime-errors', 'passed'], ['terminates', 'failed']]);
  const cx = failed(report, 'deadlock-free');
  assert.equal(cx.kind, 'deadlock');
  // One internal step starts both branches (as the runtime does: a par starts all its branches together); the outside saw nothing.
  assert.deepEqual(cx.steps.map((s) => [s.kind, s.visible]), [['internal', false]]);
  assert.match(cx.steps[0].description, /^main starts branch 1 and branch 2 \(par at line 10\)$/);
  assert.deepEqual(cx.steps[0].participants.map((p) => p.process.label), ['main', 'branch 1', 'branch 2']);
  const [main, b1, b2] = cx.final;
  assert.deepEqual(cx.final.map((s) => s.status), ['blocked', 'blocked', 'blocked']);
  assert.equal(line(b1), 12);
  assert.equal(line(b2), 17);
  assert.deepEqual(b1.waits?.map((w) => [w.operation, w.channel?.name, w.partner?.state]), [['write', 'c', 'blocked-elsewhere']]);
  assert.ok(b1.waits?.[0].partner?.process && samePath(b1.waits[0].partner.process.path, b2.process.path), 'branch 1 waits for branch 2');
  assert.match(b1.waits![0].partner!.detail, /^branch 2, the only reader of c \(line 18\), waits to write 2 on d \(line 17\)$/);
  // The par ends only when both branches have, and both are stuck: it names them both, the first blocked one as its partner.
  assert.equal(main.waits![0].detail, 'waits at its par for branch 1 and branch 2 to finish');
  assert.deepEqual([main.waits![0].partner?.state, main.waits![0].partner?.process?.label], ['blocked-elsewhere', 'branch 1']);
  assert.equal(main.waits![0].partner?.detail, 'branch 1 waits to write 1 on c (line 12); branch 2 waits to write 2 on d (line 17)');
  // The circle: branch 1 waits on c for branch 2, branch 2 on d for branch 1.
  assert.equal(cx.cycles?.length, 1);
  assert.deepEqual(cx.cycles![0].map((m) => [m.process.label, m.channel?.name]), [['branch 1', 'c'], ['branch 2', 'd']]);
  assert.equal(cx.caveats, undefined, 'nothing abstract decides this run');
  assert.match(cx.summary, /^deadlock after 1 step: a circular wait: branch 1 waits to write 1 on c \(line 12\) for branch 2, which waits to write 2 on d \(line 17\) for branch 1$/);
  // Every process is the model's own (src/verification.ts identity), named as the sentences name it.
  const identity = (p: { path: unknown; label: string; procedure?: string }) => ({ path: p.path, label: p.label, procedure: p.procedure });
  assert.deepEqual(cx.final.map((s) => identity(s.process)), model.sourceMap.processes.filter((p) => p.process).map((p) => identity(p.process!)));
  assert.deepEqual(cx.final.map((s) => s.process.name), ['main', 'branch 1', 'branch 2']);
});

test('a write that waits forever because its only reader has terminated', async () => {
  const { report } = await reportOf(CASES.readerEnded);
  const cx = failed(report, 'deadlock-free');
  const stuck = cx.final.find((s) => s.process.path.map((p) => p.kind).join('/') === 'branch/call/branch' && s.process.path[2].index === 1);
  assert.ok(stuck);
  assert.equal(stuck.status, 'blocked');
  assert.equal(line(stuck), 25);
  const wait = stuck.waits![0];
  assert.equal(wait.operation, 'write');
  assert.equal(wait.channel?.name, 'a');
  assert.deepEqual(wait.channel?.owner, []);
  assert.equal(wait.partner?.state, 'terminated');
  assert.equal(wait.partner?.process?.label, 'consume(a.read)');
  assert.match(wait.partner!.detail, /^consume, the only reader of a \(line 35\), has already terminated \(its last step was \d+\)$/);
  assert.equal(byLabel(cx, 'consume(a.read)').status, 'terminated');
  // prefix is stuck too: its reader delta waits at its par for the stuck branch.
  const prefix = byLabel(cx, 'prefix(0, c.read, d.write)');
  assert.equal(prefix.status, 'blocked');
  assert.equal(prefix.waits![0].partner?.state, 'blocked-elsewhere');
  assert.match(prefix.description, /^prefix waits to write 5 on out \(d\) \(line 8\); l = 5$/);
  assert.equal(cx.cycles, undefined, 'nothing circular: the cause is a terminated reader');
  assert.match(cx.summary, /^deadlock after \d+ steps: branch 1 of delta waits to write 4 on out1 \(a\) \(line 25\), but consume, the only reader of a/);
  // Every communication says who wrote, who read, and where each was.
  const first = cx.steps.find((s) => s.kind === 'communication' && s.channel?.name === 'a')!;
  assert.equal(first.value, '0');
  assert.equal(first.visible, true);
  assert.deepEqual(first.participants.map((p) => [p.role, p.at?.span.start.line]).sort(), [['reader', 34], ['writer', 24]]);
  assert.match(first.description, /^branch 1 of delta writes 0 on a \(line 25\); consume reads it \(line 35\)$/);
  const fork = cx.steps.find((s) => s.event.startsWith('pj_fork_delta_'))!;
  assert.match(fork.description, /^delta starts branch 1 and branch 2 \(par at line 24\) with l = 0$/);
});

test('a barrier left stuck: the last enrolled branch resigned after the others arrived', async () => {
  const { report } = await reportOf(CASES.barrier);
  const cx = failed(report, 'deadlock-free');
  const waiting = cx.final.filter((s) => s.waits?.some((w) => w.operation === 'sync'));
  assert.equal(waiting.length, 2);
  for (const s of waiting) {
    assert.equal(line(s), 2);
    const w = s.waits![0];
    assert.equal(w.channel?.name, 'b');
    assert.match(w.detail, /^waits at barrier b \(2 of 2 enrolled processes waiting\)$/);
    assert.equal(w.partner?.state, 'terminated');
    assert.match(w.partner!.detail, /^c has ended and resigned from b; in the ProcessJ runtime a resignation never completes a barrier/);
  }
  assert.ok(cx.steps.some((s) => s.kind === 'barrier' && /^c ends and resigns from barrier b$/.test(s.description)));
  assert.ok(cx.steps.some((s) => s.kind === 'barrier' && /arrives at barrier b \(line 2\)$/.test(s.description)));
});

test('a runtime error is reported at its statement, by the process that ran it', async () => {
  const { report } = await reportOf(CASES.range);
  const deadlock = report.checks.find((c) => c.id === 'deadlock-free');
  assert.equal(deadlock?.status, 'passed');
  // The error ends the runs it is in: deadlock freedom covers the runs that stay inside the integers.
  assert.match(deadlock!.message!, /, in the runs that stay inside the modelled integers 0\.\.3 \(see No runtime errors\)$/);
  // A value outside the model's integers is the model's limit, not an error of the program.
  assert.equal(report.checks.find((c) => c.id === 'no-runtime-errors')?.severity, 'warning');
  assert.equal(lensVerdict(report), 'FDR: integers out of range (4 steps)');
  const cx = failed(report, 'no-runtime-errors');
  assert.equal(cx.kind, 'runtime-error');
  assert.equal(cx.error?.kind, 'range');
  assert.equal(cx.error?.at?.span.start.line, 4);
  assert.match(cx.error!.message, /outside the modelled integers 0\.\.3/);
  const server = byLabel(cx, 'server(c.read, d.write)');
  assert.equal(server.status, 'error');
  assert.equal(line(server), 5);
  // The others are not stuck: the trace ends where the error happens.
  assert.ok(cx.final.filter((s) => s !== server).every((s) => s.status === 'running' && !s.waits));
  assert.match(cx.summary, /^integers out of the modelled range after 4 steps: server: the value written to 'out' is outside the modelled integers 0\.\.3 \(line 5\)$/);
  assert.match(server.description, /^server leaves the modelled integers, where the model stops: /);
});

test('what a passed check does not cover is said in short too', async () => {
  const range = await reportOf(CASES.range);
  assert.deepEqual(range.report.checks.find((c) => c.id === 'deadlock-free')?.limits, ['only in runs within 0..3']);
  const unlocked = await reportOf(CASES.unlocked);
  assert.deepEqual(unlocked.report.checks.find((c) => c.id === 'deadlock-free')?.limits, ['the compiled program may differ']);
  assert.match(lensVerdict(unlocked.report), /^FDR: no deadlock, \d+ states; the compiled program may differ$/);
  // A plain proof has no limits.
  assert.equal((await reportOf(CASES.crossed)).report.checks.find((c) => c.id === 'no-runtime-errors')?.limits, undefined);
});

test('after a plain read the model\'s acknowledgement only completes the write: bookkeeping, not a second message', async () => {
  const { report } = await reportOf(CASES.ackAfterRead);
  const cx = failed(report, 'deadlock-free');
  const acks = cx.steps.filter((s) => /__ack/.test(s.event) || /completes/.test(s.description));
  assert.deepEqual(acks.map((s) => s.kind), ['internal', 'communication']);
  assert.match(acks[0].description, /^branch 1's write on c completes \(line 4\): branch 2 has taken the value \(line 5\)$/);
  assert.match(acks[1].description, /^branch 2 finishes the extended rendezvous on c \(line 5\); branch 1's write completes$/);
});

test('a program too big to model is reported as not checked, never as holding, and its stub is marked as generated', () => {
  const c: Case = { name: 'too_big', source: 'public void w(chan<int>.write out, int i) { out.write(i); }\npublic void main(string[] args) {\n    chan<int> c;\n    par {\n        par for (int i = 0; i < 9; i++) { w(c.write, i); }\n        c.read();\n    }\n}' };
  const { uri, input } = load(c);
  const model = translateProgram({ ...input, options: { maxProcesses: 4 } });
  assert.deepEqual(model.assertions, []);
  assert.match(model.text, /^-- Generated by processj-lsp from too_big\.pj\. /);
  const report = explain(model, undefined, { uri });
  // The checks the model would have made, each not checked: a report with no check at all would read as no failure.
  assert.deepEqual(report.checks.map((check) => [check.id, check.status]), [['deadlock-free', 'skipped'], ['no-runtime-errors', 'skipped'], ['terminates', 'skipped']]);
  assert.ok(report.checks.every((check) => /^not checked: the model is incomplete \(the program has more than 4 processes/.test(check.message ?? '')));
  assert.equal(lensVerdict(report), 'FDR: not modelled');
  assert.equal(lensVerdict({ ...report, checks: [] }), 'FDR: not checked');
});

test('a process that reached stop is shown at that statement, with the compiled program\'s difference', async () => {
  const { report, model } = await reportOf(CASES.stop);
  const cx = failed(report, 'deadlock-free');
  const stopped = byLabel(cx, 'branch 1');
  assert.equal(stopped.status, 'blocked');
  assert.deepEqual(stopped.at?.span, { start: { line: 3, col: 26 }, end: { line: 3, col: 31 } });
  assert.match(stopped.description, /^branch 1 can never do anything again: it reached the stop statement at line 4$/);
  assert.ok(cx.caveats?.some((c) => c.startsWith('compiler/stop-ignored (line 4): ')), (cx.caveats ?? []).join('\n'));
  const [diagnostic] = fdrDiagnostics(report, model);
  assert.deepEqual([diagnostic.code, diagnostic.span.start.line, diagnostic.span.start.col], ['fdr/deadlock', 3, 26]);
});

test('a division by zero is a runtime error of the program, at its statement', async () => {
  const { report, model } = await reportOf(CASES.divide);
  const cx = failed(report, 'no-runtime-errors');
  assert.equal(report.checks.find((c) => c.id === 'no-runtime-errors')?.severity, 'error');
  assert.equal(cx.error?.kind, 'division-by-zero');
  assert.equal(cx.error?.at?.span.start.line, 5);
  assert.match(cx.summary, /^runtime error after \d+ steps: branch 2: /);
  assert.deepEqual(fdrDiagnostics(report, model).map((d) => [d.code, d.severity, d.span.start.line + 1]), [['fdr/runtime-error', 'error', 6]]);
  assert.equal(lensVerdict(report), `FDR: runtime error (${cx.steps.length} steps)`);
});

test('values that never decide anything outgrow the integers without an error and read as such', async () => {
  const { report, model } = await reportOf(CASES.saturated);
  assert.equal(report.checks.find((c) => c.id === 'no-runtime-errors')?.status, 'passed');
  assert.ok(report.assumptions.some((a) => /never decide anything/.test(a)), report.assumptions.join('\n'));
  const cx = failed(report, 'deadlock-free');
  const values = cx.steps.filter((s) => s.kind === 'communication').map((s) => s.value);
  assert.deepEqual(values, ['3', 'a value outside 0..3', 'a value outside 0..3']);
  assert.match(cx.steps.filter((s) => s.kind === 'communication')[1].description, /^branch 1 writes a value outside 0\.\.3 on c \(line 6\); branch 2 reads it \(line 7\)$/);
  const writer = byLabel(cx, 'branch 1');
  assert.match(writer.description, /^branch 1 waits to write a value outside 0\.\.3 on c \(line 6\); v = a value outside 0\.\.3$/);
  assert.equal(writer.waits?.[0].partner?.state, 'terminated');
  assert.match(model.text, /\nchannel c : Int_s\n/);
});

test('where the compiled program differs from the language, a verdict says so', async () => {
  const unlocked = await reportOf(CASES.unlocked);
  const deadlock = unlocked.report.checks.find((c) => c.id === 'deadlock-free')!;
  assert.equal(deadlock.status, 'passed');
  assert.match(deadlock.message!, /^no deadlock in \d+ states; the compiled program may differ \(pj\/shared-unlocked-end at line 13\)$/);
  const parForBody = await reportOf(CASES.parForBody);
  const cx = failed(parForBody.report, 'deadlock-free');
  assert.ok(cx.caveats?.some((c) => /^pj\/par-for-body \(line 14\): the model runs each par for iteration as one process \(the language\), while this ProcessJ build runs every statement of the body as its own process$/.test(c)), (cx.caveats ?? []).join('\n'));
  assert.match(fdrDiagnostics(parForBody.report, parForBody.model)[0].message, /the real program may not do this, see the caveats in the report\)$/);
  // Every iteration both writes and reads c, so c goes through a server. The writer whose value the server
  // holds waits for the acknowledgement in a definition that does not use the channel parameter itself
  // (FDR shows it as `_`); it is named all the same.
  assert.ok(cx.final.some((s) => s.waits?.some((w) => /^waits to write 0 on out \(c\) \(no reader has taken it\)$/.test(w.detail))), cx.final.map((s) => s.description).join('\n'));
  assert.ok(cx.final.every((s) => !/(^|[^A-Za-z0-9_])_([^A-Za-z0-9_]|$)/.test(s.description)), cx.final.map((s) => s.description).join('\n'));
  // Ten iterations all wait for each other: the shortest circles come first.
  assert.ok(cx.cycles?.length && cx.cycles.every((c) => c.length === 2), JSON.stringify(cx.cycles?.map((c) => c.length)));
});

test('a divergence names the process that loops without communicating', async () => {
  const { report } = await reportOf(CASES.spin);
  const cx = failed(report, 'divergence-free');
  assert.equal(cx.kind, 'divergence');
  assert.equal(cx.loopStart, 0);
  assert.equal(cx.final[0].status, 'diverging');
  assert.equal(line(cx.final[0]), 2);
  assert.match(cx.steps[0].description, /^spin goes round its loop \(line 2\)$/);
});

test('nondeterminism: whether a value is read depends on an internal choice of the alt', async () => {
  const { report } = await reportOf(CASES.choosy);
  const cx = failed(report, 'deterministic');
  assert.equal(cx.kind, 'nondeterminism');
  assert.equal(report.checks.find((c) => c.id === 'deterministic')?.severity, 'info');
  assert.match(cx.summary, /^nondeterministic at the start: whether choosy can read \d from a depends on an internal step \(choosy takes the skip guard of its alt \(line 5\)\)$/);
});

test('a checked procedure starts with the values of its data parameters', async () => {
  const { report } = await reportOf(CASES.scale);
  const cx = failed(report, 'no-runtime-errors');
  assert.equal(cx.steps[0].event, 'pj_call.1');
  assert.equal(cx.steps[0].description, 'scale is called with k = 1');
  assert.equal(cx.steps[0].participants[0]?.process.path.length, 0);
  assert.match(cx.steps[1].description, /^scale reads 1 from in \(line 3\) \(from the caller\)$/);
  assert.equal(cx.error?.at?.span.start.line, 3);
});

test('an extended rendezvous: the writer is held until the block is done, and the block needs the writer', async () => {
  const { report } = await reportOf(CASES.extended);
  const cx = failed(report, 'deadlock-free');
  const comm = cx.steps.find((s) => s.kind === 'communication')!;
  assert.match(comm.description, /^branch 1 writes 5 on c \(line 5\); branch 2 reads it and runs its extended rendezvous block \(line 6\)$/);
  const writer = byLabel(cx, 'branch 1');
  assert.match(writer.waits![0].detail, /^waits for its reader to finish the extended rendezvous on c$/);
  assert.equal(cx.cycles?.[0].length, 2);
});

test('several processes on both sides of a channel: a writer whose readers are all gone', async () => {
  const { report } = await reportOf(CASES.shared);
  const cx = failed(report, 'deadlock-free');
  const stuck = cx.final.find((s) => s.status === 'blocked' && s.process.path.length === 1)!;
  assert.equal(stuck.process.path[0].kind, 'par-for');
  assert.match(stuck.waits![0].detail, /^waits to write \d on c \(no reader has taken it\)$/);
  assert.match(stuck.waits![0].partner!.detail, /^no reader of c \(line 7\) can take part: .* have already terminated; .* reads c itself, but not while it waits here$/);
  // One fork starts every iteration of the par for.
  assert.match(cx.steps[0].description, /^main starts iteration i = 0, iteration i = 1 and iteration i = 2 \(par for at line 5\)$/);
});

test('shared writers: the one left over waits forever once the reader is done', async () => {
  const { report } = await reportOf(CASES.sharedWriters);
  const cx = failed(report, 'deadlock-free');
  const writers = cx.final.filter((s) => s.process.procedure === 'writer');
  assert.equal(writers.length, 3);
  const stuck = writers.filter((s) => s.status === 'blocked');
  assert.equal(stuck.length, 1, 'six values, five reads: exactly one writer is left');
  assert.equal(writers.filter((s) => s.status === 'terminated').length, 2);
  assert.equal(line(stuck[0]), 7);
  const wait = stuck[0].waits![0];
  assert.deepEqual([wait.operation, wait.channel?.name, wait.partner?.state, wait.partner?.process?.label], ['write', 'c', 'terminated', 'reader(c.read)']);
  assert.match(stuck[0].description, /^writer\([123], …\) waits to write [123] on out \(c\) \(line 7\)/);
  // Writers meet the reader one at a time: every communication has one writer and one reader.
  for (const step of cx.steps.filter((x) => x.kind === 'communication')) assert.deepEqual(step.participants.map((p) => p.role).sort(), ['reader', 'writer']);
});

test('an alt that takes its skip guard leaves the writer waiting', async () => {
  const { report } = await reportOf(CASES.altSkip);
  const cx = failed(report, 'deadlock-free');
  assert.ok(cx.steps.some((s) => s.event === 'pj_skip' && /takes the skip guard of its alt \(line 18\)/.test(s.description)));
  assert.match(cx.summary, /writer1 waits to write 42 on out \(c1\) \(line 6\), but reader, the only reader of c1 \(line 16\), has already terminated/);
  // The model lets the alt take skip whenever it likes; the runtime takes the first ready guard. The report says so.
  assert.deepEqual(cx.caveats, ['reader takes the skip guard at line 18 (step 2): ProcessJ takes the first ready guard in source order, so the real program does this only while no guard written before it is ready']);
  const { model } = modelOf(CASES.altSkip);
  assert.match(fdrDiagnostics(report, model)[0].message, /; the real program may not do this, see the caveats in the report\)$/);
  assert.equal(failed(report, 'deadlock-free').caveats?.length, 1);
});

test('a specification of your own: the event it refuses, and who would perform it', async () => {
  const { report, model } = await reportOf(CASES.userSpec);
  const check = report.checks.find((c) => c.id === 'block-1')!;
  assert.deepEqual([check.property, check.severity, check.label], ['refinement', 'error', 'ONLY_ONES [T= MAIN']);
  const cx = failed(report, 'block-1');
  assert.equal(cx.kind, 'refinement');
  assert.equal(cx.summary, 'ONLY_ONES [T= MAIN fails after 2 steps: branch 1 can then write 2 on a (line 9) and branch 2 read it (line 10), which the specification does not allow (a.2)');
  const [diagnostic] = fdrDiagnostics(report, model);
  assert.deepEqual([diagnostic.code, diagnostic.span.start.line, diagnostic.span.end.line], ['fdr/assertion', 1, 4], 'on the /*@csp block');
});

test('an operation nobody can ever answer', async () => {
  const { report } = await reportOf(CASES.noWriter);
  const cx = failed(report, 'deadlock-free');
  assert.equal(cx.steps.length, 0);
  assert.deepEqual(cx.final[0].waits?.map((w) => [w.operation, w.partner?.state, w.partner?.detail]), [['read', 'missing', 'nothing in the program writes c']]);
  assert.equal(cx.summary, 'deadlock at the start: main waits to read c (line 8), but nothing in the program writes c');
});

test('a par for body declares its own channels: every wait and circle stays inside one iteration', async () => {
  const { report } = await reportOf(CASES.parForLocal);
  const cx = failed(report, 'deadlock-free');
  const iteration = (snap: ProcessSnapshot): number | undefined => snap.process.path.find((s) => s.kind === 'par-for')?.index;
  const writers = cx.final.filter((s) => s.waits?.some((w) => w.operation === 'write'));
  assert.equal(writers.length, 4, 'both branches of both iterations wait to write');
  for (const s of writers) {
    const partner = s.waits![0].partner!;
    const of = cx.final.find((x) => partner.process && samePath(x.process.path, partner.process.path))!;
    assert.equal(iteration(of), iteration(s), `${s.description}: its partner is in its own iteration`);
    assert.doesNotMatch(partner.detail, /iteration i = \d.*iteration i = \d/, 'one candidate, not every iteration\'s');
  }
  assert.equal(cx.cycles?.length, 2, 'one circle per iteration');
  for (const cycle of cx.cycles!) {
    const of = cycle.map((m) => m.process.path.find((s) => s.kind === 'par-for')?.index);
    assert.equal(new Set(of).size, 1, 'a circle never mixes iterations');
  }
});

test('a barrier declared in a par for body is counted per iteration', async () => {
  const { report } = await reportOf(CASES.parForBarrier);
  const cx = failed(report, 'deadlock-free');
  const waiting = cx.final.filter((s) => s.waits?.some((w) => w.operation === 'sync'));
  assert.equal(waiting.length, 2);
  for (const s of waiting) {
    assert.equal(s.process.path.find((x) => x.kind === 'par-for')?.index, 1);
    // Branches 1 and 3 of iteration 1 wait; branch 2 has resigned: 2 of 2 enrolled are waiting.
    assert.match(s.waits![0].detail, /^waits at barrier b \(2 of 2 enrolled processes waiting\)$/);
    assert.match(s.waits![0].partner!.detail, /^branch 2 of iteration i = 1 has ended and resigned from b; in the ProcessJ runtime a resignation never completes a barrier/);
  }
});

test('a barrier that an enrolled process can never reach is stuck for good, and said to be', async () => {
  const { report } = await reportOf(CASES.barrierNever);
  const cx = failed(report, 'deadlock-free');
  const waiting = cx.final.filter((s) => s.waits?.some((w) => w.operation === 'sync'));
  assert.equal(waiting.length, 2);
  for (const s of waiting) {
    const partner = s.waits![0].partner!;
    assert.equal(partner.state, 'missing');
    assert.equal(partner.process?.label, 'branch 3');
    assert.match(partner.detail, /^branch 3, enrolled on b, never syncs on it and resigns only when it ends \(it waits to read c \(line 7\)\): the barrier completes only when every enrolled process has arrived$/);
  }
  assert.equal(cx.cycles, undefined, 'branch 3 waits for nobody at the barrier');
});

test('a partner that has passed its last use of the channel is no partner: no false circle', async () => {
  const { report } = await reportOf(CASES.pastRead);
  const cx = failed(report, 'deadlock-free');
  const writer = cx.final.find((s) => s.waits?.some((w) => w.operation === 'write' && w.channel?.name === 'c'))!;
  const wait = writer.waits![0];
  assert.equal(wait.partner?.state, 'missing');
  assert.equal(wait.partner?.process?.label, 'branch 2', 'the reader it used to have');
  assert.match(wait.partner!.detail, /^branch 2, the only reader of c \(line 5\), never reads c again: its read is behind it \(it waits to read d \(line 5\)\)$/);
  assert.equal(cx.cycles, undefined, 'branch 2 waits for branch 1, but branch 1 does not wait for branch 2');
  assert.match(cx.summary, /^deadlock after 2 steps: branch 1 waits to write 2 on c \(line 4\), but branch 2, the only reader of c/);
});

test('two alt guards on one channel: the one whose precondition holds is taken and waits; temporaries stay out of the text', async () => {
  const { report } = await reportOf(CASES.altPreconditions);
  const cx = failed(report, 'deadlock-free');
  const take = cx.steps.find((s) => s.kind === 'communication')!;
  const reader = take.participants.find((p) => p.role === 'reader')!;
  assert.equal(reader.at?.span.start.line, 10, 'n == 0: the guard on line 11 took the value');
  const stuck = cx.final.find((s) => s.waits?.some((w) => w.operation === 'alt-guard'))!;
  assert.deepEqual(stuck.waits!.map((w) => w.at?.span.start.line), [11], 'n == 1: only the guard on line 12 waits');
  assert.match(stuck.description, /; n = 1$/);
  assert.doesNotMatch(JSON.stringify(cx), /pj_pre/);
  const { model } = modelOf(CASES.altPreconditions);
  assert.deepEqual(fdrDiagnostics(report, model).filter((d) => d.code === 'fdr/deadlock').map((d) => d.span.start.line), [11]);
});

test('a write that waits forever while other processes keep running: a partial deadlock, on that write', async () => {
  const { report, model } = await reportOf(CASES.partial);
  assert.equal(report.checks.find((c) => c.id === 'deadlock-free')?.status, 'passed', 'the program as a whole never stops');
  const cx = failed(report, 'terminates');
  assert.equal(cx.kind, 'no-termination');
  assert.equal(cx.loopStart, 1);
  // One fork starts all three branches together: no run leaves the writer unstarted.
  assert.match(cx.steps[0].description, /^main starts ticker, sink and branch 3 \(par at line 5\)$/);
  const writer = byLabel(cx, 'branch 3');
  assert.equal(writer.status, 'blocked');
  assert.deepEqual(writer.waits?.map((w) => [w.operation, w.channel?.name, w.partner?.state, w.partner?.detail]), [['write', 'c', 'missing', 'nothing in the program reads c']]);
  assert.deepEqual(['ticker(a.write)', 'sink(a.read)'].map((l) => byLabel(cx, l).status), ['running', 'running']);
  assert.match(cx.summary, /^branch 3 waits to write on c \(line 8\) forever: nothing in the program reads c, while ticker and sink run forever \(the steps from 2 on repeat\)$/);
  // Nothing reads c in any run: the writer is stuck for good, and so is main, whose par waits for it (and for the
  // two branches that keep running): the branch that can never finish is its partner.
  assert.equal(stuckForGood(writer, cx), true);
  const main = byLabel(cx, 'main');
  assert.equal(main.waits?.[0].detail, 'waits at its par for ticker, sink and branch 3 to finish');
  assert.deepEqual([main.waits?.[0].partner?.state, main.waits?.[0].partner?.process?.label], ['blocked-elsewhere', 'branch 3']);
  assert.equal(main.waits?.[0].partner?.detail, 'branch 3 waits to write on c (line 8); ticker keeps running (line 1); sink keeps running (line 2)');
  assert.equal(stuckForGood(main, cx), true);
  const told = story(cx, report.checks.find((c) => c.id === 'terminates')!);
  assert.ok(told.includes('branch 3 is stuck at line 8 writing c: nothing in the program reads c.'), told.join('\n'));
  assert.ok(told.some((l) => /^main is stuck at line 5 \(waiting at its par for ticker, sink and branch 3 to finish\)/.test(l)), told.join('\n'));
  // The check hides every event (SKIP [FD= MAIN \ Events) only to ask whether the program ends: the steps on
  // main's own channel a were seen outside like any other, the start of the par was not.
  assert.deepEqual(cx.steps.map((s) => [s.kind, s.channel?.name, s.visible]), [['internal', undefined, false], ['communication', 'a', true]]);
  const [diagnostic] = fdrDiagnostics(report, model).filter((d) => d.code === 'fdr/partial-deadlock');
  assert.deepEqual([diagnostic?.severity, diagnostic?.span.start.line], ['error', 7]);
  assert.match(diagnostic.message, /^FDR: this write waits forever while ticker and sink keep running: nothing in the program reads c \(a run that never ends, after 2 steps\)$/);
  assert.equal(lensVerdict(report), 'FDR: partial deadlock (2 steps)');
});

test('a par for whose bound arrives as an argument: iterations past it never appear', async () => {
  const { report } = await reportOf(CASES.computedBounds);
  const cx = failed(report, 'deadlock-free');
  const iterations = cx.final.filter((s) => s.process.path.some((x) => x.kind === 'par-for')).map((s) => s.process.path[s.process.path.length - 1].index);
  assert.deepEqual(iterations, [0, 1], 'only i = 0 and i = 1 run: the slots for the other modelled integers are not processes of this run');
  const fork = cx.steps.find((s) => s.event.startsWith('pj_fork_work_'))!;
  assert.match(fork.description, /^work starts iteration i = 0 and iteration i = 1 \(par for at line 2\)$/);
  assert.equal(fork.participants.length, 3, 'work and its two iterations');
});

test('a checked procedure\'s own channels are hidden from divergence and determinism', async () => {
  const live = await reportOf(CASES.livelock);
  const cx = failed(live.report, 'divergence-free');
  assert.equal(cx.kind, 'divergence');
  assert.deepEqual(cx.final.filter((s) => s.status === 'diverging').map((s) => s.process.label), ['branch 1', 'branch 2']);
  assert.match(live.model.text, /\nassert \(chatter \\ PJ_LOCAL\) :\[divergence free\]\n/);
  const race = await reportOf(CASES.race);
  const nd = failed(race.report, 'deterministic');
  // What the caller sees (out) depends on which of the two internal writers the alt meets.
  assert.match(nd.summary, /^nondeterministic at the start: whether race can write [12] on out depends on an internal step/);
  assert.ok(nd.steps.every((s) => !s.visible || s.channel?.name === 'out'), 'the procedure\'s own channels are not visible');
});

test('your own assertions: a commented-out one is not one, negations are explained, termination is not a defect', async () => {
  const { report, model } = await reportOf(CASES.userAssertions);
  assert.deepEqual(model.assertions.filter((a) => a.at).map((a) => [a.id, a.assertion, a.property, !!a.negated]), [
    ['user-1', 'MAIN :[deadlock free [F]]', 'deadlock-free', false],
    ['user-2', 'not MAIN :[deadlock free [F]]', 'custom', true],
    ['block-1', 'not MAIN :[has trace]: <c.1>', 'custom', true],
  ]);
  const plain = report.checks.find((c) => c.id === 'user-1')!;
  assert.equal(plain.status, 'failed');
  assert.equal(plain.severity, 'info', 'FDR counts termination as deadlock: the program has no defect');
  assert.match(plain.message!, /^the program terminates after \d+ steps, and FDR counts successful termination as a deadlock; the generated check PJ_NOERR\(MAIN\) :\[deadlock free \[F\]\] tells the two apart$/);
  const negated = report.checks.find((c) => c.id === 'user-2')!;
  assert.equal(negated.status, 'passed');
  assert.match(negated.message!, /^holds: MAIN :\[deadlock free \[F\]\] does not \(the program terminates/);
  assert.equal(negated.counterexample?.kind, 'deadlock', 'the witness FDR found');
  const trace = report.checks.find((c) => c.id === 'block-1')!;
  assert.deepEqual([trace.status, trace.message], ['failed', 'does not hold: MAIN :[has trace]: <c.1> holds (3 states)']);
  // The plain one is informational; the failing has-trace negation is what the lens shows.
  assert.equal(lensVerdict(report), 'FDR: not MAIN :[has trace]: <c.1> fails');
});

test('results are matched to assertions by their text: a missing or an extra one never shifts the others', () => {
  const assertion = (id: string, text: string) => ({ id, index: 0, property: 'custom' as const, label: text, severity: 'error' as const, target: { kind: 'program' as const, name: 'main' }, assertion: text });
  const result = (text: string, passed: boolean) => ({ assertion: text, passed, errors: [], counterexamples: [] });
  const asserts = [assertion('a', 'PJ_NOERR(MAIN) :[deadlock free [F]]'), assertion('b', 'SKIP [FD= (MAIN \\ Events)'), assertion('c', 'MAIN [T= MAIN')];
  // FDR reprints without the parentheses; an included file's assertion comes in between; the last is missing.
  const matched = matchResults(asserts, [result('PJ_NOERR(MAIN) :[deadlock free [F]]', true), result('OTHER [T= MAIN', false), result('SKIP [FD= MAIN \\ Events', false)]);
  assert.deepEqual(matched.map((r) => r?.passed), [true, false, undefined]);
  assert.deepEqual(blockAssertions('SPEC = a -> SPEC\n{- off:\nassert OLD [T= MAIN\n-}\n-- assert NOT [T= MAIN\nassert SPEC [T=\n    MAIN\nassert MAIN :[deadlock free]'), ['SPEC [T= MAIN', 'MAIN :[deadlock free]']);
});

test('an error in your own CSPm is reported at your line of the specification, not on the program', () => {
  const c: Case = { name: 'spec_error', source: ['/*@csp', 'assert MAIN [T= FOO', '*/', 'public void main(string[] args) { chan<int> c; par { c.write(1); int x = c.read(); } }'].join('\n') };
  const { model, uri } = modelOf(c);
  const block = model.sourceMap.user[0];
  assert.equal(block.sourceLine, 1, 'the block\'s first line is the line after /*@csp');
  const line = model.text.split('\n').findIndex((l) => l === 'assert MAIN [T= FOO') + 1;
  assert.equal(line, block.line);
  const run: FdrRun = { results: [], errors: [`./spec_error.csp:${line}:17-20: FOO is not in scope`], warnings: [], eventMap: {}, timedOut: false, aborted: false, exitCode: 1, durationMs: 5, stderr: '' };
  const report = explain(model, run, { uri });
  assert.ok(report.checks.every((x) => x.status === 'error' && x.message === 'FDR could not check this: your CSPm specification has an error (line 2): FOO is not in scope'), report.checks.map((x) => x.message).join('\n'));
  const diagnostics = fdrDiagnostics(report, model, run);
  assert.deepEqual(diagnostics.map((d) => [d.code, d.severity, d.span.start.line, d.message]), [['fdr/spec-error', 'error', 1, 'FDR: error in your CSPm specification: FOO is not in scope']]);
  // An error anywhere else is the translator's.
  const other = explain(model, { ...run, errors: [`./spec_error.csp:3:1-2: something`] }, { uri });
  assert.match(other.checks[0].message!, /^FDR rejected the generated model \(a bug in the translation to CSP; please report it with this file\): something$/);
});

test('with //@csp compress, a process inside a compressed part is said to be so, and the story is told by the others', async () => {
  const { report } = await reportOf(CASES.compressed);
  const cx = failed(report, 'deadlock-free');
  const hidden = cx.final.filter((s) => s.status === 'unknown');
  assert.ok(hidden.length > 0);
  for (const s of hidden) assert.match(s.description, /is inside a compressed part of the network \(\/\/@csp compress\), so the counterexample has no state of its own for it$/);
  assert.doesNotMatch(cx.summary, /no behaviour of its own|  /);
  assert.doesNotMatch(JSON.stringify(cx.final.map((s) => s.waits?.map((w) => w.partner?.detail))), /[a-z] {2}[a-z]/);
});

test('fail closed: a model with constructs it cannot express is never checked, so nothing passes', () => {
  const c: Case = { name: 'arrays', source: 'public void main(string[] args) { chan<int>[][] cs = new chan<int>[2][2]; }' };
  const { uri, input } = load(c);
  const model = translateProgram(input);
  assert.ok(model.unsupported.length);
  const report = explain(model, undefined, { uri });
  assert.ok(report.checks.length >= 3);
  assert.ok(report.checks.every((check) => check.status === 'skipped' && /^not checked: the model is incomplete \(arrays of channels/.test(check.message ?? '')));
  assert.ok(report.assumptions.some((a) => a.startsWith('Not modelled')));
  assert.equal(lensVerdict(report), 'FDR: not modelled');
  const diagnostics = fdrDiagnostics(report, model);
  assert.ok(diagnostics.some((d) => d.code === 'fdr/not-modelled' && d.severity === 'warning'));
});

test('without FDR every check is skipped with the reason', () => {
  const { model, uri } = modelOf(CASES.crossed);
  const report = explain(model, undefined, { uri, notRun: 'FDR (its refines command) was not found' });
  assert.ok(report.checks.every((c) => c.status === 'skipped' && c.message === 'FDR (its refines command) was not found'));
});

test('a type error in the model, a timeout and a cancellation are reported as such', () => {
  const { model, uri } = modelOf(CASES.crossed);
  const base: FdrRun = { results: [], errors: [], warnings: [], eventMap: {}, timedOut: false, aborted: false, exitCode: 1, durationMs: 5, stderr: '' };
  assert.ok(explain(model, { ...base, errors: ['x.csp:3:1: type error'] }, { uri }).checks.every((c) => c.status === 'error' && /type error/.test(c.message ?? '')));
  assert.ok(explain(model, { ...base, timedOut: true, durationMs: 120_000 }, { uri }).checks.every((c) => c.status === 'timeout' && /^FDR did not finish within 120 s: the model may have more states than FDR can explore in that time\. Check one procedure at a time, add \/\/@csp compress/.test(c.message ?? '')));
  assert.ok(explain(model, { ...base, aborted: true }, { uri }).checks.every((c) => c.status === 'cancelled'));
  // Stopped by the memory watchdog: not a timeout of the clock, and the lens says which.
  const memory = explain(model, { ...base, memoryExceeded: 9 * 1024 ** 3 }, { uri });
  assert.ok(memory.checks.every((c) => c.status === 'timeout' && /^FDR was stopped after using more than 9\.0 GB of memory/.test(c.message ?? '')), memory.checks.map((c) => c.message).join('\n'));
  assert.equal(lensVerdict(memory), 'FDR: out of memory');
  // A model FDR rejects outside the user's own CSPm is the translator's bug, and says so.
  assert.match(explain(model, { ...base, errors: ['./x.csp:3:1-2: Couldn\'t match expected type'] }, { uri }).checks[0].message!, /^FDR rejected the generated model \(a bug in the translation to CSP; please report it with this file\): Couldn't match expected type$/);
});

// ---------------------------------------------------------------------------
// What editors show
// ---------------------------------------------------------------------------

test('diagnostics sit on the stuck statements, say who cannot answer, and link the rest of the circle', async () => {
  const { report, model } = await reportOf(CASES.crossed);
  const diagnostics = fdrDiagnostics(report, model);
  assert.deepEqual(diagnostics.map((d) => [d.code, d.severity, d.span.start.line + 1, d.span.start.col + 1]), [['fdr/deadlock', 'error', 12, 13], ['fdr/deadlock', 'error', 17, 13]]);
  assert.equal(diagnostics[0].message, 'FDR: this write waits forever: branch 2, the only reader of c (line 18), waits to write 2 on d (line 17) (deadlock after 1 step)');
  assert.deepEqual(diagnostics[0].related.map((r) => [r.span.start.line + 1, r.message]), [[17, 'branch 2 waits to write 2 on d (line 17)']]);
  const ended = await reportOf(CASES.readerEnded);
  const write = fdrDiagnostics(ended.report, ended.model).find((d) => d.span.start.line === 24)!;
  assert.match(write.message, /^FDR: this write waits forever: consume, the only reader of a \(line 35\), has already terminated/);
  assert.ok(write.related.some((r) => /^step \d+: branch 1 of delta writes 3 on a/.test(r.message)), 'the last steps the stuck process took');
  const range = await reportOf(CASES.range);
  assert.deepEqual(fdrDiagnostics(range.report, range.model).map((d) => [d.code, d.severity, d.span.start.line + 1]), [['fdr/range', 'warning', 5]]);
  assert.match(fdrDiagnostics(range.report, range.model)[0].message, /not an error of the program: give it more integers with \/\/@csp int lo\.\.hi$/);
  const spin = await reportOf(CASES.spin);
  assert.deepEqual(fdrDiagnostics(spin.report, spin.model).map((d) => [d.code, d.severity]), [['fdr/divergence', 'warning']]);
  const choosy = await reportOf(CASES.choosy);
  assert.deepEqual(fdrDiagnostics(choosy.report, choosy.model).map((d) => [d.code, d.severity, d.span.start.line]), [['fdr/nondeterminism', 'info', 0]]);
});

test('the text report has a results table and every counterexample step by step', async () => {
  const { report, model } = await reportOf(CASES.crossed);
  const text = formatFdrReport(report, { fileName: 'par_deadlock.pj', model, cspFile: '/tmp/par_deadlock.csp' });
  assert.match(text, /^# FDR check: par_deadlock\.pj\n/);
  assert.match(text, /\n\| Deadlock freedom \| ✗ deadlock after 1 step \| 2 \| 2 \| {2}\|\n/);
  assert.match(text, /\n\| No runtime errors \| ✓ no runtime error in 2 states \|/);
  assert.match(text, /\n\| Terminates \(informational\) \| ✗ /);
  assert.match(text, /\n### Where every process ends up\n\n- \*\*blocked\*\*: main waits at its par for branch 1 and branch 2 to finish \(line 10\)\n/);
  assert.match(text, /\n### Circular waits\n\n- branch 1 -\(c\)-> branch 2 -\(d\)-> branch 1\n/);
  assert.match(text, /\n1\. \*main starts branch 1 and branch 2 \(par at line 10\)\*\n/);
  assert.match(text, /\n## What the model assumes\n/);
  assert.equal(lensVerdict(report), 'FDR: deadlock (1 step)');
});

test('short names for processes, unique within a program', () => {
  const santa = loadProgram(path.join(ROOT, 'test', 'fixtures', 'processj', 'santa.pj'), INCLUDE);
  const model = translateProgram({ units: santa.units, index: santa.index });
  const names = processNames(model, santa.units[0].uri).filter((n): n is string => !!n);
  assert.ok(names.includes('santa'));
  assert.ok(names.includes('reindeer(0, …)') && names.includes('reindeer(2, …)'));
  assert.ok(names.includes('elf(3, …)'));
  assert.equal(new Set(names).size, names.length);
});

test('FDR state names split into a definition and its arguments', () => {
  assert.deepEqual(parseState('delta__24_join1(1, d, 4, main__par42_1__end(1))'), { name: 'delta__24_join1', args: ['1', 'd', '4', 'main__par42_1__end(1)'] });
  assert.deepEqual(parseState('main__10(1, pj_end -> SKIP)'), { name: 'main__10', args: ['1', 'pj_end -> SKIP'] });
  assert.deepEqual(parseState('f(<1, 2>, Point.1.2, (3, 4))'), { name: 'f', args: ['<1, 2>', 'Point.1.2', '(3, 4)'] });
  assert.deepEqual(parseState('STOP'), { name: 'STOP', args: [] });
});

test('refines is found through the setting, FDR_HOME and PATH', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-refines-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const exe = path.join(bin, process.platform === 'win32' ? 'refines.exe' : 'refines');
    fs.writeFileSync(exe, '');
    assert.equal(findRefines(exe), exe);
    assert.equal(findRefines(dir), exe, 'an install directory works too');
    assert.equal(findRefines(path.join(dir, 'missing')), undefined, 'an explicit setting is the only candidate');
    assert.equal(findRefines(undefined, { FDR_HOME: dir, PATH: '' }), exe);
    assert.equal(findRefines(undefined, { PATH: bin }), exe);
    assert.equal(findRefines(path.basename(exe), { PATH: bin }), exe, 'a bare command name is looked up on PATH');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// With FDR
// ---------------------------------------------------------------------------

test('FDR: the recorded answers are still what refines says, counterexample for counterexample', { skip: NO_FDR }, async () => {
  for (const c of Object.values(CASES)) {
    const { model, uri } = modelOf(c);
    // One worker, as the recordings: the same counterexamples, so the same explanations (a determinism or a
    // termination counterexample can still differ: those searches vary even with one worker).
    const live = await checkWithFdr({ ...load(c).input, model, uri, refines, timeoutMs: 60_000, workers: 1 });
    const stored = explain(model, await recorded(c, model), { uri });
    const shown = (x: VerificationReport['checks'][number]) => [x.status, x.property === 'deterministic' || x.property === 'terminates' ? undefined : x.counterexample?.summary];
    assert.deepEqual(live.report.checks.map(shown), stored.checks.map(shown), `${c.name}: re-record with PJ_RECORD_FDR=1`);
  }
});

test('FDR: checkWithFdr translates, runs and explains in one call, with progress per assertion', { skip: NO_FDR }, async () => {
  const c: Case = { name: 'commstime_small', source: COMMSTIME };
  const { input, uri } = load(c);
  const progress: string[] = [];
  const result = await checkWithFdr({ ...input, uri, refines, timeoutMs: 60_000, onProgress: (done, total, label) => progress.push(`${done}/${total} ${label}`) });
  assert.deepEqual(result.report.checks.map((x) => [x.id, x.status]), [['deadlock-free', 'passed'], ['no-runtime-errors', 'passed'], ['terminates', 'passed']]);
  assert.deepEqual(progress, ['1/3 Deadlock freedom', '2/3 No runtime errors', '3/3 Terminates']);
  assert.ok(result.report.checks.every((x) => (x.stats?.states ?? 0) > 0 && x.stats?.ms !== undefined));
  assert.equal(lensVerdict(result.report).startsWith('FDR: no deadlock, '), true);
  assert.equal(result.cspFile, undefined, 'the private model is removed afterwards');
});

test('FDR: a cancelled check stops refines and says so', { skip: NO_FDR }, async () => {
  const santa = loadProgram(path.join(ROOT, 'test', 'fixtures', 'processj', 'santa.pj'), INCLUDE);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const started = Date.now();
  const result = await checkWithFdr({ units: santa.units, index: santa.index, uri: santa.units[0].uri, refines, signal: controller.signal });
  assert.ok(Date.now() - started < 5_000, 'refines is killed at once');
  assert.ok(result.report.checks.every((x) => x.status === 'cancelled' || x.status === 'passed'));
  assert.ok(result.report.checks.some((x) => x.status === 'cancelled'));
});

// ---------------------------------------------------------------------------
// Through the server
// ---------------------------------------------------------------------------

test('server: Check with FDR puts the deadlock on both blocked writes; Convert to CSP writes the model next to the file', { skip: NO_FDR }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-fdr-lsp-'));
  const file = path.join(dir, 'par_deadlock.pj');
  fs.writeFileSync(file, CASES.crossed.source);
  const client = new Client();
  try {
    const uri = pathToFileURL(file).toString();
    await client.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(dir).toString(),
      capabilities: { window: { showDocument: { support: true }, workDoneProgress: true }, textDocument: { publishDiagnostics: { relatedInformation: true } } },
      initializationOptions: { installDir: path.join(dir, 'no-processj'), fdrPath: refines },
    });
    client.notify('initialized', {});
    client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'processj', version: 1, text: CASES.crossed.source } });
    await client.waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri);
    const before = await client.request('textDocument/codeLens', { textDocument: { uri } });
    assert.ok(before.result.some((l: any) => l.command.title === 'FDR: check program & show graph' && l.command.command === 'processj.checkWithFdr'));

    const checked = await client.request('workspace/executeCommand', { command: 'processj.checkWithFdr', arguments: [uri] }, 60_000);
    assert.equal(checked.error, undefined);
    const result = checked.result as { reportFile: string; jsonFile: string; cspFile: string; report: VerificationReport };
    assert.equal(result.cspFile, path.join(dir, 'par_deadlock.csp'));
    assert.match(fs.readFileSync(result.cspFile, 'utf8'), /^-- Generated by processj-lsp from par_deadlock\.pj\./);
    assert.match(fs.readFileSync(result.reportFile, 'utf8'), /^# FDR check: par_deadlock\.pj\n/);
    assert.deepEqual(JSON.parse(fs.readFileSync(result.jsonFile, 'utf8')).checks.map((c: any) => c.status), ['failed', 'passed', 'failed']);
    const cx = result.report.checks[0].counterexample!;
    assert.deepEqual(cx.final.map((s) => [s.process.label, s.status, line(s)]), [['main', 'blocked', 10], ['branch 1', 'blocked', 12], ['branch 2', 'blocked', 17]]);
    assert.deepEqual(cx.cycles?.[0].map((m) => m.process.label), ['branch 1', 'branch 2']);

    const published = await client.waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri && m.params.diagnostics.some((d: any) => d.source === 'fdr'));
    const fdr = published.params.diagnostics.filter((d: any) => d.source === 'fdr');
    assert.deepEqual(fdr.map((d: any) => [d.code, d.severity, d.range.start.line + 1, d.range.start.character + 1, d.range.end.character + 1]), [['fdr/deadlock', 1, 12, 13, 23], ['fdr/deadlock', 1, 17, 13, 23]]);
    assert.match(fdr[0].message, /^FDR: this write waits forever: branch 2, the only reader of c \(line 18\), waits to write 2 on d \(line 17\)/);
    assert.equal(fdr[0].relatedInformation[0].location.range.start.line, 16);
    // The title names the file: two checks running at once each have their own line.
    assert.ok(client.messages.some((m) => m.method === '$/progress' && m.params.value.kind === 'begin' && /^FDR: checking the program of par_deadlock\.pj$/.test(m.params.value.title)));
    // The graph opens on the result (fdrShowGraph: always); the text report is written beside the model.
    assert.ok(client.messages.some((m) => m.method === 'window/showDocument' && m.params.external === true && /[?&]check=program%2Fdeadlock-free$/.test(m.params.uri)));
    assert.ok(fs.existsSync(result.reportFile));
    const after = await client.request('textDocument/codeLens', { textDocument: { uri } });
    assert.ok(after.result.some((l: any) => l.command.title === 'FDR: deadlock (1 step) · show graph'));
    const stored = await client.request('processj/fdrReport', { textDocument: { uri } });
    assert.deepEqual(stored.result.checks.map((c: any) => c.status), ['failed', 'passed', 'failed']);

    // `main` by name is the whole program; a .csp the user wrote is never overwritten.
    fs.writeFileSync(path.join(dir, 'par_deadlock.csp'), '-- my own model\n');
    const converted = await client.request('workspace/executeCommand', { command: 'processj.convertToCsp', arguments: [uri, 'main'] });
    assert.notEqual(converted.result.cspFile, path.join(dir, 'par_deadlock.csp'));
    assert.equal(fs.readFileSync(path.join(dir, 'par_deadlock.csp'), 'utf8'), '-- my own model\n');
    assert.ok(!fs.existsSync(path.join(dir, 'par_deadlock.main.csp')), 'main is the program, not a procedure of its own');
    assert.ok(client.messages.some((m) => m.method === 'window/showMessage' && /was not generated by processj-lsp, so it was left alone/.test(m.params.message)));

    // Editing the file clears what FDR said about the old text.
    client.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: `${CASES.crossed.source}\n` }] });
    const edited = await client.waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri && m.params.version === 2);
    assert.equal(edited.params.diagnostics.filter((d: any) => d.source === 'fdr').length, 0);
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('server without FDR: Convert to CSP works, its guard holds, Check with FDR says what is missing, no FDR lens', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-fdr-nofdr-'));
  const file = path.join(dir, 'par_deadlock.pj');
  fs.writeFileSync(file, CASES.crossed.source);
  const client = new Client();
  try {
    const uri = pathToFileURL(file).toString();
    const missing = path.join(dir, 'no-fdr', 'refines');
    await client.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(dir).toString(),
      capabilities: { window: { showDocument: { support: true } } },
      initializationOptions: { installDir: path.join(dir, 'no-processj'), fdrPath: missing },
    });
    client.notify('initialized', {});
    client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'processj', version: 1, text: CASES.crossed.source } });
    await client.waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri);
    const lenses = await client.request('textDocument/codeLens', { textDocument: { uri } });
    assert.ok(!lenses.result.some((l: any) => /^FDR/.test(l.command.title)), 'no FDR lens without refines');
    // Convert writes the model next to the file, and never over a file the user wrote.
    const first = await client.request('workspace/executeCommand', { command: 'processj.convertToCsp', arguments: [uri] });
    assert.equal(first.result.cspFile, path.join(dir, 'par_deadlock.csp'));
    assert.match(fs.readFileSync(first.result.cspFile, 'utf8'), /^-- Generated by processj-lsp from par_deadlock\.pj\./);
    fs.writeFileSync(path.join(dir, 'par_deadlock.csp'), '-- mine\n');
    const second = await client.request('workspace/executeCommand', { command: 'processj.convertToCsp', arguments: [uri] });
    assert.notEqual(second.result.cspFile, path.join(dir, 'par_deadlock.csp'));
    assert.equal(fs.readFileSync(path.join(dir, 'par_deadlock.csp'), 'utf8'), '-- mine\n');
    // Check says where FDR was looked for; there is no report yet; nothing to cancel.
    const checked = await client.request('workspace/executeCommand', { command: 'processj.checkWithFdr', arguments: [uri] });
    assert.equal(checked.result, null);
    assert.ok(client.messages.some((m) => m.method === 'window/showMessage' && m.params.message.includes(`FDR's refines was not found at ${missing}`)));
    assert.equal((await client.request('processj/fdrReport', { textDocument: { uri } })).result, null);
    assert.deepEqual((await client.request('workspace/executeCommand', { command: 'processj.cancelFdr', arguments: [uri] })).result, { cancelled: 0 });
    // A file with a syntax error is refused.
    client.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'public void main( {' }] });
    const refused = await client.request('workspace/executeCommand', { command: 'processj.convertToCsp', arguments: [uri] });
    assert.equal(refused.result, null);
    assert.ok(client.messages.some((m) => m.method === 'window/showMessage' && /fix the syntax errors? first/.test(m.params.message)));
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('server: a check can be cancelled from the editor, a stored report is announced, and a procedure\'s report found by its line', { skip: NO_FDR }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-fdr-cancel-'));
  const santa = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'processj', 'santa.pj'), 'utf8');
  const file = path.join(dir, 'santa.pj');
  fs.writeFileSync(file, santa);
  const client = new Client();
  try {
    const uri = pathToFileURL(file).toString();
    await client.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(dir).toString(),
      capabilities: { window: { showDocument: { support: true }, workDoneProgress: true } },
      // One worker: santa takes seconds, long enough to cancel.
      initializationOptions: { installDir: path.join(dir, 'no-processj'), fdrPath: refines, fdrWorkers: 1 },
    });
    client.notify('initialized', {});
    client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'processj', version: 1, text: santa } });
    await client.waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri);
    const started = Date.now();
    const running = client.request('workspace/executeCommand', { command: 'processj.checkWithFdr', arguments: [uri] }, 60_000);
    await client.waitFor((m) => m.method === '$/progress' && m.params.value.kind === 'report' && /running FDR/.test(m.params.value.message ?? ''), 20_000);
    const cancel = await client.request('workspace/executeCommand', { command: 'processj.cancelFdr', arguments: [uri] });
    assert.deepEqual(cancel.result, { cancelled: 1 });
    assert.equal((await running).result, null);
    assert.ok(Date.now() - started < 20_000);
    assert.ok(client.messages.some((m) => m.method === 'window/showMessage' && /the check of the program was cancelled/.test(m.params.message)));
    // A procedure checked on its own: its report is announced and found by name and line.
    const elf = santa.split('\n').findIndex((l) => /\bvoid elf\(/.test(l));
    const done = await client.request('workspace/executeCommand', { command: 'processj.checkWithFdr', arguments: [uri, 'elf', elf] }, 60_000);
    assert.ok(done.result?.report);
    assert.ok(client.messages.some((m) => m.method === 'processj/fdrReportChanged' && m.params.uri === uri && m.params.target?.name === 'elf'));
    const found = await client.request('processj/fdrReport', { textDocument: { uri }, procedure: 'elf', line: elf });
    assert.equal(found.result?.checks[0].target.name, 'elf');
    assert.equal((await client.request('processj/fdrReport', { textDocument: { uri }, procedure: 'elf', line: elf + 1 })).result, null);
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pj2csp --check never exits 0 for a program it did not check, and leaves no temporary file behind', async () => {
  // Its own temporary directory, to see what it leaves there.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pj2csp-test-'));
  const run = (args: string[]): Promise<number | null> => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'pj2csp.js'), ...args], { stdio: 'ignore', env: { ...process.env, TMPDIR: tmp } });
    child.on('exit', (code) => resolve(code));
  });
  try {
    // Arrays sent on a channel are not modelled: nothing is checked (and without FDR nothing can be).
    assert.equal(await run([path.join(ROOT, 'test', 'fixtures', 'processj', 'arr.pj'), '--check', '--include', INCLUDE]), 2);
    if (refines) assert.equal(await run([path.join(ROOT, 'examples', 'par_deadlock.pj'), '--check', '--include', INCLUDE]), 1);
    // Without --out, FDR ran on a temporary copy of the model, removed afterwards.
    assert.deepEqual(fs.readdirSync(tmp), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('fdr-validate confirms a hang or a failure only where nothing else can explain it', () => {
  // scripts/fdr-validate.js is plain JavaScript; it loads the built translator from dist/.
  const { judge } = require('../../scripts/fdr-validate.js') as { judge(verdict: object, real: object | undefined, lints: Set<string>): string };
  const deadlock = { deadlock: 'failed', errors: 'passed', terminates: 'failed', range: false, caveats: [] };
  const hangs = { status: 'hangs' };
  assert.equal(judge(deadlock, hangs, new Set()), 'CONFIRMED');
  // break_after_nested_for.pj: the consumer's NullPointerException (compiler/loop-labels) leaves the producer
  // waiting, which is no deadlock of the language; a program that threw and then hung has failed.
  const threw = { status: 'hangs', exception: 'Exception in thread "Thread-0" java.lang.NullPointerException' };
  assert.equal(judge(deadlock, threw, new Set(['compiler/loop-labels'])), 'language');
  assert.equal(judge(deadlock, threw, new Set()), 'MISMATCH', 'an exception FDR does not predict');
  assert.equal(judge({ ...deadlock, errors: 'failed' }, threw, new Set()), 'CONFIRMED', 'a runtime error FDR found');
  // Where the report says the program may differ from the model, a hang FDR predicts may come from that instead.
  assert.equal(judge(deadlock, hangs, new Set(['pj/par-for-body'])), 'language');
  assert.equal(judge(deadlock, hangs, new Set(['model/aliasing'])), 'abstraction');
  // A lint the model follows as the compiled program does, or an abstraction of time, does not.
  assert.equal(judge(deadlock, hangs, new Set(['pj/timeout-deadline', 'pj/channel-direction'])), 'CONFIRMED');
  // No deadlock and termination, and the program finishes: that is what FDR says, whatever the lints.
  assert.equal(judge({ deadlock: 'passed', errors: 'passed', terminates: 'passed', range: false, caveats: [] }, { status: 'finishes' }, new Set(['pj/par-for-body'])), 'CONFIRMED');
});

/** A small LSP client over stdio, answering the server's own requests. */
class Client {
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private readonly waiting = new Map<number, (message: any) => void>();
  readonly messages: any[] = [];
  readonly child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js'), '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
  readonly sent = new Set<string>();

  constructor() {
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        const end = this.buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const length = Number(/Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, end).toString())?.[1] ?? 0);
        if (this.buffer.length < end + 4 + length) return;
        const message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + length).toString());
        this.buffer = this.buffer.subarray(end + 4 + length);
        if (message.id !== undefined && !message.method && this.waiting.has(message.id)) {
          this.waiting.get(message.id)!(message);
          this.waiting.delete(message.id);
        } else if (message.method) {
          this.messages.push(message);
          if (message.id !== undefined) this.send({ jsonrpc: '2.0', id: message.id, result: message.method === 'window/showDocument' ? { success: true } : null });
        }
      }
    });
  }

  request(method: string, params: unknown, timeoutMs = 10_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), timeoutMs);
      this.waiting.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  async waitFor(predicate: (message: any) => boolean, timeoutMs = 10_000): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.messages.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('timed out waiting for a message from the server');
  }

  /** Shut the server down the LSP way (it removes its report directory), then make sure it is gone. */
  /** Shut the server down the LSP way and wait for it to exit (it removes its report directory and sandboxes on the way out). */
  close(): Promise<void> {
    return stopServer(this);
  }

  private send(message: unknown): void {
    const { method } = message as { method?: string };
    if (method === 'shutdown' || method === 'exit') this.sent.add(method);
    const json = JSON.stringify(message);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
  }
}
