/**
 * Running FDR's command-line checker, `refines`, on a generated model.
 *
 * Output is FDR's `--format=framed_json`: one JSON object per line, each with
 * the results of one assertion in file order (FDR reprints the assertion with
 * its own spacing, so match results to assertions by order, not by text).
 * Lines arrive as each assertion finishes, which gives a time per assertion
 * and progress while a long check runs. `--divide` adds per-component
 * behaviours to every counterexample: the leaves of the generated network
 * with their traces, named states and acceptances. The raw objects are kept;
 * src/csp/explain.ts reads them.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { exec } from '../compiler';
import type { CspNetworkNode } from './model';

export interface FdrResult {
  /** The assertion as FDR printed it. */
  assertion: string;
  /** true: holds; false: a counterexample was found; undefined: FDR could not decide (see errors). */
  passed?: boolean;
  /** `assert not ...`: `passed` is about the negation (FDR's `is_negated`). */
  negated?: boolean;
  errors: string[];
  states?: number;
  transitions?: number;
  /** Wall-clock time until this result arrived after the previous one (the first includes loading the model). */
  ms?: number;
  /** Raw counterexamples (`type`, `implementation_behaviour`, `specification_behaviour`, ...). */
  counterexamples: unknown[];
}

export interface FdrRun {
  results: FdrResult[];
  /** File-level errors (a type error in the model, a parse error). */
  errors: string[];
  warnings: string[];
  /** Event ids used in counterexample traces -> event names (`τ`, `✓`, `a.4`). */
  eventMap: Record<string, string>;
  version?: string;
  timedOut: boolean;
  aborted: boolean;
  /** refines was stopped for using more memory than allowed: how much it was using (bytes). */
  memoryExceeded?: number;
  exitCode: number | null;
  durationMs: number;
  stderr: string;
}

/** Where FDR's `refines` usually lives, in the order they are tried after an explicit setting. */
export function refinesCandidates(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
  const exe = platform === 'win32' ? 'refines.exe' : 'refines';
  const onPath = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean).map((dir) => path.join(dir, exe));
  const fromHome = env.FDR_HOME ? [path.join(env.FDR_HOME, 'bin', exe), path.join(env.FDR_HOME, 'Contents', 'MacOS', exe), path.join(env.FDR_HOME, exe)] : [];
  return [
    ...(env.FDR_REFINES ? [env.FDR_REFINES] : []),
    ...fromHome,
    ...onPath,
    '/Applications/FDR4.app/Contents/MacOS/refines',
    path.join(home, 'Applications', 'FDR4.app', 'Contents', 'MacOS', 'refines'),
    '/opt/fdr/bin/refines',
    '/usr/local/fdr/bin/refines',
    '/usr/lib/fdr/bin/refines',
    ...(platform === 'win32' ? ['C:\\Program Files\\FDR4\\bin\\refines.exe', 'C:\\Program Files (x86)\\FDR4\\bin\\refines.exe'] : []),
  ];
}

/**
 * The `refines` executable. An explicit path (the `processj.fdrPath` setting)
 * is the only candidate when given; it may also name FDR's install directory
 * or `FDR4.app`. Otherwise $FDR_REFINES, $FDR_HOME, PATH and the usual
 * install locations are tried.
 */
export function findRefines(explicit?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const exe = process.platform === 'win32' ? 'refines.exe' : 'refines';
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
  const given = explicit?.startsWith('~') ? path.join(home, explicit.slice(1)) : explicit;
  // A bare command name (`refines`) is looked up on PATH.
  const onPath = given && !given.includes('/') && !given.includes('\\')
    ? (env.PATH ?? env.Path ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean).map((dir) => path.join(dir, given))
    : [];
  const candidates = given
    ? [...onPath, given, path.join(given, 'bin', exe), path.join(given, 'Contents', 'MacOS', exe), path.join(given, exe)]
    : refinesCandidates(env);
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* not here */
    }
  }
  return undefined;
}

