/**
 * Which procedures can suspend? A procedure suspends directly when its body
 * communicates (channel read/write, sync, timeout, alt, par, suspend) and
 * indirectly when it calls a procedure that suspends. ProcessJ compiles
 * suspending procedures into resumable processes, so the distinction matters.
 *
 * The compiler's own `Yield` pass only looks at a procedure's body and its
 * parameters: it never follows calls. `needingAnnotation` lists the procedures
 * the compiler would therefore mis-compile unless they carry `[yield=true]`.
 */
import type * as A from '../parser/ast';
import { forEachReachableStatement } from './controlflow';
import type { DeclIndex, ProcSig } from './index';

export type YieldMode = 'direct' | 'calls';

export interface YieldCallScope {
  /** Exact overloads selected while checking the declaration's source file. */
  calls: ReadonlyMap<A.Invocation, ProcSig>;
  /** False when a file/budget boundary prevented exact call resolution. */
  complete: boolean;
}

export type YieldCallProvider = (declaration: A.ProcDecl) => YieldCallScope | undefined;

export interface YieldAnalysisOptions {
  /**
   * Treat an unresolved invocation in the current program as may-yield. This
   * is appropriate for compiler augmentation and transformation safety. A
   * checker diagnostic sets it false because an invalid call is not evidence
   * that the author forgot a yield annotation.
   */
  unresolvedRootCallsYield?: boolean;
}

export class YieldAnalysis {
  private readonly memo = new Map<A.ProcDecl, boolean>();

  constructor(
    private readonly index: DeclIndex,
    /** Exact overloads selected while checking the current program. */
    private readonly calls?: ReadonlyMap<A.Invocation, ProcSig>,
    /** Exact overloads from reachable imported procedure bodies. */
    private readonly importedCalls?: ReadonlyMap<A.Invocation, ProcSig>,
    /** Lazily checks an imported declaration in that declaration's own scope. */
    private readonly callProvider?: YieldCallProvider,
    private readonly options: YieldAnalysisOptions = {},
  ) {}

  /** Can the procedure suspend, directly or through the procedures it calls? */
  procYields(decl: A.ProcDecl): boolean {
    const known = this.memo.get(decl);
    return known ?? this.proceduresYield([decl]);
  }

  /** Does the procedure's own body communicate, ignoring what its callees do? */
  procYieldsDirectly(decl: A.ProcDecl): boolean {
    return !!decl.body && this.scan([{ kind: 'stmt', value: decl.body }]).direct;
  }

  /**
   * Would the compiler's `Yield` pass mark this procedure by itself? It counts
   * direct communication in the body, any channel-end, barrier or timer
   * parameter, `suspend`, and always `main`.
   */
  compilerMarks(decl: A.ProcDecl): boolean {
    if (decl.name.name === 'main') return true;
    if (decl.params.some((p) => isYieldingParamType(p.type))) return true;
    // ProcessJ's two compiler Yield visitors traverse a par-for like an
    // ordinary loop and overlook the scheduler yield emitted by Java codegen.
    return !!decl.body && this.scan([{ kind: 'stmt', value: decl.body }], false, false).direct;
  }

  stmtYields(s: A.Stmt, mode: YieldMode): boolean {
    const scanned = this.scan([{ kind: 'stmt', value: s }]);
    return scanned.direct || (mode === 'calls' && this.invocationsYield(scanned.invocations));
  }

  exprYields(e: A.Expr, mode: YieldMode): boolean {
    const scanned = this.scan([{ kind: 'expr', value: e }]);
    return scanned.direct || (mode === 'calls' && this.invocationsYield(scanned.invocations));
  }

  /** Resolve a group of expression calls and ask the iterative graph once. */
  private invocationsYield(invocations: readonly A.Invocation[], scope?: YieldCallScope): boolean {
    const targets: A.ProcDecl[] = [];
    for (const invocation of invocations) {
      const resolved = this.resolveInvocation(invocation, scope);
      if (!resolved) return true;
      targets.push(...resolved);
    }
    return this.proceduresYield(targets);
  }

