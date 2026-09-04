import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { check } from '../src/checker/checker';
import { analyzeProcedureEffects } from '../src/checker/effects';
import { DeclIndex } from '../src/checker/index';
import { analyzeReachableCalls, type ReachableUnit } from '../src/checker/reachable';
import { YieldAnalysis } from '../src/checker/yields';
import type * as A from '../src/parser/ast';
import { parse } from '../src/parser/parser';

test('reachable imports preserve exact overload yield and transitive parameter effects', () => {
  const files = new Map<string, { source: string; program: A.Program; imports: string[] }>();
  const add = (name: string, source: string, imports: string[] = []): string => {
    const file = path.resolve('/workspace', name);
    const parsed = parse(source);
    assert.deepEqual(parsed.errors, [], `${name} must parse`);
    files.set(file, { source, program: parsed.program, imports: imports.map((dependency) => path.resolve('/workspace', dependency)) });
    return file;
  };
  const dep = add('dep.pj', [
    'void leaf(int value) { }',
    'void leaf(chan<int>.read input) { int value = input.read(); }',
    'void neutral() { leaf(1); }',
    'void relay(chan<int>.read input) { leaf(input); }',
  ].join('\n'));
  const bridge = add('bridge.pj', 'void bridge(chan<int>.read input) { relay(input); }', ['dep.pj']);
  const rootFile = add('root.pj', [
    'void ordinary() { neutral(); }',
    'void entry(chan<int>.read source) { bridge(source); }',
  ].join('\n'), ['dep.pj', 'bridge.pj']);

  const unitCache = new Map<string, ReachableUnit>();
  const checkedUnit = (file: string): ReachableUnit => {
    const cached = unitCache.get(file);
    if (cached) return cached;
    const source = files.get(file)!;
    const index = new DeclIndex();
    index.addProgram(source.program, file);
    for (const dependency of source.imports) index.addProgram(files.get(dependency)!.program, dependency);
    const unit = {
      file,
      program: source.program,
      checked: check(source.program, { index, text: source.source }),
      dependencies: source.imports,
    };
    unitCache.set(file, unit);
    return unit;
  };

  const root = checkedUnit(rootFile);
  const ordinary = root.program.decls.find((decl): decl is A.ProcDecl => decl.kind === 'ProcDecl' && decl.name.name === 'ordinary')!;
  assert.equal(
    root.checked.diagnostics.some((diagnostic) => diagnostic.code === 'pj/needs-yield-annotation' && diagnostic.line === 0),
    false,
    'uncertain calls are not evidence for a missing-yield diagnostic',
  );
  assert.equal(
    new YieldAnalysis(new DeclIndex(), root.checked.calls).procYields(ordinary),
    true,
    'without the imported scope, safety analysis treats the call chain as may-yield',
  );
  const declarationFiles = new Map<A.ProcDecl, string>();
  for (const [file, source] of files) {
    for (const declaration of source.program.decls) {
      if (declaration.kind === 'ProcDecl') declarationFiles.set(declaration, file);
    }
  }
  const rootIndex = new DeclIndex();
  rootIndex.addProgram(files.get(rootFile)!.program, rootFile);
  for (const dependency of files.get(rootFile)!.imports) rootIndex.addProgram(files.get(dependency)!.program, dependency);
  const yieldCallProvider = (declaration: A.ProcDecl) => {
    const owner = declarationFiles.get(declaration);
    if (!owner || owner === rootFile) return undefined;
    return { calls: checkedUnit(owner).checked.calls, complete: true };
  };
  const exactRoot = check(root.program, {
    index: rootIndex,
    text: files.get(rootFile)!.source,
    yieldCallProvider,
  });
  assert.ok(
    !exactRoot.diagnostics.some((diagnostic) => diagnostic.code === 'pj/needs-yield-annotation' && diagnostic.line === 0),
    'the imported file\'s exact leaf(int) resolution must keep ordinary non-yielding',
  );
  assert.equal(new YieldAnalysis(rootIndex, exactRoot.calls, undefined, yieldCallProvider).procYields(ordinary), false);
  const reachable = analyzeReachableCalls(root, {
    rootDependencies: root.dependencies,
    load: checkedUnit,
  });
  assert.equal(reachable.truncated, false);
  assert.deepEqual(reachable.units.map((unit) => unit.file).sort(), [rootFile, dep, bridge].sort());
  assert.deepEqual([...reachable.dependencies].sort(), [dep, bridge].sort());

  const yieldAnalysis = new YieldAnalysis(new DeclIndex(), root.checked.calls, reachable.calls);
  assert.equal(yieldAnalysis.procYields(ordinary), false, 'leaf(int) must not inherit the channel overload\'s yield behavior');

  const effects = analyzeProcedureEffects(reachable.units);
  const entry = root.program.decls.find((decl): decl is A.ProcDecl => decl.kind === 'ProcDecl' && decl.name.name === 'entry')!;
  const entryEffects = effects.get(entry)!;
  assert.equal(entryEffects.transitive.channelRead, true);
  assert.deepEqual([...entryEffects.transitive.channelReads], [0]);
  assert.equal(entryEffects.transitive.unknown, false);

  const bounded = analyzeReachableCalls(root, {
    rootDependencies: root.dependencies,
    maxImportedFiles: 1,
    load: checkedUnit,
  });
  assert.equal(bounded.units.length, 2);
  assert.equal(bounded.truncated, true, 'the import walk reports when it refuses to exceed its file budget');
  assert.equal(
    new YieldAnalysis(new DeclIndex(), root.checked.calls, bounded.calls).procYields(ordinary),
    true,
    'an omitted imported overload chain stays conservatively yielding instead of binding against the root scope',
  );

  const sharedLoaderBudget = analyzeReachableCalls(root, {
    rootDependencies: root.dependencies,
    load: () => undefined,
    loadTruncated: () => true,
  });
  assert.equal(sharedLoaderBudget.units.length, 1);
  assert.equal(sharedLoaderBudget.truncated, true, 'a loader that already spent its shared budget propagates truncation to the walk');
});
