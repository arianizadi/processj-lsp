import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { check } from '../src/checker/checker';
import { DeclIndex } from '../src/checker/index';
import { resolveImports } from '../src/imports';
import { parse } from '../src/parser/parser';

const EXAMPLES = path.join(__dirname, '..', '..', 'examples');
const INCLUDE = path.join(__dirname, '..', '..', 'test', 'fixtures', 'include');

/** Every example declares the diagnostic codes it must produce on its first line. */
test('examples produce exactly the diagnostics they announce', () => {
  const files = fs.readdirSync(EXAMPLES).filter((f) => f.endsWith('.pj')).sort();
  assert.ok(files.length >= 10);
  const problems: string[] = [];
  for (const f of files) {
    const file = path.join(EXAMPLES, f);
    const src = fs.readFileSync(file, 'utf8');
    const header = /^\/\/ expect:\s*(.*)$/m.exec(src);
    if (!header) {
      problems.push(`${f}: missing '// expect:' header`);
      continue;
    }
    const expected = header[1].trim() === 'none' ? [] : header[1].split(',').map((s) => s.trim()).sort();
    const parsed = parse(src);
    if (parsed.errors.length) {
      problems.push(`${f}: syntax errors: ${parsed.errors.map((e) => e.message).join('; ')}`);
      continue;
    }
    const res = resolveImports(parsed.program, file, [EXAMPLES], INCLUDE);
    const index = new DeclIndex();
    index.addProgram(parsed.program, file);
    for (const dep of res.files) index.addProgram(parse(fs.readFileSync(dep, 'utf8')).program, dep);
    const unresolved = res.imports.some((i) => i.files.length === 0);
    const r = check(parsed.program, { index, importsStd: res.importsStd, unresolvedImports: unresolved });
    const actual = r.diagnostics
      .filter((d) => d.severity !== 'info' || d.code === 'pj/timeout-noop')
      .map((d) => d.code ?? '?')
      .sort();
    if (unresolved) problems.push(`${f}: unresolved import`);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      problems.push(`${f}: expected [${expected.join(', ')}] but got [${actual.join(', ')}]\n    ${r.diagnostics.map((d) => `L${d.line + 1} ${d.code}: ${d.message}`).join('\n    ')}`);
    }
  }
  assert.deepEqual(problems, []);
});
