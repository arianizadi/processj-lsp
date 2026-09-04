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
export const TOKEN_MODIFIERS = ['declaration', 'readonly', 'defaultLibrary', 'channelRead', 'channelWrite', 'channelShared', 'blocking', 'escaped'] as const;

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
  const toksBySpan = new Map<string, Tok>();
  const choiceReads = new WeakSet<A.ChanRead>();
  const typeIdx = (t: TokenType) => TOKEN_TYPES.indexOf(t);
  const modBits = (...ms: Modifier[]) => ms.reduce((acc, m) => acc | (1 << TOKEN_MODIFIERS.indexOf(m)), 0);
  const add = (id: A.Ident | { span: A.Span }, type: TokenType, ...mods: Modifier[]) => {
    const s = id.span;
    if (s.start.line !== s.end.line || s.end.col <= s.start.col) return;
    const key = `${s.start.line}:${s.start.col}:${s.end.col}`;
    const bits = modBits(...mods);
    const existing = toksBySpan.get(key);
    if (existing) {
      // The AST can expose the same identifier through a wrapper and its
      // operation. LSP forbids overlapping semantic tokens, so merge modifier
      // facts into the one token rather than emitting a duplicate range.
      existing.mods |= bits;
      return;
    }
    const token = { line: s.start.line, col: s.start.col, len: s.end.col - s.start.col, type: typeIdx(type), mods: bits };
    toksBySpan.set(key, token);
    toks.push(token);
  };
  const addQualified = (id: A.Ident, type: TokenType, ...mods: Modifier[]): void => {
    for (const q of id.qualifier ?? []) add(q, 'namespace');
    add(id, type, ...mods);
  };
  const typeNode = (t: A.TypeNode): void => {
    switch (t.kind) {
      case 'NamedType': {
        const n = t.name.name;
        if (index.protocols.has(n)) addQualified(t.name, 'enum');
        else addQualified(t.name, 'struct');
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

  const nameExpr = (e: A.NameExpr, ...extra: Modifier[]): void => {
    for (const q of e.qualifier ?? []) add(q, 'namespace');
    const v = checked.resolutions.get(e);
    if (v) add(e.name, v.isParam ? 'parameter' : 'variable', ...(v.isConst ? (['readonly'] as Modifier[]) : []), ...extra);
    else if (index.consts.has(e.name.name)) add(e.name, 'variable', 'readonly', ...extra);
    else if (checked.types.get(e)?.k === 'protocol' && !e.qualifier) add(e.name, 'enumMember', ...extra);
    else if (index.procs.has(e.name.name)) add(e.name, 'function', ...extra);
    else if (index.records.has(e.name.name)) add(e.name, 'struct', ...extra);
    else if (index.protocols.has(e.name.name)) add(e.name, 'enum', ...extra);
  };

  const operationModifiers = (target: A.Expr, end?: 'read' | 'write', blocking = false, escaped = false): Modifier[] => {
    const modifiers: Modifier[] = [];
    const t = checked.types.get(target);
    if (t?.k === 'chan') {
      if (end === 'read') modifiers.push('channelRead');
      if (end === 'write') modifiers.push('channelWrite');
      if (t.shared) modifiers.push('channelShared');
    }
    if (blocking) modifiers.push('blocking');
    if (escaped) modifiers.push('escaped');
    return modifiers;
  };

  const operationTarget = (target: A.Expr, end?: 'read' | 'write', blocking = false, escaped = false): void => {
    const modifiers = operationModifiers(target, end, blocking, escaped);
    const carrier = (candidate: A.Expr): void => {
      switch (candidate.kind) {
        case 'NameExpr':
          nameExpr(candidate, ...modifiers);
          return;
        case 'ParenExpr':
          return carrier(candidate.expr);
        case 'CastExpr':
          typeNode(candidate.type);
          return carrier(candidate.expr);
        case 'ChanEnd':
          // In `c.read.read()` the selected end is part of the direct read,
          // not an escaped endpoint value.
          return carrier(candidate.target);
        case 'RecordAccess':
          expr(candidate.target);
          add(candidate.member, 'property', ...modifiers);
          return;
        case 'ArrayAccess':
          carrier(candidate.target);
          expr(candidate.index);
          return;
        default:
          return expr(candidate);
      }
    };
    carrier(target);
  };

  const isExplicitChanEnd = (argument: A.Expr): boolean => {
    while (argument.kind === 'ParenExpr' || argument.kind === 'CastExpr') argument = argument.expr;
    return argument.kind === 'ChanEnd';
  };

  const expr = (e: A.Expr): void => {
    switch (e.kind) {
      case 'Literal':
      case 'ErrorExpr':
        return;
      case 'NameExpr': {
        nameExpr(e);
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
        addQualified(e.typeName, 'enumMember');
        return;
      case 'Invocation': {
        if (e.target) expr(e.target);
        for (const q of e.qualifier ?? []) add(q, 'namespace');
        const sig = checked.calls.get(e);
        const lib = sig?.file && opts.libraryFiles?.has(sig.file);
        add(e.name, 'function', ...(lib ? (['defaultLibrary'] as Modifier[]) : []));
        e.args.forEach((argument, index) => {
          expr(argument);
          // `g(c.read)` is annotated while visiting its ChanEnd. For an end
          // already stored in a parameter or aggregate (`g(out)`, `g(r.out)`),
          // recover the pass from the selected overload. Requiring the checked
          // actual and formal to agree avoids inventing a role for unresolved or
          // invalid calls, and keeps explicit selectors from gaining both roles.
          if (isExplicitChanEnd(argument)) return;
          const actual = checked.types.get(argument);
          const formal = sig?.params[index];
          if (actual?.k !== 'chan' || !actual.end || formal?.k !== 'chan' || formal.end !== actual.end) return;
          operationTarget(argument, actual.end, false, true);
        });
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
        return operationTarget(e.target, e.end, false, true);
      case 'ChanRead': {
        const targetType = checked.types.get(e.target);
        // `timer.read()` returns the current time and does not rendezvous or
        // suspend, despite sharing the channel-read AST shape.
        const channel = targetType?.k === 'chan';
        operationTarget(e.target, channel ? 'read' : undefined, channel && !choiceReads.has(e));
        if (e.extended) block(e.extended);
        return;
      }
      case 'ChanWrite':
        operationTarget(e.target, 'write', true);
        expr(e.value);
        return;
      case 'Sync':
        return operationTarget(e.target, undefined, true);
      case 'Timeout':
        operationTarget(e.target, undefined, true);
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
        addQualified(e.typeName, 'struct');
        for (const f of e.fields) {
          add(f.name, 'property');
          expr(f.value);
        }
        return;
      case 'ProtocolLiteral':
        addQualified(e.typeName, 'enum');
        add(e.tag, 'enumMember');
        for (const f of e.fields) {
          add(f.name, 'property');
          expr(f.value);
        }
        return;
      case 'NewMobile':
        addQualified(e.typeName, 'function');
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
            if (s.cases.length > 1) choiceReads.add(c.guard.read);
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
        for (const i of d.implements) addQualified(i, 'type');
        if (d.body) block(d.body);
        break;
      case 'RecordDecl':
        add(d.name, 'struct', 'declaration');
        for (const e of d.extends) addQualified(e, 'struct');
        for (const m of d.members) {
          typeNode(m.type);
          add(m.name, 'property', 'declaration');
        }
        break;
      case 'ProtocolDecl':
        add(d.name, 'enum', 'declaration');
        for (const e of d.extends) addQualified(e, 'enum');
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
