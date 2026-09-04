/**
 * Conservative, editor-neutral plans for concurrency-oriented refactorings.
 *
 * This module deliberately does not depend on vscode-languageserver.  Every edit
 * is expressed against the original source using the parser's half-open spans,
 * so a client can turn a successful plan into a TextEdit/WorkspaceEdit without
 * reparsing or guessing at offsets.
 */
import { check, type CheckResult, type VarInfo } from './checker/checker';
import { forEachReachableStatement } from './checker/controlflow';
import { DeclIndex, type ProcSig } from './checker/index';
import { proveAllRendezvousSchedulesComplete } from './checker/rendezvous';
import { endOf, typeStr } from './checker/types';
import { YieldAnalysis } from './checker/yields';
import { KEYWORDS, LITERALS, PRIMITIVE_TYPES } from './keywords';
import type * as A from './parser/ast';
import { parse, type ParseResult } from './parser/parser';

export interface RefactorEdit {
  /** Half-open range in the source supplied to the planner. */
  range: A.Span;
  newText: string;
}

export interface RefactorPlan {
  kind: 'extract-procedure' | 'run-in-par' | 'introduce-channel' | 'channel-direction' | 'channel-sharing';
  title: string;
  edits: RefactorEdit[];
}

export type RefactorResult = { ok: true; plan: RefactorPlan } | { ok: false; reasons: string[] };

export interface RefactorOptions {
  /** Declarations imported by the current file. Local declarations always win. */
  index?: DeclIndex;
  /** Used only as declaration metadata when constructing the local index. */
  file?: string;
  /** Exact invocations inside reachable imported bodies for transitive yield safety. */
  yieldCalls?: ReadonlyMap<A.Invocation, ProcSig>;
  /** Exact compiler-distributed native declarations proven not to block or rendezvous. */
  trustedNonBlockingNativeDeclarations?: ReadonlySet<A.ProcDecl>;
  /** One indentation step. It is inferred from the selected block by default. */
  indent?: string;
  /** Allow a signature-changing repair on public/protected procedures. */
  allowExternalCallers?: boolean;
}

export interface ExtractProcedureOptions extends RefactorOptions {
  /** Preferred procedure name. A numeric suffix is added if it is already used. */
  name?: string;
}

export interface ChannelDiagnostic {
  code: 'pj/channel-direction' | 'pj/shared-channel-end' | 'pj/parallel-usage';
  range: A.Span;
}

interface Context {
  source: string;
  parsed: ParseResult;
  index: DeclIndex;
  checked: CheckResult;
  yieldCalls?: ReadonlyMap<A.Invocation, ProcSig>;
  trustedNonBlockingNativeDeclarations?: ReadonlySet<A.ProcDecl>;
  offsets: SourceOffsets;
}

interface StatementList {
  statements: A.Stmt[];
  procedure: A.ProcDecl;
  inPar: boolean;
  inClaim: boolean;
  inExtendedRendezvous: boolean;
}

interface StatementSelection extends StatementList {
  selected: A.Stmt[];
  range: A.Span;
}

type UseRole = 'read' | 'write' | 'readwrite' | 'mutation' | 'chan-read' | 'chan-write' | 'chan-end-read' | 'chan-end-write';

interface UseEvent {
  expression: A.NameExpr;
  role: UseRole;
  operation: A.Span;
  invocation?: A.Invocation;
  argumentIndex?: number;
}

interface WalkFacts {
  uses: UseEvent[];
  invocations: A.Invocation[];
  channelOps: Array<{ variable?: VarInfo; direction: 'read' | 'write'; span: A.Span }>;
  hasSynchronization: boolean;
  hasOpaqueSynchronization: boolean;
  hasNestedConcurrency: boolean;
  hasControlTransfer: boolean;
}

interface DeclSite {
  type: A.TypeNode;
  procedure: A.ProcDecl;
  parameter?: A.Param;
  parameterIndex?: number;
  local?: A.LocalDecl;
  declarator?: A.Declarator;
}

const RESERVED = new Set<string>([...KEYWORDS, ...PRIMITIVE_TYPES, ...LITERALS]);

