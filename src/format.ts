/**
 * Formatter: parses the file and prints the AST back in a canonical layout,
 * re-attaching comments and keeping (at most one) blank line between statements.
 *
 * Style: 4-space indent, braces on the same line as their header, spaces around
 * binary operators, `chan<int>` without inner spaces, one declaration per line
 * in records, protocol cases on one line, alt guards followed by ` : `.
 * User parentheses are kept as written; nothing is added or removed.
 */
import type * as A from './parser/ast';
import { identToString, qualifierToString, typeToString } from './parser/ast';
import { parse } from './parser/parser';
import type { CommentToken } from './tokens';

export interface FormatOptions {
  indent?: string;
  maxWidth?: number;
}

export interface FormatResult {
  text?: string;
  errors: A.ParseError[];
}

export function format(source: string, opts: FormatOptions = {}): FormatResult {
  const parsed = parse(source);
  if (parsed.errors.length > 0) return { errors: parsed.errors };
  const printer = new Printer(source, parsed.comments, opts.indent ?? '    ', opts.maxWidth ?? 100);
  return { text: printer.print(parsed.program), errors: [] };
}

class Printer {
  private out: string[] = [];
  private comments: CommentToken[];
  private ci = 0;
  /** Source line of the last thing emitted, for blank-line preservation. */
  private lastSrcLine = -1;

  constructor(
    source: string,
    comments: CommentToken[],
    private readonly indentUnit: string,
    private readonly maxWidth: number,
  ) {
    void source;
    this.comments = [...comments].sort((a, b) => a.line - b.line || a.col - b.col);
  }

  // -------------------------------------------------------------------------
  // Output helpers
  // -------------------------------------------------------------------------

  private ind(level: number): string {
    return this.indentUnit.repeat(level);
  }

  private line(level: number, text: string): void {
    this.out.push(text.length ? this.ind(level) + text : '');
  }

  private blank(): void {
    if (this.out.length > 0 && this.out[this.out.length - 1] !== '') this.out.push('');
  }

  /** Insert a blank line if the source had one or more blank lines before `srcLine`. */
  private gapBefore(srcLine: number): void {
    if (this.lastSrcLine >= 0 && srcLine - this.lastSrcLine > 1) this.blank();
  }

  private nextComment(): CommentToken | undefined {
    return this.comments[this.ci];
  }

  private before(c: CommentToken, pos: A.Pos): boolean {
    return c.line < pos.line || (c.line === pos.line && c.col < pos.col);
  }

  /** Emit every comment that starts before `pos` as standalone lines at `level`. */
  private flushBefore(pos: A.Pos, level: number): void {
    for (let c = this.nextComment(); c && this.before(c, pos); c = this.nextComment()) {
      this.gapBefore(c.line);
      this.emitComment(c, level);
      this.ci++;
    }
  }

  private emitComment(c: CommentToken, level: number): void {
    if (c.kind === 'line') {
      this.line(level, c.text.trimEnd());
    } else {
      const parts = c.text.split(/\r?\n/);
      parts.forEach((p, idx) => {
        const t = p.trim();
        if (idx === 0) this.line(level, t);
        else this.line(level, t.startsWith('*') ? ` ${t}` : t);
      });
    }
    this.lastSrcLine = Math.max(this.lastSrcLine, c.endLine);
  }

  /** Append a comment that sits on the same source line as the node just printed (a block comment only when it ends there too). */
  private trailing(endLine: number): void {
    const c = this.nextComment();
    if (c && c.line === endLine && c.endLine === endLine && this.out.length > 0) {
      this.out[this.out.length - 1] += `  ${c.text.trimEnd()}`;
      this.ci++;
    }
  }

  private noCommentsInside(span: A.Span): boolean {
    const c = this.nextComment();
    return !c || !this.before(c, span.end);
  }

  // -------------------------------------------------------------------------
  // Program
  // -------------------------------------------------------------------------

