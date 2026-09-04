import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { check } from '../src/checker/checker';
import { DeclIndex } from '../src/checker/index';
import { importDiagnostics, resolveImports } from '../src/imports';
import { parse } from '../src/parser/parser';

const EXAMPLES = path.join(__dirname, '..', '..', 'examples');
const INCLUDE = path.join(__dirname, '..', '..', 'test', 'fixtures', 'include');

/**
 * Every example declares the diagnostic codes it must produce on its first line
 * (`// expect:`).
 */
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
    const trustedNonBlockingNativeDeclarations = new Set<import('../src/parser/ast').ProcDecl>();
    for (const dep of res.files) {
      const dependency = parse(fs.readFileSync(dep, 'utf8')).program;
      index.addProgram(dependency, dep);
      if (path.resolve(dep) === path.resolve(INCLUDE, 'std', 'io.pj')) {
        for (const declaration of dependency.decls) {
          if (declaration.kind === 'ProcDecl' && (declaration.name.name === 'print' || declaration.name.name === 'println')) {
            trustedNonBlockingNativeDeclarations.add(declaration);
          }
        }
      }
    }
    const unresolved = res.imports.some((i) => i.files.length === 0);
    const r = check(parsed.program, {
      index,
      importsStd: res.importsStd,
      unresolvedImports: unresolved,
      trustedNonBlockingNativeDeclarations,
    });
    const all = [...importDiagnostics(res, true), ...r.diagnostics];
    const actual = all.filter((d) => d.severity !== 'info').map((d) => d.code ?? '?').sort();
    if (unresolved) problems.push(`${f}: unresolved import`);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      problems.push(`${f}: expected [${expected.join(', ')}] but got [${actual.join(', ')}]\n    ${r.diagnostics.map((d) => `L${d.line + 1} ${d.code}: ${d.message}`).join('\n    ')}`);
    }
  }
  assert.deepEqual(problems, []);
});
