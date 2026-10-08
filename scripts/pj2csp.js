#!/usr/bin/env node
/**
 * Translate a ProcessJ file to CSPm, and optionally check it with FDR.
 *
 *   node scripts/pj2csp.js file.pj                 print the CSPm model of the program (from main)
 *   node scripts/pj2csp.js file.pj --proc delta    the model of one procedure with a harness
 *   node scripts/pj2csp.js file.pj --out model.csp write the model to a file
 *   node scripts/pj2csp.js file.pj --int -2..8     model integers as -2..8
 *   node scripts/pj2csp.js file.pj --check         also run FDR's refines and explain its answers
 *   node scripts/pj2csp.js file.pj --check --json  the explained report as JSON (src/verification.ts)
 *   node scripts/pj2csp.js file.pj --map           print the source map as JSON
 *
 * --check runs FDR on a temporary copy of the model, removed afterwards (with
 * --out, on that file, which is kept), then prints the results table and every
 * counterexample step by step: which process is stuck at which statement,
 * waiting for whom. It exits with 1 when a check fails, and with 2 when
 * something was not checked: FDR could not run, a check timed out or erred,
 * or the model is incomplete (fail closed).
 * Options: --timeout <seconds> (default 120), --refines <path to refines>,
 * --workers <n> (refines' BFS workers; default 1, the same deadlock and
 * runtime-error counterexamples on every run; 0: every core), --include <ProcessJ include dir> (default: the
 * configured install, else the test fixtures' std headers). Run `npm run
 * build` first.
 */
const fs = require('node:fs');
const path = require('node:path');
const { findInstall } = require('../dist/src/config.js');
const { loadProgram } = require('../dist/src/csp/load.js');
const { pathToFileURL } = require('node:url');
const { translateProgram, translateProcedure, findRefines, refinesNotFoundMessage, checkWithFdr, formatFdrReport } = require('../dist/src/csp/index.js');

function usage(message) {
  if (message) console.error(message);
  console.error('usage: node scripts/pj2csp.js file.pj [--proc name] [--out file.csp] [--int lo..hi] [--check [--json]] [--map] [--timeout s] [--workers n] [--refines path] [--include dir]');
  process.exit(2);
}

const args = process.argv.slice(2);
const opts = { check: false, map: false, json: false, timeout: 120, workers: 1 };
let file;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const value = () => (i + 1 < args.length ? args[++i] : usage(`${a} needs a value`));
  if (a === '--proc') opts.proc = value();
  else if (a === '--out') opts.out = value();
  else if (a === '--int') opts.int = value();
  else if (a === '--check') opts.check = true;
  else if (a === '--map') opts.map = true;
  else if (a === '--json') opts.json = true;
  else if (a === '--timeout') opts.timeout = Number(value());
  else if (a === '--workers') opts.workers = Number(value());
  else if (a === '--refines') opts.refines = value();
  else if (a === '--include') opts.include = value();
  else if (a === '-h' || a === '--help') usage();
  else if (!file) file = a;
  else usage(`unexpected argument ${a}`);
}
if (!file) usage();
file = path.resolve(file);

let include = opts.include;
if (!include) {
  const install = findInstall();
  include = 'error' in install ? path.join(__dirname, '..', 'test', 'fixtures', 'include') : install.includeDir;
}
let intRange;
if (opts.int) {
  const m = /^(-?\d+)\.\.(-?\d+)$/.exec(opts.int);
  if (!m) usage('--int takes lo..hi, for example 0..7');
  intRange = { lo: Number(m[1]), hi: Number(m[2]) };
}

const loaded = loadProgram(file, include);
if (loaded.syntaxErrors.length) {
  console.error(loaded.syntaxErrors.join('\n'));
  process.exit(1);
}
const input = { units: loaded.units, index: loaded.index, options: intRange ? { intRange } : undefined };
const model = opts.proc ? translateProcedure(input, opts.proc) : translateProgram(input);

const report = (title, list) => {
  if (!list.length) return;
  console.error(`${title}:`);
  for (const d of list) console.error(`  ${d.at ? `line ${d.at.span.start.line + 1}: ` : ''}${d.message}`);
};
report('warnings', model.warnings);
report('not modelled', model.unsupported);

if (opts.map) {
  console.log(JSON.stringify(model.sourceMap, null, 2));
  process.exit(0);
}

// Without --out, --check leaves the model to checkWithFdr, which runs FDR on a private copy and removes it.
const out = opts.out;
if (out) {
  fs.writeFileSync(out, model.text);
  console.error(`wrote ${out}`);
} else if (!opts.check) {
  process.stdout.write(model.text);
}

if (!opts.check) process.exit(model.unsupported.length ? 1 : 0);

(async () => {
  const refines = findRefines(opts.refines);
  if (!refines) {
    console.error(refinesNotFoundMessage(opts.refines));
    process.exit(2);
  }
  if (model.unsupported.length) console.error('The model is incomplete (see "not modelled"): no check is run on it.');
  const started = Date.now();
  const result = await checkWithFdr({
    ...input,
    model,
    uri: pathToFileURL(file).href,
    refines,
    timeoutMs: opts.timeout * 1000,
    workers: opts.workers || undefined,
    cspFile: out,
    onProgress: (done, total, label, r) => console.error(`  ${label}: ${r.passed === true ? 'holds' : r.passed === false ? 'fails' : 'no verdict'} (${done}/${total})`),
  });
  const { report } = result;
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatFdrReport(report, { fileName: path.basename(file), cspFile: out, model, durationMs: Date.now() - started }));
  const failed = report.checks.some((c) => c.status === 'failed' && c.severity !== 'info');
  // Not checked is never "passed": an incomplete model, a check FDR could not finish or decide.
  const unchecked = model.unsupported.length > 0 || report.checks.some((c) => c.status === 'error' || c.status === 'timeout' || c.status === 'skipped' || c.status === 'cancelled');
  // Not process.exit(): a large report piped to another program would be cut short.
  process.exitCode = unchecked ? 2 : failed ? 1 : 0;
})();
