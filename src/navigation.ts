/**
 * Binding-aware helpers shared by completion, definition, references and rename.
 *
 * The checker gives each local/parameter declaration a stable `VarInfo` object and
 * maps every name expression back to that object.  Using those identities avoids
 * the classic LSP failure mode where a textual rename also changes a shadowed
 * variable that merely has the same spelling.
 */
import type { CheckResult, VarInfo } from './checker/checker';
import type * as A from './parser/ast';

export interface SourcePosition {
  line: number;
  character: number;
}

function beforeOrEqual(a: A.Pos, b: A.Pos): boolean {
  return a.line < b.line || (a.line === b.line && a.col <= b.col);
}

export function containsPosition(span: A.Span, pos: SourcePosition): boolean {
  const p = { line: pos.line, col: pos.character };
  return beforeOrEqual(span.start, p) && beforeOrEqual(p, span.end);
}

/** The exact checker binding at a declaration or variable-use position. */
export function variableAt(checked: CheckResult, pos: SourcePosition): VarInfo | undefined {
  for (const [expr, variable] of checked.resolutions) {
    if (containsPosition(expr.name.span, pos)) return variable;
  }
  return checked.vars.find((variable) => containsPosition(variable.decl.span, pos));
}

/** Declaration and references for one binding, in source order. */
export function variableSpans(checked: CheckResult, variable: VarInfo, includeDeclaration = true): A.Span[] {
  const spans: A.Span[] = [];
  if (includeDeclaration) spans.push(variable.decl.span);
  for (const [expr, resolved] of checked.resolutions) {
    if (resolved === variable) spans.push(expr.name.span);
  }
  spans.sort((a, b) => a.start.line - b.start.line || a.start.col - b.start.col);
  return spans;
}

/** Refuse both capture of renamed uses and capture of existing uses of the new name. */
export function localRenameConflict(program: A.Program, checked: CheckResult, variable: VarInfo, newName: string): boolean {
  if (variable.name === newName) return false;
  const scopes = declarationScopes(program);
  const scope = scopes.get(variable.decl);
  if (!scope) return true;
  const position = (span: A.Span): SourcePosition => ({ line: span.start.line, character: span.start.col });
  for (const other of checked.vars) {
    if (other === variable || other.name !== newName) continue;
    // Duplicate declarations are unsafe even when neither variable is used.
    if (scopes.get(other.decl) === scope) return true;
  }
  for (const [expr, resolved] of checked.resolutions) {
    if (resolved !== variable) continue;
    const other = visibleVariables(program, checked, position(expr.span)).find((v) => v.name === newName);
    if (other && other.depth >= variable.depth) return true;
  }
  for (const [expr] of checked.types) {
    if (expr.kind !== 'NameExpr' || expr.qualifier?.length || expr.name.name !== newName) continue;
    const resolved = checked.resolutions.get(expr);
    if (resolved && resolved.depth > variable.depth) continue;
    // Includes top-level constants and unresolved names, whose meaning must
    // not silently become this local variable after the rename.
    // Test the declaration's region directly: its old name might currently
    // be shadowed, but changing that name can expose it in the nested scope.
    if (containsPosition(scope, position(expr.span)) && (variable.isParam || beforeOrEqual(variable.decl.span.end, expr.span.start))) return true;
  }
  return false;
}

/**
 * Every syntactic use of a named record/protocol type. This deliberately does
 * not collect arbitrary identifiers: field names, protocol case tags, labels,
 * and same-spelled declarations are different symbols.
 */
