/**
 * Static analysis that runs on every keystroke, before and independently of the
 * compiler. Each lint recreates a check the ProcessJ compiler is missing, has
 * disabled, or gets wrong. The reasoning is documented next to each one.
 */
import type { RawDiagnostic } from './diagnostics';
import type { PJSymbol } from './symbols';
import { matchingClose, tokenize, type Token } from './tokens';

export interface AnalysisOptions {
  /** Names exported by the standard library, for the missing-import lint. */
  libraryNames?: Set<string>;
}

export interface FixHint {
  kind: 'add-import' | 'make-shared';
  line: number;
  col: number;
  title: string;
}

export type LintDiagnostic = RawDiagnostic & { fix?: FixHint };

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=']);
const INCDEC = new Set(['++', '--']);
const NUMERIC = new Set(['byte', 'short', 'int', 'long', 'float', 'double', 'char']);

export function analyze(text: string, symbols: PJSymbol[], locals: PJSymbol[], opts: AnalysisOptions = {}): LintDiagnostic[] {
  const { tokens, issues } = tokenize(text);
  const out: LintDiagnostic[] = [];

  for (const issue of issues) {
    out.push({ line: issue.line, startCol: issue.col, endCol: issue.end, message: issue.message, severity: 'error', code: issue.code, source: 'lsp' });
  }

  const procs = symbols.filter((s) => s.kind === 'proc');
  const ctx: Ctx = { tokens, symbols, locals, procs, out };

  lintChannelDirection(ctx);
  lintChannelWriteType(ctx);
  lintShortCircuitRead(ctx);
  lintParBlocks(ctx);
  lintUnusedAndShadowed(ctx);
  lintChannelWithoutPartner(ctx);
  lintAlts(ctx);
  lintMissingImport(ctx, opts.libraryNames);

  return out.sort((a, b) => a.line - b.line || (a.startCol ?? 0) - (b.startCol ?? 0));
}

