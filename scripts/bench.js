#!/usr/bin/env node
// Prints parse / symbol / lint / format timings for generated files of several sizes.
// Usage: npm run build && node scripts/bench.js [lines ...]
const { bigProgram } = require('../dist/test/big-program.js');
const { parse } = require('../dist/src/parser/parser.js');
const { astSymbols } = require('../dist/src/astsymbols.js');
const { check } = require('../dist/src/checker/checker.js');
const { DeclIndex } = require('../dist/src/checker/index.js');
const { semanticTokens } = require('../dist/src/semantic.js');
const { format } = require('../dist/src/format.js');

const sizes = process.argv.slice(2).map(Number).filter(Boolean);
if (sizes.length === 0) sizes.push(1000, 10000, 50000);

function time(fn) {
  const t0 = process.hrtime.bigint();
  const value = fn();
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, value };
}

for (const target of sizes) {
  const src = bigProgram(target);
  const lines = src.split('\n').length;
  // Warm up the JIT once so numbers reflect steady state, as in an editor session.
  parse(src);
  const p = time(() => parse(src));
  const s = time(() => astSymbols(p.value));
  const index = new DeclIndex();
  index.addProgram(p.value.program, 'big.pj');
  const c = time(() => check(p.value.program, { index, importsStd: true, unresolvedImports: true }));
  const t = time(() => semanticTokens(p.value.program, c.value, index));
  const f = time(() => format(src));
  console.log(
    `${String(lines).padStart(7)} lines  ${String(p.value.tokens.length).padStart(8)} tokens  parse ${p.ms.toFixed(1).padStart(7)} ms  symbols ${s.ms.toFixed(1).padStart(6)} ms  check ${c.ms.toFixed(1).padStart(7)} ms  semantic ${t.ms.toFixed(1).padStart(6)} ms  format ${f.ms.toFixed(1).padStart(7)} ms`,
  );
}
