import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { check } from '../src/checker/checker';
import { DeclIndex } from '../src/checker/index';
import { parse } from '../src/parser/parser';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures', 'processj');
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
const STD = stdIndex();

export function run(src: string, opts: { std?: boolean } = {}) {
  const parsed = parse(src);
  assert.deepEqual(parsed.errors, [], 'test program must parse');
  const index = new DeclIndex();
  index.addProgram(parsed.program, 'test.pj');
  const importsStd = /import\s+std\b/.test(src);
  if (opts.std !== false && importsStd) index.addIndex(STD);
  const result = check(parsed.program, { index, stdIndex: STD, importsStd, text: src });
  return { ...result, codes: result.diagnostics.map((d) => d.code), messages: result.diagnostics.map((d) => `${d.line + 1}: ${d.message}`), errors: result.diagnostics.filter((d) => d.severity === 'error') };
}

const MAIN = (body: string, extra = '') => `import std.*;\n${extra}\npublic void main(string[] args) {\n${body}\n}\n`;

// Genuine bugs in the compiler's own examples that the checker is expected to find.
const KNOWN_CORPUS_BUGS: Record<string, string[]> = {
  // muxGate declares out1 as a read end and writes to it; callers then hand the same read end to two processes.
  'fullAdder.pj': ['pj/channel-direction', 'pj/shared-channel-end'],
  // a find/replace of int -> long turned println into prlongln.
  'integrate.pj': ['pj/type/call'],
};

