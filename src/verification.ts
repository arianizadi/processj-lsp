/**
 * Verification results in the one shape the editors and the graph viewer consume,
 * whatever produced them: the static checker (instant, covers straight-line
 * rendezvous and the channel hazard lints) or FDR (exhaustive over the CSP model).
 *
 * Producers and the graph agree on identity so a result lands on the right box and
 * arrow:
 * - a process instance is the path of spawn sites from the root procedure ([] is
 *   the root itself). Walking from the root toward the instance, every par branch
 *   entered adds { kind: 'branch', site: the branch statement, index: its 1-based
 *   position in the par body }; every par for entered adds { kind: 'par-for',
 *   site: the for statement, index: the iteration value when known }; and every
 *   call passed through on the way to a par adds { kind: 'call', site: the
 *   Invocation expression }. A call that leads to no par adds nothing: such a
 *   callee runs inside the process that called it;
 * - a channel (or barrier, or timer) is its declarator plus the path of the
 *   procedure instance that declared it ([] for the root procedure);
 * - a program point is a statement or expression span.
 *
 * URIs are the LSP document URI for the open document and pathToFileURL(file)
 * for any other file. Spans are the parser's (0-based, half-open).
 *
 * Every field a producer cannot know is optional; consumers show what is present
 * and never invent the rest.
 */
import type { Span } from './parser/ast';

export interface SourceRef {
  uri: string;
  span: Span;
}

/** One level of process creation below the root procedure. */
export interface SpawnSite {
  /** The par branch statement, the par for statement, or the expanded call statement. */
  site: SourceRef;
  kind: 'branch' | 'par-for' | 'call';
  /** 1-based branch number within its par, or the par for iteration value when known. */
  index?: number;
}

export type ProcessPath = SpawnSite[];

export interface ProcessRef {
  path: ProcessPath;
  /** What the user recognises: `delta(d, a, b)`, `branch 2`, `reindeer(1, ...)`. */
  label: string;
  /** Procedure whose code the instance runs, when it is a call. */
  procedure?: string;
  /**
   * A short name that tells the instance apart from every other process of the
   * report, when labels do not (`branch 1 of crossed(r1.write)`, `a (line 9)`,
   * `reindeer(1, …)`): the name the producer's own sentences use.
   */
  name?: string;
}

export interface ChannelRef {
  name: string;
  kind: 'channel' | 'barrier' | 'timer';
  /** Span of the declarator name (a local declaration or a parameter). */
  declaration?: SourceRef;
  /** Instance of the procedure that declared it; [] for the root procedure. */
  owner: ProcessPath;
  /** Which user of a shared side took part, when the producer distinguishes them. */
  user?: string;
}

/** One operation a process is stuck on. An alt waits on several at once. */
export interface WaitInfo {
  operation: 'read' | 'write' | 'sync' | 'alt-guard' | 'extended-read' | 'timeout' | 'other';
  channel?: ChannelRef;
  /** The statement that is waiting. */
  at?: SourceRef;
  /** `waits to write out1`, `waits to read d`. */
  detail: string;
  /** Why it can never complete, when the producer knows. */
  partner?: {
    process?: ProcessRef;
    state: 'terminated' | 'blocked-elsewhere' | 'missing' | 'not-ready';
    detail: string;
  };
}

export interface ProcessSnapshot {
  process: ProcessRef;
  status: 'running' | 'blocked' | 'terminated' | 'error' | 'diverging' | 'unknown';
  /** Where the instance is: the statement it is executing or waiting at. */
  at?: SourceRef;
  waits?: WaitInfo[];
  description: string;
  /**
   * The producer's own names for the states the process went through, in
   * order, when it has them (FDR: the model's per-blocking-point
   * definitions with their arguments, from --divide). The process is in
   * `state` from just before step `step` until the next entry's step;
   * `step` is steps.length for a state the last step leads into.
   */
  trail?: Array<{ step: number; state: string }>;
}

export interface TraceStep {
  /** 0-based position in the counterexample. */
  index: number;
  /** The raw event as the producer saw it (a CSPm event for FDR), for users who know CSP. */
  event: string;
  kind: 'communication' | 'barrier' | 'termination' | 'error' | 'internal' | 'other';
  channel?: ChannelRef;
  /** The communicated value, rendered in ProcessJ terms (`3`, `true`, `move(1, 2)`). */
  value?: string;
  /** Who took part, and the statement each one executed. */
  participants: Array<{
    process: ProcessRef;
    role: 'writer' | 'reader' | 'sync' | 'actor';
    at?: SourceRef;
  }>;
  /** `delta writes 3 on a; consume reads it`. */
  description: string;
  /** False when the step was internal to a procedure (a hidden channel), so the outside never saw it. */
  visible?: boolean;
  /**
   * When what the producer's model abstracts decides this step (an alt taking
   * a skip or timeout guard, an abstract value choosing a branch): what the
   * real program would need to do the same. Counterexample.caveats says it in full.
   */
  caveat?: string;
}