/** What to tell a user whose FDR cannot be found. */
export function refinesNotFoundMessage(explicit?: string): string {
  if (explicit) return `FDR's refines was not found at ${explicit} (the processj.fdrPath setting). Point it at the refines executable or FDR's install directory.`;
  return 'FDR (its refines command) was not found. Install FDR4 from https://cocotec.io/fdr/, then put refines on PATH or set processj.fdrPath to it (on macOS: /Applications/FDR4.app/Contents/MacOS/refines).';
}

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Per-component counterexamples (default true). */
  divide?: boolean;
  /** Only type-check the file. */
  typecheckOnly?: boolean;
  /** Called as each assertion's result arrives (0-based, in file order). */
  onResult?: (index: number, result: FdrResult) => void;
  /**
   * Stop refines once its process group uses more memory than this (bytes):
   * a big model can take tens of gigabytes within seconds. 0: no limit;
   * default: half of this machine's memory, at most 8 GB. Not on Windows.
   */
  memoryLimit?: number;
  /**
   * refines' BFS workers. One worker finds the same deadlock and trace
   * (runtime error) counterexample on every run (with several, which of the
   * shortest ones comes first varies). It does not govern the divergence
   * search behind the termination check, nor the determinism check: their
   * counterexamples can differ from one run to the next whatever this is.
   * The default is refines' own (one per core).
   */
  workers?: number;
}

/** The memory refines may use when no limit is given: half of this machine's, at most 8 GB. */
export function defaultMemoryLimit(): number {
  return Math.min(Math.floor(os.totalmem() / 2), 8 * 1024 ** 3);
}

/** The resident memory of a process group, in bytes (POSIX `ps`); undefined when it cannot be read. */
function groupMemory(pgid: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pgid=,rss='], { timeout: 5_000 }, (error, stdout) => {
      if (error) return resolve(undefined);
      let kb = 0;
      for (const line of stdout.split('\n')) {
        const [group, rss] = line.trim().split(/\s+/).map(Number);
        if (group === pgid && Number.isFinite(rss)) kb += rss;
      }
      resolve(kb * 1024);
    });
  });
}

/**
 * Run `refines` on a CSPm file and parse its framed JSON output. The process
 * group is killed on timeout, on abort and when it uses more memory than allowed.
 */
export async function runRefines(refines: string, file: string, opts: RunOptions = {}): Promise<FdrRun> {
  const args = ['--format=framed_json', '-q'];
  if (opts.typecheckOnly) args.push('--typecheck');
  else if (opts.divide !== false) args.push('--divide');
  if (opts.workers !== undefined && opts.workers > 0) args.push(`--refinement-bfs-workers=${opts.workers}`);
  // `./`: a model named like an option (`-x.csp`) is still a file.
  args.push(`./${path.basename(file)}`);
  // Results stream in one line per assertion: time each one and report progress.
  const started = Date.now();
  let last = started;
  const times: number[] = [];
  let pending = '';
  let seen = 0;
  const onStdout = (chunk: string): void => {
    pending += chunk;
    for (let nl = pending.indexOf('\n'); nl >= 0; nl = pending.indexOf('\n')) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (!line.includes('"results"')) continue;
      const now = Date.now();
      const parsed = parseFramedJson(line);
      for (const r of parsed.results) {
        times.push(now - last);
        r.ms = now - last;
        opts.onResult?.(seen++, r);
      }
      last = now;
    }
  };
  // A watchdog on refines' memory: it polls the process group and stops it past the limit.
  const limit = opts.memoryLimit ?? defaultMemoryLimit();
  const stop = new AbortController();
  const onAbort = (): void => stop.abort();
  if (opts.signal?.aborted) stop.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  let memoryExceeded: number | undefined;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  const onSpawn = (pid: number): void => {
    if (!limit || process.platform === 'win32') return;
    let busy = false;
    watchdog = setInterval(() => {
      if (busy) return;
      busy = true;
      void groupMemory(pid).then((bytes) => {
        busy = false;
        if (bytes !== undefined && bytes > limit && memoryExceeded === undefined) {
          memoryExceeded = bytes;
          stop.abort();
        }
      });
    }, 1_000);
    watchdog.unref?.();
  };
  let r;
  try {
    r = await exec(refines, args, { cwd: path.dirname(file), timeoutMs: opts.timeoutMs ?? 60_000, signal: stop.signal, maxOutput: 50_000_000, onStdout, onSpawn });
  } finally {
    if (watchdog) clearInterval(watchdog);
    opts.signal?.removeEventListener('abort', onAbort);
  }
  const parsed = parseFramedJson(r.stdout);
  parsed.results.forEach((result, i) => {
    if (times[i] !== undefined) result.ms = times[i];
  });
  return { ...parsed, timedOut: r.timedOut, aborted: r.aborted && memoryExceeded === undefined, ...(memoryExceeded !== undefined ? { memoryExceeded } : {}), exitCode: r.exitCode, durationMs: r.durationMs, stderr: r.stderr };
}

