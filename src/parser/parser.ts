/**
 * Recursive-descent parser for ProcessJ, written from src/parser/ProcessJ.cup.
 *
 * Unlike the compiler's CUP parser, which prints "Syntax error" and exits at the
 * first problem, this one recovers and keeps going, so every syntax error in a
 * file is reported at once, and each message says what was expected, what was
 * found, and (for misspelled keywords) what was probably meant.
 */
import { KEYWORDS, PRIMITIVE_TYPES } from '../keywords';
import { tokenize, type CommentToken, type LexIssue, type Token } from '../tokens';
import type * as A from './ast';
import { identToString, qualifierToString } from './ast';

export interface ParseResult {
  program: A.Program;
  errors: A.ParseError[];
  tokens: Token[];
  comments: CommentToken[];
  lexIssues: LexIssue[];
}

const PRIMITIVES = new Set(['boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double', 'string', 'barrier', 'timer']);
const MODIFIERS = new Set(['public', 'private', 'protected', 'native', 'mobile', 'const']);
const ASSIGN_OPS = new Set(['=', '*=', '/=', '%=', '+=', '-=', '<<=', '>>=', '>>>=', '&=', '^=', '|=']);
const TYPE_KEYWORDS = ['chan', 'shared', ...PRIMITIVE_TYPES];
/** Expression/block nesting beyond which the parser gives up rather than overflow the stack. */
const MAX_NESTING = 400;
const TOP_LEVEL_KEYWORDS = ['public', 'private', 'protected', 'native', 'mobile', 'const', 'record', 'protocol', 'extern', 'import', 'package', 'void', ...TYPE_KEYWORDS];

const BINARY_PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '|': 3,
  '^': 4,
  '&': 5,
  '==': 6,
  '!=': 6,
  '<': 7,
  '>': 7,
  '<=': 7,
  '>=': 7,
  is: 7,
  '<<': 8,
  '>>': 8,
  '>>>': 8,
  '+': 9,
  '-': 9,
  '*': 10,
  '/': 10,
  '%': 10,
};

export function parse(text: string): ParseResult {
  const lexed = tokenize(text);
  const parser = new Parser(lexed.tokens, text);
  const program = parser.parseProgram();
  return { program, errors: parser.errors, tokens: lexed.tokens, comments: lexed.comments, lexIssues: lexed.issues };
}

/** Damerau-Levenshtein (optimal string alignment) distance: a swapped pair like 'itn' counts as one edit. */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let twoBack = new Array<number>(n + 1).fill(0);
  let previous = Array.from({ length: n + 1 }, (_, j) => j);
  let current = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    current[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) current[j] = Math.min(current[j], twoBack[j - 2] + 1);
    }
    const reusable = twoBack;
    twoBack = previous;
    previous = current;
    current = reusable;
  }
  return previous[n];
}

/** Return the distance when it is at most `limit`, otherwise `limit + 1`. */
function boundedEditDistance(a: string, b: string, limit: number): number {
  const m = a.length;
  const n = b.length;
  const beyond = limit + 1;
  if (Math.abs(m - n) > limit) return beyond;

  let twoBack = new Array<number>(n + 1).fill(beyond);
  let previous = Array.from({ length: n + 1 }, (_, j) => (j <= limit ? j : beyond));
  let current = new Array<number>(n + 1).fill(beyond);
  for (let i = 1; i <= m; i++) {
    current.fill(beyond);
    if (i <= limit) current[0] = i;
    const from = Math.max(1, i - limit);
    const to = Math.min(n, i + limit);
    for (let j = from; j <= to; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost, beyond);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) current[j] = Math.min(current[j], twoBack[j - 2] + 1);
    }
    const reusable = twoBack;
    twoBack = previous;
    previous = current;
    current = reusable;
  }
  return previous[n] <= limit ? previous[n] : beyond;
}

export function suggest(word: string, candidates: Iterable<string>): string | undefined {
  if (word.length < 2) return undefined;
  const normalized = word.toLowerCase();
  const limit = word.length <= 4 ? 1 : 2;
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    if (c === word) continue;
    const candidate = c.toLowerCase();
    if (Math.abs(candidate.length - normalized.length) > limit) continue;
    const threshold = bestD === Infinity ? limit : Math.min(limit, bestD - 1);
    const d = boundedEditDistance(normalized, candidate, threshold);
    if (d <= threshold) {
      best = c;
      bestD = d;
      if (d === 0) return best;
    }
  }
  return best;
}

class Parser {
  private i = 0;
  readonly errors: A.ParseError[] = [];
  private lastErrorTok = -1;
  private nesting = 0;
  private readonly declaredTypes = new Set<string>();
  private readonly eof: Token;

  constructor(
    private readonly toks: Token[],
    text: string,
  ) {
    const lines = text.split(/\r\n|\r|\n/);
    const lastLine = Math.max(0, lines.length - 1);
    this.eof = { kind: 'punct', text: '<end of file>', line: lastLine, col: lines[lastLine]?.length ?? 0, end: lines[lastLine]?.length ?? 0 };
    // Pre-scan declared record/protocol names so unknown types can be told apart from typos.
    for (let k = 0; k + 1 < toks.length; k++) {
      if ((toks[k].text === 'record' || toks[k].text === 'protocol') && toks[k + 1].kind === 'ident') this.declaredTypes.add(toks[k + 1].text);
    }
  }

  // -------------------------------------------------------------------------
  // Token helpers
  // -------------------------------------------------------------------------

  private peek(k = 0): Token {
    return this.toks[this.i + k] ?? this.eof;
  }

  private atEof(): boolean {
    return this.i >= this.toks.length;
  }

  private at(text: string, k = 0): boolean {
    const t = this.peek(k);
    return t.text === text && (t.kind === 'punct' || t.kind === 'keyword');
  }

  private atIdent(k = 0): boolean {
    return this.peek(k).kind === 'ident';
  }

  private next(): Token {
    const t = this.peek();
    if (!this.atEof()) this.i++;
    return t;
  }

  private accept(text: string): Token | undefined {
    return this.at(text) ? this.next() : undefined;
  }

  private describe(t: Token): string {
    if (t === this.eof) return 'end of file';
    switch (t.kind) {
      case 'string':
        return `string ${t.text}`;
      case 'char':
        return `character ${t.text}`;
      case 'number':
        return `number ${t.text}`;
      default:
        return `'${t.text}'`;
    }
  }

  private error(tok: Token, message: string, fix?: A.ParseFix): void {
    const idx = tok === this.eof ? this.toks.length : this.i;
    // One error per token position: avoids cascades after a recovery.
    if (idx === this.lastErrorTok) return;
    this.lastErrorTok = idx;
    this.errors.push({ line: tok.line, col: tok.col, endCol: Math.max(tok.end, tok.col + 1), message, fix });
  }

  /** Replace the token's text with `text` as the quick fix for an error on it. */
  private replaceFix(tok: Token, text: string, title: string): A.ParseFix {
    return { title, line: tok.line, col: tok.col, endCol: tok.end, text };
  }

  /** Error placed just after the previous token (for "missing ';'" style messages); the fix inserts `insert`. */
  private errorAfterPrevious(message: string, insert?: string): void {
    const prev = this.toks[this.i - 1];
    if (!prev) return this.error(this.peek(), message);
    const idx = this.i;
    if (idx === this.lastErrorTok) return;
    this.lastErrorTok = idx;
    const fix = insert !== undefined ? { title: `Insert '${insert}'`, line: prev.line, col: prev.end, endCol: prev.end, text: insert } : undefined;
    this.errors.push({ line: prev.line, col: prev.end, endCol: prev.end + 1, message, fix });
  }

  private expect(text: string, what: string): Token | undefined {
    if (this.at(text)) return this.next();
    const t = this.peek();
    if (text === ';' || text === ')' || text === ']' || text === '>') {
      this.errorAfterPrevious(`Missing '${text}' ${what}`, text);
    } else {
      this.error(t, `Expected '${text}' ${what} but found ${this.describe(t)}`);
    }
    return undefined;
  }

  private expectIdent(what: string): A.Ident {
    const t = this.peek();
    if (t.kind === 'ident') {
      this.next();
      return this.ident(t);
    }
    if (t.kind === 'keyword') this.error(t, `'${t.text}' is a keyword and cannot be used as ${what}`);
    else this.error(t, `Expected ${what} but found ${this.describe(t)}`);
    return { kind: 'Ident', name: '<missing>', span: this.spanOf(t) };
  }

  private ident(t: Token): A.Ident {
    return { kind: 'Ident', name: t.text, span: this.spanOf(t) };
  }

