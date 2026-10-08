#!/usr/bin/env node
/**
 * Differential test of the LSP parser against the ProcessJ compiler's parser.
 *
 * The compiler's `-showTree` flag prints the tree its CUP parser built, right
 * after parsing and before any name or type checking, so even programs that do
 * not type-check can be compared. For each file this script:
 *
 *   1. parses it with dist/src/parser/parser.js and renders what the compiler's
 *      ParseTreePrinter would print for that tree, as a normalised S-expression
 *      per top-level item (pragma, package, import, declaration);
 *   2. runs the compiler with -showTree and turns its indented dump into the
 *      same S-expressions;
 *   3. compares the two item by item, and reports files that exactly one side
 *      rejects (a lexer issue or parse error here, a syntax error or crash there).
 *
 * The dump omits a few things and the compiler's tree drops a few more, so the
 * rendering of our tree drops them too: spans, parentheses, unary `+` (the
 * compiler's grammar discards it), statement labels and break/continue targets,
 * which end a channel-end expression names, `par` on a for loop, `pri` on an alt,
 * how a channel type is shared, `const` on locals and parameters, `[]` written
 * after a declared name, the annotations of records and protocols, and pragma
 * contents. A `seq` block prints as a plain block, a `stop` statement prints as
 * nothing, and numeric literals are compared by value. Library files are
 * compared with their `#pragma LIBRARY` line blanked on both sides, because that
 * pragma makes the compiler generate library code instead of printing the tree.
 *
 * The --fuzz mode generates seeded, reproducible programs that stress operator
 * precedence and associativity, casts, ternaries, assignments, member chains,
 * channel operations, every statement form and the declaration forms, batched
 * many cases per file (one JVM per file), plus single-file near misses (one
 * token dropped, repeated, swapped, inserted or replaced) and a list of edge
 * cases, to check that both parsers reject the same inputs.
 *
 * Needs a ProcessJ install (see README). Usage:
 *   npm run build
 *   node scripts/parse-diff.js [--jobs=N] [--show] <file-or-directory>...
 *   node scripts/parse-diff.js --fuzz=CASES [--seed=N] [--near-miss=FILES] [--batch=N] [--depth=N] [--jobs=N] [--keep=DIR] [--show]
 * --show prints every item that agrees (files), or the near misses we reject
 * later in the file than the compiler does (fuzz). --keep writes the generated
 * files to DIR. Exits 1 when any difference is found.
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { parse } = require('../dist/src/parser/parser.js');
const { tokenize } = require('../dist/src/tokens.js');
const { findInstall } = require('../dist/src/config.js');

// ---------------------------------------------------------------------------
// S-expressions
// ---------------------------------------------------------------------------

function sx(node) {
  if (Array.isArray(node)) return `(${node.map(sx).join(' ')})`;
  return /^[^\s()"]+$/.test(node) ? node : JSON.stringify(node);
}

/** The first place two normalised trees differ, as a path and both subtrees. */
function firstDifference(a, b, where = []) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a[0] !== b[0]) {
    return sx(a) === sx(b) ? undefined : { where, ours: a, compiler: b };
  }
  for (let k = 1; k < a.length; k++) {
    const d = firstDifference(a[k], b[k], [...where, `${a[0]}[${k}]`]);
    if (d) return d;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Literal values, as the compiler's PrimitiveLiteral constructor renders them
// ---------------------------------------------------------------------------

/** Integer.decode / Long.decode: 0x hex, leading-zero octal, otherwise decimal. */
function decodeInteger(digits) {
  if (/^0[xX]/.test(digits)) return BigInt(digits).toString();
  if (/^0[0-7]+$/.test(digits)) return BigInt(`0o${digits.slice(1)}`).toString();
  return BigInt(digits).toString();
}

/** The shortest decimal that reads back as the same 32-bit float. */
function shortestFloat(f) {
  if (!Number.isFinite(f)) return String(f);
  for (let p = 1; p <= 9; p++) {
    const s = f.toPrecision(p);
    if (Math.fround(Number(s)) === f) return String(Number(s));
  }
  return String(f);
}

function charCode(raw) {
  const body = raw.slice(1, -1);
  if (body[0] !== '\\') return body.charCodeAt(0);
  const simple = { b: 8, t: 9, n: 10, f: 12, r: 13, '"': 34, "'": 39, '\\': 92 };
  if (body[1] in simple) return simple[body[1]];
  if (body[1] === 'u') return parseInt(body.slice(2), 16);
  return parseInt(body.slice(1), 8);
}

/** Integers (int, long, char) print as decimal, floating values by value, the rest verbatim. */
function ourLiteral(e) {
  try {
    return literalValue(e.litKind, e.text);
  } catch {
    return `?${e.text}`; // a malformed literal, already reported by the lexer
  }
}

function literalValue(kind, raw) {
  switch (kind) {
    case 'int':
    case 'long':
      return `I${decodeInteger(raw.replace(/[lL]$/, ''))}`;
    case 'char':
      return `I${charCode(raw)}`;
    case 'float':
      return `F${shortestFloat(Math.fround(parseFloat(raw.replace(/[fF]$/, ''))))}`;
    case 'double':
      return `F${String(parseFloat(raw.replace(/[dD]$/, '')))}`;
    default:
      return raw;
  }
}

function compilerLiteral(text) {
  if (/^-?\d+$/.test(text)) return `I${BigInt(text).toString()}`;
  if (/^-?(\d|Infinity|NaN)/.test(text)) return `F${String(parseFloat(text))}`;
  return text;
}

// ---------------------------------------------------------------------------
// Our tree, rendered the way the compiler would build and print it
// ---------------------------------------------------------------------------

const seq = (elements) => ['Seq', ...elements];
const qualified = (qualifier, name) => (qualifier?.length ? `${qualifier.map((q) => q.name).join('.')}::` : '') + name;
const nameOf = (id) => ['Name', qualified(id.qualifier, id.name)];

class Renderer {
  constructor(text) {
    const lines = text.split(/\r\n|\r|\n/);
    this.lineStarts = [];
    let offset = 0;
    // Spans count a CRLF pair as one line break, like the tokenizer.
    const breaks = text.match(/\r\n|\r|\n/g) ?? [];
    lines.forEach((line, k) => {
      this.lineStarts.push(offset);
      offset += line.length + (breaks[k]?.length ?? 0);
    });
    this.text = text;
  }

  slice(span) {
    return this.text.slice(this.lineStarts[span.start.line] + span.start.col, this.lineStarts[span.end.line] + span.end.col);
  }

  type(t) {
    switch (t.kind) {
      case 'PrimitiveType':
        return ['PrimitiveType', t.name];
      case 'NamedType':
        return ['NamedType', nameOf(t.name)];
      case 'ArrayType':
        return ['ArrayType', String(t.dims), this.type(t.elem)];
      case 'ChanType':
        return [t.end ? 'ChannelEndType' : 'ChannelType', this.type(t.elem)];
    }
    return ['?type', t.kind];
  }

  /**
   * Parameters and fields fold `[]` written after the name into their type; the
   * compiler keeps those on the name, where the dump does not show them. The
   * span still covers only the written type, so count its trailing `[]`.
   */
  writtenType(t) {
    if (t.kind !== 'ArrayType') return this.type(t);
    const trailing = /(?:\s*\[\s*\])+\s*$/.exec(this.slice(t.span));
    const written = trailing ? trailing[0].split('[').length - 1 : 0;
    if (written === t.dims) return this.type(t);
    return written === 0 ? this.type(t.elem) : this.type({ ...t, dims: written });
  }

  items(program) {
    const out = [];
    const at = (node) => node.span.start.line + 1;
    for (const pragma of program.pragmas) out.push({ line: at(pragma), tree: ['Pragma'] });
    if (program.pkg) out.push({ line: program.pkg[0].span.start.line + 1, tree: ['Package', seq(program.pkg.map((id) => ['Name', id.name]))] });
    for (const imp of program.imports) {
      const names = imp.path.map((id) => id.name);
      if (imp.wildcard) names.push('*');
      const file = names.pop();
      out.push({ line: at(imp), tree: ['Import', seq(names.map((n) => ['Name', n])), ['Name', file]] });
    }
    for (const d of program.decls) for (const tree of this.decl(d)) out.push({ line: at(d), tree });
    return out;
  }

  decl(d) {
    const mods = seq(d.modifiers?.map((m) => ['Modifier', m]) ?? []);
    switch (d.kind) {
      case 'ProcDecl': {
        // A Hashtable: one value per key, the last one written wins.
        const annotations = new Map(d.annotations.map((a) => [a.name, a.value]));
        const tree = [
          'ProcTypeDecl',
          ['Annotations', ...[...annotations].map(([k, v]) => `${k}=${v}`).sort()],
          mods,
          this.type(d.returnType),
          ['Name', d.name.name],
          seq(d.params.map((p) => ['ParamDecl', this.writtenType(p.type), ['Name', p.name.name]])),
          seq(d.implements.map(nameOf)),
        ];
        if (d.body) tree.push(this.block(d.body));
        return [tree];
      }
      case 'RecordDecl':
        return [['RecordTypeDecl', mods, ['Name', d.name.name], seq(d.extends.map(nameOf)), seq(d.members.map((f) => this.member(f)))]];
      case 'ProtocolDecl': {
        const tree = ['ProtocolTypeDecl', mods, ['Name', d.name.name], seq(d.extends.map(nameOf))];
        if (d.cases) tree.push(seq(d.cases.map((c) => ['ProtocolCase', ['Name', c.name.name], seq(c.members.map((f) => this.member(f)))])));
        return [tree];
      }
      case 'ConstDecl':
        return d.declarators.map((v) => ['ConstantDecl', mods, this.type(d.type), this.var(v)]);
      case 'ExternDecl':
        return [['NamedType', ['Name', d.name.name]]];
    }
    return [['?decl', d.kind]];
  }

  member(f) {
    return ['RecordMember', this.writtenType(f.type), ['Name', f.name.name]];
  }

  var(v) {
    return v.init ? ['Var', ['Name', v.name.name], this.expr(v.init)] : ['Var', ['Name', v.name.name]];
  }

  localDecls(decl) {
    return decl.declarators.map((v) => ['LocalDecl', this.type(decl.type), this.var(v)]);
  }

  block(b) {
    return ['Block', seq(this.elements(b.stmts))];
  }

  /** Block statements: one element per declarator, `null` for `;`. */
  elements(stmts) {
    const out = [];
    for (let s of stmts) {
      while (s.kind === 'LabeledStmt') s = s.stmt;
      if (s.kind === 'LocalDecl') out.push(...this.localDecls(s));
      else if (s.kind === 'EmptyStmt') out.push('Null');
      else if (s.kind === 'StopStmt') out.push(['Multi']);
      else out.push(this.stmt(s));
    }
    return out;
  }

  /** A sub-statement: the dump skips a null (empty) one, and `stop` prints nothing. */
  sub(s) {
    while (s.kind === 'LabeledStmt') s = s.stmt;
    if (s.kind === 'EmptyStmt' || s.kind === 'StopStmt') return [];
    if (s.kind === 'LocalDecl') return this.localDecls(s);
    return [this.stmt(s)];
  }

  forInit(init) {
    if (!init) return [];
    if (!Array.isArray(init)) return this.localDecls(init);
    return init.map((e) => ['ExprStat', this.expr(e)]);
  }

  stmt(s) {
    switch (s.kind) {
      case 'Block':
        return this.block(s);
      case 'SeqBlock':
        return this.block(s.body);
      case 'ParBlock':
        return ['ParBlock', seq(this.elements(s.body.stmts)), seq(s.barriers.map((e) => this.expr(e)))];
      case 'ExprStmt': {
        const e = s.expr;
        if (e.kind === 'ChanWrite' || e.kind === 'Sync' || e.kind === 'Timeout') return this.expr(e);
        return ['ExprStat', this.expr(e)];
      }
      case 'IfStmt':
        return ['IfStat', this.expr(s.cond), ...this.sub(s.then), ...(s.else ? this.sub(s.else) : [])];
      case 'WhileStmt':
        return ['WhileStat', this.expr(s.cond), ...this.sub(s.body)];
      case 'DoStmt':
        return ['DoStat', ...this.sub(s.body), this.expr(s.cond)];
      case 'ForStmt':
        return [
          'ForStat',
          seq(this.forInit(s.init)),
          ...(s.cond ? [this.expr(s.cond)] : []),
          seq(s.update.map((e) => ['ExprStat', this.expr(e)])),
          seq(s.enroll.map((e) => this.expr(e))),
          ...this.sub(s.body),
        ];
      case 'ClaimStmt':
        return ['ClaimStat', seq(s.channels.map((c) => (c.kind === 'LocalDecl' ? this.localDecls(c)[0] : this.expr(c)))), ...this.sub(s.body)];
      case 'SwitchStmt':
        return [
          'SwitchStat',
          this.expr(s.expr),
          seq(s.groups.map((g) => ['SwitchGroup', seq(g.labels.map((l) => (l ? ['SwitchLabel', this.expr(l)] : ['SwitchLabel']))), seq(this.elements(g.stmts))])),
        ];
      case 'AltStmt':
        return this.alt(s);
      case 'ReturnStmt':
        return s.expr ? ['Return', this.expr(s.expr)] : ['Return'];
      case 'BreakStmt':
        return ['BreakStat'];
      case 'ContinueStmt':
        return ['ContinueStat'];
      case 'SkipStmt':
        return ['SkipStat'];
      case 'SuspendStmt':
        return ['SuspendStat', seq([])];
      case 'LocalDecl':
        return ['Multi', ...this.localDecls(s)];
    }
    return ['?stmt', s.kind];
  }

  alt(s) {
    const tree = ['AltStat'];
    if (s.replicated) {
      tree.push(seq(this.forInit(s.replicated.init)));
      if (s.replicated.cond) tree.push(this.expr(s.replicated.cond));
      tree.push(seq(s.replicated.update.map((e) => ['ExprStat', this.expr(e)])));
    }
    tree.push(seq(s.cases.map((c) => this.altCase(c))));
    return tree;
  }

  altCase(c) {
    if (c.nested) return ['AltCase', this.alt(c.nested)];
    const tree = ['AltCase'];
    if (c.precondition) tree.push(this.expr(c.precondition));
    if (c.guard) tree.push(['Guard', this.guard(c.guard)]);
    if (c.body) tree.push(...this.sub(c.body));
    return tree;
  }

  guard(g) {
    switch (g.kind) {
      case 'ReadGuard':
        return ['ExprStat', ['Assignment', '=', this.expr(g.target), this.expr(g.read)]];
      case 'SkipGuard':
        return ['SkipStat'];
      case 'TimeoutGuard':
        return this.expr(g.timeout);
    }
    return ['?guard', g.kind];
  }

  expr(e) {
    switch (e.kind) {
      case 'Literal':
        return ['PrimitiveLiteral', ourLiteral(e)];
      case 'NameExpr':
        return ['NameExpr', ['Name', qualified(e.qualifier, e.name.name)]];
      case 'ParenExpr':
        return this.expr(e.expr);
      case 'BinaryExpr':
        return ['BinaryExpr', e.op, this.expr(e.left), this.expr(e.right)];
      case 'UnaryExpr':
        // `PLUS unary_expression` returns its operand: no node for unary plus.
        if (e.prefix && e.op === '+') return this.expr(e.operand);
        return [e.prefix ? 'UnaryPreExpr' : 'UnaryPostExpr', e.op, this.expr(e.operand)];
      case 'AssignExpr':
        return ['Assignment', e.op, this.expr(e.target), this.expr(e.value)];
      case 'TernaryExpr':
        return ['Ternary', this.expr(e.cond), this.expr(e.then), this.expr(e.else)];
      case 'CastExpr':
        return ['CastExpr', this.type(e.type), this.expr(e.expr)];
      case 'IsExpr':
        return ['BinaryExpr', 'instanceof', this.expr(e.expr), ['NameExpr', nameOf(e.typeName)]];
      case 'Invocation':
        return ['Invocation', ...(e.target ? [this.expr(e.target)] : []), ['Name', qualified(e.qualifier, e.name.name)], seq(e.args.map((a) => this.expr(a)))];
      case 'RecordAccess':
        return ['RecordAccess', this.expr(e.target), ['Name', e.member.name]];
      case 'ArrayAccess':
        return ['ArrayAccessExpr', this.expr(e.target), this.expr(e.index)];
      case 'ChanEnd':
        return ['ChannelEndExpr', this.expr(e.target)];
      case 'ChanRead':
        return ['ChannelReadExpr', this.expr(e.target), ...(e.extended ? [this.block(e.extended)] : [])];
      case 'ChanWrite':
        return ['ChannelWriteStat', this.expr(e.target), this.expr(e.value)];
      case 'Sync':
        return ['SyncStat', this.expr(e.target)];
      case 'Timeout':
        return ['TimeoutStat', this.expr(e.target), this.expr(e.delay)];
      case 'NewArray':
        return [
          'NewArray',
          this.type(e.elem),
          seq(e.dimExprs.map((d) => this.expr(d))),
          seq(Array.from({ length: e.extraDims }, () => 'Null')),
          ...(e.init ? [this.expr(e.init)] : []),
        ];
      case 'ArrayLiteral':
        return ['ArrayLiteral', seq(e.elements.map((x) => this.expr(x)))];
      case 'RecordLiteral':
        return ['RecordLiteral', nameOf(e.typeName), seq(e.fields.map((f) => ['Multi', ['Name', f.name.name], this.expr(f.value)]))];
      case 'ProtocolLiteral':
        return ['ProtocolLiteral', nameOf(e.typeName), ['Name', e.tag.name], seq(e.fields.map((f) => ['Multi', ['Name', f.name.name], this.expr(f.value)]))];
      case 'NewMobile':
        // The printer's visitNewMobile is misspelled, so only the name is printed.
        return nameOf(e.typeName);
      case 'ErrorExpr':
        return ['Error'];
    }
    return ['?expr', e.kind];
  }
}

/** Our side: problems (lexer issues and parse errors) and the rendered items. */
function oursFor(text) {
  const result = parse(text);
  const problems = [
    ...result.lexIssues.map((i) => `${i.line + 1}:${i.col + 1}: ${i.message}`),
    ...result.errors.map((e) => `${e.line + 1}:${e.col + 1}: ${e.message}`),
  ];
  return { problems, items: new Renderer(text).items(result.program) };
}

// ---------------------------------------------------------------------------
// The compiler's -showTree dump
// ---------------------------------------------------------------------------

/**
 * Each dump line is `<source line>: <indent><text>`, with the text starting at
 * column indent + 4 whatever the width of the line number. A Sequence prints
 * `Sequence:[n nodes]` and then one `Sequence[i]:` sibling per element, with the
 * element's own lines nested one level deeper.
 */
function dumpLines(stdout) {
  const root = { head: '', kids: [], indent: -Infinity };
  const stack = [root];
  for (const raw of stdout.split(/\r?\n/)) {
    const m = /^(\d+):( *)(\S.*?)\s*$/.exec(raw);
    if (!m) continue;
    const node = { head: m[3], kids: [], indent: m[1].length + 1 + m[2].length - 4 };
    while (stack[stack.length - 1].indent >= node.indent) stack.pop();
    stack[stack.length - 1].kids.push(node);
    stack.push(node);
  }
  return root.kids;
}

/** Printer headers that are not just a class name with a colon. */
const HEADS = { 'Continue Statement': 'ContinueStat', 'New Array': 'NewArray' };

/** Convert sibling dump lines, folding each Sequence header and its elements into one ['Seq', ...]. */
function convertSiblings(kids) {
  const out = [];
  for (let k = 0; k < kids.length; k++) {
    const m = /^Sequence:\[(\d+) nodes\]$/.exec(kids[k].head);
    if (!m) {
      out.push(convertLine(kids[k]));
      continue;
    }
    const elements = [];
    for (let j = 0; j < Number(m[1]); j++) {
      const element = kids[++k];
      if (!element) break;
      if (/: = null$/.test(element.head)) elements.push('Null');
      else {
        const parts = convertSiblings(element.kids);
        elements.push(parts.length === 1 ? parts[0] : ['Multi', ...parts]);
      }
    }
    out.push(seq(elements));
  }
  return out;
}

function convertLine(node) {
  const h = node.head;
  let m;
  if ((m = /^Name = (.*)$/.exec(h))) return ['Name', m[1]];
  if ((m = /^PrimtiveLiteral = (.*)$/.exec(h))) return ['PrimitiveLiteral', compilerLiteral(m[1])];
  if ((m = /^PrimitiveType = (.*)$/.exec(h))) return ['PrimitiveType', m[1]];
  if ((m = /^Modifier \((.*)\)$/.exec(h))) return ['Modifier', m[1]];
  if ((m = /^Annotations: \{(.*)\}$/.exec(h))) return ['Annotations', ...(m[1] ? m[1].split(', ').sort() : [])];
  if ((m = /^ArrayType:((?:\[\])*)$/.exec(h))) return ['ArrayType', String(m[1].length / 2), ...convertSiblings(node.kids)];
  if ((m = /^Operator(?::| =) (.*)$/.exec(h))) return { operator: m[1] };
  const tag = HEADS[h] ?? h.replace(/:$/, '');
  const kids = convertSiblings(node.kids);
  const op = kids.find((k) => k && !Array.isArray(k) && typeof k === 'object');
  const rest = kids.filter((k) => k !== op);
  return op ? [tag, op.operator, ...rest] : [tag, ...rest];
}

/** The compiler side: either a rejection message or the converted items. */
function compilerFor(stdout, stderr) {
  const roots = dumpLines(stdout);
  const compilation = roots.find((r) => r.head === 'Compilation:');
  if (!compilation) {
    const said = `${stdout}\n${stderr}`
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.startsWith('-- '))
      .slice(0, 4)
      .join(' | ');
    return { rejected: said || '(no output)' };
  }
  const children = convertSiblings(compilation.kids);
  // The package child is null (and skipped) when there is no package declaration.
  const [pragmas, pkg, imports, decls] = children.length === 4 ? children : [children[0], undefined, children[1], children[2]];
  const items = [...pragmas.slice(1)];
  if (pkg) items.push(['Package', pkg]);
  items.push(...imports.slice(1), ...decls.slice(1));
  return { items };
}

