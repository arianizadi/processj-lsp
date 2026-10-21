/**
 * FDR on a CSPm file as it is: `refines --format=framed_json --divide` on a
 * private copy of the buffer (so unsaved edits are what is checked, and an
 * `include` still finds the files next to the original), then the answers
 * explained onto the drawn network (src/cspm/explain.ts). Also FDR's own
 * type check, for diagnostics. Independent of the LSP connection.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePrivateDir, removePrivateDir } from '../compiler';
import { findRefines, refinesNotFoundMessage, runRefines, type FdrResult, type FdrRun, type RefinesRunner, type RunOptions } from '../csp/fdr';
import { includePolicy, includeProblemsText, prepareIncludes, type PreparedModel } from '../csp/includes';
import type { Span } from '../parser/ast';
import type { VerificationReport } from '../verification';
import type { CspmDocument } from './document';
import { assertionKey, cspmAssertions, explainCspm } from './explain';

export interface CspmCheckRequest {
  document: CspmDocument;
  refines?: string;
  /** refines elsewhere (the browser IDE's runner): used instead of a local refines, and nothing is written. */
  runner?: RefinesRunner;
  timeoutMs?: number;
  signal?: AbortSignal;
  memoryLimit?: number;
  workers?: number;
  /** Where to write the copy FDR runs (kept); a private temporary directory otherwise. */
  cspFile?: string;
  /** Where includes may resolve (the workspace roots); default: the document's directory (src/csp/includes.ts). */
  includeRoots?: readonly string[];
  onProgress?: (done: number, total: number, label: string, result: FdrResult) => void;
}

export interface CspmCheck {
  report: VerificationReport;
  run?: FdrRun;
  /** The copy FDR ran, when it was kept. */
  cspFile?: string;
}

/** The directory of the document on disk (for its includes), if it has one. */
export function documentDirectory(uri: string): string | undefined {
  try {
    return path.dirname(fileURLToPath(uri));
  } catch {
    return undefined;
  }
}

/** The document's text as FDR runs it, its includes checked against the workspace (src/csp/includes.ts). */
export function prepareDocument(document: CspmDocument, roots: readonly string[] | undefined): PreparedModel {
  const base = documentDirectory(document.uri);
  return prepareIncludes(document.text, base, includePolicy(roots, base));
}

/** Check a CSPm document's own assertions with FDR and explain the answers. */
export async function checkCspmWithFdr(req: CspmCheckRequest): Promise<CspmCheck> {
  const doc = req.document;
  const explainOf = (run: FdrRun | undefined, notRun?: string): VerificationReport => explainCspm({
    uri: doc.uri,
    ...(doc.version !== undefined ? { documentVersion: doc.version } : {}),
    text: doc.text,
    file: doc.file,
    globals: doc.globals,
    viewFor: (assertion) => doc.viewForAssertion(assertion),
    ...(run ? { run } : {}),
    ...(notRun ? { notRun } : {}),
  });
  const assertions = cspmAssertions(doc.file);
  let done = 0;
  const options: RunOptions = {
    timeoutMs: req.timeoutMs,
    signal: req.signal,
    memoryLimit: req.memoryLimit,
    workers: req.workers,
    onResult: (_index, result) => {
      const a = assertions.find((x) => assertionKey(x.text) === assertionKey(result.assertion));
      if (a) req.onProgress?.(++done, assertions.length, a.text, result);
    },
  };
  const refines = req.runner ? undefined : req.refines ?? findRefines();
  if (!req.runner && !refines) return { report: explainOf(undefined, refinesNotFoundMessage()) };
  const prepared = prepareDocument(doc, req.includeRoots);
  if (prepared.problems.length) return { report: explainOf(undefined, includeProblemsText(prepared.problems)) };
  if (req.runner) {
    const base = documentDirectory(doc.uri);
    const name = req.cspFile ? path.basename(req.cspFile) : safeName(doc.title);
    const run = await req.runner({ text: doc.text, name, ...(base ? { includeBase: base } : {}) }, options);
    return { report: explainOf(run), run, ...(req.cspFile ? { cspFile: req.cspFile } : {}) };
  }
  const temp = req.cspFile ? undefined : makePrivateDir('processj-fdr-csp-');
  const file = req.cspFile ?? path.join(temp!, safeName(doc.title));
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, prepared.text);
    const run = await runRefines(refines!, file, options);
    return { report: explainOf(run), run, ...(temp ? {} : { cspFile: file }) };
  } finally {
    if (temp) removePrivateDir(temp, true);
  }
}