  private spanOf(t: Token): A.Span {
    return { start: { line: t.line, col: t.col }, end: { line: t.line, col: t.end } };
  }

  private startPos(): A.Pos {
    const t = this.peek();
    return { line: t.line, col: t.col };
  }

  private endPos(): A.Pos {
    const prev = this.toks[this.i - 1];
    return prev ? { line: prev.line, col: prev.end } : { line: 0, col: 0 };
  }

  private span(start: A.Pos): A.Span {
    const end = this.endPos();
    // A synthetic node that consumed nothing must not end before it starts.
    if (end.line < start.line || (end.line === start.line && end.col < start.col)) return { start, end: start };
    return { start, end };
  }

  /** True at a token that can only begin a top-level declaration and sits at column 0 on its own line. */
  private atUnindentedDeclaration(): boolean {
    const t = this.peek();
    if (t === this.eof || t.col !== 0 || t.kind !== 'keyword') return false;
    return t.text === 'void' || t.text === 'record' || t.text === 'protocol' || t.text === 'extern' || t.text === 'public' || t.text === 'private' || t.text === 'protected' || t.text === 'native';
  }

  /** After a broken top-level declaration: skip to its `;`, but never past the start of the next declaration. */
  private skipToNextDeclaration(): void {
    let depth = 0;
    while (!this.atEof()) {
      const t = this.peek();
      if (depth === 0 && t.line > this.endPos().line && (this.atUnindentedDeclaration() || (t.kind === 'keyword' && MODIFIERS.has(t.text)) || this.atTypeStart())) return;
      if (t.kind === 'punct') {
        if (t.text === '{' || t.text === '(' || t.text === '[') depth++;
        else if (t.text === '}' || t.text === ')' || t.text === ']') {
          if (depth === 0) {
            this.next();
            return;
          }
          depth--;
        }
      }
      this.next();
      if (depth === 0 && t.text === ';') return;
    }
  }

  /** Skip tokens until one of `stops` at bracket depth 0 (the stop token itself is not consumed). */
  private skipTo(stops: string[], consumeStop = false): void {
    let depth = 0;
    while (!this.atEof()) {
      const t = this.peek();
      if (t.kind === 'punct') {
        if (t.text === '{' || t.text === '(' || t.text === '[') depth++;
        else if (t.text === '}' || t.text === ')' || t.text === ']') {
          if (depth === 0 && stops.includes(t.text)) {
            if (consumeStop) this.next();
            return;
          }
          depth = Math.max(0, depth - 1);
        }
      }
      if (depth === 0 && stops.includes(t.text)) {
        if (consumeStop) this.next();
        return;
      }
      this.next();
    }
  }

  /** In a type, `>>` must be read as two `>` tokens (`chan<chan<int>>`). */
  private splitGtGt(): void {
    const t = this.peek();
    if (t.kind === 'punct' && (t.text === '>>' || t.text === '>>>' || t.text === '>>=' || t.text === '>>>=')) {
      const first: Token = { ...t, text: '>', end: t.col + 1 };
      const rest: Token = { ...t, text: t.text.slice(1), col: t.col + 1 };
      this.toks.splice(this.i, 1, first, rest);
    }
  }

  // -------------------------------------------------------------------------
  // Program structure
  // -------------------------------------------------------------------------

  parseProgram(): A.Program {
    const start = this.startPos();
    const pragmas: A.Pragma[] = [];
    const imports: A.Import[] = [];
    const decls: A.Decl[] = [];
    let pkg: A.Ident[] | undefined;

    while (this.at('#')) pragmas.push(this.parsePragma());
    if (this.at('package')) {
      this.next();
      pkg = this.parseDottedName();
      this.expect(';', 'after the package name');
    }
    while (this.at('import')) imports.push(this.parseImport());

    while (!this.atEof()) {
      const before = this.i;
      if (this.at('import')) {
        this.error(this.peek(), "'import' must come before all declarations");
        imports.push(this.parseImport());
        continue;
      }
      if (this.at('package')) {
        this.error(this.peek(), "'package' must be the first line after any pragmas");
        this.next();
        this.parseDottedName();
        this.expect(';', 'after the package name');
        continue;
      }
      const d = this.parseTopLevel();
      if (d) decls.push(d);
      if (this.i === before) {
        const t = this.next();
        this.error(t, `Unexpected ${this.describe(t)} at top level; expected a procedure, record, protocol or constant declaration`);
      }
    }
    return { kind: 'Program', pragmas, pkg, imports, decls, span: this.span(start) };
  }

  private parsePragma(): A.Pragma {
    const start = this.startPos();
    const hash = this.next(); // '#'
    if (this.peek().text !== 'pragma') this.error(this.peek(), `Expected 'pragma' after '#' but found ${this.describe(this.peek())}`);
    else {
      const pragma = this.peek();
      if (pragma.line !== hash.line || pragma.col !== hash.end) {
        this.error(pragma, "ProcessJ requires '#pragma' with no whitespace between '#' and 'pragma'");
      }
      this.next();
    }
    const name = this.expectIdent('a pragma name');
    let value: string | undefined;
    if (this.peek().kind === 'string') value = this.next().text;
    this.expect(';', 'after the pragma');
    return { kind: 'Pragma', name, value, span: this.span(start) };
  }

  private parseDottedName(): A.Ident[] {
    const parts = [this.expectIdent('a name')];
    while (this.at('.') && this.atIdent(1)) {
      this.next();
      parts.push(this.ident(this.next()));
    }
    return parts;
  }

  /** Number of tokens in an identifier or `pkg.path::identifier` starting at `k`. */
  private qualifiedNameLength(k = 0): number {
    if (!this.atIdent(k)) return 0;
    let j = k + 1;
    if (this.at('::', j) && this.atIdent(j + 1)) return 3;
    let dotted = false;
    while (this.at('.', j) && this.atIdent(j + 1)) {
      dotted = true;
      j += 2;
    }
    return dotted && this.at('::', j) && this.atIdent(j + 1) ? j + 2 - k : 1;
  }

  /** Parse CUP's `type_name`: a bare name or a dotted package followed by `::name`. */
  private parseTypeName(what: string): A.Ident {
    const length = this.qualifiedNameLength();
    const first = this.expectIdent(what);
    if (length <= 1 || first.name === '<missing>') return first;
    const qualifier = [first];
    while (this.accept('.')) qualifier.push(this.ident(this.next()));
    this.expect('::', `before ${what}`);
    const name = this.expectIdent(what);
    name.qualifier = qualifier;
    return name;
  }

  private parseImport(): A.Import {
    const start = this.startPos();
    this.next();
    const path = [this.expectIdent('a package or library name after import')];
    let wildcard = false;
    while (this.at('.')) {
      this.next();
      if (this.at('*')) {
        this.next();
        wildcard = true;
        break;
      }
      path.push(this.expectIdent("a name or '*' after '.'"));
    }
    this.expect(';', 'after the import');
    return { kind: 'Import', path, wildcard, span: this.span(start) };
  }

  private parseModifiers(): string[] {
    const mods: string[] = [];
    while (this.peek().kind === 'keyword' && MODIFIERS.has(this.peek().text)) mods.push(this.next().text);
    return mods;
  }

  private parseTopLevel(): A.Decl | undefined {
    const start = this.startPos();
    const t = this.peek();

    if (t.kind === 'ident' && !this.atIdent(1) && !this.at('[', 1)) {
      const s = suggest(t.text, TOP_LEVEL_KEYWORDS);
      if (s) {
        this.error(t, `Unknown declaration '${t.text}'; did you mean '${s}'?`, this.replaceFix(t, s, `Change to '${s}'`));
        this.next();
        return undefined;
      }
    }

    if (this.at('extern')) {
      this.next();
      const parts = this.parseDottedName();
      const name = this.expectIdent('a name for the extern type');
      return { kind: 'ExternDecl', externType: parts.map((p) => p.name).join('.'), name, span: this.span(start) };
    }

    const modifiers = this.parseModifiers();

    if (this.at('record')) return this.parseRecord(modifiers, start);
    if (this.at('protocol')) return this.parseProtocol(modifiers, start);

    if (this.at('proc')) {
      const t = this.peek();
      const gap = this.peek(1).line === t.line ? this.peek(1).col : t.end;
      this.error(t, "'proc' is not part of the syntax; write the return type and name directly, e.g. 'public void main(string[] args)'", { title: "Remove 'proc'", line: t.line, col: t.col, endCol: gap, text: '' });
      this.next();
    }

    if (this.at('{')) {
      this.error(this.peek(), 'A block cannot appear at top level; statements must be inside a procedure');
      this.skipTo(['}'], true);
      return undefined;
    }

    if (!this.atTypeStart()) {
      const tok = this.peek();
      this.error(tok, `Expected a declaration (procedure, record, protocol or constant) but found ${this.describe(tok)}`);
      this.skipTo([';', '}'], true);
      return undefined;
    }

    const typeToken = this.peek();
    const type = this.parseType(true);
    const name = this.expectIdent('a name after the type');

    if (type.kind === 'ArrayType' && containsVoid(type)) {
      this.error(typeToken, "'void' cannot be an array element type; only a procedure may use bare 'void' as its return type");
    }

    if (this.at('(')) return this.parseProcRest(modifiers, type, name, start);

    if (type.kind === 'PrimitiveType' && type.name === 'void') {
      this.error(typeToken, "'void' can only be the return type of a procedure; it cannot declare a constant");
    }

    // Constant declaration.
    const declarators = this.parseDeclarators(name);
    if (!this.expect(';', 'after the constant declaration')) this.skipToNextDeclaration();
    return { kind: 'ConstDecl', modifiers, type, declarators, span: this.span(start) };
  }

