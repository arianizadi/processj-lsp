/**
 * Which procedures can suspend? A procedure suspends directly when its body
 * communicates (channel read/write, sync, timeout, alt, par) and indirectly when
 * it calls a procedure that suspends. ProcessJ compiles suspending procedures
 * into resumable processes, so the distinction matters to the compiler.
 */
import type * as A from '../parser/ast';
import type { DeclIndex } from './index';

export class YieldAnalysis {
  private readonly memo = new Map<A.ProcDecl, boolean>();

  constructor(private readonly index: DeclIndex) {}

  /** Can the procedure suspend, directly or through the procedures it calls? */
  procYields(decl: A.ProcDecl): boolean {
    const m = this.memo.get(decl);
    if (m !== undefined) return m;
    this.memo.set(decl, false); // recursion guard: a cycle with no communication does not yield
    const r = decl.body ? this.stmtYields(decl.body, true) : false;
    this.memo.set(decl, r);
    return r;
  }

  /** Does the procedure's own body communicate, ignoring what its callees do? */
  procYieldsDirectly(decl: A.ProcDecl): boolean {
    return decl.body ? this.stmtYields(decl.body, false) : false;
  }

  stmtYields(s: A.Stmt, viaCalls: boolean): boolean {
    switch (s.kind) {
      case 'Block':
        return s.stmts.some((x) => this.stmtYields(x, viaCalls));
      case 'LocalDecl':
        return s.declarators.some((v) => !!v.init && this.exprYields(v.init, viaCalls));
      case 'ExprStmt':
        return this.exprYields(s.expr, viaCalls);
      case 'IfStmt':
        return this.exprYields(s.cond, viaCalls) || this.stmtYields(s.then, viaCalls) || (!!s.else && this.stmtYields(s.else, viaCalls));
      case 'WhileStmt':
      case 'DoStmt':
        return this.exprYields(s.cond, viaCalls) || this.stmtYields(s.body, viaCalls);
      case 'ForStmt':
        return s.isPar || this.stmtYields(s.body, viaCalls) || (!!s.cond && this.exprYields(s.cond, viaCalls));
      case 'ParBlock':
      case 'AltStmt':
      case 'ClaimStmt':
        return true;
      case 'SeqBlock':
        return this.stmtYields(s.body, viaCalls);
      case 'SwitchStmt':
        return this.exprYields(s.expr, viaCalls) || s.groups.some((g) => g.stmts.some((x) => this.stmtYields(x, viaCalls)));
      case 'ReturnStmt':
        return !!s.expr && this.exprYields(s.expr, viaCalls);
      case 'LabeledStmt':
        return this.stmtYields(s.stmt, viaCalls);
      default:
        return false;
    }
  }

  exprYields(e: A.Expr, viaCalls: boolean): boolean {
    switch (e.kind) {
      case 'ChanRead':
      case 'ChanWrite':
      case 'Sync':
      case 'Timeout':
        return true;
      case 'Invocation': {
        if (e.args.some((a) => this.exprYields(a, viaCalls))) return true;
        if (!viaCalls) return false;
        const cands = this.index.procs.get(e.name.name) ?? [];
        return cands.some((c) => this.procYields(c.decl));
      }
      case 'ParenExpr':
        return this.exprYields(e.expr, viaCalls);
      case 'BinaryExpr':
        return this.exprYields(e.left, viaCalls) || this.exprYields(e.right, viaCalls);
      case 'UnaryExpr':
        return this.exprYields(e.operand, viaCalls);
      case 'AssignExpr':
        return this.exprYields(e.target, viaCalls) || this.exprYields(e.value, viaCalls);
      case 'TernaryExpr':
        return this.exprYields(e.cond, viaCalls) || this.exprYields(e.then, viaCalls) || this.exprYields(e.else, viaCalls);
      case 'CastExpr':
        return this.exprYields(e.expr, viaCalls);
      case 'RecordAccess':
        return this.exprYields(e.target, viaCalls);
      case 'ArrayAccess':
        return this.exprYields(e.target, viaCalls) || this.exprYields(e.index, viaCalls);
      case 'NewArray':
        return e.dimExprs.some((d) => this.exprYields(d, viaCalls));
      case 'ArrayLiteral':
        return e.elements.some((x) => this.exprYields(x, viaCalls));
      case 'RecordLiteral':
      case 'ProtocolLiteral':
        return e.fields.some((f) => this.exprYields(f.value, viaCalls));
      default:
        return false;
    }
  }

  /** Procedures that suspend only through calls and are not yet marked `[yield=true]`. */
  needingAnnotation(program: A.Program): A.ProcDecl[] {
    const out: A.ProcDecl[] = [];
    for (const d of program.decls) {
      if (d.kind !== 'ProcDecl' || !d.body) continue;
      if (d.annotations.some((a) => a.name === 'yield' && a.value === 'true')) continue;
      if (!this.procYieldsDirectly(d) && this.procYields(d)) out.push(d);
    }
    return out;
  }
}

export function hasYieldAnnotation(d: A.ProcDecl): boolean {
  return d.annotations.some((a) => a.name === 'yield' && a.value === 'true');
}
