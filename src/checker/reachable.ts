/**
 * Call-driven cross-file analysis support.
 *
 * A language server must know the bodies behind imported calls to summarize
 * effects and follow yieldability, but checking every file in a workspace (or
 * every module in `std.*`) on each keystroke is needlessly expensive.  This
 * walker starts with every procedure in the edited file and follows only exact,
 * body-bearing call targets.  The loader remains responsible for checking each
 * loaded file in that file's own import scope.
 */
import * as path from 'node:path';
import type * as A from '../parser/ast';
import type { EffectUnit } from './effects';
import type { ProcSig } from './index';

export interface ReachableUnit extends EffectUnit {
  file: string;
  /** Direct imports that can change this unit's overload resolution. */
  dependencies: readonly string[];
}

export interface ReachableCallAnalysis {
  /** Root first, followed by only the imported files reached by an exact call. */
  units: readonly EffectUnit[];
  /** Exact resolutions in all reachable procedure bodies, including the root. */
  calls: ReadonlyMap<A.Invocation, ProcSig>;
  /** Direct and transitive analysis inputs, for editor-cache invalidation. */
  dependencies: ReadonlySet<string>;
  /** True when the file budget prevented the walker from following every body. */
  truncated: boolean;
}

export interface ReachableCallOptions {
  /**
   * Load and check one file. Implementations should return stable AST objects:
   * selected declarations refer to those objects by identity.
   */
  load(file: string): ReachableUnit | undefined;
  /** Maximum imported files to check. The root does not consume this budget. */
  maxImportedFiles?: number;
  /** Direct imports of the root file. */
  rootDependencies?: readonly string[];
}

export const DEFAULT_MAX_IMPORTED_FILES = 128;

/** Follow exact calls from `root` without scanning unrelated workspace files. */
export function analyzeReachableCalls(root: EffectUnit, options: ReachableCallOptions): ReachableCallAnalysis {
  const maxImportedFiles = Math.max(0, options.maxImportedFiles ?? DEFAULT_MAX_IMPORTED_FILES);
  const units: EffectUnit[] = [root];
  const calls = new Map<A.Invocation, ProcSig>();
  const dependencies = new Set((options.rootDependencies ?? []).map(normalized));
  const loaded = new Map<string, ReachableUnit>();
  const owner = new Map<A.ProcDecl, ReachableUnit | EffectUnit>();
  const callsByDeclaration = new Map<A.ProcDecl, Array<[A.Invocation, ProcSig]>>();
  const pending: A.ProcDecl[] = [];
  const seen = new Set<A.ProcDecl>();
  let importedFiles = 0;
  let truncated = false;

  const register = (unit: ReachableUnit | EffectUnit): void => {
    const procedures: A.ProcDecl[] = [];
    for (const declaration of unit.program.decls) {
      if (declaration.kind !== 'ProcDecl') continue;
      owner.set(declaration, unit);
      procedures.push(declaration);
      callsByDeclaration.set(declaration, []);
    }
    procedures.sort((left, right) => compare(left.span.start, right.span.start));
    for (const entry of unit.checked.calls) {
      const invocation = entry[0];
      // Top-level procedure spans do not overlap. Find the last declaration
      // that starts before this call, then confirm its half-open containment.
      let low = 0;
      let high = procedures.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (compare(procedures[middle].span.start, invocation.span.start) <= 0) low = middle + 1;
        else high = middle;
      }
      const declaration = procedures[low - 1];
      if (declaration?.body && contains(declaration.body.span, invocation.span)) callsByDeclaration.get(declaration)!.push(entry);
    }
  };
  const enqueue = (declaration: A.ProcDecl): void => {
    if (!declaration.body || seen.has(declaration)) return;
    seen.add(declaration);
    pending.push(declaration);
  };
  const load = (file: string): ReachableUnit | undefined => {
    const absolute = normalized(file);
    dependencies.add(absolute);
    const existing = loaded.get(absolute);
    if (existing) return existing;
    if (importedFiles >= maxImportedFiles) {
      truncated = true;
      return undefined;
    }
    const unit = options.load(absolute);
    if (!unit) return undefined;
    importedFiles++;
    loaded.set(absolute, unit);
    units.push(unit);
    register(unit);
    dependencies.add(normalized(unit.file));
    for (const dependency of unit.dependencies) dependencies.add(normalized(dependency));
    return unit;
  };

  register(root);
  for (const declaration of root.program.decls) {
    // Every procedure authored in the current file is an editor-facing entry:
    // effects and code lenses are produced for all of them, not only `main`.
    if (declaration.kind === 'ProcDecl') enqueue(declaration);
  }

  while (pending.length) {
    const declaration = pending.pop()!;
    const unit = owner.get(declaration);
    if (!unit || !declaration.body) continue;
    for (const [invocation, selected] of callsByDeclaration.get(declaration) ?? []) {
      calls.set(invocation, selected);
      if (!selected.decl.body) continue;

      let targetOwner = owner.get(selected.decl);
      if (!targetOwner && selected.file) {
        targetOwner = load(selected.file);
        // A loader that reparses instead of returning the AST used by the
        // caller's index cannot safely be joined by declaration identity.
        if (targetOwner && !owner.has(selected.decl)) targetOwner = undefined;
      }
      if (targetOwner) enqueue(selected.decl);
    }
  }

  return { units, calls, dependencies, truncated };
}

function normalized(file: string): string {
  return path.resolve(file);
}

function compare(left: A.Pos, right: A.Pos): number {
  return left.line - right.line || left.col - right.col;
}

function contains(outer: A.Span, inner: A.Span): boolean {
  return compare(outer.start, inner.start) <= 0 && compare(inner.end, outer.end) <= 0;
}
