/**
 * What a ProcessJ -> CSPm translation produces: the CSPm text plus everything a
 * consumer needs to read FDR's answers back in ProcessJ terms (which definition
 * is which statement, which network leaf is which process instance, which
 * channel is which declaration, which assertion is which check).
 *
 * The model is built for FDR's `--divide` output. Every process instance of
 * the program (the root, every par branch, every par for iteration) is one
 * leaf of a static parallel network, and every state a leaf can stop in is a
 * named definition, so a counterexample names the exact statement each
 * process is at. `network` mirrors the generated parallel expression so the
 * leaves of FDR's tree can be matched to `processes` by position.
 */
import type { Span } from '../parser/ast';
import type { ChannelRef, CheckProperty, ProcessRef, SourceRef } from '../verification';

export interface CspModel {
  /** The generated CSPm file. */
  text: string;
  /** What was translated: a whole program (from `main`) or one procedure checked on its own (and the arguments it was checked with: CheckedWith.short). */
  target: { kind: 'program' | 'procedure'; name: string; at?: SourceRef; arguments?: string };
  /** The root process FDR checks (`MAIN` or `PROC_<name>`). */
  root: string;
  /** Integer range every byte/short/char/int/long value is modelled with, and where it came from. */
  intRange: { lo: number; hi: number; source: 'comment' | 'option' | 'inferred' };
  /** Abstractions the model makes, worded for a report. */
  assumptions: string[];
  /** Generated assertions plus the user's, in the order they appear in the file (FDR answers in that order). */
  assertions: CspAssertion[];
  sourceMap: CspSourceMap;
  /** Things the user should know: miscompilations the model does not reproduce, imprecisions, ignored code. */
  warnings: CspDiagnostic[];
  /**
   * Constructs the translator cannot model. When non-empty the model is incomplete:
   * consumers must not present any check as passed (fail closed).
   */
  unsupported: CspDiagnostic[];
  /**
   * A procedure checked on its own whose data parameters decide its network
   * (recursion depth, channel-array lengths, par for counts) is checked with
   * the arguments its calls give (or every modelled value that elaborates):
   * which ones, for the report, the lens and the diagnostics
   * (`altFIFO checked with size = 6 (the call at line 75)`).
   */
  checkedWith?: CheckedWith;
}

export interface CheckedWith {
  /** One sentence: `altFIFO checked with size = 6 (the call at line 75)`. */
  text: string;
  /** The same after `checked with`: `size = 6 (the call at line 75)`. */
  detail: string;
  /** Short, for a lens: `size = 6`. */
  short: string;
  /** Where the values come from. */
  source: 'calls' | 'directive' | 'range';
  /** Each instance checked: its arguments (`size = 6`), by parameter name, and the call sites that give them. */
  instances: Array<{ label: string; values: Record<string, number | boolean>; arrays: Record<string, number>; sites: SourceRef[] }>;
}

export interface CspDiagnostic {
  message: string;
  at?: SourceRef;
  /**
   * The checker lint this note comes from (`pj/par-for-body`), or for a
   * miscompilation no lint reports, `compiler/...` (miscompile.ts).
   */
  code?: string;
}

export interface CspAssertion {
  /** Stable within one model: `deadlock-free`, `no-runtime-errors`, `terminates`, `user-1`, ... */
  id: string;
  /** 0-based position among the file's assertions; FDR reports results in this order. */
  index: number;
  property: CheckProperty;
  label: string;
  /** Termination and determinism are informational: servers run forever, alts choose. */
  severity: 'error' | 'warning' | 'info';
  target: { kind: 'program' | 'procedure'; name: string; at?: SourceRef; arguments?: string };
  /** The assertion as written in the file (FDR echoes it with its own spacing). */
  assertion: string;
  /** For assertions written in the ProcessJ source: where. */
  at?: SourceRef;
  /** `assert not ...`: it holds when the property after `not` fails (FDR reports `is_negated`). */
  negated?: boolean;
}