// ---------------------------------------------------------------------------
// Running the compiler
// ---------------------------------------------------------------------------

/** A private compiler home; `workingdir` names a directory that never exists, so no code is written. */
function makeHome(install) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-parse-diff-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'processjrc'), `workingdir=no-output\ninstalldir=${install.installDir}\n`);
  return root;
}

let runCounter = 0;
function runCompiler(install, root, name, text) {
  const dir = path.join(root, `run${runCounter++}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, name), text);
  const args = [`-Duser.home=${path.join(root, 'home')}`, '-cp', install.classpath, 'ProcessJc', '-showTree', '-include', install.includeDir, name];
  return new Promise((resolve) => {
    execFile(install.javaBin, args, { cwd: dir, timeout: 60000, maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ stdout: String(stdout), stderr: String(stderr) + (error?.killed ? '\n(timed out)' : '') });
    });
  });
}

async function pool(tasks, jobs) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const k = next++;
      results[k] = await tasks[k]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, worker));
  return results;
}

/** `#pragma LIBRARY` makes the compiler generate library code instead of printing the tree. */
function withoutLibraryPragma(text) {
  return text.replace(/^[ \t]*#pragma[ \t]+LIBRARY[ \t]*;/gim, (m) => ' '.repeat(m.length));
}

/**
 * Compare one program. The verdict is one of:
 *   agree           both accept and every item matches
 *   differ          both accept, but some items differ
 *   ours-only       we reject, the compiler accepts
 *   compiler-only   the compiler rejects, we accept
 *   both-reject     both reject
 */
async function compare(install, root, name, source) {
  const text = withoutLibraryPragma(source);
  const ours = oursFor(text);
  const run = await runCompiler(install, root, name, text);
  const theirs = compilerFor(run.stdout, run.stderr);
  const result = { name, text, ours, theirs, items: 0, agreed: 0, differences: [] };
  if (theirs.rejected) {
    result.verdict = ours.problems.length ? 'both-reject' : 'compiler-only';
    // Where each side stopped: a near miss should be rejected at the same place.
    const line = /:(\d+): (?:Syntax error|integer number|long number)|at line (\d+)/.exec(theirs.rejected);
    if (line && ours.problems.length) {
      result.compilerLine = Number(line[1] ?? line[2]);
      result.ourLine = Math.min(...ours.problems.map((p) => Number(p.split(':')[0])));
    }
    return result;
  }
  if (ours.problems.length) {
    result.verdict = 'ours-only';
    return result;
  }
  const count = Math.max(ours.items.length, theirs.items.length);
  for (let k = 0; k < count; k++) {
    const a = ours.items[k];
    const b = theirs.items[k];
    result.items++;
    const d = a && b ? firstDifference(a.tree, b) : { where: [], ours: a?.tree ?? '(none)', compiler: b ?? '(none)' };
    if (d) result.differences.push({ line: a?.line ?? ours.items[ours.items.length - 1]?.line ?? 0, ...d, oursItem: a?.tree, compilerItem: b });
    else result.agreed++;
  }
  result.verdict = result.differences.length ? 'differ' : 'agree';
  return result;
}

const clip = (s, n = 400) => (s.length > n ? `${s.slice(0, n)} ...` : s);

function describe(result, show) {
  const lines = [];
  switch (result.verdict) {
    case 'differ':
      for (const d of result.differences) {
        lines.push(`${result.name}:${d.line}: tree differs at ${d.where.join(' > ') || 'item'}`);
        lines.push(`    ours:     ${clip(sx(d.ours))}`);
        lines.push(`    compiler: ${clip(sx(d.compiler))}`);
      }
      break;
    case 'ours-only':
      lines.push(`${result.name}: only we reject it: ${clip(result.ours.problems.slice(0, 3).join(' | '))}`);
      break;
    case 'compiler-only':
      lines.push(`${result.name}: only the compiler rejects it: ${clip(result.theirs.rejected)}`);
      break;
  }
  if (show && result.verdict === 'agree') for (const item of result.ours.items) lines.push(`${result.name}:${item.line}: ${sx(item.tree)}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Program generator
// ---------------------------------------------------------------------------

const BINARY = ['||', '&&', '|', '^', '&', '==', '!=', '<', '>', '<=', '>=', '<<', '>>', '>>>', '+', '-', '*', '/', '%'];
const ASSIGN = ['=', '*=', '/=', '%=', '+=', '-=', '<<=', '>>=', '>>>=', '&=', '^=', '|='];
const PRIMS = ['boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double', 'string', 'barrier', 'timer'];
const NAMES = ['a', 'b', 'c', 'd', 'x', 'y', 'z', 'i', 'j', 'n', 'v', 't', 'ch', 'arr', 'rec', 'val', 'out', 'in2'];
const TYPES = ['T', 'R', 'P', 'Msg', 'Point'];
const LITERALS = [
  '0', '1', '7', '42', '1000', '2147483647', '0x1f', '0XFF', '017', '00', '5L', '0x10L', '077l', '9223372036854775807L',
  '1.5', '.25', '3.', '1e3', '2.5e-2', '7d', '1.0D', '08', '1.5f', '2F', '.5f', '1e2f', '1E+2',
  "'a'", "'Z'", "'\\n'", "'\\t'", "'\\\\'", "'\\''", "'\\\"'", "'\\101'", "'\\0'", "'\\u0061'",
  '"abc"', '""', '"a b c"', 'true', 'false', 'null',
];

/** mulberry32: a small seeded generator, so every case can be regenerated from its seed. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random programs inside the compiler's grammar. Expressions are written with
 * as few parentheses as possible so precedence and associativity decide the
 * shape. A primary chain tracks which CUP class it is in: `[...]` may only follow
 * a name or a `primary_no_new_array_or_mobile`, and `::` only a dotted name.
 */
class Generator {
  constructor(seed) {
    this.next = random(seed);
    this.labels = [];
  }

  int(n) {
    return Math.floor(this.next() * n);
  }

  chance(p) {
    return this.next() < p;
  }

  pick(list) {
    return list[this.int(list.length)];
  }

  /** Pick one of several weighted alternatives: [[weight, () => string], ...]. */
  choose(options) {
    const live = options.filter(([w]) => w > 0);
    let r = this.next() * live.reduce((s, [w]) => s + w, 0);
    for (const [w, f] of live) if ((r -= w) < 0) return f();
    return live[live.length - 1][1]();
  }

  name() {
    return this.pick(NAMES);
  }

  typeName() {
    return this.choose([
      [6, () => this.pick(TYPES)],
      [1, () => `lib::${this.pick(TYPES)}`],
      [1, () => `std.lib::${this.pick(TYPES)}`],
    ]);
  }

  literal() {
    return this.pick(LITERALS);
  }

  // Expressions --------------------------------------------------------------

  expr(d) {
    return this.choose([
      [d > 0 ? 1 : 0, () => `${this.lhs(d - 1)} ${this.pick(ASSIGN)} ${this.expr(d - 1)}`],
      [8, () => this.conditional(d)],
    ]);
  }

  conditional(d) {
    if (d > 0 && this.chance(0.15)) return `${this.chain(d - 1)} ? ${this.expr(d - 1)} : ${this.conditional(d - 1)}`;
    return this.chain(d);
  }

  /**
   * A flat run of operands and binary operators: the parser alone decides the
   * grouping. `x is T` is a relational expression, so the operator right after
   * it must be relational or looser (`a is T + b` is a syntax error).
   */
  chain(d) {
    const n = d > 0 ? this.int(5) : 0;
    // Shapes that look like casts but are not: `(a) - b`, `(a) + b`, `(a)++ - b`.
    let s = n > 0 && this.chance(0.15) ? `(${this.name()})${this.pick(['', '++', '--'])}` : this.unary(d - 1);
    let afterIs = false;
    for (let k = 0; k < n; k++) {
      if (this.chance(0.08)) {
        s += ` is ${this.typeName()}`;
        afterIs = true;
      } else {
        s += ` ${this.pick(afterIs ? BINARY.slice(0, 11) : BINARY)} ${this.unary(d - 1)}`;
        afterIs = false;
      }
    }
    return s;
  }

  unary(d) {
    if (d <= 0) return this.simple();
    return this.choose([
      [2, () => `${this.pick(['-', '+', '!', '~'])}${this.chance(0.5) ? ' ' : ''}${this.unary(d - 1)}`],
      [1, () => `${this.pick(['++', '--'])}${this.unary(d - 1)}`],
      [1, () => `${this.pick(['-', '+', '!', '~', '++', '--'])} ${this.pick(['-', '+', '!', '~'])} ${this.unary(d - 1)}`],
      [2, () => `(${this.pick(PRIMS)}) ${this.unary(d - 1)}`],
      [2, () => `(${this.typeName()}) ${this.notPlusMinus(d - 1)}`],
      // CUP casts to any parenthesised name.
      [1, () => `((${this.typeName()})) ${this.notPlusMinus(d - 1)}`],
      [2, () => `${this.primary(d - 1)}${this.pick(['++', '--'])}`],
      [10, () => this.primary(d)],
    ]);
  }

  /** CUP's unary_expression_not_plus_minus: what a named cast may be applied to. */
  notPlusMinus(d) {
    if (d <= 0) return this.simple();
    return this.choose([
      [1, () => `${this.pick(['!', '~'])}${this.unary(d - 1)}`],
      [1, () => `(${this.typeName()}) ${this.notPlusMinus(d - 1)}`],
      [1, () => `(${this.pick(PRIMS)}) ${this.unary(d - 1)}`],
      [1, () => `${this.primary(d - 1)}${this.pick(['++', '--'])}`],
      [5, () => this.primary(d)],
    ]);
  }

  simple() {
    return this.chance(0.6) ? this.name() : this.literal();
  }

  args(d, min = 0) {
    const n = min + this.int(3);
    return Array.from({ length: n }, () => this.expr(d)).join(', ');
  }

  /** A primary with a random chain of suffixes; returns the text. */
  primary(d) {
    return this.primaryOf(d).text;
  }

  primaryOf(d) {
    // cls: 'name' (a bare identifier), 'plain' (primary_no_new_array_or_mobile) or 'other'.
    let p = this.choose([
      [6, () => ({ text: this.name(), cls: 'name', path: true })],
      [3, () => ({ text: this.literal(), cls: 'plain', literal: true })],
      [d > 0 ? 2 : 0, () => ({ text: `(${this.expr(d - 1)})`, cls: 'plain' })],
      [d > 0 ? 2 : 0, () => ({ text: `${this.name()}(${this.args(d - 1)})`, cls: 'plain' })],
      [d > 0 ? 1 : 0, () => ({ text: `fork(${this.args(d - 1, 1)})`, cls: 'plain' })],
      [1, () => ({ text: `${this.pick(['lib', 'std.lib'])}::${this.name()}`, cls: 'other' })],
      [d > 0 ? 1 : 0, () => ({ text: `${this.pick(['lib', 'std.lib'])}::${this.name()}(${this.args(d - 1)})`, cls: 'plain' })],
      [d > 0 ? 2 : 0, () => ({ text: this.newArray(d - 1), cls: 'other' })],
      [d > 0 ? 1 : 0, () => ({ text: `new ${this.typeName()} { ${this.fields(d - 1, 1)} }`, cls: 'plain' })],
      [d > 0 ? 1 : 0, () => ({ text: `new ${this.typeName()} { ${this.name()}: ${this.fields(d - 1, 0)} }`, cls: 'plain' })],
      [1, () => ({ text: `new mobile(${this.typeName()})`, cls: 'other' })],
    ]);
    const suffixes = d > 0 ? this.int(4) : 0;
    for (let k = 0; k < suffixes; k++) {
      // A member after a number would be read as part of it (`1.x` lexes as `1.` then `x`).
      if (p.literal && /^[0-9.]/.test(p.text)) break;
      p = this.choose([
        [3, () => ({ text: `${p.text}.${this.name()}`, cls: 'plain', path: p.path })],
        [2, () => ({ text: `${p.text}.${this.name()}(${this.args(d - 1)})`, cls: 'plain' })],
        [p.cls === 'other' ? 0 : 3, () => ({ text: `${p.text}[${this.expr(d - 1)}]`, cls: 'plain' })],
        [2, () => ({ text: `${p.text}.read()`, cls: 'other' })],
        [d > 1 ? 1 : 0, () => ({ text: `${p.text}.read(${this.block(d - 2)})`, cls: 'other' })],
        [1, () => ({ text: `${p.text}.${this.pick(['read', 'write'])}`, cls: 'other' })],
        [p.path ? 1 : 0, () => ({ text: `${p.text}::${this.name()}`, cls: 'other' })],
        [p.path ? 1 : 0, () => ({ text: `${p.text}::${this.name()}(${this.args(d - 1)})`, cls: 'plain' })],
      ]);
    }
    return p;
  }

  fields(d, min) {
    const n = min + this.int(3);
    return Array.from({ length: n }, () => `${this.name()} = ${this.expr(d)}`).join(', ');
  }

  arrayLiteral(d) {
    const n = this.int(4);
    return `{ ${Array.from({ length: n }, () => (d > 0 && this.chance(0.3) ? this.arrayLiteral(d - 1) : this.expr(d))).join(', ')} }`;
  }

  newArray(d) {
    const elem = this.choose([
      [4, () => this.pick(PRIMS)],
      [2, () => this.pick(TYPES)],
      [1, () => this.chanType(false)],
    ]);
    if (this.chance(0.4)) return `new ${elem}${'[]'.repeat(1 + this.int(2))} ${this.arrayLiteral(d)}`;
    const sizes = Array.from({ length: 1 + this.int(2) }, () => `[${this.expr(d)}]`).join('');
    return `new ${elem}${sizes}${'[]'.repeat(this.int(2))}`;
  }

  /** Assignable: a name, a field or an element. */
  lhs(d) {
    return this.choose([
      [4, () => this.name()],
      [d >= 0 ? 2 : 0, () => {
        const p = this.primaryOf(Math.max(d, 0));
        if (p.literal && /^[0-9.]/.test(p.text)) return this.name();
        return p.cls === 'other' ? `${p.text}.${this.name()}` : this.chance(0.5) ? `${p.text}.${this.name()}` : `${p.text}[${this.expr(Math.max(d, 0))}]`;
      }],
    ]);
  }

  // Types --------------------------------------------------------------------

  chanType(allowArrays = true) {
    const elem = this.chance(0.15) ? this.chanType(false) : this.chance(0.2) ? `${this.pick(PRIMS)}[]` : this.chance(0.7) ? this.pick(PRIMS) : this.pick(TYPES);
    // Nested channel types close with `> >`: the compiler's lexer reads `>>` as a shift.
    const inner = `<${elem}${elem.endsWith('>') ? ' ' : ''}>`;
    const t = this.choose([
      [3, () => `chan${inner}`],
      [2, () => `chan${inner}.${this.pick(['read', 'write'])}`],
      [1, () => `shared chan${inner}`],
      [1, () => `shared ${this.pick(['read', 'write'])} chan${inner}`],
      [1, () => `shared chan${inner}.${this.pick(['read', 'write'])}`],
    ]);
    return allowArrays && this.chance(0.1) ? `${t}[]` : t;
  }

  type() {
    return this.choose([
      [5, () => this.pick(PRIMS)],
      [2, () => `${this.pick(PRIMS)}${'[]'.repeat(1 + this.int(2))}`],
      [2, () => this.pick(TYPES)],
      [1, () => `${this.pick(TYPES)}[]`],
      [1, () => `std.lib::${this.pick(TYPES)}[]`],
      [2, () => this.chanType()],
    ]);
  }

  declarators(d, max = 3) {
    const n = 1 + this.int(max);
    return Array.from({ length: n }, () => {
      const dims = this.chance(0.15) ? '[]'.repeat(1 + this.int(2)) : '';
      if (!this.chance(0.6)) return `${this.name()}${dims}`;
      return `${this.name()}${dims} = ${this.chance(0.15) ? this.arrayLiteral(d) : this.expr(d)}`;
    }).join(', ');
  }

  // Statements ---------------------------------------------------------------

  block(d, ind = '') {
    const n = d > 0 ? this.int(4) : this.int(2);
    const inner = `${ind}    `;
    const stmts = Array.from({ length: n }, () => `${inner}${this.blockStatement(d, inner)}\n`).join('');
    return `{\n${stmts}${ind}}`;
  }

  blockStatement(d, ind) {
    return this.choose([
      [2, () => `${this.chance(0.2) ? this.pick(['const ', 'mobile ']) : ''}${this.type()} ${this.declarators(Math.min(d, 2))};`],
      [1, () => {
        const label = `L${this.int(3)}`;
        this.labels.push(label);
        const s = `${label}: ${this.statement(d, ind, { labelled: true })}`;
        this.labels.pop();
        return s;
      }],
      [8, () => this.statement(d, ind)],
    ]);
  }

  /** A statement expression: what may stand alone or appear in a for header. */
  statementExpression(d) {
    return this.choose([
      [4, () => `${this.lhs(d - 1)} ${this.pick(ASSIGN)} ${this.expr(d)}`],
      [1, () => `${this.pick(['++', '--'])}${this.unary(d - 1)}`],
      [1, () => `${this.primary(d - 1)}${this.pick(['++', '--'])}`],
      [2, () => `${this.name()}(${this.args(d - 1)})`],
      [2, () => {
        const p = this.primaryOf(d - 1);
        return p.literal && /^[0-9.]/.test(p.text) ? `(${p.text}).${this.name()}()` : `${p.text}.${this.name()}(${this.args(d - 1)})`;
      }],
      [1, () => `${this.pick(['lib', 'std.lib'])}::${this.name()}(${this.args(d - 1)})`],
      [1, () => `fork(${this.args(d - 1, 1)})`],
      [2, () => `${this.channel(d - 1)}.read()`],
    ]);
  }

  /** Something to call `.read()`, `.write(...)`, `.sync()` or `.timeout(...)` on. */
  channel(d) {
    const p = this.primaryOf(Math.max(0, d));
    return p.literal && /^[0-9.]/.test(p.text) ? this.name() : p.text;
  }

  forHeader(d) {
    const init = this.choose([
      [1, () => ''],
      [2, () => `${this.pick(['int', 'long', this.pick(TYPES)])} ${this.declarators(d, 2)}`],
      [2, () => Array.from({ length: 1 + this.int(2) }, () => this.statementExpression(d)).join(', ')],
    ]);
    const cond = this.chance(0.8) ? this.expr(d) : '';
    const update = this.chance(0.8) ? Array.from({ length: 1 + this.int(2) }, () => this.statementExpression(d)).join(', ') : '';
    return `(${init}; ${cond}; ${update})`;
  }

  /**
   * A statement that may be the body of if/while/for; never a declaration. With
   * `noShortIf` its text will be followed by `else`, where CUP wants a
   * `statement_no_short_if`: no labeled statement may end it.
   */
  statement(d, ind, { labelled = false, noShortIf = false } = {}) {
    const sub = (beforeElse = false) => this.statement(d - 1, ind, { noShortIf: noShortIf || beforeElse });
    const deeper = d > 0 ? 1 : 0;
    return this.choose([
      [6, () => `${this.statementExpression(Math.min(d, 2))};`],
      [1, () => `${this.channel(1)}.read(${this.block(Math.max(0, d - 1), ind)});`],
      [2, () => `${this.channel(1)}.write(${this.expr(Math.min(d, 2))});`],
      [1, () => `(${this.name()}).write(${this.expr(Math.min(d, 2))});`],
      [1, () => `${this.channel(1)}.sync();`],
      [1, () => `${this.channel(1)}.timeout(${this.expr(Math.min(d, 2))});`],
      [deeper * 3, () => `if (${this.expr(1)}) ${sub()}`],
      [deeper * 3, () => `if (${this.expr(1)}) ${sub(true)} else ${sub()}`],
      // Dangling else: the else belongs to the inner if.
      [deeper * 2, () => `if (${this.expr(1)}) if (${this.expr(1)}) ${sub(true)} else ${sub()}`],
      [deeper * 2, () => `while (${this.expr(1)}) ${sub()}`],
      [deeper * 2, () => `do ${this.statement(d - 1, ind)} while (${this.expr(1)});`],
      [deeper * 2, () => `for ${this.forHeader(1)} ${sub()}`],
      [deeper, () => `par for ${this.forHeader(1)}${this.chance(0.4) ? ` enroll (${this.args(1, 1)})` : ''} ${sub()}`],
      [deeper * 3, () => this.block(d - 1, ind)],
      [deeper, () => `seq ${this.block(d - 1, ind)}`],
      [deeper * 2, () => `par ${this.block(d - 1, ind)}`],
      [deeper, () => `par enroll ${this.chance(0.3) ? `(${this.name()})` : this.args(1, 1)} ${this.block(d - 1, ind)}`],
      [deeper, () => `par enroll (${this.name()}).${this.name()}, ${this.name()} ${this.block(d - 1, ind)}`],
      [deeper * 2, () => this.switchStatement(d - 1, ind)],
      [deeper * 3, () => this.alt(d - 1, ind)],
      [deeper, () => `claim (${Array.from({ length: 1 + this.int(2) }, () => this.claimed()).join(', ')}) ${sub()}`],
      [noShortIf ? 0 : deeper, () => {
        const label = `L${this.int(3)}`;
        this.labels.push(label);
        const s = `${label}: ${this.statement(d - 1, ind, { labelled: true })}`;
        this.labels.pop();
        return s;
      }],
      [1, () => (this.chance(0.5) ? 'return;' : `return ${this.expr(Math.min(d, 2))};`)],
      [1, () => `break${this.labels.length && this.chance(0.5) ? ` ${this.pick(this.labels)}` : ''};`],
      [1, () => `continue${this.labels.length && this.chance(0.5) ? ` ${this.pick(this.labels)}` : ''};`],
      [1, () => this.pick(['skip;', 'stop;', 'suspend;'])],
      // `L: ;` crashes the compiler (the label is set on a null statement).
      [labelled ? 0 : 1, () => ';'],
    ]);
  }

  claimed() {
    return this.choose([
      [3, () => this.name()],
      [2, () => `${this.chance(0.5) ? this.name() : `${this.name()}.${this.name()}`}.${this.pick(['read', 'write'])}`],
      [1, () => `${this.chanType(false)} ${this.name()} = ${this.pick([`${this.name()}.${this.name()}`, `${this.name()}()`, `${this.name()}[0]`, '(c)'])}`],
    ]);
  }

  switchStatement(d, ind) {
    const inner = `${ind}    `;
    const groups = Array.from({ length: this.int(4) }, () => {
      const labels = Array.from({ length: 1 + this.int(2) }, () => (this.chance(0.2) ? 'default:' : `case ${this.expr(1)}:`)).join(' ');
      const stmts = Array.from({ length: 1 + this.int(2) }, () => this.blockStatement(d, `${inner}    `)).join(' ');
      return `${inner}${labels} ${stmts}\n`;
    }).join('');
    return `switch (${this.expr(1)}) {\n${groups}${ind}}`;
  }

  guard(d) {
    return this.choose([
      [4, () => `${this.lhs(0)} = ${this.channel(1)}.read(${this.chance(0.15) ? this.block(0) : ''})`],
      [1, () => 'skip'],
      [1, () => `${this.channel(1)}.timeout(${this.expr(Math.min(d, 1))})`],
      [1, () => `(${this.name()}).timeout(${this.expr(Math.min(d, 1))})`],
    ]);
  }

  alt(d, ind) {
    const inner = `${ind}    `;
    const replicated = this.chance(0.2) ? ` ${this.forHeader(1)}` : '';
    const cases = Array.from({ length: 1 + this.int(3) }, () => {
      if (d > 0 && this.chance(0.1)) return `${inner}${this.alt(d - 1, inner)}\n`;
      const pre = this.chance(0.3) ? `(${this.expr(1)}) && ` : '';
      return `${inner}${pre}${this.guard(d)} : ${this.statement(Math.max(0, d - 1), inner)}\n`;
    }).join('');
    return `${this.chance(0.3) ? 'pri ' : ''}alt${replicated} {\n${cases}${ind}}`;
  }

  // Declarations -------------------------------------------------------------

  modifiers() {
    return Array.from({ length: this.int(3) }, () => this.pick(['public', 'private', 'protected', 'native', 'mobile', 'const'])).map((m) => `${m} `).join('');
  }

  annotations() {
    if (!this.chance(0.3)) return '';
    const n = 1 + this.int(2);
    return ` [${Array.from({ length: n }, () => `${this.pick(['yield', 'k', 'level'])}=${this.pick(['true', 'false', 'x', '1', '2L', '1.5', '2.5f'])}`).join(', ')}]`;
  }

  members() {
    return Array.from({ length: this.int(3) }, () => `${this.type()} ${Array.from({ length: 1 + this.int(2) }, () => `${this.name()}${this.chance(0.2) ? '[]' : ''}`).join(', ')};`).join(' ');
  }

  extendsList() {
    return this.chance(0.4) ? ` extends ${Array.from({ length: 1 + this.int(2), }, () => this.typeName()).join(', ')}` : '';
  }

  procedure(k, depth) {
    const params = Array.from({ length: this.int(4) }, () => `${this.chance(0.15) ? 'const ' : ''}${this.type()} ${this.name()}${this.chance(0.1) ? '[]' : ''}`).join(', ');
    const ret = this.chance(0.7) ? 'void' : this.type();
    const impl = this.chance(0.15) ? ` implements ${this.pick(['f', 'lib::g', 'std.lib::h'])}` : '';
    const body = this.chance(0.05) ? ';' : ` ${this.block(depth)}`;
    return `${this.modifiers()}${ret} case${k}(${params})${this.annotations()}${impl}${body}`;
  }

  declaration(k, depth) {
    return this.choose([
      [12, () => this.procedure(k, depth)],
      [2, () => `${this.modifiers()}record R${k}${this.extendsList()}${this.annotations()} { ${this.members()} }`],
      [1, () => `${this.modifiers()}protocol P${k}${this.extendsList()}${this.annotations()};`],
      [2, () => {
        const cases = Array.from({ length: 1 + this.int(3) }, (_, j) => `t${j}: { ${this.members()} }`).join(' ');
        return `${this.modifiers()}protocol P${k}${this.extendsList()}${this.annotations()} { ${cases} }`;
      }],
      [2, () => `${this.modifiers()}${this.type()} ${this.declarators(1)};`],
      [1, () => `extern ${this.pick(['java.lang.Object', 'Thing', 'a.b'])} ext${k}`],
    ]);
  }

  /** A batch file: an optional header, then `count` top-level cases. */
  program(count, depth) {
    const head = [];
    if (this.chance(0.2)) head.push(this.pick(['#pragma FILE "gen";', '#pragma LANGUAGE "JAVA";', '#pragma file "gen";']));
    if (this.chance(0.2)) head.push(`package ${this.pick(['gen', 'a.b'])};`);
    for (let k = this.int(3); k > 0; k--) head.push(`import ${this.pick(['std.io', 'std.*', 'lib', 'a.b.c', 'a.*'])};`);
    const cases = Array.from({ length: count }, (_, k) => this.declaration(k, depth));
    return { head: head.join('\n'), cases };
  }
}

/**
 * Near misses: small edits of generated programs (drop, repeat, swap, insert or
 * replace one token), plus spellings at the edges of the grammar. Each is
 * checked on its own, so the question is only whether both sides agree.
 */
const EDGE_CASES = [
  'void f(chan<chan<int>> c) { }',
  'void f(chan<chan<int> > c) { }',
  'void f(timer t) { int x; x = t.timeout(5); }',
  'void f(barrier b) { int x; x = b.sync(); }',
  'void f(chan<int>.write c) { g(c.write(1)); }',
  'void f(chan<int>.write c) { c.write(1).x = 2; }',
  'void f(chan<int>.write c) { (c).write(1); }',
  'void f(timer t) { (t).timeout(5); }',
  'void f(timer t) { alt { (t).timeout(5) : skip; } }',
  'void f(timer t) { alt { (true) && (t).timeout(5) : skip; } }',
  'void f(chan<int[]>.read c) { int x; x = c.read()[0]; }',
  'void f(chan<int[]>.read c) { int x; x = (c.read())[0]; }',
  'void f() { int x; x = c.read[0]; }',
  'void f() { int x; x = lib::b[0]; }',
  'void f() { int x; x = (lib::b)[0]; }',
  'void f() { int x; x = new int[] { 1 }[0]; }',
  'void f() { int x; x = new int[3][0]; }',
  'void f() { int x; x = new mobile(g)[0]; }',
  'void f() { int x; x = "abc"[0]; }',
  'void f() { fork(); }',
  'void f() { fork(g); }',
  'void f() { int x; x = ((a)) x; }',
  'void f() { int x; x = (((a))) x; }',
  'void f() { int x; x = ((a)) - x; }',
  'void f() { int x; x = (a.b) x; }',
  'void f() { int x; x = (a) ++x; }',
  'void f() { int x; x = (a)++ - x; }',
  'void f() { int x; x = (int) +x; }',
  'void f() { int x; x = (a) +x; }',
  'void f() { int x; if (true) L: x = 1; else x = 2; }',
  'void f() { int x; if (true) while (x > 0) L: x = 1; else x = 2; }',
  'void f() { int x; if (true) { L: x = 1; } else x = 2; }',
  'void f() { L: ; }',
  'void f() { L: M: while (true) { break L; } }',
  'void f() { lib::T[] x; }',
  'void f() { a.lib::T[] x; }',
  'void f(lib::T[] x) { }',
  'void f() { int x = 0xFFFFFFFF; }',
  'void f() { int x = 2147483648; }',
  'void f() { int x = -2147483648; }',
  'void f() { long x = 9223372036854775808L; }',
  'void f() { int x = 037777777777; }',
  'void f() { int x = 040000000000; }',
  "void f() { char c = '\\u00AB'; }",
  'void f(shared chan<int>.write c) { claim (chan<int>.write w = c) { w.write(1); } }',
  'void f(shared chan<int>.write c) { claim (chan<int>.write w = (c)) { w.write(1); } }',
  'void f(shared chan<int>.write c) { claim (c[0]) { skip; } }',
  'void f(shared chan<int>.write c) { claim (a.b) { skip; } }',
  'void f(shared chan<int>.write c) { claim (a.b.write) { skip; } }',
  'void f(shared chan<int>.write c) { claim ((c)) { skip; } }',
  'void f(shared chan<int>.write c) { claim (g()) { skip; } }',
  'void f(barrier b) { par enroll (b).x { skip; } }',
  'void f(barrier b, barrier c) { par enroll (b), c { skip; } }',
  'void f(barrier b, barrier c) { par enroll (b, c) { skip; } }',
  'void f(barrier b) { par enroll b { skip; } }',
  'void f() { par for (int i = 0; i < 2; i++) enroll () { skip; } }',
  'void f() { for (int i = 0; i < 2; i++) enroll (b) { skip; } }',
  'void f() { alt { } }',
  'void f() { switch (1) { } }',
  'void f() { switch (1) { case 1: } }',
  'void f() { switch (1) { default: default: skip; } }',
  'void f() { int x; x = y = z; }',
  'void f() { int x; x = a ? b : c = d; }',
  'void f() { int x; x = a ? b = 1 : c; }',
  'void f() { int x; (x) = 1; }',
  'void f() { int x; x++ ++; }',
  'void f() { int x; ++x++; }',
  'void f() { int x; x = a is T is U; }',
  'void f() { int x; x = a is T.b; }',
  'void f() { int x; x = a is lib::T < b; }',
  'void f() { int x; x = a < b < c; }',
  'void f() { int x; x = - -x; }',
  'void f() { int x; x = --x; }',
  'void f() { int x; x = -+-+x; }',
  'void f() { int x; x = ~!~x; }',
  'void f() { int x; x = a.b.c.d(e).f[g].h; }',
  'void f() { int x; x = a.b::c; }',
  'void f() { int x; x = a.b::c(); }',
  'void f() { int x; x = (a)::c; }',
  'void f() { int x; x = g()::c; }',
  'void f() { int x; x = new R { }; }',
  'void f() { int x; x = new R { a = 1, }; }',
  'void f() { int x; x = new P { t: }; }',
  'void f() { int x; x = new P { t: a = 1 }; }',
  'void f() { int x; x = new lib::R { a = 1 }; }',
  'void f() { int x; x = new lib::R[2]; }',
  'void f() { int[] x = { }; }',
  'void f() { int[] x = { 1, }; }',
  'void f() { int[] x = { { 1 }, { } }; }',
  'void f() { int[] x; x = { 1 }; }',
  'void f() { int x[] = new int[2]; }',
  'void f() { int[] x = new int[]; }',
  'void f() { int[] x = new int[2] { 1, 2 }; }',
  'void f() { int[] x = new int[][2]; }',
  'void f() { chan<int> c; c.read; }',
  'void f() { chan<int> c; c.read(); }',
  'void f() { chan<int> c; c.read({ }); }',
  'void f() { chan<int> c; c.read({ c.write(1); }); }',
  'void f() { chan<int> c; c.write; }',
  'void f() { chan<int> c; c.write(); }',
  'void f() { chan<int> c; int x; x = c.read() + c.read(); }',
  'void f() { chan<int> c; int x; alt { x = c.read() : skip; } }',
  'void f() { chan<int> c; int x; alt { x = (c.read()) : skip; } }',
  'void f() { chan<int> c; int x; alt { x += c.read() : skip; } }',
  'void f() { chan<int> c; int x; alt { c.read() : skip; } }',
  'void f() { chan<int> c; int x; alt { skip : int y = 1; } }',
  'void f() { chan<int> c; int x; alt { skip : ; } }',
  'void f() { chan<int> c; int x; alt { (x > 0) && skip : skip; } }',
  'void f() { chan<int> c; int x; alt { x > 0 && skip : skip; } }',
  'void f() { chan<int> c; int x; alt { alt { skip : skip; } } }',
  'void f() { chan<int> c; int x; pri alt { pri alt { skip : skip; } } }',
  'void f() { chan<int> c; int x; alt (int i = 0; i < 2; i++) { skip : skip; } }',
  'void f() { chan<int> c; int x; alt (;;) { skip : skip; } }',
  'void f() { int x; do x++; while (x < 2); }',
  'void f() { int x; do ; while (x < 2); }',
  'void f() { int x; while (x < 2) ; }',
  'void f() { int x; for (;;) ; }',
  'void f() { int x; for (x = 0, y = 1; ; x++, y--) { } }',
  'void f() { int x; for (int i = 0, j = 1; ; ) { } }',
  'void f() { int x; for (1; ; ) { } }',
  'void f() { int x; for (c.write(1); ; ) { } }',
  'void f() { int x; for (; ; c.read()) { } }',
  'void f() { int x; if (x) ; else ; }',
  'void f() { int x; if (x) stop; else stop; }',
  'void f() { int x; seq { } }',
  'void f() { int x; seq x = 1; }',
  'void f() { int x; L: int y = 1; }',
  'void f() { int x; if (x) int y = 1; }',
  'void f() { int x; return x = 1; }',
  'void f() { int x; break L; continue M; }',
  'void f() { suspend; }',
  'void f() { resume; }',
  'void f() { stop; skip; }',
  'proc void f() { }',
  'void f() { } ;',
  'void f();',
  'void f() [yield=true] { }',
  'void f() [yield=true, x=1, yield=false] { }',
  'void f() [yield="true"] { }',
  'void f() [yield=-1] { }',
  'void f() implements g, lib::h, a.b::k { }',
  'void f() [yield=true] implements g { }',
  'void f() implements g [yield=true] { }',
  'void[] f() { }',
  'int[] f() { }',
  'void f(int x[], int[] y[]) { }',
  'void f(const int x) { }',
  'void f(const mobile int x) { }',
  'void f(shared read chan<int> c) { }',
  'void f(shared read chan<int>.read c) { }',
  'void f(shared chan<int>.read c) { }',
  'void f(chan<int>.read[] c) { }',
  'void f(chan<int[]>[] c) { }',
  'record R { }',
  'record R { int x, y[]; chan<int> c; }',
  'record R extends A, lib::B [k=1] { int x; }',
  'record R [k=1] extends A { int x; }',
  'protocol P;',
  'protocol P extends Q;',
  'protocol P { }',
  'protocol P { t: }',
  'protocol P { t: { } u: { int x; } }',
  'const int X = 1, Y = 2;',
  'public const int X;',
  'int X[] = { 1 };',
  'void X;',
  'mobile void f() { }',
  'native void f();',
  'extern a.b.C x',
  'extern a.b.C x;',
  'public extern C x',
  'import a;\nvoid f() { }',
  'import a.*;\nvoid f() { }',
  'import *;\nvoid f() { }',
  'import a.b.*.c;\nvoid f() { }',
  'package a.b;\nvoid f() { }',
  'package a.b;\npackage c;\nvoid f() { }',
  '#pragma FILE "x";\nvoid f() { }',
  '#pragma FILE;\nvoid f() { }',
  '# pragma FILE "x";\nvoid f() { }',
  'void f() { }\n#pragma FILE "x";',
  'void f() { string s = "a\\tb"; }',
  "void f() { char c = 'ab'; }",
  "void f() { char c = ''; }",
  'void f() { int x = 1_000; }',
  'void f() { double d = 1e; }',
  'void f() { double d = 1.e5; }',
  'void f() { double d = 1.2.3; }',
  'void f() { int x = 09; }',
  'void f() { int x = 0x; }',
  'void f() { int x = 0x123456789; }',
  'void f() { long x = 0x123456789L; }',
  'void f() { /**/ }',
  'void f() { /* x */ }',
  'void f() { int $x_1 = 1; }',
  'void f() { int x; x = a.read.write; }',
  'void f() { int x; x = a.write.read(); }',
  'void f() { int x; x = c.read().x; }',
  'void f() { int x; x = new int[3].length; }',
  'void f() { int x; x = new R { a = 1 }.a; }',
  'void f() { int x; x = new R { a = 1 }[0]; }',
  'void f() { int x; x = g().h()[0].k; }',
  'void f() { int x; x = (int[]) y; }',
  'void f() { int x; x = (void) y; }',
  'void f() { int x; x = (chan<int>) y; }',
  'void f() { int x; x = (string) y; }',
  'void f() { int x; x = (lib::T) y; }',
  'void f() { int x; x = (a.lib::T) y; }',
  'void f() { int x; x = (T) (y); }',
  'void f() { int x; x = (T) -y; }',
  'void f() { int x; x = (T) !y; }',
  'void f() { int x; x = (T) "s"; }',
  'void f() { int x; x = (T) new int[1]; }',
  'void f() { int x; x = (T) fork(g); }',
  'void f() { int x; x = (T) null; }',
  'void f() { int x; x = (T) (U) y; }',
  'void f() { int x; x = (int) (T) y; }',
  'void f() { int x; x = (T) y++; }',
  'void f() { int x; x = (T) ++y; }',
  'void f() { int x; x = a ? b : c ? d : e; }',
  'void f() { int x; x = a ? b ? c : d : e; }',
  'void f() { int x; x = (a ? b : c) ? d : e; }',
  'void f() { int x; x = a || b ? c : d; }',
  'void f() { int x; x = a = b ? c : d; }',
  'void f() { int x; x >>>= 1; x <<= 2; x ^= 3; x |= 4; x &= 5; x %= 6; }',
  'void f() { int x; x = a >>> b >> c << d; }',
  'void f() { int x; x = a & b ^ c | d && e || f; }',
  'void f() { int x; x = a == b != c; }',
  'void f() { int x; x = a <= b >= c; }',
  'void f() { int x; x = a * b / c % d; }',
  'void f() { int x; x = a - b + c - d; }',
  'void f() { int x; x = y++.z; }',
  'void f() { int x; x = y++[0]; }',
  'void f() { int x; x = y++::z; }',
  'void f() { int x; x = (y++).z; }',
  'void f() { int x; x = y++ ++; }',
  'void f() { int x; x = y++++; }',
  'void f() { int x; x = y----; }',
  'void f() { int x; x = y++.read(); }',
  'void f() { int x; x = a is T * b; }',
  'void f() { int x; x = a is T == b; }',
  'void f() { int x; x = a is T && b is U; }',
  'void f() { int x; x = a + b is T; }',
  'void f() { int x; x = a is T ? b : c; }',
  'void f() { int x; x = a is T = b; }',
  'void f() { int x; x = (a is T) * b; }',
  'void f(timer t) { alt { (t)[0].timeout(5) : skip; } }',
  'void f(timer t) { alt { (t).x.timeout(5) : skip; } }',
  'void f(timer t) { alt { (x > 0) v = c.read() : skip; } }',
  'void f(timer t) { alt { (x > 0) && (t).timeout(5) : skip; } }',
  'void f() { int x; while (x) L: x = 1; }',
  'void f() { int x; if (x) L: x = 1; }',
  'void f() { int x; if (x) x = 1; else L: x = 2; }',
  'void f() { int x; if (x) if (y) x = 1; else L: x = 2; else x = 3; }',
  'void f() { int x; if (x) do L: x = 1; while (x); else x = 3; }',
  'void f() { int x; if (x) for (;;) L: x = 1; else x = 3; }',
  'void f() { int x; if (x) claim (c) L: x = 1; else x = 3; }',
  'void f() { L: }',
  'void f() { L: M: ; }',
  'void f() { L: { } }',
  '',
  '// nothing but a comment',
  'void f() { int x; x = (lib::T) y; x = (std.lib::T) y; x = ((std.lib::T)) y; }',
  'void f() { int x; x = ((int)) y; }',
  'void f() { int x; x = ((a)) (y); }',
  'void f() { int x; x = ((a)) -y; }',
  'void f() { fork(g, h); }',
  'void f() { int x; x = fork(g).y; }',
  'void f(shared chan<int>.write c) { claim (c, d.write, e.f.read) { skip; } }',
  'void f(shared chan<int>.write c) { claim (lib::c) { skip; } }',
  'void f(shared chan<int>.write c) { claim (chan<int>.write w = a.b, shared chan<int>.read r = g()) { skip; } }',
  'void f(shared chan<int>.write c) { claim (chan<int>.write w = c.write) { skip; } }',
  'void f(shared chan<int>.write c) { claim (chan<int>.write w = c[0]) { skip; } }',
  'void f(shared chan<int>.write c) { claim (chan<int>.write w = new R { a = 1 }) { skip; } }',
  'void f(barrier b) { par enroll (b) + c { skip; } }',
  'void f(barrier b) { par enroll (b)[0] { skip; } }',
  'void f() { int x = 2147483647; long y = 9223372036854775807L; int z = 0x7fffffff; int o = 017777777777; }',
  'void f() [k=99999999999] { }',
  'void f() { chan<chan<chan<int> > > c; }',
  'void f() { chan<chan<chan<int>>> c; }',
  'void f() { chan<chan<int> >[] c; }',
  'void f() { chan<chan<int>.read> c; }',
  'void f() { chan<int[]>[] c; }',
  'void f() { int x; x = c.write.read; }',
  'void f() { int x; x = a >> b > c; }',
  'void f() { int x; x = a >>= b; }',
  'void f() { string s = "a // b /* c */"; char c = \'/\'; char d = \'"\'; }',
  'void f() { int x; x = a / /* c */ b; x = a/ /b; }',
  'void f() { int pragma = 1; int $a = 2, _b = 3, c$4 = 5; }',
  'void f() { int with = 1; }',
  'void f() { float a = 1.f, b = 1E-5f, c = .5F; double d = 1.e5, e = 1e+10, g = 2D; }',
  'void f() { double d = 0x1.8p1; }',
  'void f() { int x; x = a--b; }',
  'void f() { int x; x = a- -b; }',
];

/** Edge cases where the two sides disagree for a reason outside our parser. */
const COMPILER_QUIRKS = new Map([
  ["void f() { char c = '\\u00AB'; }", "the compiler's PrimitiveLiteral.parseChar reads only lower-case hex digits, so it decodes '\\u00AB' as -373 (and emits that value)"],
]);

/** One random near miss of `text`: a single token dropped, repeated, swapped, inserted or replaced. */
function nearMiss(gen, text) {
  const lines = text.split('\n');
  const starts = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const tokens = tokenize(text).tokens.map((t) => ({ text: t.text, at: starts[t.line] + t.col }));
  if (tokens.length === 0) return text;
  const k = gen.int(tokens.length);
  const t = tokens[k];
  const pool = [';', ',', '(', ')', '{', '}', '[', ']', '.', ':', '::', '=', '+', '-', '!', '?', '&&', 'else', 'int', 'x', '1', 'read', 'write', 'new', 'skip', 'alt', 'par', 'case', 'chan', '<', '>', '>>'];
  const at = (start, end, replacement) => text.slice(0, start) + replacement + text.slice(end);
  return gen.choose([
    [3, () => at(t.at, t.at + t.text.length, '')],
    [1, () => at(t.at, t.at, `${t.text} `)],
    [2, () => {
      const u = tokens[Math.min(k + 1, tokens.length - 1)];
      return u === t ? text : text.slice(0, t.at) + u.text + text.slice(t.at + t.text.length, u.at) + t.text + text.slice(u.at + u.text.length);
    }],
    [2, () => at(t.at, t.at, `${gen.pick(pool)} `)],
    [2, () => at(t.at, t.at + t.text.length, gen.pick(pool))],
  ]);
}

/** Fuzz driver: valid batches first, then single-file near misses and edge cases. */
async function fuzz(install, root, jobs, option) {
  const total = Number(option('fuzz', 2000)) || 2000;
  const seed = Number(option('seed', 1)) || 1;
  const perFile = Number(option('batch', 25)) || 25;
  const nearMisses = Number(option('near-miss', Math.round(total / 4)));
  const keep = option('keep', false);
  const depth = Number(option('depth', 3)) || 3;
  const store = (name, text) => {
    if (typeof keep === 'string') {
      fs.mkdirSync(keep, { recursive: true });
      fs.writeFileSync(path.join(keep, name), text);
    }
  };

  // Generated programs, many cases per file. A case we reject is checked on its
  // own; if the compiler rejects a batch, its cases are checked one by one.
  const batches = [];
  for (let b = 0; b * perFile < total; b++) {
    const gen = new Generator(seed * 100003 + b);
    const { head, cases } = gen.program(Math.min(perFile, total - b * perFile), depth);
    batches.push({ name: `Fuzz${seed}_${b}.pj`, head, cases });
  }
  const tasks = [];
  for (const batch of batches) {
    const alone = (c, k) => () => compare(install, root, batch.name.replace('.pj', `_${k}.pj`), `${batch.head}\n${c}\n`);
    const accepted = [];
    batch.cases.forEach((c, k) => {
      if (oursFor(`${batch.head}\n${c}\n`).problems.length === 0) accepted.push(c);
      else tasks.push(alone(c, k));
    });
    const text = `${batch.head}\n${accepted.join('\n\n')}\n`;
    store(batch.name, text);
    tasks.push(async () => {
      const r = await compare(install, root, batch.name, text);
      return r.verdict === 'compiler-only' ? pool(accepted.map(alone), 1) : [r];
    });
  }
  const checked = (await pool(tasks, jobs)).flat();
  const caseCount = batches.reduce((n, b) => n + b.cases.length, 0);

  // Near misses and edge cases, one per file.
  const misses = [];
  for (let k = 0; k < nearMisses; k++) {
    const gen = new Generator(seed * 7919 + k);
    const base = gen.program(1, 2);
    misses.push({ name: `Near${seed}_${k}.pj`, text: nearMiss(gen, `${base.head}\n${base.cases[0]}\n`) });
  }
  EDGE_CASES.forEach((text, k) => misses.push({ name: `Edge${k}.pj`, text: `${text}\n` }));
  for (const m of misses) store(m.name, m.text);
  const missed = await pool(misses.map((m) => () => compare(install, root, m.name, m.text)), jobs);
  const quirks = missed.filter((r) => COMPILER_QUIRKS.has(r.text.trim()));
  const missResults = missed.filter((r) => !quirks.includes(r));

  for (const r of [...checked, ...missResults]) {
    const lines = describe(r, false);
    if (lines.length) console.log([...lines, `    source: ${clip(r.text.replace(/\s+/g, ' ').trim(), 600)}`].join('\n'));
  }
  for (const r of quirks) if (r.verdict !== 'agree') console.log(`${r.name}: known compiler quirk: ${COMPILER_QUIRKS.get(r.text.trim())}`);
  // Where both sides stop on a rejected near miss. We report a missing token
  // right after the previous one, so our line can be one earlier; a later line
  // could hide a construct we wrongly accept, so those are listed with --show.
  const stops = missResults.filter((r) => r.compilerLine !== undefined);
  const later = stops.filter((r) => r.ourLine > r.compilerLine);
  if (option('show', false)) for (const r of later) console.log(`${r.name}: we stop at line ${r.ourLine}, the compiler at ${r.compilerLine}\n    source: ${clip(r.text.replace(/\s+/g, ' ').trim(), 600)}`);
  const t = tally(checked);
  const m = tally(missResults);
  console.log(`generated programs (seed ${seed}): ${caseCount} declarations in ${batches.length} batch files; ${summary(t)}`);
  console.log(`near misses and edge cases: ${summary(m)}`);
  console.log(`  first error of a rejected near miss: same line ${stops.filter((r) => r.ourLine === r.compilerLine).length}, earlier here ${stops.filter((r) => r.ourLine < r.compilerLine).length}, later here ${later.length}`);
  return t.differ + t.oursOnly + t.compilerOnly + m.differ + m.oursOnly + m.compilerOnly > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

function collect(target, out) {
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target).sort()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      collect(path.join(target, entry), out);
    }
  } else if (target.endsWith('.pj')) out.push(target);
  return out;
}

function tally(results) {
  const count = (v) => results.filter((r) => r.verdict === v).length;
  const items = results.reduce((n, r) => n + r.items, 0);
  const agreed = results.reduce((n, r) => n + r.agreed, 0);
  return { files: results.length, agree: count('agree'), differ: count('differ'), oursOnly: count('ours-only'), compilerOnly: count('compiler-only'), bothReject: count('both-reject'), items, agreed };
}

function summary(t) {
  return `${t.files} files: ${t.agree} agree, ${t.differ} with tree differences, ${t.oursOnly} rejected only by us, ${t.compilerOnly} rejected only by the compiler, ${t.bothReject} rejected by both; ${t.agreed}/${t.items} items identical`;
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (!hit) return fallback;
    return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
  };
  const jobs = Number(option('jobs', Math.max(1, Math.min(8, os.cpus().length - 2))));
  const found = findInstall();
  if ('error' in found) {
    console.error(found.error);
    process.exit(2);
  }
  const root = makeHome(found);
  try {
    if (option('fuzz', false)) {
      process.exitCode = await fuzz(found, root, jobs, option);
      return;
    }
    const targets = args.filter((a) => !a.startsWith('--'));
    if (targets.length === 0) {
      console.error('Usage: node scripts/parse-diff.js [--jobs=N] [--show] <file-or-directory>...');
      process.exit(2);
    }
    const files = targets.flatMap((t) => collect(path.resolve(t), []));
    const results = await pool(
      files.map((file) => () => compare(found, root, path.basename(file), fs.readFileSync(file, 'utf8')).then((r) => ({ ...r, name: path.relative(process.cwd(), file) }))),
      jobs,
    );
    for (const r of results) for (const line of describe(r, option('show', false))) console.log(line);
    const t = tally(results);
    console.log(summary(t));
    process.exitCode = t.differ + t.oursOnly + t.compilerOnly > 0 ? 1 : 0;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

module.exports = { oursFor, compilerFor, dumpLines, sx, firstDifference, compare, makeHome, runCompiler, pool, Generator, nearMiss, EDGE_CASES };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
