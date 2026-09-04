import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { parse, suggest } from '../src/parser/parser';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures', 'processj');

function fixtures(): Array<{ name: string; text: string }> {
  return fs
    .readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.pj'))
    .sort()
    .map((f) => ({ name: f, text: fs.readFileSync(path.join(FIXTURES, f), 'utf8') }));
}

test('every ProcessJ example program parses without errors (except the stale "proc" keyword)', () => {
  const problems: string[] = [];
  for (const { name, text } of fixtures()) {
    const { errors } = parse(text);
    const usesProc = /(^|\s)proc\s+\w/.test(text.replace(/\/\/.*$/gm, ''));
    const unexpected = errors.filter((e) => !(usesProc && /'proc'/.test(e.message)));
    for (const e of unexpected) problems.push(`${name}:${e.line + 1}:${e.col + 1}: ${e.message}`);
  }
  assert.deepEqual(problems, []);
});

test('misspelled statement keyword gets a suggestion and the body is still parsed', () => {
  const src = 'public void main(string[] args) {\n    pa {\n        println("a");\n        int x = ;\n    }\n}\n';
  const { errors, program } = parse(src);
  assert.equal(errors[0].line, 1);
  assert.match(errors[0].message, /Unknown statement 'pa'; did you mean 'par'\?/);
  assert.deepEqual(errors[0].fix, { title: "Change to 'par'", line: 1, col: 4, endCol: 6, text: 'par' });
  assert.ok(errors.some((e) => e.line === 3 && /Expected an expression but found ';'/.test(e.message)));
  const main = program.decls[0];
  assert.equal(main.kind, 'ProcDecl');
  assert.equal(main.kind === 'ProcDecl' && main.body?.stmts[0].kind, 'ParBlock');
});

test('missing semicolon is reported right after the statement, once', () => {
  const src = 'public void main(string[] args) {\n    int x = 1\n    println("a");\n}\n';
  const { errors } = parse(src);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 1);
  assert.equal(errors[0].col, 13);
  assert.match(errors[0].message, /Missing ';' after the variable declaration/);
  assert.deepEqual(errors[0].fix, { title: "Insert ';'", line: 1, col: 13, endCol: 13, text: ';' });
});

test('unclosed block names the line where it was opened', () => {
  const src = 'public void main(string[] args) {\n    while (true) {\n        println("a");\n\n';
  const { errors } = parse(src);
  assert.ok(errors.some((e) => /Missing '\}' to close the block opened at line 2/.test(e.message)), JSON.stringify(errors));
});

test('else without if, unknown type with suggestion, not-a-statement', () => {
  const src = [
    'public void main(string[] args) {',
    '    else { }',
    '    retrun y;',
    '    y + 1;',
    '    c.read;',
    '    point p;',
    '}',
  ].join('\n');
  const msgs = parse(src).errors.map((e) => `${e.line}:${e.message}`);
  assert.ok(msgs.some((m) => m.startsWith("1:'else' without a matching 'if'")), msgs.join('\n'));
  assert.ok(msgs.some((m) => m.startsWith("2:Unknown type 'retrun'; did you mean 'return'?")), msgs.join('\n'));
  // A lower-case record type may come from an import: not the parser's call.
  assert.ok(!msgs.some((m) => m.startsWith('5:')), msgs.join('\n'));
  assert.ok(msgs.some((m) => m.startsWith("3:Not a statement: the '+' expression")), msgs.join('\n'));
  assert.ok(msgs.some((m) => m.startsWith("4:'c.read' names a channel end")), msgs.join('\n'));
});

test('alt guard errors are specific', () => {
  const src = 'public void f(chan<int>.read c) {\n    int v;\n    alt {\n        c.read() : { }\n        v = c.read() { }\n    }\n}\n';
  const msgs = parse(src).errors.map((e) => e.message);
  assert.ok(msgs.some((m) => /An alt guard must store the value: write 'v = c\.read\(\)'/.test(m)), msgs.join('\n'));
  assert.ok(msgs.some((m) => /Expected ':' after the alt guard/.test(m)), msgs.join('\n'));
});

test('top-level typos and stale proc keyword', () => {
  const msgs = parse('pubic void f() { }\nproc void g() { }\n').errors.map((e) => e.message);
  assert.ok(msgs.some((m) => /Unknown declaration 'pubic'; did you mean 'public'\?/.test(m)), msgs.join('\n'));
  assert.ok(msgs.some((m) => /'proc' is not part of the syntax/.test(m)), msgs.join('\n'));
});

