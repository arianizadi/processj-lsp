/**
 * The compiler and FDR on a runner elsewhere, for a client that offers one
 * (`initializationOptions.browser`): the browser IDE, where no process can be
 * started. The server asks its client with `processj/compile` and
 * `processj/runRefines`; the client runs the job on its runner service and
 * answers with what the tool printed, which goes through the same parsing as
 * a local run's output (parseCompilerOutput, parseFramedJson), so everything
 * after it is unchanged.
 *
 * A job is a small project: `files` with paths relative to its top, which is
 * the workspace root, and the runner accepts only paths inside it, so the
 * jobs are written in those terms here.
 */
import * as path from 'node:path';
import type { ImportMirror } from './compiler';
import { parseFramedJson, type FdrRun, type RefinesModel, type RefinesRunner } from './csp/fdr';

/** What the client offers in `initializationOptions.browser`. */
export interface RemoteOptions {
  /** FDR checks and type checks run on the client's runner (processj/runRefines). */
  fdr: boolean;
  /** Compiler diagnostics come from the client's runner (processj/compile). */
  compile: boolean;
}

export function remoteOptions(initializationOptions: unknown): RemoteOptions {
  const browser = (initializationOptions as { browser?: unknown } | null | undefined)?.browser;
  const raw = browser && typeof browser === 'object' ? browser as Record<string, unknown> : {};
  return { fdr: raw.remoteFdr === true, compile: raw.remoteCompile === true };
}

export interface JobFile {
  /** Relative to the job's top, `/`-separated. */
  path: string;
  text: string;
}

/** `processj/runRefines`: FDR on `model`, a file named `name` at the top of a job with `files`. */
export interface RunRefinesParams {
  model: string;
  name: string;
  /** The other .csp files it includes (and the ones they include), at their paths in the project. */
  files: JobFile[];
  mode: 'check' | 'typecheck';
  timeoutMs: number;
}

/** The runner's `result.data`: one object per line of refines' `--format=framed_json`; `error` when the job failed. */
export interface RunRefinesResult {
  exitCode: number;
  frames: unknown[];
  error?: string;
}

/** `processj/compile`: compiler messages for `entry`, compiled with the project files it imports. */
export interface RemoteCompileParams {
  entry: string;
  files: JobFile[];
  mode: 'check';
}

/** The compiler's output (with the runner's notes), and whether it succeeded; `error` when the job failed. */
export interface RemoteCompileResult {
  output: string;
  ok: boolean;
  error?: string;
}

/** Where the server reads the project: its roots, and a file's current text (an open buffer before the file). */
export interface Project {
  roots: readonly string[];
  read(file: string): string | undefined;
}

/** Most files a runner job may have (runner-protocol.md). */
const MAX_JOB_FILES = 64;
/** An `include "file"` anywhere in CSPm text; the runner looks for the same, comments included. */
const INCLUDE = /(\binclude\s*")([^"\n]*)(")/g;

/** A file's place in the project: the root it is under and its path from there (`/`-separated). */
export function projectPath(file: string, roots: readonly string[]): { root: string; path: string } | undefined {
  const absolute = path.resolve(file);
  // The innermost root wins when roots nest.
  for (const root of [...roots].map((r) => path.resolve(r)).sort((a, b) => b.length - a.length)) {
    if (!absolute.startsWith(root + path.sep)) continue;
    return { root, path: path.relative(root, absolute).split(path.sep).join('/') };
  }
  return undefined;
}

/** A name the runner accepts at the top of a job: letters, digits, `_`, `.` and `-`, ending in .csp. */
function jobName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^[.-]+/, '_').slice(0, 90);
  return safe.endsWith('.csp') ? safe : `${safe || 'model'}.csp`;
}

/**
 * The job for a model: the model at the top of the job, its `include`s of
 * project files rewritten to their project paths, and those files with the
 * ones they include in turn, at their own project paths (their includes are
 * written relative to themselves, as FDR reads them). An include of anything
 * outside the project is left as written: the runner refuses it and says why.
 */
export function refinesJob(model: RefinesModel, project: Project): { name: string; model: string; files: JobFile[] } {
  const files = new Map<string, JobFile>();
  const pending: Array<{ file: string; job: string }> = [];
  /** `text` with its includes, relative to `base` on disk, rewritten for a file at `place` in the job. */
  const rewrite = (text: string, base: string | undefined, place: string): string => text.replace(INCLUDE, (whole, open: string, target: string, close: string) => {
    if (!base && !path.isAbsolute(target)) return whole;
    const file = path.resolve(base ?? '/', target);
    const found = projectPath(file, project.roots);
    if (!found) return whole;
    if (!files.has(found.path)) {
      if (files.size >= MAX_JOB_FILES - 1) return whole;
      const included = project.read(file);
      if (included === undefined) return whole;
      files.set(found.path, { path: found.path, text: included });
      pending.push({ file, job: found.path });
    }
    return `${open}${path.posix.relative(`/${path.posix.dirname(place)}`, `/${found.path}`)}${close}`;
  });
  const text = rewrite(model.text, model.includeBase, '.');
  for (let next = pending.shift(); next; next = pending.shift()) {
    const entry = files.get(next.job)!;
    entry.text = rewrite(entry.text, path.dirname(next.file), next.job);
  }
  let name = jobName(model.name);
  for (let n = 2; files.has(name); n++) name = jobName(`${model.name.replace(/\.csp$/i, '')}.${n}.csp`);
  return { name, model: text, files: [...files.values()] };
}