interface Ctx {
  tokens: Token[];
  symbols: PJSymbol[];
  locals: PJSymbol[];
  procs: PJSymbol[];
  out: LintDiagnostic[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function report(ctx: Ctx, tok: Token, severity: RawDiagnostic['severity'], code: string, message: string, fix?: FixHint): void {
  ctx.out.push({ line: tok.line, startCol: tok.col, endCol: tok.end, message, severity, code, source: 'lsp', fix });
}

function procAt(ctx: Ctx, line: number): PJSymbol | undefined {
  return ctx.procs.find((p) => line >= p.line && line <= p.endLine);
}

function tokenRange(ctx: Ctx, sym: PJSymbol): [number, number] {
  let a = ctx.tokens.findIndex((t) => t.line >= sym.line);
  if (a < 0) a = ctx.tokens.length;
  let b = a;
  while (b < ctx.tokens.length && ctx.tokens[b].line <= sym.endLine) b++;
  return [a, b];
}

/** Locals (and params) visible in a proc, with the declared type text. */
function localsOf(ctx: Ctx, proc: PJSymbol): PJSymbol[] {
  return ctx.locals.filter((l) => l.container === proc.name);
}

function isParam(l: PJSymbol): boolean {
  return l.detail.endsWith('(parameter)');
}

/** Type text of a local as written: `chan<int>`, `shared chan<int>.read`, `int`, ... */
function typeOf(l: PJSymbol): string {
  return l.detail.replace(/\s*\(parameter\)$/, '').slice(0, -(l.name.length + 1)).trim();
}

interface ChanInfo {
  shared: boolean;
  base: string;
  end?: 'read' | 'write';
}

function chanInfo(l: PJSymbol): ChanInfo | undefined {
  const m = /^(shared\s+)?chan\s*<(.+)>(?:\.(read|write))?$/.exec(typeOf(l));
  if (!m) return undefined;
  return { shared: !!m[1], base: m[2].trim(), end: m[3] as 'read' | 'write' | undefined };
}

function prevIsDot(tokens: Token[], i: number): boolean {
  return i > 0 && tokens[i - 1].kind === 'punct' && tokens[i - 1].text === '.';
}

function is(t: Token | undefined, text: string): boolean {
  return !!t && t.text === text;
}

// ---------------------------------------------------------------------------
// Lints
// ---------------------------------------------------------------------------

/**
 * The type checker never checks the direction of a channel end at a use site
 * (TypeChecker.java:555-562, 599): `c.read.write(1)` and `in.write(..)` on a
 * `chan<int>.read` parameter are accepted and then fail (or misbehave) in Java.
 */
function lintChannelDirection(ctx: Ctx): void {
  const { tokens } = ctx;
  for (let i = 0; i + 4 < tokens.length; i++) {
    const [a, d1, m1, d2, m2] = [tokens[i], tokens[i + 1], tokens[i + 2], tokens[i + 3], tokens[i + 4]];
    if (a.kind !== 'ident' || !is(d1, '.') || !is(d2, '.')) continue;
    if ((is(m1, 'read') && is(m2, 'write')) || (is(m1, 'write') && is(m2, 'read'))) {
      report(ctx, m2, 'error', 'pj/channel-direction', `'${a.text}.${m1.text}' is a ${m1.text} end; it has no '${m2.text}' operation (the compiler does not check this and produces broken Java)`);
    }
  }
  for (const proc of ctx.procs) {
    const [a, b] = tokenRange(ctx, proc);
    const ends = new Map<string, ChanInfo>();
    for (const l of localsOf(ctx, proc)) {
      const info = chanInfo(l);
      if (info?.end) ends.set(l.name, info);
    }
    if (ends.size === 0) continue;
    for (let i = a; i + 2 < b; i++) {
      const t = tokens[i];
      if (t.kind !== 'ident' || prevIsDot(tokens, i) || !is(tokens[i + 1], '.')) continue;
      const info = ends.get(t.text);
      if (!info) continue;
      const member = tokens[i + 2];
      const opposite = info.end === 'read' ? 'write' : 'read';
      if (member.text === opposite) {
        report(ctx, member, 'error', 'pj/channel-direction', `'${t.text}' is declared as a ${info.end} end (chan<${info.base}>.${info.end}); it cannot ${opposite}`);
      }
    }
  }
}

/**
 * `visitChannelWriteStat` (TypeChecker.java:594-606) never compares the written
 * value with the channel's element type, so `chan<int> c; c.write("hi")` passes.
 * We check the obvious literal cases.
 */
function lintChannelWriteType(ctx: Ctx): void {
  const { tokens } = ctx;
  for (const proc of ctx.procs) {
    const [a, b] = tokenRange(ctx, proc);
    const chans = new Map<string, ChanInfo>();
    for (const l of localsOf(ctx, proc)) {
      const info = chanInfo(l);
      if (info && info.end !== 'read') chans.set(l.name, info);
    }
    if (chans.size === 0) continue;
    for (let i = a; i + 5 < b; i++) {
      const t = tokens[i];
      if (t.kind !== 'ident' || prevIsDot(tokens, i)) continue;
      const info = chans.get(t.text);
      if (!info || !is(tokens[i + 1], '.') || !is(tokens[i + 2], 'write') || !is(tokens[i + 3], '(') || !is(tokens[i + 5], ')')) continue;
      const lit = tokens[i + 4];
      const base = info.base;
      let bad: string | undefined;
      if (lit.kind === 'string' && base !== 'string') bad = 'a string';
      else if (lit.kind === 'number' && !NUMERIC.has(base)) bad = 'a number';
      else if (lit.kind === 'char' && !NUMERIC.has(base)) bad = 'a char';
      else if ((lit.text === 'true' || lit.text === 'false') && base !== 'boolean') bad = 'a boolean';
      if (bad) {
        report(ctx, lit, 'error', 'pj/channel-write-type', `Writing ${bad} to '${t.text}', which carries ${base} (the compiler does not check channel write types)`);
      }
    }
  }
}

/**
 * The ChannelRead rewriter (rewriters/ChannelRead.java:227-249) hoists both operands
 * of a binary expression regardless of the operator, so a channel read on the right
 * of `&&` / `||` / `?:` is executed even when the left side decides the result.
 */
function lintShortCircuitRead(ctx: Ctx): void {
  const { tokens } = ctx;
  let start = 0;
  for (let i = 0; i <= tokens.length; i++) {
    const t = tokens[i];
    const boundary = !t || (t.kind === 'punct' && (t.text === ';' || t.text === '{' || t.text === '}'));
    if (!boundary) continue;
    const stmt = tokens.slice(start, i);
    start = i + 1;
    const ops = stmt.filter((x) => x.kind === 'punct' && (x.text === '&&' || x.text === '||' || x.text === '?'));
    if (ops.length === 0) continue;
    for (let k = 0; k + 2 < stmt.length; k++) {
      if (is(stmt[k], '.') && is(stmt[k + 1], 'read') && is(stmt[k + 2], '(')) {
        // Only flag reads that come after the short-circuit operator.
        if (ops.some((op) => op.col < stmt[k + 1].col || op.line < stmt[k + 1].line)) {
          report(ctx, stmt[k + 1], 'warning', 'pj/short-circuit-read', "This channel read is on the right of '&&', '||' or '?:'. The compiler hoists it out of the expression and performs it unconditionally, so it can block even when the left side is false. Move the read to its own statement.");
        }
      }
    }
  }
}

interface Branch {
  first: Token;
  assigned: Map<string, Token>;
  used: Map<string, Token>;
  declared: Set<string>;
  ends: Map<string, Token>; // "c.read" -> first token
}

/**
 * Two checks on `par` blocks:
 *  - Parallel usage rule (the compiler's ParallelUsageCheck pass is disabled in
 *    ProcessJc.java:326): a variable written in one branch may not be read or
 *    written in another.
 *  - A non-shared channel end used in more than one branch needs `shared`.
 */
function lintParBlocks(ctx: Ctx): void {
  const { tokens } = ctx;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'keyword' || t.text !== 'par') continue;
    let j = i + 1;
    if (is(tokens[j], 'for')) continue; // replicated par: one body, nothing to compare
    if (is(tokens[j], 'enroll') && is(tokens[j + 1], '(')) j = matchingClose(tokens, j + 1) + 1;
    if (!is(tokens[j], '{')) continue;
    const close = matchingClose(tokens, j);
    const branches = splitBranches(tokens, j + 1, close);
    const proc = procAt(ctx, t.line);
    const procLocals = proc ? localsOf(ctx, proc) : [];

    // Parallel usage.
    const reported = new Set<string>();
    for (let x = 0; x < branches.length; x++) {
      for (const [name, wtok] of branches[x].assigned) {
        if (branches[x].declared.has(name)) continue;
        for (let y = 0; y < branches.length; y++) {
          if (x === y || branches[y].declared.has(name)) continue;
          const other = branches[y].assigned.get(name) ?? branches[y].used.get(name);
          if (!other) continue;
          const key = `${name}@${t.line}`;
          if (reported.has(key)) continue;
          reported.add(key);
          const later = other.line > wtok.line || (other.line === wtok.line && other.col > wtok.col) ? other : wtok;
          const what = branches[y].assigned.has(name) ? 'written' : 'read';
          report(ctx, later, 'error', 'pj/parallel-usage', `'${name}' is written in one branch of this par and ${what} in another. Branches run concurrently, so this is a data race (parallel usage rule; the compiler's check for it is disabled).`);
        }
      }
    }

    // Shared channel ends.
    const seenEnds = new Map<string, number>();
    for (let x = 0; x < branches.length; x++) {
      for (const [end, tok] of branches[x].ends) {
        const first = seenEnds.get(end);
        if (first === undefined) {
          seenEnds.set(end, x);
          continue;
        }
        if (first === x) continue;
        const chanName = end.split('.')[0];
        const decl = procLocals.find((l) => l.name === chanName);
        const info = decl ? chanInfo(decl) : undefined;
        if (!decl || !info || info.shared) continue;
        const declTypeCol = decl.startCol - typeOf(decl).length - 1;
        const fix: FixHint = { kind: 'make-shared', line: decl.line, col: Math.max(0, declTypeCol), title: `Declare '${chanName}' as shared` };
        report(ctx, tok, 'error', 'pj/shared-channel-end', `'${end}' is used in more than one branch of this par. Only one process may hold a non-shared end; declare it 'shared chan<${info.base}>' or give each branch its own channel.`, fix);
        seenEnds.set(end, -1);
      }
    }
  }
}