test('AST shapes: channel types, nested generics, casts, literals, extended rendezvous', () => {
  const src = [
    'record R { int a; }',
    'protocol P { tag : { int x; } none : { } }',
    'public void f(shared chan<chan<int>>.read in, chan<int>.write out) {',
    '    int v = (int) 3.5;',
    '    long w = (long) v;',
    '    R r = new R { a = 1 };',
    '    P p = new P { none: };',
    '    int[] xs = new int[] { 1, 2 };',
    '    int[][] m = new int[2][];',
    '    v = in.read({ out.write(1); }).read();',
    '    if (p is tag) out.write(v);',
    '    par enroll b { skip; }',
    '}',
  ].join('\n');
  const { errors, program } = parse(src);
  assert.deepEqual(errors, []);
  const f = program.decls[2];
  assert.equal(f.kind, 'ProcDecl');
  if (f.kind !== 'ProcDecl') return;
  const p0 = f.params[0].type;
  assert.equal(p0.kind, 'ChanType');
  assert.equal(p0.kind === 'ChanType' && p0.shared && p0.end === 'read' && p0.elem.kind === 'ChanType', true);
  const body = f.body!.stmts;
  assert.equal(body[0].kind === 'LocalDecl' && body[0].declarators[0].init?.kind, 'CastExpr');
  assert.equal(body[2].kind === 'LocalDecl' && body[2].declarators[0].init?.kind, 'RecordLiteral');
  assert.equal(body[3].kind === 'LocalDecl' && body[3].declarators[0].init?.kind, 'ProtocolLiteral');
  assert.equal(body[4].kind === 'LocalDecl' && body[4].declarators[0].init?.kind === 'NewArray' && body[4].declarators[0].init.init?.elements.length, 2);
  assert.equal(body[5].kind === 'LocalDecl' && body[5].declarators[0].init?.kind === 'NewArray' && body[5].declarators[0].init.extraDims, 1);
  const rd = body[6].kind === 'ExprStmt' && body[6].expr.kind === 'AssignExpr' ? body[6].expr.value : undefined;
  assert.equal(rd?.kind, 'ChanRead');
  assert.equal(rd?.kind === 'ChanRead' && rd.target.kind === 'ChanRead' && !!rd.target.extended, true);
  assert.equal(body[7].kind === 'IfStmt' && body[7].cond.kind, 'IsExpr');
  assert.equal(body[8].kind === 'ParBlock' && body[8].barriers.length, 1);
});

test('suggest picks close keywords only', () => {
  assert.equal(suggest('pa', ['par', 'pri', 'if']), 'par');
  assert.equal(suggest('whlie', ['while', 'for']), 'while');
  assert.equal(suggest('fooo', ['while', 'for']), undefined);
  assert.equal(suggest('x', ['if']), undefined);
});

