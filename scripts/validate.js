#!/usr/bin/env node
/**
 * Empirical validation: does the real ProcessJ program behave the way the checker
 * says? For every example, run the checker, then build with the real compiler and
 * run the program with a timeout.
 *
 *   - a program the checker says will block must NOT finish (times out)
 *   - a program the checker calls clean must finish with exit code 0
 *   - everything else is reported for inspection
 *
 * Needs a ProcessJ install (see README). Usage: npm run build && node scripts/validate.js [timeoutMs]
 */
const fs = require('node:fs');
const path = require('node:path');
const { findInstall } = require('../dist/src/config.js');
const { parse } = require('../dist/src/parser/parser.js');
const { check } = require('../dist/src/checker/checker.js');
const { DeclIndex } = require('../dist/src/checker/index.js');
const { DEFAULT_MAX_IMPORTED_FILES } = require('../dist/src/checker/reachable.js');
const { importDiagnostics, resolveImports } = require('../dist/src/imports.js');
const { build, run } = require('../dist/src/pipeline.js');

const BLOCKING = new Set(['pj/channel-no-writer', 'pj/channel-no-reader', 'pj/channel-self-deadlock', 'pj/par-deadlock', 'pj/starving-loop']);
const RACES = new Set(['pj/parallel-usage', 'pj/shared-channel-end']);
// These diagnostics describe compiler output that runs but is observably wrong,
// rather than a checker false positive. Keep this evidence-backed list narrow.
const RUNNING_COMPILER_BUGS = new Set(['pj/type/const-init']);
const args = process.argv.slice(2);
const runTimeout = Number(args.find((a) => /^\d+$/.test(a))) || 8000;
const dir = path.resolve(args.find((a) => !/^\d+$/.test(a)) ?? path.join(__dirname, '..', 'examples'));

const found = findInstall();
if ('error' in found) {
  console.error(found.error);
  process.exit(2);
}
const install = found;

function verdictOf(codes) {
  if (codes.some((c) => BLOCKING.has(c))) return 'blocks';
  if (codes.length === 0) return 'clean';
  return 'other';
}

/** Disk-backed counterpart of the server's bounded, call-driven import analysis. */
function analyzeFile(program, file, text, rootResolution) {
  const sourceCache = new Map([[path.resolve(file), { program, text }]]);
  const sourceFor = (requested) => {
    const absolute = path.resolve(requested);
    if (sourceCache.has(absolute)) return sourceCache.get(absolute);
    try {
      const source = fs.readFileSync(absolute, 'utf8');
      const loaded = { program: parse(source).program, text: source };
      sourceCache.set(absolute, loaded);
      return loaded;
    } catch {
      sourceCache.set(absolute, undefined);
      return undefined;
    }
  };
  const index = new DeclIndex();
  const rootDeclarations = new Set(program.decls.filter((declaration) => declaration.kind === 'ProcDecl'));
  const declarationFiles = new Map();
  const trustedNonBlockingNativeDeclarations = new Set();
  const includeRoot = path.resolve(install.includeDir);
  const isCompilerStdHeader = (owner) => {
    const absolute = path.resolve(owner);
    const relative = path.relative(includeRoot, absolute);
    return relative !== '' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      && path.basename(path.dirname(absolute)) === 'std';
  };
  const register = (loaded, owner) => {
    for (const declaration of loaded.decls) {
      if (declaration.kind !== 'ProcDecl') continue;
      declarationFiles.set(declaration, path.resolve(owner));
      if (isCompilerStdHeader(owner)
        && (declaration.name.name === 'print' || declaration.name.name === 'println')
        && declaration.modifiers.includes('native')
        && !declaration.modifiers.includes('mobile')
        && !declaration.body
        && !declaration.annotations.some((annotation) => annotation.name === 'yield' && annotation.value === 'true')) {
        trustedNonBlockingNativeDeclarations.add(declaration);
      }
    }
  };
  index.addProgram(program, file);
  for (const dependency of rootResolution.files) {
    const loaded = sourceFor(dependency)?.program;
    if (!loaded) continue;
    index.addProgram(loaded, dependency);
    register(loaded, dependency);
  }

  const unitCache = new Map();
  let checkedFiles = 0;
  const load = (requested) => {
    const absolute = path.resolve(requested);
    if (unitCache.has(absolute)) return unitCache.get(absolute);
    if (checkedFiles >= DEFAULT_MAX_IMPORTED_FILES) return undefined;
    const source = sourceFor(absolute);
    if (!source) {
      unitCache.set(absolute, undefined);
      return undefined;
    }
    checkedFiles++;
    const resolution = resolveImports(source.program, absolute, [dir], install.includeDir);
    const importedIndex = new DeclIndex();
    importedIndex.addProgram(source.program, absolute);
    register(source.program, absolute);
    for (const dependency of resolution.files) {
      const loaded = sourceFor(dependency)?.program;
      if (!loaded) continue;
      importedIndex.addProgram(loaded, dependency);
      register(loaded, dependency);
    }
    const importedChecked = check(source.program, {
      index: importedIndex,
      importsStd: resolution.importsStd,
      unresolvedImports: resolution.imports.some((entry) => entry.files.length === 0),
      text: source.text,
      trustedNonBlockingNativeDeclarations,
    });
    const unit = { program: source.program, checked: importedChecked, file: absolute, dependencies: resolution.files };
    unitCache.set(absolute, unit);
    return unit;
  };
  const emptyCalls = new Map();
  const yieldCallProvider = (declaration) => {
    if (rootDeclarations.has(declaration)) return undefined;
    const owner = declarationFiles.get(declaration);
    const unit = owner && load(owner);
    return unit ? { calls: unit.checked.calls, complete: true } : { calls: emptyCalls, complete: false };
  };
  const checked = check(program, {
    index,
    importsStd: rootResolution.importsStd,
    unresolvedImports: rootResolution.imports.some((entry) => entry.files.length === 0),
    text,
    yieldCallProvider,
    trustedNonBlockingNativeDeclarations,
  });
  return { index, checked, yieldCallProvider };
}