/** What a runner's answer with no frames and no reason means: refines printed nothing it could read. */
export const NO_FDR_ANSWER = 'FDR gave no answer: the runner returned none of its output';

/** The FdrRun a runner's answer stands for: its frames are the lines refines printed. */
export function fdrRunFromFrames(result: RunRefinesResult, durationMs: number): FdrRun {
  const frames = Array.isArray(result?.frames) ? result.frames : [];
  const parsed = parseFramedJson(frames.map((frame) => JSON.stringify(frame) ?? '').join('\n'));
  // The runner's reason for failing (a timeout, no FDR, a refused include) is said as refines' stderr would be.
  // refines always prints a frame, so none at all is no answer, whatever the exit code (not "decided").
  const error = typeof result?.error === 'string' && result.error ? result.error : frames.length ? '' : NO_FDR_ANSWER;
  return { ...parsed, timedOut: false, aborted: false, exitCode: typeof result?.exitCode === 'number' ? result.exitCode : null, durationMs, stderr: error };
}

/**
 * A RefinesRunner that asks the client (`request` sends processj/runRefines).
 * A cancelled check ends at once, without waiting for the client; one that
 * gets no answer in twice its time (with a margin for the runner's queue) ends
 * as timed out.
 */
export function remoteRefines(request: (params: RunRefinesParams, signal: AbortSignal) => Promise<RunRefinesResult>, project: Project): RefinesRunner {
  return async (model, opts) => {
    const started = Date.now();
    const job = refinesJob(model, project);
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const params: RunRefinesParams = { model: job.model, name: job.name, files: job.files, mode: opts.typecheckOnly ? 'typecheck' : 'check', timeoutMs };
    const ended = (how: 'aborted' | 'timedOut'): FdrRun => ({ results: [], errors: [], warnings: [], eventMap: {}, timedOut: how === 'timedOut', aborted: how === 'aborted', exitCode: null, durationMs: Date.now() - started, stderr: '' });
    if (opts.signal?.aborted) return ended('aborted');
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await new Promise<RunRefinesResult | 'aborted' | 'timedOut'>((resolve) => {
      const onAbort = (): void => resolve('aborted');
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => resolve('timedOut'), Math.max(2 * timeoutMs, timeoutMs + 120_000));
      // In Node, an unanswered request does not keep the server alive.
      timer.unref?.();
      request(params, stop.signal).then(resolve, (error: unknown) => resolve({ exitCode: -1, frames: [], error: `the runner could not be asked (${error instanceof Error ? error.message : String(error)})` }))
        .finally(() => opts.signal?.removeEventListener('abort', onAbort));
    });
    clearTimeout(timer);
    if (outcome === 'aborted' || outcome === 'timedOut') {
      stop.abort();
      return ended(outcome);
    }
    const run = fdrRunFromFrames(outcome, Date.now() - started);
    run.results.forEach((result, index) => opts.onResult?.(index, result));
    return run;
  };
}

/**
 * The compile job for a document: its text (as the compiler should read it)
 * at its project path, and the project files it imports, directly or through
 * other files. The compiler resolves an import from the document's directory,
 * so a package found under a workspace root instead goes where the local
 * compiler's sandbox links it (`mirrors`), next to the document. Undefined for
 * a document outside the project.
 */
export function compileJob(entry: { file: string; text: string }, imports: readonly string[], mirrors: readonly ImportMirror[], project: Project): { params: RemoteCompileParams; root: string } | undefined {
  const own = projectPath(entry.file, project.roots);
  if (!own) return undefined;
  const entryDir = path.dirname(path.resolve(entry.file));
  const entryDirJob = path.posix.dirname(own.path);
  const inside = (dir: string, file: string): boolean => file === dir || file.startsWith(dir + path.sep);
  const jobPath = (file: string): string | undefined => {
    const absolute = path.resolve(file);
    if (inside(entryDir, absolute)) return projectPath(absolute, [own.root])?.path;
    for (const mirror of mirrors) {
      const target = path.resolve(mirror.target);
      if (inside(target, absolute)) return path.posix.join(entryDirJob, mirror.name, path.relative(target, absolute).split(path.sep).join('/'));
    }
    return projectPath(absolute, [own.root])?.path;
  };
  const files = new Map<string, JobFile>([[own.path, { path: own.path, text: entry.text }]]);
  for (const file of imports) {
    if (files.size >= MAX_JOB_FILES) break;
    const at = jobPath(file);
    if (!at || files.has(at)) continue;
    const text = project.read(file);
    if (text !== undefined) files.set(at, { path: at, text });
  }
  return { params: { entry: own.path, files: [...files.values()], mode: 'check' }, root: own.root };
}

/**
 * The compiler's part of a runner's output: without the runner's own
 * progress notes, which it prints dimmed on lines of their own
 * (`processjc main.pj`, `compilation failed`).
 */
export function compilerOutput(output: string): string {
  // eslint-disable-next-line no-control-regex
  return output.replace(/^\x1b\[2m[^\n]*\x1b\[0m\r?\n?/gm, '');
}