test('the compiler example corpus type-checks; only the known bugs in it are reported', () => {
  const problems: string[] = [];
  for (const f of fs.readdirSync(FIXTURES).filter((x) => x.endsWith('.pj')).sort()) {
    const src = fs.readFileSync(path.join(FIXTURES, f), 'utf8');
    const parsed = parse(src);
    if (parsed.errors.length) continue;
    const index = new DeclIndex();
    index.addProgram(parsed.program, f);
    index.addIndex(STD);
    const r = check(parsed.program, { index, stdIndex: STD, importsStd: true });
    const errors = r.diagnostics.filter((d) => d.severity === 'error');
    const codes = [...new Set(errors.map((d) => d.code))].sort();
    const expected = (KNOWN_CORPUS_BUGS[f] ?? []).sort();
    if (JSON.stringify(codes) !== JSON.stringify(expected)) {
      problems.push(`${f}: expected [${expected.join(', ')}] but got [${codes.join(', ')}]`);
      for (const d of errors.slice(0, 5)) problems.push(`    ${f}:${d.line + 1}: [${d.code}] ${d.message}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('names: undefined with suggestion and fix, proc as value, type as value, duplicates, use in own initialiser', () => {
  const r = run(MAIN('    int count = 1;\n    int x = cuont + 1;\n    int y = main;\n    int z = Point;\n    int x = 2;\n    int w = w + 1;', 'record Point { int a; }'));
  assert.ok(r.messages.some((m) => m.startsWith("5: Cannot find 'cuont'; did you mean 'count'?")), r.messages.join('\n'));
  assert.equal(r.diagnostics.find((d) => /cuont/.test(d.message))?.fix?.text, 'count');
  assert.ok(r.messages.some((m) => /'main' is a procedure; call it/.test(m)));
  assert.ok(r.messages.some((m) => /'Point' is a type, not a value/.test(m)));
  assert.ok(r.messages.some((m) => /'x' is already declared in this scope \(line 5\)/.test(m)), r.messages.join('\n'));
  assert.ok(r.messages.some((m) => m.startsWith("9: Cannot find 'w'")));
});

test('assignments and arithmetic follow Java widening, with constant narrowing for literals', () => {
  const ok = run(MAIN('    byte b = 1;\n    short s = 2;\n    int i = b + s;\n    long l = i;\n    float f = 1.5;\n    double d = l * f;\n    string t = "n=" + i + d;\n    boolean eq = i == l && t != null;\n    char c = 65;\n    i += 2; l <<= 1; t += 1;\n    println(t + eq + c);'));
  assert.deepEqual(ok.errors, [], ok.messages.join('\n'));
  const bad = run(MAIN('    int i = 1;\n    long l = 2;\n    int j = l;\n    int k = "s";\n    string s = 5;\n    boolean b = i + 1;\n    boolean c = i && true;\n    i = i < 2;\n    if (i) { }\n    int m = -true;'));
  assert.deepEqual(
    bad.errors.map((d) => `${d.line + 1}: ${d.message}`),
    [
      "6: Cannot initialise 'j' (int) with a value of type long (long does not fit in int without a cast)",
      "7: Cannot initialise 'k' (int) with a value of type string",
      "8: Cannot initialise 's' (string) with a value of type int",
      "9: Cannot initialise 'b' (boolean) with a value of type int",
      "10: '&&' needs boolean operands; here they are int and boolean",
      "11: Cannot assign boolean to 'i' (int)",
      "12: The condition of 'if' must be boolean, not int",
      "13: Unary '-' needs a number; true is boolean",
    ],
  );
});

test('channels: element types, directions, whole channel vs end, shared requirement', () => {
  const src = MAIN(
    [
      '    chan<int> c;',
      '    chan<string> s;',
      '    par {',
      '        c.write("hello");',
      '        s.write(5);',
      '        reader(c);',
      '        reader(c.write);',
      '        writer(c.read);',
      '        sharedReader(c.read);',
      '        int v = c.write.read();',
      '        c.read.write(1);',
      '        s.write("ok");',
      '        println(s.read());',
      '    }',
    ].join('\n'),
    'public void reader(chan<int>.read in) { println(in.read()); in.write(1); }\npublic void writer(chan<int>.write out) { out.write(1); int x = out.read(); }\npublic void sharedReader(shared chan<int>.read in) { println(in.read()); }',
  );
  const r = run(src);
  const errs = r.errors.map((d) => `${d.line + 1}:${d.code}`);
  assert.ok(errs.includes('2:pj/channel-direction'), `in.write on read end: ${errs.join(' ')}`);
  assert.ok(errs.includes('3:pj/channel-direction'), 'out.read on write end');
  assert.ok(errs.includes('9:pj/channel-write-type'), `string into chan<int>: ${errs.join(' ')}`);
  assert.ok(errs.includes('10:pj/channel-write-type'), 'int into chan<string>');
  assert.ok(r.messages.some((m) => m.startsWith("11: No version of 'reader' accepts (chan<int>)") && /pass an end of the channel: '.read'/.test(m)), r.messages.join('\n'));
  assert.ok(r.messages.some((m) => m.startsWith("12: No version of 'reader' accepts (chan<int>.write)") && /write end was given where a read end/.test(m)));
  assert.ok(r.messages.some((m) => m.startsWith("13: No version of 'writer' accepts (chan<int>.read)")));
  assert.ok(r.messages.some((m) => m.startsWith("14: No version of 'sharedReader' accepts (chan<int>.read)") && /declare the channel 'shared chan<int>'/.test(m)));
  assert.ok(errs.includes('15:pj/channel-direction'), 'c.read.read');
  assert.ok(errs.includes('16:pj/channel-direction'), 'c.read.write');
  assert.ok(!errs.includes('17:pj/channel-write-type') && !errs.includes('18:pj/channel-write-type'));
});

test('records and protocols: fields, literals, switch narrowing, is', () => {
  const decls = 'record Point { int x; int y; }\nrecord Point3 extends Point { int z; }\nprotocol Msg { move : { int dx; int dy; } quit : { string reason; } }';
  const ok = run(MAIN('    Point3 p = new Point3 { x = 1, y = 2, z = 3 };\n    int s = p.x + p.z;\n    Point q = p;\n    Msg m = new Msg { move: dx = 1, dy = 2 };\n    Msg n = new Msg { quit: };\n    switch (m) {\n        case move: s = m.dx; break;\n        case quit: println(m.reason); break;\n    }\n    if (m is move) s = m.dy;\n    println(s + q.y + n.reason);', decls));
  assert.deepEqual(ok.errors, [], ok.messages.join('\n'));
  const bad = run(MAIN('    Point p = new Point { x = 1, yy = 2 };\n    int a = p.z;\n    Msg m = new Msg { mvoe: dx = 1 };\n    Msg n = new Msg { move: reason = "r" };\n    switch (m) {\n        case move: println(m.reason); break;\n        case halt: break;\n    }\n    boolean b = m is bogus;\n    Point q = new Msg { quit: };', decls));
  assert.deepEqual(
    bad.errors.map((d) => `${d.line + 1}: ${d.message}`),
    [
      "6: Record 'Point' has no field 'yy' (fields: x, y); did you mean 'y'?",
      "7: Record 'Point' has no field 'z' (fields: x, y)",
      "8: 'mvoe' is not a case of protocol Msg (cases: move, quit); did you mean 'move'?",
      "9: Case 'move' of Msg has no field 'reason' (fields: dx, dy)",
      "11: 'reason' belongs to case quit, but here 'm' is case 'move' (fields: dx, dy)",
      "12: 'halt' is not a case of protocol Msg (cases: move, quit)",
      "14: 'bogus' is not a case of protocol Msg (cases: move, quit)",
      "15: Cannot initialise 'q' (Point) with a value of type Msg",
    ],
  );
});

test('procedure calls: overload resolution, mismatch explanations, methods, return and break checks', () => {
  const extra = 'public int twice(int v) { return v * 2; }\npublic long twice(long v) { return v * 2; }\npublic void show(string s, int n) { println(s + n); }\npublic int bad() { return; }\npublic void bad2() { return 1; }\npublic int noret(int x) { if (x > 0) return x; else return -x; }';
  const r = run(MAIN('    byte b = 3;\n    int t = twice(b);\n    long u = twice(4L);\n    show("n", "x");\n    show(1);\n    twiceX(1);\n    int q = args.size + "abc".length;\n    break;\n    println(t + u + q);', extra));
  const msgs = r.messages;
  assert.ok(msgs.some((m) => m.startsWith("12: No version of 'show' accepts (string, string): argument 2 ('n') needs int")), msgs.join('\n'));
  assert.ok(msgs.some((m) => m.startsWith("13: No version of 'show' accepts (int). Available: void show(string s, int n)")));
  assert.ok(msgs.some((m) => m.startsWith("14: Cannot find a procedure named 'twiceX'; did you mean 'twice'?")));
  assert.ok(msgs.some((m) => m.startsWith("16: 'break' outside of a loop or switch")));
  assert.ok(msgs.some((m) => /'bad' must return a value of type int/.test(m)));
  assert.ok(msgs.some((m) => /'bad2' returns void; it cannot return a value/.test(m)));
  assert.ok(!msgs.some((m) => /Ambiguous/.test(m)), 'byte argument picks twice(int) as most specific');
  const call = [...r.calls.values()].find((s) => s.name === 'twice' && s.params[0].k === 'prim' && s.params[0].name === 'int');
  assert.ok(call, 'twice(int) chosen for a byte argument');
});

test('concurrency lints from the AST: parallel usage, shared ends with fix, no writer, short circuit', () => {
  const r = run(MAIN('    chan<int> c;\n    chan<int> d;\n    int x = 0;\n    par {\n        w(c.write);\n        w(c.write);\n        x = 1;\n        println(x);\n        { int local = 1; local = local + 1; }\n        println(c.read());\n    }\n    int v = d.read();\n    if (x > 0 && c.read() == 1) { }\n    int z = x > 0 ? c.read() : v;', 'public void w(chan<int>.write o) { o.write(1); }'));
  const byCode = (code: string) => r.diagnostics.filter((d) => d.code === code).map((d) => d.line + 1);
  assert.deepEqual(byCode('pj/parallel-usage'), [11]);
  assert.deepEqual(byCode('pj/shared-channel-end'), [9]);
  assert.equal(r.diagnostics.find((d) => d.code === 'pj/shared-channel-end')?.fix?.kind, 'make-shared');
  assert.deepEqual(byCode('pj/channel-no-writer'), [15]);
});

test('a channel written and read by the same sequential process is a self-deadlock', () => {
  const bad = run(MAIN('    chan<int> c;\n    c.write(1);\n    int x = c.read();\n    println(x);'));
  assert.deepEqual(bad.codes, ['pj/channel-self-deadlock']);
  assert.equal(bad.diagnostics[0].line, 4);
  assert.match(bad.diagnostics[0].message, /both the writer and the reader of 'c', so this write blocks forever/);
  // Same branch of a par is still one process; different branches are fine.
  const sameBranch = run(MAIN('    chan<int> c;\n    par {\n        { c.write(1); println(c.read()); }\n        println("other");\n    }'));
  assert.deepEqual(sameBranch.codes, ['pj/channel-self-deadlock']);
  const ok = run(MAIN('    chan<int> c;\n    par {\n        c.write(1);\n        println(c.read());\n    }'));
  assert.deepEqual(ok.codes, []);
  const viaProc = run(MAIN('    chan<int> c;\n    par {\n        w(c.write);\n        println(c.read());\n    }', 'public void w(chan<int>.write o) { o.write(1); }'));
  assert.deepEqual(viaProc.codes, []);
});

test('starving loops: infinite loops that never communicate, unless they can exit or call something that does', () => {
  const bad = run(MAIN('    int n = 0;\n    while (true) { n++; }\n    for (;;) { println(n); }\n    do { n--; } while (true);'));
  assert.deepEqual(bad.codes, ['pj/starving-loop', 'pj/starving-loop', 'pj/starving-loop']);
  const ok = run(MAIN('    chan<int> c;\n    int n = 0;\n    par {\n        while (true) c.write(n);\n        while (true) { if (c.read() > 3) break; }\n        while (true) { helper(c.read); }\n        while (n < 10) n++;\n        for (;;) { n++; if (n > 5) return; }\n    }', 'public void helper(chan<int>.read in) { println(in.read()); }'));
  assert.deepEqual(ok.codes.filter((c) => c === 'pj/starving-loop'), []);
});

test('par deadlock simulation: crossed orders, unmatched writes, and correct pairings', () => {
  const crossed = run(MAIN('    chan<int> c;\n    chan<int> d;\n    par {\n        { c.write(1); int x = d.read(); println(x); }\n        { d.write(2); int y = c.read(); println(y); }\n    }'));
  assert.deepEqual(crossed.codes, ['pj/par-deadlock']);
  assert.match(crossed.diagnostics[0].message, /branch 1 waits to write 'c', branch 2 waits to write 'd'/);
  const unmatched = run(MAIN('    chan<int> c;\n    par {\n        { c.write(1); c.write(2); }\n        println(c.read());\n    }'));
  assert.deepEqual(unmatched.codes, ['pj/par-deadlock']);
  assert.match(unmatched.diagnostics[0].message, /branch 1 waits to write 'c' but every other branch has finished/);
  const fine = run(MAIN('    chan<int> c;\n    chan<int> d;\n    par {\n        { c.write(1); int x = d.read(); println(x); }\n        { int y = c.read(); d.write(y + 1); }\n    }'));
  assert.deepEqual(fine.codes, []);
  // Opaque branches (a loop, a call that takes a channel) switch the simulation off.
  const opaque = run(MAIN('    chan<int> c;\n    par {\n        while (true) c.write(1);\n        println(c.read());\n    }'));
  assert.deepEqual(opaque.codes, []);
});

test('par for: outer variables and non-shared ends are shared by every iteration', () => {
  const r = run(MAIN('    chan<int> c;\n    int sum = 0;\n    par for (int i = 0; i < 3; i++) {\n        sum += i;\n        c.write(i);\n    }\n    for (int j = 0; j < 3; j++) println(c.read() + sum);'));
  assert.deepEqual(r.codes.sort(), ['pj/parallel-usage', 'pj/shared-channel-end']);
  assert.equal(r.diagnostics.find((d) => d.code === 'pj/shared-channel-end')?.fix?.kind, 'make-shared');
});

test('pri alt with skip before other guards, trivial alt and par, unreachable code, assignment in condition, barrier not enrolled', () => {
  const r = run(MAIN('    int v = 0;\n    boolean b = true;\n    string s = "x";\n    string t = "y";\n    barrier bar;\n    pri alt {\n        skip : { v = 1; }\n        v = c.read() : { }\n    }\n    alt { v = c.read() : { } }\n    par { println(v); }\n    if (b = true) { }\n    if (s == "x") { }\n    if (s == t) { }\n    bar.sync();\n    return;\n    println(v);', 'public void f(chan<int>.read c) { }').replace('public void main(string[] args) {', 'public void main(string[] args) {\n    chan<int>.read c;'));
  const codes = new Set(r.codes);
  for (const c of ['pj/pri-alt-skip', 'pj/trivial-alt', 'pj/trivial-par', 'pj/unreachable', 'pj/assign-in-condition', 'pj/barrier-not-enrolled']) assert.ok(codes.has(c), `${c} in ${[...codes].join(', ')}`);
  assert.ok(!codes.has('pj/string-identity'));
});

test('a procedure that suspends only through calls gets a [yield=true] quick fix', () => {
  const r = run('import std.*;\n\npublic void wait1() { timer t; t.timeout(1); }\n\npublic void twice() { wait1(); wait1(); }\n\npublic void marked() [yield=true] { wait1(); }\n\npublic void main(string[] args) { twice(); marked(); println("ok"); }\n');
  const hits = r.diagnostics.filter((d) => d.code === 'pj/needs-yield-annotation');
  assert.deepEqual(hits.map((d) => d.line + 1), [5, 9]);
  assert.deepEqual(hits[0].fix, { kind: 'edit', title: 'Add [yield=true]', line: 4, col: 20, endCol: 20, text: '[yield=true] ' });
});

test('reads that must be their own statement: inside ?:, inside a write value; calls as whole conditions', () => {
  const r = run(MAIN('    chan<int> c;\n    chan<int> d;\n    boolean flag = true;\n    par {\n        c.write(1);\n        { int x = flag ? c.read() : 7; println(x); }\n    }\n    par {\n        c.write(2);\n        d.write(c.read() + 1);\n        println(d.read());\n    }\n    if (ready(1)) println("r");\n    while (!ready(2)) { break; }\n    if (ready(3) && flag) println("fine");', 'public boolean ready(int n) { return n > 0; }'));
  const placement = r.diagnostics.filter((d) => d.code === 'pj/read-placement');
  assert.deepEqual(placement.map((d) => d.line + 1), [9, 13]);
  assert.equal(placement[1].fix?.title, "Read into 'read13' first");
  assert.equal(placement[1].fix?.text, 'int read13 = c.read();\n        d.write(read13 + 1)');
  const calls = r.diagnostics.filter((d) => d.code === 'pj/call-as-condition');
  assert.deepEqual(calls.map((d) => d.line + 1), [16, 17]);
  assert.equal(calls[0].fix?.text, ' == true');
});

test('unused and shadowed variables, constants; nothing about compiler internals', () => {
  const r = run(MAIN('    timer t;\n    int index = 0;\n    int dead;\n    int args = 1;\n    const int k = args;\n    alt {\n        v = c.read() : { }\n        t.timeout(100) : { }\n    }\n    alt { v = c.read() : { } }\n    t.timeout(5);\n    println(index + k);', 'public void f(chan<int>.read c, int v) { }').replace('public void main(string[] args) {', 'public void main(string[] args) {\n    chan<int>.read c; int v;'));
  const codes = new Set(r.codes);
  for (const c of ['pj/unused', 'pj/shadows-parameter', 'pj/type/const-init']) assert.ok(codes.has(c), `${c} in ${[...codes].join(', ')}`);
  for (const c of ['pj/alt-timeout', 'pj/multiple-alts', 'pj/reserved-alt-name', 'pj/timeout-noop']) assert.ok(!codes.has(c), `${c} must not be reported`);
  assert.ok(r.messages.some((m) => /'dead' is never used/.test(m)));
});

test("missing 'import std.*' is reported once with a fix, and nothing else is blamed on it", () => {
  const r = run('public void main(string[] args) {\n    println("hi");\n    print("x");\n}\n');
  assert.deepEqual(r.codes, ['pj/missing-import', 'pj/missing-import']);
  assert.equal(r.diagnostics[0].fix?.kind, 'add-import');
});

test('a correct program produces no diagnostics at all', () => {
  const src = [
    'import std.*;',
    '',
    'const int N = 3;',
    'record Pair { int a; int b; }',
    '',
    'public void producer(chan<Pair>.write out) {',
    '    for (int i = 0; i < N; i++) out.write(new Pair { a = i, b = i * i });',
    '}',
    '',
    'public void consumer(chan<Pair>.read in, chan<int>.write done) {',
    '    int sum = 0;',
    '    for (int i = 0; i < N; i++) {',
    '        Pair p = in.read();',
    '        sum += p.a + p.b;',
    '    }',
    '    done.write(sum);',
    '}',
    '',
    'public void main(string[] args) {',
    '    chan<Pair> c;',
    '    chan<int> d;',
    '    par {',
    '        producer(c.write);',
    '        consumer(c.read, d.write);',
    '    }',
    '    println("sum " + d.read());',
    '}',
  ].join('\n');
  const r = run(src);
  assert.deepEqual(r.messages, []);
  assert.ok(r.types.size > 20, 'expression types recorded');
});