(async () => {
  const rows = [];
  let failures = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.pj')).sort()) {
    const file = path.join(dir, f);
    const src = fs.readFileSync(file, 'utf8');
    const parsed = parse(src);
    const res = resolveImports(parsed.program, file, [dir], install.includeDir);
    const { index, checked, yieldCallProvider } = analyzeFile(parsed.program, file, src, res);
    const codes = [...new Set([...parsed.errors.map(() => 'pj/syntax'), ...importDiagnostics(res, true), ...checked.diagnostics].filter((d) => d.severity !== 'info').map((d) => d.code ?? d))].sort();
    const verdict = verdictOf(codes);
    const hasMain = parsed.program.decls.some((d) => d.kind === 'ProcDecl' && d.name.name === 'main');

    const built = await build(install, file, src, {
      timeoutMs: 90_000,
      // Match the server's private compiler-buffer rewrite exactly, including
      // yield propagation through imported and overloaded procedures.
      yieldContext: { program: parsed.program, index, calls: checked.calls, callProvider: yieldCallProvider },
    });
    let actual;
    let detail = '';
    if (!built.ok) {
      const failed = built.stages.find((s) => !s.ok);
      const crashed = /Exception in thread "main"/.test(failed?.output ?? '');
      actual = crashed ? 'compiler crashed' : `build failed at ${failed?.name}`;
      detail = (failed?.output ?? '').split('\n').find((l) => /error|Exception|rror\[/.test(l)) ?? '';
    } else if (!hasMain) {
      actual = 'no main (not runnable)';
    } else {
      const r = await run(install, built, { timeoutMs: runTimeout });
      const out = r.output.split('\n').filter((l) => l && !/^\[Scheduler\]|^Total execution/.test(l));
      if (r.timedOut) actual = `hangs (>${runTimeout / 1000}s)`;
      else actual = r.exitCode === 0 ? 'finishes' : `exit ${r.exitCode}`;
      detail = out.slice(0, 3).join(' | ').slice(0, 90);
    }
    built.sandbox.cleanup();

    let ok = 'n/a';
    if (verdict === 'blocks') ok = actual.startsWith('hangs') ? 'CONFIRMED' : 'MISMATCH';
    if (verdict === 'clean') ok = actual === 'finishes' ? 'CONFIRMED' : actual.startsWith('build failed') ? 'MISSING RULE?' : actual.startsWith('hangs') ? 'hangs (design?)' : actual.startsWith('no main') || actual === 'compiler crashed' ? 'n/a' : 'MISMATCH';
    if (verdict === 'blocks' && actual.startsWith('no main')) ok = 'n/a';
    // Errors from the checker but the program builds and runs: look at it, it may be a false positive.
    // Races are expected to run; their result is just not reliable.
    const hasErrors = checked.diagnostics.some((d) => d.severity === 'error' && !RACES.has(d.code));
    const onlyRaces = checked.diagnostics.some((d) => RACES.has(d.code)) && !hasErrors;
    const knownMiscompile = checked.diagnostics.some((d) => RUNNING_COMPILER_BUGS.has(d.code));
    if (verdict === 'other' && actual === 'finishes') ok = onlyRaces ? 'race (runs)' : knownMiscompile ? 'compiler bug (runs)' : hasErrors ? 'FALSE POSITIVE?' : ok;
    // This compiler build cannot link user-library imports; that is not a checker gap.
    const userImports = res.imports.some((i) => i.userLibrary);
    if (verdict === 'clean' && actual.startsWith('build failed') && userImports) ok = 'compiler limit (imports)';
    if (ok === 'MISMATCH' || ok === 'MISSING RULE?') failures++;
    rows.push({ f, verdict, codes: codes.join(', ') || '-', actual, ok, detail });
  }
  const w = (s, n) => String(s).padEnd(n);
  console.log(`${w('example', 22)} ${w('checker says', 13)} ${w('real program', 22)} ${w('result', 10)} output / error`);
  for (const r of rows) console.log(`${w(r.f, 22)} ${w(r.verdict, 13)} ${w(r.actual, 22)} ${w(r.ok, 10)} ${r.detail}`);
  console.log(`\n${rows.filter((r) => r.ok === 'CONFIRMED').length} confirmed, ${failures} to investigate (missing rule or mismatch), ${rows.filter((r) => r.ok === 'FALSE POSITIVE?').length} possible false positives, ${rows.filter((r) => r.ok === 'n/a' || r.ok.startsWith('hangs')).length} informational`);
  process.exit(failures ? 1 : 0);
})();
