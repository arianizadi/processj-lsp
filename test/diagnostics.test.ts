import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCompilerOutput } from '../src/diagnostics';

// Outputs below were captured from the real compiler (ProcessJ snapshot Sep 2025, JVM target).

test('parser syntax error with caret gives line and column', () => {
  const out = 'syn.pj:4: Syntax error:\n\n    int x = ;\n            ^\n';
  const { diagnostics, succeeded } = parseCompilerOutput(out, '');
  assert.equal(succeeded, false);
  assert.equal(diagnostics.length, 1);
  const d = diagnostics[0];
  assert.equal(d.line, 3);
  assert.equal(d.startCol, 12);
  assert.equal(d.endCol, 13);
  assert.equal(d.severity, 'error');
  assert.equal(d.source, 'parser');
});

test('unexpected end of file maps to the last line', () => {
  const out = 'Unexpected end of file.    println("hi");\n\n';
  const { diagnostics } = parseCompilerOutput(out, '');
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].line, -1);
  assert.match(diagnostics[0].message, /end of file/i);
});

test('PJBugManager messages carry token columns and survive ANSI colour', () => {
  const out = [
    "\x1b[1;31merror[405]: \x1b[0mSymbol 'y' not found",
    '[+] /Users/me/proj/name.pj:4',
    " ### Token: 'y', line 4 [13:13] (kind: 115)",
    '',
    '',
    "\x1b[1;31merror[405]: \x1b[0mSymbol 'z' not found",
    '[+] /Users/me/proj/name.pj:5',
    " ### Token: 'z', line 5 [20:20] (kind: 115)",
    '',
  ].join('\n');
  const { diagnostics } = parseCompilerOutput(out, '');
  assert.equal(diagnostics.length, 2);
  assert.deepEqual(
    diagnostics.map((d) => [d.line, d.startCol, d.endCol, d.code, d.message]),
    [
      [3, 12, 13, '405', "Symbol 'y' not found"],
      [4, 19, 20, '405', "Symbol 'z' not found"],
    ],
  );
  assert.equal(diagnostics[0].file, '/Users/me/proj/name.pj');
});

test('PJBugManager locations tolerate blank separator lines', () => {
  const out = [
    "error[405]: Symbol 'x' not found",
    '',
    '[+] /p/name.pj:8',
    '',
    " ### Token: 'x', line 8 [5:5] (kind: 115)",
  ].join('\n');
  const { diagnostics } = parseCompilerOutput(out, '');
  assert.deepEqual(
    diagnostics.map((d) => [d.file, d.line, d.startCol, d.endCol]),
    [['/p/name.pj', 7, 4, 5]],
  );
});

test('legacy type checker messages parse even when glued together on one line', () => {
  const out =
    'typ.pj:4: Cannot assign value of type int to variable of type byte.\n' +
    'Error number: 3058typ.pj:5: Cannot assign value of type int to variable of type string.\n' +
    'Error number: 3058-- Rewriting channel arrays local decls\n' +
    '** COMPILATION COMPLITED SUCCESSFULLY **\n';
  const { diagnostics, succeeded } = parseCompilerOutput(out, '');
  // The compiler reports success even though it printed errors; we still surface them.
  assert.equal(succeeded, true);
  assert.equal(diagnostics.length, 2);
  assert.equal(diagnostics[0].line, 3);
  assert.equal(diagnostics[0].code, '3058');
  assert.equal(diagnostics[0].file, 'typ.pj');
  assert.equal(diagnostics[1].line, 4);
  assert.match(diagnostics[1].message, /type string/);
  assert.equal(diagnostics[0].source, 'legacy');
});

test('name checker and type checker duplicates on one line are both kept only if messages differ', () => {
  const out = [
    "error[405]: Symbol 'y' not found",
    '[+] /p/name.pj:4',
    " ### Token: 'y', line 4 [13:13] (kind: 115)",
    '',
    "name.pj:4: Unknown name expression 'y'.",
    'Error number: 3029',
    "name.pj:4: Unknown name expression 'y'.",
    'Error number: 3029',
  ].join('\n');
  const { diagnostics } = parseCompilerOutput(out, '');
  assert.equal(diagnostics.length, 2);
});

test('warning number is mapped to warning severity', () => {
  const out = 'w.pj:7: Unreachable code.\nWarning number: 802\n';
  const { diagnostics } = parseCompilerOutput(out, '');
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].severity, 'warning');
  assert.equal(diagnostics[0].code, '802');
});

test('a compiler crash on stderr becomes a diagnostic with the exception', () => {
  const err =
    'Exception in thread "main" java.lang.IllegalArgumentException: no such attribute: switchBlock\n' +
    '\tat org.stringtemplate.v4.ST.add(ST.java:223)\n' +
    '\tat codegen.java.CodeGenJava.visitProcTypeDecl(CodeGenJava.java:433)\n';
  const { diagnostics, crash, succeeded } = parseCompilerOutput('-- Setting absolute path\n', err);
  assert.equal(succeeded, false);
  assert.ok(crash);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /compiler crashed on this file/);
  assert.equal(diagnostics[0].severity, 'warning');
  assert.match(crash ?? '', /no such attribute: switchBlock/);
  assert.equal(diagnostics[0].line, 0);
});

test('successful compile yields no diagnostics', () => {
  const out = '-- Rewriting channel arrays local decls\n** COMPILATION COMPLITED SUCCESSFULLY **\n';
  const { diagnostics, succeeded } = parseCompilerOutput(out, '');
  assert.equal(succeeded, true);
  assert.equal(diagnostics.length, 0);
});

test('unparseable failure surfaces the last meaningful line', () => {
  const out = '-- Setting absolute path\nSomething odd happened\n';
  const { diagnostics } = parseCompilerOutput(out, '');
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /Something odd happened/);
});

test('unparseable launch failure surfaces stderr', () => {
  const { diagnostics } = parseCompilerOutput('-- Setting absolute path\n', 'java: command not found\n');
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /java: command not found/);
});

test('otherwise identical imported-file diagnostics are not deduplicated', () => {
  const out = [
    'one.pj:4: Unknown name.',
    'Error number: 3029',
    'two.pj:4: Unknown name.',
    'Error number: 3029',
  ].join('\n');
  const { diagnostics } = parseCompilerOutput(out, '');
  assert.deepEqual(diagnostics.map((d) => d.file), ['one.pj', 'two.pj']);
});

test('a legacy message without an error number keeps its line', () => {
  const out = '/tmp/x/cast.pj:5: Illegal Expression in cast - Type names only\n';
  const { diagnostics, succeeded } = parseCompilerOutput(out, '');
  assert.equal(succeeded, false);
  assert.deepEqual(diagnostics.map((d) => [d.line, d.message, d.file]), [[4, 'Illegal Expression in cast - Type names only', '/tmp/x/cast.pj']]);
});