  /**
   * Build the reachable may-yield call graph iteratively, then propagate each
   * direct yielding seed backwards. This is stack-safe for generated programs
   * with thousands of procedures and naturally handles recursive SCCs.
   */
  private proceduresYield(roots: readonly A.ProcDecl[]): boolean {
    const uniqueRoots = [...new Set(roots)];
    if (uniqueRoots.some((declaration) => this.memo.get(declaration) === true)) return true;
    const pending = uniqueRoots.filter((declaration) => !this.memo.has(declaration));
    const queued = new Set(pending);
    const examined = new Set<A.ProcDecl>();
    const reverse = new Map<A.ProcDecl, Set<A.ProcDecl>>();
    const yielding = new Set<A.ProcDecl>();

    while (pending.length) {
      const declaration = pending.pop()!;
      queued.delete(declaration);
      if (examined.has(declaration) || this.memo.has(declaration)) continue;
      examined.add(declaration);

      // Manual annotations are compiler contracts, including on native bodies.
      if (hasYieldAnnotation(declaration)) {
        yielding.add(declaration);
        continue;
      }
      if (!declaration.body) continue;
      const provided = this.callProvider?.(declaration);
      if (provided && !provided.complete) {
        yielding.add(declaration);
        continue;
      }
      const scanned = this.scan([{ kind: 'stmt', value: declaration.body }]);
      if (scanned.direct) yielding.add(declaration);
      for (const invocation of scanned.invocations) {
        const targets = this.resolveInvocation(invocation, provided);
        if (!targets) {
          yielding.add(declaration);
          continue;
        }
        for (const target of targets) {
          const known = this.memo.get(target);
          if (known === true) {
            yielding.add(declaration);
            continue;
          }
          if (known === false) continue;
          let callers = reverse.get(target);
          if (!callers) {
            callers = new Set();
            reverse.set(target, callers);
          }
          callers.add(declaration);
          if (!examined.has(target) && !queued.has(target)) {
            pending.push(target);
            queued.add(target);
          }
        }
      }
    }

    const propagate = [...yielding];
    while (propagate.length) {
      const callee = propagate.pop()!;
      for (const caller of reverse.get(callee) ?? []) {
        if (yielding.has(caller)) continue;
        yielding.add(caller);
        propagate.push(caller);
      }
    }
    for (const declaration of examined) this.memo.set(declaration, yielding.has(declaration));
    return uniqueRoots.some((declaration) => this.memo.get(declaration) === true);
  }

  /** Undefined means the invocation is not exactly known and may yield. */
  private resolveInvocation(invocation: A.Invocation, scope?: YieldCallScope): A.ProcDecl[] | undefined {
    const selected = this.calls?.get(invocation) ?? this.importedCalls?.get(invocation) ?? scope?.calls.get(invocation);
    if (selected) return [selected.decl];
    // Do not resolve an imported invocation against the root's overload set.
    // An imported scope or combined imported map also means unresolved and
    // qualified calls remain a conservative may-yield boundary instead of
    // silently appearing pure.
    if (scope) return undefined;
    if (this.calls) return this.options.unresolvedRootCallsYield === false ? [] : undefined;
    if (this.importedCalls) return undefined;
    return (this.index.procs.get(invocation.name.name) ?? []).map((candidate) => candidate.decl);
  }