export interface Counterexample {
  kind: 'deadlock' | 'runtime-error' | 'divergence' | 'nondeterminism' | 'refinement' | 'no-termination';
  steps: TraceStep[];
  /** For divergence: the steps from this index on repeat forever. */
  loopStart?: number;
  /** Every known process at the end of the trace (for divergence: when the loop starts). */
  final: ProcessSnapshot[];
  /** Circular waits in `final`: processes in wait order, each with the channel it waits on toward the next. */
  cycles?: Array<Array<{ process: ProcessRef; channel?: ChannelRef }>>;
  /** For runtime errors: what went wrong and where (an integer outside the modelled range, division by zero, an array index). */
  error?: { kind: string; message: string; at?: SourceRef };
  /** One line for lists and diagnostics: `deadlock after 6 steps: delta waits to write a, consume has terminated`. */
  summary: string;
  /**
   * Abstractions of the producer's model this counterexample relies on (an alt
   * taking a skip or timeout guard, an abstract value deciding a branch), so
   * the real program may reach it only under some schedules or values.
   */
  caveats?: string[];
}

export type CheckProperty =
  | 'deadlock-free'
  | 'no-runtime-errors'
  | 'terminates'
  | 'divergence-free'
  | 'deterministic'
  | 'refinement'
  | 'custom';

export interface CheckOutcome {
  /** Stable within one report. */
  id: string;
  property: CheckProperty;
  /** `Deadlock freedom`, `No runtime errors`, `Terminates`, or the user's assertion. */
  label: string;
  /** A whole program (`main`) or one procedure checked on its own. */
  target: { kind: 'program' | 'procedure'; name: string; at?: SourceRef };
  status: 'passed' | 'failed' | 'error' | 'timeout' | 'cancelled' | 'skipped';
  /** How a failure should be presented: termination and determinism are informational, not defects. */
  severity: 'error' | 'warning' | 'info';
  stats?: { states?: number; transitions?: number; ms?: number };
  /** Error text, skip reason, or a note about the result. */
  message?: string;
  /**
   * What a passed check does not cover, each as a short phrase for a chip or a
   * lens (`only in runs within 0..3`, `the compiled program may differ`);
   * `message` says the same in full.
   */
  limits?: string[];
  counterexample?: Counterexample;
  /** The assertion as the tool ran it (CSPm for FDR). */
  assertion?: string;
}

export interface VerificationReport {
  version: 1;
  producer: 'checker' | 'fdr';
  /** The .pj document the results are about. */
  uri: string;
  /** Document version the results were computed for; stale once the buffer changes. */
  documentVersion?: number;
  tool?: { name: string; version?: string };
  /** Abstractions the producer made: integer range, timers, alt priority, unsupported constructs. */
  assumptions: string[];
  checks: CheckOutcome[];
}

/** Same spawn path: the identity used to match a result to a drawn process. */
export function samePath(a: ProcessPath, b: ProcessPath): boolean {
  return a.length === b.length && a.every((step, i) => sameSite(step, b[i]));
}

/** Whether `prefix` is an ancestor (or the same) instance of `path`. */
export function isPathPrefix(prefix: ProcessPath, path: ProcessPath): boolean {
  return prefix.length <= path.length && prefix.every((step, i) => sameSite(step, path[i]));
}

/**
 * Whether a drawn process (`pattern`) stands for the instance at `path`. A pattern
 * step without an index matches every index there: the graph draws a par for once
 * (x N) while FDR reports each iteration separately.
 */
export function pathMatches(pattern: ProcessPath, path: ProcessPath): boolean {
  return pattern.length === path.length && pattern.every((step, i) => sameSite(step, path[i], step.index === undefined));
}

function sameSite(a: SpawnSite, b: SpawnSite, anyIndex = false): boolean {
  return a.kind === b.kind
    && (anyIndex || a.index === b.index)
    && a.site.uri === b.site.uri
    && a.site.span.start.line === b.site.span.start.line
    && a.site.span.start.col === b.site.span.start.col
    && a.site.span.end.line === b.site.span.end.line
    && a.site.span.end.col === b.site.span.end.col;
}