function refuse(...reasons: string[]): RefactorResult {
  return { ok: false, reasons: unique(reasons.filter(Boolean)) };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function comparePos(a: A.Pos, b: A.Pos): number {
  return a.line - b.line || a.col - b.col;
}

function containsSpan(outer: A.Span, inner: A.Span): boolean {
  return comparePos(outer.start, inner.start) <= 0 && comparePos(inner.end, outer.end) <= 0;
}

function overlaps(a: A.Span, b: A.Span): boolean {
  return comparePos(a.start, b.end) < 0 && comparePos(b.start, a.end) < 0;
}

function spanSize(span: A.Span): number {
  return (span.end.line - span.start.line) * 1_000_000 + span.end.col - span.start.col;
}

class SourceOffsets {
  private readonly starts: number[] = [0];

  constructor(readonly source: string) {
    for (let i = 0; i < source.length; i++) {
      if (source[i] === '\r') {
        if (source[i + 1] === '\n') i++;
        this.starts.push(i + 1);
      } else if (source[i] === '\n') {
        this.starts.push(i + 1);
      }
    }
  }

  offset(pos: A.Pos): number {
    const start = this.starts[pos.line];
    if (start === undefined) return this.source.length;
    return Math.min(this.source.length, start + pos.col);
  }

  slice(span: A.Span): string {
    return this.source.slice(this.offset(span.start), this.offset(span.end));
  }

  line(line: number): string {
    const start = this.starts[line];
    if (start === undefined) return '';
    const next = this.starts[line + 1] ?? this.source.length;
    return this.source.slice(start, next).replace(/[\r\n]+$/, '');
  }

  endPosition(): A.Pos {
    const line = this.starts.length - 1;
    return { line, col: this.source.length - this.starts[line] };
  }
}

function makeContext(source: string, options: RefactorOptions): Context | string[] {
  const parsed = parse(source);
  const problems = [
    ...parsed.lexIssues.map((issue) => `The source has a lexer error at ${issue.line + 1}:${issue.col + 1}: ${issue.message}`),
    ...parsed.errors.map((error) => `The source has a syntax error at ${error.line + 1}:${error.col + 1}: ${error.message}`),
  ];
  if (problems.length) return problems;
  const index = new DeclIndex();
  index.addProgram(parsed.program, options.file);
  if (options.index) index.addIndex(externalDeclarations(options.index, options.file));
  return {
    source,
    parsed,
    index,
    checked: check(parsed.program, {
      index,
      text: source,
      yieldCalls: options.yieldCalls,
      trustedNonBlockingNativeDeclarations: options.trustedNonBlockingNativeDeclarations,
    }),
    yieldCalls: options.yieldCalls,
    trustedNonBlockingNativeDeclarations: options.trustedNonBlockingNativeDeclarations,
    offsets: new SourceOffsets(source),
  };
}

/** Remove the stale copy of the current file from a workspace index. */
function externalDeclarations(input: DeclIndex, ownFile: string | undefined): DeclIndex {
  if (!ownFile) return input;
  const out = new DeclIndex();
  for (const [name, signatures] of input.procs) {
    const imported = signatures.filter((signature) => signature.file !== ownFile);
    if (imported.length) out.procs.set(name, imported);
  }
  for (const [name, record] of input.records) if (record.file !== ownFile) out.records.set(name, record);
  for (const [name, protocol] of input.protocols) if (protocol.file !== ownFile) out.protocols.set(name, protocol);
  for (const [name, constant] of input.consts) if (constant.file !== ownFile) out.consts.set(name, constant);
  for (const name of input.externs) out.externs.add(name);
  return out;
}

function errorCodes(checked: CheckResult): Map<string, number> {
  const out = new Map<string, number>();
  for (const diagnostic of checked.diagnostics) {
    if (diagnostic.severity !== 'error') continue;
    const code = diagnostic.code ?? 'unknown';
    out.set(code, (out.get(code) ?? 0) + 1);
  }
  return out;
}

const BLOCKING_DIAGNOSTICS = new Set([
  'pj/barrier-not-enrolled',
  'pj/channel-no-reader',
  'pj/channel-no-writer',
  'pj/channel-self-deadlock',
  'pj/par-deadlock',
]);

function diagnosticCounts(checked: CheckResult, wanted: ReadonlySet<string>): Map<string, { code: string; count: number }> {
  const out = new Map<string, { code: string; count: number }>();
  for (const diagnostic of checked.diagnostics) {
    const code = diagnostic.code ?? 'unknown';
    if (!wanted.has(code)) continue;
    const key = `${code}\0${diagnostic.message}`;
    const current = out.get(key);
    out.set(key, { code, count: (current?.count ?? 0) + 1 });
  }
  return out;
}

function newBlockingDiagnostics(before: CheckResult, after: CheckResult): string[] {
  const oldCounts = diagnosticCounts(before, BLOCKING_DIAGNOSTICS);
  const newCounts = diagnosticCounts(after, BLOCKING_DIAGNOSTICS);
  const reasons: string[] = [];
  for (const [key, current] of newCounts) {
    const added = current.count - (oldCounts.get(key)?.count ?? 0);
    if (added > 0) reasons.push(`The rewrite introduces ${added} confirmed blocking hazard${added === 1 ? '' : 's'} (${current.code}).`);
  }
  return reasons;
}

function existingErrors(ctx: Context): string[] {
  return ctx.checked.diagnostics
    .filter((diagnostic) => diagnostic.severity === 'error')
    .map((diagnostic) => `Fix ${diagnostic.code} on line ${diagnostic.line + 1} before refactoring.`);
}

function validateCleanCandidate(ctx: Context, edits: RefactorEdit[], options: RefactorOptions): string[] {
  const candidate = applyRefactorEdits(ctx.source, edits);
  const built = makeContext(candidate, options);
  if (Array.isArray(built)) return built.map((reason) => `The planned rewrite is not valid: ${reason}`);
  return [
    ...existingErrors(built).map((reason) => `The planned rewrite did not type-check: ${reason}`),
    ...newBlockingDiagnostics(ctx.checked, built.checked),
  ];
}

function validateDiagnosticCandidate(ctx: Context, edits: RefactorEdit[], diagnosticCode: string, options: RefactorOptions): string[] {
  const candidate = applyRefactorEdits(ctx.source, edits);
  const built = makeContext(candidate, options);
  if (Array.isArray(built)) return built.map((reason) => `The planned rewrite is not valid: ${reason}`);
  const before = errorCodes(ctx.checked);
  const after = errorCodes(built.checked);
  const reasons: string[] = [];
  if ((after.get(diagnosticCode) ?? 0) >= (before.get(diagnosticCode) ?? 0)) reasons.push(`The rewrite does not remove the ${diagnosticCode} diagnostic.`);
  for (const [code, count] of after) {
    if (count > (before.get(code) ?? 0)) reasons.push(`The rewrite introduces ${count - (before.get(code) ?? 0)} ${code} error${count - (before.get(code) ?? 0) === 1 ? '' : 's'}.`);
  }
  reasons.push(...newBlockingDiagnostics(ctx.checked, built.checked));
  return reasons;
}

function collectStatementLists(program: A.Program): StatementList[] {
  const lists: StatementList[] = [];
  for (const declaration of program.decls) {
    if (declaration.kind !== 'ProcDecl' || !declaration.body) continue;
    collectBlock(declaration.body, declaration, { inPar: false, inClaim: false, inExtendedRendezvous: false }, lists);
  }
  return lists;
}

function collectBlock(block: A.Block, procedure: A.ProcDecl, flags: Omit<StatementList, 'statements' | 'procedure'>, lists: StatementList[]): void {
  lists.push({ statements: block.stmts, procedure, ...flags });
  for (const statement of block.stmts) collectNestedStatement(statement, procedure, flags, lists);
}

function collectNestedStatement(statement: A.Stmt, procedure: A.ProcDecl, flags: Omit<StatementList, 'statements' | 'procedure'>, lists: StatementList[]): void {
  switch (statement.kind) {
    case 'Block':
      collectBlock(statement, procedure, flags, lists);
      break;
    case 'IfStmt':
      collectNestedStatement(statement.then, procedure, flags, lists);
      if (statement.else) collectNestedStatement(statement.else, procedure, flags, lists);
      collectExpressionBlocks(statement.cond, procedure, flags, lists);
      break;
    case 'WhileStmt':
    case 'DoStmt':
      collectNestedStatement(statement.body, procedure, flags, lists);
      collectExpressionBlocks(statement.cond, procedure, flags, lists);
      break;
    case 'ForStmt':
      collectNestedStatement(statement.body, procedure, flags, lists);
      if (Array.isArray(statement.init)) for (const expression of statement.init) collectExpressionBlocks(expression, procedure, flags, lists);
      else if (statement.init) collectNestedStatement(statement.init, procedure, flags, lists);
      if (statement.cond) collectExpressionBlocks(statement.cond, procedure, flags, lists);
      for (const expression of [...statement.update, ...statement.enroll]) collectExpressionBlocks(expression, procedure, flags, lists);
      break;
    case 'ParBlock':
      collectBlock(statement.body, procedure, { ...flags, inPar: true }, lists);
      for (const expression of statement.barriers) collectExpressionBlocks(expression, procedure, flags, lists);
      break;
    case 'SeqBlock':
      collectBlock(statement.body, procedure, flags, lists);
      break;
    case 'ClaimStmt':
      collectNestedStatement(statement.body, procedure, { ...flags, inClaim: true }, lists);
      for (const channel of statement.channels) {
        if (channel.kind === 'LocalDecl') collectNestedStatement(channel, procedure, flags, lists);
        else collectExpressionBlocks(channel, procedure, flags, lists);
      }
      break;
    case 'SwitchStmt':
      collectExpressionBlocks(statement.expr, procedure, flags, lists);
      for (const group of statement.groups) {
        lists.push({ statements: group.stmts, procedure, ...flags });
        for (const nested of group.stmts) collectNestedStatement(nested, procedure, flags, lists);
        for (const label of group.labels) if (label) collectExpressionBlocks(label, procedure, flags, lists);
      }
      break;
    case 'AltStmt':
      if (statement.replicated) {
        if (Array.isArray(statement.replicated.init)) for (const expression of statement.replicated.init) collectExpressionBlocks(expression, procedure, flags, lists);
        else if (statement.replicated.init) collectNestedStatement(statement.replicated.init, procedure, flags, lists);
        if (statement.replicated.cond) collectExpressionBlocks(statement.replicated.cond, procedure, flags, lists);
        for (const expression of statement.replicated.update) collectExpressionBlocks(expression, procedure, flags, lists);
      }
      for (const c of statement.cases) {
        if (c.precondition) collectExpressionBlocks(c.precondition, procedure, flags, lists);
        if (c.guard?.kind === 'ReadGuard') collectExpressionBlocks(c.guard.read, procedure, flags, lists);
        else if (c.guard?.kind === 'TimeoutGuard') collectExpressionBlocks(c.guard.timeout, procedure, flags, lists);
        if (c.nested) collectNestedStatement(c.nested, procedure, flags, lists);
        if (c.body) collectNestedStatement(c.body, procedure, flags, lists);
      }
      break;
    case 'LabeledStmt':
      collectNestedStatement(statement.stmt, procedure, flags, lists);
      break;
    case 'LocalDecl':
      for (const declarator of statement.declarators) if (declarator.init) collectExpressionBlocks(declarator.init, procedure, flags, lists);
      break;
    case 'ExprStmt':
      collectExpressionBlocks(statement.expr, procedure, flags, lists);
      break;
    case 'ReturnStmt':
      if (statement.expr) collectExpressionBlocks(statement.expr, procedure, flags, lists);
      break;
    default:
      break;
  }
}

function collectExpressionBlocks(expression: A.Expr, procedure: A.ProcDecl, flags: Omit<StatementList, 'statements' | 'procedure'>, lists: StatementList[]): void {
  if (expression.kind === 'ChanRead' && expression.extended) {
    collectBlock(expression.extended, procedure, { ...flags, inExtendedRendezvous: true }, lists);
  }
  forEachChildExpression(expression, (child) => collectExpressionBlocks(child, procedure, flags, lists));
}

/** Some parser productions (notably local declarations) stop just before `;`. */
function effectiveStatementSpan(ctx: Context, statement: A.Stmt): A.Span {
  const semicolon = ctx.parsed.tokens.find((token) => token.text === ';' && token.line === statement.span.end.line && token.col === statement.span.end.col);
  return semicolon ? { start: statement.span.start, end: { line: semicolon.line, col: semicolon.end } } : statement.span;
}

function selectStatements(ctx: Context, selection: A.Span): StatementSelection | string[] {
  if (comparePos(selection.start, selection.end) >= 0) return ['Select one or more complete statements.'];
  const matches: StatementSelection[] = [];
  let sawPartial = false;
  for (const list of collectStatementLists(ctx.parsed.program)) {
    const spans = new Map(list.statements.map((statement) => [statement, effectiveStatementSpan(ctx, statement)]));
    const intersecting = list.statements.filter((statement) => overlaps(spans.get(statement)!, selection));
    if (intersecting.some((statement) => !containsSpan(selection, spans.get(statement)!))) {
      sawPartial = true;
      continue;
    }
    const selected = list.statements.filter((statement) => containsSpan(selection, spans.get(statement)!));
    if (!selected.length) continue;
    const firstIndex = list.statements.indexOf(selected[0]);
    const lastIndex = list.statements.indexOf(selected[selected.length - 1]);
    if (lastIndex - firstIndex + 1 !== selected.length) continue;
    const range: A.Span = { start: spans.get(selected[0])!.start, end: spans.get(selected[selected.length - 1])!.end };
    const prefix: A.Span = { start: selection.start, end: range.start };
    const suffix: A.Span = { start: range.end, end: selection.end };
    if (!/^\s*$/.test(ctx.offsets.slice(prefix)) || !/^\s*$/.test(ctx.offsets.slice(suffix))) continue;
    matches.push({ ...list, selected, range });
  }
  if (!matches.length) return [sawPartial ? 'The selection cuts through a statement; select complete statements only.' : 'The selection does not contain complete contiguous statements from one block.'];
  matches.sort((a, b) => spanSize(a.range) - spanSize(b.range));
  return matches[0];
}

function forEachChildExpression(expression: A.Expr, visit: (child: A.Expr) => void): void {
  switch (expression.kind) {
    case 'ParenExpr':
      visit(expression.expr);
      break;
    case 'BinaryExpr':
      visit(expression.left);
      visit(expression.right);
      break;
    case 'UnaryExpr':
      visit(expression.operand);
      break;
    case 'AssignExpr':
      visit(expression.target);
      visit(expression.value);
      break;
    case 'TernaryExpr':
      visit(expression.cond);
      visit(expression.then);
      visit(expression.else);
      break;
    case 'CastExpr':
    case 'IsExpr':
      visit(expression.expr);
      break;
    case 'Invocation':
      if (expression.target) visit(expression.target);
      for (const argument of expression.args) visit(argument);
      break;
    case 'RecordAccess':
      visit(expression.target);
      break;
    case 'ArrayAccess':
      visit(expression.target);
      visit(expression.index);
      break;
    case 'ChanEnd':
      visit(expression.target);
      break;
    case 'ChanRead':
      visit(expression.target);
      break;
    case 'ChanWrite':
      visit(expression.target);
      visit(expression.value);
      break;
    case 'Sync':
      visit(expression.target);
      break;
    case 'Timeout':
      visit(expression.target);
      visit(expression.delay);
      break;
    case 'NewArray':
      for (const dimension of expression.dimExprs) visit(dimension);
      if (expression.init) visit(expression.init);
      break;
    case 'ArrayLiteral':
      for (const element of expression.elements) visit(element);
      break;
    case 'RecordLiteral':
    case 'ProtocolLiteral':
      for (const field of expression.fields) visit(field.value);
      break;
    default:
      break;
  }
}

function emptyFacts(): WalkFacts {
  return { uses: [], invocations: [], channelOps: [], hasSynchronization: false, hasOpaqueSynchronization: false, hasNestedConcurrency: false, hasControlTransfer: false };
}

function factsFor(statements: A.Stmt[], checked: CheckResult): WalkFacts {
  const facts = emptyFacts();
  forEachReachableStatement(statements, (statement) => walkStatement(statement, checked, facts));
  return facts;
}

function emitName(expression: A.NameExpr, role: UseRole, operation: A.Span, checked: CheckResult, facts: WalkFacts, invocation?: A.Invocation, argumentIndex?: number): void {
  facts.uses.push({ expression, role, operation, invocation, argumentIndex });
  if (role === 'chan-read' || role === 'chan-write' || role === 'chan-end-read' || role === 'chan-end-write') {
    facts.channelOps.push({ variable: checked.resolutions.get(expression), direction: role.endsWith('read') ? 'read' : 'write', span: operation });
  }
}

function walkStatement(statement: A.Stmt, checked: CheckResult, facts: WalkFacts): void {
  switch (statement.kind) {
    case 'Block':
      forEachReachableStatement(statement.stmts, (nested) => walkStatement(nested, checked, facts));
      break;
    case 'LocalDecl':
      for (const declarator of statement.declarators) if (declarator.init) walkExpression(declarator.init, checked, facts);
      break;
    case 'ExprStmt':
      walkExpression(statement.expr, checked, facts);
      break;
    case 'IfStmt':
      walkExpression(statement.cond, checked, facts);
      walkStatement(statement.then, checked, facts);
      if (statement.else) walkStatement(statement.else, checked, facts);
      break;
    case 'WhileStmt':
    case 'DoStmt':
      walkExpression(statement.cond, checked, facts);
      walkStatement(statement.body, checked, facts);
      break;
    case 'ForStmt':
      if (statement.isPar) facts.hasNestedConcurrency = true;
      if (Array.isArray(statement.init)) for (const expression of statement.init) walkExpression(expression, checked, facts);
      else if (statement.init) walkStatement(statement.init, checked, facts);
      if (statement.cond) walkExpression(statement.cond, checked, facts);
      for (const expression of [...statement.update, ...statement.enroll]) walkExpression(expression, checked, facts);
      walkStatement(statement.body, checked, facts);
      break;
    case 'ParBlock':
      facts.hasNestedConcurrency = true;
      for (const barrier of statement.barriers) walkExpression(barrier, checked, facts);
      // These are independent process branches, not a sequential block.
      for (const branch of statement.body.stmts) walkStatement(branch, checked, facts);
      break;
    case 'SeqBlock':
      walkStatement(statement.body, checked, facts);
      break;
    case 'ClaimStmt':
      facts.hasSynchronization = true;
      facts.hasOpaqueSynchronization = true;
      for (const channel of statement.channels) {
        if (channel.kind === 'LocalDecl') walkStatement(channel, checked, facts);
        else walkExpression(channel, checked, facts);
      }
      walkStatement(statement.body, checked, facts);
      break;
    case 'SwitchStmt':
      walkExpression(statement.expr, checked, facts);
      for (const group of statement.groups) {
        for (const label of group.labels) if (label) walkExpression(label, checked, facts);
        forEachReachableStatement(group.stmts, (nested) => walkStatement(nested, checked, facts));
      }
      break;
    case 'AltStmt':
      facts.hasNestedConcurrency = true;
      if (statement.replicated) {
        if (Array.isArray(statement.replicated.init)) for (const expression of statement.replicated.init) walkExpression(expression, checked, facts);
        else if (statement.replicated.init) walkStatement(statement.replicated.init, checked, facts);
        if (statement.replicated.cond) walkExpression(statement.replicated.cond, checked, facts);
        for (const expression of statement.replicated.update) walkExpression(expression, checked, facts);
      }
      for (const c of statement.cases) {
        if (c.precondition) walkExpression(c.precondition, checked, facts);
        if (c.guard?.kind === 'ReadGuard') walkExpression(c.guard.read, checked, facts);
        else if (c.guard?.kind === 'TimeoutGuard') walkExpression(c.guard.timeout, checked, facts);
        if (c.nested) walkStatement(c.nested, checked, facts);
        if (c.body) walkStatement(c.body, checked, facts);
      }
      break;
    case 'ReturnStmt':
      facts.hasControlTransfer = true;
      if (statement.expr) walkExpression(statement.expr, checked, facts);
      break;
    case 'BreakStmt':
    case 'ContinueStmt':
    case 'LabeledStmt':
    case 'StopStmt':
    case 'SuspendStmt':
      facts.hasControlTransfer = true;
      if (statement.kind === 'LabeledStmt') walkStatement(statement.stmt, checked, facts);
      break;
    default:
      break;
  }
}

function walkExpression(expression: A.Expr, checked: CheckResult, facts: WalkFacts, invocation?: A.Invocation, argumentIndex?: number): void {
  switch (expression.kind) {
    case 'NameExpr':
      emitName(expression, 'read', expression.span, checked, facts, invocation, argumentIndex);
      break;
    case 'ParenExpr':
      walkExpression(expression.expr, checked, facts, invocation, argumentIndex);
      break;
    case 'BinaryExpr':
      walkExpression(expression.left, checked, facts, invocation, argumentIndex);
      walkExpression(expression.right, checked, facts, invocation, argumentIndex);
      break;
    case 'UnaryExpr':
      if (expression.op === '++' || expression.op === '--') walkLValue(expression.operand, 'readwrite', expression.span, checked, facts);
      else walkExpression(expression.operand, checked, facts, invocation, argumentIndex);
      break;
    case 'AssignExpr':
      walkLValue(expression.target, expression.op === '=' ? 'write' : 'readwrite', expression.span, checked, facts);
      walkExpression(expression.value, checked, facts);
      break;
    case 'TernaryExpr':
      walkExpression(expression.cond, checked, facts);
      walkExpression(expression.then, checked, facts);
      walkExpression(expression.else, checked, facts);
      break;
    case 'CastExpr':
    case 'IsExpr':
      walkExpression(expression.expr, checked, facts, invocation, argumentIndex);
      break;
    case 'Invocation':
      facts.invocations.push(expression);
      if (expression.target) walkExpression(expression.target, checked, facts);
      expression.args.forEach((argument, index) => walkExpression(argument, checked, facts, expression, index));
      break;
    case 'RecordAccess':
      walkExpression(expression.target, checked, facts, invocation, argumentIndex);
      break;
    case 'ArrayAccess':
      walkExpression(expression.target, checked, facts, invocation, argumentIndex);
      walkExpression(expression.index, checked, facts);
      break;
    case 'ChanEnd':
      walkChannelTarget(expression.target, `chan-end-${expression.end}`, expression.span, checked, facts, invocation, argumentIndex);
      break;
    case 'ChanRead':
      facts.hasSynchronization = true;
      facts.hasOpaqueSynchronization ||= !!expression.extended;
      walkChannelTarget(expression.target, 'chan-read', expression.span, checked, facts, invocation, argumentIndex);
      if (expression.extended) walkStatement(expression.extended, checked, facts);
      break;
    case 'ChanWrite':
      facts.hasSynchronization = true;
      walkChannelTarget(expression.target, 'chan-write', expression.span, checked, facts, invocation, argumentIndex);
      walkExpression(expression.value, checked, facts);
      break;
    case 'Sync':
      facts.hasSynchronization = true;
      facts.hasOpaqueSynchronization = true;
      walkExpression(expression.target, checked, facts);
      break;
    case 'Timeout':
      facts.hasSynchronization = true;
      facts.hasOpaqueSynchronization = true;
      walkExpression(expression.target, checked, facts);
      walkExpression(expression.delay, checked, facts);
      break;
    case 'NewArray':
      for (const dimension of expression.dimExprs) walkExpression(dimension, checked, facts);
      if (expression.init) walkExpression(expression.init, checked, facts);
      break;
    case 'ArrayLiteral':
      for (const element of expression.elements) walkExpression(element, checked, facts);
      break;
    case 'RecordLiteral':
    case 'ProtocolLiteral':
      for (const field of expression.fields) walkExpression(field.value, checked, facts);
      break;
    default:
      break;
  }
}

function walkChannelTarget(target: A.Expr, role: Extract<UseRole, `chan-${string}`>, operation: A.Span, checked: CheckResult, facts: WalkFacts, invocation?: A.Invocation, argumentIndex?: number): void {
  if (target.kind === 'NameExpr') {
    emitName(target, role, operation, checked, facts, invocation, argumentIndex);
    return;
  }
  if (target.kind === 'ChanEnd') {
    walkChannelTarget(target.target, `chan-end-${target.end}`, operation, checked, facts, invocation, argumentIndex);
    return;
  }
  facts.channelOps.push({ direction: role.endsWith('read') ? 'read' : 'write', span: operation });
  walkExpression(target, checked, facts, invocation, argumentIndex);
}

function walkLValue(target: A.Expr, role: 'write' | 'readwrite', operation: A.Span, checked: CheckResult, facts: WalkFacts): void {
  if (target.kind === 'NameExpr') {
    emitName(target, role, operation, checked, facts);
    return;
  }
  const root = rootName(target);
  if (root) emitName(root, 'mutation', operation, checked, facts);
  if (target.kind === 'ArrayAccess') walkExpression(target.index, checked, facts);
  forEachChildExpression(target, (child) => {
    if (child !== root && (target.kind !== 'ArrayAccess' || child !== target.index)) walkExpression(child, checked, facts);
  });
}

function rootName(expression: A.Expr): A.NameExpr | undefined {
  if (expression.kind === 'NameExpr') return expression;
  if (expression.kind === 'RecordAccess' || expression.kind === 'ArrayAccess') return rootName(expression.target);
  if (expression.kind === 'ParenExpr') return rootName(expression.expr);
  return undefined;
}

function declarationSites(program: A.Program): Map<A.Ident, DeclSite> {
  const sites = new Map<A.Ident, DeclSite>();
  for (const declaration of program.decls) {
    if (declaration.kind !== 'ProcDecl') continue;
    declaration.params.forEach((parameter, parameterIndex) => sites.set(parameter.name, { type: parameter.type, procedure: declaration, parameter, parameterIndex }));
    if (declaration.body) collectLocalSites(declaration.body, declaration, sites);
  }
  return sites;
}

function collectLocalSites(statement: A.Stmt, procedure: A.ProcDecl, sites: Map<A.Ident, DeclSite>): void {
  if (statement.kind === 'LocalDecl') {
    for (const declarator of statement.declarators) sites.set(declarator.name, { type: statement.type, procedure, local: statement, declarator });
  }
  switch (statement.kind) {
    case 'Block':
      statement.stmts.forEach((nested) => collectLocalSites(nested, procedure, sites));
      break;
    case 'IfStmt':
      collectLocalSites(statement.then, procedure, sites);
      if (statement.else) collectLocalSites(statement.else, procedure, sites);
      break;
    case 'WhileStmt':
    case 'DoStmt':
      collectLocalSites(statement.body, procedure, sites);
      break;
    case 'ForStmt':
      if (statement.init && !Array.isArray(statement.init)) collectLocalSites(statement.init, procedure, sites);
      collectLocalSites(statement.body, procedure, sites);
      break;
    case 'ParBlock':
    case 'SeqBlock':
      collectLocalSites(statement.body, procedure, sites);
      break;
    case 'ClaimStmt':
      for (const channel of statement.channels) if (channel.kind === 'LocalDecl') collectLocalSites(channel, procedure, sites);
      collectLocalSites(statement.body, procedure, sites);
      break;
    case 'SwitchStmt':
      for (const group of statement.groups) group.stmts.forEach((nested) => collectLocalSites(nested, procedure, sites));
      break;
    case 'AltStmt':
      if (statement.replicated?.init && !Array.isArray(statement.replicated.init)) collectLocalSites(statement.replicated.init, procedure, sites);
      for (const c of statement.cases) {
        if (c.nested) collectLocalSites(c.nested, procedure, sites);
        if (c.body) collectLocalSites(c.body, procedure, sites);
      }
      break;
    case 'LabeledStmt':
      collectLocalSites(statement.stmt, procedure, sites);
      break;
    default:
      break;
  }
}

function allUses(ctx: Context): UseEvent[] {
  return allWalkFacts(ctx).uses;
}

function allWalkFacts(ctx: Context): WalkFacts {
  const facts = emptyFacts();
  for (const declaration of ctx.parsed.program.decls) if (declaration.kind === 'ProcDecl' && declaration.body) walkStatement(declaration.body, ctx.checked, facts);
  return facts;
}

function inferIndent(ctx: Context, line: number, requested?: string): string {
  if (requested !== undefined) return requested;
  const current = /^\s*/.exec(ctx.offsets.line(line))?.[0] ?? '';
  if (/\t/.test(current)) return '\t';
  const widths = collectStatementLists(ctx.parsed.program)
    .flatMap((list) => list.statements.map((statement) => /^ */.exec(ctx.offsets.line(statement.span.start.line))?.[0].length ?? 0))
    .filter((width) => width > 0)
    .sort((a, b) => a - b);
  return ' '.repeat(widths[0] ?? 4);
}

function newlineOf(source: string): string {
  return /\r\n|\r|\n/.exec(source)?.[0] ?? '\n';
}

function baseIndent(ctx: Context, line: number): string {
  return /^\s*/.exec(ctx.offsets.line(line))?.[0] ?? '';
}

function dedentSelection(text: string, indent: string): string[] {
  const lines = text.split(/\r\n|\r|\n/);
  return lines.map((line, index) => index > 0 && line.startsWith(indent) ? line.slice(indent.length) : line);
}

function indentText(lines: string[], prefix: string, newline: string): string {
  return lines.map((line) => line.length ? `${prefix}${line}` : line).join(newline);
}

function isIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !RESERVED.has(name);
}