  print(p: A.Program): string {
    for (const pr of p.pragmas) {
      this.flushBefore(pr.span.start, 0);
      this.line(0, `#pragma ${pr.name.name}${pr.value ? ' ' + pr.value : ''};`);
      this.lastSrcLine = pr.span.end.line;
      this.trailing(pr.span.end.line);
    }
    if (p.pkg) {
      this.flushBefore(p.pkg[0].span.start, 0);
      this.gapBefore(p.pkg[0].span.start.line);
      this.line(0, `package ${p.pkg.map((i) => i.name).join('.')};`);
      this.lastSrcLine = p.pkg[p.pkg.length - 1].span.end.line;
      this.trailing(this.lastSrcLine);
    }
    for (const im of p.imports) {
      this.flushBefore(im.span.start, 0);
      this.gapBefore(im.span.start.line);
      this.line(0, `import ${im.path.map((i) => i.name).join('.')}${im.wildcard ? '.*' : ''};`);
      this.lastSrcLine = im.span.end.line;
      this.trailing(im.span.end.line);
    }
    let prevKind: string | undefined;
    for (const d of p.decls) {
      // Procedures, records and protocols always get a blank line between them; constants keep the source's spacing.
      if (this.out.length > 0 && (d.kind !== 'ConstDecl' || prevKind !== 'ConstDecl')) this.blank();
      this.flushBefore(d.span.start, 0);
      this.gapBefore(d.span.start.line);
      this.decl(d);
      this.lastSrcLine = d.span.end.line;
      this.trailing(d.span.end.line);
      prevKind = d.kind;
    }
    this.flushBefore({ line: Number.MAX_SAFE_INTEGER, col: 0 }, 0);
    while (this.out.length && this.out[this.out.length - 1] === '') this.out.pop();
    return this.out.join('\n') + '\n';
  }

  private mods(m: string[]): string {
    return m.length ? m.join(' ') + ' ' : '';
  }

  private decl(d: A.Decl): void {
    switch (d.kind) {
      case 'ProcDecl': {
        const params = d.params.map((p) => `${p.isConst ? 'const ' : ''}${typeToString(p.type)} ${p.name.name}`).join(', ');
        const ann = d.annotations.length ? ` [${d.annotations.map((a) => `${a.name} = ${a.value}`).join(', ')}]` : '';
        const impl = d.implements.length ? ` implements ${d.implements.map(identToString).join(', ')}` : '';
        const head = `${this.mods(d.modifiers)}${typeToString(d.returnType)} ${d.name.name}(${params})${ann}${impl}`;
        if (!d.body) {
          this.line(0, `${head};`);
          return;
        }
        this.line(0, `${head} {`);
        this.blockBody(d.body, 0);
        return;
      }
      case 'RecordDecl': {
        const ext = d.extends.length ? ` extends ${d.extends.map(identToString).join(', ')}` : '';
        this.line(0, `${this.mods(d.modifiers)}record ${d.name.name}${ext} {`);
        this.lastSrcLine = d.span.start.line;
        this.fields(d.members, 1, d.span.end);
        this.line(0, '}');
        return;
      }
      case 'ProtocolDecl': {
        const ext = d.extends.length ? ` extends ${d.extends.map(identToString).join(', ')}` : '';
        if (!d.cases) {
          this.line(0, `${this.mods(d.modifiers)}protocol ${d.name.name}${ext};`);
          return;
        }
        this.line(0, `${this.mods(d.modifiers)}protocol ${d.name.name}${ext} {`);
        this.lastSrcLine = d.span.start.line;
        for (const c of d.cases) {
          this.flushBefore(c.span.start, 1);
          this.gapBefore(c.span.start.line);
          const inline = c.members.map((m) => `${typeToString(m.type)} ${m.name.name};`).join(' ');
          this.line(1, `${c.name.name} : { ${inline}${inline ? ' ' : ''}}`);
          this.lastSrcLine = c.span.end.line;
          this.trailing(c.span.end.line);
        }
        this.flushBefore(d.span.end, 1);
        this.line(0, '}');
        return;
      }
      case 'ConstDecl':
        this.line(0, `${this.mods(d.modifiers)}${typeToString(d.type)} ${this.declarators(d.declarators, 0)};`);
        return;
      case 'ExternDecl':
        this.line(0, `extern ${d.externType} ${d.name.name}`);
        return;
    }
  }