test('rejects constructs outside the compiler grammar before invoking the compiler', () => {
  const cases: Array<[string, RegExp]> = [
    ['protocol P { }', /must declare at least one case/],
    ['protocol P { one: two: { } }', /case 'one' needs a body in braces/],
    ['record R { }\nvoid f() { R r = new R { }; }', /record literal must initialise at least one field/i],
    ['void f() { int[] a = new int[2] { 1, 2 }; }', /both explicit sizes and an initializer/],
    ['void f() { int[] a; a = { 1, 2 }; }', /cannot be assigned later/],
    ['void f(shared read chan<int>.read in) { }', /cannot also be a channel-end type/],
    ['native void value;', /void.*cannot declare a constant/],
    ['void f() { for (1 + 2; true; ) { } }', /initialiser of 'for'.*has no effect/],
    ['void f() { for (; true; 1 + 2) { } }', /update of 'for'.*has no effect/],
    ['void f() { alt { } }', /must contain at least one guard/],
    ['void f() { barrier a; barrier b; par enroll (a, b) { } }', /accepts one barrier only/],
    ['void f() [yield="true"] { }', /needs an identifier, boolean, or numeric value/],
    ['void f() { const mobile int n = 1; }', /cannot be both 'const' and 'mobile'/],
    ['void f() { double[] d; int[] i = (int[]) d; }', /Array casts are not accepted/],
    ['void[] f() { }', /void.*cannot be an array element type/i],
    ['void[] value;', /void.*cannot be an array element type/i],
    ['void f() { int[] a = { 1, }; }', /Trailing commas.*array initializer/],
    ['void f() { int[] a = new int[] { 1, }; }', /Trailing commas.*array initializer/],
    ['record R { int x; }\nvoid f() { R r = new R { x = 1, }; }', /Trailing commas.*record literal/],
    ['protocol P { value: { int x; } }\nvoid f() { P p = new P { value: x = 1, }; }', /Trailing commas.*protocol literal/],
    ['void f() { if (true) int x = 1; }', /variable declaration cannot be used as a single substatement/i],
    ['void f() { alt { skip: int x = 1; } }', /variable declaration cannot be used as a single substatement/i],
    ['void f() { label: int x = 1; }', /variable declaration cannot be used as a single substatement/i],
    ['void f() { switch (1) { case 1: } }', /case.*must contain at least one statement/i],
    ['# pragma trace;\nvoid f() { }', /requires '#pragma' with no whitespace/],
    ['#\tpragma trace;\nvoid f() { }', /requires '#pragma' with no whitespace/],
    ['#\npragma trace;\nvoid f() { }', /requires '#pragma' with no whitespace/],
    ['void f() { pkg.types::Thing value; }', /package-qualified named type must be an array/i],
    ['void f() { Thing[] values = new pkg.types::Thing[1]; }', /not array creation/i],
  ];
  for (const [source, expected] of cases) {
    const messages = parse(source).errors.map((e) => e.message);
    assert.ok(messages.some((message) => expected.test(message)), `${source}\n${messages.join('\n')}`);
  }
});

test('lexer issues cover malformed literals, unfinished comments, and CR-only line endings', () => {
  const malformed = parse("void f() { int a = 1_000; int b = 09L; int c = 0x; double d = 1e; char e = ''; char g = 'ab'; char h = '\\q'; }");
  assert.deepEqual(
    malformed.lexIssues.map((issue) => issue.code),
    ['pj/numeric-literal', 'pj/numeric-literal', 'pj/numeric-literal', 'pj/numeric-literal', 'pj/char-literal', 'pj/char-literal', 'pj/char-literal'],
  );

  const unfinished = parse('void f() { string s = "oops\r/* never closed');
  assert.deepEqual(
    unfinished.lexIssues.map((issue) => [issue.code, issue.line]),
    [
      ['pj/unterminated-string', 0],
      ['pj/unterminated-comment', 1],
    ],
  );

  const escapedNewline = parse("void f() { char c = '\\\rint n = 1;");
  assert.equal(escapedNewline.lexIssues.find((issue) => issue.code === 'pj/unterminated-char')?.line, 0);

  const valid = parse("void f() { double a = .5; double b = 1.; double c = 1e2; double odd = 09; float d = 1f; int h = 0xff; int hd = 0xd; int o = 077; int $value = 1; char q = '\\n'; char u = '\\u0041'; }");
  assert.deepEqual(valid.lexIssues, []);
  assert.deepEqual(valid.errors, []);
  assert.ok(valid.tokens.some((token) => token.kind === 'ident' && token.text === '$value'));

  const numericKinds = parse('void f() { double fallback = 09; int hexF = 0xff; int hexD = 0xd; int octal = 077; }');
  const proc = numericKinds.program.decls[0];
  assert.equal(proc?.kind, 'ProcDecl');
  const kinds = proc?.kind === 'ProcDecl'
    ? proc.body?.stmts.flatMap((stmt) => stmt.kind === 'LocalDecl' ? stmt.declarators.map((d) => d.init?.kind === 'Literal' ? d.init.litKind : undefined) : [])
    : [];
  assert.deepEqual(kinds, ['double', 'int', 'int', 'int']);

  const crOnly = parse('void f() {\rint n = 1;\r@\r}');
  assert.equal(crOnly.lexIssues.find((issue) => issue.code === 'pj/illegal-char')?.line, 2);
});