function uniqueProcedureName(index: DeclIndex, preferred: string): string {
  const used = new Set(index.allNames());
  if (!used.has(preferred)) return preferred;
  let suffix = 2;
  while (used.has(`${preferred}${suffix}`)) suffix++;
  return `${preferred}${suffix}`;
}

function exactType(t: VarInfo['type']): boolean {
  if (t.k === 'unknown' || t.k === 'error' || t.k === 'null') return false;
  if (t.k === 'array') return exactType(t.elem);
  if (t.k === 'chan') return exactType(t.elem);
  return true;
}

/**
 * Extract complete, contiguous statements to a private top-level procedure.
 * Only input captures are supported: writes to outer locals and declarations
 * that escape the selection are refused instead of being guessed into returns.
 */
export function planExtractProcedure(source: string, selection: A.Span, options: ExtractProcedureOptions = {}): RefactorResult {
  const made = makeContext(source, options);
  if (Array.isArray(made)) return refuse(...made);
  const ctx = made;
  const errors = existingErrors(ctx);
  if (errors.length) return refuse(...errors);
  const found = selectStatements(ctx, selection);
  if (Array.isArray(found)) return refuse(...found);
  if (found.inClaim) return refuse('Code inside a claim cannot be extracted without changing the claim\'s exclusive ownership region.');
  if (found.inExtendedRendezvous) return refuse('Code inside an extended rendezvous cannot be extracted without changing the rendezvous lifetime.');

  const facts = factsFor(found.selected, ctx.checked);
  if (facts.hasControlTransfer) return refuse('The selection contains return, break, continue, or a label whose target would change after extraction.');
  if (facts.hasNestedConcurrency) return refuse('Nested par/alt constructs are not extracted automatically; their process ownership needs an explicit review.');

  const selectedVariables = new Set(ctx.checked.vars.filter((variable) => containsSpan(found.range, variable.decl.span)));
  // One pass over the file's resolutions rather than one per selected local.
  const usedOutside = new Set<VarInfo>();
  for (const [expression, resolved] of ctx.checked.resolutions) {
    if (selectedVariables.has(resolved) && !containsSpan(found.range, expression.span)) usedOutside.add(resolved);
  }
  const escaping = [...selectedVariables].filter((variable) => usedOutside.has(variable));
  if (escaping.length) return refuse(...escaping.map((variable) => `Local '${variable.name}' is declared in the selection but used afterward.`));

  const roles = new Map<VarInfo, Set<UseRole>>();
  for (const use of facts.uses) {
    const variable = ctx.checked.resolutions.get(use.expression);
    if (!variable || containsSpan(found.range, variable.decl.span)) continue;
    let set = roles.get(variable);
    if (!set) roles.set(variable, set = new Set());
    set.add(use.role);
  }
  const reasons: string[] = [];
  for (const [variable, usedAs] of roles) {
    if (!exactType(variable.type)) reasons.push(`The exact type of captured variable '${variable.name}' is not known.`);
    if ([...usedAs].some((role) => role === 'write' || role === 'readwrite' || role === 'mutation')) reasons.push(`Captured variable '${variable.name}' is modified; extraction supports input-only captures.`);
    if (variable.type.k === 'protocol') reasons.push(`Protocol variable '${variable.name}' cannot safely be captured as a generated parameter with the current compiler.`);
    if (variable.type.k === 'chan') {
      const ends = new Set([...usedAs].flatMap((role): Array<'read' | 'write'> => role.endsWith('read') ? ['read'] : role.endsWith('write') ? ['write'] : []));
      if (!variable.type.end && ([...usedAs].some((role) => role === 'read') || ends.size !== 1)) reasons.push(`Channel '${variable.name}' is used as a whole channel or from both ends; extraction cannot preserve unique ownership.`);
      if (variable.type.end && ends.size && !ends.has(variable.type.end)) reasons.push(`Channel end '${variable.name}' is used in a direction that disagrees with its declaration.`);
    }
  }
  if (reasons.length) return refuse(...reasons);

  const requested = options.name ?? 'extracted';
  if (!isIdentifier(requested)) return refuse(`'${requested}' is not a valid, non-reserved ProcessJ procedure name.`);
  const name = uniqueProcedureName(ctx.index, requested);
  const captures = [...roles.keys()].sort((a, b) => comparePos(a.decl.span.start, b.decl.span.start));
  const parameters: string[] = [];
  const arguments_: string[] = [];
  for (const variable of captures) {
    const usedAs = roles.get(variable)!;
    if (variable.type.k === 'chan' && !variable.type.end) {
      const direction = [...usedAs].some((role) => role.endsWith('write')) ? 'write' : 'read';
      parameters.push(`${typeStr(endOf(variable.type, direction))} ${variable.name}`);
      arguments_.push(`${variable.name}.${direction}`);
    } else {
      parameters.push(`${typeStr(variable.type)} ${variable.name}`);
      arguments_.push(variable.name);
    }
  }

  const newline = newlineOf(source);
  const outerIndent = baseIndent(ctx, found.range.start.line);
  const step = inferIndent(ctx, found.range.start.line, options.indent);
  const selectedText = ctx.offsets.slice(found.range);
  const body = indentText(dedentSelection(selectedText, outerIndent), step, newline);
  const yields = found.selected.some((statement) => new YieldAnalysis(ctx.index, ctx.checked.calls, ctx.yieldCalls).stmtYields(statement, 'calls'));
  const annotation = yields ? ' [yield=true]' : '';
  const separator = source.length === 0 ? '' : source.endsWith('\n') || source.endsWith('\r') ? newline : `${newline}${newline}`;
  const procedure = `${separator}private void ${name}(${parameters.join(', ')})${annotation} {${newline}${body}${newline}}${newline}`;
  const eof = ctx.offsets.endPosition();
  const edits: RefactorEdit[] = [
    { range: found.range, newText: `${name}(${arguments_.join(', ')});` },
    { range: { start: eof, end: eof }, newText: procedure },
  ];
  const invalid = validateCleanCandidate(ctx, edits, options);
  if (invalid.length) return refuse(...invalid);
  return { ok: true, plan: { kind: 'extract-procedure', title: `Extract to procedure '${name}'`, edits } };
}

