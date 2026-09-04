/**
 * Symbols (declarations and locals) derived from the real parse tree. Produces
 * the same `PJSymbol` shape the regex extractor did, so completion, hover,
 * definition and the lints keep working unchanged, but now with proper scoping.
 */
import type * as A from './parser/ast';
import { identToString, typeToString } from './parser/ast';
import type { ParseResult } from './parser/parser';
import type { PJSymbol } from './symbols';
import type { CommentToken, Token } from './tokens';

export interface AstSymbols {
  symbols: PJSymbol[];
  locals: PJSymbol[];
}

export function astSymbols(parsed: ParseResult): AstSymbols {
  const symbols: PJSymbol[] = [];
  const locals: PJSymbol[] = [];
  const docs = new DocFinder(parsed.comments, parsed.tokens);

  for (const d of parsed.program.decls) {
    switch (d.kind) {
      case 'ProcDecl': {
        const params = d.params.map((p) => `${p.isConst ? 'const ' : ''}${typeToString(p.type)} ${p.name.name}`);
        const mods = d.modifiers.length ? d.modifiers.join(' ') + ' ' : '';
        symbols.push({
          name: d.name.name,
          kind: 'proc',
          line: d.name.span.start.line,
          startCol: d.name.span.start.col,
          endCol: d.name.span.end.col,
          endLine: d.span.end.line,
          detail: `${mods}${typeToString(d.returnType)} ${d.name.name}(${params.join(', ')})`,
          doc: docs.above(d.span.start.line),
          params,
        });
        for (const p of d.params) {
          locals.push(local(p.name, `${typeToString(p.type)} ${p.name.name} (parameter)`, d.name.name));
        }
        if (d.body) collectLocals(d.body, d.name.name, locals);
        break;
      }
      case 'RecordDecl':
        symbols.push({
          name: d.name.name,
          kind: 'record',
          line: d.name.span.start.line,
          startCol: d.name.span.start.col,
          endCol: d.name.span.end.col,
          endLine: d.span.end.line,
          detail: `record ${d.name.name}${d.extends.length ? ` extends ${d.extends.map(identToString).join(', ')}` : ''}`,
          doc: docs.above(d.span.start.line),
          children: d.members.map((m) => ({
            name: m.name.name,
            kind: 'field' as const,
            line: m.name.span.start.line,
            startCol: m.name.span.start.col,
            endCol: m.name.span.end.col,
            endLine: m.span.end.line,
            detail: `${typeToString(m.type)} ${m.name.name}`,
            container: d.name.name,
          })),
        });
        break;
      case 'ProtocolDecl':
        symbols.push({
          name: d.name.name,
          kind: 'protocol',
          line: d.name.span.start.line,
          startCol: d.name.span.start.col,
          endCol: d.name.span.end.col,
          endLine: d.span.end.line,
          detail: `protocol ${d.name.name}${d.extends.length ? ` extends ${d.extends.map(identToString).join(', ')}` : ''}`,
          doc: docs.above(d.span.start.line),
          children: (d.cases ?? []).map((c) => ({
            name: c.name.name,
            kind: 'case' as const,
            line: c.name.span.start.line,
            startCol: c.name.span.start.col,
            endCol: c.name.span.end.col,
            endLine: c.span.end.line,
            detail: `${c.name.name} : { ${c.members.map((m) => `${typeToString(m.type)} ${m.name.name};`).join(' ')}${c.members.length ? ' ' : ''}}`,
            container: d.name.name,
          })),
        });
        break;
      case 'ConstDecl':
        for (const v of d.declarators) {
          const mods = d.modifiers.filter((m) => m !== 'const');
          symbols.push({
            name: v.name.name,
            kind: 'const',
            line: v.name.span.start.line,
            startCol: v.name.span.start.col,
            endCol: v.name.span.end.col,
            endLine: d.span.end.line,
            detail: `${mods.length ? mods.join(' ') + ' ' : ''}const ${typeToString(d.type)}${'[]'.repeat(v.dims)} ${v.name.name}`,
            doc: docs.above(d.span.start.line),
          });
        }
        break;
      case 'ExternDecl':
        symbols.push({
          name: d.name.name,
          kind: 'record',
          line: d.name.span.start.line,
          startCol: d.name.span.start.col,
          endCol: d.name.span.end.col,
          endLine: d.span.end.line,
          detail: `extern ${d.externType} ${d.name.name}`,
        });
        break;
    }
  }
  return { symbols, locals };
}

function local(name: A.Ident, detail: string, container: string): PJSymbol {
  return { name: name.name, kind: 'var', line: name.span.start.line, startCol: name.span.start.col, endCol: name.span.end.col, endLine: name.span.end.line, detail, container };
}

function collectDecl(d: A.LocalDecl, container: string, out: PJSymbol[]): void {
  for (const v of d.declarators) {
    out.push(local(v.name, `${d.isConst ? 'const ' : ''}${typeToString(d.type)}${'[]'.repeat(v.dims)} ${v.name.name}`, container));
    if (v.init) collectExpr(v.init, container, out);
  }
}

