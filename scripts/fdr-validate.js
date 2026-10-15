#!/usr/bin/env node
/**
 * Corpus validation of ProcessJ -> CSP -> FDR: translate every program (from
 * main), check it with FDR's default assertions, build and run the real
 * program with a timeout, and compare what FDR says with what the program does.
 *
 *   node scripts/fdr-validate.js                  test/fixtures/processj, test/differential, examples
 *   node scripts/fdr-validate.js dir file.pj ...  those files and the .pj files of those directories
 *   --timeout <seconds>     FDR time per program (default 60)
 *   --run-timeout <ms>      how long a real program may run before it counts as hanging (default 4000)
 *   --no-run                do not build and run the programs: compare with their recorded outcomes only
 *   --include <dir>         ProcessJ include directory (default: the configured install, else the fixtures')
 *   --markdown              print the table as Markdown at the end (as in docs/DETAILS.md); the rows go to stderr
 *   --procedures            check every procedure with a body (but main) on its own instead, as
 *                           "Check with FDR" on that procedure does: a row per procedure with each
 *                           check's verdict, not modelled (and why), or FDR rejecting the model
 *
 * What a program really does comes from running it (needs a ProcessJ install,
 * see README) or, without a run, from its `// outcome:` header
 * (test/differential) or an example's `// expect:` line naming a blocking lint.
 * Each row gets a result:
 *
 *   CONFIRMED    FDR's verdict is what the program does: a deadlock and the program hangs,
 *                deadlock-free and terminating and it finishes, deadlock-free and running
 *                forever and it is still running at the timeout, a runtime error and it fails.
 *                A program that printed an exception and then hung has failed (a process
 *                stopped with an error and the others wait for it), which is no deadlock
 *   language     the model follows the language and the translation names why the compiled
 *                program differs (a lint such as pj/par-for-body or pj/shared-unlocked-end, or a
 *                miscompilation the translator names, such as compiler/loop-labels); also when
 *                the program hangs or fails as FDR says, but where the report itself says the
 *                compiled program may differ: it may hang or fail for that reason instead
 *   abstraction  the counterexample relies on what the model abstracts (an alt taking a skip or
 *                timeout guard, an abstract value), as its caveats say; this run avoided it. Also
 *                where the program shares an array or record between references (model/aliasing)
 *   range limit  a value leaves the modelled integers: not an error of the program, and the other
 *                verdicts cover the runs up to that point
 *   not built    the compiler rejects the program; FDR's verdict is about the language only
 *   not modelled, does not parse, no main, too big (FDR timed out)
 *   MISMATCH     none of the above: a translator or explanation bug to investigate
 *
 * A model FDR rejects is always a translator bug. The exit code is 1 when a
 * row is a MISMATCH or a model is rejected. Run `npm run build` first.
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { findInstall } = require('../dist/src/config.js');
const { build, run } = require('../dist/src/pipeline.js');
const { loadProgram } = require('../dist/src/csp/load.js');
const { translateProgram, translateProcedure, findRefines, refinesNotFoundMessage, checkWithFdr } = require('../dist/src/csp/index.js');
const { COMPILED_DIFFERS, MODEL_DIFFERS } = require('../dist/src/csp/explain.js');

const ROOT = path.join(__dirname, '..');
/**
 * Where this ProcessJ build does not do what the language says (the model follows the language):
 * the checker's lints, and the miscompilations the translator names itself (`compiler/...`).
 */
const DIFFERS = new Set([
  'pj/par-for-body', 'pj/shared-unlocked-end', 'pj/timeout-deadline', 'pj/multiple-alts', 'pj/compiler-limit', 'pj/starving-loop',
  'pj/shared-channel-end', 'pj/channel-direction', 'pj/parallel-usage',
  'compiler/loop-labels', 'compiler/par-loop-calls', 'compiler/stop-ignored', 'compiler/short-circuit-read', 'compiler/replicated-alt-precondition', 'compiler/labelled-break',
  'compiler/empty-par-for',
]);
/** Where the model's own abstraction may make it differ from the program (an array or record shared between references). */
const ABSTRACTS = new Set(['model/aliasing']);
/** An example whose `// expect:` line names one of these hangs. */
const BLOCKING = ['pj/par-deadlock', 'pj/channel-no-writer', 'pj/channel-no-reader', 'pj/channel-self-deadlock', 'pj/starving-loop'];