  private parseProcRest(modifiers: string[], returnType: A.TypeNode, name: A.Ident, start: A.Pos): A.ProcDecl {
    this.expect('(', 'to start the parameter list');
    const params: A.Param[] = [];
    if (!this.at(')')) {
      for (;;) {
        const pstart = this.startPos();
        const isConst = !!this.accept('const');
        if (!this.atTypeStart()) {
          const t = this.peek();
          this.error(t, `Expected a parameter type but found ${this.describe(t)}`);
          this.skipTo([',', ')']);
        } else {
          let type = this.parseType();
          const pname = this.expectIdent('a parameter name');
          const dims = this.parseDims();
          if (dims > 0) type = { kind: 'ArrayType', elem: type, dims, span: type.span };
          params.push({ kind: 'Param', isConst, type, name: pname, span: this.span(pstart) });
        }
        if (this.accept(',')) continue;
        break;
      }
    }
    this.expect(')', 'to close the parameter list');
    const headerEnd = this.endPos();
    const annotationStart = this.at('[') ? this.startPos() : undefined;
    const annotations = this.parseAnnotations();
    const annotationsSpan = annotationStart ? this.span(annotationStart) : undefined;
    const impls: A.Ident[] = [];
    if (this.accept('implements')) {
      impls.push(this.parseTypeName('a procedure name'));
      while (this.accept(',')) impls.push(this.parseTypeName('a procedure name'));
    }
    let body: A.Block | undefined;
    if (this.at('{')) body = this.parseBlock();
    else if (!this.accept(';')) {
      const t = this.peek();
      this.error(t, `Expected '{' to start the body of '${name.name}' (or ';' for a native procedure) but found ${this.describe(t)}`);
      this.skipTo(['{', ';', '}']);
      if (this.at('{')) body = this.parseBlock();
      else this.accept(';');
    }
    return { kind: 'ProcDecl', modifiers, returnType, name, params, annotations, annotationsSpan, implements: impls, body, headerEnd, span: this.span(start) };
  }

  private parseAnnotations(): A.Annotation[] {
    const out: A.Annotation[] = [];
    if (!this.at('[')) return out;
    this.next();
    for (;;) {
      const name = this.expectIdent('an annotation name');
      this.expect('=', 'in the annotation');
      const v = this.peek();
      if (!(v.kind === 'ident' || v.kind === 'number' || (v.kind === 'keyword' && (v.text === 'true' || v.text === 'false')))) {
        this.error(v, `Annotation '${name.name}' needs an identifier, boolean, or numeric value; found ${this.describe(v)}`);
      }
      if (!this.atEof()) this.next();
      out.push({
        name: name.name,
        value: v.text,
        span: { start: { line: v.line, col: v.col }, end: { line: v.line, col: v.end } },
      });
      if (this.accept(',')) continue;
      break;
    }
    this.expect(']', 'to close the annotations');
    return out;
  }

  private parseExtends(): A.Ident[] {
    const out: A.Ident[] = [];
    if (this.accept('extends')) {
      out.push(this.parseTypeName("a type name after 'extends'"));
      while (this.accept(',')) out.push(this.parseTypeName('a type name'));
    }
    return out;
  }

  private parseRecord(modifiers: string[], start: A.Pos): A.RecordDecl {
    this.next(); // record
    const name = this.expectIdent("a record name after 'record'");
    const ext = this.parseExtends();
    const annotations = this.parseAnnotations();
    const members = this.parseMemberBody(`record '${name.name}'`);
    return { kind: 'RecordDecl', modifiers, name, extends: ext, annotations, members, span: this.span(start) };
  }

  /** `{ type name, name; ... }` shared by records and protocol cases. */
  private parseMemberBody(owner: string): A.Field[] {
    const members: A.Field[] = [];
    if (!this.expect('{', `to start the body of ${owner}`)) return members;
    while (!this.at('}') && !this.atEof()) {
      const before = this.i;
      const mstart = this.startPos();
      if (!this.atTypeStart()) {
        const t = this.peek();
        const s = t.kind === 'ident' ? suggest(t.text, [...TYPE_KEYWORDS, ...this.declaredTypes]) : undefined;
        this.error(t, `Expected a field declaration (type and name) in ${owner} but found ${this.describe(t)}${s ? `; did you mean '${s}'?` : ''}`);
        this.skipTo([';', '}'], false);
        this.accept(';');
        if (this.i === before) this.next();
        continue;
      }
      const type = this.parseType();
      for (;;) {
        const fname = this.expectIdent('a field name');
        const dims = this.parseDims();
        members.push({ kind: 'Field', type: dims > 0 ? { kind: 'ArrayType', elem: type, dims, span: type.span } : type, name: fname, span: this.span(mstart) });
        if (this.accept(',')) continue;
        break;
      }
      if (!this.expect(';', 'after the field declaration')) this.skipTo([';', '}']), this.accept(';');
      if (this.i === before) this.next();
    }
    this.expect('}', `to close ${owner}`);
    return members;
  }

  private parseProtocol(modifiers: string[], start: A.Pos): A.ProtocolDecl {
    this.next(); // protocol
    const name = this.expectIdent("a protocol name after 'protocol'");
    const ext = this.parseExtends();
    const annotations = this.parseAnnotations();
    if (this.accept(';')) return { kind: 'ProtocolDecl', modifiers, name, extends: ext, annotations, span: this.span(start) };
    const cases: A.ProtocolCase[] = [];
    if (this.expect('{', `to start the body of protocol '${name.name}'`)) {
      if (this.at('}')) this.error(this.peek(), `Protocol '${name.name}' must declare at least one case; use ';' instead of an empty body for a forward declaration`);
      while (!this.at('}') && !this.atEof()) {
        const before = this.i;
        const cstart = this.startPos();
        const tag = this.expectIdent(`a case name in protocol '${name.name}'`);
        if (!this.expect(':', `after protocol case '${tag.name}'`)) {
          this.skipTo(['{', '}']);
        }
        let members: A.Field[] = [];
        if (this.at('{')) members = this.parseMemberBody(`protocol case '${tag.name}'`);
        else this.error(this.peek(), `Protocol case '${tag.name}' needs a body in braces, even when it has no fields`);
        cases.push({ kind: 'ProtocolCase', name: tag, members, span: this.span(cstart) });
        if (this.i === before) this.next();
      }
      this.expect('}', `to close protocol '${name.name}'`);
    }
    return { kind: 'ProtocolDecl', modifiers, name, extends: ext, annotations, cases, span: this.span(start) };
  }

