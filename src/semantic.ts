/**
 * Semantic tokens: classify every identifier using the parse tree and the
 * checker's resolutions, so highlighting knows a record from a procedure from a
 * parameter. Keywords, literals and comments are left to the editor's syntax
 * file, which handles them without a round trip.
 */
import type * as A from './parser/ast';
import type { CheckResult } from './checker/checker';
import type { DeclIndex } from './checker/index';

export const TOKEN_TYPES = ['namespace', 'type', 'struct', 'enum', 'enumMember', 'function', 'variable', 'parameter', 'property'] as const;
export const TOKEN_MODIFIERS = ['declaration', 'readonly', 'defaultLibrary'] as const;

type TokenType = (typeof TOKEN_TYPES)[number];
type Modifier = (typeof TOKEN_MODIFIERS)[number];

interface Tok {
  line: number;
  col: number;
  len: number;
  type: number;
  mods: number;
}

export interface SemanticOptions {
  /** Files that belong to the standard library (for the defaultLibrary modifier). */
  libraryFiles?: Set<string>;
}

export function semanticTokens(program: A.Program, checked: CheckResult, index: DeclIndex, opts: SemanticOptions = {}): number[] {
  const toks: Tok[] = [];
  const typeIdx = (t: TokenType) => TOKEN_TYPES.indexOf(t);
  const modBits = (...ms: Modifier[]) => ms.reduce((acc, m) => acc | (1 << TOKEN_MODIFIERS.indexOf(m)), 0);
  const add = (id: A.Ident | { span: A.Span }, type: TokenType, ...mods: Modifier[]) => {
    const s = id.span;
    if (s.start.line !== s.end.line || s.end.col <= s.start.col) return;
    toks.push({ line: s.start.line, col: s.start.col, len: s.end.col - s.start.col, type: typeIdx(type), mods: modBits(...mods) });
  };
  const typeNode = (t: A.TypeNode): void => {
    switch (t.kind) {
      case 'NamedType': {
        const n = t.name.name;
        if (index.protocols.has(n)) add(t.name, 'enum');
        else add(t.name, 'struct');
        return;
      }
      case 'ArrayType':
        return typeNode(t.elem);
      case 'ChanType':
        return typeNode(t.elem);
      default:
        return;
    }
  };

  const expr = (e: A.Expr): void => {
    switch (e.kind) {
      case 'Literal':
      case 'ErrorExpr':
        return;
      case 'NameExpr': {
        for (const q of e.qualifier ?? []) add(q, 'namespace');
        const v = checked.resolutions.get(e);
        if (v) add(e.name, v.isParam ? 'parameter' : 'variable', ...(v.isConst ? (['readonly'] as Modifier[]) : []));
        else if (index.consts.has(e.name.name)) add(e.name, 'variable', 'readonly');
        else if (checked.types.get(e)?.k === 'protocol' && !e.qualifier) add(e.name, 'enumMember'); // switch case label
        else if (index.procs.has(e.name.name)) add(e.name, 'function');
        else if (index.records.has(e.name.name)) add(e.name, 'struct');
        else if (index.protocols.has(e.name.name)) add(e.name, 'enum');
        return;
      }
      case 'ParenExpr':
        return expr(e.expr);
      case 'BinaryExpr':
        expr(e.left);
        expr(e.right);
        return;
      case 'UnaryExpr':
        return expr(e.operand);
      case 'AssignExpr':
        expr(e.target);
        expr(e.value);
        return;
      case 'TernaryExpr':
        expr(e.cond);
        expr(e.then);
        expr(e.else);
        return;
      case 'CastExpr':
        typeNode(e.type);
        expr(e.expr);
        return;
      case 'IsExpr':
        expr(e.expr);
        add(e.typeName, 'enumMember');
        return;
      case 'Invocation': {
        if (e.target) expr(e.target);
        for (const q of e.qualifier ?? []) add(q, 'namespace');
        const sig = checked.calls.get(e);
        const lib = sig?.file && opts.libraryFiles?.has(sig.file);
        add(e.name, 'function', ...(lib ? (['defaultLibrary'] as Modifier[]) : []));
        for (const a of e.args) expr(a);
        return;
      }
      case 'RecordAccess':
        expr(e.target);
        add(e.member, 'property');
        return;
      case 'ArrayAccess':
        expr(e.target);
        expr(e.index);
        return;
      case 'ChanEnd':
        return expr(e.target);
      case 'ChanRead':
        expr(e.target);
        if (e.extended) block(e.extended);
        return;
      case 'ChanWrite':
        expr(e.target);
        expr(e.value);
        return;
      case 'Sync':
        return expr(e.target);
      case 'Timeout':
        expr(e.target);
        expr(e.delay);
        return;
      case 'NewArray':
        typeNode(e.elem);
        for (const d of e.dimExprs) expr(d);
        if (e.init) expr(e.init);
        return;
      case 'ArrayLiteral':
        for (const x of e.elements) expr(x);
        return;
      case 'RecordLiteral':
        add(e.typeName, 'struct');
        for (const f of e.fields) {
          add(f.name, 'property');
          expr(f.value);
        }
        return;
      case 'ProtocolLiteral':
        add(e.typeName, 'enum');
        add(e.tag, 'enumMember');
        for (const f of e.fields) {
          add(f.name, 'property');
          expr(f.value);
        }
        return;
      case 'NewMobile':
        add(e.typeName, 'function');
        return;
    }
  };

  const decl = (d: A.LocalDecl): void => {
    typeNode(d.type);
    for (const v of d.declarators) {
      add(v.name, 'variable', 'declaration', ...(d.isConst ? (['readonly'] as Modifier[]) : []));
      if (v.init) expr(v.init);
    }
  };

  const block = (b: A.Block): void => {
    for (const s of b.stmts) stmt(s);
  };

  const stmt = (s: A.Stmt): void => {
    switch (s.kind) {
      case 'Block':
        return block(s);
      case 'LocalDecl':
        return decl(s);
      case 'ExprStmt':
        return expr(s.expr);
      case 'IfStmt':
        expr(s.cond);
        stmt(s.then);
        if (s.else) stmt(s.else);
        return;
      case 'WhileStmt':
        expr(s.cond);
        return stmt(s.body);
      case 'DoStmt':
        stmt(s.body);
        return expr(s.cond);
      case 'ForStmt':
        if (s.init) Array.isArray(s.init) ? s.init.forEach(expr) : decl(s.init);
        if (s.cond) expr(s.cond);
        s.update.forEach(expr);
        s.enroll.forEach(expr);
        return stmt(s.body);
      case 'ParBlock':
        s.barriers.forEach(expr);
        return block(s.body);
      case 'SeqBlock':
        return block(s.body);
      case 'ClaimStmt':
        for (const c of s.channels) c.kind === 'LocalDecl' ? decl(c) : expr(c);
        return stmt(s.body);
      case 'SwitchStmt':
        expr(s.expr);
        for (const g of s.groups) {
          for (const l of g.labels) if (l) expr(l);
          g.stmts.forEach(stmt);
        }
        return;
      case 'AltStmt': {
        if (s.replicated) {
          const r = s.replicated;
          if (r.init) Array.isArray(r.init) ? r.init.forEach(expr) : decl(r.init);
          if (r.cond) expr(r.cond);
          r.update.forEach(expr);
        }
        for (const c of s.cases) {
          if (c.nested) stmt(c.nested);
          if (c.precondition) expr(c.precondition);
          if (c.guard?.kind === 'ReadGuard') {
            expr(c.guard.target);
            expr(c.guard.read);
          } else if (c.guard?.kind === 'TimeoutGuard') expr(c.guard.timeout);
          if (c.body) stmt(c.body);
        }
        return;
      }
      case 'ReturnStmt':
        if (s.expr) expr(s.expr);
        return;
      case 'LabeledStmt':
        return stmt(s.stmt);
      default:
        return;
    }
  };

  for (const im of program.imports) for (const p of im.path) add(p, 'namespace');
  for (const p of program.pkg ?? []) add(p, 'namespace');
  for (const d of program.decls) {
    switch (d.kind) {
      case 'ProcDecl':
        typeNode(d.returnType);
        add(d.name, 'function', 'declaration');
        for (const p of d.params) {
          typeNode(p.type);
          add(p.name, 'parameter', 'declaration');
        }
        for (const i of d.implements) add(i, 'type');
        if (d.body) block(d.body);
        break;
      case 'RecordDecl':
        add(d.name, 'struct', 'declaration');
        for (const e of d.extends) add(e, 'struct');
        for (const m of d.members) {
          typeNode(m.type);
          add(m.name, 'property', 'declaration');
        }
        break;
      case 'ProtocolDecl':
        add(d.name, 'enum', 'declaration');
        for (const e of d.extends) add(e, 'enum');
        for (const c of d.cases ?? []) {
          add(c.name, 'enumMember', 'declaration');
          for (const m of c.members) {
            typeNode(m.type);
            add(m.name, 'property', 'declaration');
          }
        }
        break;
      case 'ConstDecl':
        typeNode(d.type);
        for (const v of d.declarators) {
          add(v.name, 'variable', 'declaration', 'readonly');
          if (v.init) expr(v.init);
        }
        break;
      case 'ExternDecl':
        add(d.name, 'type', 'declaration');
        break;
    }
  }

  toks.sort((a, b) => a.line - b.line || a.col - b.col);
  const data: number[] = [];
  let prevLine = 0;
  let prevCol = 0;
  for (const t of toks) {
    const dl = t.line - prevLine;
    const dc = dl === 0 ? t.col - prevCol : t.col;
    data.push(dl, dc, t.len, t.type, t.mods);
    prevLine = t.line;
    prevCol = t.col;
  }
  return data;
}

/** Decode LSP relative token data back into absolute tokens (used by tests). */
export function decodeTokens(data: number[]): Array<{ line: number; col: number; len: number; type: string; mods: string[] }> {
  const out: Array<{ line: number; col: number; len: number; type: string; mods: string[] }> = [];
  let line = 0;
  let col = 0;
  for (let i = 0; i < data.length; i += 5) {
    line += data[i];
    col = data[i] === 0 ? col + data[i + 1] : data[i + 1];
    const mods = TOKEN_MODIFIERS.filter((_, k) => data[i + 4] & (1 << k));
    out.push({ line, col, len: data[i + 2], type: TOKEN_TYPES[data[i + 3]], mods });
  }
  return out;
}
