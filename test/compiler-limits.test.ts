/**
 * Rules for programs the ProcessJ compiler accepts (or claims to) and then
 * mis-compiles or mis-runs. Every expectation here was derived by building and
 * running the program with the real compiler; the matching fixtures under
 * `test/differential/` re-check the outcome against it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from './checker.test';

const MAIN = (body: string, extra = '') => `import std.*;\n${extra}\npublic void main(string[] args) {\n${body}\n}\n`;

function of(src: string, code: string): Array<[number, string]> {
  return run(src).diagnostics.filter((d) => d.code === code).map((d) => [d.line, d.message]);
}

test('a timeout argument is an absolute deadline, so a bare delay is reported with a fix', () => {
  const hits = of(MAIN('    timer t;\n    t.timeout(300);\n    long later = t.read() + 300;\n    t.timeout(later);\n    t.timeout(t.read() + 300);'), 'pj/timeout-deadline');
  // Only the bare delay: a value already derived from the timer is a real deadline.
  assert.deepEqual(hits.map(([line]) => line), [4]);
  assert.match(hits[0][1], /absolute time to wake up, not how long to wait/);
  assert.match(hits[0][1], /t\.read\(\) \+ 300/);
  const fix = run(MAIN('    timer t;\n    t.timeout(300);')).diagnostics.find((d) => d.code === 'pj/timeout-deadline')?.fix;
  assert.deepEqual(fix, { kind: 'edit', title: "Wait from now: 't.read() + ...'", line: 4, col: 14, endCol: 14, text: 't.read() + ' });
});

test("'!' as a whole condition is a compiler limit, with the comparison as its fix", () => {
  const hits = of(MAIN('    boolean b = false;\n    int n = 7;\n    if (!b) println("a");\n    while (!(n > 5)) { n++; }\n    if (!b && n > 0) println("fine");\n    if (b == false) println("fine");'), 'pj/compiler-limit');
  assert.deepEqual(hits.map(([line]) => line), [5, 6]);
  assert.match(hits[0][1], /'!' as the whole condition of 'if'/);
  const fixes = run(MAIN('    boolean b = false;\n    if (!b) println("a");')).diagnostics.filter((d) => d.code === 'pj/compiler-limit').map((d) => d.fix?.text);
  assert.deepEqual(fixes, ['b == false']);
});

test('a negated call keeps its own diagnostic and now carries the comparison fix', () => {
  const r = run(MAIN('    if (!ready(1)) println("a");', 'public boolean ready(int n) { return n > 0; }'));
  const calls = r.diagnostics.filter((d) => d.code === 'pj/call-as-condition');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fix?.text, 'ready(1) == false');
  assert.deepEqual(r.diagnostics.filter((d) => d.code === 'pj/compiler-limit'), []);
});

test('a procedure that returns a value and can suspend cannot be compiled', () => {
  const hits = of('import std.*;\npublic int take(chan<int>.read c) { int v; v = c.read(); return v; }\npublic int twice(int n) { return n * 2; }\npublic int viaCall(chan<int>.read c) { return take(c); }\npublic void fine(chan<int>.read c) { int v; v = c.read(); println(v); }\npublic void main(string[] args) { }\n', 'pj/compiler-limit');
  assert.deepEqual(hits.map(([line]) => line), [1, 3]);
  assert.match(hits[0][1], /'take' returns int and can suspend/);
  assert.match(hits[0][1], /hand the result back through a channel parameter/);
});

test('a channel carrying string is a compiler limit wherever the type is written', () => {
  const hits = of('import std.*;\npublic void send(chan<string>.write out) { }\npublic void main(string[] args) {\n    chan<string> c;\n    chan<int> ok;\n}\n', 'pj/compiler-limit');
  assert.deepEqual(hits.map(([line]) => line), [1, 3]);
  assert.match(hits[0][1], /no wrapper type for string/);
});

test('a record or protocol literal is only compilable as a declaration initialiser', () => {
  const hits = of(MAIN('    Point p = new Point { x = 1, y = 2 };\n    Point q;\n    q = new Point { x = 3, y = 4 };\n    Point[] ps = new Point[2];\n    ps[0] = p;', 'record Point { int x; int y; }'), 'pj/compiler-limit');
  assert.deepEqual(hits.map(([line]) => line), [5]);
  assert.match(hits[0][1], /only be compiled as the initialiser of a declaration/);
});

test('per-process limits: a second alt or par for in one process, but not one per par branch', () => {
  const twoAlts = of('import std.*;\npublic void f(chan<int>.read a, chan<int>.read b) {\n    int x;\n    alt { x = a.read() : { } }\n    alt { x = b.read() : { } }\n}\npublic void main(string[] args) { }\n', 'pj/multiple-alts');
  assert.deepEqual(twoAlts.map(([line]) => line), [4]);
  assert.match(twoAlts[0][1], /second alt in the same process/);

  // One alt per par branch is one alt per generated class, which the compiler accepts.
  const perBranch = run('import std.*;\npublic void f(chan<int>.read a, chan<int>.read b) {\n    int x;\n    par {\n        alt { x = a.read() : { } }\n        alt { x = b.read() : { } }\n    }\n}\npublic void main(string[] args) { }\n');
  assert.deepEqual(perBranch.diagnostics.filter((d) => d.code === 'pj/multiple-alts'), []);

  const twoParFors = of(MAIN('    par for (int i = 0; i < 2; i++) println("a" + i);\n    par for (int j = 0; j < 2; j++) println("b" + j);'), 'pj/compiler-limit');
  assert.deepEqual(twoParFors.map(([line]) => line), [4]);
  assert.match(twoParFors[0][1], /second 'par for' in the same process/);
});

test('a par for body with several statements runs each of them as its own process', () => {
  const hits = of(MAIN('    par for (int i = 0; i < 2; i++) {\n        int x = i * 10;\n        println("x=" + x);\n    }'), 'pj/par-for-body');
  assert.deepEqual(hits.map(([line]) => line), [3]);
  assert.match(hits[0][1], /Each of these 2 statements becomes its own process/);
  assert.match(hits[0][1], /Wrap the body in an inner '\{ \.\.\. \}' block/);
  assert.match(hits[0][1], /run in parallel rather than in sequence/);

  const wrapped = run(MAIN('    par for (int i = 0; i < 2; i++) {\n        {\n            int x = i * 10;\n            println("x=" + x);\n        }\n    }'));
  assert.deepEqual(wrapped.diagnostics.filter((d) => d.code === 'pj/par-for-body'), []);
  const single = run(MAIN('    par for (int i = 0; i < 2; i++) println("i=" + i);'));
  assert.deepEqual(single.diagnostics.filter((d) => d.code === 'pj/par-for-body'), []);
});

test('an alt timeout guard takes a plain deadline: a read inside it is a compiler limit', () => {
  const src = MAIN('    chan<int> c;\n    timer t;\n    int x;\n    long deadline = t.read() + 1000;\n    par {\n        c.write(1);\n        alt {\n            x = c.read() : { println("read " + x); }\n            t.timeout(t.read() + 1000) : { println("late"); }\n        }\n    }\n    alt {\n        x = c.read() : { }\n        t.timeout(deadline) : { }\n    }');
  const r = run(src);
  const limits = r.diagnostics.filter((d) => d.code === 'pj/compiler-limit' && /alt timeout guard/.test(d.message));
  assert.deepEqual(limits.map((d) => d.line), [11]);
  assert.match(limits[0].message, /compute the deadline into a variable before the alt/);

  // The constant-delay advice inside an alt cannot be the inline rewrite, which
  // would itself fail to compile there.
  const inAlt = run(MAIN('    chan<int> c;\n    timer t;\n    int x;\n    par {\n        c.write(1);\n        alt {\n            x = c.read() : { }\n            t.timeout(1000) : { }\n        }\n    }'));
  const deadline = inAlt.diagnostics.find((d) => d.code === 'pj/timeout-deadline');
  assert.equal(deadline?.fix, undefined);
  assert.match(deadline?.message ?? '', /Set 'long deadline = t\.read\(\) \+ 1000;' before the alt/);
});