/** Parse refines' framed JSON (one object per line; a cancelled run may leave a truncated last line). */
export function parseFramedJson(stdout: string): Pick<FdrRun, 'results' | 'errors' | 'warnings' | 'eventMap' | 'version'> {
  const out: Pick<FdrRun, 'results' | 'errors' | 'warnings' | 'eventMap' | 'version'> = { results: [], errors: [], warnings: [], eventMap: {} };
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      out.errors.push('refines output was cut short');
      continue;
    }
    if (typeof obj.copyright_notice === 'string' && !out.version) out.version = /Version ([\d.]+)/.exec(obj.copyright_notice)?.[1];
    for (const e of asStrings(obj.errors)) if (!out.errors.includes(e)) out.errors.push(e);
    for (const w of asStrings(obj.warnings)) if (!out.warnings.includes(w)) out.warnings.push(w);
    if (obj.event_map && typeof obj.event_map === 'object') Object.assign(out.eventMap, obj.event_map as Record<string, string>);
    for (const raw of Array.isArray(obj.results) ? obj.results : []) {
      const r = raw as Record<string, unknown>;
      out.results.push({
        assertion: String(r.assertion_string ?? ''),
        passed: r.result === 1 ? true : r.result === 0 ? false : undefined,
        ...(r.is_negated === 1 || r.is_negated === true ? { negated: true } : {}),
        errors: asStrings(r.errors),
        states: typeof r.visited_states === 'number' ? r.visited_states : undefined,
        transitions: typeof r.visited_transitions === 'number' ? r.visited_transitions : undefined,
        counterexamples: Array.isArray(r.counterexamples) ? r.counterexamples : [],
      });
    }
  }
  return out;
}

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

// ---------------------------------------------------------------------------
// Reading a --divide counterexample against the model's network
// ---------------------------------------------------------------------------

/** One behaviour node of a --divide counterexample, as refines prints it. */
export interface FdrBehaviour {
  machine_name?: string;
  /** `trace`, `min_acceptance` (with `acceptance`), `loop` (with `loop_start`). */
  type: string;
  /** Event ids, aligned with the parent's trace; 0: the machine did not take part in that step. */
  trace: number[];
  /** State before the first step and after each step: a named definition, `<unnamed>` or `<unchanged>`. */
  states?: string[];
  /** Events the machine still offers at the end (what it waits for). */
  acceptance?: number[];
  /** Trace counterexamples: the event the machine performs next, which the specification refuses (0: none). */
  error_event?: number;
  /** Divergence: the trace from this index on repeats forever. */
  loop_start?: number;
  child_behaviours?: FdrBehaviour[];
}

/** A counterexample as refines prints it. */
export interface FdrCounterexample {
  /** `deadlock`, `trace`, `failure`, `divergence`, `refinement_divergence`, `determinism`, ... */
  type: string;
  implementation_behaviour?: FdrBehaviour;
  specification_behaviour?: FdrBehaviour;
}