function straightLineForPar(statement: A.Stmt): boolean {
  switch (statement.kind) {
    case 'Block':
      return statement.stmts.every(straightLineForPar);
    case 'LocalDecl':
    case 'ExprStmt':
    case 'SkipStmt':
    case 'EmptyStmt':
      return true;
    default:
      return false;
  }
}

function variableAccess(facts: WalkFacts, checked: CheckResult): Map<VarInfo, { read: boolean; write: boolean }> {
  const out = new Map<VarInfo, { read: boolean; write: boolean }>();
  for (const use of facts.uses) {
    if (use.role.startsWith('chan-')) continue;
    const variable = checked.resolutions.get(use.expression);
    if (!variable) continue;
    let access = out.get(variable);
    if (!access) out.set(variable, access = { read: false, write: false });
    access.read ||= use.role === 'read' || use.role === 'readwrite';
    access.write ||= use.role === 'write' || use.role === 'readwrite' || use.role === 'mutation';
  }
  return out;
}

function proveChannelSchedule(branches: WalkFacts[]): string[] {
  const queues = branches.map((branch) => [...branch.channelOps]);
  for (const queue of queues) {
    if (queue.some((operation) => !operation.variable || operation.variable.type.k !== 'chan' || !!operation.variable.type.end)) {
      return ['A channel operation uses an unresolved or already-separated endpoint, so a matching peer cannot be proved locally.'];
    }
  }
  const proof = proveAllRendezvousSchedulesComplete(queues, (left, right) => left.variable === right.variable && left.direction !== right.direction);
  if (proof.kind === 'safe') return [];
  if (proof.kind === 'budget') return [`The selected channel operations exceed the bounded rendezvous proof budget (${proof.states} states), so the refactor is refused.`];
  return ['At least one legal rendezvous schedule can deadlock when each selected statement becomes a branch.'];
}