/** Split the tokens of a par body into top-level statements, classifying each one's variable traffic. */
function splitBranches(tokens: Token[], from: number, to: number): Branch[] {
  const branches: Branch[] = [];
  let start = from;
  let depth = 0;
  for (let i = from; i < to; i++) {
    const t = tokens[i];
    if (t.kind === 'punct') {
      if (t.text === '{' || t.text === '(' || t.text === '[') depth++;
      else if (t.text === '}' || t.text === ')' || t.text === ']') {
        depth--;
        if (t.text === '}' && depth === 0 && !is(tokens[i + 1], 'else')) {
          branches.push(classify(tokens, start, i + 1));
          start = i + 1;
        }
      } else if (t.text === ';' && depth === 0) {
        branches.push(classify(tokens, start, i + 1));
        start = i + 1;
      }
    }
  }
  if (start < to) branches.push(classify(tokens, start, to));
  return branches.filter((b) => b.first !== undefined);
}

function classify(tokens: Token[], from: number, to: number): Branch {
  const b: Branch = { first: tokens[from], assigned: new Map(), used: new Map(), declared: new Set(), ends: new Map() };
  for (let i = from; i < to; i++) {
    const t = tokens[i];
    if (t.kind !== 'ident') continue;
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    if (prev && prev.kind === 'punct' && prev.text === '.') continue; // member name
    if (next && next.kind === 'punct' && next.text === '(') continue; // call
    if (next && (next.kind === 'ident' || (next.kind === 'punct' && next.text === '<'))) continue; // type position
    // Declaration: `<type> name` where the previous token ends a type.
    if (prev && (prev.kind === 'ident' || prev.kind === 'keyword' || (prev.kind === 'punct' && (prev.text === '>' || prev.text === ']'))) && next && next.kind === 'punct' && (next.text === '=' || next.text === ';' || next.text === ',' || next.text === ')')) {
      const isDecl = prev.kind !== 'keyword' || !['return', 'new', 'is', 'else', 'case'].includes(prev.text);
      if (isDecl) {
        b.declared.add(t.text);
        continue;
      }
    }
    // Channel end use.
    if (next && next.kind === 'punct' && next.text === '.') {
      const member = tokens[i + 2];
      if (member && (member.text === 'read' || member.text === 'write')) {
        const key = `${t.text}.${member.text}`;
        if (!b.ends.has(key)) b.ends.set(key, t);
        continue;
      }
      // Record field access: `r.f = ..` writes r, otherwise reads r.
      let k = i + 1;
      while (is(tokens[k], '.') && tokens[k + 1]?.kind === 'ident') k += 2;
      const after = tokens[k];
      if (after && after.kind === 'punct' && (ASSIGN_OPS.has(after.text) || INCDEC.has(after.text))) {
        if (!b.assigned.has(t.text)) b.assigned.set(t.text, t);
      } else if (!b.used.has(t.text)) b.used.set(t.text, t);
      continue;
    }
    // Plain variable: assignment, increment, indexed assignment, or read.
    let k = i + 1;
    while (is(tokens[k], '[')) k = matchingClose(tokens, k) + 1;
    const after = tokens[k];
    const prefixIncDec = prev && prev.kind === 'punct' && INCDEC.has(prev.text);
    if ((after && after.kind === 'punct' && (ASSIGN_OPS.has(after.text) || INCDEC.has(after.text))) || prefixIncDec) {
      if (!b.assigned.has(t.text)) b.assigned.set(t.text, t);
      if (after && after.kind === 'punct' && after.text !== '=' && !b.used.has(t.text)) b.used.set(t.text, t); // `x += 1` also reads x
    } else if (!b.used.has(t.text)) b.used.set(t.text, t);
  }
  return b;
}

