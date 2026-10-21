/**
 * Translate, run FDR, explain: one call for editors, scripts and the graph
 * viewer. Independent of the LSP connection.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makePrivateDir, removePrivateDir } from '../compiler';
import type { Pos } from '../parser/ast';
import type { VerificationReport } from '../verification';
import { explain, normalizeAssertion } from './explain';
import { findRefines, refinesNotFoundMessage, runRefines, type FdrResult, type FdrRun, type RefinesRunner, type RunOptions } from './fdr';
import { includePolicy, includeProblemsText, prepareIncludes } from './includes';
import type { CspModel } from './model';
import { translateProcedure, translateProgram, type TranslateInput } from './translate';

export interface FdrCheckRequest extends TranslateInput {
  /** A procedure checked on its own; the whole program (from main) when omitted. */
  procedure?: { name: string; at?: Pos };
  /** The document the report is about (its LSP URI). */
  uri: string;
  documentVersion?: number;
  /** FDR's refines; found with findRefines() when omitted. */
  refines?: string;
  /** refines elsewhere (the browser IDE's runner): used instead of a local refines, and nothing is written. */
  runner?: RefinesRunner;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Stop refines past this much memory (bytes); see RunOptions.memoryLimit. */
  memoryLimit?: number;
  /** refines' BFS workers; 1 gives the same deadlock and runtime-error counterexamples on every run (RunOptions.workers). */
  workers?: number;
  /**
   * Where to write the model FDR runs on (its directory is FDR's working
   * directory). When omitted, a private temporary directory is used and
   * removed after the run.
   */
  cspFile?: string;
  /**
   * The directory an `include "file"` of a /*@csp block is relative to:
   * FDR looks next to the file that includes, so the copy FDR runs names
   * such files by their absolute path. Default: the document's directory.
   */
  includeBase?: string;
  /** Where includes may resolve (the workspace roots); default: `includeBase` (src/csp/includes.ts). */
  includeRoots?: readonly string[];
  /** Called as each assertion's result arrives: `index` of `total` (in file order). */
  onProgress?: (done: number, total: number, label: string, result: FdrResult) => void;
  /** A translation the caller already made of this same input and target (it is not translated again). */
  model?: CspModel;
}

export interface FdrCheck {
  report: VerificationReport;
  model: CspModel;
  /** The model as FDR ran it, when it was kept (`cspFile` was given). */
  cspFile?: string;
  /** refines' parsed output; undefined when FDR did not run (not found, or the model is incomplete). */
  rawResults?: FdrRun;
}

/** Translate the program or one procedure, check it with FDR and explain the answers. */
export async function checkWithFdr(req: FdrCheckRequest): Promise<FdrCheck> {
  const model = req.model ?? (req.procedure ? translateProcedure(req, req.procedure.name, req.procedure.at) : translateProgram(req));
  const opts = { uri: req.uri, documentVersion: req.documentVersion };
  // Fail closed: an incomplete model is never run (explain() marks every check as not checked).
  if (model.unsupported.length) return { report: explain(model, undefined, opts), model };
  const base = req.includeBase ?? (req.units[0]?.file ? path.dirname(req.units[0].file) : undefined);
  const refines = req.runner ? undefined : req.refines ?? findRefines();
  if (!req.runner && !refines) return { report: explain(model, undefined, { ...opts, notRun: refinesNotFoundMessage() }), model };
  // The /*@csp blocks are the user's CSPm: their includes may name only files of the project.
  const prepared = prepareIncludes(model.text, base, includePolicy(req.includeRoots, base));
  if (prepared.problems.length) return { report: explain(model, undefined, { ...opts, notRun: includeProblemsText(prepared.problems) }), model };
  // Progress by assertion text: a block's `include` can add assertions of its own to FDR's list.
  let done = 0;
  const options: RunOptions = {
    timeoutMs: req.timeoutMs,
    signal: req.signal,
    memoryLimit: req.memoryLimit,
    workers: req.workers,
    onResult: (_index, result) => {
      const a = model.assertions.find((x) => normalizeAssertion(x.assertion) === normalizeAssertion(result.assertion));
      if (!a) return;
      req.onProgress?.(++done, model.assertions.length, a.label, result);
    },
  };
  if (req.runner) {
    const name = req.cspFile ? path.basename(req.cspFile) : `${model.target.kind === 'program' ? 'program' : model.target.name}.csp`;
    const run = await req.runner({ text: model.text, name, ...(base ? { includeBase: base } : {}) }, options);
    return { report: explain(model, run, opts), model, rawResults: run };
  }
  // Removed when the check is over, or at exit if the process is stopped during it (a signal).
  const temp = req.cspFile ? undefined : makePrivateDir('processj-fdr-');
  const file = req.cspFile ?? path.join(temp!, `${model.target.kind === 'program' ? 'program' : model.target.name}.csp`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, prepared.text);
    const run = await runRefines(refines!, file, options);
    return { report: explain(model, run, opts), model, cspFile: temp ? undefined : file, rawResults: run };
  } finally {
    if (temp) removePrivateDir(temp, true);
  }
}

/**
 * The model with every relative `include "file"` (from the user's /*@csp
 * blocks) made absolute against `base`, line for line, so FDR finds the
 * file wherever the copy it runs is written. Unchecked: FDR runs go through
 * prepareIncludes (src/csp/includes.ts), which also confines them.
 */
export function absoluteIncludes(text: string, base: string): string {
  return text.replace(/^(\s*include\s+")([^"]+)(")/gm, (whole, open: string, file: string, close: string) => (path.isAbsolute(file) ? whole : `${open}${path.resolve(base, file).split(path.sep).join('/')}${close}`));
}