test('qualified names are accepted exactly in the compiler grammar positions', () => {
  const source = [
    'record R extends pkg.base::Base { int value; }',
    'protocol P extends pkg.base::Parent { item: { int value; } }',
    'mobile void worker() { }',
    'void run(P p, R r) implements pkg.api::work {',
    '    pkg.api::work();',
    '    R copy = new pkg.types::R { value = 1 };',
    '    P event = new pkg.types::P { item: value = 1 };',
    '    boolean matches = p is pkg.types::item;',
    '    R casted = (pkg.types::R) r;',
    '    pkg.types::R[] values;',
    '    R process = new mobile(pkg.tasks::worker);',
    '}',
  ].join('\n');
  const parsed = parse(source);
  assert.deepEqual(parsed.errors, []);

  const run = parsed.program.decls.find((d) => d.kind === 'ProcDecl' && d.name.name === 'run');
  assert.equal(run?.kind, 'ProcDecl');
  assert.deepEqual(run?.kind === 'ProcDecl' ? run.implements[0].qualifier?.map((q) => q.name) : [], ['pkg', 'api']);
  const call = run?.kind === 'ProcDecl' && run.body?.stmts[0]?.kind === 'ExprStmt' ? run.body.stmts[0].expr : undefined;
  assert.deepEqual(call?.kind === 'Invocation' ? call.qualifier?.map((q) => q.name) : [], ['pkg', 'api']);

  // Direct declarations in switch groups and consecutive labels are block
  // statements in CUP, even though declarations are illegal after `if`, etc.
  assert.deepEqual(parse('void f() { switch (1) { case 1: case 2: int value = 1; break; } }').errors, []);
});

test('re-parsing a misspelled keyword reports the typo once and leaves no phantom token', () => {
  const src = 'void f() {\n  whlie (x > ) { }\n}\n';
  const r = parse(src);
  assert.deepEqual(r.errors.map((e) => `${e.line}:${e.col} ${e.message}`), ["1:2 Unknown statement 'whlie'; did you mean 'while'?", "1:13 Expected an expression but found ')'"]);
  assert.deepEqual(r.tokens.filter((t) => t.line === 1 && t.col === 2).map((t) => `${t.kind}:${t.text}`), ['keyword:while']);
});

test('synthetic nodes never get a span that ends before it starts', () => {
  const check = (src: string) => {
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) return value.forEach(visit);
      const node = value as Record<string, unknown>;
      const span = node.span as { start: { line: number; col: number }; end: { line: number; col: number } } | undefined;
      if (span) assert.ok(span.end.line > span.start.line || (span.end.line === span.start.line && span.end.col >= span.start.col), `${src}: ${JSON.stringify(span)}`);
      for (const child of Object.values(node)) visit(child);
    };
    visit(parse(src).program);
  };
  check('void f() {\n  while x { }\n}');
  check('void f() {\n  if (x)   }');
  check('void f() {\n  if x { y = 1; }\n}');
});

test('a missing ( keeps the block as the body instead of cascading', () => {
  const r = parse('void f() {\n  if x { y = 1; }\n}\n');
  assert.deepEqual(r.errors.map((e) => e.message), ["Expected '(' after 'if' but found 'x'"]);
  const f = r.program.decls[0];
  assert.equal(f.kind === 'ProcDecl' && f.body?.stmts.length, 1);
});

test('a missing ; or } before the next declaration does not swallow that declaration', () => {
  const missingSemi = parse('int x = 5\nvoid g() { }\nvoid h() { }\n');
  assert.deepEqual(missingSemi.errors.map((e) => e.message), ["Missing ';' after the constant declaration"]);
  assert.deepEqual(missingSemi.program.decls.map((d) => d.kind === 'ConstDecl' ? d.declarators[0].name.name : d.kind === 'ProcDecl' ? d.name.name : d.kind), ['x', 'g', 'h']);

  const missingBrace = parse('void f() {\n  if (x) {\n    y = 1;\n}\nvoid g() { }\nvoid h() { }\n');
  assert.deepEqual(missingBrace.errors.map((e) => `${e.line}:${e.message}`), ["3:Missing '}' to close the block opened at line 1"]);
  assert.deepEqual(missingBrace.program.decls.map((d) => (d.kind === 'ProcDecl' ? d.name.name : d.kind)), ['f', 'g', 'h']);
  assert.equal(missingBrace.errors[0].fix?.text, '}');
});

test('absurd nesting is reported instead of overflowing the stack', () => {
  const parens = 'void f() { int x = ' + '('.repeat(3000) + '1' + ')'.repeat(3000) + '; }';
  assert.ok(parse(parens).errors.some((e) => /nested too deeply/.test(e.message)));
  const blocks = 'void f() ' + '{'.repeat(3000) + '}'.repeat(3000);
  assert.ok(parse(blocks).errors.some((e) => /nested too deeply/.test(e.message)));
});
