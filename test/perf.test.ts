import assert from 'node:assert/strict';
import { test } from 'node:test';
import { astSymbols } from '../src/astsymbols';
import { check } from '../src/checker/checker';
import { DeclIndex } from '../src/checker/index';
import { semanticTokens } from '../src/semantic';
import { format } from '../src/format';
import { parse } from '../src/parser/parser';
import { bigProgram } from './big-program';
function time<T>(fn: () => T): { ms: number; value: T } {
  const t0 = process.hrtime.bigint();
  const value = fn();
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, value };
}

test('a 20,000-line file parses, lints, and formats fast enough for keystroke latency', () => {
  const src = bigProgram(20_000);
  const lineCount = src.split('\n').length;
  assert.ok(lineCount >= 20_000, `generated ${lineCount} lines`);

  const p = time(() => parse(src));
  const s = time(() => astSymbols(p.value));
  const index = new DeclIndex();
  index.addProgram(p.value.program, 'big.pj');
  const c = time(() => check(p.value.program, { index, importsStd: true, unresolvedImports: true }));
  const t = time(() => semanticTokens(p.value.program, c.value, index));
  const f = time(() => format(src));

  console.log(`  ${lineCount} lines: parse ${p.ms.toFixed(0)} ms, symbols ${s.ms.toFixed(0)} ms, check ${c.ms.toFixed(0)} ms, semantic ${t.ms.toFixed(0)} ms, format ${f.ms.toFixed(0)} ms, ${p.value.tokens.length} tokens`);
  assert.equal(p.value.errors.length, 0, JSON.stringify(p.value.errors.slice(0, 3)));
  assert.ok(f.value.text, 'formatted');
  assert.ok(t.value.length > 1000, 'semantic tokens produced');

  // Budgets are generous for slow CI machines; a laptop should be several times faster.
  assert.ok(p.ms < 1500, `parse took ${p.ms} ms`);
  assert.ok(s.ms < 500, `symbols took ${s.ms} ms`);
  assert.ok(c.ms < 2500, `check took ${c.ms} ms`);
  assert.ok(t.ms < 1000, `semantic tokens took ${t.ms} ms`);
  assert.ok(f.ms < 3000, `format took ${f.ms} ms`);
});

test('parse time grows linearly, not quadratically', () => {
  const small = bigProgram(2_000);
  const large = bigProgram(16_000);
  const a = time(() => parse(small)).ms;
  const b = time(() => parse(large)).ms;
  const ratioLines = large.split('\n').length / small.split('\n').length;
  console.log(`  ${small.split('\n').length} lines ${a.toFixed(1)} ms; ${large.split('\n').length} lines ${b.toFixed(1)} ms; ratio ${(b / a).toFixed(1)}x for ${ratioLines.toFixed(1)}x lines`);
  assert.ok(b / Math.max(a, 1) < ratioLines * 4, 'superlinear growth');
});