  private fields(members: A.Field[], level: number, end: A.Pos): void {
    for (const m of members) {
      this.flushBefore(m.span.start, level);
      this.gapBefore(m.span.start.line);
      this.line(level, `${typeToString(m.type)} ${m.name.name};`);
      this.lastSrcLine = m.span.end.line;
      this.trailing(m.span.end.line);
    }
    this.flushBefore(end, level);
  }

  private declarators(ds: A.Declarator[], level: number): string {
    return ds.map((d) => `${d.name.name}${'[]'.repeat(d.dims)}${d.init ? ` = ${this.expr(d.init, level)}` : ''}`).join(', ');
  }

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------

  /** Print the statements of a block whose `{` is already on the previous line, then the closing brace. */
  private blockBody(b: A.Block, level: number): void {
    this.lastSrcLine = b.span.start.line;
    this.stmts(b.stmts, level + 1, b.span.end);
    this.line(level, '}');
  }

  private stmts(stmts: A.Stmt[], level: number, end: A.Pos): void {
    for (const s of stmts) {
      this.flushBefore(s.span.start, level);
      this.gapBefore(s.span.start.line);
      this.stmt(s, level);
      this.lastSrcLine = s.span.end.line;
      this.trailing(s.span.end.line);
    }
    this.flushBefore(end, level);
  }

  /** A statement that follows a header such as `if (...)`: a block stays on the header line, anything else goes on the next line. */
  private body(s: A.Stmt, level: number, header: string): void {
    if (s.kind === 'Block') {
      this.line(level, `${header} {`);
      this.blockBody(s, level);
    } else {
      this.line(level, header);
      this.subStatement(s, level + 1);
    }
  }

  /** A lone statement under a header: its own comments come before it and a same-line comment stays with it. */
  private subStatement(s: A.Stmt, level: number): void {
    // The header line just printed is not a gap: nothing under it starts with a blank line.
    const comment = this.nextComment();
    const first = comment && this.before(comment, s.span.start) ? comment.line : s.span.start.line;
    this.lastSrcLine = Math.max(this.lastSrcLine, first - 1);
    this.flushBefore(s.span.start, level);
    this.stmt(s, level);
    this.lastSrcLine = Math.max(this.lastSrcLine, s.span.end.line);
    this.trailing(s.span.end.line);
  }