/**
 * FDR's type check of a document: its errors, each at a span of the document
 * when FDR names one in it. `refines` is the local executable, or a runner
 * elsewhere.
 */
export async function typecheckCspm(document: CspmDocument, refines: string | RefinesRunner, opts: { timeoutMs?: number; signal?: AbortSignal; includeRoots?: readonly string[] } = {}): Promise<Array<{ message: string; span?: Span; file?: string }>> {
  // A refused include is the diagnostic, at the include; FDR does not read the file.
  const prepared = prepareDocument(document, opts.includeRoots);
  if (prepared.problems.length) return prepared.problems.map((problem) => ({ message: `${problem.message}. FDR may read only files inside the workspace`, span: problem.span }));
  const options: RunOptions = { typecheckOnly: true, timeoutMs: opts.timeoutMs ?? 20_000, signal: opts.signal };
  if (typeof refines !== 'string') {
    const base = documentDirectory(document.uri);
    const name = safeName(document.title);
    const run = await refines({ text: document.text, name, ...(base ? { includeBase: base } : {}) }, options);
    if (run.aborted) return [];
    return fdrErrors([...run.errors, ...run.results.flatMap((result) => result.errors)], name);
  }
  const temp = makePrivateDir('processj-fdr-tc-');
  try {
    const file = path.join(temp, safeName(document.title));
    fs.writeFileSync(file, prepared.text);
    const run = await runRefines(refines, file, options);
    // Stopped, or not started (too many FDR runs waiting): the next save type-checks again.
    if (run.aborted || run.busy) return [];
    return fdrErrors([...run.errors, ...run.results.flatMap((result) => result.errors)], path.basename(file));
  } finally {
    removePrivateDir(temp, true);
  }
}

/**
 * FDR's error messages with their locations: `model.csp:3:5-6: b is not in
 * scope` is at line 3, columns 5 to 6 of the file named; a message about
 * another file (an include) keeps the file's name.
 */
export function fdrErrors(errors: readonly string[], ownName: string): Array<{ message: string; span?: Span; file?: string }> {
  const out: Array<{ message: string; span?: Span; file?: string }> = [];
  // One string can hold several errors, each starting on a line of its own with its location.
  const split = errors.flatMap((raw) => raw.split(/\n(?=[^\n:]*\.csp:\d+:\d+)/));
  for (const raw of split) {
    const text = raw.replace(/\s*Lexical call stack:[\s\S]*$/, '').trim();
    if (!text) continue;
    const m = /^(?:\.\/)?(.+?\.csp):(\d+):(\d+)(?:-(\d+)(?::(\d+))?)?:\s*([\s\S]*)$/.exec(text);
    if (!m) {
      out.push({ message: text.replace(/^<unknown location>:\s*/, '').replace(/\s+/g, ' ') });
      continue;
    }
    const message = m[6].replace(/\s+/g, ' ').trim();
    const line = Number(m[2]) - 1;
    const col = Number(m[3]) - 1;
    // `3:5-6` ends on the same line; `3:5-4:2` on another.
    const end = m[5] !== undefined ? { line: Number(m[4]) - 1, col: Number(m[5]) - 1 } : { line, col: m[4] !== undefined ? Number(m[4]) - 1 : col + 1 };
    const span = { start: { line, col }, end: end.line > line || end.col > col ? end : { line, col: col + 1 } };
    out.push(path.basename(m[1]) === ownName ? { message, span } : { message, file: m[1], span });
  }
  return out;
}

function safeName(title: string): string {
  const base = path.basename(title).replace(/[^A-Za-z0-9_.-]/g, '_');
  return base.endsWith('.csp') ? base : `${base || 'model'}.csp`;
}