/**
 * The checks every model asserts about its target, in the order the file
 * lists them (translate.ts writes their CSPm): also what a translation that
 * could not produce a model would have been checked for.
 */
export const STANDARD_CHECKS: Readonly<Record<'program' | 'procedure', ReadonlyArray<Pick<CspAssertion, 'id' | 'property' | 'label' | 'severity'>>>> = Object.freeze({
  program: Object.freeze([
    { id: 'deadlock-free', property: 'deadlock-free', label: 'Deadlock freedom', severity: 'error' },
    { id: 'no-runtime-errors', property: 'no-runtime-errors', label: 'No runtime errors', severity: 'error' },
    { id: 'terminates', property: 'terminates', label: 'Terminates', severity: 'info' },
  ] as const),
  procedure: Object.freeze([
    { id: 'deadlock-free', property: 'deadlock-free', label: 'Deadlock freedom', severity: 'error' },
    { id: 'divergence-free', property: 'divergence-free', label: 'Divergence freedom', severity: 'error' },
    { id: 'no-runtime-errors', property: 'no-runtime-errors', label: 'No runtime errors', severity: 'error' },
    { id: 'deterministic', property: 'deterministic', label: 'Deterministic', severity: 'info' },
  ] as const),
});

export interface CspSourceMap {
  /** Every generated process definition, by CSPm name. */
  definitions: Record<string, CspDefinitionInfo>;
  /** Every CSPm channel the model declares, by name. */
  channels: Record<string, CspChannelInfo>;
  /** `pj_error` constructors: the runtime error each one stands for. */
  errors: Record<string, CspErrorSite>;
  /** Every leaf of the process network, in the left-to-right order of `network`. */
  processes: CspProcessInfo[];
  /** The generated parallel composition, root first. */
  network: CspNetworkNode;
  /**
   * The named definition FDR shows for the top of `network` (the hiding of the
   * internal events): `MAIN`, the checked procedure's name, or `PJ_RUN` when a
   * checked procedure takes data arguments (one `PJ_RUN(...)` per argument value).
   */
  networkRoot: string;
  /**
   * A procedure checked once per argument tuple (CspModel.checkedWith): each
   * instance's own network (`PJ_RUN_1`, ...) and processes, in instance
   * order; `network`, `networkRoot` and `processes` are the first one's.
   * explain.ts reads a counterexample against the instance that ran it.
   * `call`: the fields of its `pj_call` event, a field it leaves to the
   * caller undefined.
   */
  instances?: Array<{ label: string; networkRoot: string; network: CspNetworkNode; processes: CspProcessInfo[]; call?: Array<string | undefined> }>;
  /** Record and protocol constructors, so values in events read back in ProcessJ terms. */
  constructors: Record<string, CspConstructor>;
  /**
   * The CSPm the user wrote (`/*@csp` blocks, `//@csp assert` lines): where it
   * is in the generated file (1-based `line`, `lines` long) and in the source
   * (`sourceLine`, 0-based, is the source line of the first generated line),
   * so an FDR error in it is reported at the user's own text.
   */
  user: Array<{ line: number; lines: number; at: SourceRef; sourceLine: number }>;
  /**
   * Every way the body of a procedure's definition goes on to another state:
   * the references the generated CSPm makes from one definition to the next
   * (or to the end), recorded as the body is generated. With `definitions`
   * they are each procedure's communication state machine (machine.ts).
   */
  transitions?: CspTransition[];
}

/** One path through a definition's body to the next state, as generated (gen.ts). */
export interface CspTransition {
  /** The definition the path starts in. */
  from: string;
  /**
   * Where it leads: another definition, `STOP` (a stop statement, a runtime
   * error), or `pj_k` (the procedure's continuation: it returns to its caller).
   */
  to: string;
  /** What the process does on the way, in order: the definition's own operation first. */
  via: CspTransitionStep[];
  /**
   * The path passes a condition the translation leaves to FDR (an if or a
   * loop test, an alt guard's precondition, a range or runtime check):
   * taken only in the runs where it holds, possibly none.
   */
  conditional: boolean;
  /** For an alt: the guard (0-based, in source order) the path starts with. */
  guard?: number;
  /** A call on the way: the callee's entry definition. `to` is where the caller goes on after it returns. */
  call?: string;
}

