/**
 * The files a CSPm model includes, confined to the project. FDR reads
 * `include "file"` relative to the including file, with the permissions of
 * whoever runs it, and recursively: a .csp file or a /*@csp block of a
 * ProcessJ file could otherwise make it read any file on the machine (or, in
 * a hosted worker, other jobs' files).
 *
 * Every include is resolved here before FDR runs, the included files'
 * includes too: a relative one must stay inside the workspace roots, also
 * once symbolic links are resolved; an absolute one is kept as written for a
 * local editor (the user named that file) unless it reaches into the
 * workspace through a link out of it, and is refused in the browser, whose
 * runner only has the project's files. Any refused include means FDR is not
 * run, with a diagnostic saying which and why.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { lex } from '../cspm/lexer';
import { isBrowserMode } from '../mode';
import type { Span } from '../parser/ast';

export interface IncludePolicy {
  /** Directories an include may resolve within (the workspace roots, absolute). */
  roots: readonly string[];
  /** Keep an absolute include outside the roots as written (a local editor) instead of refusing it (the browser). */
  allowAbsolute: boolean;
}

/** The policy for a model whose relative includes start at `base`: the workspace roots, else that directory. */
export function includePolicy(roots: readonly string[] | undefined, base: string | undefined): IncludePolicy {
  const confined = roots?.length ? roots : base ? [base] : [];
  return { roots: confined.map((root) => path.resolve(root)), allowAbsolute: !isBrowserMode() };
}

export interface IncludedFile {
  /** Absolute path, as FDR is given it. */
  path: string;
  /** Relative to the model's directory, `/`-separated (what the browser sends the runner beside the model). */
  relative: string;
  text: string;
}

export interface IncludeProblem {
  /** The include as written. */
  include: string;
  message: string;
  /** The include in the model's text that is refused, or that leads to the file whose include is. */
  span: Span;
  /** The included file whose own include is refused (absolute). */
  file?: string;
}

export interface PreparedModel {
  /** The model FDR runs: with `rewrite`, each relative include of the model itself made absolute. */
  text: string;
  /** Every file included inside the roots, transitively, in the order found. */
  files: IncludedFile[];
  problems: IncludeProblem[];
}

/** More included files than any model needs: a cycle or an include bomb. */
const MAX_INCLUDED_FILES = 64;
const MAX_INCLUDED_BYTES = 4_000_000;

/** An `include "file"` of a text. */
export interface FoundInclude {
  include: string;
  /** Offset and length of the string literal in the text. */
  offset: number;
  length: number;
  span: Span;
}

/**
 * Check the includes of `text` (a model whose relative includes start at
 * `base`) and of every file they include. With `rewrite` (a copy FDR runs in
 * another directory) the model's own relative includes become absolute.
 */
