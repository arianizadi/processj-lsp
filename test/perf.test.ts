import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { astSymbols } from '../src/astsymbols';
import { check } from '../src/checker/checker';
import { analyzeProcedureEffects } from '../src/checker/effects';
import { DeclIndex } from '../src/checker/index';
import { analyzeProtocols, effectiveProtocolCases } from '../src/checker/protocols';
import { analyzeReachableCalls, type ReachableUnit } from '../src/checker/reachable';
import { buildConcurrencyGraph } from '../src/concurrency';
import { channelInlays } from '../src/inlays';
import { semanticTokens } from '../src/semantic';
import { format } from '../src/format';
import { parse } from '../src/parser/parser';
import { withYieldAnnotations } from '../src/yieldfix';
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
  const index = new DeclIndex();
  index.addProgram(p.value.program, 'big.pj');
  const c = time(() => check(p.value.program, { index, importsStd: true, unresolvedImports: true }));
  const e = time(() => analyzeProcedureEffects([{ program: p.value.program, checked: c.value, file: 'big.pj' }]));
  const protocols = time(() => analyzeProtocols(p.value.program, index, c.value, { file: 'big.pj', sourceText: src, tokens: p.value.tokens }));
  const graph = time(() => buildConcurrencyGraph(p.value.program, c.value, index, { uri: 'file:///big.pj', effects: e.value.summaries }));
  const hints = time(() => channelInlays(p.value.program, c.value, e.value));
  const t = time(() => semanticTokens(p.value.program, c.value, index));
  const f = time(() => format(src));

  console.log(`  ${lineCount} lines: parse ${p.ms.toFixed(0)} ms, symbols ${s.ms.toFixed(0)} ms, check ${c.ms.toFixed(0)} ms, effects ${e.ms.toFixed(0)} ms, protocols ${protocols.ms.toFixed(0)} ms, graph ${graph.ms.toFixed(0)} ms, inlays ${hints.ms.toFixed(0)} ms, semantic ${t.ms.toFixed(0)} ms, format ${f.ms.toFixed(0)} ms, ${p.value.tokens.length} tokens`);
  assert.equal(p.value.errors.length, 0, JSON.stringify(p.value.errors.slice(0, 3)));
  assert.ok(f.value.text, 'formatted');
  assert.ok(t.value.length > 1000, 'semantic tokens produced');
  assert.equal(graph.value.version, 1, 'concurrency graph produced');
  assert.ok(Array.isArray(protocols.value.protocols), 'protocol facts produced');
  assert.ok(Array.isArray(hints.value), 'channel inlays produced');

  // Budgets are generous for slow CI machines; a laptop should be several times faster.
  assert.ok(p.ms < 1500, `parse took ${p.ms} ms`);
  assert.ok(s.ms < 500, `symbols took ${s.ms} ms`);
  assert.ok(c.ms < 2500, `check took ${c.ms} ms`);
  assert.ok(e.ms < 1500, `effect analysis took ${e.ms} ms`);
  assert.ok(protocols.ms < 1500, `protocol analysis took ${protocols.ms} ms`);
  assert.ok(graph.ms < 1500, `concurrency graph took ${graph.ms} ms`);
  assert.ok(hints.ms < 750, `channel inlays took ${hints.ms} ms`);
  assert.ok(t.ms < 1000, `semantic tokens took ${t.ms} ms`);
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

test('procedure effect analysis does not rescan every variable for every procedure', () => {
  const prepare = (targetLines: number) => {
    const source = bigProgram(targetLines);
    const parsed = parse(source);
    const index = new DeclIndex();
    index.addProgram(parsed.program, 'big.pj');
    const checked = check(parsed.program, { index, importsStd: true, unresolvedImports: true });
    const analyze = () => analyzeProcedureEffects([{ program: parsed.program, checked, file: 'big.pj' }]);
    analyze(); // JIT warm-up
    return { lines: source.split('\n').length, analyze };
  };

  const small = prepare(10_000);
  const large = prepare(50_000);
  const a = time(small.analyze).ms;
  const b = time(large.analyze).ms;
  const ratioLines = large.lines / small.lines;
  console.log(`  effects: ${small.lines} lines ${a.toFixed(1)} ms; ${large.lines} lines ${b.toFixed(1)} ms; ratio ${(b / Math.max(a, 0.1)).toFixed(1)}x for ${ratioLines.toFixed(1)}x lines`);
  assert.ok(b / Math.max(a, 0.1) < ratioLines * 3, 'effect analysis became superlinear');
});