/** Wrap independent complete statements in a `par` block after a local effect proof. */
export function planRunInPar(source: string, selection: A.Span, options: RefactorOptions = {}): RefactorResult {
  const made = makeContext(source, options);
  if (Array.isArray(made)) return refuse(...made);
  const ctx = made;
  const errors = existingErrors(ctx);
  if (errors.length) return refuse(...errors);
  const found = selectStatements(ctx, selection);
  if (Array.isArray(found)) return refuse(...found);
  if (found.selected.length < 2) return refuse('Select at least two complete statements to run in parallel.');
  if (found.inPar) return refuse('The selection is already inside a par branch.');
  if (found.inClaim || found.inExtendedRendezvous) return refuse('The selection is inside a synchronization ownership region that cannot be split into processes.');
  if (found.selected.some((statement) => statement.kind === 'LocalDecl')) return refuse('A top-level declaration would become local to one par branch; select executable statements after the declarations.');
  if (found.selected.some((statement) => !straightLineForPar(statement))) return refuse('Only straight-line blocks, declarations, and expression statements can be proven independent locally.');

  const branches = found.selected.map((statement) => factsFor([statement], ctx.checked));
  const reasons: string[] = [];
  for (const branch of branches) {
    if (branch.invocations.length) reasons.push('Procedure calls may have hidden state or I/O effects; local independence cannot be proved.');
    if (branch.hasOpaqueSynchronization) reasons.push('Barrier, timeout, claim, or extended-rendezvous effects cannot be proven independent locally.');
    if (branch.hasNestedConcurrency || branch.hasControlTransfer) reasons.push('Nested concurrency or control transfer cannot be safely split into a new par block.');
    if (branch.uses.some((use) => use.role === 'mutation')) reasons.push('A record or array mutation may alias state used by another branch; local independence cannot be proved.');
  }
  const accesses = branches.map((branch) => variableAccess(branch, ctx.checked));
  for (let left = 0; left < accesses.length; left++) {
    for (let right = left + 1; right < accesses.length; right++) {
      for (const [variable, a] of accesses[left]) {
        const b = accesses[right].get(variable);
        if (b && (a.write || b.write)) reasons.push(`Statements ${left + 1} and ${right + 1} both depend on '${variable.name}', with at least one write.`);
      }
    }
  }
  reasons.push(...proveChannelSchedule(branches));
  if (reasons.length) return refuse(...reasons);

  const newline = newlineOf(source);
  const outerIndent = baseIndent(ctx, found.range.start.line);
  const step = inferIndent(ctx, found.range.start.line, options.indent);
  const selectedText = ctx.offsets.slice(found.range);
  const body = indentText(dedentSelection(selectedText, outerIndent), `${outerIndent}${step}`, newline);
  const edit: RefactorEdit = { range: found.range, newText: `par {${newline}${body}${newline}${outerIndent}}` };
  const invalid = validateCleanCandidate(ctx, [edit], options);
  if (invalid.length) return refuse(...invalid);
  return { ok: true, plan: { kind: 'run-in-par', title: 'Run independent statements in parallel', edits: [edit] } };
}

function chanType(type: A.TypeNode): A.ChanType | undefined {
  return type.kind === 'ChanType' ? type : undefined;
}

function tokenSpan(ctx: Context, type: A.ChanType, word: string): A.Span | undefined {
  const candidates = ctx.parsed.tokens.filter((token) => token.text === word && containsSpan(type.span, { start: { line: token.line, col: token.col }, end: { line: token.line, col: token.end } }));
  const token = candidates[candidates.length - 1];
  return token ? { start: { line: token.line, col: token.col }, end: { line: token.line, col: token.end } } : undefined;
}

function externalSignature(procedure: A.ProcDecl): boolean {
  return !procedure.modifiers.includes('private');
}

function diagnosticUse(ctx: Context, range: A.Span): UseEvent | undefined {
  const candidates = allUses(ctx).filter((use) => overlaps(use.operation, range) || overlaps(use.expression.span, range) || containsSpan(use.operation, range) || containsSpan(range, use.operation));
  const directChannelRank = (use: UseEvent): number => use.role === 'chan-read' || use.role === 'chan-write' ? 0 : 1;
  candidates.sort((a, b) => directChannelRank(a) - directChannelRank(b) || spanSize(a.operation) - spanSize(b.operation));
  return candidates[0];
}

