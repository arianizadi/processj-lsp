/**
 * Checking a test program the way the server does, for the checker's test
 * files. A module of its own, not a test file: a test file imported by
 * another would run its tests again in that file's process.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { check } from '../src/checker/checker';
import { DeclIndex } from '../src/checker/index';
import { parse } from '../src/parser/parser';

const INCLUDE = path.join(__dirname, '..', '..', 'test', 'fixtures', 'include');

function stdIndex(): DeclIndex {
  const idx = new DeclIndex();
  for (const dir of ['std', 'image']) {
    const full = path.join(INCLUDE, dir);
    for (const f of fs.readdirSync(full).filter((x) => x.endsWith('.pj')).sort()) {
      idx.addProgram(parse(fs.readFileSync(path.join(full, f), 'utf8')).program, path.join(full, f));
    }
  }
  return idx;
}
/** The std (and image) headers of the test include directory. */
export const STD = stdIndex();
/** The std output procedures the server trusts not to block, as it does for the install's own headers. */
export const TRUSTED_STD_OUTPUT_DECLARATIONS = new Set(
  ['print', 'println'].flatMap((name) => STD.procs.get(name) ?? []).map((signature) => signature.decl),
);

/** Parse and check a test program (with the std headers when it imports std): its diagnostics, also as codes, notes, messages and errors. */
export function run(src: string, opts: { std?: boolean } = {}) {
  const parsed = parse(src);
  assert.deepEqual(parsed.errors, [], 'test program must parse');
  const index = new DeclIndex();
  index.addProgram(parsed.program, 'test.pj');
  const importsStd = /import\s+std\b/.test(src);
  if (opts.std !== false && importsStd) index.addIndex(STD);
  const result = check(parsed.program, {
    index,
    stdIndex: STD,
    importsStd,
    text: src,
    trustedNonBlockingNativeDeclarations: TRUSTED_STD_OUTPUT_DECLARATIONS,
  });
  return { ...result, codes: result.diagnostics.filter((d) => d.severity !== 'info').map((d) => d.code), notes: result.diagnostics.filter((d) => d.severity === 'info').map((d) => `${d.line + 1}:${d.code}`), messages: result.diagnostics.filter((d) => d.severity !== 'info').map((d) => `${d.line + 1}: ${d.message}`), errors: result.diagnostics.filter((d) => d.severity === 'error') };
}