  private stmt(s: A.Stmt, level: number): void {
    switch (s.kind) {
      case 'Block':
        this.line(level, '{');
        this.blockBody(s, level);
        return;
      case 'EmptyStmt':
        this.line(level, ';');
        return;
      case 'LocalDecl':
        this.line(level, `${s.isConst ? 'const ' : ''}${s.isMobile ? 'mobile ' : ''}${typeToString(s.type)} ${this.declarators(s.declarators, level)};`);
        return;
      case 'ExprStmt':
        this.line(level, `${this.expr(s.expr, level)};`);
        return;
      case 'IfStmt':
        this.ifChain(s, level, `if (${this.expr(s.cond, level)})`);
        return;
      case 'WhileStmt':
        this.body(s.body, level, `while (${this.expr(s.cond, level)})`);
        return;
      case 'DoStmt':
        if (s.body.kind === 'Block') {
          this.line(level, 'do {');
          this.lastSrcLine = s.body.span.start.line;
          this.stmts(s.body.stmts, level + 1, s.body.span.end);
          this.line(level, `} while (${this.expr(s.cond, level)});`);
        } else {
          this.line(level, 'do');
          this.stmt(s.body, level + 1);
          this.line(level, `while (${this.expr(s.cond, level)});`);
        }
        return;
      case 'ForStmt': {
        const init = s.init === undefined ? '' : Array.isArray(s.init) ? s.init.map((e) => this.expr(e, level)).join(', ') : `${s.init.isConst ? 'const ' : ''}${typeToString(s.init.type)} ${this.declarators(s.init.declarators, level)}`;
        const cond = s.cond ? ` ${this.expr(s.cond, level)}` : '';
        const update = s.update.length ? ` ${s.update.map((e) => this.expr(e, level)).join(', ')}` : '';
        const enroll = s.enroll.length ? ` enroll (${s.enroll.map((e) => this.expr(e, level)).join(', ')})` : '';
        this.body(s.body, level, `${s.isPar ? 'par ' : ''}for (${init};${cond};${update})${enroll}`);
        return;
      }
      case 'ParBlock': {
        const b = s.barriers.map((e) => this.expr(e, level)).join(', ');
        const header = s.barriers.length ? (s.barrierParens ? `par enroll (${b})` : `par enroll ${b}`) : 'par';
        this.line(level, `${header} {`);
        this.blockBody(s.body, level);
        return;
      }
      case 'SeqBlock':
        this.line(level, 'seq {');
        this.blockBody(s.body, level);
        return;
      case 'ClaimStmt': {
        const chans = s.channels.map((c) => (c.kind === 'LocalDecl' ? `${typeToString(c.type)} ${this.declarators(c.declarators, level)}` : this.expr(c, level))).join(', ');
        this.body(s.body, level, `claim (${chans})`);
        return;
      }
      case 'SwitchStmt':
        this.line(level, `switch (${this.expr(s.expr, level)}) {`);
        this.lastSrcLine = s.span.start.line;
        for (const g of s.groups) {
          this.flushBefore(g.span.start, level + 1);
          this.gapBefore(g.span.start.line);
          for (const l of g.labels) this.line(level + 1, l === undefined ? 'default:' : `case ${this.expr(l, level)}:`);
          this.lastSrcLine = g.span.start.line;
          this.stmts(g.stmts, level + 2, g.span.end);
        }
        this.flushBefore(s.span.end, level + 1);
        this.line(level, '}');
        return;
      case 'AltStmt':
        this.alt(s, level);
        return;
      case 'ReturnStmt':
        this.line(level, s.expr ? `return ${this.expr(s.expr, level)};` : 'return;');
        return;
      case 'BreakStmt':
        this.line(level, s.label ? `break ${s.label.name};` : 'break;');
        return;
      case 'ContinueStmt':
        this.line(level, s.label ? `continue ${s.label.name};` : 'continue;');
        return;
      case 'SkipStmt':
        this.line(level, 'skip;');
        return;
      case 'StopStmt':
        this.line(level, 'stop;');
        return;
      case 'SuspendStmt':
        this.line(level, 'suspend;');
        return;
      case 'LabeledStmt':
        this.line(level, `${s.label.name}:`);
        this.stmt(s.stmt, level);
        return;
    }
  }

  private ifChain(s: A.IfStmt, level: number, header: string): void {
    if (s.then.kind === 'Block') {
      this.line(level, `${header} {`);
      this.lastSrcLine = s.then.span.start.line;
      this.stmts(s.then.stmts, level + 1, s.then.span.end);
      if (!s.else) {
        this.line(level, '}');
        return;
      }
      if (s.else.kind === 'IfStmt') {
        this.ifChain(s.else, level, `} else if (${this.expr(s.else.cond, level)})`);
        return;
      }
      if (s.else.kind === 'Block') {
        this.line(level, '} else {');
        this.blockBody(s.else, level);
        return;
      }
      this.line(level, '} else');
      this.subStatement(s.else, level + 1);
      return;
    }
    this.line(level, header);
    this.subStatement(s.then, level + 1);
    if (!s.else) return;
    if (s.else.kind === 'IfStmt') {
      this.ifChain(s.else, level, `else if (${this.expr(s.else.cond, level)})`);
      return;
    }
    if (s.else.kind === 'Block') {
      this.line(level, 'else {');
      this.blockBody(s.else, level);
      return;
    }
    this.line(level, 'else');
    this.subStatement(s.else, level + 1);
  }