test('yield propagation is stack-safe across a thousand-procedure call chain', () => {
  const count = 1_200;
  const source = Array.from({ length: count }, (_, index) => index + 1 === count
    ? `void p${index}() { timer clock; clock.timeout(1); }`
    : `void p${index}() { p${index + 1}(); }`).join('\n');
  const augmented = time(() => withYieldAnnotations(source));
  assert.match(augmented.value, /^void p0\(\) \[yield=true\]/);
  assert.match(augmented.value, /void p1198\(\) \[yield=true\]/);
  assert.match(augmented.value, /void p1199\(\) \{ timer clock;/, 'the compiler already detects the direct timeout');
  assert.ok(augmented.ms < 3000, `1,200-procedure yield propagation took ${augmented.ms} ms`);
  console.log(`  yield chain: ${count} procedures in ${augmented.ms.toFixed(1)} ms`);
});

test('call-driven imported analysis stays bounded across a deep file chain', () => {
  const count = 120;
  const parsed = Array.from({ length: count }, (_, index) => {
    const source = index + 1 === count
      ? `void p${index}(chan<int>.read input) { int value = input.read(); }`
      : `void p${index}(chan<int>.read input) { p${index + 1}(input); }`;
    return { file: `/workspace/p${index}.pj`, source, program: parse(source).program };
  });
  const rootSource = 'void entry(chan<int>.read source) { p0(source); }';
  const rootProgram = parse(rootSource).program;
  const rootIndex = new DeclIndex();
  rootIndex.addProgram(rootProgram, '/workspace/root.pj');
  rootIndex.addProgram(parsed[0].program, parsed[0].file);
  const rootChecked = check(rootProgram, { index: rootIndex, text: rootSource });
  const load = (file: string): ReachableUnit | undefined => {
    const index = Number(/p(\d+)\.pj$/.exec(file)?.[1]);
    const source = parsed[index];
    if (!source) return undefined;
    const declarations = new DeclIndex();
    declarations.addProgram(source.program, source.file);
    const next = parsed[index + 1];
    if (next) declarations.addProgram(next.program, next.file);
    return {
      program: source.program,
      checked: check(source.program, { index: declarations, text: source.source }),
      file: source.file,
      dependencies: next ? [next.file] : [],
    };
  };
  const reached = time(() => analyzeReachableCalls({ program: rootProgram, checked: rootChecked, file: '/workspace/root.pj' }, {
    rootDependencies: [parsed[0].file],
    load,
  }));
  const effects = time(() => analyzeProcedureEffects(reached.value.units));
  const entry = rootProgram.decls.find((declaration) => declaration.kind === 'ProcDecl')!;
  assert.equal(reached.value.units.length, count + 1);
  assert.equal(reached.value.truncated, false);
  assert.equal(effects.value.get(entry)?.transitive.channelRead, true);
  assert.ok(reached.ms < 1500, `${count}-file reachable import walk took ${reached.ms} ms`);
  console.log(`  reachable imports: ${count} files checked in ${reached.ms.toFixed(1)} ms; effects ${effects.ms.toFixed(1)} ms`);
});

test('protocol analysis stores long inheritance chains linearly', () => {
  const prepare = (count: number) => {
    const source = Array.from({ length: count }, (_, index) =>
      `protocol P${index}${index === 0 ? '' : ` extends P${index - 1}`} { c${index}: { } }`,
    ).join('\n');
    const parsed = parse(source);
    assert.equal(parsed.errors.length, 0, JSON.stringify(parsed.errors.slice(0, 3)));
    const index = new DeclIndex();
    index.addProgram(parsed.program, 'protocol-chain.pj');
    return () => analyzeProtocols(parsed.program, index, undefined, {
      file: 'protocol-chain.pj',
      tokens: parsed.tokens,
    });
  };

  const analyzeSmall = prepare(250);
  const analyzeLarge = prepare(750);
  analyzeSmall(); // JIT warm-up
  const small = time(analyzeSmall);
  const large = time(analyzeLarge);
  const storedCases = large.value.protocols.reduce((sum, protocol) => sum + protocol.cases.length, 0);
  const storedCollisions = large.value.protocols.reduce((sum, protocol) => sum + protocol.collisions.length, 0);
  const effectiveCases = time(() => effectiveProtocolCases(large.value.protocols, 'P749'));
  console.log(`  protocols: 250-deep ${small.ms.toFixed(1)} ms; 750-deep ${large.ms.toFixed(1)} ms; ${storedCases} stored cases`);

  // Each declaration and case must occur once in the wire model. The previous
  // eager representation stored every ancestor case (and its full path) in
  // every descendant, consuming roughly a GiB for this otherwise tiny input.
  assert.equal(storedCases, 750, 'inherited case facts were eagerly duplicated');
  assert.equal(storedCollisions, 0, 'a unique-case chain cannot introduce collisions');
  assert.equal(effectiveCases.value.length, 750, 'on-demand effective case lookup lost inherited cases');
  assert.equal(effectiveCases.value.at(-1)?.inheritanceDepth, 749);
  assert.ok(large.ms < 1500, `750-deep protocol analysis took ${large.ms} ms`);
  assert.ok(effectiveCases.ms < 500, `on-demand 750-case resolution took ${effectiveCases.ms} ms`);
  assert.ok(large.ms / Math.max(small.ms, 1) < 12, 'long-chain protocol analysis became superlinear');
});

test('protocol collision discovery ignores unrelated duplicated case names', () => {
  const prepare = (count: number) => {
    const declarations: string[] = [];
    for (let index = 0; index < count; index++) {
      declarations.push(`protocol A${index} { c${index}: { } }`);
      declarations.push(`protocol B${index} { c${index}: { } }`);
    }
    for (let index = 0; index < count; index++) declarations.push(`protocol D${index} extends A0, B0 { own${index}: { } }`);
    const parsed = parse(declarations.join('\n'));
    assert.equal(parsed.errors.length, 0, JSON.stringify(parsed.errors.slice(0, 3)));
    const index = new DeclIndex();
    index.addProgram(parsed.program, 'protocol-families.pj');
    return () => analyzeProtocols(parsed.program, index, undefined, { file: 'protocol-families.pj', tokens: parsed.tokens });
  };

  const analyzeSmall = prepare(250);
  const analyzeLarge = prepare(1500);
  analyzeSmall();
  const small = time(analyzeSmall);
  const large = time(analyzeLarge);
  assert.equal(large.value.collisions.length, 1500, 'the relevant A0/B0 collision was lost');
  assert.ok(large.ms < 750, `unrelated protocol collision analysis took ${large.ms} ms`);
  assert.ok(large.ms / Math.max(small.ms, 1) < 12, 'unrelated duplicated tags are being rescanned for every multi-parent protocol');
});

test('unique-case diamond ladders keep collision analysis memory linear', () => {
  // Isolate the regression under a modest heap cap. The old implementation
  // cached every parent's complete effective-case list and needed hundreds of
  // MiB for this 2,401-protocol input despite there being no possible collision.
  const script = `
    const { parse } = require(${JSON.stringify(require.resolve('../src/parser/parser'))});
    const { DeclIndex } = require(${JSON.stringify(require.resolve('../src/checker/index'))});
    const { analyzeProtocols } = require(${JSON.stringify(require.resolve('../src/checker/protocols'))});
    const declarations = ['protocol Root { rootCase: { } }'];
    let previous = 'Root';
    for (let index = 0; index < 800; index++) {
      const left = 'Left' + index;
      const right = 'Right' + index;
      const joined = 'Joined' + index;
      declarations.push('protocol ' + left + ' extends ' + previous + ' { leftCase' + index + ': { } }');
      declarations.push('protocol ' + right + ' extends ' + previous + ' { rightCase' + index + ': { } }');
      declarations.push('protocol ' + joined + ' extends ' + left + ', ' + right + ' { joinedCase' + index + ': { } }');
      previous = joined;
    }
    const parsed = parse(declarations.join('\\n'));
    if (parsed.errors.length) throw new Error(JSON.stringify(parsed.errors.slice(0, 3)));
    const index = new DeclIndex();
    index.addProgram(parsed.program, 'protocol-diamonds.pj');
    const heapBefore = process.memoryUsage().heapUsed;
    const started = process.hrtime.bigint();
    const result = analyzeProtocols(parsed.program, index, undefined, { file: 'protocol-diamonds.pj', tokens: parsed.tokens });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
    process.stdout.write(JSON.stringify({
      elapsedMs,
      heapGrowth,
      protocols: result.protocols.length,
      cases: result.protocols.reduce((sum, protocol) => sum + protocol.cases.length, 0),
      collisions: result.collisions.length,
    }));
  `;
  const child = spawnSync(process.execPath, ['--max-old-space-size=128', '-e', script], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(child.status, 0, `diamond-ladder analysis exceeded its heap/time budget:\n${child.stderr}`);
  const result = JSON.parse(child.stdout) as {
    elapsedMs: number;
    heapGrowth: number;
    protocols: number;
    cases: number;
    collisions: number;
  };
  console.log(`  protocol diamonds: ${result.protocols} protocols ${result.elapsedMs.toFixed(1)} ms; heap +${(result.heapGrowth / 1024 / 1024).toFixed(1)} MiB`);
  assert.deepEqual([result.protocols, result.cases, result.collisions], [2401, 2401, 0]);
  assert.ok(result.heapGrowth < 64 * 1024 * 1024, `diamond-ladder analysis grew the heap by ${result.heapGrowth} bytes`);
  assert.ok(result.elapsedMs < 1500, `diamond-ladder analysis took ${result.elapsedMs} ms`);
});