// The options, set from the command line by main().
let timeout = 60;
let runTimeout = 4000;
let runPrograms = true;
let markdown = false;
let include;
let install;
let refines;

/** What FDR says about a program, from its report. */
function fdrVerdict(model, result) {
  const checks = result.report.checks;
  const by = (property) => checks.find((c) => c.property === property);
  const deadlock = by('deadlock-free');
  const errors = by('no-runtime-errors');
  const terminates = by('terminates');
  const line = (ref) => (ref ? `L${ref.span.start.line + 1}` : '');
  const v = {
    deadlock: deadlock?.status,
    errors: errors?.status,
    terminates: terminates?.status,
    states: deadlock?.stats?.states,
    ms: result.rawResults?.durationMs,
    // FDR rejects a model either as a whole (rawResults.errors) or per check (status 'error', e.g. an
    // evaluation error such as an invalid event or a pattern-match failure).
    rejected: result.rawResults?.errors.length ? result.rawResults.errors[0].split('\n')[0] : checks.find((c) => c.status === 'error')?.message?.split('\n')[0] || (checks.some((c) => c.status === 'error') ? 'FDR could not evaluate a check' : undefined),
    timedOut: checks.some((c) => c.status === 'timeout'),
    range: errors?.status === 'failed' && errors.counterexample?.error?.kind === 'range',
    caveats: [],
    summary: '',
    says: '',
  };
  const failed = [deadlock, errors, terminates].filter((c) => c?.status === 'failed');
  // Caveats naming a lint or a miscompilation say where the compiled program differs; the rest are abstractions.
  for (const c of failed) for (const caveat of c.counterexample?.caveats ?? []) if (!v.caveats.includes(caveat) && !/^(pj|compiler)\//.test(caveat)) v.caveats.push(caveat);
  // A partial deadlock: no deadlock of the whole program, but the termination check's run leaves a process waiting for good.
  v.partial = !!terminates?.counterexample && terminates.counterexample.loopStart !== undefined && terminates.counterexample.final.some((s) => s.status === 'blocked' && (s.waits ?? []).some((w) => w.operation !== 'other' && (w.partner?.state === 'terminated' || w.partner?.state === 'missing')));
  const first = checks.find((c) => c.status === 'failed' && c.severity !== 'info') ?? checks.find((c) => c.status !== 'passed' && c.status !== 'failed') ?? checks.find((c) => c.status === 'failed');
  v.summary = first?.message ?? '';
  if (v.rejected) v.says = 'model rejected';
  else if (v.timedOut) v.says = 'no answer in time';
  else {
    const parts = [];
    if (deadlock?.status === 'failed') {
      // Where processes are stuck: their waits, or where a process without any (at `stop`) stopped.
      const final = deadlock.counterexample?.final ?? [];
      const stuck = [...new Set(final.flatMap((p) => (p.waits?.length ? p.waits.filter((w) => w.operation !== 'other' && w.at).map((w) => line(w.at)) : p.status === 'blocked' && p.at ? [line(p.at)] : [])))];
      parts.push(`deadlock${stuck.length ? ` (${stuck.slice(0, 4).join(', ')})` : ''}`);
    } else if (deadlock?.status === 'passed') parts.push('no deadlock');
    if (errors?.status === 'failed') {
      const e = errors.counterexample?.error;
      parts.push(`${v.range ? 'integers out of range' : e?.kind ?? 'runtime error'}${e?.at ? ` (${line(e.at)})` : ''}`);
    }
    if (deadlock?.status === 'passed' && errors?.status !== 'failed') parts.push(terminates?.status === 'passed' ? 'terminates' : v.partial ? 'partial deadlock' : terminates?.status === 'failed' ? 'runs forever' : '');
    v.says = parts.filter(Boolean).join(', ');
  }
  void model;
  return v;
}

/** Build and run the real program: finishes, hangs, fails (exit code or exception), or does not build. */
async function realRun(file, text, loaded) {
  const unit = loaded.units[0];
  const empty = new Map();
  const unitOf = new Map();
  for (const u of loaded.units.slice(1)) for (const d of u.program.decls) if (d.kind === 'ProcDecl') unitOf.set(d, u);
  const callProvider = (decl) => {
    if (unit.program.decls.includes(decl)) return undefined;
    const owner = unitOf.get(decl);
    return owner ? { calls: owner.checked.calls, complete: true } : { calls: empty, complete: false };
  };
  const built = await build(install, file, text, { timeoutMs: 120_000, yieldContext: { program: unit.program, index: loaded.index, calls: unit.checked.calls, callProvider } });
  try {
    if (!built.ok) {
      const failed = built.stages.find((s) => !s.ok);
      const crashed = /Exception in thread "main"/.test(failed?.output ?? '');
      return { status: 'not built', detail: crashed ? `${failed?.name} crashed` : `${failed?.name ?? 'build'} fails` };
    }
    const r = await run(install, built, { timeoutMs: runTimeout });
    const out = r.output.split('\n').filter((l) => l && !/^\[Scheduler\]|^Total execution/.test(l));
    const exception = out.find((l) => /Exception|Error:/.test(l));
    if (r.timedOut) return { status: 'hangs', exception: exception?.trim(), detail: `still running after ${runTimeout / 1000} s${exception ? `, ${exception.trim().slice(0, 60)}` : ''}` };
    if (r.exitCode !== 0 || exception) return { status: 'fails', detail: `exit ${r.exitCode}${exception ? `: ${exception.trim().slice(0, 60)}` : ''}` };
    return { status: 'finishes', detail: out.slice(0, 2).join(' | ').slice(0, 60) };
  } finally {
    built.sandbox.cleanup();
  }
}

/** What the program is known to do without running it. */
function recorded(text) {
  const outcome = /^\/\/ outcome:\s*(\S+)/m.exec(text)?.[1];
  const expect = /^\/\/ expect:\s*(.*)$/m.exec(text)?.[1] ?? '';
  switch (outcome) {
    case 'runs':
      return { status: 'finishes', detail: 'recorded: runs' };
    case 'runs-wrong':
      return { status: 'finishes', detail: 'recorded: runs, with a wrong result' };
    case 'deadlocks':
      return { status: 'hangs', detail: 'recorded: deadlocks' };
    case 'error':
    case 'compiler-limit':
      return { status: 'not built', detail: `recorded: ${outcome}` };
    default:
      if (BLOCKING.some((code) => expect.includes(code))) return { status: 'hangs', detail: `expected to hang (${BLOCKING.find((code) => expect.includes(code))})` };
      return undefined;
  }
}

/** The result of a row: does FDR's verdict match the program, and if not, what explains it. */
function judge(v, real, lints) {
  const lint = [...lints].find((c) => DIFFERS.has(c));
  const abstracts = [...lints].some((c) => ABSTRACTS.has(c));
  const explained = (what) => (v.caveats.length || abstracts ? 'abstraction' : lint ? 'language' : what);
  // Where the report itself says the program may differ from the model (it qualifies every verdict
  // so), a hang or a failure as FDR predicts may come from that difference: it confirms nothing.
  const agreed = [...lints].some((c) => COMPILED_DIFFERS.has(c)) ? 'language' : [...lints].some((c) => MODEL_DIFFERS.has(c)) ? 'abstraction' : 'CONFIRMED';
  if (v.rejected) return 'MISMATCH';
  if (v.timedOut) return 'too big';
  if (!real) return v.range ? 'range limit' : 'n/a';
  if (real.status === 'not built') return v.range ? 'range limit' : 'not built';
  const deadlock = v.deadlock === 'failed';
  const error = v.errors === 'failed' && !v.range;
  const forever = v.terminates === 'failed';
  // A program that printed an exception and then hung has failed: a process stopped with an error,
  // and the others wait for it. That is not the deadlock FDR found.
  switch (real.status === 'hangs' && real.exception ? 'fails' : real.status) {
    case 'hangs':
      if (deadlock || forever) return agreed;
      if (v.range) return 'range limit';
      return lint ? 'language' : abstracts ? 'abstraction' : 'MISMATCH';
    case 'fails':
      if (error) return agreed;
      if (v.range) return 'range limit';
      return lint ? 'language' : abstracts ? 'abstraction' : 'MISMATCH';
    case 'finishes':
      if (deadlock || error) return explained('MISMATCH');
      if (v.range) return 'range limit';
      if (forever) return v.caveats.length || abstracts ? 'abstraction' : lint ? 'language' : 'MISMATCH';
      return 'CONFIRMED';
    default:
      return 'MISMATCH';
  }
}

/** Translate, check and run one program: its row of the table. */
async function checkOne(file) {
  const name = path.relative(ROOT, file);
  const text = fs.readFileSync(file, 'utf8');
  const row = { name, says: '', real: '', result: '', note: '' };
  const loaded = loadProgram(file, include);
  if (loaded.syntaxErrors.length) return Object.assign(row, { says: '-', real: '-', result: 'does not parse', note: loaded.syntaxErrors[0] });
  if (!loaded.units[0].program.decls.some((d) => d.kind === 'ProcDecl' && d.name.name === 'main' && d.body)) return Object.assign(row, { says: '-', real: '-', result: 'no main' });
  const input = { units: loaded.units, index: loaded.index };
  const model = translateProgram(input);
  const lints = new Set(model.warnings.map((w) => w.code).filter(Boolean));
  const realPromise = runPrograms ? realRun(file, text, loaded) : Promise.resolve(recorded(text));
  const realText = (real) => (real ? `${real.status}${real.detail ? ` (${real.detail})` : ''}` : '?');
  if (model.unsupported.length) {
    const real = await realPromise;
    return Object.assign(row, { says: 'not modelled', real: realText(real), realStatus: real?.status, realDetail: real?.detail, result: 'not modelled', note: model.unsupported[0].message });
  }
  const [result, real] = await Promise.all([
    // One worker: the same deadlock and runtime-error counterexamples on every run (the table's verdicts do not depend on them).
    checkWithFdr({ ...input, model, uri: pathToFileURL(file).href, refines, timeoutMs: timeout * 1000, workers: 1 }),
    realPromise,
  ]);
  const v = fdrVerdict(model, result);
  Object.assign(row, { says: v.says, real: realText(real), realStatus: real?.status, realDetail: real?.detail, realException: real?.exception, result: judge(v, real, lints), states: v.states, ms: v.ms });
  const why = row.result === 'language'
    ? `the model follows the language: ${[...lints].filter((c) => DIFFERS.has(c)).join(', ')}`
    : row.result === 'abstraction'
      ? `relies on: ${v.caveats[0] ?? [...lints].filter((c) => ABSTRACTS.has(c)).join(', ')}`
      : '';
  row.note = [why, v.summary].filter(Boolean).join('; ');
  return row;
}

/**
 * --procedures: every procedure with a body (but main, which is the program
 * check) checked on its own, as "Check with FDR" on that procedure does. A
 * row per procedure: the verdict of each check, not modelled (with the
 * reason), FDR rejecting the model (always a translator bug), or no answer in
 * time. Nothing is run: a procedure on its own has no real run to compare with.
 */
async function checkProcedures(file) {
  const name = path.relative(ROOT, file);
  const loaded = loadProgram(file, include);
  if (loaded.syntaxErrors.length) return [{ name, procedure: '-', outcome: 'does not parse', note: loaded.syntaxErrors[0] }];
  const input = { units: loaded.units, index: loaded.index };
  const rows = [];
  for (const decl of loaded.units[0].program.decls) {
    if (decl.kind !== 'ProcDecl' || !decl.body || decl.name.name === 'main') continue;
    const row = { name, procedure: `${decl.name.name}:${decl.name.span.start.line + 1}`, outcome: '', note: '' };
    rows.push(row);
    let model;
    try {
      model = translateProcedure(input, decl.name.name, decl.name.span.start);
    } catch (e) {
      Object.assign(row, { outcome: 'crash', note: String(e?.stack ?? e).split('\n').slice(0, 3).join(' ') });
      continue;
    }
    row.instances = model.checkedWith?.text ?? '';
    if (model.unsupported.length) {
      Object.assign(row, { outcome: 'not modelled', note: model.unsupported[0].message });
      continue;
    }
    let result;
    try {
      result = await checkWithFdr({ ...input, model, procedure: { name: decl.name.name, at: decl.name.span.start }, uri: pathToFileURL(file).href, refines, timeoutMs: timeout * 1000, workers: 1 });
    } catch (e) {
      Object.assign(row, { outcome: 'crash', note: String(e?.stack ?? e).split('\n').slice(0, 3).join(' ') });
      continue;
    }
    const checks = result.report.checks;
    const rejected = result.rawResults?.errors.length ? result.rawResults.errors[0].split('\n')[0] : checks.find((c) => c.status === 'error')?.message?.split('\n')[0];
    if (rejected) Object.assign(row, { outcome: 'FDR error', note: rejected });
    else if (checks.some((c) => c.status === 'timeout')) Object.assign(row, { outcome: 'no answer in time', note: checks.find((c) => c.status === 'timeout').message });
    else {
      const short = { 'deadlock-free': 'deadlock', 'divergence-free': 'divergence', 'no-runtime-errors': 'errors', deterministic: 'determinism' };
      row.outcome = 'verdict';
      row.note = checks.map((c) => `${short[c.property] ?? c.id} ${c.status === 'passed' ? 'ok' : c.status === 'failed' ? (c.counterexample?.error?.kind === 'range' ? 'RANGE' : 'FAIL') : c.status}`).join(', ');
    }
  }
  return rows;
}

async function mainProcedures(files) {
  const counts = new Map();
  const all = [];
  const w = (s, n) => String(s).padEnd(n);
  for (const file of files) {
    for (const r of await checkProcedures(file)) {
      all.push(r);
      counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
      console.log(`${w(r.name, 52)} ${w(r.procedure, 26)} ${w(r.outcome, 14)} ${r.note.slice(0, 300)}${r.instances ? `  [${r.instances.slice(0, 160)}]` : ''}`);
    }
  }
  console.log('');
  console.log([...counts].map(([k, n]) => `${n} ${k}`).join(', '));
  const bad = all.filter((r) => r.outcome === 'FDR error' || r.outcome === 'crash');
  if (bad.length) {
    console.log(`\n${bad.length} to investigate:`);
    for (const r of bad) console.log(`  ${r.name} ${r.procedure}: ${r.outcome}: ${r.note}`);
  }
  const missing = all.filter((r) => r.outcome === 'not modelled');
  if (missing.length) {
    console.log(`\n${missing.length} not modelled:`);
    for (const r of missing) console.log(`  ${r.name} ${r.procedure}: ${r.note}`);
  }
  process.exit(bad.length ? 1 : 0);
}

async function main() {
  const args = process.argv.slice(2);
  const inputs = [];
  let procedures = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--timeout') timeout = Number(args[++i]);
    else if (args[i] === '--run-timeout') runTimeout = Number(args[++i]);
    else if (args[i] === '--no-run') runPrograms = false;
    else if (args[i] === '--include') include = args[++i];
    else if (args[i] === '--markdown') markdown = true;
    else if (args[i] === '--procedures') procedures = true;
    else inputs.push(path.resolve(args[i]));
  }
  if (!inputs.length) inputs.push(path.join(ROOT, 'test', 'fixtures', 'processj'), path.join(ROOT, 'test', 'differential'), path.join(ROOT, 'examples'));
  if (procedures) runPrograms = false;
  const found = findInstall();
  install = 'error' in found ? undefined : found;
  if (!include) include = install ? install.includeDir : path.join(ROOT, 'test', 'fixtures', 'include');
  if (runPrograms && !install) {
    console.error(`${found.error}\nThe programs are not run; their recorded outcomes are used instead (--no-run).`);
    runPrograms = false;
  }
  refines = findRefines();
  if (!refines) {
    console.error(refinesNotFoundMessage());
    process.exit(2);
  }
  const files = inputs.flatMap((p) => (fs.statSync(p).isDirectory() ? fs.readdirSync(p).filter((f) => f.endsWith('.pj')).sort().map((f) => path.join(p, f)) : [p]));
  if (procedures) return mainProcedures(files);

  const rows = [];
  const counts = new Map();
  const w = (s, n) => String(s).padEnd(n);
  for (const file of files) {
    const r = await checkOne(file);
    rows.push(r);
    counts.set(r.result, (counts.get(r.result) ?? 0) + 1);
    // With --markdown the table comes at the end; the rows still show progress, on stderr.
    const log = markdown ? console.error : console.log;
    const stats = r.states !== undefined ? `${String(r.states).padStart(9)} st ${String(r.ms ?? '').padStart(6)} ms` : ''.padEnd(22);
    log(`${w(r.name, 56)} ${w(r.result, 15)} ${w(r.says, 40)} ${stats}  real: ${r.real}`);
    if (r.note && r.result !== 'CONFIRMED') log(`${' '.repeat(57)}${r.note.slice(0, 400)}`);
  }

  if (markdown) {
    // One row per program, except the plain cases (confirmed clean, not built and clean, not parsed, no main): one row per directory.
    const plain = (r) => (r.says === 'no deadlock, terminates' && (r.result === 'CONFIRMED' || r.result === 'not built')) || r.result === 'does not parse' || r.result === 'no main';
    const thrown = (r) => /([\w.$]+(?:Exception|Error))\b/.exec(r.realException ?? '')?.[1] ?? 'an exception';
    const realText = (r) => (!r.realStatus ? '-' : r.realStatus === 'not built' ? `does not build (${r.realDetail.replace(/^recorded: /, '')})` : r.realStatus === 'fails' ? `fails (${r.realDetail})` : r.realStatus === 'hangs' && r.realException ? `hangs after ${thrown(r)}` : r.realStatus);
    const saysText = (r) => (r.result === 'not modelled' ? `not modelled: ${r.note}` : r.says);
    console.log('| program | FDR says | real program | result |');
    console.log('| --- | --- | --- | --- |');
    for (const r of rows.filter((x) => !plain(x))) console.log(`| \`${r.name}\` | ${saysText(r)} | ${realText(r)} | ${r.result} |`);
    const groups = new Map();
    for (const r of rows.filter(plain)) {
      const real = r.realStatus === 'not built' ? 'does not build' : (r.realStatus ?? '-');
      const key = [path.dirname(r.name), r.says, real, r.result].join('|');
      groups.set(key, [...(groups.get(key) ?? []), path.basename(r.name)]);
    }
    for (const [key, names] of groups) {
      const [dir, says, real, result] = key.split('|');
      console.log(`| ${dir}/: ${names.map((n) => `\`${n}\``).join(', ')} | ${says} | ${real} | ${result} |`);
    }
  }
  console.log('');
  console.log([...counts].map(([k, n]) => `${n} ${k}`).join(', '));
  const bad = rows.filter((r) => r.result === 'MISMATCH');
  if (bad.length) {
    console.log(`\n${bad.length} to investigate:`);
    for (const r of bad) console.log(`  ${r.name}: FDR says ${r.says}; the program ${r.real}${r.note ? `; ${r.note}` : ''}`);
  }
  process.exit(bad.length ? 1 : 0);
}

// The test of judge() requires this file; run as a script, it checks the corpus.
module.exports = { judge };
if (require.main === module) main();
