import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { check } from '../src/checker/checker';
import { DeclIndex } from '../src/checker/index';
import { parse } from '../src/parser/parser';

const DIR = path.join(__dirname, '..', '..', 'test', 'differential');
const INCLUDE = path.join(__dirname, '..', '..', 'test', 'fixtures', 'include');
const BLOCKING = new Set(['pj/channel-no-writer', 'pj/channel-no-reader', 'pj/channel-self-deadlock', 'pj/par-deadlock', 'pj/starving-loop']);

/**
 * Each program records what the real compiler and runtime did with it (`// outcome: runs` or `runs-wrong` (builds and runs, but wrong: a note must say so) or `error` (does not build: an error must say so), `runs-wrong`, `error`
 * means it built and finished). The checker must never claim that a program that runs
 * blocks or has an error. `npm run validate test/differential` re-derives the outcomes.
 */
test('the checker never contradicts a program that really runs', () => {
  const std = new DeclIndex();
  for (const f of fs.readdirSync(path.join(INCLUDE, 'std'))) std.addProgram(parse(fs.readFileSync(path.join(INCLUDE, 'std', f), 'utf8')).program, f);
  const problems: string[] = [];
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.pj')).sort();
  assert.ok(files.length >= 15);
  for (const f of files) {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8');
    const outcome = /^\/\/ outcome:\s*(\S+)/.exec(src)?.[1];
    assert.ok(outcome, `${f} lacks an outcome header`);
    const parsed = parse(src);
    if (parsed.errors.length) {
      problems.push(`${f}: syntax errors ${parsed.errors.map((e) => e.message).join('; ')}`);
      continue;
    }
    const index = new DeclIndex();
    index.addProgram(parsed.program, f);
    index.addIndex(std);
    const r = check(parsed.program, { index, importsStd: true, text: src });
    const claims = r.diagnostics.filter((d) => d.severity === 'error' || BLOCKING.has(d.code ?? ''));
    if (outcome === 'runs' && claims.length) problems.push(`${f} runs, but the checker says: ${claims.map((d) => `L${d.line + 1} ${d.code}`).join(', ')}`);
    if (outcome === 'compiler-limit' && !r.diagnostics.some((d) => d.code === 'pj/compiler-limit')) problems.push(`${f} cannot be built by this compiler, but nothing in the file says so`);
    if (outcome === 'error' && !r.diagnostics.some((d) => d.severity === 'error')) problems.push(`${f} does not build, but the checker reports no error`);
    if (outcome === 'runs-wrong' && !r.diagnostics.some((d) => d.severity === 'info' && d.code?.startsWith('pj/note-'))) problems.push(`${f} runs but misbehaves, and no note says so`);
  }
  assert.deepEqual(problems, []);
});
