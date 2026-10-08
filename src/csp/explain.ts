/**
 * FDR's answers in ProcessJ terms: a VerificationReport (src/verification.ts).
 *
 * Every assertion of the model becomes a CheckOutcome. A counterexample is
 * read with --divide's per-process behaviours (fdr.ts matches them to the
 * model's processes) and the model's source map:
 *
 * - each step of the trace says which processes took part, in which role,
 *   at which statement (the named definition each was in before the step),
 *   with the value in ProcessJ terms;
 * - each process ends terminated, not started, blocked (on the statement of
 *   the definition it stopped in, waiting for exactly the events FDR says it
 *   still offers), stopped by a runtime error, or diverging;
 * - each wait names the processes that could complete it (the other users of
 *   the same channel instance, the other processes enrolled on a barrier, the
 *   branches a par still waits for) and why they cannot: terminated, blocked
 *   elsewhere, not started, or nobody at all;
 * - waits that go round in a circle are listed as cycles.
 *
 * Nothing here talks to FDR or to an editor: explain() is a pure function of
 * the model and refines' parsed output, so it is tested on recorded output.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChannelRef, CheckOutcome, Counterexample, ProcessRef, ProcessSnapshot, SourceRef, TraceStep, VerificationReport, WaitInfo } from '../verification';
import { isPathPrefix, samePath } from '../verification';
import { loopStart, networkBehaviour, parseState, type FdrBehaviour, type FdrCounterexample, type FdrResult, type FdrRun, type LeafBehaviour } from './fdr';
import { STANDARD_CHECKS, type CspAssertion, type CspChannelInfo, type CspDefinitionInfo, type CspModel, type CspOperation, type CspProcessInfo, type CspUse } from './model';

export interface ExplainOptions {
  /** The document the report is about (the LSP URI of the .pj file). */
  uri: string;
  documentVersion?: number;
  /** Why FDR was not run (it is not installed, the run was not wanted): every check is skipped with this reason. */
  notRun?: string;
}

/** Turn a model and refines' output into a report. `run` is undefined when FDR did not run (see `notRun`). */
export function explain(model: CspModel, run: FdrRun | undefined, opts: ExplainOptions): VerificationReport {
  const assumptions = [...model.assumptions];
  for (const w of model.warnings) assumptions.push(`${w.at ? `${where(w.at, opts.uri)}: ` : ''}${w.message}`);
  for (const u of model.unsupported) assumptions.push(`Not modelled${u.at ? ` (${where(u.at, opts.uri)})` : ''}: ${u.message}`);
  const results = run ? matchResults(model.assertions, run.results) : [];
  // A translation that produced no model at all (too many processes) asserts nothing: the checks it
  // would have made are each not checked, rather than the report holding no check (which reads as no failure).
  const assertions = model.assertions.length || !model.unsupported.length
    ? model.assertions
    : STANDARD_CHECKS[model.target.kind].map((check, index): CspAssertion => ({ ...check, index, target: model.target, assertion: '' }));
  const checks = assertions.map((a, i) => outcome(model, a, results[i], run, opts));
  qualify(model, checks, opts.uri);
  return {
    version: 1,
    producer: 'fdr',
    uri: opts.uri,
    documentVersion: opts.documentVersion,
    tool: { name: 'FDR', version: run?.version },
    assumptions,
    checks,
  };
}

/** An assertion as text to compare: FDR reprints assertions without redundant parentheses and with its own spacing. */
export function normalizeAssertion(text: string): string {
  return text.replace(/[\s()]/g, '');
}

/**
 * FDR's result for each assertion of the model, matched by text in file
 * order: an assertion FDR did not report gets none (it is never given the
 * next one's answer), and results of assertions the model does not list (in
 * a file a block includes) are skipped. Only when no text matches at all
 * (FDR printed every assertion differently) is the order alone trusted.
 */
export function matchResults(assertions: CspAssertion[], results: FdrResult[]): Array<FdrResult | undefined> {
  const out: Array<FdrResult | undefined> = [];
  let next = 0;
  let matched = 0;
  for (const a of assertions) {
    const want = normalizeAssertion(a.assertion);
    let k = next;
    while (k < results.length && normalizeAssertion(results[k].assertion) !== want) k++;
    if (k < results.length) {
      out.push(results[k]);
      next = k + 1;
      matched++;
    } else out.push(undefined);
  }
  if (!matched && results.length === assertions.length) return [...results];
  return out;
}

/**
 * FDR's file-level errors in the user's terms: an error inside a `/*@csp`
 * block or a `//@csp assert` is the user's specification, at its line of the
 * .pj file; anything else is the generated model (a translator bug).
 */
export function specErrors(model: Pick<CspModel, 'sourceMap'>, errors: string[]): Array<{ message: string; at?: SourceRef; user: boolean }> {
  // FDR's messages are laid out over several lines and end with a note about stack traces.
  const tidy = (t: string): string => t.replace(/\s*Lexical call stack:[\s\S]*$/, '').replace(/\s+/g, ' ').trim();
  return errors.map((e) => {
    const m = /^(?:\.\/)?[^\s:]*\.csp:(\d+):(\d+)(?:-(\d+))?(?::(\d+)(?:-(\d+))?)?:\s*([\s\S]*)$/.exec(e.trim());
    if (!m) return { message: tidy(e), user: false };
    const line = Number(m[1]);
    const text = tidy(m[6]);
    const block = (model.sourceMap.user ?? []).find((u) => line >= u.line && line < u.line + u.lines);
    if (!block) return { message: text, user: false };
    const sourceLine = block.sourceLine + (line - block.line);
    const col = Math.max(0, Number(m[2]) - 1);
    return { message: text, user: true, at: { uri: block.at.uri, span: { start: { line: sourceLine, col: line === block.line ? 0 : col }, end: { line: sourceLine, col: col + 1 } } } };
  });
}