export interface CspTransitionStep {
  /** `test`: a condition the model leaves to FDR, and which way the path takes it. */
  kind: 'write' | 'read' | 'ack' | 'sync' | 'go' | 'skip' | 'timeout' | 'enroll' | 'fork' | 'join' | 'resign' | 'tick' | 'call' | 'test' | 'error' | 'stop';
  /** The ProcessJ channel or barrier variable, the callee, the condition's source text, or the runtime error. */
  name?: string;
  /** For a test: whether the path is the one where the condition holds. */
  holds?: boolean;
  /** For a join: the branch it collects (1-based); absent for a par for. */
  branch?: number;
  at?: SourceRef;
}

export interface CspConstructor {
  kind: 'record' | 'protocol' | 'null';
  /** Record name, or the protocol the case belongs to; the family's root for `null`. */
  type: string;
  /** Protocol case. */
  tag?: string;
  /** Field names in order: the constructor is followed by one value per field. */
  fields: string[];
}

export type CspDefinitionKind =
  /** First definition of a procedure body (`delta__body`). */
  | 'entry'
  /** A blocking program point: communication, sync, alt, par, call, loop head or join point. */
  | 'point'
  /** A par branch or par for iteration waiting to be started (`delta__par24_1`). */
  | 'slot'
  /** A branch or iteration that has finished and waits for its parent to collect it. */
  | 'branch-end'
  /** The parent of a par waiting for one of its branches (`main__42_join2`). */
  | 'join'
  /** The process a procedure runs standalone (procedure checks and user specifications). */
  | 'process'
  /** Library processes: barriers, joins. */
  | 'helper';

export interface CspDefinitionInfo {
  name: string;
  kind: CspDefinitionKind;
  /** ProcessJ procedure whose code the definition belongs to. */
  procedure?: string;
  /** The operation a process stopped in this definition is about to perform (or performing, for joins). */
  at?: SourceRef;
  /** The enclosing statement, when it differs from `at`. */
  statement?: SourceRef;
  /** First line of the source text of `statement ?? at`, trimmed. */
  text?: string;
  operation?: CspOperation;
  /** Parameters in order: what each one carries. */
  params: CspParam[];
  /** For slots and branch ends: the spawn site the slot stands for. */
  spawn?: { kind: 'branch' | 'par-for'; site: SourceRef; index?: number; par: SourceRef };
  /**
   * The par branch or par for body whose process runs this definition, named
   * like `spawn`; absent for the procedure's own thread.
   */
  region?: { kind: 'branch' | 'par-for'; site: SourceRef; index?: number };
  /** `stop` statements the definition's body can reach: a process stopped there is in FDR's state `STOP`, after this definition. */
  stops?: SourceRef[];
  /**
   * What a process in this definition may still do (CspUse.site keys of the
   * operations, and of the pars it may start, its callees' included): an
   * over-approximation, so an operation not in it can never happen again.
   * For a slot or branch end it is what the branch does if started again.
   */
  reach?: string[];
  /** The definition can reach the end of its procedure (it goes on in its continuation, `pj_k`) or of its branch. */
  exits?: boolean;
  /** Slots and branch ends: the site key of the par that starts them; they run again only if their parent can reach it. */
  restart?: string;
}

