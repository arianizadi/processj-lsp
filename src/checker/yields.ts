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
import type { DeclIndex } from './index';

export type YieldMode = 'direct' | 'calls';

export class YieldAnalysis {
  private readonly memo = new Map<A.ProcDecl, boolean>();
  /** Procedures whose analysis is in progress; a call back into one is a cycle. */
  private readonly visiting = new Set<A.ProcDecl>();
  /** Set while a computation consulted a procedure that is still in progress. */
  private touchedCycle = false;

  constructor(private readonly index: DeclIndex) {}

  /** Can the procedure suspend, directly or through the procedures it calls? */
  procYields(decl: A.ProcDecl): boolean {
    const m = this.memo.get(decl);
    if (m !== undefined) return m;
    if (this.visiting.has(decl)) {
      this.touchedCycle = true;
      return false;
    }
    this.visiting.add(decl);
    const outerTouched = this.touchedCycle;
    this.touchedCycle = false;
    const r = decl.body ? this.stmtYields(decl.body, 'calls') : false;
    const touched = this.touchedCycle;
    this.visiting.delete(decl);
    // A `false` reached through a procedure that is still being analysed is
    // provisional: that procedure may yet turn out to yield through another
    // path. Only definite answers are remembered.
    if (r || !touched) this.memo.set(decl, r);
    this.touchedCycle = outerTouched || touched;
    return r;
  }

  /** Does the procedure's own body communicate, ignoring what its callees do? */
  procYieldsDirectly(decl: A.ProcDecl): boolean {
    return decl.body ? this.stmtYields(decl.body, 'direct') : false;
  }

  /**
   * Would the compiler's `Yield` pass mark this procedure by itself? It counts
   * direct communication in the body, any channel-end, barrier or timer
   * parameter, `suspend`, and always `main`.
   */
  compilerMarks(decl: A.ProcDecl): boolean {
    if (decl.name.name === 'main') return true;
    if (decl.params.some((p) => isYieldingParamType(p.type))) return true;
    return this.procYieldsDirectly(decl);
  }

  stmtYields(s: A.Stmt, mode: YieldMode): boolean {
    switch (s.kind) {
      case 'Block':
        return s.stmts.some((x) => this.stmtYields(x, mode));
      case 'LocalDecl':
        return s.declarators.some((v) => !!v.init && this.exprYields(v.init, mode));
      case 'ExprStmt':
        return this.exprYields(s.expr, mode);
      case 'IfStmt':
        return this.exprYields(s.cond, mode) || this.stmtYields(s.then, mode) || (!!s.else && this.stmtYields(s.else, mode));
      case 'WhileStmt':
      case 'DoStmt':
        return this.exprYields(s.cond, mode) || this.stmtYields(s.body, mode);
      case 'ForStmt': {
        if (s.isPar) return true;
        const init = s.init ? (Array.isArray(s.init) ? s.init.some((e) => this.exprYields(e, mode)) : this.stmtYields(s.init, mode)) : false;
        return init || (!!s.cond && this.exprYields(s.cond, mode)) || s.update.some((e) => this.exprYields(e, mode)) || this.stmtYields(s.body, mode);
      }
      case 'ParBlock':
      case 'AltStmt':
      case 'ClaimStmt':
      case 'SuspendStmt':
        return true;
      case 'SeqBlock':
        return this.stmtYields(s.body, mode);
      case 'SwitchStmt':
        return this.exprYields(s.expr, mode) || s.groups.some((g) => g.stmts.some((x) => this.stmtYields(x, mode)));
      case 'ReturnStmt':
        return !!s.expr && this.exprYields(s.expr, mode);
      case 'LabeledStmt':
        return this.stmtYields(s.stmt, mode);
      default:
        return false;
    }
  }

  exprYields(e: A.Expr, mode: YieldMode): boolean {
    switch (e.kind) {
      case 'ChanRead':
      case 'ChanWrite':
      case 'Sync':
      case 'Timeout':
        return true;
      case 'Invocation': {
        if (e.args.some((a) => this.exprYields(a, mode))) return true;
        if (mode !== 'calls') return false;
        const cands = this.index.procs.get(e.name.name) ?? [];
        return cands.some((c) => this.procYields(c.decl));
      }
      case 'ParenExpr':
        return this.exprYields(e.expr, mode);
      case 'BinaryExpr':
        return this.exprYields(e.left, mode) || this.exprYields(e.right, mode);
      case 'UnaryExpr':
        return this.exprYields(e.operand, mode);
      case 'AssignExpr':
        return this.exprYields(e.target, mode) || this.exprYields(e.value, mode);
      case 'TernaryExpr':
        return this.exprYields(e.cond, mode) || this.exprYields(e.then, mode) || this.exprYields(e.else, mode);
      case 'CastExpr':
      case 'IsExpr':
        return this.exprYields(e.expr, mode);
      case 'RecordAccess':
      case 'ChanEnd':
        return this.exprYields(e.target, mode);
      case 'ArrayAccess':
        return this.exprYields(e.target, mode) || this.exprYields(e.index, mode);
      case 'NewArray':
        return e.dimExprs.some((d) => this.exprYields(d, mode)) || (!!e.init && this.exprYields(e.init, mode));
      case 'ArrayLiteral':
        return e.elements.some((x) => this.exprYields(x, mode));
      case 'RecordLiteral':
      case 'ProtocolLiteral':
        return e.fields.some((f) => this.exprYields(f.value, mode));
      default:
        return false;
    }
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
export function yieldAnnotationEdit(d: A.ProcDecl): { line: number; col: number; text: string } {
  if (d.annotationsSpan) return { line: d.annotationsSpan.start.line, col: d.annotationsSpan.start.col + 1, text: 'yield=true, ' };
  return { line: d.headerEnd.line, col: d.headerEnd.col, text: ' [yield=true]' };
}