export function namedTypeSpans(program: A.Program, name: string): A.Span[] {
  const spans: A.Span[] = [];
  const seen = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as Record<string, unknown>;
    if (node.kind === 'NamedType') {
      const id = node.name as A.Ident;
      if (!id.qualifier?.length && id.name === name) spans.push(id.span);
    } else if (node.kind === 'RecordLiteral' || node.kind === 'ProtocolLiteral') {
      const id = node.typeName as A.Ident;
      if (!id.qualifier?.length && id.name === name) spans.push(id.span);
    } else if (node.kind === 'RecordDecl' || node.kind === 'ProtocolDecl') {
      for (const id of node.extends as A.Ident[]) if (!id.qualifier?.length && id.name === name) spans.push(id.span);
    }
    for (const [key, child] of Object.entries(node)) {
      // Spans are coordinate data, and the identifiers handled above must not
      // be mistaken for additional semantic contexts.
      if (key === 'span' || key === 'name' || key === 'typeName' || key === 'extends') continue;
      visit(child);
    }
  };
  visit(program);
  spans.sort((a, b) => a.start.line - b.start.line || a.start.col - b.start.col);
  return spans;
}

/**
 * Variables visible at a completion position.  Scope spans are recovered from
 * the AST because `VarInfo` deliberately stores only the checker's scope depth.
 */
export function visibleVariables(program: A.Program, checked: CheckResult, pos: SourcePosition): VarInfo[] {
  const proc = program.decls.find((d): d is A.ProcDecl => d.kind === 'ProcDecl' && containsPosition(d.span, pos));
  if (!proc) return [];

  const scopes = declarationScopes(program);
  const at = { line: pos.line, col: pos.character };
  const candidates = checked.vars.filter((variable) => {
    // Procedure names are not unique because ProcessJ supports overloads.  The
    // declaration location, unlike VarInfo.proc, identifies the exact overload.
    if (!containsPosition(proc.span, { line: variable.decl.span.start.line, character: variable.decl.span.start.col })) return false;
    const scope = scopes.get(variable.decl);
    if (!scope || !containsPosition(scope, pos)) return false;
    return variable.isParam || beforeOrEqual(variable.decl.span.end, at);
  });

  // One completion per spelling.  The deepest/latest declaration shadows the
  // others, matching the checker lookup order.
  const byName = new Map<string, VarInfo>();
  for (const variable of candidates) {
    const previous = byName.get(variable.name);
    if (!previous || variable.depth > previous.depth || (variable.depth === previous.depth && beforeOrEqual(previous.decl.span.start, variable.decl.span.start))) {
      byName.set(variable.name, variable);
    }
  }
  return [...byName.values()];
}

/** Map each local/parameter identifier to the region in which it is visible. */
const declarationScopeCache = new WeakMap<A.Program, Map<A.Ident, A.Span>>();