export function prepareIncludes(text: string, base: string | undefined, policy: IncludePolicy, rewrite = !isBrowserMode()): PreparedModel {
  const roots = policy.roots.map((root) => path.resolve(root));
  const realRoots = roots.map((root) => {
    try {
      return fs.realpathSync(root);
    } catch {
      return root;
    }
  });
  const files: IncludedFile[] = [];
  const problems: IncludeProblem[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  const edits: Array<{ offset: number; length: number; text: string }> = [];

  /** One include found in `from` (undefined: the model), reached through the model's include at `at`. */
  const visit = (found: FoundInclude, dir: string | undefined, from: string | undefined, at: Span): void => {
    const refuse = (why: string): void => {
      problems.push({ include: found.include, message: `include "${found.include}"${from ? ` in ${path.basename(from)}` : ''} is refused: ${why}`, span: at, ...(from ? { file: from } : {}) });
    };
    const absolute = path.isAbsolute(found.include);
    if (/[\u0000-\u001f"]/.test(found.include)) return refuse('its name has a quote or a control character');
    if (absolute && !policy.allowAbsolute) return refuse('an include must name a file of the project, relative to the including file');
    if (!absolute && dir === undefined) return refuse('the file is not saved, so there is no directory to find it in');
    const lexical = path.resolve(dir ?? '/', found.include);
    if (!roots.some((root) => within(lexical, root))) {
      // A local editor's absolute include outside the workspace: the user named that very file.
      if (absolute) return;
      return refuse('it is outside the workspace');
    }
    let real: string | undefined;
    try {
      real = fs.realpathSync(lexical);
    } catch {
      real = undefined;
    }
    if (real === undefined) {
      // Missing: FDR says so. A link whose target cannot be checked is refused.
      if (isLink(lexical)) return refuse('it is a symbolic link that cannot be followed');
      if (rewrite && !from && !absolute) edits.push({ offset: found.offset, length: found.length, text: `"${toPosix(lexical)}"` });
      return;
    }
    if (!realRoots.some((root) => within(real!, root))) return refuse('it is a symbolic link to a file outside the workspace');
    if (!isFile(real)) return refuse('it is not a regular file');
    if (rewrite && !from && !absolute) edits.push({ offset: found.offset, length: found.length, text: `"${toPosix(lexical)}"` });
    if (seen.has(real)) return;
    seen.add(real);
    if (files.length >= MAX_INCLUDED_FILES) return refuse(`the model includes more than ${MAX_INCLUDED_FILES} files`);
    let included: string;
    try {
      included = fs.readFileSync(lexical, 'utf8');
    } catch (error) {
      return refuse(`it cannot be read (${error instanceof Error ? error.message : String(error)})`);
    }
    bytes += included.length;
    if (bytes > MAX_INCLUDED_BYTES) return refuse(`the included files hold more than ${MAX_INCLUDED_BYTES} characters`);
    files.push({ path: lexical, relative: toPosix(base ? path.relative(base, lexical) : lexical), text: included });
    // FDR resolves the file's own includes next to it, as it is named.
    for (const inner of includesIn(included)) visit(inner, path.dirname(lexical), lexical, at);
  };

  for (const found of includesIn(text)) visit(found, base, undefined, found.span);
  let out = text;
  for (const edit of edits.sort((a, b) => b.offset - a.offset)) out = out.slice(0, edit.offset) + edit.text + out.slice(edit.offset + edit.length);
  return { text: out, files, problems };
}

/** One sentence for a model FDR is not run on. */
export function includeProblemsText(problems: readonly IncludeProblem[]): string {
  const first = problems[0];
  return `FDR was not run: ${first.message}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}. FDR may read only files inside the workspace.`;
}

/**
 * Every `include "file"` of a CSPm text: the lexer's (an `include` token
 * before a string, outside comments), and, to be safe where FDR's reading
 * could differ from it, every line that starts with one.
 */
export function includesIn(text: string): FoundInclude[] {
  const out = new Map<number, FoundInclude>();
  const { tokens } = lex(text);
  for (let i = 0; i + 1 < tokens.length; i++) {
    const token = tokens[i];
    const next = tokens[i + 1];
    if (token.kind !== 'ident' || token.text !== 'include' || next.kind !== 'str') continue;
    const closed = next.text.length > 1 && next.text.endsWith('"');
    out.set(next.offset, { include: next.text.slice(1, closed ? -1 : undefined), offset: next.offset, length: next.text.length, span: next.span });
  }
  const lineStart = /^[ \t]*include[ \t]*("([^"\n]*)"?)/gm;
  for (let m = lineStart.exec(text); m; m = lineStart.exec(text)) {
    const offset = m.index + m[0].length - m[1].length;
    if (out.has(offset)) continue;
    const before = text.slice(0, offset);
    const line = (before.match(/\n/g) ?? []).length;
    const col = offset - (before.lastIndexOf('\n') + 1);
    out.set(offset, { include: m[2], offset, length: m[1].length, span: { start: { line, col }, end: { line, col: col + m[1].length } } });
  }
  return [...out.values()].sort((a, b) => a.offset - b.offset);
}

function within(file: string, root: string): boolean {
  const relative = path.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isLink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function toPosix(file: string): string {
  return file.split(path.sep).join('/');
}
