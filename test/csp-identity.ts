/**
 * Process identities computed straight from the AST by the rule in
 * src/verification.ts, independently of the CSP translator: the graph viewer
 * computes the same paths, so the translator's must equal these.
 */
import type { CheckResult } from '../src/checker/checker';
import type * as A from '../src/parser/ast';
import type { ProcessPath, SpawnSite } from '../src/verification';

export interface IdentityUnit {
  program: A.Program;
  checked: CheckResult;
  uri: string;
}

/**
 * Every process instance under `root`: [] for the root itself, then one path
 * per par branch and per par for iteration (iteration values computed for
 * literal `for (int i = a; i < b; i++)` headers), with a call level for each
 * call on the way to a par.
 */
export function expectedPaths(units: IdentityUnit[], root: A.ProcDecl): ProcessPath[] {
  const unitOf = new Map<A.ProcDecl, IdentityUnit>();
  for (const u of units) for (const d of u.program.decls) if (d.kind === 'ProcDecl' && !unitOf.has(d)) unitOf.set(d, u);
  const leads = new Map<A.ProcDecl, boolean>();
  const leadsToPar = (decl: A.ProcDecl, stack: A.ProcDecl[] = []): boolean => {
    const known = leads.get(decl);
    if (known !== undefined) return known;
    if (stack.includes(decl)) return false;
    const unit = unitOf.get(decl);
    let found = false;
    const visitStmt = (s: A.Stmt | undefined): void => {
      if (!s || found) return;
      if (s.kind === 'ParBlock' || (s.kind === 'ForStmt' && s.isPar)) {
        found = true;
        return;
      }
      forEachChild(s, visitStmt, (e) => {
        for (const call of invocations(e)) {
          const callee = unit?.checked.calls.get(call)?.decl;
          if (callee?.body && unitOf.has(callee) && leadsToPar(callee, [...stack, decl])) found = true;
        }
      });
    };
    visitStmt(decl.body);
    leads.set(decl, found);
    return found;
  };

  const out: ProcessPath[] = [[]];
  const walk = (decl: A.ProcDecl, prefix: ProcessPath, stack: A.ProcDecl[]): void => {
    const unit = unitOf.get(decl)!;
    const visit = (s: A.Stmt | undefined, path: ProcessPath): void => {
      if (!s) return;
      if (s.kind === 'ParBlock') {
        s.body.stmts.forEach((branch, i) => {
          const site: SpawnSite = { kind: 'branch', site: { uri: unit.uri, span: branch.span }, index: i + 1 };
          const p = [...path, site];
          out.push(p);
          visit(branch, p);
        });
        return;
      }
      if (s.kind === 'ForStmt' && s.isPar) {
        for (const v of iterations(s)) {
          const site: SpawnSite = { kind: 'par-for', site: { uri: unit.uri, span: s.span }, index: v };
          const p = [...path, site];
          out.push(p);
          visit(s.body, p);
        }
        return;
      }
      forEachChild(s, (c) => visit(c, path), (e) => {
        for (const call of invocations(e)) {
          const callee = unit.checked.calls.get(call)?.decl;
          if (!callee?.body || !unitOf.has(callee) || stack.includes(callee) || !leadsToPar(callee)) continue;
          walk(callee, [...path, { kind: 'call', site: { uri: unit.uri, span: call.span } }], [...stack, callee]);
        }
      });
    };
    visit(decl.body, prefix);
  };
  walk(root, [], [root]);
  return out;
}

/** Literal `for (int i = a; i < b; i++)`-style iteration values. */
function iterations(s: A.ForStmt): number[] {
  const init = s.init && !Array.isArray(s.init) ? s.init.declarators[0]?.init : undefined;
  const cond = s.cond?.kind === 'BinaryExpr' ? s.cond : undefined;
  const lit = (e: A.Expr | undefined): number | undefined => (e?.kind === 'Literal' && e.litKind === 'int' ? Number(e.text) : undefined);
  const a = lit(init);
  const b = lit(cond?.right);
  if (a === undefined || b === undefined || !cond) throw new Error('expectedPaths handles literal par for bounds only');
  const out: number[] = [];
  for (let i = a; cond.op === '<' ? i < b : cond.op === '<=' ? i <= b : false; i++) out.push(i);
  return out;
}