function declarationScopes(program: A.Program): Map<A.Ident, A.Span> {
  const cached = declarationScopeCache.get(program);
  if (cached) return cached;
  const out = new Map<A.Ident, A.Span>();

  const declaration = (decl: A.LocalDecl, scope: A.Span): void => {
    for (const variable of decl.declarators) {
      out.set(variable.name, scope);
      if (variable.init) expression(variable.init, scope);
    }
  };

  const expression = (expr: A.Expr, scope: A.Span): void => {
    switch (expr.kind) {
      case 'ParenExpr':
        expression(expr.expr, scope);
        return;
      case 'BinaryExpr':
        expression(expr.left, scope);
        expression(expr.right, scope);
        return;
      case 'UnaryExpr':
        expression(expr.operand, scope);
        return;
      case 'AssignExpr':
        expression(expr.target, scope);
        expression(expr.value, scope);
        return;
      case 'TernaryExpr':
        expression(expr.cond, scope);
        expression(expr.then, scope);
        expression(expr.else, scope);
        return;
      case 'CastExpr':
      case 'IsExpr':
        expression(expr.expr, scope);
        return;
      case 'Invocation':
        if (expr.target) expression(expr.target, scope);
        expr.args.forEach((arg) => expression(arg, scope));
        return;
      case 'RecordAccess':
      case 'ChanEnd':
      case 'Sync':
        expression(expr.target, scope);
        return;
      case 'ArrayAccess':
        expression(expr.target, scope);
        expression(expr.index, scope);
        return;
      case 'ChanRead':
        expression(expr.target, scope);
        if (expr.extended) statement(expr.extended, scope);
        return;
      case 'ChanWrite':
        expression(expr.target, scope);
        expression(expr.value, scope);
        return;
      case 'Timeout':
        expression(expr.target, scope);
        expression(expr.delay, scope);
        return;
      case 'NewArray':
        expr.dimExprs.forEach((dim) => expression(dim, scope));
        if (expr.init) expression(expr.init, scope);
        return;
      case 'ArrayLiteral':
        expr.elements.forEach((element) => expression(element, scope));
        return;
      case 'RecordLiteral':
      case 'ProtocolLiteral':
        expr.fields.forEach((field) => expression(field.value, scope));
        return;
      default:
        return;
    }
  };

  const statement = (stmt: A.Stmt, scope: A.Span): void => {
    switch (stmt.kind) {
      case 'Block':
        stmt.stmts.forEach((child) => statement(child, stmt.span));
        return;
      case 'LocalDecl':
        declaration(stmt, scope);
        return;
      case 'ExprStmt':
        expression(stmt.expr, scope);
        return;
      case 'IfStmt':
        expression(stmt.cond, scope);
        statement(stmt.then, scope);
        if (stmt.else) statement(stmt.else, scope);
        return;
      case 'WhileStmt':
      case 'DoStmt':
        expression(stmt.cond, scope);
        statement(stmt.body, scope);
        return;
      case 'ForStmt':
        if (stmt.init) Array.isArray(stmt.init) ? stmt.init.forEach((expr) => expression(expr, scope)) : declaration(stmt.init, stmt.span);
        if (stmt.cond) expression(stmt.cond, stmt.span);
        stmt.update.forEach((expr) => expression(expr, stmt.span));
        stmt.enroll.forEach((expr) => expression(expr, stmt.span));
        statement(stmt.body, stmt.span);
        return;
      case 'ParBlock':
      case 'SeqBlock':
        statement(stmt.body, scope);
        return;
      case 'ClaimStmt':
        for (const channel of stmt.channels) channel.kind === 'LocalDecl' ? declaration(channel, stmt.span) : expression(channel, stmt.span);
        statement(stmt.body, stmt.span);
        return;
      case 'SwitchStmt':
        expression(stmt.expr, scope);
        for (const group of stmt.groups) {
          for (const label of group.labels) if (label) expression(label, group.span);
          group.stmts.forEach((child) => statement(child, group.span));
        }
        return;
      case 'AltStmt':
        if (stmt.replicated?.init) {
          const init = stmt.replicated.init;
          Array.isArray(init) ? init.forEach((expr) => expression(expr, stmt.span)) : declaration(init, stmt.span);
        }
        if (stmt.replicated?.cond) expression(stmt.replicated.cond, stmt.span);
        stmt.replicated?.update.forEach((expr) => expression(expr, stmt.span));
        for (const altCase of stmt.cases) {
          if (altCase.nested) statement(altCase.nested, stmt.span);
          if (altCase.precondition) expression(altCase.precondition, altCase.span);
          if (altCase.guard?.kind === 'ReadGuard') {
            expression(altCase.guard.target, altCase.span);
            expression(altCase.guard.read, altCase.span);
          } else if (altCase.guard?.kind === 'TimeoutGuard') expression(altCase.guard.timeout, altCase.span);
          if (altCase.body) statement(altCase.body, altCase.span);
        }
        return;
      case 'ReturnStmt':
        if (stmt.expr) expression(stmt.expr, scope);
        return;
      case 'LabeledStmt':
        statement(stmt.stmt, scope);
        return;
      default:
        return;
    }
  };

  for (const decl of program.decls) {
    if (decl.kind !== 'ProcDecl') continue;
    const scope = decl.body?.span ?? decl.span;
    for (const param of decl.params) out.set(param.name, scope);
    if (decl.body) decl.body.stmts.forEach((stmt) => statement(stmt, decl.body!.span));
  }
  declarationScopeCache.set(program, out);
  return out;
}