/** What one process of the model did in a counterexample. */
export interface LeafBehaviour {
  /** Index into sourceMap.processes. */
  process: number;
  /** The machine as FDR named it (aliases resolved: `main__42(1, ...)` for `main__body(1, ...)`). */
  machine: string;
  /** Per step of the counterexample: the event this process took part in, or undefined. */
  steps: Array<string | undefined>;
  /** Named state after each step, carried forward over `<unchanged>` (undefined while unnamed); index 0 is the start. */
  states: Array<string | undefined>;
  /**
   * The definition the process is in before step i (and, at index steps.length,
   * at the end): the last named state at or before that point. A state is
   * unnamed in the middle of a definition (between a par's forks, after a
   * guard), so this is the definition whose statement the process executes.
   */
  at: Array<string | undefined>;
  /** The last named state: the definition (with arguments) the process stopped in. */
  final?: string;
  /** Event names the process offers at the end. */
  acceptance: string[];
  /** Whether FDR said what the process offers at the end (only stuck states have an acceptance). */
  hasAcceptance: boolean;
  /** For a trace counterexample: the event this process performs next, the one the specification refuses. */
  errorEvent?: string;
  /** For a divergence: the process takes part in the steps that repeat forever. */
  inLoop: boolean;
}

/** The network part of a counterexample: the behaviour standing for the model's network and the trace around it. */
export interface NetworkBehaviour {
  node: FdrBehaviour;
  leaves: LeafBehaviour[];
}

/**
 * Match the leaves of a --divide behaviour to the model's processes. The
 * generated network has one leaf per process and FDR's behaviour tree has
 * the same shape (named definitions as named nodes, parallels as `<op>`
 * nodes with two children, leaves wrapped in `sbisim(...)`), so the match is
 * by position. The network is found under its root name (`MAIN`, the
 * checked procedure, or the `PJ_RUN(...)` of the argument values a checked
 * procedure was called with). Returns undefined when the network is not in
 * the tree (an assertion about other processes).
 */
export function leafBehaviours(
  model: { root: string; sourceMap: { network: CspNetworkNode; processes: Array<{ leaf: string }>; networkRoot?: string } },
  /** A counterexample (its implementation behaviour is used) or a behaviour node. */
  behaviour: FdrBehaviour | FdrCounterexample,
  eventMap: Record<string, string>,
): LeafBehaviour[] | undefined {
  return networkBehaviour(model, behaviour, eventMap)?.leaves;
}