function outcome(model: CspModel, a: CspAssertion, r: FdrResult | undefined, run: FdrRun | undefined, opts: ExplainOptions): CheckOutcome {
  const base: CheckOutcome = {
    id: a.id,
    property: a.property,
    label: a.label,
    target: a.target,
    status: 'skipped',
    severity: a.severity,
    ...(a.assertion ? { assertion: a.assertion } : {}),
  };
  if (model.unsupported.length) {
    // Fail closed: a check of an incomplete model proves nothing either way.
    const first = model.unsupported[0];
    return { ...base, status: 'skipped', message: `not checked: the model is incomplete (${first.message}${first.at ? `, ${where(first.at, opts.uri)}` : ''}${model.unsupported.length > 1 ? `, and ${model.unsupported.length - 1} more` : ''})` };
  }
  if (!run) return { ...base, status: 'skipped', message: opts.notRun ?? 'FDR was not run' };
  const stats = r ? { states: r.states, transitions: r.transitions, ms: r.ms } : undefined;
  if (!r) {
    if (run.aborted) return { ...base, status: 'cancelled', message: 'the check was cancelled' };
    if (run.timedOut) {
      const secs = (run.durationMs / 1000).toFixed(run.durationMs < 10_000 ? 1 : 0);
      return { ...base, status: 'timeout', message: `FDR did not finish within ${secs} s: the model may have more states than FDR can explore in that time. Check one procedure at a time, add //@csp compress, lower the loop and par for bounds, or allow more time (fdrTimeoutMs)` };
    }
    if (run.memoryExceeded) return { ...base, status: 'timeout', message: `FDR was stopped after using more than ${formatBytes(run.memoryExceeded)} of memory: the model has more states than this machine can hold. Check one procedure at a time, add //@csp compress, lower the loop and par for bounds, or allow more memory (fdrMemoryMb)` };
    if (run.errors.length) {
      const found = specErrors(model, run.errors);
      const user = found.find((x) => x.user);
      if (user) return { ...base, status: 'error', message: `FDR could not check this: your CSPm specification has an error${user.at ? ` (${where(user.at, opts.uri)})` : ''}: ${user.message}` };
      return { ...base, status: 'error', message: `FDR rejected the generated model (a bug in the translation to CSP; please report it with this file): ${found.map((x) => x.message).join('\n')}` };
    }
    if (run.results.length) return { ...base, status: 'error', message: 'FDR did not report this assertion (its result is missing from refines\' output)' };
    const why = run.stderr.trim() || `refines exited with code ${run.exitCode}`;
    return { ...base, status: 'error', message: `FDR could not check this: ${why}` };
  }
  if (r.passed === undefined) {
    // An error in this one assertion (a user's naming a value outside a channel's type).
    const found = specErrors(model, r.errors);
    const user = found.find((x) => x.user);
    const message = user ? `your CSPm specification has an error${user.at ? ` (${where(user.at, opts.uri)})` : ''}: ${user.message}` : found.map((x) => x.message).join('; ');
    return { ...base, status: 'error', stats, message: message || 'FDR could not decide this assertion' };
  }
  const raw = r.counterexamples[0] as FdrCounterexample | undefined;
  if (a.negated || r.negated) {
    // `assert not P ...` holds when P's property fails; the counterexample FDR found for P shows how.
    const inner = a.assertion.replace(/^not\s*/, '');
    if (!r.passed) return { ...base, status: 'failed', stats, message: `does not hold: ${inner} holds${r.states !== undefined ? ` (${r.states.toLocaleString('en-US')} states)` : ''}` };
    if (!raw) return { ...base, status: 'passed', stats, message: `holds: ${inner} does not` };
    const witness = new Explainer(model, run.eventMap, opts.uri).counterexample({ ...a, label: inner, assertion: inner }, raw);
    return { ...base, status: 'passed', stats, message: `holds: ${inner} does not (${witness.summary})`, counterexample: witness };
  }
  if (r.passed) return { ...base, status: 'passed', stats, message: passedMessage(a, r) };
  if (!raw) return { ...base, status: 'failed', stats, message: `${a.label} does not hold (FDR gave no counterexample)` };
  const counterexample = new Explainer(model, run.eventMap, opts.uri).counterexample(a, raw);
  // A user's `:[deadlock free]` that fails only because the program ends: not a defect of the program.
  const ends = counterexample.kind === 'deadlock' && counterexample.final.length > 0 && counterexample.final.every((p) => p.status === 'terminated');
  return { ...base, status: 'failed', stats, message: counterexample.summary, counterexample, ...(ends && a.at ? { severity: 'info' as const } : {}) };
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/**
 * Lints saying the compiled program does not do what the language, and so the
 * model, does there (or that this ProcessJ build cannot compile it): a verdict
 * about the model may not hold for the program the build makes.
 */
export const COMPILED_DIFFERS: ReadonlySet<string> = new Set([
  'pj/shared-unlocked-end',
  'pj/shared-channel-end',
  'pj/par-for-body',
  'pj/starving-loop',
  'pj/multiple-alts',
  'pj/compiler-limit',
  'compiler/loop-labels',
  'compiler/par-loop-calls',
  'compiler/stop-ignored',
  'compiler/short-circuit-read',
  'compiler/replicated-alt-precondition',
  'compiler/labelled-break',
]);

/** Places where the model's own abstraction may differ from any program: an array or record shared between references (lower.ts). */
export const MODEL_DIFFERS: ReadonlySet<string> = new Set(['model/aliasing']);

/**
 * What one check says about the others. A range error ends the runs it is in
 * (an error stops the program), so the other verdicts cover only the runs
 * that stay inside the modelled integers; it is the model's limit, not an
 * error of the program, so it is presented as a warning. Where the compiled
 * program differs from the language, a verdict says so.
 */
function qualify(model: CspModel, checks: CheckOutcome[], uri: string): void {
  const range = checks.find((c) => c.property === 'no-runtime-errors' && c.status === 'failed' && c.counterexample?.error?.kind === 'range');
  if (range) range.severity = 'warning';
  const compiled = model.warnings.filter((w) => w.code && COMPILED_DIFFERS.has(w.code));
  const abstracted = model.warnings.filter((w) => w.code && MODEL_DIFFERS.has(w.code));
  const behaviour = new Set<CheckOutcome['property']>(['deadlock-free', 'terminates', 'divergence-free', 'no-runtime-errors']);
  for (const c of checks) {
    if (!behaviour.has(c.property)) continue;
    if (c.status === 'passed') {
      // The same qualifications as short phrases, for a chip or a lens.
      const limits: string[] = [];
      if (range && c !== range && c.property !== 'no-runtime-errors') {
        c.message = `${c.message}, in the runs that stay inside the modelled integers ${model.intRange.lo}..${model.intRange.hi} (see ${range.label})`;
        limits.push(`only in runs within ${model.intRange.lo}..${model.intRange.hi}`);
      }
      if (compiled.length) {
        c.message = `${c.message}; the compiled program may differ (${sitesText(compiled, uri)})`;
        limits.push('the compiled program may differ');
      }
      if (abstracted.length) {
        c.message = `${c.message}; the program may differ where it shares an array or record between references, which the model copies (${sitesText(abstracted, uri)})`;
        limits.push('shared arrays or records may differ');
      }
      if (limits.length) c.limits = limits;
    } else if (c.status === 'failed' && c.counterexample && (compiled.length || abstracted.length)) {
      const notes = [...compiled, ...abstracted].map((w) => `${w.code}${w.at ? ` (${where(w.at, uri)})` : ''}: ${w.message.split(' — ').pop()}`);
      c.counterexample.caveats = [...new Set([...(c.counterexample.caveats ?? []), ...notes])];
    }
  }
}

/** `pj/shared-channel-end at lines 140, 141 and 153`: each code once, with where it is. */
function sitesText(warnings: CspModel['warnings'], uri: string): string {
  const byCode = new Map<string, string[]>();
  for (const w of warnings) {
    const places = byCode.get(w.code!) ?? [];
    const at = w.at ? where(w.at, uri) : undefined;
    if (at && !places.includes(at)) places.push(at);
    byCode.set(w.code!, places);
  }
  return [...byCode].map(([code, places]) => {
    if (!places.length) return code;
    const lines = places.map((p) => p.replace(/^line /, ''));
    const shown = lines.length > 3 ? `${lines.slice(0, 3).join(', ')} and ${lines.length - 3} more` : lines.length > 1 ? `${lines.slice(0, -1).join(', ')} and ${lines[lines.length - 1]}` : lines[0];
    return `${code} at line${places.length > 1 ? 's' : ''} ${shown}`;
  }).join('; ');
}

function passedMessage(a: CspAssertion, r: FdrResult): string {
  const states = r.states !== undefined ? `${r.states.toLocaleString('en-US')} state${r.states === 1 ? '' : 's'}` : 'every state';
  switch (a.property) {
    case 'deadlock-free':
      return `no deadlock in ${states}`;
    case 'no-runtime-errors':
      return `no runtime error in ${states}`;
    case 'terminates':
      return 'always terminates';
    case 'divergence-free':
      return `no divergence in ${states}`;
    case 'deterministic':
      return 'deterministic';
    default:
      return `holds (${states})`;
  }
}

// ---------------------------------------------------------------------------
// One counterexample
// ---------------------------------------------------------------------------

interface Proc {
  index: number;
  info: CspProcessInfo;
  ref: ProcessRef;
  name: string;
  leaf?: LeafBehaviour;
  /** Filled by snapshot(). */
  snap?: ProcessSnapshot;
  /** Took part in at least one step (a par for iteration outside its computed bounds takes part in none). */
  active: boolean;
  /** A par for iteration that does not exist in this run: every fork it saw had computed bounds without it. */
  absent?: boolean;
}

interface Bound {
  def?: CspDefinitionInfo;
  name: string;
  env: Map<string, string>;
}

interface Edge {
  to: number;
  channel?: ChannelRef;
}

/** What a wait can expect from one possible partner. */
type PartnerState = NonNullable<WaitInfo['partner']>['state'];

class Explainer {
  private readonly procs: Proc[] = [];
  private readonly servers: Array<{ info: CspProcessInfo; leaf?: LeafBehaviour }> = [];
  private edges = new Map<number, Edge[]>();
  /** The branches (or iterations) each join wait is for: the ones its par has not collected and that have not finished. */
  private readonly joinChildren = new Map<WaitInfo, Proc[]>();
  /** The counterexample is a run that repeats forever (from loopStart on): processes outside the repeating steps never move again. */
  private lasso = false;
  /**
   * The check hides every event (`SKIP [FD= MAIN \ Events`, the termination
   * check): FDR's trace is all τ, so what the outside saw is the model's own
   * hiding (PJ_HIDDEN), not the check's.
   */
  private hidesEverything = false;
  /** Par for iterations seen inside (and outside) the computed bounds of a fork they took part in. */
  private readonly inRange = new Set<Proc>();
  private readonly outOfRange = new Set<Proc>();
  /** The bounds of each par for's latest fork, by fork channel and procedure instance. */
  private readonly ranges = new Map<string, { lo: number; hi: number }>();
  /** What each process may still do (reach.ts), once computed. */
  private readonly reachCache = new Map<Proc, Set<string> | undefined>();
  /** Each step's position in FDR's trace (where the leaves' behaviours are). */
  private readonly positions = new Map<TraceStep, number>();
  /** The other way round: the step (0-based) at each position of FDR's trace that is one. */
  private readonly stepAtPosition = new Map<number, number>();
  /** Writes held for the reader to finish its extended rendezvous: the reader's end of it answers them. */
  private readonly ackWaits = new Set<WaitInfo>();
  private readonly reachBusy = new Set<Proc>();

  constructor(
    private readonly model: CspModel,
    private readonly eventMap: Record<string, string>,
    private readonly uri: string,
  ) {}

  counterexample(a: CspAssertion, raw: FdrCounterexample): Counterexample {
    const kind = this.kindOf(a, raw);
    this.hidesEverything = a.property === 'terminates';
    const impl = raw.implementation_behaviour;
    // An assertion about other processes (a user's specification) has no network to read.
    const net = networkBehaviour(this.model, raw, this.eventMap);
    if (net) this.setUp(net.leaves);
    const top = impl?.trace ?? [];
    const rawLoop = kind === 'divergence' || raw.type === 'refinement_divergence' || raw.type === 'divergence' ? loopStart(impl) : undefined;
    this.lasso = rawLoop !== undefined;
    // A position where the implementation takes no part (0: FDR aligns it with the specification's
    // steps in a determinism counterexample) is not a step of the program.
    const positions = top.flatMap((id, k) => (id === 0 ? [] : [k]));
    const steps = positions.map((k, i) => {
      const step = this.step(k, top[k]);
      step.index = i;
      this.positions.set(step, k);
      this.stepAtPosition.set(k, i);
      return step;
    });
    const loop = rawLoop === undefined ? undefined : Math.max(0, positions.findIndex((k) => k >= rawLoop));
    // Who really took part: a par for iteration outside its computed bounds joins the fork but never runs.
    for (const p of this.procs) {
      p.active = steps.some((s) => s.participants.some((x) => x.process === p.ref));
      if (this.outOfRange.has(p) && !this.inRange.has(p)) p.absent = true;
    }
    // These counterexamples end in a state where nothing can happen: every process is stuck.
    const stuck = raw.type === 'deadlock' || (kind === 'no-termination' && raw.type === 'failure');
    const errorProc = this.procs.find((p) => p.leaf?.errorEvent?.startsWith('pj_error.') || p.leaf?.steps.some((e) => e?.startsWith('pj_error.')));
    const errorEvent = errorProc?.leaf?.errorEvent ?? errorProc?.leaf?.steps.find((e) => e?.startsWith('pj_error.')) ?? (impl?.error_event ? this.eventName(impl.error_event) : undefined);
    const error = errorEvent?.startsWith('pj_error.') ? this.errorInfo(errorEvent) : undefined;
    for (const p of this.procs) p.snap = this.snapshot(p, { stuck, loop: this.lasso, diverges: kind === 'divergence', errorProc });
    // Who could answer each wait, and why they do not. In a run that repeats forever the processes
    // outside the repeating steps are stuck too, beside the ones that keep running.
    for (const p of this.procs) this.partners(p);
    // The states each process went through, in FDR's own names.
    for (const p of this.procs) {
      const trail = this.trail(p, positions);
      if (p.snap && trail.length) p.snap.trail = trail;
    }
    const cycles = this.cycles();
    // A par waits for every branch it has not collected: which of them keeps it waiting is known once the circles are.
    for (const p of this.procs) this.joinPartners(p, cycles);
    const final = this.procs.filter((p) => !p.absent).map((p) => p.snap!);
    const cx: Counterexample = {
      kind,
      steps,
      final,
      summary: '',
    };
    if (loop !== undefined) cx.loopStart = loop;
    if (cycles.length) cx.cycles = cycles;
    if (error) cx.error = error;
    cx.summary = this.summary(a, kind, raw, cx, errorProc);
    const caveats = this.caveats(steps);
    if (caveats.length) cx.caveats = caveats;
    return cx;
  }

  /**
   * Where the run relies on what the model abstracts: an alt that takes a skip
   * or timeout guard (the runtime takes the first ready guard in source order,
   * and a timeout only after its deadline), or an abstract value deciding what
   * a process does.
   */
  private caveats(steps: TraceStep[]): string[] {
    const out = new Set<string>();
    for (const step of steps) {
      const p = this.procs.find((q) => step.participants[0] && q.ref === step.participants[0].process);
      const at = step.participants[0]?.at;
      const where = at ? ` at ${this.where(at)}` : '';
      if (step.event === 'pj_skip' || step.event === 'pj_timeout') {
        const b = p ? this.bind(p.leaf?.at[this.positions.get(step) ?? step.index]) : undefined;
        const guards = b?.def?.operation?.guards ?? [];
        const mine = guards.findIndex((g) => !!at && sameSpan(g.at.span, at.span));
        // Read guards written before this one that could be chosen (a false precondition rules one out).
        const earlier = guards.slice(0, mine < 0 ? guards.length : mine).filter((g) => g.kind === 'read' && (!b || this.guardEnabled(b, g) !== false));
        if (step.event === 'pj_timeout') {
          out.add(`${p?.name ?? 'a process'} takes the timeout guard${where} (step ${step.index + 1}): time is abstract, so the model lets a timeout end at any moment; the runtime ends it only once its deadline has passed`);
          step.caveat = 'the real program takes the timeout only once its deadline has passed';
        } else if (earlier.length) {
          out.add(`${p?.name ?? 'a process'} takes the skip guard${where} (step ${step.index + 1}): ProcessJ takes the first ready guard in source order, so the real program does this only while no guard written before it is ready`);
          step.caveat = `the real program takes the skip guard only while ${listText(earlier.map((g) => `${g.variable ?? g.channel} has no writer ready`))}`;
        }
      } else if (step.event === 'τ' && p) {
        out.add(`a value the model abstracts (a string, a real, a timer reading or a random number) decides what ${p.name} does${where} (step ${step.index + 1}): every outcome is explored, so this one may never happen with the real values`);
        step.caveat = 'a value the model abstracts decides this; the real values may never do it';
      }
    }
    return [...out];
  }

  private kindOf(a: CspAssertion, raw: FdrCounterexample): Counterexample['kind'] {
    switch (a.property) {
      case 'deadlock-free':
        return 'deadlock';
      case 'no-runtime-errors':
        return 'runtime-error';
      case 'terminates':
        return 'no-termination';
      case 'divergence-free':
        return 'divergence';
      case 'deterministic':
        return 'nondeterminism';
      default:
        switch (raw.type) {
          case 'deadlock':
            return 'deadlock';
          case 'divergence':
            return 'divergence';
          case 'determinism':
            return 'nondeterminism';
          default:
            return 'refinement';
        }
    }
  }

  // -------------------------------------------------------------------------
  // Processes and names
  // -------------------------------------------------------------------------

  private setUp(leaves: LeafBehaviour[]): void {
    const byIndex = new Map(leaves.map((l) => [l.process, l]));
    this.model.sourceMap.processes.forEach((info, index) => {
      const leaf = byIndex.get(index);
      if (!info.process) {
        this.servers.push({ info, leaf });
        return;
      }
      this.procs.push({ index, info, ref: info.process, name: '', leaf, active: !!leaf?.steps.some((e) => e !== undefined) });
    });
    const names = processNames(this.model, this.uri);
    for (const p of this.procs) {
      p.name = names[p.index] ?? p.ref.label;
      // The report names each process as its sentences do, so a consumer can tell two `branch 1` apart.
      p.ref = { ...p.ref, name: p.name };
    }
  }

  private parentOf(p: Proc): Proc | undefined {
    let best: Proc | undefined;
    for (const q of this.procs) {
      if (q === p || q.ref.path.length >= p.ref.path.length || !isPathPrefix(q.ref.path, p.ref.path)) continue;
      if (!best || q.ref.path.length > best.ref.path.length) best = q;
    }
    return best;
  }

  /**
   * The processes a join's par runs: every branch of the par at `def.at`, or
   * every iteration of a par for, of the procedure instance the join is in (a
   * procedure called twice runs the same par twice, with its own branches).
   * Join k of a par collects branch k, but the par ends only when every
   * branch has: the ones still running are what it waits for.
   */
  private childrenOf(p: Proc, b: Bound): Proc[] {
    const def = b.def!;
    const instance = def.params.find((x) => x.role === 'instance');
    const handle = instance ? b.env.get(instance.name) : undefined;
    return this.procs.filter((q) => {
      const last = q.ref.path[q.ref.path.length - 1];
      if (q.absent || !last || !def.at || q.ref.path.length <= p.ref.path.length || !isPathPrefix(p.ref.path, q.ref.path)) return false;
      if (handle !== undefined && q.info.args[0] !== handle) return false;
      const parSpan = this.parOf(q);
      return !!parSpan && sameSpan(parSpan.span, def.at.span);
    });
  }

  /** `to_santa (reindeer_santa)`: the name the statement uses, and the channel it is when that differs. */
  private local(variable: string | undefined, label: string): string {
    return variable && variable !== label ? `${variable} (${label})` : label;
  }

  /** The par statement that starts a process (from its slot definition). */
  private parOf(q: Proc): SourceRef | undefined {
    return this.model.sourceMap.definitions[q.info.definition]?.spawn?.par;
  }

  // -------------------------------------------------------------------------
  // What a process may still do (reach.ts)
  // -------------------------------------------------------------------------

  /**
   * The program points (CspUse.site keys) a process may still reach from
   * where the counterexample leaves it, its continuations and a restart of
   * its branch included; undefined when that is not known (a process inside
   * a compressed part, an unnamed state), which counts as "anything".
   */
  private reachOf(p: Proc): Set<string> | undefined {
    if (this.reachCache.has(p)) return this.reachCache.get(p);
    if (this.reachBusy.has(p)) return undefined;
    this.reachBusy.add(p);
    let out: Set<string> | undefined;
    const leaf = p.leaf;
    if (leaf) {
      const stopped = leaf.steps.includes('pj_end') || !!leaf.errorEvent?.startsWith('pj_error.') || leaf.steps.some((e) => e?.startsWith('pj_error.'));
      out = stopped ? new Set() : this.reachFrom(p, leaf.at[leaf.at.length - 1] ?? leaf.final, 0);
    }
    this.reachBusy.delete(p);
    this.reachCache.set(p, out);
    return out;
  }

  private reachFrom(p: Proc, state: string | undefined, depth: number): Set<string> | undefined {
    if (!state || depth > 64) return undefined;
    if (state === 'STOP' || state === 'SKIP') return new Set();
    const b = this.bind(state);
    const def = b.def;
    if (!def?.reach) return undefined;
    const out = new Set(def.reach);
    if (def.kind === 'slot' || def.kind === 'branch-end') return this.canRestart(p, def) ? out : new Set();
    if (!def.exits) return out;
    const k = def.params.find((x) => x.role === 'continuation');
    const cont = k ? b.env.get(k.name) : undefined;
    if (k && cont !== undefined) {
      // What the caller does next: a definition, or the end of the root (`pj_end -> STOP`).
      const next = continuationState(cont);
      if (next) {
        const more = this.reachFrom(p, next, depth + 1);
        if (!more) return undefined;
        for (const x of more) out.add(x);
      }
    } else if (!k) {
      // The end of a branch: it runs again only if its parent starts its par again.
      const slot = this.model.sourceMap.definitions[p.info.definition];
      if (slot?.reach && slot.kind === 'slot' && this.canRestart(p, slot)) for (const x of slot.reach) out.add(x);
    }
    return out;
  }

  /** Whether a branch or iteration can be started again: its parent can still reach the par. */
  private canRestart(p: Proc, slot: CspDefinitionInfo): boolean {
    const parent = this.parentOf(p);
    if (!parent || !slot.restart) return false;
    const r = this.reachOf(parent);
    return !r || r.has(slot.restart);
  }

  // -------------------------------------------------------------------------
  // Events and values
  // -------------------------------------------------------------------------

  private eventName(id: number): string {
    return this.eventMap[String(id)] ?? String(id);
  }

  private channelInfo(base: string): CspChannelInfo | undefined {
    return this.model.sourceMap.channels[base];
  }

  /** `a.4` -> channel `a`, value `4`; `b.1.pj_sync` -> `b`, op `pj_sync`; mediated and fork fields skip the instance. */
  private parse(event: string): { base: string; info?: CspChannelInfo; fields: string[]; instance?: string } {
    const parts = splitDots(event);
    const base = parts[0];
    const info = this.channelInfo(base);
    const fields = parts.slice(1);
    const instance = info?.instanced && fields.length ? fields.shift() : undefined;
    return { base, info, fields, instance };
  }

  /** A value in ProcessJ terms. */
  private value(tokens: string[]): string {
    return this.values(tokens).join(', ');
  }

  /** Consecutive values (a record or protocol value spans its constructor and one value per field). */
  private values(tokens: string[]): string[] {
    const out: string[] = [];
    let i = 0;
    const one = (): string => {
      const t = tokens[i++];
      if (t === undefined) return '?';
      const ctor = this.model.sourceMap.constructors[t];
      if (ctor) {
        if (ctor.kind === 'null') return 'null';
        const fields = ctor.fields.map((f) => `${f} = ${one()}`);
        if (ctor.kind === 'record') return `${ctor.type} { ${fields.join(', ')} }`;
        return fields.length ? `${ctor.tag} { ${fields.join(', ')} }` : `${ctor.tag}`;
      }
      if (t === 'pj_any') return '?';
      const n = t.replace(/^\((-\d+)\)$/, '$1');
      // Only a saturated integer (relevance.ts) is ever outside the modelled range.
      const { lo, hi } = this.model.intRange;
      if (/^-?\d+$/.test(n) && (Number(n) < lo || Number(n) > hi)) return `a value outside ${lo}..${hi}`;
      return n;
    };
    while (i < tokens.length) out.push(one());
    return out;
  }

  /** The ProcessJ name of a CSPm channel (`f_c` is `c` of f). */
  private channelLabel(base: string, ref?: ChannelRef): string {
    const info = this.channelInfo(base);
    const of = info?.of ? this.channelInfo(info.of) : undefined;
    return ref?.name ?? info?.ref?.name ?? of?.ref?.name ?? base;
  }

  /** The declaration instance a process means by a CSPm channel. */
  private refFor(p: Proc | undefined, base: string): ChannelRef | undefined {
    const info = this.channelInfo(base);
    const main = info?.of ?? base;
    return p?.info.channels[base] ?? p?.info.channels[main] ?? info?.ref ?? this.channelInfo(main)?.ref;
  }

  /**
   * The channel or barrier instance (CspUse.resource) a process's operation at
   * `at` is on: exact where ChannelRef is not (a par for body's own channel
   * is one per iteration).
   */
  private resourceOf(p: Proc, base: string, at?: SourceRef): string | undefined {
    const main = this.channelInfo(base)?.of ?? base;
    const uses = p.info.uses.filter((u) => u.channel === base || u.channel === main || this.channelInfo(u.channel)?.of === main);
    const here = at ? uses.find((u) => u.at && sameSpan(u.at.span, at.span) && u.at.uri === at.uri) : undefined;
    return (here ?? uses[0])?.resource ?? p.info.enrolled.find((e) => e.channel === main)?.resource;
  }

  /** Whether a use is on the channel or barrier instance a wait is on. */
  private sameResource(u: { ref?: ChannelRef; resource?: string }, ref: ChannelRef | undefined, resource: string | undefined): boolean {
    if (resource && u.resource) return u.resource === resource;
    return !!u.ref && !!ref && sameChannel(u.ref, ref);
  }

  // -------------------------------------------------------------------------
  // Definitions a process is in
  // -------------------------------------------------------------------------

  private bind(state: string | undefined): Bound {
    if (!state) return { name: '', env: new Map() };
    const { name, args } = parseState(state);
    const def = this.model.sourceMap.definitions[name];
    const env = new Map<string, string>();
    def?.params.forEach((param, i) => {
      if (args[i] !== undefined) env.set(param.name, args[i]);
    });
    return { def, name, env };
  }

  /** The channel a definition's operation is on, in this instance (`out1` bound to `a`). */
  private boundChannel(b: Bound, expr: string | undefined): string | undefined {
    if (!expr) return undefined;
    const head = splitDots(expr)[0];
    const bound = b.env.get(head);
    return splitDots(bound ?? head)[0];
  }

  /**
   * The ProcessJ channel an operation is on: through `channel`, or through the
   * event it really waits on (`via`) when FDR shows `channel` as `_` (a
   * parameter the definition does not use), mapped from an acknowledgement or
   * a mediated channel's take to the channel itself.
   */
  private opChannel(b: Bound, op: { channel?: string; via?: string }): string {
    for (const expr of [op.channel, op.via]) {
      const base = this.boundChannel(b, expr);
      if (base && base !== '_') return this.channelInfo(base)?.of ?? base;
    }
    return '?';
  }

  /**
   * Whether an alt guard is enabled in the state `b`: its precondition is a
   * constant or a parameter of the alt's definition (`pj_pre1`, `ready`),
   * whose value is in FDR's state name. Undefined when it cannot be told.
   */
  private guardEnabled(b: Bound, g: NonNullable<CspOperation['guards']>[number]): boolean | undefined {
    if (!g.precondition) return true;
    if (g.pre === 'true' || g.pre === 'false') return g.pre === 'true';
    const value = g.pre ? b.env.get(g.pre) : undefined;
    return value === 'true' ? true : value === 'false' ? false : undefined;
  }

  // -------------------------------------------------------------------------
  // Steps
  // -------------------------------------------------------------------------

  private step(k: number, topId: number): TraceStep {
    const top = this.eventName(topId);
    let parts = this.procs.filter((p) => p.leaf?.steps[k] !== undefined);
    const serverEvent = this.servers.map((s) => s.leaf?.steps[k]).find((e) => e !== undefined);
    const event = parts.map((p) => p.leaf!.steps[k]!).find((e) => e !== 'τ') ?? serverEvent ?? (parts.length ? 'τ' : top);
    const parsed = this.parse(event);
    parts = this.inBounds(parts, parsed);
    const step: TraceStep = { index: k, event, kind: 'other', participants: [], description: '' };
    const info = parsed.info;
    // What the outside saw: FDR shows a hidden event (a local channel of a checked procedure too) as τ.
    // A check that hides every event says nothing about that: there the model's own hiding does.
    step.visible = (this.hidesEverything || top !== 'τ') && !(event === 'τ' || !!info?.hidden);
    const role = info?.role;
    const lineOf = (p: Proc): SourceRef | undefined => this.stepAt(p, k, parsed.base, event);
    if (event === 'τ' || event === '✓' || !info) {
      for (const p of parts) step.participants.push({ process: p.ref, role: 'actor', at: lineOf(p) });
      step.kind = event === '✓' ? 'termination' : event === 'τ' ? 'internal' : 'other';
      step.description = this.describeOther(event, parts, k, step);
      return step;
    }
    if (role === 'channel' || role === 'ack') {
      step.kind = 'communication';
      const ref = this.refFor(parts[0], parsed.base);
      if (ref) step.channel = ref;
      const label = this.channelLabel(parsed.base, ref);
      const value = role === 'channel' && parsed.fields.length ? this.value(parsed.fields) : undefined;
      if (value !== undefined) step.value = value;
      const roles = parts.map((p) => ({ p, role: this.roleOf(p, k, parsed.base, info) }));
      for (const { p, role: r } of roles) step.participants.push({ process: p.ref, role: r, at: lineOf(p) });
      const writer = roles.find((x) => x.role === 'writer')?.p;
      const reader = roles.find((x) => x.role === 'reader')?.p;
      const ln = (p: Proc | undefined): string => {
        const at = p ? lineOf(p) : undefined;
        return at ? ` (${this.where(at)})` : '';
      };
      const isTake = !!info.of && role === 'channel';
      if (role === 'ack') {
        const done = this.channelInfo(parsed.base)?.meaning?.startsWith('the reader is done');
        if (reader && writer && !done && !this.endsBlock(reader, k)) {
          // After a plain read the model's acknowledgement only completes the write the read
          // already took: bookkeeping, not a second message.
          step.kind = 'internal';
          step.description = `${writer.name}'s write on ${label} completes${ln(writer)}: ${reader.name} has taken the value${ln(reader)}`;
          return step;
        }
        step.description = done
          ? `${reader?.name ?? 'the reader'} is done with the value from ${label}${ln(reader)}`
          : reader && writer
            ? `${reader.name} finishes the extended rendezvous on ${label}${ln(reader)}; ${writer.name}'s write completes`
            : `${(writer ?? reader)?.name ?? 'a process'}'s write on ${label} completes${ln(writer ?? reader)}`;
      } else if (isTake) {
        step.description = `${reader?.name ?? parts[0]?.name ?? 'a process'} reads ${value ?? 'a value'} from ${label}${ln(reader ?? parts[0])}`;
      } else if (writer && reader) {
        const how = this.readHow(reader, k);
        step.description = `${writer.name} writes ${value ?? 'a value'} on ${label}${ln(writer)}; ${reader.name} ${how}${ln(reader)}`;
      } else if (writer) {
        step.description = `${writer.name} writes ${value ?? 'a value'} on ${label}${ln(writer)}${this.isHarness(ref) ? ' (to the caller)' : ''}`;
      } else if (reader) {
        step.description = `${reader.name} reads ${value ?? 'a value'} from ${label}${ln(reader)}${this.isHarness(ref) ? ' (from the caller)' : ''}`;
      } else {
        step.description = `${event}`;
      }
      return step;
    }
    if (role === 'barrier') {
      step.kind = 'barrier';
      const ref = this.refFor(parts[0], parsed.base) ?? this.servers.find((s) => s.leaf?.steps[k] !== undefined)?.info.barrier;
      if (ref) step.channel = ref;
      const label = this.channelLabel(parsed.base, ref);
      for (const p of parts) step.participants.push({ process: p.ref, role: 'sync', at: lineOf(p) });
      const p = parts[0];
      const at = p ? lineOf(p) : undefined;
      const ln = at ? ` (${this.where(at)})` : '';
      const op = parsed.fields[0] ?? '';
      const enroll = /^pj_enroll_(\d+)$/.exec(op);
      if (op === 'pj_sync') step.description = `${p?.name ?? 'a process'} arrives at barrier ${label}${ln}`;
      else if (op === 'pj_go') step.description = `${p?.name ?? 'a process'} passes barrier ${label}${ln}`;
      else if (op === 'pj_resign') step.description = `${p?.name ?? 'a process'} ends and resigns from barrier ${label}`;
      else if (enroll) step.description = `${p?.name ?? 'a process'} enrolls the ${enroll[1]} new ${enroll[1] === '1' ? 'process' : 'processes'} of its par on barrier ${label}${ln}`;
      else step.description = `${event}`;
      return step;
    }
    if (role === 'error') {
      step.kind = 'error';
      for (const p of parts) step.participants.push({ process: p.ref, role: 'actor', at: lineOf(p) });
      const site = this.errorInfo(event);
      step.description = `${parts[0]?.name ?? 'a process'}: ${site?.message ?? 'runtime error'}${site?.at ? ` (${this.where(site.at)})` : ''}`;
      return step;
    }
    // Bookkeeping: forks, joins, loop ticks, skip and timeout guards, the end, the harness.
    for (const p of parts) step.participants.push({ process: p.ref, role: 'actor', at: lineOf(p) });
    step.kind = parsed.base === 'pj_end' || parsed.base === 'pj_done' ? 'termination' : parsed.base === 'pj_call' || parsed.base === 'pj_result' ? 'other' : 'internal';
    step.description = this.describeInternal(parsed, parts, k, info);
    if (parsed.base === 'pj_call' || parsed.base === 'pj_result') {
      const root = this.procs.find((p) => p.ref.path.length === 0);
      if (root && !step.participants.length) step.participants.push({ process: root.ref, role: 'actor', at: this.model.target.at });
    }
    return step;
  }

  /**
   * A par for with computed bounds has a slot for every modelled integer: all
   * take part in its fork and join, the ones outside the bounds only to join
   * at once. They are not participants: in the program those iterations do
   * not exist.
   */
  private inBounds(parts: Proc[], parsed: ReturnType<Explainer['parse']>): Proc[] {
    const forkName = parsed.base.startsWith('pj_join_') ? parsed.base.replace(/^pj_join_/, 'pj_fork_') : parsed.base;
    const forkInfo = this.channelInfo(forkName);
    if (!forkInfo?.computedBounds) return parts;
    const key = `${forkName}#${parsed.instance ?? ''}`;
    if (parsed.base === forkName) {
      const num = (t: string | undefined): number => Number((t ?? '').replace(/^\((-?\d+)\)$/, '$1'));
      this.ranges.set(key, { lo: num(parsed.fields[0]), hi: num(parsed.fields[1]) });
    }
    const range = this.ranges.get(key);
    if (!range) return parts;
    return parts.filter((q) => {
      const last = q.ref.path[q.ref.path.length - 1];
      if (q.info.kind !== 'iteration' || last?.kind !== 'par-for' || last.index === undefined) return true;
      const inside = last.index >= range.lo && last.index <= range.hi;
      (inside ? this.inRange : this.outOfRange).add(q);
      return inside;
    });
  }

  /**
   * Whether a reader's acknowledgement at step k ends an extended rendezvous
   * block. A channel read with a block anywhere is acknowledged after every
   * read (gen.ts); after a plain read (an alt guard, `x = c.read()`) the
   * acknowledgement is part of the read, not the end of a block.
   */
  private endsBlock(reader: Proc, k: number): boolean {
    const def = this.bind(reader.leaf?.at[k]).def;
    if (def?.operation?.kind !== 'ack' || def.operation.role !== 'reader' || !def.at) return true;
    const at = def.at;
    return Object.values(this.model.sourceMap.definitions).some((d) => d.operation?.kind === 'extended-read' && !!d.at && d.at.uri === at.uri && sameSpan(d.at.span, at.span));
  }

  /** A channel standing for a parameter of the checked procedure: the caller is its other side. */
  private isHarness(ref: ChannelRef | undefined): boolean {
    return !!ref && Object.values(this.model.sourceMap.channels).some((c) => c.harness && !!c.ref && sameChannel(c.ref, ref));
  }

  /** How a reader took a value: plainly, in an alt, or with an extended rendezvous. */
  private readHow(reader: Proc, k: number): string {
    const b = this.bind(reader.leaf?.at[k]);
    const op = b.def?.operation;
    if (op?.kind === 'alt') return 'takes it in its alt';
    if (op?.kind === 'extended-read') return 'reads it and runs its extended rendezvous block';
    return 'reads it';
  }

  private roleOf(p: Proc, k: number, base: string, info: CspChannelInfo): 'writer' | 'reader' | 'sync' | 'actor' {
    const b = this.bind(p.leaf?.at[k]);
    const op = b.def?.operation;
    if (info.role === 'ack') {
      if (info.meaning?.startsWith('the reader is done')) return 'reader';
      if (op?.kind === 'ack' && op.role) return op.role;
      return 'writer';
    }
    if (info.of) return 'reader'; // a mediated channel's take
    switch (op?.kind) {
      case 'write':
        return 'writer';
      case 'read':
      case 'extended-read':
      case 'alt':
        return 'reader';
      default: {
        const uses = p.info.uses.filter((u) => u.channel === base && !u.ack);
        if (uses.length && uses.every((u) => u.op === 'write')) return 'writer';
        if (uses.length && uses.every((u) => u.op === 'read')) return 'reader';
        return 'actor';
      }
    }
  }

  /** The statement a process executed at step k. */
  private stepAt(p: Proc, k: number, base: string, event: string): SourceRef | undefined {
    if (event.startsWith('pj_error.')) return this.errorInfo(event)?.at;
    const b = this.bind(p.leaf?.at[k]);
    const def = b.def;
    if (!def) return undefined;
    const op = def.operation;
    if (op?.kind === 'alt' && op.guards) {
      const want = base === 'pj_skip' ? 'skip' : base === 'pj_timeout' ? 'timeout' : 'read';
      const matching = op.guards.filter((g) => g.kind === want && (want !== 'read' || this.opChannel(b, g) === (this.channelInfo(base)?.of ?? base)));
      // Two guards on one channel: the one whose precondition holds is the one taken.
      const guard = matching.find((g) => this.guardEnabled(b, g) === true) ?? matching.find((g) => this.guardEnabled(b, g) !== false) ?? matching[0];
      if (guard) return guard.at;
    }
    if (base === 'pj_tick') {
      const next = this.bind(p.leaf?.at[k + 1]).def;
      if (next?.operation?.kind === 'loop' && next.at) return next.at;
    }
    return def.at;
  }

  private describeOther(event: string, parts: Proc[], k: number, step: TraceStep): string {
    if (event === '✓') return 'the program terminates';
    if (event !== 'τ') return event;
    if (!parts.length) return 'an internal step';
    const p = parts[0];
    const at = step.participants[0]?.at;
    return `${p.name} makes an internal choice${at ? ` (${this.where(at)})` : ''}: a value the model abstracts (a random number, a string, a real, the time) decides what it does next`;
  }

  private describeInternal(parsed: ReturnType<Explainer['parse']>, parts: Proc[], k: number, info: CspChannelInfo): string {
    const { base, fields } = parsed;
    const p = parts[0];
    const name = p?.name ?? 'a process';
    if (base.startsWith('pj_fork_') || base.startsWith('pj_join_')) {
      const fork = base.startsWith('pj_fork_');
      // The parent is the participant whose definition is the par (or its join); the children run slots.
      const isSlot = (q: Proc): boolean => {
        const def = this.bind(q.leaf?.at[k]).def;
        return def?.kind === 'slot' || def?.kind === 'branch-end';
      };
      const children = parts.filter(isSlot);
      const parent = parts.find((q) => !children.includes(q));
      const forkInfo = fork ? info : this.channelInfo(base.replace(/^pj_join_/, 'pj_fork_'));
      const iterations = (forkInfo?.spawns ?? info.spawns) === 'iterations';
      const par = children[0] ? this.parOf(children[0]) : undefined;
      const site = par ? ` (${iterations ? 'par for' : 'par'} at ${this.where(par)})` : '';
      const names = children.map((c) => this.relativeName(c, parent));
      const list = names.length > 4 ? `${names.length} ${iterations ? 'iterations' : 'branches'} (${names[0]} to ${names[names.length - 1]})` : listText(names);
      const parentName = parent?.name ?? (fork ? 'a process' : 'the parent');
      // The values a fork hands its branches (after a par for's computed bounds) or a join collects.
      const bounded = !!forkInfo?.computedBounds && fork;
      const fieldNames = (info.fields ?? []).slice(bounded ? 2 : 0);
      const vals = this.values(fields.slice(bounded ? 2 : 0));
      const values = fieldNames.length && vals.length ? fieldNames.map((n, i) => `${n} = ${vals[i] ?? '?'}`).join(', ') : '';
      if (fork) {
        if (!children.length) {
          const num = (t: string | undefined): string => (t ?? '?').replace(/^\((-?\d+)\)$/, '$1');
          const range = bounded ? ` (from ${num(fields[0])} to ${num(fields[1])})` : '';
          return `${parentName} reaches its ${iterations ? 'par for' : 'par'}${par ? ` at ${this.where(par)}` : ''}, which runs no ${iterations ? 'iteration' : 'branch'}${range}`;
        }
        return `${parentName} starts ${list}${site}${values ? ` with ${values}` : ''}`;
      }
      return `${parentName} collects ${list || 'its branches'}, which ${children.length === 1 ? 'has' : 'have all'} finished${site}${values ? ` (it hands back ${values})` : ''}`;
    }
    switch (base) {
      case 'pj_tick': {
        const at = p ? this.stepAt(p, k, base, base) : undefined;
        return `${name} goes round its loop${at ? ` (${this.where(at)})` : ''}`;
      }
      case 'pj_skip': {
        const at = p ? this.stepAt(p, k, base, base) : undefined;
        return `${name} takes the skip guard of its alt${at ? ` (${this.where(at)})` : ''}`;
      }
      case 'pj_timeout': {
        const at = p ? this.stepAt(p, k, base, base) : undefined;
        return `${name} takes a timeout guard of its alt${at ? ` (${this.where(at)})` : ''} (time is abstract: a timeout may end at any moment)`;
      }
      case 'pj_end':
        return `${this.model.target.kind === 'program' ? 'main' : this.model.target.name} returns: the program ends`;
      case 'pj_done':
        return 'the program has terminated';
      case 'pj_call': {
        const names = info.fields ?? [];
        const vals = this.values(fields);
        return `${this.model.target.name} is called with ${names.map((n, i) => `${n} = ${vals[i] ?? '?'}`).join(', ')}`;
      }
      case 'pj_result':
        return `${this.model.target.name} returns ${this.value(fields)}`;
      default:
        return `${name}: ${base}${fields.length ? `.${fields.join('.')}` : ''}`;
    }
  }

  private errorInfo(event: string): Counterexample['error'] | undefined {
    const ctor = event.slice('pj_error.'.length);
    const site = this.model.sourceMap.errors[ctor];
    if (!site) return { kind: 'runtime-error', message: `runtime error ${ctor}` };
    return { kind: site.kind, message: site.message, at: site.at };
  }

  // -------------------------------------------------------------------------
  // Final states
  // -------------------------------------------------------------------------

  /** Whether a process has terminated, before every snapshot is built (a join names the branches still running). */
  private classify(p: Proc): { status: ProcessSnapshot['status'] } {
    const leaf = p.leaf;
    if (!leaf) return { status: 'unknown' };
    if (leaf.errorEvent?.startsWith('pj_error.') || leaf.steps.some((e) => e?.startsWith('pj_error.'))) return { status: 'error' };
    const finalState = leaf.at[leaf.at.length - 1] ?? leaf.final;
    if (finalState === 'SKIP' || leaf.steps.includes('pj_end')) return { status: 'terminated' };
    const def = this.bind(finalState).def;
    if (def?.kind === 'branch-end') return { status: 'terminated' };
    if (def?.kind === 'slot') return { status: p.active ? 'terminated' : 'unknown' };
    return { status: 'blocked' };
  }

  private snapshot(p: Proc, ctx: { stuck: boolean; loop: boolean; diverges: boolean; errorProc?: Proc }): ProcessSnapshot {
    const leaf = p.leaf;
    const snap: ProcessSnapshot = { process: p.ref, status: 'unknown', description: '' };
    if (!leaf) {
      snap.description = `${p.name} is inside a compressed part of the network (//@csp compress), so the counterexample has no state of its own for it`;
      return snap;
    }
    const errored = leaf.errorEvent?.startsWith('pj_error.') ? leaf.errorEvent : leaf.steps.find((e) => e?.startsWith('pj_error.'));
    if (errored) {
      const info = this.errorInfo(errored);
      snap.status = 'error';
      if (info?.at) snap.at = info.at;
      // The variables where it fails: what the failing expression was computed from.
      const position = leaf.steps.findIndex((e) => e === errored);
      const values = this.liveValues(this.bind(position >= 0 ? leaf.at[position] : leaf.at[leaf.at.length - 1] ?? leaf.final));
      snap.description = info?.kind === 'range'
        ? `${p.name} leaves the modelled integers, where the model stops: ${info.message}${info.at ? ` (${this.where(info.at)})` : ''}${values ? `; ${values}` : ''}`
        : `${p.name} stops with a runtime error: ${info?.message ?? errored}${info?.at ? ` (${this.where(info.at)})` : ''}${values ? `; ${values}` : ''}`;
      return snap;
    }
    const finalState = leaf.at[leaf.at.length - 1] ?? leaf.final;
    const b = this.bind(finalState);
    const def = b.def;
    if (finalState === 'SKIP' || leaf.steps.includes('pj_end')) {
      snap.status = 'terminated';
      snap.description = `${p.name} has terminated`;
      return snap;
    }
    if (def?.kind === 'slot') {
      const par = def.spawn?.par;
      if (p.active) {
        snap.status = 'terminated';
        snap.description = `${p.name} has terminated${this.lastStep(p)}`;
      } else {
        snap.status = 'unknown';
        snap.description = `${p.name} has not been started: ${this.parentOf(p)?.name ?? 'its parent'} has not reached the ${def.spawn?.kind === 'par-for' ? 'par for' : 'par'}${par ? ` at ${this.where(par)}` : ''}`;
      }
      return snap;
    }
    if (def?.kind === 'branch-end') {
      snap.status = 'terminated';
      snap.description = `${p.name} has terminated${this.lastStep(p)}`;
      return snap;
    }
    if (finalState === 'STOP') {
      const before = this.bind([...leaf.at].reverse().find((s) => s && s !== 'STOP' && s !== 'SKIP')).def;
      const stop = before?.stops?.length === 1 ? before.stops[0] : undefined;
      const at = stop ?? before?.at;
      snap.status = 'blocked';
      if (at) snap.at = at;
      snap.description = stop
        ? `${p.name} can never do anything again: it reached the stop statement at ${this.where(stop)}`
        : `${p.name} can never do anything again${at ? ` (after ${this.where(at)})` : ''}: it reached a stop statement`;
      return snap;
    }
    if (def?.at) snap.at = def.at;
    const inside = this.inside(p, def);
    if (ctx.loop && leaf.inLoop) {
      // A divergence repeats internal steps only; a run that never ends (the termination check) repeats anything.
      snap.status = ctx.diverges ? 'diverging' : 'running';
      snap.description = ctx.diverges
        ? `${p.name}${inside} loops forever${def?.at ? ` (${this.where(def.at)})` : ''} without communicating with anything outside`
        : `${p.name}${inside} keeps running: it takes part in the steps that repeat${def?.at ? ` (${this.where(def.at)})` : ''}`;
      return snap;
    }
    // Stuck: in a deadlock every process is; in a run that repeats forever, every process that takes
    // no part in the repetition and stopped at an operation never completes it in that run.
    if (ctx.stuck || (ctx.loop && WAITING.has(def?.operation?.kind ?? ''))) {
      const waits = this.waits(p, b, leaf);
      snap.status = 'blocked';
      if (waits.length) snap.waits = waits;
      const values = this.liveValues(b);
      snap.description = `${p.name}${inside} ${waits.length ? waits.map((w) => w.detail).join(', or ') : 'is stuck'}${def?.at ? ` (${this.where(def.at)})` : ''}${values ? `; ${values}` : ''}`;
      return snap;
    }
    // Not a stuck state (a trace that ends in an error, a divergence, a refusal): where each process is.
    snap.status = 'running';
    snap.description = `${p.name}${inside} is at ${def?.at ? this.where(def.at) : 'an unnamed point'}${def?.text ? ` (${shorten(def.text, 60)})` : ''}`;
    return snap;
  }

  /**
   * The named states a process went through (ProcessSnapshot.trail): the
   * definition it is in before each step of the counterexample, and at the
   * end, each change once. `positions` are the steps' places in FDR's trace.
   */
  private trail(p: Proc, positions: number[]): NonNullable<ProcessSnapshot['trail']> {
    const leaf = p.leaf;
    if (!leaf) return [];
    const points = [...positions.map((k, i) => ({ step: i, state: leaf.at[k] })), { step: positions.length, state: leaf.at[leaf.at.length - 1] ?? leaf.final }];
    const out: NonNullable<ProcessSnapshot['trail']> = [];
    for (const { step, state } of points) {
      if (state && out[out.length - 1]?.state !== state) out.push({ step, state });
    }
    return out;
  }

  /** ` (in f)` when a process is inside a procedure it called. */
  private inside(p: Proc, def: CspDefinitionInfo | undefined): string {
    const home = p.ref.procedure ?? this.model.sourceMap.definitions[p.info.definition]?.procedure ?? (p.ref.path.length === 0 ? this.model.target.name : undefined);
    return def?.procedure && home && def.procedure !== home ? ` (in ${def.procedure})` : '';
  }

  /** `l = 4, x = true`: the ProcessJ variables live where a process stopped (temporaries of the translation have no name). */
  private liveValues(b: Bound): string {
    const out: string[] = [];
    for (const param of b.def?.params ?? []) {
      if (param.role !== 'value' || !param.variable) continue;
      const v = b.env.get(param.name);
      if (v === undefined) continue;
      out.push(`${param.variable} = ${this.value(splitDots(v))}`);
    }
    return out.join(', ');
  }

  /** What a process stopped in definition `b` waits for, from its statement and the events it still offers. */
  private waits(p: Proc, b: Bound, leaf: LeafBehaviour): WaitInfo[] {
    const def = b.def;
    const op = def?.operation;
    if (!def || !op) return [];
    const offered = new Map<string, string[]>();
    for (const e of leaf.acceptance) {
      const parsed = this.parse(e);
      const key = parsed.info?.of ?? parsed.base;
      offered.set(key, [...(offered.get(key) ?? []), e]);
    }
    const offers = (base: string): boolean => !leaf.hasAcceptance || offered.has(base) || offered.has(this.channelInfo(base)?.of ?? base);
    const at = def.at;
    const wait = (operation: WaitInfo['operation'], base: string | undefined, detail: string, where = at): WaitInfo => {
      const w: WaitInfo = { operation, detail };
      const ref = base ? this.refFor(p, base) : undefined;
      if (ref) w.channel = ref;
      if (where) w.at = where;
      return w;
    };
    switch (op.kind) {
      case 'write': {
        const base = this.opChannel(b, op);
        const sent = (offered.get(base) ?? []).map((e) => this.value(this.parse(e).fields));
        const label = this.local(op.variable, this.channelLabel(base, this.refFor(p, base)));
        return [wait('write', base, `waits to write ${sent.length === 1 ? `${sent[0]} ` : ''}on ${label}`)];
      }
      case 'read':
      case 'extended-read': {
        const base = this.opChannel(b, op);
        return [wait(op.kind, base, `waits to read ${this.local(op.variable, this.channelLabel(base, this.refFor(p, base)))}`)];
      }
      case 'ack': {
        const base = this.opChannel(b, op);
        const ref = this.refFor(p, base);
        const label = this.channelLabel(base, ref);
        if (op.role === 'reader') return [wait('extended-read', base, `waits to end the extended rendezvous on ${label}`)];
        // A mediated channel: the server holds the written value until a reader takes it.
        const resource = this.resourceOf(p, base, at);
        const server = this.isMediated(base) ? this.servers.find((sv) => sv.info.kind === 'channel' && this.sameResource({ ref: sv.info.barrier, resource: sv.info.resource }, ref, resource)) : undefined;
        const named = this.local(op.variable, label);
        if (server) {
          const last = [...(server.leaf?.steps ?? [])].reverse().find((e): e is string => !!e && !e.startsWith('pj_end'));
          const taken = !!last && this.parse(last).base !== base;
          const sent = [...(leaf.steps ?? [])].reverse().find((e): e is string => !!e && this.parse(e).base === base);
          const value = sent ? this.value(this.parse(sent).fields) : undefined;
          const w = wait('write', base, taken ? `waits for its reader to finish the extended rendezvous on ${named}` : `waits to write ${value !== undefined ? `${value} ` : ''}on ${named} (no reader has taken it)`);
          if (taken) this.ackWaits.add(w);
          return [w];
        }
        const w = wait('write', base, `waits for its reader to finish the extended rendezvous on ${named}`);
        this.ackWaits.add(w);
        return [w];
      }
      case 'sync': {
        const base = this.opChannel(b, op);
        const ref = this.refFor(p, base);
        const label = this.channelLabel(base, ref);
        const counter = this.counter(ref, this.resourceOf(p, base, at));
        const state = counter ? ` (${counter.waiting} of ${counter.enrolled} enrolled processes waiting)` : '';
        return [wait('sync', base, `waits at barrier ${label}${state}`)];
      }
      case 'alt': {
        const out: WaitInfo[] = [];
        for (const g of op.guards ?? []) {
          if (g.kind !== 'read') continue;
          // A guard whose precondition is false is not waiting for anything.
          if (this.guardEnabled(b, g) === false) continue;
          const base = this.opChannel(b, g);
          if (!offers(base)) continue;
          out.push(wait('alt-guard', base, `waits in an alt to read ${this.channelLabel(base, this.refFor(p, base))}`, g.at));
        }
        if (!out.length && op.guards?.length) out.push(wait('alt-guard', undefined, 'waits in an alt whose guards are all disabled'));
        return out;
      }
      case 'join': {
        // The par ends when all of its branches (every iteration of a par for) have: name the ones still running.
        const children = this.childrenOf(p, b);
        const open = children.filter((c) => this.classify(c).status !== 'terminated');
        const shown = open.length ? open : children.filter((c) => op.branch === undefined || c.ref.path[c.ref.path.length - 1]?.index === op.branch);
        const names = shown.map((c) => this.relativeName(c, p));
        const list = names.length > 4 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : listText(names);
        const w = op.branch === undefined
          ? wait('other', undefined, `waits for ${list || 'the iterations'} of its par for to finish`)
          : wait('other', undefined, `waits at its par for ${list || `branch ${op.branch}`} to finish`);
        if (shown.length) this.joinChildren.set(w, shown);
        return [w];
      }
      default:
        return [];
    }
  }

  /** Whether a channel goes through a server (several processes on both of its sides). */
  private isMediated(base: string): boolean {
    return Object.values(this.model.sourceMap.channels).some((c) => c.of === base && c.role === 'channel');
  }

  /** A barrier's runtime counter at the end (of this barrier instance): enrolled and waiting processes. */
  private counter(ref: ChannelRef | undefined, resource: string | undefined): { enrolled: number; waiting: number; lastResigned: boolean } | undefined {
    if (!ref) return undefined;
    const server = this.servers.find((s) => s.info.kind === 'barrier' && this.sameResource({ ref: s.info.barrier, resource: s.info.resource }, ref, resource));
    const state = server?.leaf?.at[server.leaf.at.length - 1];
    if (!state) return undefined;
    const { name, args } = parseState(state);
    if (name !== 'PJ_BAR_S' || args.length < 4) return undefined;
    const events = server!.leaf!.steps.filter((e): e is string => !!e);
    return { enrolled: Number(args[2]), waiting: Number(args[3]), lastResigned: /\.pj_resign$/.test(events[events.length - 1] ?? '') };
  }

  // -------------------------------------------------------------------------
  // Partners: who could complete a wait, and why they cannot
  // -------------------------------------------------------------------------

  private partners(p: Proc): void {
    const snap = p.snap;
    if (!snap || snap.status !== 'blocked' || !snap.waits) return;
    for (const w of snap.waits) {
      if (w.operation === 'other') {
        // The par waits for each of them (its partner is chosen in joinPartners, once the circles are known).
        for (const child of this.joinChildren.get(w) ?? []) if (child.snap?.status === 'blocked') this.edge(p, child.index);
        continue;
      }
      if (!w.channel) continue;
      if (w.operation === 'sync') {
        this.barrierPartners(p, w);
        continue;
      }
      this.channelPartners(p, w);
    }
  }

  /**
   * The partner of a par's wait: of the branches it waits for, the one that
   * keeps it from ever finishing when one does (stuck for good), else one that
   * is blocked, else the first; the detail says what each of them is doing.
   */
  private joinPartners(p: Proc, cycles: NonNullable<Counterexample['cycles']>): void {
    for (const w of p.snap?.status === 'blocked' ? p.snap.waits ?? [] : []) {
      const children = (this.joinChildren.get(w) ?? []).filter((c) => !!c.snap);
      if (w.operation !== 'other' || !children.length) continue;
      const rank = (c: Proc): number => (this.forGood(c, cycles) ? 0 : c.snap!.status === 'blocked' ? 1 : 2);
      const lead = [...children].sort((x, y) => rank(x) - rank(y))[0];
      const st = lead.snap!.status;
      const rest = children.filter((c) => c !== lead);
      const texts = [lead, ...rest].slice(0, 3).map((c) => `${c.name} ${this.stateText(c)}`);
      const more = children.length - texts.length;
      if (more > 0) texts.push(`${more} more ${more === 1 ? 'has' : 'have'} not finished either`);
      w.partner = {
        process: lead.ref,
        state: st === 'blocked' ? 'blocked-elsewhere' : st === 'terminated' || st === 'error' ? 'terminated' : 'not-ready',
        detail: texts.join('; '),
      };
    }
  }

  /**
   * Whether a blocked process can never go on: in a stuck state every one; in
   * a run that repeats forever one on a circle of waits, or each of whose
   * waits nobody can answer (its partners terminated or missing, or its par
   * waiting for such a branch). One the run merely starves is not.
   */
  private forGood(q: Proc, cycles: NonNullable<Counterexample['cycles']>, seen = new Set<Proc>()): boolean {
    if (q.snap?.status !== 'blocked') return false;
    if (!this.lasso) return true;
    if (cycles.some((c) => c.length > 1 && c.some((m) => m.process === q.ref))) return true;
    if (seen.has(q)) return false;
    seen.add(q);
    const waits = q.snap.waits ?? [];
    return waits.length > 0 && waits.every((w) => (w.operation === 'other'
      ? (this.joinChildren.get(w) ?? []).some((c) => this.forGood(c, cycles, seen))
      : w.partner?.state === 'terminated' || w.partner?.state === 'missing'));
  }

  /** A read or write: the other processes that use the channel instance the other way, and whether they still can. */
  private channelPartners(p: Proc, w: WaitInfo): void {
    const base = this.baseOf(p, w);
    const resource = base ? this.resourceOf(p, base, w.at) : undefined;
    const wanted: CspUse['op'] = w.operation === 'write' ? 'read' : 'write';
    // A write held for the end of an extended rendezvous waits for the reader's end of it, not for another read.
    const ending = this.ackWaits.has(w);
    const matching = (q: Proc): CspUse[] => q.info.uses.filter((u) => u.op === wanted && !!u.ack === ending && this.sameResource(u, w.channel, resource));
    const candidates = this.procs.filter((q) => !q.absent && matching(q).length);
    const label = w.channel!.name;
    const verb = wanted === 'read' ? 'reads' : 'writes';
    const noun = wanted === 'read' ? 'reader' : 'writer';
    // In a run that repeats forever, a partner left waiting on this channel instance the other way
    // could meet this wait at any moment: the run just never lets them (FDR assumes no fairness).
    const meets = (q: Proc): boolean => this.lasso && !ending && !!q.snap?.waits?.some((x) => {
      const kinds: Array<WaitInfo['operation']> = wanted === 'read' ? ['read', 'extended-read', 'alt-guard'] : ['write'];
      if (!kinds.includes(x.operation) || !x.channel || !sameChannel(x.channel, w.channel!)) return false;
      const theirs = this.baseOf(q, x);
      return !resource || !theirs || this.resourceOf(q, theirs, x.at) === resource;
    });
    if (!candidates.length) {
      w.partner = { state: 'missing', detail: this.isHarness(w.channel) ? `the procedure's caller is the only ${noun} of ${label}` : `nothing in the program ${verb} ${label}` };
      return;
    }
    const described = candidates.map((q) => {
      const uses = matching(q);
      const sites = uses.map((u) => u.at).filter((x): x is SourceRef => !!x);
      const lines = sites.length ? ` (${[...new Set(sites.map((x) => this.where(x)))].slice(0, 3).join(', ')})` : '';
      // `consume, the only reader of a (line 35),` / `logger (reads a at line 40)`
      const who = candidates.length === 1 ? `${q.name}, the only ${noun} of ${label}${lines},` : `${q.name} (${verb} ${label}${lines ? ` at ${lines.slice(2, -1)}` : ''})`;
      if (q === p) return { q, state: 'blocked-elsewhere' as PartnerState, text: candidates.length === 1 ? `${q.name} itself is the only ${noun} of ${label}${lines}, and it cannot get there while it waits here` : `${q.name} itself ${verb} ${label}${lines}, but not while it waits here` };
      const st = q.snap!;
      // Can q still get to one of those operations from where it is (reach.ts)?
      const reach = this.reachOf(q);
      const still = !reach || uses.some((u) => !u.site || reach.has(u.site));
      if (st.status === 'error') return { q, state: 'terminated' as PartnerState, text: `${who} stopped with a runtime error` };
      if (st.status === 'terminated') {
        return still
          ? { q, state: 'not-ready' as PartnerState, text: `${who} has finished, and runs again only when its parent starts it again` }
          : { q, state: 'terminated' as PartnerState, text: `${who} has already terminated${this.lastStep(q)}` };
      }
      if (!still) {
        // Busy elsewhere, and its uses of the channel are all behind it: it will never answer.
        const doing = st.status === 'running' ? 'keeps running' : this.stateText(q);
        if (ending) return { q, state: 'missing' as PartnerState, text: `${who} can never finish its extended rendezvous on ${label} (it ${doing})` };
        return { q, state: 'missing' as PartnerState, text: `${who} never ${verb.replace(/s$/, '')}s ${label} again: its ${verb.replace(/s$/, '')}${uses.length === 1 ? ' is' : 's are'} behind it (it ${doing})` };
      }
      if (st.status === 'blocked' && meets(q)) {
        return { q, state: 'not-ready' as PartnerState, text: `${who} waits to ${verb.replace(/s$/, '')} ${label} too: the two could meet, but this run never lets them (FDR looks for any run that never ends, fair or not)` };
      }
      if (st.status === 'blocked') {
        this.edge(p, q.index, w.channel);
        return { q, state: 'blocked-elsewhere' as PartnerState, text: `${who} ${this.stateText(q)}` };
      }
      if (st.status === 'running' && this.lasso) {
        return { q, state: 'not-ready' as PartnerState, text: `${who} keeps running and could still ${verb.replace(/s$/, '')} ${label}, but does not in this run` };
      }
      return { q, state: 'not-ready' as PartnerState, text: `${who} ${this.stateText(q)}` };
    });
    const order: PartnerState[] = ['terminated', 'missing', 'blocked-elsewhere', 'not-ready'];
    const others = described.filter((d) => d.q !== p);
    const gone = (d: (typeof described)[number]): boolean => d.state === 'terminated' || d.state === 'missing';
    // Nobody will ever answer only when every other candidate is gone for good; otherwise the one that
    // still could is the partner. A known state tells more than one inside a compressed part.
    const never = others.length > 0 && others.every(gone);
    const pool = (others.length ? others : described).filter((d) => never || !gone(d));
    const known = (d: (typeof described)[number]): boolean => !!d.q.leaf;
    const lead = [...(pool.length ? pool : described)].sort((x, y) => Number(known(y)) - Number(known(x)) || order.indexOf(x.state) - order.indexOf(y.state))[0];
    if (described.length === 1) {
      w.partner = { process: lead.q.ref, state: lead.state, detail: lead.text };
      return;
    }
    // Several possible partners: say what stops each, the ones that ended together.
    const ended = others.filter((d) => d.state === 'terminated' && d.q.snap?.status === 'terminated').map((d) => d.q.name);
    const parts: string[] = [];
    if (ended.length) parts.push(`${listText(ended)} ${ended.length === 1 ? 'has' : 'have'} already terminated`);
    const rest = others.filter((d) => !ended.includes(d.q.name));
    for (const d of rest.slice(0, 3)) parts.push(d.text.replace(/ \((?:reads|writes) [^)]*\)/, ''));
    if (rest.length > 3) parts.push(`${rest.length - 3} more cannot either`);
    if (described.some((d) => d.q === p)) parts.push(`${p.name} ${verb} ${label} itself, but not while it waits here`);
    const all = candidates.flatMap((q) => matching(q).map((u) => u.at)).filter((x): x is SourceRef => !!x);
    const lines = [...new Set(all.map((x) => this.where(x)))].slice(0, 3);
    w.partner = { process: lead.q.ref, state: lead.state, detail: `no ${noun} of ${label}${lines.length ? ` (${lines.join(', ')})` : ''} can take part: ${parts.join('; ')}` };
  }

  /** The CSPm channel a wait is on (for its resource). */
  private baseOf(p: Proc, w: WaitInfo): string | undefined {
    const ref = w.channel;
    if (!ref) return undefined;
    const entry = Object.entries(p.info.channels).find(([, r]) => sameChannel(r, ref));
    return entry?.[0];
  }

  private barrierPartners(p: Proc, w: WaitInfo): void {
    const ref = w.channel!;
    const label = ref.name;
    const base = this.baseOf(p, w);
    const resource = base ? this.resourceOf(p, base, w.at) : undefined;
    const users = this.procs.filter((q) => !q.absent && (q.info.enrolled.some((e) => this.sameResource(e, ref, resource)) || q.info.uses.some((u) => u.op === 'sync' && this.sameResource(u, ref, resource))));
    // `par enroll(b)` hands the parent's enrollment to its branches: while they run, the parent is not enrolled.
    const enrolled = users.filter((q) => !users.some((r) => r !== q && r.info.enrolled.some((e) => this.sameResource(e, ref, resource)) && isPathPrefix(q.ref.path, r.ref.path) && q.snap?.status !== 'terminated'));
    const waitingHere = (q: Proc): boolean => !!q.snap?.waits?.some((x) => x.operation === 'sync' && !!x.channel && sameChannel(x.channel, ref) && (!resource || this.resourceOf(q, base ?? '', x.at) === resource));
    const others = enrolled.filter((q) => q !== p && !waitingHere(q));
    const counter = this.counter(ref, resource);
    if (!others.length || others.every((q) => q.snap?.status === 'terminated')) {
      const resigned = others.filter((q) => q.snap?.status === 'terminated');
      const who = resigned.length ? `${listText(resigned.map((q) => q.name))} ${resigned.length === 1 ? 'has' : 'have'} ended and resigned from ${label}` : `every process enrolled on ${label} is waiting`;
      w.partner = {
        process: resigned[0]?.ref,
        state: resigned.length ? 'terminated' : 'not-ready',
        detail: `${who}${counter?.lastResigned || resigned.length ? '; in the ProcessJ runtime a resignation never completes a barrier, so the processes already waiting stay blocked' : ''}`,
      };
      return;
    }
    // An enrolled process that cannot get to a sync on this barrier again (reach.ts) never arrives,
    // and while it stays enrolled the barrier never completes.
    const arrives = (q: Proc): boolean => {
      if (q.snap?.status === 'terminated') return false;
      const reach = this.reachOf(q);
      const syncs = q.info.uses.filter((u) => u.op === 'sync' && this.sameResource(u, ref, resource));
      return !reach || syncs.some((u) => !u.site || reach.has(u.site));
    };
    const never = others.filter((q) => q.snap?.status !== 'terminated' && !arrives(q));
    const doing = (q: Proc): string => (q.snap?.status === 'running' ? 'keeps running' : this.stateText(q));
    const neverText = (q: Proc): string => (q.info.uses.some((u) => u.op === 'sync' && this.sameResource(u, ref, resource))
      ? `${q.name} never syncs on ${label} again (it ${doing(q)})`
      : `${q.name}, enrolled on ${label}, never syncs on it and resigns only when it ends (it ${doing(q)})`);
    if (never.length) {
      w.partner = { process: never[0].ref, state: 'missing', detail: `${never.map(neverText).join('; ')}: the barrier completes only when every enrolled process has arrived` };
      return;
    }
    const texts = others.map((q) => {
      if (q.snap?.status === 'terminated') return `${q.name} has ended and resigned`;
      if (q.snap?.status === 'blocked') this.edge(p, q.index, ref);
      return `${q.name} ${this.stateText(q)}`;
    });
    const lead = others.find((q) => q.snap?.status === 'blocked') ?? others[0];
    w.partner = {
      process: lead.ref,
      state: lead.snap?.status === 'blocked' ? 'blocked-elsewhere' : lead.snap?.status === 'terminated' ? 'terminated' : 'not-ready',
      detail: `still to arrive at ${label}: ${texts.join('; ')}`,
    };
  }

  /**
   * ` (its last step was 33)`: when a terminated process last did something,
   * counted as the steps are (FDR's trace has positions that are not steps of
   * the program in a determinism counterexample).
   */
  private lastStep(q: Proc): string {
    const steps = q.leaf?.steps ?? [];
    for (let k = steps.length - 1; k >= 0; k--) {
      const e = steps[k];
      const step = this.stepAtPosition.get(k);
      if (e && step !== undefined && !e.startsWith('pj_join_') && !/\.pj_resign$/.test(e)) return ` (its last step was ${step + 1})`;
    }
    return '';
  }

  /** A process's name as its parent's descriptions use it: `branch 1`, not `branch 1 of delta`. */
  private relativeName(child: Proc, parent: Proc | undefined): string {
    return parent && child.name.endsWith(` of ${parent.name}`) ? child.name.slice(0, -` of ${parent.name}`.length) : child.name;
  }

  /** `waits to read b (line 35)`, `has terminated`. */
  private stateText(q: Proc): string {
    const s = q.snap;
    if (!s) return 'is in an unknown state';
    if (!q.leaf) return 'is inside a compressed part of the network, so its state is not known';
    if (s.status === 'terminated') return 'has terminated';
    if (s.status === 'error') return 'stopped with a runtime error';
    if (s.status === 'blocked' && s.waits?.length) return `${s.waits.map((w) => w.detail).join(', or ')}${s.at ? ` (${this.where(s.at)})` : ''}`;
    if (s.status === 'running' && this.lasso) return `keeps running${s.at ? ` (${this.where(s.at)})` : ''}`;
    return s.description.startsWith(`${q.name} `) ? s.description.slice(q.name.length + 1) : s.description;
  }

  private edge(from: Proc, to: number, channel?: ChannelRef): void {
    const list = this.edges.get(from.index) ?? [];
    if (!list.some((e) => e.to === to && e.channel === channel)) list.push({ to, channel });
    this.edges.set(from.index, list);
  }

  /**
   * Circular waits: elementary cycles of the wait-for graph, each listed once
   * (smallest process first), shortest first: when many processes wait for
   * each other (every iteration of a par for writing the channel they all read
   * later), the short circles say it best.
   */
  private cycles(): NonNullable<Counterexample['cycles']> {
    const out: NonNullable<Counterexample['cycles']> = [];
    const byIndex = new Map(this.procs.map((p) => [p.index, p]));
    const nodes = [...this.edges.keys()].sort((a, b) => a - b);
    const limit = 10;
    for (let length = 1; length <= 20 && out.length < limit; length++) {
      for (const start of nodes) {
        const stack: Array<{ node: number; channel?: ChannelRef }> = [];
        const onStack = new Set<number>([start]);
        const dfs = (node: number): void => {
          for (const e of this.edges.get(node) ?? []) {
            if (out.length >= limit) return;
            if (e.to === start) {
              if (stack.length + 1 !== length) continue;
              const cycle = [...stack, { node, channel: e.channel }];
              out.push(cycle.map((c) => ({ process: byIndex.get(c.node)!.ref, ...(c.channel ? { channel: c.channel } : {}) })));
              continue;
            }
            if (e.to < start || onStack.has(e.to) || stack.length + 1 >= length) continue;
            onStack.add(e.to);
            stack.push({ node, channel: e.channel });
            dfs(e.to);
            stack.pop();
            onStack.delete(e.to);
          }
        };
        dfs(start);
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------

  private summary(a: CspAssertion, kind: Counterexample['kind'], raw: FdrCounterexample, cx: Counterexample, errorProc: Proc | undefined): string {
    const n = cx.steps.length;
    const after = n === 0 ? 'at the start' : `after ${n} step${n === 1 ? '' : 's'}`;
    switch (kind) {
      case 'deadlock': {
        // FDR's `:[deadlock free]` counts successful termination as a deadlock (SKIP refuses everything).
        const terminated = cx.steps[n - 1]?.event === '✓' || (cx.final.length > 0 && cx.final.every((s) => s.status === 'terminated'));
        if (terminated) return `the program terminates ${after}, and FDR counts successful termination as a deadlock; the generated check PJ_NOERR(${this.model.root}) :[deadlock free [F]] tells the two apart`;
        return `deadlock ${after}: ${this.stuckStory(cx)}`;
      }
      case 'runtime-error': {
        const e = cx.error;
        // A value outside the modelled integers is the model's limit, not an error of the program.
        const what = e?.kind === 'range' ? `integers out of the modelled range ${after}` : `runtime error ${after}`;
        return `${what}: ${errorProc ? `${this.procs.find((p) => p === errorProc)?.name}: ` : ''}${e?.message ?? 'a modelled error'}${e?.at ? ` (${this.where(e.at)})` : ''}`;
      }
      case 'divergence': {
        const looping = this.procs.filter((p) => p.snap?.status === 'diverging');
        return `divergence ${after}: ${looping.length ? looping.map((p) => `${p.name}${p.snap?.at ? ` (${this.where(p.snap.at)})` : ''}`).join(' and ') : 'the process'} can loop forever without communicating`;
      }
      case 'no-termination': {
        if (raw.type === 'refinement_divergence' || cx.loopStart !== undefined) {
          const looping = this.procs.filter((p) => p.leaf?.inLoop);
          // A process left behind for good while the others run: a partial deadlock.
          const stuck = this.stuckForever(cx);
          if (stuck) return `${stuck}, while ${looping.length ? listText(looping.map((p) => p.name)) : 'the rest'} ${looping.length === 1 ? 'runs' : 'run'} forever (the steps from ${(cx.loopStart ?? 0) + 1} on repeat)`;
          return `can run forever: ${after} the steps from ${(cx.loopStart ?? 0) + 1} on can repeat without end${looping.length ? ` (${looping.map((p) => p.name).join(', ')})` : ''}`;
        }
        if (errorProc && cx.error?.kind === 'range') return `not followed to the end: ${after} ${errorProc.name} leaves the modelled integers${cx.error.at ? ` (${this.where(cx.error.at)})` : ''}, where the model stops`;
        if (errorProc) return `does not terminate: ${after} ${errorProc.name} stops with a runtime error${cx.error?.at ? ` (${this.where(cx.error.at)})` : ''}`;
        return `can get stuck without terminating ${after}: ${this.stuckStory(cx)}`;
      }
      case 'nondeterminism': {
        const spec = raw.specification_behaviour;
        const event = spec?.error_event ? this.eventName(spec.error_event) : undefined;
        const visible = cx.steps.filter((s) => s.visible).map((s) => s.event);
        const internal = [...cx.steps].reverse().find((s) => !s.visible && s.description);
        const what = event ? this.eventText(event) : 'its next event';
        return `nondeterministic ${visible.length ? `after ${visible.join(', ')}` : 'at the start'}: whether ${this.model.target.name} can ${what} depends on an internal step${internal ? ` (${internal.description})` : ''}`;
      }
      default: {
        const spec = raw.specification_behaviour;
        const impl = raw.implementation_behaviour;
        const event = impl?.error_event ? this.eventName(impl.error_event) : spec?.error_event ? this.eventName(spec.error_event) : undefined;
        if (!event) return `${a.label} fails ${after}`;
        // Who would perform the refused event, at which statement: `branch 1 can then write 2 on a (line 11) and branch 2 read it (line 12)`.
        const doers = this.procs.filter((p) => p.leaf?.errorEvent === event);
        const atOf = (p: Proc): string => {
          const at = this.bind(p.leaf?.at[p.leaf.at.length - 1]).def?.at;
          return at ? ` (${this.where(at)})` : '';
        };
        const parsed = this.parse(event);
        const end = doers.length ? doers[0].leaf!.at.length - 1 : 0;
        const writer = doers.find((p) => parsed.info && this.roleOf(p, end, parsed.base, parsed.info) === 'writer');
        const reader = doers.find((p) => p !== writer && parsed.info && this.roleOf(p, end, parsed.base, parsed.info) === 'reader');
        const value = parsed.fields.length ? `${this.value(parsed.fields)} ` : '';
        const label = this.channelLabel(parsed.base);
        const who = writer && reader
          ? `${writer.name} can then write ${value}on ${label}${atOf(writer)} and ${reader.name} read it${atOf(reader)}`
          : doers.length
            ? `${doers.map((p) => p.name).join(' and ')} can then ${this.eventText(event)}${atOf(doers[0])}`
            : `the program can then do ${event}`;
        return `${a.label} fails ${after}: ${who}, which the specification does not allow (${event})`;
      }
    }
  }

  /**
   * In a run that repeats forever: the first process left waiting for good
   * (nobody can ever answer it, or it waits in a circle), as a sentence.
   */
  private stuckForever(cx: Counterexample): string | undefined {
    const line = (p: Proc, w: WaitInfo): string => `${p.name} ${w.detail}${w.at ? ` (${this.where(w.at)})` : ''}`;
    const blocked = this.procs.filter((p) => p.snap?.status === 'blocked');
    for (const p of blocked) {
      const w = p.snap!.waits?.find((x) => x.operation !== 'other' && (x.partner?.state === 'terminated' || x.partner?.state === 'missing'));
      if (w) return `${line(p, w)} forever: ${lowerFirst(w.partner!.detail)}`;
    }
    const cycle = cx.cycles?.find((c) => c.length > 1);
    if (cycle) return `a circular wait that never ends: ${this.circle(cycle)}`;
    return undefined;
  }

  /** An account of a circle of waits. */
  private circle(cycle: NonNullable<Counterexample['cycles']>[number]): string {
    const members = cycle.map((c) => this.procs.find((p) => p.ref === c.process)!).filter(Boolean);
    // `branch 1 waits to write 1 on c (line 12) for branch 2, which waits to write 2 on d (line 17) for branch 1`
    return members.map((p, i) => {
      const next = members[(i + 1) % members.length];
      const w = p.snap!.waits?.find((x) => x.channel && cycle[i].channel && sameChannel(x.channel, cycle[i].channel!)) ?? p.snap!.waits?.[0];
      const what = w ? `${w.detail}${w.at ? ` (${this.where(w.at)})` : ''}` : 'waits';
      return `${i === 0 ? `${p.name} ` : 'which '}${what} for ${next.name}`;
    }).join(', ');
  }

  /** An event as a ProcessJ operation: `read 0 from a`, `write 3 on out`, `sync on b`. */
  private eventText(event: string): string {
    const parsed = this.parse(event);
    const info = parsed.info;
    if (!info) return `do ${event}`;
    if (info.role === 'barrier') return `sync on ${this.channelLabel(parsed.base)}`;
    if (info.role !== 'channel') return `do ${event}`;
    const label = this.channelLabel(parsed.base);
    const value = parsed.fields.length ? `${this.value(parsed.fields)} ` : '';
    const ops = new Set(this.procs.flatMap((p) => p.info.uses.filter((u) => !u.ack && (u.channel === parsed.base || u.channel === info.of)).map((u) => u.op)));
    if (info.of || (ops.has('read') && !ops.has('write'))) return `read ${value}from ${label}`;
    if (ops.has('write') && !ops.has('read')) return `write ${value}on ${label}`;
    return `communicate ${value}on ${label}`;
  }

  /** The best one-line account of a stuck state: a wait nobody can answer, then a circle, then the first wait. */
  private stuckStory(cx: Counterexample): string {
    // Processes with a known state tell the story; one inside a compressed part cannot.
    const blocked = this.procs.filter((p) => p.snap?.status === 'blocked' && !!p.leaf);
    const line = (p: Proc, w: WaitInfo): string => `${p.name} ${w.detail}${w.at ? ` (${this.where(w.at)})` : ''}`;
    for (const state of ['terminated', 'missing'] as const) {
      for (const p of blocked) {
        const w = p.snap!.waits?.find((x) => x.operation !== 'other' && x.partner?.state === state);
        if (w) return `${line(p, w)}, but ${lowerFirst(w.partner!.detail)}`;
      }
    }
    const cycle = cx.cycles?.find((c) => c.length > 1) ?? cx.cycles?.[0];
    if (cycle) {
      const members = cycle.map((c) => this.procs.find((p) => p.ref === c.process)!).filter(Boolean);
      if (members.length === 1) {
        const p = members[0];
        const w = p.snap!.waits?.find((x) => x.operation !== 'other');
        return w ? `${line(p, w)}, and ${lowerFirst(w.partner?.detail ?? 'nothing else can complete it')}` : `${p.name} waits for itself`;
      }
      return `a circular wait: ${this.circle(cycle)}`;
    }
    const first = blocked.find((p) => p.snap!.waits?.some((w) => w.operation !== 'other')) ?? blocked[0];
    if (!first) return 'no process can move';
    const w = first.snap!.waits?.find((x) => x.operation !== 'other') ?? first.snap!.waits?.[0];
    return w ? `${line(first, w)}${w.partner ? `; ${lowerFirst(w.partner.detail)}` : ''}` : first.snap!.description;
  }

  // -------------------------------------------------------------------------
  // Locations
  // -------------------------------------------------------------------------

  private where(ref: SourceRef): string {
    return where(ref, this.uri);
  }
}

/** Operations a process can be stuck at. */
const WAITING = new Set(['write', 'read', 'extended-read', 'ack', 'sync', 'alt', 'join']);

/**
 * The state a continuation argument leads to (a definition, possibly behind a
 * lambda: `\ pj_r @ main__30(1, pj_r)`); undefined when it ends the process
 * (`pj_end -> STOP`, `pj_result!pj_r -> pj_end -> STOP`).
 */
function continuationState(text: string): string | undefined {
  const body = text.replace(/^\\\s*[\w']+\s*@\s*/, '').trim();
  return /^[A-Za-z_][\w']*(\(|$)/.test(body) && !/^pj_(end|result)\b/.test(body) ? body : undefined;
}

/** `a`, `a and b`, `a, b and c`. */
function listText(items: string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items[0] ?? '';
}

/** `line 25`, or `line 3 of util.pj` outside the document. */
export function where(ref: SourceRef, documentUri: string): string {
  const line = `line ${ref.span.start.line + 1}`;
  return ref.uri === documentUri ? line : `${line} of ${fileName(ref.uri)}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A short name for every process of a model, for sentences: the procedure a
 * process runs when that is unique; with several calls of it, the first
 * argument that tells them apart (`reindeer(1, …)`) or the iteration
 * (`elf (i = 2)`); `branch k` / `iteration i = 2` (`of <parent>` below the
 * root) for a branch that is a block. Indexed like sourceMap.processes
 * (undefined for barrier counters and channel servers).
 */
export function processNames(model: Pick<CspModel, 'sourceMap' | 'target'>, uri: string): Array<string | undefined> {
  interface Named {
    index: number;
    ref: ProcessRef;
    name: string;
  }
  const procs: Named[] = [];
  model.sourceMap.processes.forEach((info, index) => {
    if (info.process) procs.push({ index, ref: info.process, name: '' });
  });
  const parentOf = (p: Named): Named | undefined => {
    let best: Named | undefined;
    for (const q of procs) {
      if (q === p || q.ref.path.length >= p.ref.path.length || !isPathPrefix(q.ref.path, p.ref.path)) continue;
      if (!best || q.ref.path.length > best.ref.path.length) best = q;
    }
    return best;
  };
  // Names: the procedure a process runs when that is unique; with several calls of it, the
  // first argument that tells them apart (`reindeer(1, …)`) or the iteration (`elf (i = 2)`);
  // `branch k` / `iteration i = 2` (`of <parent>` below the root) for a branch that is a block.
  // A branch that calls a library procedure (`println(c.read())`) is named as a branch, not after the call.
  const translated = new Set(Object.values(model.sourceMap.definitions).map((d) => d.procedure));
  const procedureOf = (p: Named): string | undefined => (p.ref.procedure && translated.has(p.ref.procedure) ? p.ref.procedure : undefined);
  const byProcedure = new Map<string, Named[]>();
  for (const p of procs) {
    const proc = procedureOf(p);
    if (proc && p.ref.path.length) byProcedure.set(proc, [...(byProcedure.get(proc) ?? []), p]);
  }
  const callNames = new Map<Named, string>();
  for (const [proc, group] of byProcedure) {
    if (group.length === 1) {
      callNames.set(group[0], proc);
      continue;
    }
    const iteration = (p: Named): string | undefined => /\[([^\]]*)\]$/.exec(p.ref.label)?.[1];
    const args = group.map((p) => callArguments(p.ref.label.replace(/\s*\[[^\]]*\]$/, '')));
    const width = Math.max(...args.map((a) => a.length));
    let differs = -1;
    for (let i = 0; i < width && differs < 0; i++) if (new Set(args.map((a) => a[i])).size > 1) differs = i;
    group.forEach((p, k) => {
      const it = iteration(p);
      if (differs >= 0) callNames.set(p, `${proc}(${differs > 0 ? '…, ' : ''}${args[k][differs]}${args[k].length > differs + 1 ? ', …' : ''})${it ? ` (${it})` : ''}`);
      else callNames.set(p, it ? `${proc} (${it})` : proc);
    });
  }
  const ordered = [...procs].sort((x, y) => x.ref.path.length - y.ref.path.length);
  for (const p of ordered) {
    const parent = parentOf(p);
    const last = p.ref.path[p.ref.path.length - 1];
    const below = parent && parent.ref.path.length ? ` of ${parent.name}` : '';
    if (p.ref.path.length === 0) p.name = model.target.kind === 'program' ? 'main' : model.target.name;
    else if (procedureOf(p)) p.name = callNames.get(p) ?? procedureOf(p)!;
    else if (last?.kind === 'par-for') p.name = `iteration ${p.ref.label.replace(/^iteration\s*\[(.*)\]$/, '$1')}${below}`;
    else p.name = `branch ${last?.index ?? '?'}${below}`;
  }
  // Two processes with one name (two pars with a branch 1): add where each starts.
  const byName = new Map<string, Named[]>();
  for (const p of procs) byName.set(p.name, [...(byName.get(p.name) ?? []), p]);
  for (const [, same] of byName) {
    if (same.length < 2) continue;
    for (const p of same) {
      const last = p.ref.path[p.ref.path.length - 1];
      if (last) p.name = `${p.name} (${where(last.site, uri)})`;
    }
  }
  const out: Array<string | undefined> = [];
  for (const p of procs) out[p.index] = p.name;
  return out;
}

export function sameChannel(a: ChannelRef, b: ChannelRef): boolean {
  if (a === b) return true;
  if (a.name !== b.name || a.kind !== b.kind) return false;
  const da = a.declaration;
  const db = b.declaration;
  if (!!da !== !!db) return false;
  if (da && db && (da.uri !== db.uri || !sameSpan(da.span, db.span))) return false;
  return samePath(a.owner, b.owner);
}

function sameSpan(a: SourceRef['span'], b: SourceRef['span']): boolean {
  return a.start.line === b.start.line && a.start.col === b.start.col && a.end.line === b.end.line && a.end.col === b.end.col;
}

/** Split an event or value at the dots between its fields (not inside brackets). */
export function splitDots(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(' || ch === '<' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '>' || ch === '}' || ch === ']') depth = Math.max(0, depth - 1);
    if (ch === '.' && depth === 0) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

/** The arguments of a call's source text: `reindeer(0, seed + 1, b)` -> [`0`, `seed + 1`, `b`]. */
function callArguments(call: string): string[] {
  const open = call.indexOf('(');
  if (open < 0 || !call.endsWith(')')) return [];
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of call.slice(open + 1, -1)) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function lowerFirst(text: string): string {
  return text.length && /[A-Z]/.test(text[0]) && !/^[A-Z][A-Z0-9_]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
}

function fileName(uri: string): string {
  try {
    return path.basename(uri.startsWith('file:') ? fileURLToPath(uri) : uri);
  } catch {
    return uri;
  }
}

/** Behaviour helpers for callers that only want the raw trace (scripts). */
export function traceNames(b: FdrBehaviour | undefined, eventMap: Record<string, string>): string[] {
  return (b?.trace ?? []).map((e) => eventMap[String(e)] ?? String(e));
}