/**
 * Unused locals, and locals that shadow a parameter. The compiler hoists both to
 * differently named Java fields, so shadowing is accepted silently and every later
 * reference is ambiguous to the reader.
 */
function lintUnusedAndShadowed(ctx: Ctx): void {
  const { tokens } = ctx;
  for (const proc of ctx.procs) {
    const [a, b] = tokenRange(ctx, proc);
    const locals = localsOf(ctx, proc);
    const params = locals.filter(isParam);
    for (const l of locals) {
      if (l.name === 'args' && isParam(l)) continue;
      let uses = 0;
      for (let i = a; i < b; i++) {
        const t = tokens[i];
        if (t.kind !== 'ident' || t.text !== l.name || prevIsDot(tokens, i)) continue;
        if (t.line === l.line && t.col === l.startCol) continue;
        uses++;
      }
      const declTok = tokens.find((t) => t.line === l.line && t.col === l.startCol);
      if (!declTok) continue;
      if (uses === 0) {
        report(ctx, declTok, isParam(l) ? 'info' : 'warning', 'pj/unused', `'${l.name}' is never used`);
      }
      if (!isParam(l) && params.some((p) => p.name === l.name)) {
        report(ctx, declTok, 'warning', 'pj/shadows-parameter', `'${l.name}' shadows a parameter of '${proc.name}'. The compiler accepts this silently and hoists both to different fields, which makes every later '${l.name}' ambiguous to read.`);
      }
    }
  }
}

/**
 * A channel declared in a proc and only ever read (or only ever written) inside
 * that proc will block forever on the first use. With this compiler's scheduler
 * that also means a core pinned at 100%.
 */
