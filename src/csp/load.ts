/**
 * Load a ProcessJ file from disk with its imports, checked the way the server
 * checks an open document, ready for translation. Used by scripts/pj2csp.js
 * and the tests; the server builds the same units from its caches.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as A from '../parser/ast';
import { check } from '../checker/checker';
import { DeclIndex } from '../checker/index';
import { resolveImports } from '../imports';
import { parse } from '../parser/parser';
import type { CspUnit } from './translate';

export interface LoadedProgram {
  units: CspUnit[];
  index: DeclIndex;
  /** Syntax errors of the root file. */
  syntaxErrors: string[];
}

/**
 * Parse and check `file` (or `text` as its contents) against its imports and
 * the headers under `includeDir`. Imported files become units of their own,
 * checked in their own import scope, so calls into them can be translated.
 */
export function loadProgram(file: string, includeDir: string | undefined, text?: string, roots: string[] = []): LoadedProgram {
  const source = text ?? fs.readFileSync(file, 'utf8');
  const parsed = parse(source);
  const syntaxErrors = parsed.errors.map((e) => `${path.basename(file)}:${e.line + 1}:${e.col + 1}: ${e.message}`);
  const cache = new Map<string, { program: A.Program; text: string; comments: ReturnType<typeof parse>['comments'] } | undefined>();
  const read = (f: string) => {
    const abs = path.resolve(f);
    if (cache.has(abs)) return cache.get(abs);
    try {
      const t = fs.readFileSync(abs, 'utf8');
      const p = parse(t);
      const entry = { program: p.program, text: t, comments: p.comments };
      cache.set(abs, entry);
      return entry;
    } catch {
      cache.set(abs, undefined);
      return undefined;
    }
  };
  const indexFor = (program: A.Program, own: string): { index: DeclIndex; importsStd: boolean; unresolved: boolean; files: string[]; trusted: Set<A.ProcDecl> } => {
    const res = resolveImports(program, own, roots, includeDir);
    const index = new DeclIndex();
    index.addProgram(program, own);
    const trusted = new Set<A.ProcDecl>();
    for (const dep of res.files) {
      const loaded = read(dep);
      if (!loaded) continue;
      index.addProgram(loaded.program, dep);
      if (path.basename(path.dirname(dep)) === 'std') {
        for (const d of loaded.program.decls) {
          if (d.kind === 'ProcDecl' && (d.name.name === 'print' || d.name.name === 'println') && !d.body) trusted.add(d);
        }
      }
    }
    return { index, importsStd: res.importsStd, unresolved: res.imports.some((i) => i.files.length === 0), files: res.files, trusted };
  };
  const root = indexFor(parsed.program, file);
  const checked = check(parsed.program, { index: root.index, importsStd: root.importsStd, unresolvedImports: root.unresolved, text: source, trustedNonBlockingNativeDeclarations: root.trusted });
  const units: CspUnit[] = [{ program: parsed.program, checked, file, uri: pathToFileURL(file).href, text: source, comments: parsed.comments }];
  // Imported files with procedure bodies (not the include directory's native headers).
  const seen = new Set<string>([path.resolve(file)]);
  const queue = [...root.files];
  while (queue.length) {
    const dep = path.resolve(queue.shift()!);
    if (seen.has(dep)) continue;
    seen.add(dep);
    const loaded = read(dep);
    if (!loaded || !loaded.program.decls.some((d) => d.kind === 'ProcDecl' && d.body)) continue;
    const scope = indexFor(loaded.program, dep);
    const depChecked = check(loaded.program, { index: scope.index, importsStd: scope.importsStd, unresolvedImports: scope.unresolved, text: loaded.text, trustedNonBlockingNativeDeclarations: scope.trusted });
    units.push({ program: loaded.program, checked: depChecked, file: dep, uri: pathToFileURL(dep).href, text: loaded.text, comments: loaded.comments });
    queue.push(...scope.files);
  }
  return { units, index: root.index, syntaxErrors };
}