  private alt(s: A.AltStmt, level: number): void {
    let header = s.isPri ? 'pri alt' : 'alt';
    if (s.replicated) {
      const r = s.replicated;
      const init = r.init === undefined ? '' : Array.isArray(r.init) ? r.init.map((e) => this.expr(e, level)).join(', ') : `${typeToString(r.init.type)} ${this.declarators(r.init.declarators, level)}`;
      header += ` (${init};${r.cond ? ' ' + this.expr(r.cond, level) : ''};${r.update.length ? ' ' + r.update.map((e) => this.expr(e, level)).join(', ') : ''})`;
    }
    this.line(level, `${header} {`);
    this.lastSrcLine = s.span.start.line;
    for (const c of s.cases) {
      this.flushBefore(c.span.start, level + 1);
      this.gapBefore(c.span.start.line);
      if (c.nested) {
        this.alt(c.nested, level + 1);
      } else {
        const pre = c.precondition ? `(${this.expr(c.precondition, level)}) && ` : '';
        const guard = this.guard(c.guard, level);
        const head = `${pre}${guard} :`;
        const body = c.body ?? { kind: 'EmptyStmt' as const, span: c.span };
        if (body.kind === 'Block' && this.fitsInline(body, level + 1, head.length + 1)) {
          this.line(level + 1, `${head} ${this.inlineBlock(body, level + 1)}`);
        } else {
          this.body(body, level + 1, head);
        }
      }
      this.lastSrcLine = c.span.end.line;
      this.trailing(c.span.end.line);
    }
    this.flushBefore(s.span.end, level + 1);
    this.line(level, '}');
  }

  private guard(g: A.Guard | undefined, level: number): string {
    if (!g) return '<guard>';
    switch (g.kind) {
      case 'SkipGuard':
        return 'skip';
      case 'TimeoutGuard':
        return this.expr(g.timeout, level);
      case 'ReadGuard':
        return `${this.expr(g.target, level)} = ${this.expr(g.read, level)}`;
    }
  }

  /** A block with at most one simple statement, no comments, and short enough to sit on one line. */
  private fitsInline(b: A.Block, level: number, prefixWidth: number): boolean {
    if (b.stmts.length > 1 || !this.noCommentsInside(b.span)) return false;
    if (b.stmts.length === 1 && !isSimple(b.stmts[0])) return false;
    const text = this.inlineBlock(b, level);
    if (text.includes('\n')) return false; // an extended rendezvous somewhere inside
    return this.ind(level).length + prefixWidth + text.length <= this.maxWidth;
  }

  private inlineBlock(b: A.Block, level: number): string {
    if (b.stmts.length === 0) return '{ }';
    const saved = this.out;
    this.out = [];
    this.stmt(b.stmts[0], 0);
    const text = this.out.join(' ').trim();
    this.out = saved;
    return `{ ${text} }`;
  }

  // -------------------------------------------------------------------------
  // Expressions (single line, except extended rendezvous blocks)
  // -------------------------------------------------------------------------