/** Walk statements collecting every local declaration, including those in for headers, claims, replicated alts and extended rendezvous blocks. */
function collectLocals(s: A.Stmt, container: string, out: PJSymbol[]): void {
  switch (s.kind) {
    case 'Block':
      for (const x of s.stmts) collectLocals(x, container, out);
      return;
    case 'LocalDecl':
      collectDecl(s, container, out);
      return;
    case 'ExprStmt':
      collectExpr(s.expr, container, out);
      return;
    case 'IfStmt':
      collectLocals(s.then, container, out);
      if (s.else) collectLocals(s.else, container, out);
      return;
    case 'WhileStmt':
    case 'DoStmt':
      collectLocals(s.body, container, out);
      return;
    case 'ForStmt':
      if (s.init && !Array.isArray(s.init)) collectDecl(s.init, container, out);
      collectLocals(s.body, container, out);
      return;
    case 'ParBlock':
    case 'SeqBlock':
      collectLocals(s.body, container, out);
      return;
    case 'ClaimStmt':
      for (const c of s.channels) if (c.kind === 'LocalDecl') collectDecl(c, container, out);
      collectLocals(s.body, container, out);
      return;
    case 'SwitchStmt':
      for (const g of s.groups) for (const x of g.stmts) collectLocals(x, container, out);
      return;
    case 'AltStmt':
      if (s.replicated?.init && !Array.isArray(s.replicated.init)) collectDecl(s.replicated.init, container, out);
      for (const c of s.cases) {
        if (c.nested) collectLocals(c.nested, container, out);
        if (c.guard?.kind === 'ReadGuard' && c.guard.read.extended) collectLocals(c.guard.read.extended, container, out);
        if (c.body) collectLocals(c.body, container, out);
      }
      return;
    case 'LabeledStmt':
      collectLocals(s.stmt, container, out);
      return;
    default:
      return;
  }
}

/** Extended rendezvous blocks can sit inside any expression, so walk every child expression. */
function collectExpr(e: A.Expr, container: string, out: PJSymbol[]): void {
  switch (e.kind) {
    case 'ChanRead':
      collectExpr(e.target, container, out);
      if (e.extended) collectLocals(e.extended, container, out);
      return;
    case 'AssignExpr':
      collectExpr(e.target, container, out);
      collectExpr(e.value, container, out);
      return;
    case 'BinaryExpr':
      collectExpr(e.left, container, out);
      collectExpr(e.right, container, out);
      return;
    case 'Invocation':
      if (e.target) collectExpr(e.target, container, out);
      for (const a of e.args) collectExpr(a, container, out);
      return;
    case 'ParenExpr':
    case 'CastExpr':
    case 'IsExpr':
      collectExpr(e.expr, container, out);
      return;
    case 'UnaryExpr':
      collectExpr(e.operand, container, out);
      return;
    case 'TernaryExpr':
      collectExpr(e.cond, container, out);
      collectExpr(e.then, container, out);
      collectExpr(e.else, container, out);
      return;
    case 'RecordAccess':
    case 'ChanEnd':
    case 'Sync':
      collectExpr(e.target, container, out);
      return;
    case 'ArrayAccess':
      collectExpr(e.target, container, out);
      collectExpr(e.index, container, out);
      return;
    case 'ChanWrite':
      collectExpr(e.target, container, out);
      collectExpr(e.value, container, out);
      return;
    case 'Timeout':
      collectExpr(e.target, container, out);
      collectExpr(e.delay, container, out);
      return;
    case 'NewArray':
      for (const d of e.dimExprs) collectExpr(d, container, out);
      if (e.init) collectExpr(e.init, container, out);
      return;
    case 'ArrayLiteral':
      for (const x of e.elements) collectExpr(x, container, out);
      return;
    case 'RecordLiteral':
    case 'ProtocolLiteral':
      for (const f of e.fields) collectExpr(f.value, container, out);
      return;
    default:
      return;
  }
}

/** Finds a line-comment run or a block comment that ends directly above a declaration line. */
class DocFinder {
  private readonly byEndLine = new Map<number, CommentToken>();

  constructor(comments: CommentToken[], tokens: Token[]) {
    // A comment that follows code on its line (`int x; // count`) annotates that
    // code, not the declaration below it. Only comments that open a line count.
    const firstCodeCol = new Map<number, number>();
    for (const token of tokens) if (!firstCodeCol.has(token.line)) firstCodeCol.set(token.line, token.col);
    // `above` is called for every declaration. Indexing once avoids repeatedly
    // scanning the full comment list (quadratic on generated/documented APIs).
    for (const comment of comments) {
      const code = firstCodeCol.get(comment.line);
      if (code !== undefined && code < comment.col) continue;
      if (!this.byEndLine.has(comment.endLine)) this.byEndLine.set(comment.endLine, comment);
    }
  }

  above(line: number): string | undefined {
    let target = line - 1;
    const run: CommentToken[] = [];
    for (;;) {
      const c = this.byEndLine.get(target);
      if (!c) break;
      run.unshift(c);
      if (c.kind === 'block') break;
      target = c.line - 1;
    }
    if (run.length === 0) return undefined;
    const text = run
      .map((c) =>
        c.kind === 'line'
          ? c.text.replace(/^\/\/\s?/, '')
          : c.text
              .split(/\r?\n/)
              .map((l) => l.trim().replace(/^\/\*+\s?/, '').replace(/\*+\/\s*$/, '').replace(/^\*\s?/, ''))
              .filter((l, i, arr) => !(l === '' && (i === 0 || i === arr.length - 1)))
              .join('\n'),
      )
      .join('\n')
      .trim();
    return text || undefined;
  }
}
