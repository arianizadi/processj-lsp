import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze } from '../src/analysis';
import { astSymbols } from '../src/astsymbols';
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
  const l = time(() => analyze(src, s.value.symbols, s.value.locals, { libraryNames: new Set(['println']) }));
  const f = time(() => format(src));

  console.log(`  ${lineCount} lines: parse ${p.ms.toFixed(0)} ms, symbols ${s.ms.toFixed(0)} ms, lint ${l.ms.toFixed(0)} ms, format ${f.ms.toFixed(0)} ms, ${p.value.tokens.length} tokens`);
  assert.equal(p.value.errors.length, 0, JSON.stringify(p.value.errors.slice(0, 3)));
  assert.ok(f.value.text, 'formatted');

  // Budgets are generous for slow CI machines; a laptop should be several times faster.
  assert.ok(p.ms < 1500, `parse took ${p.ms} ms`);
  assert.ok(s.ms < 500, `symbols took ${s.ms} ms`);
  assert.ok(l.ms < 2500, `lint took ${l.ms} ms`);
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