export function networkBehaviour(
  model: { root: string; sourceMap: { network: CspNetworkNode; processes: Array<{ leaf: string }>; networkRoot?: string } },
  behaviour: FdrBehaviour | FdrCounterexample,
  eventMap: Record<string, string>,
): NetworkBehaviour | undefined {
  const start = 'implementation_behaviour' in behaviour || !('trace' in behaviour) ? (behaviour as FdrCounterexample).implementation_behaviour : (behaviour as FdrBehaviour);
  if (!start) return undefined;
  const rootName = model.sourceMap.networkRoot ?? model.root;
  const candidates: FdrBehaviour[] = [];
  const find = (b: FdrBehaviour): void => {
    if (b.machine_name === rootName || b.machine_name?.startsWith(`${rootName}(`)) {
      candidates.push(b);
      return;
    }
    for (const c of b.child_behaviours ?? []) find(c);
  };
  find(start);
  // Several candidates: the alternatives of a checked procedure's argument values. The one that
  // takes part in the trace is the one the counterexample ran.
  const takesPart = (b: FdrBehaviour): boolean => b.trace.some((e) => e !== 0) || !!b.error_event;
  const root = candidates.find(takesPart) ?? candidates[0];
  if (!root) return undefined;
  const out: LeafBehaviour[] = [];
  const name = (id: number | undefined): string | undefined => (id === undefined || id === 0 ? undefined : eventMap[String(id)] ?? String(id));
  const leaf = (b: FdrBehaviour, process: number): void => {
    // `sbisim(P)` wraps the machine P that carries the states.
    const inner = b.child_behaviours?.length === 1 && b.machine_name?.startsWith('sbisim(') ? b.child_behaviours[0] : b;
    const states: Array<string | undefined> = [];
    const at: Array<string | undefined> = [];
    let current: string | undefined;
    let named: string | undefined = stripSbisim(inner.machine_name);
    for (const s of inner.states ?? []) {
      if (s !== '<unchanged>') current = s === '<unnamed>' ? undefined : s;
      if (current !== undefined) named = current;
      states.push(current);
      at.push(named);
    }
    while (at.length < inner.trace.length + 1) at.push(named);
    const final = [...(inner.states ?? [])].reverse().find((s) => s !== '<unchanged>' && s !== '<unnamed>') ?? stripSbisim(inner.machine_name);
    const loopStart = loopOf(inner) ?? loopOf(b);
    out.push({
      process,
      machine: inner.machine_name ?? '',
      steps: inner.trace.map((e) => name(e)),
      states,
      at,
      final,
      acceptance: (inner.acceptance ?? []).map((e) => name(e) ?? String(e)),
      hasAcceptance: Array.isArray(inner.acceptance) || Array.isArray(b.acceptance),
      errorEvent: name(inner.error_event) ?? name(b.error_event),
      inLoop: loopStart !== undefined && inner.trace.slice(loopStart).some((e) => e !== 0),
    });
  };
  const match = (node: CspNetworkNode, b: FdrBehaviour): void => {
    const kids = b.child_behaviours ?? [];
    switch (node.kind) {
      case 'leaf':
        if (node.process >= 0) leaf(b, node.process);
        return;
      case 'hide':
      case 'named':
        // A named parallel is one FDR node with the parallel's two children.
        if (node.child.kind === 'parallel' && kids.length === 2) return match2(node.child, kids);
        if (kids.length === 1 && (node.child.kind !== 'leaf' || !b.machine_name?.startsWith('sbisim('))) return match(node.child, kids[0]);
        return match(node.child, b);
      case 'parallel':
        if (kids.length === 2) match2(node, kids);
        return;
      case 'block':
      case 'exception':
        // `P [| A |] STOP`, `P [| A |> SKIP`: the process is the first of the two children.
        if (kids.length === 2) match(node.child, kids[0]);
        else match(node.child, b);
        return;
      case 'compressed':
        // One machine for the whole part: its processes have no behaviour of their own here.
        return;
    }
  };
  const match2 = (node: Extract<CspNetworkNode, { kind: 'parallel' }>, kids: FdrBehaviour[]): void => {
    match(node.left, kids[0]);
    match(node.right, kids[1]);
  };
  match(model.sourceMap.network, root);
  return { node: root, leaves: out.sort((a, b) => a.process - b.process) };
}

function stripSbisim(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const m = /^sbisim\((.*)\)$/.exec(name);
  return m ? m[1] : name;
}

function loopOf(b: FdrBehaviour): number | undefined {
  return typeof b.loop_start === 'number' ? b.loop_start : undefined;
}

/** The loop start of a divergence counterexample, wherever FDR put it. */
export function loopStart(b: FdrBehaviour | undefined): number | undefined {
  if (!b) return undefined;
  const own = loopOf(b);
  if (own !== undefined) return own;
  for (const c of b.child_behaviours ?? []) {
    const found = loopStart(c);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Split an FDR state name into its definition and arguments:
 * `delta__24_join1(1, d, 4, main__par42_1__end(1))` -> `delta__24_join1`,
 * [`1`, `d`, `4`, `main__par42_1__end(1)`]. Arguments are split at top-level
 * commas; a process-valued last argument (a continuation) may itself contain
 * anything.
 */
export function parseState(state: string): { name: string; args: string[] } {
  const open = state.indexOf('(');
  if (open < 0 || !state.endsWith(')')) return { name: state.trim(), args: [] };
  const name = state.slice(0, open).trim();
  const body = state.slice(open + 1, -1);
  const args: string[] = [];
  let depth = 0;
  let angle = 0;
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    const prev = body[i - 1];
    const next = body[i + 1];
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    // Sequences `<1, 2>`; never the arrows and comparisons of a process (`->`, `<=`, `<-`).
    else if (ch === '<' && next !== '-' && next !== '=' && next !== '~') angle++;
    else if (ch === '>' && angle > 0 && prev !== '-' && prev !== '=' && prev !== '~') angle--;
    if (ch === ',' && depth === 0 && angle === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() || args.length) args.push(current.trim());
  return { name, args };
}