export interface CspOperation {
  kind: 'read' | 'write' | 'extended-read' | 'ack' | 'sync' | 'alt' | 'par' | 'par-for' | 'join' | 'call' | 'loop' | 'internal';
  /** Name of the CSPm parameter or channel that carries the operation (`out1`, `a`). */
  channel?: string;
  /**
   * The parameter or channel the operation's own event is on, when that is
   * not `channel`: a mediated read takes from `in__take`, a writer held for an
   * acknowledgement waits on `out__ack`. FDR shows a parameter the definition
   * does not use as `_`, so this is how the channel is found then.
   */
  via?: string;
  /** ProcessJ variable the operation goes through (`out1`, `c`). */
  variable?: string;
  /**
   * For alts: one entry per guard, in source order. `pre` is the guard's
   * precondition in the definition's terms: `true`, `false` or the name of
   * the parameter holding it (absent when it is computed inside a replicated alt).
   */
  guards?: Array<{ kind: 'read' | 'skip' | 'timeout'; channel?: string; via?: string; variable?: string; at: SourceRef; precondition?: boolean; pre?: string }>;
  /** For a join: the branch (1-based) or iteration it waits for. */
  branch?: number;
  /** For an acknowledgement: the reader sends it when its extended rendezvous block is done, the writer waits for it. */
  role?: 'reader' | 'writer';
}

export interface CspParam {
  /** CSPm parameter name. */
  name: string;
  role: 'instance' | 'iteration' | 'channel' | 'ack' | 'barrier' | 'value' | 'continuation';
  /** ProcessJ variable the parameter holds, when it is one. */
  variable?: string;
}

export interface CspChannelInfo {
  name: string;
  role:
    /** A ProcessJ channel (`chan<T> c` or a harness channel standing for a parameter). */
    | 'channel'
    /** The acknowledgement of a channel read with extended rendezvous. */
    | 'ack'
    /** A ProcessJ barrier (runtime protocol: sync, go, enroll, resign). */
    | 'barrier'
    | 'error'
    /** Bookkeeping: fork, join, end, tick, skip and timeout guards, termination marker. */
    | 'internal';
  /** The ProcessJ declaration, for channels and barriers. `owner` is [] for the root; other instances are per leaf. */
  ref?: ChannelRef;
  /** ProcessJ element type (`int`, `Message`). */
  elementType?: string;
  /** For ack channels: the channel they acknowledge. */
  of?: string;
  /** Hidden from the root's traces (local to a procedure, or bookkeeping). */
  hidden: boolean;
  /** Stands for a channel parameter of the checked procedure: its other side is the procedure's caller (FDR's environment). */
  harness?: boolean;
  /** For internal channels: what an event on it means. */
  meaning?: string;
  /** The first field is the procedure instance (`b.1.pj_sync`, `pj_fork_delta_24_1.1.4`), not data. */
  instanced?: boolean;
  /** Fork and join channels: the ProcessJ variables the fields after the instance carry. */
  fields?: string[];
  /** Fork and join channels: what they start or collect. */
  spawns?: 'branches' | 'iterations';
  /** An array of channels: its length (the CSPm channel's first field is the element, 0 to array - 1). */
  array?: number;
  /**
   * One channel of an array (`cs.2`), or a local channel of one instance of a
   * recursive procedure (`m.3`, its first field the instance), or both
   * (`cs.3.2`): an entry of its own, named by the event's leading fields.
   * `channel` is the CSPm channel it is part of.
   */
  part?: { channel: string; instance?: number; index?: number };
  /**
   * A par for fork with computed bounds: the first two fields after the
   * instance are the first and the last iteration value (first > last when
   * there is none); the iterations outside them do not exist in that run.
   */
  computedBounds?: boolean;
}

export interface CspErrorSite {
  /** `range` (a value outside the modelled integers), `division-by-zero`, `array-index`, `null`, `alt-preconditions`. */
  kind: string;
  message: string;
  at: SourceRef;
  procedure: string;
}