function lintChannelWithoutPartner(ctx: Ctx): void {
  const { tokens } = ctx;
  for (const proc of ctx.procs) {
    const [a, b] = tokenRange(ctx, proc);
    for (const l of localsOf(ctx, proc)) {
      if (isParam(l)) continue;
      const info = chanInfo(l);
      if (!info || info.end) continue;
      let reads: Token | undefined;
      let writes: Token | undefined;
      let bare = 0;
      for (let i = a; i < b; i++) {
        const t = tokens[i];
        if (t.kind !== 'ident' || t.text !== l.name || prevIsDot(tokens, i)) continue;
        if (t.line === l.line && t.col === l.startCol) continue;
        if (is(tokens[i + 1], '.')) {
          const m = tokens[i + 2];
          if (is(m, 'read')) reads ??= m;
          else if (is(m, 'write')) writes ??= m;
          else bare++;
        } else bare++;
      }
      if (bare > 0) continue;
      if (reads && !writes) report(ctx, reads, 'warning', 'pj/channel-no-writer', `'${l.name}' is read here but nothing in '${proc.name}' ever writes it or passes it on; this read blocks forever (and the scheduler spins at 100% CPU while it waits).`);
      if (writes && !reads) report(ctx, writes, 'warning', 'pj/channel-no-reader', `'${l.name}' is written here but nothing in '${proc.name}' ever reads it or passes it on; this write blocks forever.`);
    }
  }
}

/**
 * Three known code-generator problems around `alt` and timers:
 *  - a `timeout` guard is emitted as a blocking sleep before the alt (CodeGenJava.java:2104)
 *  - a second alt in the same proc redeclares Java locals and javac rejects it (CodeGenJava.java:1869)
 *  - the alt template introduces locals named `index`/`btemp` that alias user variables (CodeGenJava.java:2117)
 *  - plain `timeout` calls return immediately because of PJTimer.start() (PJTimer.java:33)
 */
function lintAlts(ctx: Ctx): void {
  const { tokens } = ctx;
  const insideAlt = new Set<number>();
  for (const proc of ctx.procs) {
    const [a, b] = tokenRange(ctx, proc);
    let alts = 0;
    for (let i = a; i < b; i++) {
      const t = tokens[i];
      if (t.kind === 'keyword' && t.text === 'alt' && is(tokens[i + 1], '{')) {
        alts++;
        const close = matchingClose(tokens, i + 1);
        for (let k = i; k <= close; k++) insideAlt.add(k);
        if (alts === 2) {
          report(ctx, t, 'warning', 'pj/multiple-alts', `Second 'alt' in '${proc.name}'. The generated Java redeclares its guard variables (ready0, booleanGuards1, ...) so javac fails with "already defined"; put each alt in its own proc.`);
        }
        for (let k = i; k <= close; k++) {
          if (tokens[k].kind === 'keyword' && tokens[k].text === 'timeout' && is(tokens[k + 1], '(') && prevIsDot(tokens, k)) {
            report(ctx, tokens[k], 'warning', 'pj/alt-timeout', 'A timeout guard in an alt is compiled as a blocking sleep *before* the alt, so channel guards are not watched during the wait (CodeGenJava.java:2104). The alt only sees them once the timeout has elapsed.');
          }
        }
      }
    }
    if (alts > 0) {
      for (const l of localsOf(ctx, proc)) {
        if (l.name === 'index' || l.name === 'btemp') {
          const declTok = tokens.find((t) => t.line === l.line && t.col === l.startCol);
          if (declTok) report(ctx, declTok, 'warning', 'pj/reserved-alt-name', `'${l.name}' is also the name of a variable the alt code generator creates; references may silently bind to the generated one. Rename it.`);
        }
      }
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'keyword' && t.text === 'timeout' && is(tokens[i + 1], '(') && prevIsDot(tokens, i) && !insideAlt.has(i)) {
      report(ctx, t, 'info', 'pj/timeout-noop', 'In the current ProcessJ build every timeout returns immediately: PJTimer.start() stores a relative delay that the timer queue reads as an absolute time (PJTimer.java:33).');
    }
  }
}

/** `println` without `import std.*;` fails in name checking with a message that does not mention imports. */
function lintMissingImport(ctx: Ctx, libraryNames?: Set<string>): void {
  if (!libraryNames || libraryNames.size === 0) return;
  const { tokens } = ctx;
  const hasStd = tokens.some((t, i) => t.text === 'import' && is(tokens[i + 1], 'std'));
  if (hasStd) return;
  const defined = new Set(ctx.symbols.map((s) => s.name));
  let lastHeaderLine = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'keyword' && (t.text === 'import' || t.text === 'package')) lastHeaderLine = t.line;
    if (t.kind === 'ident' && libraryNames.has(t.text) && !defined.has(t.text) && is(tokens[i + 1], '(') && !prevIsDot(tokens, i)) {
      const fix: FixHint = { kind: 'add-import', line: lastHeaderLine + 1, col: 0, title: "Add 'import std.*;'" };
      report(ctx, t, 'error', 'pj/missing-import', `'${t.text}' comes from the standard library; add 'import std.*;' at the top of the file.`, fix);
      return;
    }
  }
}
