import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { test } from 'node:test';
import { check } from '../src/checker/checker';
import { DeclIndex } from '../src/checker/index';
import { compilerDiagnosticTargetsBuffer, makeSandbox, remapCompilerDiagnostic } from '../src/compiler';
import { parse } from '../src/parser/parser';
import { augmentYieldAnnotations, mapYieldGeneratedRange, withYieldAnnotations } from '../src/yieldfix';

test('withYieldAnnotations marks call-only suspending procedures and keeps line numbers', () => {
  const src = 'import std.*;\n\npublic void wait1() { timer t; t.timeout(1); }\n\npublic void twice() { wait1(); wait1(); }\n\npublic void main(string[] args) { twice(); println("ok"); }\n';
  const out = withYieldAnnotations(src);
  assert.equal(out.split('\n').length, src.split('\n').length);
  assert.match(out, /public void twice\(\) \[yield=true\] \{ wait1\(\); wait1\(\); \}/);
  assert.match(out, /public void main\(string\[\] args\) \{ twice\(\)/, 'the compiler marks main itself');
  assert.match(out, /public void wait1\(\) \{ timer t;/, 'direct communication needs no annotation');
  assert.equal(withYieldAnnotations(out), out, 'idempotent');
  assert.equal(withYieldAnnotations('public void f() { int x = 1 }'), 'public void f() { int x = 1 }', 'left alone on syntax errors');
});

test('withYieldAnnotations keeps the grammar order and merges into an existing annotation list', () => {
  const src = 'void g(chan<int>.read c) { c.read(); }\r\nrecord R { chan<int>.read in; }\r\nvoid f(R r) implements g { g(r.in); }\r\nvoid h(R r) [foo=1] { g(r.in); }\r\n';
  const out = withYieldAnnotations(src);
  assert.equal(out, 'void g(chan<int>.read c) { c.read(); }\r\nrecord R { chan<int>.read in; }\r\nvoid f(R r) [yield=true] implements g { g(r.in); }\r\nvoid h(R r) [yield=true, foo=1] { g(r.in); }\r\n');
  assert.equal(withYieldAnnotations(out), out, 'idempotent');
});

test('yield rewriting uses exact overloads, mobile creation and explicit annotations', () => {
  const overload = [
    'void f(int n) { }',
    'void f(chan<int>.read c) { c.read(); }',
    'void caller() { f(1); }',
  ].join('\n');
  assert.equal(withYieldAnnotations(overload), overload, 'the selected int overload does not yield');

  const mobile = [
    'record Handle { }',
    'mobile void worker() { }',
    'void make() { Handle process = new mobile(worker); }',
    'void caller() { make(); }',
  ].join('\n');
  assert.match(withYieldAnnotations(mobile), /void caller\(\) \[yield=true\] \{ make\(\); \}/);

  const explicit = 'void declared() [yield=true] { }\nvoid caller() [yield=false, foo=1] { declared(); }';
  const rewritten = withYieldAnnotations(explicit);
  assert.equal(rewritten, 'void declared() [yield=true] { }\nvoid caller() [yield=true, foo=1] { declared(); }');
  assert.equal(withYieldAnnotations(rewritten), rewritten, 'replacing yield=false remains idempotent');
});

test('par-for gets a private yield annotation even though the compiler walkers overlook it', () => {
  const source = 'void worker() { par for (int i = 0; i < 2; i++) { skip; } }';
  assert.equal(withYieldAnnotations(source), 'void worker() [yield=true] { par for (int i = 0; i < 2; i++) { skip; } }');
});

test('lexically unreachable calls and waits do not make a procedure yielding', () => {
  const source = [
    'void wait1() { timer clock; clock.timeout(1); }',
    'void deadCall() { return; wait1(); }',
    'void deadWait() { return; timer clock; clock.timeout(1); }',
  ].join('\n');
  assert.equal(withYieldAnnotations(source), source);
});

test('compiler marking still sees unreachable direct communication in its lexical walk', () => {
  const source = [
    'void wait1() { timer clock; clock.timeout(1); }',
    'void caller() { wait1(); return; timer dead; dead.timeout(1); }',
  ].join('\n');
  assert.equal(withYieldAnnotations(source), source, 'the compiler itself marks caller from the dead timeout');
});

test('invalid calls stay quiet in yield diagnostics while private augmentation fails closed', () => {
  const source = 'void caller() { missing(); }';
  const parsed = parse(source);
  const index = new DeclIndex();
  index.addProgram(parsed.program, 'invalid-call.pj');
  const checked = check(parsed.program, { index, text: source });

  assert.ok(checked.diagnostics.some((diagnostic) => diagnostic.code === 'pj/type/call'));
  assert.equal(checked.diagnostics.some((diagnostic) => diagnostic.code === 'pj/needs-yield-annotation'), false);
  assert.equal(withYieldAnnotations(source), 'void caller() [yield=true] { missing(); }');
});

test('an imported yielding callee can annotate only the private compiler-buffer copy', () => {
  const source = 'import dep;\nvoid caller() { wait1(); }';
  const parsed = parse(source);
  const dependency = parse('void wait1() { timer clock; clock.timeout(1); }');
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(dependency.errors, []);
  const index = new DeclIndex();
  index.addProgram(parsed.program, 'caller.pj');
  index.addProgram(dependency.program, 'dep.pj');
  const checked = check(parsed.program, { index, text: source });

  assert.equal(
    withYieldAnnotations(source, { program: parsed.program, index, calls: checked.calls }),
    'import dep;\nvoid caller() [yield=true] { wait1(); }',
  );
  assert.equal(source, 'import dep;\nvoid caller() { wait1(); }', 'the editor/imported sources are untouched');
});

test('compiler columns map back across multiple same-line yield insertions and replacements', () => {
  const source = 'void leaf() { timer t; t.timeout(1); } void alpha() { leaf(); missingA(); } void beta() [yield=false] { leaf(); missingB(); }';
  const augmented = augmentYieldAnnotations(source);

  assert.match(augmented.text, /void alpha\(\) \[yield=true\]/);
  assert.match(augmented.text, /void beta\(\) \[yield=true\]/);
  assert.equal(augmented.sourceMap.edits.length, 2);

  for (const token of ['missingA', 'missingB']) {
    const generatedStart = augmented.text.indexOf(token);
    const sourceStart = source.indexOf(token);
    assert.deepEqual(
      mapYieldGeneratedRange(augmented.sourceMap, 0, generatedStart, generatedStart + token.length),
      { startCol: sourceStart, endCol: sourceStart + token.length },
      `${token} keeps its editor range`,
    );
  }

  const insertion = augmented.sourceMap.edits[0];
  assert.deepEqual(
    mapYieldGeneratedRange(augmented.sourceMap, 0, insertion.generatedStart + 1, insertion.generatedEnd - 1),
    { startCol: insertion.sourceStart, endCol: insertion.sourceStart },
    'synthetic annotation text collapses to its insertion point',
  );

  const replacement = augmented.sourceMap.edits[1];
  assert.deepEqual(
    mapYieldGeneratedRange(augmented.sourceMap, 0, replacement.generatedStart, replacement.generatedEnd),
    { startCol: replacement.sourceStart, endCol: replacement.sourceEnd },
    'the shorter true value maps over the full false value it replaced',
  );
  assert.deepEqual(
    mapYieldGeneratedRange(augmented.sourceMap, 0, -100, augmented.text.length + 100),
    { startCol: 0, endCol: source.length },
    'out-of-range compiler columns are clamped to the original line',
  );
});

test('the compiler sandbox carries the source map for its augmented private copy', () => {
  const source = 'void leaf() { timer t; t.timeout(1); } void caller() { leaf(); missing(); }';
  const sandbox = makeSandbox(
    { installDir: '/compiler', includeDir: '/compiler/include', javaBin: 'java', classpath: '' },
    'buffer.pj',
    source,
  );
  try {
    const generated = fs.readFileSync(sandbox.sourcePath, 'utf8');
    assert.match(generated, /void caller\(\) \[yield=true\]/);
    const generatedStart = generated.indexOf('missing');
    const sourceStart = source.indexOf('missing');
    assert.deepEqual(
      mapYieldGeneratedRange(sandbox.yieldSourceMap, 0, generatedStart, generatedStart + 'missing'.length),
      { startCol: sourceStart, endCol: sourceStart + 'missing'.length },
    );
    const diagnostic = {
      file: sandbox.sourcePath,
      line: 0,
      startCol: generatedStart,
      endCol: generatedStart + 'missing'.length,
      message: 'missing',
      severity: 'error' as const,
      source: 'bugmanager' as const,
    };
    assert.deepEqual(remapCompilerDiagnostic(sandbox, diagnostic), {
      ...diagnostic,
      startCol: sourceStart,
      endCol: sourceStart + 'missing'.length,
    });

    const relative = { ...diagnostic, file: sandbox.fileName };
    assert.equal(compilerDiagnosticTargetsBuffer(sandbox, relative), true, 'the root compiler unit may be reported relatively');

    const imported = { ...diagnostic, file: '/dependency/dep.pj' };
    assert.strictEqual(remapCompilerDiagnostic(sandbox, imported), imported, 'imported-file compiler output is untouched');
    const sameBasenameImport = { ...diagnostic, file: `nested/${sandbox.fileName}` };
    assert.equal(compilerDiagnosticTargetsBuffer(sandbox, sameBasenameImport), false);
    assert.strictEqual(remapCompilerDiagnostic(sandbox, sameBasenameImport), sameBasenameImport, 'an imported file with the same basename is still untouched');
  } finally {
    sandbox.cleanup();
  }
});