  /** Iteratively collect direct suspension points and ordinary invocations. */
  private scan(initial: YieldWork[], parForIsDirect = true, reachableStatementsOnly = true): { direct: boolean; invocations: A.Invocation[] } {
    const pending = [...initial];
    const invocations: A.Invocation[] = [];
    let direct = false;
    const statement = (value: A.Stmt): void => {
      pending.push({ kind: 'stmt', value });
    };
    const expression = (value: A.Expr | undefined): void => {
      if (value) pending.push({ kind: 'expr', value });
    };
    const statements = (values: readonly A.Stmt[]): void => {
      // The checker still visits dead statements to report their own errors,
      // but they cannot make a procedure yield at runtime. `suspend` is not a
      // lexical terminator in ProcessJ and deliberately remains fall-through.
      if (reachableStatementsOnly) forEachReachableStatement(values, statement);
      else values.forEach(statement);
    };

    while (pending.length) {
      const work = pending.pop()!;
      if (work.kind === 'stmt') {
        const value = work.value;
        switch (value.kind) {
          case 'Block':
            statements(value.stmts);
            break;
          case 'LocalDecl':
            value.declarators.forEach((declarator) => expression(declarator.init));
            break;
          case 'ExprStmt':
            expression(value.expr);
            break;
          case 'IfStmt':
            expression(value.cond);
            statement(value.then);
            if (value.else) statement(value.else);
            break;
          case 'WhileStmt':
          case 'DoStmt':
            expression(value.cond);
            statement(value.body);
            break;
          case 'ForStmt':
            if (value.isPar && parForIsDirect) {
              direct = true;
              break;
            }
            if (value.init) Array.isArray(value.init) ? value.init.forEach(expression) : statement(value.init);
            expression(value.cond);
            value.update.forEach(expression);
            statement(value.body);
            break;
          case 'ParBlock':
          case 'AltStmt':
          case 'ClaimStmt':
          case 'SuspendStmt':
            direct = true;
            break;
          case 'SeqBlock':
            statement(value.body);
            break;
          case 'SwitchStmt':
            expression(value.expr);
            value.groups.forEach((group) => statements(group.stmts));
            break;
          case 'ReturnStmt':
            expression(value.expr);
            break;
          case 'LabeledStmt':
            statement(value.stmt);
            break;
          default:
            break;
        }
        continue;
      }

      const value = work.value;
      switch (value.kind) {
        case 'ChanRead':
        case 'ChanWrite':
        case 'Sync':
        case 'Timeout':
        case 'NewMobile':
          direct = true;
          break;
        case 'Invocation':
          invocations.push(value);
          value.args.forEach(expression);
          break;
        case 'ParenExpr':
        case 'CastExpr':
        case 'IsExpr':
          expression(value.expr);
          break;
        case 'BinaryExpr':
          expression(value.left);
          expression(value.right);
          break;
        case 'UnaryExpr':
          expression(value.operand);
          break;
        case 'AssignExpr':
          expression(value.target);
          expression(value.value);
          break;
        case 'TernaryExpr':
          expression(value.cond);
          expression(value.then);
          expression(value.else);
          break;
        case 'RecordAccess':
        case 'ChanEnd':
          expression(value.target);
          break;
        case 'ArrayAccess':
          expression(value.target);
          expression(value.index);
          break;
        case 'NewArray':
          value.dimExprs.forEach(expression);
          expression(value.init);
          break;
        case 'ArrayLiteral':
          value.elements.forEach(expression);
          break;
        case 'RecordLiteral':
        case 'ProtocolLiteral':
          value.fields.forEach((field) => expression(field.value));
          break;
        default:
          break;
      }
    }
    return { direct, invocations };
  }

  /** Procedures that suspend, that the compiler would not notice, and that are not yet marked `[yield=true]`. */
  needingAnnotation(program: A.Program): A.ProcDecl[] {
    const out: A.ProcDecl[] = [];
    for (const d of program.decls) {
      if (d.kind !== 'ProcDecl' || !d.body || hasYieldAnnotation(d)) continue;
      if (!this.compilerMarks(d) && this.procYields(d)) out.push(d);
    }
    return out;
  }
}

type YieldWork = { kind: 'stmt'; value: A.Stmt } | { kind: 'expr'; value: A.Expr };

export function hasYieldAnnotation(d: A.ProcDecl): boolean {
  return d.annotations.some((a) => a.name === 'yield' && a.value === 'true');
}

function isYieldingParamType(t: A.TypeNode): boolean {
  if (t.kind === 'ChanType') return !!t.end;
  return t.kind === 'PrimitiveType' && (t.name === 'barrier' || t.name === 'timer');
}

/**
 * The single-line insertion that marks a procedure `[yield=true]`. The grammar
 * places the annotation list directly after the parameter list, before any
 * `implements` clause and the body, and allows only one list.
 */
export interface YieldAnnotationEdit {
  line: number;
  col: number;
  endCol: number;
  text: string;
}

export function yieldAnnotationEdit(d: A.ProcDecl): YieldAnnotationEdit {
  const existing = d.annotations.find((annotation) => annotation.name === 'yield');
  if (existing) {
    return {
      line: existing.span.start.line,
      col: existing.span.start.col,
      endCol: existing.span.end.col,
      text: 'true',
    };
  }
  if (d.annotationsSpan) {
    const col = d.annotationsSpan.start.col + 1;
    return { line: d.annotationsSpan.start.line, col, endCol: col, text: 'yield=true, ' };
  }
  return { line: d.headerEnd.line, col: d.headerEnd.col, endCol: d.headerEnd.col, text: ' [yield=true]' };
}