  private expr(e: A.Expr, level: number): string {
    switch (e.kind) {
      case 'Literal':
        return e.text;
      case 'NameExpr':
        return `${qualifierToString(e.qualifier)}${e.name.name}`;
      case 'ParenExpr':
        return `(${this.expr(e.expr, level)})`;
      case 'BinaryExpr':
        return `${this.expr(e.left, level)} ${e.op} ${this.expr(e.right, level)}`;
      case 'UnaryExpr': {
        const operand = this.expr(e.operand, level);
        if (!e.prefix) return `${operand}${e.op}`;
        // `- -x` and `+ +x` would re-lex as decrement/increment without the space.
        const sep = (e.op === '-' || e.op === '+') && operand.startsWith(e.op) ? ' ' : '';
        return `${e.op}${sep}${operand}`;
      }
      case 'AssignExpr':
        return `${this.expr(e.target, level)} ${e.op} ${this.expr(e.value, level)}`;
      case 'TernaryExpr':
        return `${this.expr(e.cond, level)} ? ${this.expr(e.then, level)} : ${this.expr(e.else, level)}`;
      case 'CastExpr':
        return `(${typeToString(e.type)}) ${this.expr(e.expr, level)}`;
      case 'IsExpr':
        return `${this.expr(e.expr, level)} is ${identToString(e.typeName)}`;
      case 'Invocation': {
        const q = qualifierToString(e.qualifier);
        const t = e.target ? this.expr(e.target, level) + '.' : '';
        return `${t}${q}${e.name.name}(${e.args.map((a) => this.expr(a, level)).join(', ')})`;
      }
      case 'RecordAccess':
        return `${this.expr(e.target, level)}.${e.member.name}`;
      case 'ArrayAccess':
        return `${this.expr(e.target, level)}[${this.expr(e.index, level)}]`;
      case 'ChanEnd':
        return `${this.expr(e.target, level)}.${e.end}`;
      case 'ChanRead': {
        const t = this.expr(e.target, level);
        if (!e.extended) return `${t}.read()`;
        if (this.fitsInline(e.extended, level, t.length + 8)) return `${t}.read(${this.inlineBlock(e.extended, level)})`;
        const saved = this.out;
        this.out = [];
        this.lastSrcLine = e.extended.span.start.line;
        this.stmts(e.extended.stmts, level + 1, e.extended.span.end);
        const inner = this.out.join('\n');
        this.out = saved;
        return `${t}.read({\n${inner}\n${this.ind(level)}})`;
      }
      case 'ChanWrite':
        return `${this.expr(e.target, level)}.write(${this.expr(e.value, level)})`;
      case 'Sync':
        return `${this.expr(e.target, level)}.sync()`;
      case 'Timeout':
        return `${this.expr(e.target, level)}.timeout(${this.expr(e.delay, level)})`;
      case 'NewArray': {
        const dims = e.dimExprs.map((d) => `[${this.expr(d, level)}]`).join('') + '[]'.repeat(e.extraDims);
        return `new ${typeToString(e.elem)}${dims}${e.init ? ' ' + this.expr(e.init, level) : ''}`;
      }
      case 'ArrayLiteral':
        return e.elements.length ? `{ ${e.elements.map((x) => this.expr(x, level)).join(', ')} }` : '{ }';
      case 'RecordLiteral':
        return `new ${identToString(e.typeName)} { ${e.fields.map((f) => `${f.name.name} = ${this.expr(f.value, level)}`).join(', ')} }`;
      case 'ProtocolLiteral': {
        const fields = e.fields.map((f) => `${f.name.name} = ${this.expr(f.value, level)}`).join(', ');
        return `new ${identToString(e.typeName)} { ${e.tag.name}:${fields ? ' ' + fields : ''} }`;
      }
      case 'NewMobile':
        return `new mobile(${identToString(e.typeName)})`;
      case 'ErrorExpr':
        return '<error>';
    }
  }
}

function isSimple(s: A.Stmt): boolean {
  switch (s.kind) {
    case 'ExprStmt':
      return !(s.expr.kind === 'ChanRead' && s.expr.extended) && !(s.expr.kind === 'AssignExpr' && s.expr.value.kind === 'ChanRead' && !!s.expr.value.extended);
    case 'LocalDecl':
    case 'ReturnStmt':
    case 'BreakStmt':
    case 'ContinueStmt':
    case 'SkipStmt':
    case 'StopStmt':
    case 'SuspendStmt':
    case 'EmptyStmt':
      return true;
    default:
      return false;
  }
}