  /** `name[] = init, name2 = init2`; pass `first` when the first name was already consumed. */
  private parseDeclarators(first?: A.Ident): A.Declarator[] {
    const out: A.Declarator[] = [];
    for (;;) {
      const start = first ? first.span.start : this.startPos();
      const name = first ?? this.expectIdent('a variable name');
      first = undefined;
      const dims = this.parseDims();
      let init: A.Expr | undefined;
      if (this.accept('=')) init = this.at('{') ? this.parseArrayLiteral() : this.parseExpression();
      out.push({ kind: 'Declarator', name, dims, init, span: this.span(start) });
      if (this.accept(',')) continue;
      break;
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Types
  // -------------------------------------------------------------------------

  private atTypeStart(k = 0): boolean {
    const t = this.peek(k);
    if (t.kind === 'keyword') return PRIMITIVES.has(t.text) || t.text === 'chan' || t.text === 'shared' || t.text === 'void';
    return t.kind === 'ident';
  }

  /** Is the upcoming token sequence a local variable declaration rather than an expression? */
  private atLocalDeclStart(): boolean {
    const t = this.peek();
    if (t.kind === 'keyword') return PRIMITIVES.has(t.text) || t.text === 'chan' || t.text === 'shared' || t.text === 'const' || t.text === 'mobile';
    if (t.kind !== 'ident') return false;
    let k = this.qualifiedNameLength();
    if (k === 0) return false;
    while (this.at('[', k) && this.at(']', k + 1)) k += 2;
    return this.atIdent(k);
  }

  private parseDims(): number {
    let dims = 0;
    while (this.at('[') && this.at(']', 1)) {
      this.next();
      this.next();
      dims++;
    }
    return dims;
  }

  private parseType(allowVoid = false): A.TypeNode {
    const start = this.startPos();
    const t = this.peek();
    let base: A.TypeNode;

    if (t.kind === 'keyword' && (PRIMITIVES.has(t.text) || (allowVoid && t.text === 'void'))) {
      this.next();
      base = { kind: 'PrimitiveType', name: t.text, span: this.spanOf(t) };
    } else if (t.text === 'void') {
      this.error(t, "'void' can only be the return type of a procedure");
      this.next();
      base = { kind: 'PrimitiveType', name: 'void', span: this.spanOf(t) };
    } else if (t.text === 'shared' || t.text === 'chan') {
      base = this.parseChanType();
    } else if (t.kind === 'ident') {
      const name = this.parseTypeName('a type name');
      base = { kind: 'NamedType', name, span: this.span(start) };
    } else {
      this.error(t, `Expected a type but found ${this.describe(t)}`);
      base = { kind: 'NamedType', name: { kind: 'Ident', name: '<missing>', span: this.spanOf(t) }, span: this.spanOf(t) };
    }
    const dims = this.parseDims();
    if (base.kind === 'NamedType' && base.name.qualifier?.length && dims === 0) {
      this.error(t, `A package-qualified named type must be an array in this compiler grammar; '${identToString(base.name)}[]' is valid, but '${identToString(base.name)}' is not`);
    }
    if (dims > 0) return { kind: 'ArrayType', elem: base, dims, span: this.span(start) };
    return base;
  }

  private parseChanType(): A.ChanType {
    const start = this.startPos();
    let shared = false;
    let sharedEnd: 'read' | 'write' | undefined;
    if (this.accept('shared')) {
      shared = true;
      if (this.at('read') || this.at('write')) sharedEnd = this.next().text as 'read' | 'write';
    }
    if (!this.expect('chan', shared ? "after 'shared'" : 'to declare a channel type')) {
      return { kind: 'ChanType', elem: { kind: 'PrimitiveType', name: 'int', span: this.span(start) }, shared, sharedEnd, span: this.span(start) };
    }
    let elem: A.TypeNode;
    if (this.expect('<', "after 'chan' to give the channel's element type")) {
      elem = this.parseType();
      this.splitGtGt();
      this.expect('>', 'to close the channel type');
    } else {
      elem = { kind: 'PrimitiveType', name: 'int', span: this.span(start) };
    }
    let end: 'read' | 'write' | undefined;
    if (this.at('.') && (this.at('read', 1) || this.at('write', 1))) {
      const dot = this.peek();
      this.next();
      end = this.next().text as 'read' | 'write';
      if (sharedEnd) this.error(dot, `'shared ${sharedEnd} chan<...>' already selects which side is shared and cannot also be a channel-end type; use 'shared chan<...>.${end}' for a shared end`);
    }
    return { kind: 'ChanType', elem, shared, sharedEnd, end, span: this.span(start) };
  }

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------

  private parseBlock(): A.Block {
    const start = this.startPos();
    const open = this.next(); // '{'
    const stmts: A.Stmt[] = [];
    if (this.nesting > MAX_NESTING) {
      this.error(open, 'Blocks nested too deeply');
      this.skipTo(['}'], true);
      return { kind: 'Block', stmts, span: this.span(start) };
    }
    this.nesting++;
    try {
      return this.parseBlockBody(start, open, stmts);
    } finally {
      this.nesting--;
    }
  }

  private parseBlockBody(start: A.Pos, open: Token, stmts: A.Stmt[]): A.Block {
    while (!this.at('}')) {
      if (this.atEof()) {
        this.error(this.eof, `Missing '}' to close the block opened at line ${open.line + 1}`);
        break;
      }
      if (this.atUnindentedDeclaration()) {
        // The next declaration has started: this block was never closed. Leave
        // the token for the top level so the declaration is still parsed.
        this.errorAfterPrevious(`Missing '}' to close the block opened at line ${open.line + 1}`, '}');
        return { kind: 'Block', stmts, span: this.span(start) };
      }
      const before = this.i;
      const s = this.parseStatement(true);
      if (s) stmts.push(s);
      if (this.i === before) {
        const t = this.next();
        this.error(t, `Unexpected ${this.describe(t)} in a block`);
      }
    }
    this.accept('}');
    return { kind: 'Block', stmts, span: this.span(start) };
  }

  private parseStatement(allowDeclaration = false): A.Stmt | undefined {
    const start = this.startPos();
    const t = this.peek();

    if (t.kind === 'punct') {
      switch (t.text) {
        case '{':
          return this.parseBlock();
        case ';':
          this.next();
          return { kind: 'EmptyStmt', span: this.span(start) };
        case '}':
          return undefined;
      }
    }

    if (t.kind === 'keyword') {
      switch (t.text) {
        case 'par':
          return this.at('for', 1) ? this.parseFor() : this.parsePar();
        case 'seq': {
          this.next();
          if (!this.at('{')) this.error(this.peek(), "Expected '{' after 'seq'");
          const body = this.at('{') ? this.parseBlock() : { kind: 'Block' as const, stmts: [], span: this.span(start) };
          return { kind: 'SeqBlock', body, span: this.span(start) };
        }
        case 'if':
          return this.parseIf();
        case 'else':
          this.error(t, "'else' without a matching 'if'");
          this.next();
          this.parseStatement();
          return undefined;
        case 'while': {
          this.next();
          const cond = this.parseCondition('while');
          const body = this.parseSubStatement('while');
          return { kind: 'WhileStmt', cond, body, span: this.span(start) };
        }
        case 'do': {
          this.next();
          const body = this.parseSubStatement('do');
          this.expect('while', "after the body of 'do'");
          const cond = this.parseCondition('while');
          this.expect(';', "after the 'do ... while' condition");
          return { kind: 'DoStmt', body, cond, span: this.span(start) };
        }
        case 'for':
          return this.parseFor();
        case 'claim':
          return this.parseClaim();
        case 'switch':
          return this.parseSwitch();
        case 'alt':
        case 'pri':
          return this.parseAlt();
        case 'return': {
          this.next();
          const expr = this.at(';') ? undefined : this.parseExpression();
          this.expect(';', "after the 'return' statement");
          return { kind: 'ReturnStmt', expr, span: this.span(start) };
        }
        case 'break':
        case 'continue': {
          this.next();
          const label = this.atIdent() ? this.ident(this.next()) : undefined;
          this.expect(';', `after '${t.text}'`);
          return { kind: t.text === 'break' ? 'BreakStmt' : 'ContinueStmt', label, span: this.span(start) };
        }
        case 'skip':
        case 'stop':
        case 'suspend': {
          this.next();
          this.expect(';', `after '${t.text}'`);
          const kind = t.text === 'skip' ? 'SkipStmt' : t.text === 'stop' ? 'StopStmt' : 'SuspendStmt';
          return { kind, span: this.span(start) } as A.Stmt;
        }
        case 'case':
        case 'default':
          this.error(t, `'${t.text}' can only appear inside a 'switch' block`);
          this.next();
          this.skipTo([':', ';', '}'], false);
          this.accept(':');
          return undefined;
        case 'proc':
          this.error(t, "'proc' is not part of the syntax; declare procedures at top level as 'public void name(...)'");
          this.next();
          return undefined;
      }
    }

    // Labeled statement: `name: statement`.
    if (t.kind === 'ident' && this.at(':', 1)) {
      this.next();
      this.next();
      const stmt = this.parseStatement() ?? { kind: 'EmptyStmt' as const, span: this.span(start) };
      return { kind: 'LabeledStmt', label: this.ident(t), stmt, span: this.span(start) };
    }

    if (this.atLocalDeclStart()) {
      if (!allowDeclaration) {
        this.error(this.peek(), 'A variable declaration cannot be used as a single substatement; wrap it in a block with braces');
      }
      const decl = this.parseLocalDecl();
      this.expect(';', 'after the variable declaration');
      return decl;
    }

    // A misspelled block keyword: `pa { ... }`, `atl { ... }`, `sqe { ... }`.
    if (t.kind === 'ident') {
      const n = this.peek(1);
      const blockKeywords = ['par', 'alt', 'seq', 'else', 'do'];
      const s = n.text === '{' ? suggest(t.text, blockKeywords) : n.kind === 'number' || n.kind === 'string' || n.text === ';' ? suggest(t.text, ['return', 'break', 'continue', 'skip', 'stop', 'suspend']) : undefined;
      if (s) return this.retryAsKeyword(t, s);
    }

    return this.parseExpressionStatement();
  }

  /** Report a misspelled keyword, then parse the statement as if it had been spelled right so its body is still checked. */
  private retryAsKeyword(t: Token, keyword: string): A.Stmt | undefined {
    this.error(t, `Unknown statement '${t.text}'; did you mean '${keyword}'?`, this.replaceFix(t, keyword, `Change to '${keyword}'`));
    // Re-read the misspelled word as the keyword in place: no phantom token is
    // left behind for the callers that inspect the token stream afterwards.
    this.toks[this.i] = { kind: 'keyword', text: keyword, line: t.line, col: t.col, end: t.end };
    return this.parseStatement();
  }

  private parseExpressionStatement(): A.Stmt | undefined {
    const start = this.startPos();
    const startTok = this.peek();
    const errorsBefore = this.errors.length;
    const lastErrorBefore = this.lastErrorTok;
    const expr = this.parseExpression();
    if (expr.kind === 'ErrorExpr') {
      this.skipTo([';', '}'], false);
      this.accept(';');
      return undefined;
    }
    if (expr.kind === 'Invocation' && !expr.target && !expr.qualifier && this.at('{')) {
      // `whlie (x) { ... }`: a call is never followed by a block.
      const s = suggest(expr.name.name, ['if', 'while', 'for', 'switch', 'claim', 'alt']);
      if (s) {
        this.i = this.indexOfToken(expr.span.start);
        this.errors.length = errorsBefore;
        this.lastErrorTok = lastErrorBefore;
        return this.retryAsKeyword(this.peek(), s);
      }
      this.error(this.peek(), `Unexpected '{' after the call to '${expr.name.name}'; a call ends with ';'`);
    }
    if (!isStatementExpr(expr)) {
      if (expr.kind === 'NameExpr' && this.atIdent()) {
        // `itn x = 5;` or `Foo x;` with an unknown type name.
        const s = suggest(expr.name.name, [...TYPE_KEYWORDS, ...this.declaredTypes]);
        this.error(startTok, s ? `Unknown type '${expr.name.name}'; did you mean '${s}'?` : `'${expr.name.name}' is not a known type here`);
        this.skipTo([';', '}'], false);
        this.accept(';');
        return undefined;
      }
      if (expr.kind === 'ChanEnd') this.error(startTok, `'${sourceOf(expr)}' names a channel end; to read use '.read()' and to write use '.write(value)'`);
      else this.error(startTok, `Not a statement: ${describeExpr(expr)} has no effect. Only assignments, ++/--, calls, channel reads/writes, sync and timeout can stand alone`);
    }
    if (!this.expect(';', 'after the statement')) {
      // Recover at the next statement boundary without eating the next statement.
      if (!this.at('}') && this.peek().line === this.endPos().line) this.skipTo([';', '}'], false), this.accept(';');
    }
    return { kind: 'ExprStmt', expr, span: this.span(start) };
  }

  private parseLocalDecl(): A.LocalDecl {
    const start = this.startPos();
    const isConst = !!this.accept('const');
    const mobile = this.accept('mobile');
    const isMobile = !!mobile;
    if (isConst && mobile) this.error(mobile, "A local declaration cannot be both 'const' and 'mobile'");
    const typeTok = this.peek();
    const type = this.parseType();
    // `retrun x;`: a lower-case "type" that is one typo away from a statement keyword.
    // Other unknown names (including `itn`) are left to the checker, which knows the
    // imported types too; a lower-case record from another file is valid here.
    if (type.kind === 'NamedType' && !type.name.qualifier?.length && !this.declaredTypes.has(type.name.name) && /^[a-z]/.test(type.name.name)) {
      const s = suggest(type.name.name, ['return', 'break', 'continue']);
      if (s) this.error(typeTok, `Unknown type '${type.name.name}'; did you mean '${s}'?`, this.replaceFix(typeTok, s, `Change to '${s}'`));
    }
    const declarators = this.parseDeclarators();
    return { kind: 'LocalDecl', isConst, isMobile, type, declarators, span: this.span(start) };
  }

  private indexOfToken(pos: A.Pos): number {
    for (let k = this.i; k >= 0; k--) {
      const t = this.toks[k];
      if (t && t.line === pos.line && t.col === pos.col) return k;
    }
    return this.i;
  }

  private parseCondition(owner: string): A.Expr {
    const open = this.expect('(', `after '${owner}'`);
    if (!open && this.at('{')) return { kind: 'ErrorExpr', span: this.span(this.startPos()) };
    const e = this.parseExpression();
    if (open) this.expect(')', `to close the '${owner}' condition`);
    else this.accept(')');
    return e;
  }

  private parseSubStatement(owner: string): A.Stmt {
    const start = this.startPos();
    if (this.at('}') || this.atEof()) {
      this.error(this.peek(), `Expected a statement or block after '${owner}'`);
      return { kind: 'EmptyStmt', span: this.span(start) };
    }
    return this.parseStatement() ?? { kind: 'EmptyStmt', span: this.span(start) };
  }

  private parseIf(): A.IfStmt {
    const start = this.startPos();
    this.next();
    const cond = this.parseCondition('if');
    const then = this.parseSubStatement('if');
    let els: A.Stmt | undefined;
    if (this.accept('else')) els = this.parseSubStatement('else');
    return { kind: 'IfStmt', cond, then, else: els, span: this.span(start) };
  }

  private parsePar(): A.ParBlock {
    const start = this.startPos();
    this.next(); // par
    const barriers: A.Expr[] = [];
    let barrierParens = false;
    if (this.accept('enroll')) {
      if (this.accept('(')) {
        barrierParens = true;
        barriers.push(this.parseExpression());
        while (this.at(',')) {
          const comma = this.next();
          this.error(comma, "A parenthesised 'par enroll' accepts one barrier only; write 'par enroll a, b' without parentheses");
          barriers.push(this.parseExpression());
        }
        this.expect(')', "to close the 'enroll' list");
      } else {
        barriers.push(this.parseExpression());
        while (this.accept(',')) barriers.push(this.parseExpression());
      }
    }
    if (!this.at('{')) {
      const t = this.peek();
      this.error(t, `Expected '{' after 'par' but found ${this.describe(t)}`);
      return { kind: 'ParBlock', barriers, barrierParens, body: { kind: 'Block', stmts: [], span: this.span(start) }, span: this.span(start) };
    }
    const body = this.parseBlock();
    return { kind: 'ParBlock', barriers, barrierParens, body, span: this.span(start) };
  }

  private parseForHeader(owner: string): { init: A.LocalDecl | A.Expr[] | undefined; cond?: A.Expr; update: A.Expr[] } {
    let init: A.LocalDecl | A.Expr[] | undefined;
    if (!this.at(';')) {
      if (this.atLocalDeclStart()) init = this.parseLocalDecl();
      else {
        const first = this.peek();
        const expr = this.parseExpression();
        this.checkForStatementExpression(expr, first, owner, 'initialiser');
        init = [expr];
        while (this.accept(',')) {
          const tok = this.peek();
          const next = this.parseExpression();
          this.checkForStatementExpression(next, tok, owner, 'initialiser');
          init.push(next);
        }
      }
    }
    this.expect(';', `after the initialiser in '${owner}'`);
    const cond = this.at(';') ? undefined : this.parseExpression();
    this.expect(';', `after the condition in '${owner}'`);
    const update: A.Expr[] = [];
    if (!this.at(')')) {
      const first = this.peek();
      const expr = this.parseExpression();
      this.checkForStatementExpression(expr, first, owner, 'update');
      update.push(expr);
      while (this.accept(',')) {
        const tok = this.peek();
        const next = this.parseExpression();
        this.checkForStatementExpression(next, tok, owner, 'update');
        update.push(next);
      }
    }
    return { init, cond, update };
  }

  /** CUP permits only assignments, ++/--, calls and reads in a for/replicated-alt expression list. */
  private checkForStatementExpression(expr: A.Expr, token: Token, owner: string, part: 'initialiser' | 'update'): void {
    if (isForStatementExpr(expr)) return;
    this.error(token, `The ${part} of '${owner}' must be an assignment, ++/--, procedure call, or channel read; ${describeExpr(expr)} has no effect`);
  }

  private parseFor(): A.ForStmt {
    const start = this.startPos();
    const isPar = !!this.accept('par');
    this.next(); // for
    const owner = isPar ? 'par for' : 'for';
    let header: ReturnType<Parser['parseForHeader']> = { init: undefined, update: [] };
    if (this.expect('(', `after '${owner}'`)) {
      header = this.parseForHeader(owner);
      this.expect(')', `to close the '${owner}' header`);
    }
    const enroll: A.Expr[] = [];
    if (isPar && this.accept('enroll')) {
      this.expect('(', "after 'enroll'");
      enroll.push(this.parseExpression());
      while (this.accept(',')) enroll.push(this.parseExpression());
      this.expect(')', "to close the 'enroll' list");
    }
    const body = this.parseSubStatement(owner);
    return { kind: 'ForStmt', isPar, init: header.init, cond: header.cond, update: header.update, enroll, body, span: this.span(start) };
  }

  private parseClaim(): A.ClaimStmt {
    const start = this.startPos();
    this.next();
    const channels: Array<A.Expr | A.LocalDecl> = [];
    if (this.expect('(', "after 'claim'")) {
      for (;;) {
        if (this.at('chan') || this.at('shared')) {
          const cstart = this.startPos();
          const type = this.parseChanType();
          const name = this.expectIdent('a name for the claimed channel');
          this.expect('=', 'in the claim declaration');
          const init = this.parseExpression();
          channels.push({ kind: 'LocalDecl', isConst: false, isMobile: false, type, declarators: [{ kind: 'Declarator', name, dims: 0, init, span: this.span(cstart) }], span: this.span(cstart) });
        } else channels.push(this.parseExpression());
        if (this.accept(',')) continue;
        break;
      }
      this.expect(')', "to close the 'claim' list");
    }
    const body = this.parseSubStatement('claim');
    return { kind: 'ClaimStmt', channels, body, span: this.span(start) };
  }

  private parseSwitch(): A.SwitchStmt {
    const start = this.startPos();
    this.next();
    const expr = this.parseCondition('switch');
    const groups: A.SwitchGroup[] = [];
    if (this.expect('{', "to start the 'switch' block")) {
      while (!this.at('}') && !this.atEof()) {
        const before = this.i;
        const gstart = this.startPos();
        const labels: Array<A.Expr | undefined> = [];
        while (this.at('case') || this.at('default')) {
          const isDefault = this.next().text === 'default';
          labels.push(isDefault ? undefined : this.parseExpression());
          this.expect(':', isDefault ? "after 'default'" : "after the 'case' value");
        }
        if (labels.length === 0) {
          const t = this.peek();
          this.error(t, `Expected 'case' or 'default' in the switch block but found ${this.describe(t)}`);
          this.skipTo(['case', 'default', '}'], false);
          if (this.i === before) this.next();
          continue;
        }
        const stmts: A.Stmt[] = [];
        while (!this.at('case') && !this.at('default') && !this.at('}') && !this.atEof()) {
          const sb = this.i;
          const s = this.parseStatement(true);
          if (s) stmts.push(s);
          if (this.i === sb) this.next();
        }
        if (stmts.length === 0) this.error(this.peek(), "A switch 'case' or 'default' must contain at least one statement");
        groups.push({ kind: 'SwitchGroup', labels, stmts, span: this.span(gstart) });
      }
      this.expect('}', "to close the 'switch' block");
    }
    return { kind: 'SwitchStmt', expr, groups, span: this.span(start) };
  }

  private parseAlt(): A.AltStmt {
    const start = this.startPos();
    const isPri = !!this.accept('pri');
    if (!this.expect('alt', isPri ? "after 'pri'" : 'to start an alt')) {
      return { kind: 'AltStmt', isPri, cases: [], span: this.span(start) };
    }
    let replicated: A.AltStmt['replicated'];
    if (this.accept('(')) {
      replicated = this.parseForHeader('alt');
      this.expect(')', "to close the replicated 'alt' header");
    }
    const cases: A.AltCase[] = [];
    if (!this.at('{')) {
      const t = this.peek();
      this.error(t, `Expected '{' after 'alt' but found ${this.describe(t)}`);
      return { kind: 'AltStmt', isPri, replicated, cases, span: this.span(start) };
    }
    const open = this.next();
    if (this.at('}')) this.error(this.peek(), `${isPri ? "A 'pri alt'" : "An 'alt'"} must contain at least one guard`);
    while (!this.at('}')) {
      if (this.atEof()) {
        this.error(this.eof, `Missing '}' to close the alt opened at line ${open.line + 1}`);
        break;
      }
      const before = this.i;
      cases.push(this.parseAltCase());
      if (this.i === before) {
        const t = this.next();
        this.error(t, `Unexpected ${this.describe(t)} in alt; expected a guard like 'v = c.read()', 'skip' or 't.timeout(ms)'`);
      }
    }
    this.accept('}');
    return { kind: 'AltStmt', isPri, replicated, cases, span: this.span(start) };
  }

  private parseAltCase(): A.AltCase {
    const start = this.startPos();
    if (this.at('alt') || this.at('pri')) {
      const nested = this.parseAlt();
      return { kind: 'AltCase', nested, span: this.span(start) };
    }
    let precondition: A.Expr | undefined;
    if (this.at('(')) {
      this.next();
      precondition = this.parseExpression();
      this.expect(')', 'to close the alt precondition');
      this.expect('&&', "between the precondition and the guard ('(cond) && guard : ...')");
    }
    let guard: A.Guard | undefined;
    const gstart = this.startPos();
    if (this.accept('skip')) {
      guard = { kind: 'SkipGuard', span: this.span(gstart) };
    } else {
      const gtok = this.peek();
      const e = this.parseExpression();
      if (e.kind === 'AssignExpr' && e.op === '=' && e.value.kind === 'ChanRead') guard = { kind: 'ReadGuard', target: e.target, read: e.value, span: this.span(gstart) };
      else if (e.kind === 'Timeout') guard = { kind: 'TimeoutGuard', timeout: e, span: this.span(gstart) };
      else if (e.kind === 'ChanRead') this.error(gtok, `An alt guard must store the value: write 'v = ${sourceOf(e.target)}.read()'`, { title: "Store the value in 'v'", line: gtok.line, col: gtok.col, endCol: gtok.col, text: 'v = ' });
      else if (e.kind !== 'ErrorExpr') this.error(gtok, `Invalid alt guard ${describeExpr(e)}; a guard is 'v = c.read()', 'skip', or 't.timeout(ms)'`);
    }
    if (!this.expect(':', 'after the alt guard')) {
      this.skipTo([':', '}', ';'], false);
      this.accept(':');
    }
    const body = this.parseSubStatement('the alt guard');
    return { kind: 'AltCase', precondition, guard, body, span: this.span(start) };
  }

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------

  private parseExpression(): A.Expr {
    const start = this.startPos();
    if (this.nesting > MAX_NESTING) {
      // Deeper than any real program: bail out instead of overflowing the stack.
      this.error(this.peek(), 'Expression nested too deeply');
      return { kind: 'ErrorExpr', span: this.span(start) };
    }
    this.nesting++;
    try {
      return this.parseExpressionInner(start);
    } finally {
      this.nesting--;
    }
  }

  private parseExpressionInner(start: A.Pos): A.Expr {
    const lhs = this.parseTernary();
    const t = this.peek();
    if (t.kind === 'punct' && ASSIGN_OPS.has(t.text)) {
      if (lhs.kind !== 'NameExpr' && lhs.kind !== 'RecordAccess' && lhs.kind !== 'ArrayAccess') {
        this.error(t, `Cannot assign to ${describeExpr(lhs)}; the left side must be a variable, field or array element`);
      }
      this.next();
      let value: A.Expr;
      if (this.at('{')) {
        const brace = this.peek();
        this.error(brace, 'An array literal can only initialise a declaration or follow a new array type; it cannot be assigned later');
        value = this.parseArrayLiteral();
      } else value = this.parseExpression();
      return { kind: 'AssignExpr', op: t.text, target: lhs, value, span: this.span(start) };
    }
    return lhs;
  }

  private parseTernary(): A.Expr {
    const start = this.startPos();
    const cond = this.parseBinary(1);
    if (this.accept('?')) {
      const then = this.parseExpression();
      this.expect(':', "in the '?:' expression");
      const els = this.parseTernary();
      return { kind: 'TernaryExpr', cond, then, else: els, span: this.span(start) };
    }
    return cond;
  }

  private parseBinary(minPrec: number): A.Expr {
    const start = this.startPos();
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      const op = t.text;
      const prec = (t.kind === 'punct' || (t.kind === 'keyword' && op === 'is')) ? BINARY_PRECEDENCE[op] : undefined;
      if (prec === undefined || prec < minPrec) break;
      this.next();
      if (op === 'is') {
        const typeName = this.parseTypeName("a protocol case name after 'is'");
        left = { kind: 'IsExpr', expr: left, typeName, span: this.span(start) };
        continue;
      }
      const right = this.parseBinary(prec + 1);
      left = { kind: 'BinaryExpr', op, left, right, span: this.span(start) };
    }
    return left;
  }

  private parseUnary(): A.Expr {
    const start = this.startPos();
    const t = this.peek();
    if (t.kind === 'punct') {
      if (t.text === '+' || t.text === '-' || t.text === '!' || t.text === '~' || t.text === '++' || t.text === '--') {
        this.next();
        const operand = this.parseUnary();
        return { kind: 'UnaryExpr', op: t.text, prefix: true, operand, span: this.span(start) };
      }
      if (t.text === '(' && this.isCastAhead()) {
        this.next();
        const typeToken = this.peek();
        let type: A.TypeNode;
        // CUP parses a named cast through `expression`, so this is one of the
        // positions where a scalar package-qualified name is legal.
        if (this.peek().kind === 'ident') {
          const typeStart = this.startPos();
          const name = this.parseTypeName('a type name in the cast');
          type = { kind: 'NamedType', name, span: this.span(typeStart) };
        } else type = this.parseType();
        if (type.kind === 'ArrayType') this.error(typeToken, 'Array casts are not accepted by the ProcessJ grammar');
        this.expect(')', 'to close the cast');
        const expr = this.parseUnary();
        return { kind: 'CastExpr', type, expr, span: this.span(start) };
      }
    }
    return this.parsePostfix();
  }

  /** `(int) x` is always a cast; `(Name) x` is a cast only when followed by an operand that cannot continue an expression. */
  private isCastAhead(): boolean {
    const t1 = this.peek(1);
    if (t1.kind === 'keyword' && PRIMITIVES.has(t1.text)) {
      // (int) x  or  (int[]) x
      let k = 2;
      while (this.peek(k).text === '[' && this.peek(k + 1).text === ']') k += 2;
      return this.peek(k).text === ')';
    }
    if (t1.kind === 'ident') {
      const nameLength = this.qualifiedNameLength(1);
      const close = 1 + nameLength;
      if (nameLength > 0 && this.peek(close).text === ')') {
        const operand = this.peek(close + 1);
        if (operand.kind === 'ident' || operand.kind === 'number' || operand.kind === 'string' || operand.kind === 'char') return true;
        if (operand.kind === 'keyword') return operand.text === 'new' || operand.text === 'true' || operand.text === 'false' || operand.text === 'null' || operand.text === 'fork';
        if (operand.kind === 'punct') return operand.text === '(' || operand.text === '!' || operand.text === '~';
      }
    }
    return false;
  }

  private parsePostfix(): A.Expr {
    const start = this.startPos();
    let e = this.parsePrimary();
    for (;;) {
      if (this.at('.')) {
        const m = this.peek(1);
        if (m.kind === 'keyword' && (m.text === 'read' || m.text === 'write')) {
          this.next();
          this.next();
          if (m.text === 'read') {
            if (this.at('(')) {
              this.next();
              const extended = this.at('{') ? this.parseBlock() : undefined;
              this.expect(')', "to close '.read('");
              e = { kind: 'ChanRead', target: e, extended, span: this.span(start) };
            } else e = { kind: 'ChanEnd', target: e, end: 'read', span: this.span(start) };
          } else if (this.at('(')) {
            this.next();
            const value = this.parseExpression();
            this.expect(')', "to close '.write('");
            e = { kind: 'ChanWrite', target: e, value, span: this.span(start) };
          } else e = { kind: 'ChanEnd', target: e, end: 'write', span: this.span(start) };
          continue;
        }
        if (m.kind === 'keyword' && m.text === 'sync') {
          this.next();
          this.next();
          this.expect('(', "after 'sync'");
          this.expect(')', "after 'sync('");
          e = { kind: 'Sync', target: e, span: this.span(start) };
          continue;
        }
        if (m.kind === 'keyword' && m.text === 'timeout') {
          this.next();
          this.next();
          this.expect('(', "after 'timeout'");
          const delay = this.parseExpression();
          this.expect(')', "to close 'timeout('");
          e = { kind: 'Timeout', target: e, delay, span: this.span(start) };
          continue;
        }
        if (m.kind === 'ident') {
          this.next();
          const member = this.ident(this.next());
          if (this.at('(')) {
            const args = this.parseArgs();
            e = { kind: 'Invocation', target: e, name: member, args, span: this.span(start) };
          } else e = { kind: 'RecordAccess', target: e, member, span: this.span(start) };
          continue;
        }
        this.next();
        if (m.kind === 'keyword') this.error(m, `'${m.text}' is a keyword; after '.' only 'read', 'write', 'sync', 'timeout' or a field name is allowed`);
        else this.error(m, `Expected a field name after '.' but found ${this.describe(m)}`);
        continue;
      }
      if (this.at('[')) {
        this.next();
        const index = this.parseExpression();
        this.expect(']', 'to close the array index');
        e = { kind: 'ArrayAccess', target: e, index, span: this.span(start) };
        continue;
      }
      if (this.at('::') && this.atIdent(1)) {
        const separator = this.next();
        const name = this.ident(this.next());
        const qualifier = packageQualifier(e);
        if (!qualifier) this.error(separator, "Only a dotted package name may appear before '::'");
        if (this.at('(')) {
          const args = this.parseArgs();
          e = { kind: 'Invocation', qualifier: qualifier ?? [], name, args, span: this.span(start) };
        } else e = { kind: 'NameExpr', qualifier: qualifier ?? [], name, span: this.span(start) };
        continue;
      }
      if (this.at('++') || this.at('--')) {
        const op = this.next().text;
        e = { kind: 'UnaryExpr', op, prefix: false, operand: e, span: this.span(start) };
        continue;
      }
      break;
    }
    return e;
  }

  private parseArgs(): A.Expr[] {
    const args: A.Expr[] = [];
    this.expect('(', 'to start the argument list');
    if (!this.at(')')) {
      for (;;) {
        if (this.at(';') || this.at('}') || this.atEof()) {
          this.error(this.peek(), "Missing ')' to close the argument list");
          return args;
        }
        args.push(this.parseExpression());
        if (this.accept(',')) continue;
        break;
      }
    }
    this.expect(')', 'to close the argument list');
    return args;
  }

  private parseArrayLiteral(): A.ArrayLiteral {
    const start = this.startPos();
    this.next(); // '{'
    const elements: A.Expr[] = [];
    while (!this.at('}') && !this.atEof()) {
      elements.push(this.at('{') ? this.parseArrayLiteral() : this.parseExpression());
      if (!this.accept(',')) break;
      if (this.at('}')) {
        this.error(this.peek(), 'Trailing commas are not accepted in an array initializer');
        break;
      }
    }
    this.expect('}', 'to close the array initialiser');
    return { kind: 'ArrayLiteral', elements, span: this.span(start) };
  }

  private parsePrimary(): A.Expr {
    const start = this.startPos();
    const t = this.peek();
    switch (t.kind) {
      case 'number': {
        this.next();
        const litKind = numericLiteralKind(t.text);
        return { kind: 'Literal', litKind, text: t.text, span: this.spanOf(t) };
      }
      case 'string':
        this.next();
        return { kind: 'Literal', litKind: 'string', text: t.text, span: this.spanOf(t) };
      case 'char':
        this.next();
        return { kind: 'Literal', litKind: 'char', text: t.text, span: this.spanOf(t) };
      case 'ident': {
        this.next();
        if (this.at('(')) {
          const args = this.parseArgs();
          return { kind: 'Invocation', name: this.ident(t), args, span: this.span(start) };
        }
        return { kind: 'NameExpr', name: this.ident(t), span: this.spanOf(t) };
      }
      case 'keyword':
        switch (t.text) {
          case 'true':
          case 'false':
            this.next();
            return { kind: 'Literal', litKind: 'boolean', text: t.text, span: this.spanOf(t) };
          case 'null':
            this.next();
            return { kind: 'Literal', litKind: 'null', text: t.text, span: this.spanOf(t) };
          case 'new':
            return this.parseNew();
          case 'fork': {
            this.next();
            const args = this.parseArgs();
            return { kind: 'Invocation', name: this.ident(t), args, span: this.span(start) };
          }
        }
        break;
      case 'punct':
        if (t.text === '(') {
          this.next();
          const inner = this.parseExpression();
          this.expect(')', 'to close the parenthesis');
          return { kind: 'ParenExpr', expr: inner, span: this.span(start) };
        }
        break;
    }
    // Nothing usable here.
    if (t.kind === 'keyword') {
      const s = suggest(t.text, ['true', 'false', 'null', 'new']);
      this.error(t, `Unexpected keyword '${t.text}' in an expression${s ? `; did you mean '${s}'?` : ''}`);
    } else if (t === this.eof) this.error(t, 'Unexpected end of file in the middle of an expression');
    else this.error(t, `Expected an expression but found ${this.describe(t)}`);
    return { kind: 'ErrorExpr', span: this.spanOf(t) };
  }

  private parseNew(): A.Expr {
    const start = this.startPos();
    this.next(); // new
    if (this.accept('mobile')) {
      this.expect('(', "after 'new mobile'");
      const typeName = this.parseTypeName('a mobile procedure name');
      this.expect(')', "to close 'new mobile('");
      return { kind: 'NewMobile', typeName, span: this.span(start) };
    }
    const t = this.peek();
    let elem: A.TypeNode;
    if (t.kind === 'keyword' && PRIMITIVES.has(t.text)) {
      this.next();
      elem = { kind: 'PrimitiveType', name: t.text, span: this.spanOf(t) };
    } else if (t.text === 'chan' || t.text === 'shared') {
      elem = this.parseChanType();
    } else if (t.kind === 'ident') {
      const typeStart = this.startPos();
      const name = this.parseTypeName('a type name after new');
      elem = { kind: 'NamedType', name, span: this.span(typeStart) };
      if (this.at('{')) return this.parseRecordOrProtocolLiteral(name, start);
      if (name.qualifier?.length) {
        this.error(t, `Package-qualified names are accepted in record/protocol literals, but not array creation; use an imported short name instead of '${identToString(name)}'`);
      }
    } else {
      this.error(t, `Expected a type after 'new' but found ${this.describe(t)}`);
      return { kind: 'ErrorExpr', span: this.span(start) };
    }
    // Array creation: new T[e][e]...[] or new T[]{...}
    const dimExprs: A.Expr[] = [];
    let extraDims = 0;
    while (this.at('[')) {
      if (this.at(']', 1)) {
        this.next();
        this.next();
        extraDims++;
      } else if (extraDims === 0) {
        this.next();
        dimExprs.push(this.parseExpression());
        this.expect(']', 'to close the array dimension');
      } else break;
    }
    let init: A.ArrayLiteral | undefined;
    if (this.at('{')) {
      const brace = this.peek();
      if (dimExprs.length > 0) this.error(brace, 'A new array cannot have both explicit sizes and an initializer; use either new T[n] or new T[] { ... }');
      init = this.parseArrayLiteral();
    }
    if (dimExprs.length === 0 && !init) {
      this.error(this.peek(), `'new ${sourceOfType(elem)}' needs a size like '[10]' or an initialiser like '[] { 1, 2 }'`);
    }
    return { kind: 'NewArray', elem, dimExprs, extraDims, init, span: this.span(start) };
  }

  private parseRecordOrProtocolLiteral(typeName: A.Ident, start: A.Pos): A.Expr {
    this.next(); // '{'
    const fields: Array<{ name: A.Ident; value: A.Expr }> = [];
    let tag: A.Ident | undefined;
    if (this.atIdent() && this.at(':', 1)) {
      tag = this.ident(this.next());
      this.next();
    }
    if (!tag && this.at('}')) this.error(this.peek(), `A record literal must initialise at least one field; 'new ${typeName.name} {}' is not accepted by the ProcessJ grammar`);
    while (!this.at('}') && !this.atEof()) {
      const before = this.i;
      const name = this.expectIdent(`a field name in the ${tag ? 'protocol' : 'record'} literal`);
      this.expect('=', `after field '${name.name}' in the literal`);
      const value = this.parseExpression();
      fields.push({ name, value });
      if (!this.accept(',')) break;
      if (this.at('}')) {
        this.error(this.peek(), `Trailing commas are not accepted in a ${tag ? 'protocol' : 'record'} literal`);
        break;
      }
      if (this.i === before) this.next();
    }
    this.expect('}', `to close the 'new ${typeName.name} {' literal`);
    if (tag) return { kind: 'ProtocolLiteral', typeName, tag, fields, span: this.span(start) };
    return { kind: 'RecordLiteral', typeName, fields, span: this.span(start) };
  }
}

function isStatementExpr(e: A.Expr): boolean {
  switch (e.kind) {
    case 'AssignExpr':
    case 'Invocation':
    case 'ChanRead':
    case 'ChanWrite':
    case 'Sync':
    case 'Timeout':
    case 'ErrorExpr':
      return true;
    case 'UnaryExpr':
      return e.op === '++' || e.op === '--';
    default:
      return false;
  }
}

/** Literal category selected by the ordered, longest-match ProcessJ.flex rules. */
function numericLiteralKind(raw: string): A.Literal['litKind'] {
  const lower = raw.toLowerCase();
  if (lower.startsWith('0x')) return /l$/i.test(raw) ? 'long' : 'int';
  if (/l$/i.test(raw)) return 'long';
  if (/f$/i.test(raw)) return 'float';
  if (/d$/i.test(raw)) return 'double';
  if (/[.e]/i.test(raw)) return 'double';
  // Octal/decimal integer rules precede DoubleLiteral. Only an otherwise
  // all-digit spelling containing 8 or 9 after a leading zero falls through.
  if (/^0[0-9]*[89][0-9]*$/.test(raw)) return 'double';
  return 'int';
}

function containsVoid(t: A.TypeNode): boolean {
  if (t.kind === 'PrimitiveType') return t.name === 'void';
  if (t.kind === 'ArrayType' || t.kind === 'ChanType') return containsVoid(t.elem);
  return false;
}

/** Flatten the expression form CUP accepts as a package path before `::`. */
function packageQualifier(e: A.Expr): A.Ident[] | undefined {
  if (e.kind === 'NameExpr') return [...(e.qualifier ?? []), e.name];
  if (e.kind === 'RecordAccess') {
    const prefix = packageQualifier(e.target);
    return prefix ? [...prefix, e.member] : undefined;
  }
  if (e.kind === 'ParenExpr') return packageQualifier(e.expr);
  return undefined;
}

/** Narrower set used by CUP's `statement_expression` production in loop headers. */
function isForStatementExpr(e: A.Expr): boolean {
  if (e.kind === 'AssignExpr' || e.kind === 'Invocation' || e.kind === 'ChanRead') return true;
  return e.kind === 'UnaryExpr' && (e.op === '++' || e.op === '--');
}

function describeExpr(e: A.Expr): string {
  switch (e.kind) {
    case 'Literal':
      return `the literal ${e.text}`;
    case 'NameExpr':
      return `'${e.name.name}'`;
    case 'BinaryExpr':
      return `the '${e.op}' expression`;
    case 'ChanEnd':
      return `the channel end '${sourceOf(e)}'`;
    case 'RecordAccess':
      return `the field access '${sourceOf(e)}'`;
    case 'ArrayAccess':
      return 'the array element';
    case 'ParenExpr':
      return 'the parenthesised expression';
    default:
      return 'this expression';
  }
}

/** Short source rendering for messages (names and member chains only). */
function sourceOf(e: A.Expr): string {
  switch (e.kind) {
    case 'NameExpr':
      return `${qualifierToString(e.qualifier)}${e.name.name}`;
    case 'RecordAccess':
      return `${sourceOf(e.target)}.${e.member.name}`;
    case 'ChanEnd':
      return `${sourceOf(e.target)}.${e.end}`;
    case 'ArrayAccess':
      return `${sourceOf(e.target)}[...]`;
    default:
      return '...';
  }
}

function sourceOfType(t: A.TypeNode): string {
  switch (t.kind) {
    case 'PrimitiveType':
      return t.name;
    case 'NamedType':
      return identToString(t.name);
    case 'ArrayType':
      return sourceOfType(t.elem) + '[]'.repeat(t.dims);
    case 'ChanType':
      return `chan<${sourceOfType(t.elem)}>`;
  }
}

export { KEYWORDS as ALL_KEYWORDS };