function dedupeEdits(edits: RefactorEdit[]): RefactorEdit[] {
  const seen = new Set<string>();
  return edits.filter((edit) => {
    const key = `${edit.range.start.line}:${edit.range.start.col}-${edit.range.end.line}:${edit.range.end.col}:${edit.newText}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Correct a channel-end parameter and every exactly resolved in-file caller. */
export function planCorrectChannelDirection(source: string, range: A.Span, options: RefactorOptions = {}): RefactorResult {
  const made = makeContext(source, options);
  if (Array.isArray(made)) return refuse(...made);
  const ctx = made;
  const hit = diagnosticUse(ctx, range);
  if (!hit || (hit.role !== 'chan-read' && hit.role !== 'chan-write')) return refuse('The diagnostic does not identify a direct channel read or write with an exact binding.');
  const variable = ctx.checked.resolutions.get(hit.expression);
  if (!variable || variable.type.k !== 'chan' || !variable.type.end) return refuse('The operation is not bound to a declared channel-end parameter.');
  const desired: 'read' | 'write' = hit.role === 'chan-read' ? 'read' : 'write';
  if (variable.type.end === desired) return refuse(`'${variable.name}' is already a ${desired} end.`);
  const site = declarationSites(ctx.parsed.program).get(variable.decl);
  if (!site?.parameter || site.parameterIndex === undefined) return refuse('Only channel-end parameters can be corrected safely; local endpoint aliases are not supported by the compiler.');
  if (externalSignature(site.procedure) && !options.allowExternalCallers) return refuse(`Changing '${site.procedure.name.name}' would change a public/protected signature; enable external-caller edits explicitly after reviewing other files.`);
  const syntax = chanType(site.type);
  if (!syntax?.end) return refuse('The parameter declaration does not have a concrete .read or .write token to replace.');

  const uses = allUses(ctx).filter((use) => ctx.checked.resolutions.get(use.expression) === variable);
  if (uses.some((use) => !use.role.startsWith('chan-'))) return refuse(`Channel end '${variable.name}' is also used as an ordinary value, so changing its direction cannot be propagated exactly.`);
  const operatedDirections = new Set(uses.filter((use) => use.role === 'chan-read' || use.role === 'chan-write').map((use) => use.role === 'chan-read' ? 'read' : 'write'));
  if (operatedDirections.size !== 1 || !operatedDirections.has(desired)) return refuse(`Channel end '${variable.name}' is used in both directions inside '${site.procedure.name.name}'.`);

  const declarationToken = tokenSpan(ctx, syntax, syntax.end);
  if (!declarationToken) return refuse('Could not locate the exact direction token in the parameter declaration.');
  const edits: RefactorEdit[] = [{ range: declarationToken, newText: desired }];
  let callers = 0;
  for (const [invocation, signature] of ctx.checked.calls) {
    if (signature.decl !== site.procedure) continue;
    callers++;
    const argument = invocation.args[site.parameterIndex];
    if (!argument) return refuse(`A resolved call to '${site.procedure.name.name}' has no corresponding argument.`);
    if (argument.kind !== 'ChanEnd') return refuse(`A caller passes an endpoint variable to '${site.procedure.name.name}'; its declaration would need a cross-signature rewrite.`);
    if (argument.end === desired) continue;
    const matchingTokens = ctx.parsed.tokens.filter((token) => token.text === argument.end && containsSpan(argument.span, { start: { line: token.line, col: token.col }, end: { line: token.line, col: token.end } }));
    const endToken = matchingTokens[matchingTokens.length - 1];
    if (!endToken) return refuse(`Could not locate an exact endpoint token at a call to '${site.procedure.name.name}'.`);
    edits.push({ range: { start: { line: endToken.line, col: endToken.col }, end: { line: endToken.line, col: endToken.end } }, newText: desired });
  }
  if (!callers && externalSignature(site.procedure) && options.allowExternalCallers) return refuse(`No in-file callers demonstrate how the public/protected signature of '${site.procedure.name.name}' should be propagated; change it manually after reviewing external callers.`);
  const finalEdits = dedupeEdits(edits);
  const invalid = validateDiagnosticCandidate(ctx, finalEdits, 'pj/channel-direction', options);
  if (invalid.length) return refuse(...invalid);
  return { ok: true, plan: { kind: 'channel-direction', title: `Change '${variable.name}' to a ${desired} channel end`, edits: finalEdits } };
}

/**
 * The innermost parallel construct around `span`. A `par for` replicates its body
 * rather than listing branches, but its ownership rules are the same, so the
 * shared-channel plan accepts both.
 */
function containingPar(program: A.Program, span: A.Span): A.ParBlock | A.ForStmt | undefined {
  let best: A.ParBlock | A.ForStmt | undefined;
  const visit = (statement: A.Stmt): void => {
    const parallel = statement.kind === 'ParBlock' || (statement.kind === 'ForStmt' && statement.isPar);
    if (parallel && containsSpan(statement.span, span) && (!best || spanSize(statement.span) < spanSize(best.span))) best = statement;
    switch (statement.kind) {
      case 'Block': statement.stmts.forEach(visit); break;
      case 'IfStmt': visit(statement.then); if (statement.else) visit(statement.else); break;
      case 'WhileStmt': case 'DoStmt': visit(statement.body); break;
      case 'ForStmt': visit(statement.body); break;
      case 'ParBlock': case 'SeqBlock': visit(statement.body); break;
      case 'ClaimStmt': visit(statement.body); break;
      case 'SwitchStmt': statement.groups.forEach((group) => group.stmts.forEach(visit)); break;
      case 'AltStmt': statement.cases.forEach((c) => { if (c.nested) visit(c.nested); if (c.body) visit(c.body); }); break;
      case 'LabeledStmt': visit(statement.stmt); break;
      default: break;
    }
  };
  for (const declaration of program.decls) if (declaration.kind === 'ProcDecl' && declaration.body) visit(declaration.body);
  return best;
}

function isDirectStatement(program: A.Program, target: A.Stmt): boolean {
  return collectStatementLists(program).some((list) => list.statements.includes(target));
}

function conditionallyEvaluates(expression: A.Expr, target: A.NameExpr, conditional = false): boolean | undefined {
  if (expression === target) return conditional;
  const visit = (child: A.Expr, nextConditional = conditional): boolean | undefined => conditionallyEvaluates(child, target, nextConditional);
  switch (expression.kind) {
    case 'ParenExpr':
      return visit(expression.expr);
    case 'BinaryExpr':
      return visit(expression.left) ?? visit(expression.right, conditional || expression.op === '&&' || expression.op === '||');
    case 'UnaryExpr':
      return visit(expression.operand);
    case 'AssignExpr':
      return visit(expression.target) ?? visit(expression.value);
    case 'TernaryExpr':
      return visit(expression.cond) ?? visit(expression.then, true) ?? visit(expression.else, true);
    case 'CastExpr':
    case 'IsExpr':
      return visit(expression.expr);
    case 'Invocation': {
      if (expression.target) {
        const result = visit(expression.target);
        if (result !== undefined) return result;
      }
      for (const argument of expression.args) {
        const result = visit(argument);
        if (result !== undefined) return result;
      }
      return undefined;
    }
    case 'RecordAccess':
      return visit(expression.target);
    case 'ArrayAccess':
      return visit(expression.target) ?? visit(expression.index);
    case 'ChanEnd':
    case 'ChanRead':
    case 'Sync':
      return visit(expression.target);
    case 'ChanWrite':
      return visit(expression.target) ?? visit(expression.value);
    case 'Timeout':
      return visit(expression.target) ?? visit(expression.delay);
    case 'NewArray':
      for (const dimension of expression.dimExprs) {
        const result = visit(dimension);
        if (result !== undefined) return result;
      }
      return expression.init ? visit(expression.init) : undefined;
    case 'ArrayLiteral':
      for (const element of expression.elements) {
        const result = visit(element);
        if (result !== undefined) return result;
      }
      return undefined;
    case 'RecordLiteral':
    case 'ProtocolLiteral':
      for (const field of expression.fields) {
        const result = visit(field.value);
        if (result !== undefined) return result;
      }
      return undefined;
    default:
      return undefined;
  }
}

function conditionallyEvaluatesUse(statement: A.Stmt, target: A.NameExpr): boolean {
  switch (statement.kind) {
    case 'Block':
      return statement.stmts.some((nested) => conditionallyEvaluatesUse(nested, target));
    case 'LocalDecl':
      return statement.declarators.some((declarator) => !!declarator.init && conditionallyEvaluates(declarator.init, target) === true);
    case 'ExprStmt':
      return conditionallyEvaluates(statement.expr, target) === true;
    default:
      return false;
  }
}

function commentSpan(comment: ParseResult['comments'][number]): A.Span {
  return { start: { line: comment.line, col: comment.col }, end: { line: comment.endLine, col: comment.endCol } };
}

function directAssignments(statement: A.Stmt, variable: VarInfo, checked: CheckResult): A.AssignExpr[] {
  const out: A.AssignExpr[] = [];
  const visit = (candidate: A.Stmt): void => {
    if (candidate.kind === 'Block') {
      candidate.stmts.forEach(visit);
      return;
    }
    if (candidate.kind !== 'ExprStmt' || candidate.expr.kind !== 'AssignExpr' || candidate.expr.op !== '=' || candidate.expr.target.kind !== 'NameExpr') return;
    if (checked.resolutions.get(candidate.expr.target) === variable) out.push(candidate.expr);
  };
  visit(statement);
  return out;
}

function uniqueLocalName(ctx: Context, preferred: string): string {
  const used = new Set([...ctx.index.allNames(), ...ctx.checked.vars.map((variable) => variable.name)]);
  if (!used.has(preferred)) return preferred;
  let suffix = 2;
  while (used.has(`${preferred}${suffix}`)) suffix++;
  return `${preferred}${suffix}`;
}

const NON_SYNCHRONIZING_OUTPUT_CALLS = new Set(['print', 'println']);

/**
 * ProcessJ's standard print procedures are native leaf calls: unlike an
 * ordinary procedure invocation, they cannot hide ProcessJ rendezvous. Keep
 * this deliberately tiny allow-list so a future library call is not silently
 * assumed safe.
 */
function isNonSynchronizingOutputCall(invocation: A.Invocation, ctx: Context): boolean {
  if (invocation.target || invocation.qualifier?.length || !NON_SYNCHRONIZING_OUTPUT_CALLS.has(invocation.name.name)) return false;
  const selected = ctx.checked.calls.get(invocation);
  // Spelling alone is not a proof: an unresolved or user-provided procedure
  // named println may still synchronize. Only an exactly resolved native leaf
  // is safe to exempt from the conservative call refusal.
  if (!selected) return false;
  return !selected.decl.body
    && selected.decl.modifiers.includes('native')
    && !selected.decl.modifiers.includes('mobile')
    && ctx.trustedNonBlockingNativeDeclarations?.has(selected.decl) === true
    && !selected.decl.annotations.some((annotation) => annotation.name === 'yield' && annotation.value === 'true');
}

function introducedRendezvousHazards(branches: WalkFacts[], ctx: Context): string[] {
  const reasons: string[] = [];
  const yields = new YieldAnalysis(ctx.index, ctx.checked.calls, ctx.yieldCalls);
  branches.forEach((branch, index) => {
    if (branch.hasNestedConcurrency) {
      reasons.push(`Par branch ${index + 1} contains nested par, par-for, or alt behavior; adding a rendezvous around that scheduler boundary could create a circular wait.`);
    }
    if (branch.hasControlTransfer) {
      reasons.push(`Par branch ${index + 1} contains return, stop, suspend, break, continue, or a label; adding a rendezvous could leave its peer blocked when control transfers first.`);
    }
    if (branch.hasOpaqueSynchronization) {
      reasons.push(`Par branch ${index + 1} contains a barrier, timeout, claim, or extended rendezvous; adding another rendezvous could create a circular wait.`);
    }
    for (const invocation of branch.invocations) {
      if (isNonSynchronizingOutputCall(invocation, ctx)) continue;
      const selected = ctx.checked.calls.get(invocation);
      const detail = selected && yields.procYields(selected.decl)
        ? 'may block or synchronize'
        : 'has call ordering, termination, or hidden effects that are not proven safe';
      reasons.push(`Par branch ${index + 1} calls '${invocation.name.name}', which ${detail}; adding a rendezvous channel could create a circular wait.`);
    }
  });
  return reasons;
}

/**
 * Replace one proven producer/consumer data race with a rendezvous channel.
 * This is intentionally diagnostic-driven: a cursor alone does not identify
 * which value edge the author intends to communicate.
 */
export function planIntroduceChannel(source: string, range: A.Span, options: RefactorOptions = {}): RefactorResult {
  const made = makeContext(source, options);
  if (Array.isArray(made)) return refuse(...made);
  const ctx = made;
  const hit = diagnosticUse(ctx, range);
  const variable = hit ? ctx.checked.resolutions.get(hit.expression) : undefined;
  if (!hit || !variable) return refuse('The race diagnostic is not bound to a local variable.');
  if (variable.isConst || variable.isParam || variable.type.k === 'chan' || variable.type.k === 'unknown' || variable.type.k === 'error' || variable.type.k === 'null' || (variable.type.k === 'prim' && (variable.type.name === 'void' || variable.type.name === 'barrier' || variable.type.name === 'timer'))) {
    return refuse(`'${variable.name}' does not have a compiler-supported value type for an introduced channel.`);
  }
  const par = containingPar(ctx.parsed.program, hit.operation);
  if (!par) return refuse('The conflicting use is not inside a lexical par block.');
  // Replacing a shared variable with a channel needs the branches listed, which
  // a replicated `par for` body does not give.
  if (par.kind !== 'ParBlock') return refuse('A replicated par for has no listed branches to move the value between.');
  if (!isDirectStatement(ctx.parsed.program, par)) return refuse('The par block must be a direct statement of a block before a channel declaration can be inserted safely.');

  const branchFacts = par.body.stmts.map((branch) => factsFor([branch], ctx.checked));
  const branchHazards = introducedRendezvousHazards(branchFacts, ctx);
  if (branchHazards.length) return refuse(...branchHazards);
  const uses = branchFacts.map((facts) => facts.uses.filter((use) => ctx.checked.resolutions.get(use.expression) === variable && !use.role.startsWith('chan-')));
  const writerIndexes = uses.flatMap((events, index) => events.some((event) => event.role === 'write' || event.role === 'readwrite' || event.role === 'mutation') ? [index] : []);
  const readerIndexes = uses.flatMap((events, index) => events.some((event) => event.role === 'read' || event.role === 'readwrite') ? [index] : []);
  if (new Set(writerIndexes).size !== 1) return refuse(`Exactly one par branch must produce '${variable.name}'.`);
  const writerIndex = writerIndexes[0];
  const consumerIndexes = [...new Set(readerIndexes.filter((index) => index !== writerIndex))];
  if (consumerIndexes.length !== 1) return refuse(`Exactly one other par branch must consume '${variable.name}'.`);
  const consumerIndex = consumerIndexes[0];
  if (uses[writerIndex].some((event) => event.role !== 'write')) return refuse(`The producer also reads or mutates '${variable.name}', so replacing its assignment would change the value dependency.`);
  if (uses[consumerIndex].some((event) => event.role !== 'read')) return refuse(`The consumer also writes or mutates '${variable.name}'.`);
  if (uses.some((events, index) => index !== writerIndex && index !== consumerIndex && events.length > 0)) return refuse(`Another par branch also uses '${variable.name}'.`);

  const assignments = directAssignments(par.body.stmts[writerIndex], variable, ctx.checked);
  if (assignments.length !== 1) return refuse(`The producer must contain exactly one unconditional simple assignment to '${variable.name}'.`);
  const assignment = assignments[0];
  if (ctx.parsed.comments.some((comment) => overlaps(commentSpan(comment), assignment.span) && !containsSpan(assignment.value.span, commentSpan(comment)))) {
    return refuse('The producer assignment contains trivia that cannot be moved into a channel write without losing it.');
  }
  const channelName = uniqueLocalName(ctx, `${variable.name}Channel`);
  const newline = newlineOf(source);
  const parIndent = baseIndent(ctx, par.span.start.line);
  const declaration: RefactorEdit = {
    range: { start: par.span.start, end: par.span.start },
    newText: `chan<${typeStr(variable.type)}> ${channelName};${newline}${parIndent}`,
  };
  const send: RefactorEdit = {
    range: assignment.span,
    newText: `${channelName}.write(${ctx.offsets.slice(assignment.value.span)})`,
  };

  const consumer = par.body.stmts[consumerIndex];
  if (!straightLineForPar(consumer)) return refuse(`The consumer reads '${variable.name}' conditionally or through control flow; an unconditional channel receive could deadlock.`);
  const firstReadEvent = [...uses[consumerIndex]].sort((a, b) => comparePos(a.expression.span.start, b.expression.span.start))[0];
  if (conditionallyEvaluatesUse(consumer, firstReadEvent.expression)) return refuse(`The first read of '${variable.name}' is conditional; an unconditional channel receive could deadlock.`);
  const firstRead = firstReadEvent.expression.span;
  let receive: RefactorEdit;
  if (consumer.kind === 'Block') {
    const beforeUse = consumer.stmts.find((statement) => containsSpan(statement.span, firstRead));
    if (!beforeUse) return refuse(`Could not locate a statement before the first read of '${variable.name}'.`);
    const indent = baseIndent(ctx, beforeUse.span.start.line);
    receive = { range: { start: beforeUse.span.start, end: beforeUse.span.start }, newText: `${variable.name} = ${channelName}.read();${newline}${indent}` };
  } else {
    const full = effectiveStatementSpan(ctx, consumer);
    const indent = baseIndent(ctx, full.start.line);
    const step = inferIndent(ctx, full.start.line, options.indent);
    const original = indentText(dedentSelection(ctx.offsets.slice(full), indent), `${indent}${step}`, newline);
    receive = {
      range: full,
      newText: `{${newline}${indent}${step}${variable.name} = ${channelName}.read();${newline}${original}${newline}${indent}}`,
    };
  }

  const edits = [declaration, send, receive];
  const invalid = validateDiagnosticCandidate(ctx, edits, 'pj/parallel-usage', options);
  if (invalid.length) return refuse(...invalid);
  return { ok: true, plan: { kind: 'introduce-channel', title: `Communicate '${variable.name}' through '${channelName}'`, edits } };
}

/** Mark the exact channel side shared, propagating the requirement to private in-file callees. */
interface SharedParameterRequirement {
  procedure: A.ProcDecl;
  parameter: A.Param;
  parameterIndex: number;
  variable: VarInfo;
  direction: 'read' | 'write';
  syntax: A.ChanType;
}

function unwrapParens(expression: A.Expr): A.Expr {
  let current = expression;
  while (current.kind === 'ParenExpr') current = current.expr;
  return current;
}

function exactBareArgumentVariable(argument: A.Expr, variable: VarInfo, checked: CheckResult): boolean {
  const expression = unwrapParens(argument);
  return expression.kind === 'NameExpr' && checked.resolutions.get(expression) === variable;
}

function exactWholeChannelEndArgument(argument: A.Expr, variable: VarInfo, direction: 'read' | 'write', checked: CheckResult): boolean {
  const expression = unwrapParens(argument);
  if (expression.kind !== 'ChanEnd' || expression.end !== direction) return false;
  const target = unwrapParens(expression.target);
  return target.kind === 'NameExpr' && checked.resolutions.get(target) === variable;
}

function callHasResolutionDiagnostic(ctx: Context, invocation: A.Invocation): boolean {
  return ctx.checked.diagnostics.some((diagnostic) => diagnostic.code === 'pj/type/call'
    && diagnostic.line >= invocation.span.start.line
    && diagnostic.line <= invocation.span.end.line);
}

function resolveSharedParameter(
  ctx: Context,
  invocation: A.Invocation,
  argumentIndex: number,
  direction: 'read' | 'write',
): SharedParameterRequirement | string {
  const signature = ctx.checked.calls.get(invocation);
  if (!signature || callHasResolutionDiagnostic(ctx, invocation)) {
    return `The ${direction} endpoint is passed through a call that is unresolved or ambiguous.`;
  }
  if (!ctx.parsed.program.decls.includes(signature.decl)) {
    return `The ${direction} endpoint is passed to '${signature.name}', whose declaration is outside this file.`;
  }
  if (externalSignature(signature.decl)) {
    return `Making a parameter of '${signature.name}' shared would change a public or protected signature with possible external callers.`;
  }
  if (!signature.decl.body) {
    return `The ${direction} endpoint is passed to bodyless procedure '${signature.name}', so its use cannot be followed safely.`;
  }
  const parameter = signature.decl.params[argumentIndex];
  if (!parameter) return `A resolved call to '${signature.name}' has no parameter for argument ${argumentIndex + 1}.`;
  const syntax = chanType(parameter.type);
  if (!syntax || syntax.end !== direction) {
    return `Parameter '${parameter.name.name}' of '${signature.name}' does not expose the exact ${direction} endpoint expected by the call.`;
  }
  const variable = ctx.checked.vars.find((candidate) => candidate.decl === parameter.name);
  if (!variable || variable.type.k !== 'chan' || variable.type.end !== direction) {
    return `Parameter '${parameter.name.name}' of '${signature.name}' has no exact in-file channel-end binding.`;
  }
  return { procedure: signature.decl, parameter, parameterIndex: argumentIndex, variable, direction, syntax };
}

function sharedParameterCycle(edges: Map<A.Param, Set<A.Param>>): A.Param[] | undefined {
  const indegree = new Map<A.Param, number>();
  for (const [parameter, next] of edges) {
    if (!indegree.has(parameter)) indegree.set(parameter, 0);
    for (const target of next) indegree.set(target, (indegree.get(target) ?? 0) + 1);
  }
  const ready = [...indegree].filter(([, degree]) => degree === 0).map(([parameter]) => parameter);
  let removed = 0;
  for (let cursor = 0; cursor < ready.length; cursor++) {
    const parameter = ready[cursor];
    removed++;
    for (const target of edges.get(parameter) ?? []) {
      const degree = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, degree);
      if (degree === 0) ready.push(target);
    }
  }
  if (removed === indegree.size) return undefined;
  return [...indegree].filter(([, degree]) => degree > 0).slice(0, 4).map(([parameter]) => parameter);
}

function argumentWillBeShared(
  ctx: Context,
  argument: A.Expr,
  direction: 'read' | 'write',
  root: VarInfo,
  rootSide: 'read' | 'write' | undefined,
  requiredVariables: ReadonlySet<VarInfo>,
): boolean {
  const expression = unwrapParens(argument);
  if (expression.kind === 'NameExpr') {
    const resolved = ctx.checked.resolutions.get(expression);
    if (resolved && requiredVariables.has(resolved)) return true;
    return !!resolved && resolved.type.k === 'chan' && resolved.type.end === direction && resolved.type.shared;
  }
  if ((!rootSide || rootSide === direction) && exactWholeChannelEndArgument(argument, root, direction, ctx.checked)) return true;
  if (expression.kind !== 'ChanEnd' || expression.end !== direction) return false;
  const target = unwrapParens(expression.target);
  if (target.kind !== 'NameExpr') return false;
  const resolved = ctx.checked.resolutions.get(target);
  return !!resolved
    && resolved.type.k === 'chan'
    && !resolved.type.end
    && resolved.type.shared
    && (!resolved.type.sharedSide || resolved.type.sharedSide === direction);
}

export function planMakeChannelShared(source: string, range: A.Span, options: RefactorOptions = {}): RefactorResult {
  const made = makeContext(source, options);
  if (Array.isArray(made)) return refuse(...made);
  const ctx = made;
  const hit = diagnosticUse(ctx, range);
  if (!hit || !hit.role.startsWith('chan-')) return refuse('The diagnostic does not identify a channel operation or endpoint with an exact binding.');
  const variable = ctx.checked.resolutions.get(hit.expression);
  if (!variable || variable.type.k !== 'chan' || variable.type.end) return refuse('The diagnostic is not bound to a whole local channel declaration.');
  if (variable.type.shared) return refuse(`Channel '${variable.name}' is already shared.`);
  const site = declarationSites(ctx.parsed.program).get(variable.decl);
  if (!site?.local || !site.declarator) return refuse('Only local whole-channel declarations can be made shared automatically.');
  if (site.local.declarators.length !== 1) return refuse('Split the multi-variable channel declaration first so sharing applies to exactly one binding.');
  const syntax = chanType(site.type);
  if (!syntax || syntax.shared) return refuse('The channel declaration does not have an unshared chan type that can be rewritten exactly.');
  const par = containingPar(ctx.parsed.program, hit.operation);
  if (!par) return refuse('The channel use is not inside a par block, so repeated ownership cannot be established locally.');

  const walked = allWalkFacts(ctx);
  const rootUses = walked.uses.filter((use) => ctx.checked.resolutions.get(use.expression) === variable);
  if (rootUses.some((use) => !use.role.startsWith('chan-'))) return refuse(`Channel '${variable.name}' also escapes as a bare or opaque value, so sharing cannot be propagated exactly.`);
  // Every iteration of a `par for` is a process, so one use in its body is
  // already repeated ownership; a par block needs the use in two branches.
  const replicated = par.kind === 'ForStmt';
  const branches: A.Stmt[] = replicated ? [par.body] : par.body.stmts;
  const branchUses = branches.map((branch) => factsFor([branch], ctx.checked).uses.filter((use) => ctx.checked.resolutions.get(use.expression) === variable && use.role.startsWith('chan-')));
  const readers = branchUses.flatMap((uses, branch) => uses.some((use) => use.role.endsWith('read')) ? [branch] : []);
  const writers = branchUses.flatMap((uses, branch) => uses.some((use) => use.role.endsWith('write')) ? [branch] : []);
  const repeatedRead = replicated ? readers.length > 0 : new Set(readers).size > 1;
  const repeatedWrite = replicated ? writers.length > 0 : new Set(writers).size > 1;
  if (!repeatedRead && !repeatedWrite) return refuse('No channel side is held by more than one lexical par branch.');

  const side: 'read' | 'write' | undefined = repeatedRead === repeatedWrite ? undefined : repeatedRead ? 'read' : 'write';
  const prefix = side ? `shared ${side} ` : 'shared ';
  const edits: RefactorEdit[] = [{ range: { start: syntax.span.start, end: syntax.span.start }, newText: prefix }];

  const requirements = new Map<A.Param, SharedParameterRequirement>();
  const queue: SharedParameterRequirement[] = [];
  const edges = new Map<A.Param, Set<A.Param>>();
  const enqueue = (requirement: SharedParameterRequirement): void => {
    const existing = requirements.get(requirement.parameter);
    if (existing) return;
    requirements.set(requirement.parameter, requirement);
    queue.push(requirement);
  };

  // Changing the declaration changes this side everywhere, not just inside the
  // par that exposed the ownership error. Seed the closure from every exact
  // endpoint pass so an out-of-par helper cannot silently discard sharing.
  for (const use of rootUses) {
    const direction: 'read' | 'write' = use.role.endsWith('read') ? 'read' : 'write';
    if (side && direction !== side) continue;
    if (use.role !== 'chan-end-read' && use.role !== 'chan-end-write') continue;
    if (!use.invocation || use.argumentIndex === undefined) return refuse('A shared endpoint escapes outside a resolved procedure call; propagation is not exact.');
    const argument = use.invocation.args[use.argumentIndex];
    if (!argument || !exactWholeChannelEndArgument(argument, variable, direction, ctx.checked)) return refuse('A shared endpoint is wrapped or transformed before the call; propagation is not exact.');
    const requirement = resolveSharedParameter(ctx, use.invocation, use.argumentIndex, direction);
    if (typeof requirement === 'string') return refuse(requirement);
    enqueue(requirement);
  }

  const usesByVariable = new Map<VarInfo, UseEvent[]>();
  for (const use of walked.uses) {
    const resolved = ctx.checked.resolutions.get(use.expression);
    if (!resolved) continue;
    const uses = usesByVariable.get(resolved);
    if (uses) uses.push(use);
    else usesByVariable.set(resolved, [use]);
  }

  for (let cursor = 0; cursor < queue.length; cursor++) {
    const requirement = queue[cursor];
    if (!requirement.syntax.shared) edits.push({ range: { start: requirement.syntax.span.start, end: requirement.syntax.span.start }, newText: 'shared ' });
    for (const use of usesByVariable.get(requirement.variable) ?? []) {
      if (use.role === `chan-${requirement.direction}`) continue;
      if (use.role !== 'read' || !use.invocation || use.argumentIndex === undefined) {
        return refuse(`Channel end '${requirement.parameter.name.name}' in '${requirement.procedure.name.name}' has a direct, opposite-direction, or opaque use that cannot be propagated exactly.`);
      }
      const argument = use.invocation.args[use.argumentIndex];
      if (!argument || !exactBareArgumentVariable(argument, requirement.variable, ctx.checked)) {
        return refuse(`Channel end '${requirement.parameter.name.name}' is wrapped or transformed before a call; propagation is not exact.`);
      }
      const next = resolveSharedParameter(ctx, use.invocation, use.argumentIndex, requirement.direction);
      if (typeof next === 'string') return refuse(next);
      const outgoing = edges.get(requirement.parameter);
      if (outgoing) outgoing.add(next.parameter);
      else edges.set(requirement.parameter, new Set([next.parameter]));
      enqueue(next);
    }
  }

  const cycle = sharedParameterCycle(edges);
  if (cycle) return refuse(`Shared endpoint propagation enters a recursive cycle involving ${cycle.map((parameter) => `'${parameter.name.name}'`).join(', ')}, so the rewrite is refused rather than assuming a terminal use.`);

  const requiredIndexes = new Map<A.ProcDecl, Set<number>>();
  for (const requirement of requirements.values()) {
    const indexes = requiredIndexes.get(requirement.procedure);
    if (indexes) indexes.add(requirement.parameterIndex);
    else requiredIndexes.set(requirement.procedure, new Set([requirement.parameterIndex]));
  }
  for (const procedure of requiredIndexes.keys()) {
    const signatures = ctx.index.procs.get(procedure.name.name) ?? [];
    const projected = new Map<string, A.ProcDecl>();
    for (const signature of signatures) {
      const changed = requiredIndexes.get(signature.decl);
      const key = signature.params.map((type, index) => typeStr(changed?.has(index) && type.k === 'chan' ? { ...type, shared: true } : type)).join('\0');
      const previous = projected.get(key);
      if (previous && previous !== signature.decl && (changed || requiredIndexes.has(previous))) {
        return refuse(`Making the propagated endpoint shared would collide with another '${procedure.name.name}' overload.`);
      }
      projected.set(key, signature.decl);
    }
  }

  const requiredVariables = new Set([...requirements.values()].map((requirement) => requirement.variable));
  const callsByProcedure = new Map<A.ProcDecl, A.Invocation[]>();
  const unresolvedCallShapes = new Set<string>();
  for (const invocation of walked.invocations) {
    if (invocation.target || invocation.qualifier?.length) continue;
    const signature = ctx.checked.calls.get(invocation);
    if (!signature) {
      unresolvedCallShapes.add(`${invocation.name.name}\0${invocation.args.length}`);
      continue;
    }
    const calls = callsByProcedure.get(signature.decl);
    if (calls) calls.push(invocation);
    else callsByProcedure.set(signature.decl, [invocation]);
  }
  for (const requirement of requirements.values()) {
    if (unresolvedCallShapes.has(`${requirement.procedure.name.name}\0${requirement.procedure.params.length}`)) {
      return refuse(`A possible caller of '${requirement.procedure.name.name}' is unresolved, so all callers cannot be proven safe.`);
    }
    for (const invocation of callsByProcedure.get(requirement.procedure) ?? []) {
      if (callHasResolutionDiagnostic(ctx, invocation)) return refuse(`A caller of '${requirement.procedure.name.name}' is ambiguous, so all callers cannot be proven safe.`);
      const argument = invocation.args[requirement.parameterIndex];
      if (!argument || !argumentWillBeShared(ctx, argument, requirement.direction, variable, side, requiredVariables)) {
        return refuse(`Caller of '${requirement.procedure.name.name}' passes an unshared or opaque ${requirement.direction} endpoint to '${requirement.parameter.name.name}'.`);
      }
    }
  }

  const finalEdits = dedupeEdits(edits);
  const invalid = validateDiagnosticCandidate(ctx, finalEdits, 'pj/shared-channel-end', options);
  if (invalid.length) return refuse(...invalid);
  return { ok: true, plan: { kind: 'channel-sharing', title: `Make the ${side ?? 'read and write'} side${side ? '' : 's'} of '${variable.name}' shared`, edits: finalEdits } };
}

/** Route an LSP/checker diagnostic to the applicable exact-binding repair. */
export function planChannelDiagnostic(source: string, diagnostic: ChannelDiagnostic, options: RefactorOptions = {}): RefactorResult {
  if (diagnostic.code === 'pj/channel-direction') return planCorrectChannelDirection(source, diagnostic.range, options);
  if (diagnostic.code === 'pj/shared-channel-end') return planMakeChannelShared(source, diagnostic.range, options);
  return planIntroduceChannel(source, diagnostic.range, options);
}

/** Apply a plan without a vscode dependency; primarily useful to clients and tests. */
export function applyRefactorEdits(source: string, edits: readonly RefactorEdit[]): string {
  const offsets = new SourceOffsets(source);
  const ordered = edits.map((edit, order) => ({ edit, order, start: offsets.offset(edit.range.start), end: offsets.offset(edit.range.end) }))
    .sort((a, b) => b.start - a.start || b.end - a.end || b.order - a.order);
  let out = source;
  let previousStart = source.length + 1;
  for (const item of ordered) {
    if (item.end > previousStart) throw new Error('Refactor edits overlap.');
    out = out.slice(0, item.start) + item.edit.newText + out.slice(item.end);
    previousStart = item.start;
  }
  return out;
}