export interface CspProcessInfo {
  /** Position of the leaf in `network`, as child indices from the root. */
  position: number[];
  /** The leaf exactly as written in the network (`delta__par24_1(1, a)`). */
  leaf: string;
  definition: string;
  args: string[];
  /** `barrier`: a barrier's runtime counter (PJ_BAR); `channel`: a mediated channel's server (PJ_MED). */
  kind: 'root' | 'branch' | 'iteration' | 'barrier' | 'channel';
  /** The ProcessJ process instance (identity per src/verification.ts). Absent for servers. */
  process?: ProcessRef;
  /** For servers: the barrier or channel they serve. */
  barrier?: ChannelRef;
  /** For servers: the resource key (CspUse.resource) of the barrier or channel instance they serve. */
  resource?: string;
  /** For a process that is a call: the data arguments elaboration knows (`size = 4`), which tell instances apart. */
  known?: string;
  /**
   * What the CSPm channels this leaf uses stand for in this instance. Local
   * channels of a procedure share one CSPm name across instances; this map
   * says which declaration instance it is for this leaf.
   */
  channels: Record<string, ChannelRef>;
  /**
   * Every channel and barrier operation in the code this process runs itself
   * (its callees included, not the processes it starts), with where it is:
   * who could be the partner of a stuck operation, and where that partner
   * would have to be.
   */
  uses: CspUse[];
  /** Barriers the par that starts this process enrolls it on (it resigns when it ends). */
  enrolled: Array<{ channel: string; ref: ChannelRef; resource?: string }>;
}

export interface CspUse {
  /** CSPm channel (base name) the operation's events are on. */
  channel: string;
  op: 'read' | 'write' | 'sync';
  /** The operation (for an alt guard: the guard). */
  at?: SourceRef;
  /** ProcessJ procedure whose code it is. */
  procedure: string;
  /** The declaration instance the operation is on. */
  ref?: ChannelRef;
  /**
   * The channel or barrier instance, exactly: the declaration in one procedure
   * instance and, for one declared in a par for body, one iteration. ChannelRef
   * (the src/verification.ts identity) cannot tell the iterations apart.
   */
  resource?: string;
  /** The operation's program point (`<procedure>#<node>`), as definitions' `reach` lists it. */
  site?: string;
  /**
   * The end of an extended rendezvous (or of a read from a channel server):
   * the reader says it is done with the value (op `read`), the writer waits
   * for that (op `write`). Not a read or write of its own.
   */
  ack?: boolean;
}

export type CspNetworkNode =
  | { kind: 'leaf'; process: number }
  | { kind: 'parallel'; sync: string; left: CspNetworkNode; right: CspNetworkNode }
  /** A named definition whose body is the subtree (FDR shows its name in `--divide`). */
  | { kind: 'named'; name: string; child: CspNetworkNode }
  | { kind: 'hide'; hidden: string; child: CspNetworkNode }
  /**
   * `child [| events |] STOP`: a process whose own operations on these channels
   * have no partner anywhere in the program; they block (FDR shows a parallel
   * of the process and STOP).
   */
  | { kind: 'block'; events: string; child: CspNetworkNode }
  /**
   * `child [| events |> SKIP`: the program ends when the root's `pj_end`
   * happens (no process of the network ends in SKIP: distributed termination
   * of many SKIPs costs FDR exponentially). FDR shows a node with the child
   * and SKIP.
   */
  | { kind: 'exception'; events: string; child: CspNetworkNode }
  /**
   * `sbisim(diamond(child \ hidden))` (the `compress` option): FDR shows one
   * machine for the whole part, so its processes have no states of their own.
   */
  | { kind: 'compressed'; name: string; hidden: string; child: CspNetworkNode };

/** Options a caller may pass; everything has a default. */
export interface TranslateOptions {
  /** Integer range to model, overriding the source's `//@csp int lo..hi` and inference. */
  intRange?: { lo: number; hi: number };
  /** Largest inferred range (number of values); wider literal sets are clamped with a warning. Default 64. */
  maxInferredValues?: number;
  /** Largest number of network leaves before the translation gives up. Default 2000. */
  maxProcesses?: number;
  /**
   * Compress every sub-network (hide what it does inside, then sbisim(diamond(...))):
   * far smaller state spaces for big networks, coarser counterexamples. Also `//@csp compress`.
   */
  compress?: boolean;
}

export function spanKey(span: Span): string {
  return `${span.start.line}:${span.start.col}-${span.end.line}:${span.end.col}`;
}
