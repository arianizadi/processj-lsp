#!/usr/bin/env node
// Prints steady-state timings for the complete in-memory editor analysis path.
// Usage: npm run build && node scripts/bench.js [lines ...]
const { bigProgram } = require('../dist/test/big-program.js');
const { parse } = require('../dist/src/parser/parser.js');
const { astSymbols } = require('../dist/src/astsymbols.js');
const { check } = require('../dist/src/checker/checker.js');
const { DeclIndex } = require('../dist/src/checker/index.js');
const { semanticTokens } = require('../dist/src/semantic.js');
const { analyzeProcedureEffects } = require('../dist/src/checker/effects.js');
const { analyzeProtocols } = require('../dist/src/checker/protocols.js');
const { buildConcurrencyGraph } = require('../dist/src/concurrency.js');
const { channelInlays } = require('../dist/src/inlays.js');
const { format } = require('../dist/src/format.js');

const sizes = process.argv.slice(2).map(Number).filter(Boolean);
if (sizes.length === 0) sizes.push(1000, 10000, 50000);

function time(fn) {
  const t0 = process.hrtime.bigint();
  const value = fn();
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, value };
}

function analyze(src) {
  const p = time(() => parse(src));
  const s = time(() => astSymbols(p.value));
  const index = new DeclIndex();
  index.addProgram(p.value.program, 'big.pj');
  const c = time(() => check(p.value.program, { index, importsStd: true, unresolvedImports: true }));
  const e = time(() => analyzeProcedureEffects([{ program: p.value.program, checked: c.value, file: 'big.pj' }]));
  const pr = time(() => analyzeProtocols(p.value.program, index, c.value, { file: 'big.pj', sourceText: src, tokens: p.value.tokens }));
  const g = time(() => buildConcurrencyGraph(p.value.program, c.value, index, { uri: 'file:///big.pj', effects: e.value.summaries }));
  const h = time(() => channelInlays(p.value.program, c.value, e.value));
  const t = time(() => semanticTokens(p.value.program, c.value, index));
  const f = time(() => format(src));
  return { tokens: p.value.tokens.length, parse: p.ms, symbols: s.ms, check: c.ms, effects: e.ms, protocols: pr.ms, graph: g.ms, inlays: h.ms, semantic: t.ms, format: f.ms };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

for (const target of sizes) {
  const src = bigProgram(target);
  const lines = src.split('\n').length;
  // Warm every layer, then use medians to suppress scheduler and GC jitter.
  analyze(src);
  const samples = Array.from({ length: 5 }, () => analyze(src));
  const result = Object.fromEntries(
    ['parse', 'symbols', 'check', 'effects', 'protocols', 'graph', 'inlays', 'semantic', 'format']
      .map((key) => [key, median(samples.map((sample) => sample[key]))]),
  );
  console.log(
    `${String(lines).padStart(7)} lines  ${String(samples[0].tokens).padStart(8)} tokens  parse ${result.parse.toFixed(1).padStart(7)} ms  symbols ${result.symbols.toFixed(1).padStart(6)} ms  check ${result.check.toFixed(1).padStart(7)} ms  effects ${result.effects.toFixed(1).padStart(6)} ms  protocols ${result.protocols.toFixed(1).padStart(6)} ms  graph ${result.graph.toFixed(1).padStart(6)} ms  inlays ${result.inlays.toFixed(1).padStart(6)} ms  semantic ${result.semantic.toFixed(1).padStart(6)} ms  format ${result.format.toFixed(1).padStart(7)} ms`,
  );
}