function invocations(e: A.Expr): A.Invocation[] {
  const out: A.Invocation[] = [];
  const visit = (x: A.Expr): void => {
    if (x.kind === 'Invocation') out.push(x);
    for (const child of childExprs(x)) visit(child);
  };
  visit(e);
  return out;
}

function childExprs(e: A.Expr): A.Expr[] {
  switch (e.kind) {
    case 'ParenExpr':
    case 'CastExpr':
    case 'IsExpr':
      return [e.expr];
    case 'BinaryExpr':
      return [e.left, e.right];
    case 'UnaryExpr':
      return [e.operand];
    case 'AssignExpr':
      return [e.target, e.value];
    case 'TernaryExpr':
      return [e.cond, e.then, e.else];
    case 'Invocation':
      return [...(e.target ? [e.target] : []), ...e.args];
    case 'RecordAccess':
    case 'ChanEnd':
    case 'ChanRead':
    case 'Sync':
      return [e.target];
    case 'ArrayAccess':
      return [e.target, e.index];
    case 'ChanWrite':
      return [e.target, e.value];
    case 'Timeout':
      return [e.target, e.delay];
    case 'NewArray':
      return [...e.dimExprs, ...(e.init ? [e.init] : [])];
    case 'ArrayLiteral':
      return e.elements;
    case 'RecordLiteral':
    case 'ProtocolLiteral':
      return e.fields.map((f) => f.value);
    default:
      return [];
  }
}

/** Child statements and the expressions of a statement (extended rendezvous blocks are statements too). */
function forEachChild(s: A.Stmt, stmt: (s: A.Stmt | undefined) => void, expr: (e: A.Expr) => void): void {
  const exprs = (e: A.Expr): void => {
    expr(e);
    const visit = (x: A.Expr): void => {
      if (x.kind === 'ChanRead' && x.extended) stmt(x.extended);
      for (const c of childExprs(x)) visit(c);
    };
    visit(e);
  };
  switch (s.kind) {
    case 'Block':
      s.stmts.forEach(stmt);
      return;
    case 'LocalDecl':
      for (const d of s.declarators) if (d.init) exprs(d.init);
      return;
    case 'ExprStmt':
      exprs(s.expr);
      return;
    case 'IfStmt':
      exprs(s.cond);
      stmt(s.then);
      stmt(s.else);
      return;
    case 'WhileStmt':
    case 'DoStmt':
      exprs(s.cond);
      stmt(s.body);
      return;
    case 'ForStmt':
      if (s.init) Array.isArray(s.init) ? s.init.forEach(exprs) : stmt(s.init);
      if (s.cond) exprs(s.cond);
      s.update.forEach(exprs);
      stmt(s.body);
      return;
    case 'SeqBlock':
      stmt(s.body);
      return;
    case 'SwitchStmt':
      exprs(s.expr);
      for (const g of s.groups) g.stmts.forEach(stmt);
      return;
    case 'AltStmt':
      for (const c of s.cases) {
        if (c.precondition) exprs(c.precondition);
        if (c.guard?.kind === 'ReadGuard') exprs(c.guard.read);
        if (c.nested) stmt(c.nested);
        stmt(c.body);
      }
      return;
    case 'ReturnStmt':
      if (s.expr) exprs(s.expr);
      return;
    case 'LabeledStmt':
      stmt(s.stmt);
      return;
    default:
      return;
  }
}

/** A path as text, for readable assertion failures. */
export function pathText(path: ProcessPath): string {
  return path.map((s) => `${s.kind}${s.index ?? ''}@${s.site.span.start.line + 1}:${s.site.span.start.col}-${s.site.span.end.line + 1}:${s.site.span.end.col}`).join(' / ') || '(root)';
}
