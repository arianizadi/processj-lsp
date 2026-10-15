/**
 * FDR's answers about a CSPm file's own assertions, as a VerificationReport
 * (src/verification.ts) placed on the drawn network of src/cspm/network.ts.
 *
 * Each `assert` of the file is one check: its verdict, FDR's statistics, and
 * for a failure the counterexample. With `--divide` FDR gives, below the
 * behaviour of the process the assertion is about, one behaviour per
 * component, each with its own trace aligned to the whole one, the states it
 * went through (named definitions, or `<unnamed>` inside one) and, at the
 * end, what it still offers. Those components are matched to the drawn
 * operands by following the composition the network was drawn from: through
 * the hiding, `[| A |>` and named definitions around it, operand by operand
 * (by machine name where FDR's names agree with the drawing, else by
 * position, flattening the binary operators FDR prints for `A ||| B ||| C`).
 *
 * From that, every step says which operands took part and in which role, and
 * the final state says what each operand offers, which is what it waits
 * for: an event the operands it must share it with do not offer. Waits that
 * go round in a circle are cycles. Where the tree cannot be matched to the
 * drawing, the check says so and the processes it could not place are
 * listed; nothing is placed by guesswork. Pure: tested on recorded output.
 */
import type { ChannelRef, CheckOutcome, CheckProperty, Counterexample, ProcessPath, ProcessRef, ProcessSnapshot, SourceRef, TraceStep, VerificationReport, WaitInfo } from '../verification';
import { normalizeAssertion, splitDots } from '../csp/explain';
import { loopStart, parseState, type FdrBehaviour, type FdrCounterexample, type FdrResult, type FdrRun } from '../csp/fdr';
import type { Assertion, CspmFile, Span } from './ast';
import type { Globals } from './eval';
import { show } from './eval';
import type { CompNode, CspmView, LeafNode, Link, Shape, TreeNode, Use } from './network';
import { spanText } from './parser';

export interface CspmExplainOptions {
  /** The .csp document's URI. */
  uri: string;
  documentVersion?: number;
  /** Why FDR was not run: every check is skipped with this reason. */
  notRun?: string;
}

export interface CspmExplainInput extends CspmExplainOptions {
  /** The document text the file was parsed from. */
  text: string;
  file: CspmFile;
  globals: Globals;
  /** The drawn view of the process an assertion is about. */
  viewFor(assertion: Assertion): CspmView | undefined;
  run?: FdrRun;
}

/** The checks of a file's assertions, in file order. */
export function cspmAssertions(file: CspmFile): Assertion[] {
  return file.decls.filter((decl): decl is Assertion => decl.kind === 'assert');
}

/** A stable id for an assertion: its line (`line 12`). */
export function assertionId(assertion: Assertion): string {
  return `line ${assertion.span.start.line + 1}`;
}

export function explainCspm(input: CspmExplainInput): VerificationReport {
  const assertions = cspmAssertions(input.file);
  const results = input.run ? matchCspmResults(assertions, input.run.results) : [];
  const checks = assertions.map((assertion, i) => outcome(input, assertion, results[i]));
  const assumptions = [
    "FDR checked the file's own assertions as written; nothing was generated or added.",
    'The drawn processes come from the composition structure of the file; FDR’s per-process results (--divide) are matched to them by machine name, else by position.',
  ];
  for (const decl of input.file.decls) if (decl.kind === 'skipped') assumptions.push(`${upper(decl.what)} at line ${decl.span.start.line + 1} is not drawn; FDR still read it.`);
  return { version: 1, producer: 'fdr', uri: input.uri, ...(input.documentVersion !== undefined ? { documentVersion: input.documentVersion } : {}), tool: { name: 'FDR', ...(input.run?.version ? { version: input.run.version } : {}) }, assumptions, checks };
}

/**
 * An assertion's text as FDR prints it back, for matching: FDR drops
 * comments, spaces and parentheses, prints `:[livelock free]` and
 * `:[divergence-free]` as `:[divergence free]`, a generator `i : S` as
 * `i <- S`, and `:[has trace [T]]: <a>` without the colon.
 */
export function assertionKey(text: string): string {
  return normalizeAssertion(text
    .replace(/\{-[\s\S]*?-\}/g, ' ')
    .replace(/--.*$/gm, ' ')
    .replace(/:\[\s*(?:livelock|divergence)\s*-?\s*free/g, ':[divergence free')
    .replace(/<-/g, ':')
    .replace(/\]\s*:\s*</g, ']<'));
}

/**
 * Results matched to assertions by text in file order (an included file's
 * assertions are skipped). When FDR reports exactly as many results as the
 * file has assertions, one whose text matches none takes the result at its
 * own position, if no other assertion took it.
 */
export function matchCspmResults(assertions: readonly Assertion[], results: readonly FdrResult[]): Array<FdrResult | undefined> {
  const out: Array<FdrResult | undefined> = [];
  const taken = new Set<number>();
  let next = 0;
  for (const a of assertions) {
    const want = assertionKey(a.text);
    let k = next;
    while (k < results.length && assertionKey(results[k].assertion) !== want) k++;
    if (k < results.length) {
      out.push(results[k]);
      taken.add(k);
      next = k + 1;
    } else out.push(undefined);
  }
  if (results.length === assertions.length) {
    out.forEach((result, i) => {
      if (!result && !taken.has(i)) out[i] = results[i];
    });
  }
  return out;
}

/** The assertion as written, with its `not`. */
function assertionLabel(a: Assertion): string {
  return a.negated && !/^not\b/.test(a.text) ? `not ${a.text}` : a.text;
}

/** The assertion without its `not`: what FDR checks and then negates. */
function positiveText(a: Assertion): string {
  return a.text.replace(/^not\s+/, '');
}

function propertyOf(a: Assertion): CheckProperty {
  if (a.refinement) return 'refinement';
  const name = (a.property?.name ?? '').replace(/\s*-\s*/g, ' ');
  if (name.startsWith('deadlock free')) return 'deadlock-free';
  if (name.startsWith('divergence free') || name.startsWith('livelock free')) return 'divergence-free';
  if (name.startsWith('deterministic')) return 'deterministic';
  return 'custom';
}

function outcome(input: CspmExplainInput, a: Assertion, r: FdrResult | undefined): CheckOutcome {
  const view = input.viewFor(a);
  const target = view ? { kind: 'procedure' as const, name: view.root.name, at: view.root.source } : { kind: 'procedure' as const, name: a.text, at: { uri: input.uri, span: a.impl.span } };
  const base: CheckOutcome = {
    id: assertionId(a),
    property: propertyOf(a),
    label: assertionLabel(a),
    target,
    status: 'skipped',
    severity: 'error',
    assertion: assertionLabel(a),
  };
  const run = input.run;
  if (!run) return { ...base, message: input.notRun ?? 'FDR was not run' };
  const stats = r ? { ...(r.states !== undefined ? { states: r.states } : {}), ...(r.transitions !== undefined ? { transitions: r.transitions } : {}), ...(r.ms !== undefined ? { ms: r.ms } : {}) } : undefined;
  if (!r) {
    if (run.aborted) return { ...base, status: 'cancelled', message: 'the check was cancelled' };
    if (run.timedOut) return { ...base, status: 'timeout', message: `FDR did not finish within ${(run.durationMs / 1000).toFixed(run.durationMs < 10_000 ? 1 : 0)} s: the model may have more states than FDR can explore in that time (allow more time with fdrTimeoutMs)` };
    if (run.memoryExceeded) return { ...base, status: 'timeout', message: `FDR was stopped after using more than ${Math.round(run.memoryExceeded / 1024 ** 2)} MB of memory (allow more with fdrMemoryMb)` };
    if (run.errors.length) return { ...base, status: 'error', message: `FDR could not check this file: ${tidy(run.errors[0])}` };
    return { ...base, status: 'error', message: run.results.length ? "FDR did not report this assertion (its result is missing from refines' output)" : `FDR could not check this: ${run.stderr.trim() || `refines exited with code ${run.exitCode}`}` };
  }
  if (r.passed === undefined) return { ...base, status: 'error', ...(stats ? { stats } : {}), message: r.errors.length ? tidy(r.errors[0]) : 'FDR could not decide this assertion' };
  const raw = r.counterexamples[0] as FdrCounterexample | undefined;
  const negated = a.negated || r.negated;
  const states = r.states !== undefined ? ` (${r.states.toLocaleString('en-US')} state${r.states === 1 ? '' : 's'})` : '';
  if (negated) {
    // `assert not P`: holds when P fails; FDR's counterexample for P is the witness.
    if (!r.passed) return { ...base, status: 'failed', ...(stats ? { stats } : {}), message: `${positiveText(a)} holds${states}, so its negation does not` };
    return { ...base, status: 'passed', ...(stats ? { stats } : {}), message: `holds: ${positiveText(a)} does not${raw && view ? ` (${new Explainer(input, a, view, run.eventMap).counterexample(raw).summary})` : ''}` };
  }
  if (r.passed) return { ...base, status: 'passed', ...(stats ? { stats } : {}), message: `holds${states}` };
  if (!raw) return { ...base, status: 'failed', ...(stats ? { stats } : {}), message: 'FDR gave no counterexample' };
  if (!view) {
    const steps = (raw.implementation_behaviour?.trace ?? []).map((id) => run.eventMap[String(id)] ?? String(id)).filter((name) => name !== 'τ');
    return { ...base, status: 'failed', ...(stats ? { stats } : {}), message: `it fails after ⟨${steps.join(', ')}⟩; the process it is about is not drawn, so the run is not placed on a graph` };
  }
  const counterexample = new Explainer(input, a, view, run.eventMap).counterexample(raw);
  const notes = (counterexample as Counterexample & { notes?: string[] }).notes ?? [];
  delete (counterexample as Counterexample & { notes?: string[] }).notes;
  return { ...base, status: 'failed', ...(stats ? { stats } : {}), message: `${counterexample.summary}${notes.length ? `. ${notes.join(' ')}` : ''}`, counterexample };
}

function tidy(text: string): string {
  return text.replace(/\s*Lexical call stack:[\s\S]*$/, '').replace(/\s+/g, ' ').trim();
}

function upper(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

// ---------------------------------------------------------------------------
// Matching FDR's --divide tree to the drawn composition
// ---------------------------------------------------------------------------

/** One drawn process instance with FDR's behaviour for it. */
export interface Placed {
  leaf: LeafNode;
  path: ProcessPath;
  /** The behaviour that carries the states (inside sbisim). */
  behaviour: FdrBehaviour;
  /** How it is named: the drawn label, or FDR's machine name for a member of a box drawn once. */
  name: string;
}

/** `sbisim(PHIL(0))` -> `PHIL(0)`; FDR's names of anonymous terms (`sbisim(…)`) stay as they are. */
export function machineName(name: string | undefined): string | undefined {
  let current = name;
  for (let m = current && /^(?:sbisim|normal|diamond|explicate|wbisim|chase)\((.*)\)$/.exec(current); m && m[1] !== '…'; m = /^(?:sbisim|normal|diamond|explicate|wbisim|chase)\((.*)\)$/.exec(current!)) current = m[1];
  return current;
}

function sameName(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && a.replace(/\s+/g, '') === b.replace(/\s+/g, '');
}

/** The behaviour that carries a leaf's own states: inside FDR's compression wrapper. */
function unwrap(b: FdrBehaviour): FdrBehaviour {
  let current = b;
  while (current.child_behaviours?.length === 1 && /^(?:sbisim|normal|diamond|explicate|wbisim|chase)\(/.test(current.machine_name ?? '')) current = current.child_behaviours[0];
  return current;
}

/** Match a drawn tree to FDR's behaviour tree. `notes` gets what could not be matched. */
export function placeTree(tree: TreeNode, b: FdrBehaviour, notes: string[]): Placed[] {
  const out: Placed[] = [];
  const visit = (node: TreeNode, behaviour: FdrBehaviour): void => {
    if (node.kind === 'leaf') {
      out.push({ leaf: node, path: node.path, behaviour: unwrap(behaviour), name: node.label });
      return;
    }
    const found = compositionNode(node, behaviour);
    if (!found) {
      notes.push(`FDR's behaviour for ${node.label || node.operator} does not have the shape of the drawn composition, so its ${node.children.length} operands are not placed.`);
      return;
    }
    const { kids } = found;
    // A box drawn once for every member of a replicated composition: each of FDR's members is placed on it.
    if (node.children.length === 1 && node.children[0].replicated) {
      const child = node.children[0];
      // The member's own step is the replicated composition's (it has no index when drawn once).
      const at = node.path.length;
      kids.forEach((kid, i) => {
        const indexed = child.path.map((step, j) => (j === at ? { ...step, index: i + 1 } : step));
        const fdrName = machineName(kid.machine_name);
        if (child.kind === 'leaf') out.push({ leaf: child, path: indexed, behaviour: unwrap(kid), name: fdrName && !/…/.test(fdrName) ? fdrName : `${child.label} #${i + 1}` });
        else visit({ ...child, path: indexed }, kid);
      });
      return;
    }
    // By name where FDR's machine names agree with the drawing, else by position.
    const order = byNames(node.children, kids);
    if (!order) notes.push(`FDR names the operands of ${node.label || node.operator} differently (an alias or an anonymous term), so they are matched by position.`);
    node.children.forEach((child, i) => visit(child, kids[order ? order[i] : i]));
  };
  visit(tree, b);
  return out;
}

function byNames(children: readonly TreeNode[], kids: readonly FdrBehaviour[]): number[] | undefined {
  const names = kids.map((kid) => machineName(kid.machine_name));
  const used = new Set<number>();
  const order: number[] = [];
  for (const child of children) {
    const label = child.kind === 'leaf' ? child.label : child.label;
    const at = names.findIndex((name, i) => !used.has(i) && sameName(name, label));
    if (at < 0) return children.every((entry, i) => entry.kind === 'comp' || !names[i] || /…/.test(names[i]!) || sameName(names[i], entry.label)) ? children.map((_, i) => i) : undefined;
    used.add(at);
    order.push(at);
  }
  return order;
}

/**
 * The node of FDR's tree that is this composition, with its operands: below
 * the behaviour given, through the hiding, `[| A |>`, `;` and named
 * definitions the composition was drawn through (each may or may not be a
 * node of its own in FDR's tree).
 */
function compositionNode(node: CompNode, b: FdrBehaviour): { node: FdrBehaviour; kids: FdrBehaviour[] } | undefined {
  let states: Array<{ b: FdrBehaviour; depth: number }> = [{ b, depth: 0 }];
  const push = (list: typeof states, entry: (typeof states)[number]): void => {
    if (!list.some((other) => other.b === entry.b)) list.push(entry);
  };
  for (const wrapper of [...node.wrappers, { kind: 'call' as const }]) {
    const next: typeof states = [];
    for (const state of states) {
      push(next, state);
      const kids = state.b.child_behaviours ?? [];
      if (/^sbisim\(/.test(state.b.machine_name ?? '')) continue;
      if (wrapper.kind === 'after' && kids.length >= 2) push(next, { b: kids[0], depth: state.depth + 1 });
      else if (kids.length === 1) push(next, { b: kids[0], depth: state.depth + 1 });
    }
    states = next;
  }
  const k = node.children.length;
  const replicatedOnce = k === 1 && !!node.children[0].replicated;
  let best: { node: FdrBehaviour; kids: FdrBehaviour[]; depth: number } | undefined;
  for (const state of states) {
    const kids = operandsOf(state.b, k, replicatedOnce, node.shape);
    if (kids && (!best || state.depth > best.depth)) best = { node: state.b, kids, depth: state.depth };
  }
  return best;
}

/**
 * FDR's children of a composition node as the drawn operands. A chain of one
 * operator drawn as one composition (`A [| X |] (B [| X |] C)`) stays binary
 * in FDR's tree: it is followed by the shape it was written in, so each
 * operand gets the node of its own position and never a neighbour's. FDR
 * gives a replicated composition its members directly.
 */
function operandsOf(b: FdrBehaviour, k: number, any: boolean, shape: Shape | undefined): FdrBehaviour[] | undefined {
  const kids = [...(b.child_behaviours ?? [])];
  if (any) return kids.length >= 1 && !/^sbisim\(/.test(b.machine_name ?? '') ? kids : undefined;
  if (kids.length < 2) return undefined;
  if (kids.length === k) return kids;
  if (!shape) return undefined;
  const out: FdrBehaviour[] = [];
  const follow = (node: FdrBehaviour, at: Shape): boolean => {
    if (typeof at === 'number') {
      out.push(node);
      return true;
    }
    // An inner node of the chain is an unnamed binary node of FDR's tree.
    const inner = node.child_behaviours ?? [];
    if (inner.length !== 2 || (node !== b && node.machine_name)) return false;
    return follow(inner[0], at[0]) && follow(inner[1], at[1]);
  };
  return follow(b, shape) && out.length === k ? out : undefined;
}

// ---------------------------------------------------------------------------
// Counterexamples
// ---------------------------------------------------------------------------

interface Proc {
  placed: Placed;
  ref: ProcessRef;
  /** Event names per step of the whole trace (undefined: not taking part). */
  steps: Array<string | undefined>;
  acceptance?: string[];
  errorEvent?: string;
  snap?: ProcessSnapshot;
}

class Explainer {
  private procs: Proc[] = [];
  private readonly notes: string[] = [];

  constructor(private readonly input: CspmExplainInput, private readonly assertion: Assertion, private readonly view: CspmView, private readonly eventMap: Record<string, string>) {}

  private name(id: number | undefined): string | undefined {
    return id === undefined || id === 0 ? undefined : this.eventMap[String(id)] ?? String(id);
  }

  counterexample(raw: FdrCounterexample): Counterexample {
    const impl = raw.implementation_behaviour;
    const kind: Counterexample['kind'] = raw.type === 'deadlock' ? 'deadlock' : raw.type === 'divergence' || raw.type === 'refinement_divergence' ? 'divergence' : raw.type === 'determinism' ? 'nondeterminism' : 'refinement';
    const cx: Counterexample & { notes?: string[] } = { kind, steps: [], final: [], summary: '' };
    if (!impl) {
      cx.summary = `${this.assertion.text} fails (FDR gave no behaviour for the process)`;
      return cx;
    }
    const placed = placeTree(this.view.tree, impl, this.notes);
    const length = impl.trace.length;
    const counts = new Map<string, number>();
    for (const entry of placed) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
    this.procs = placed.map((entry) => {
      const aligned = entry.behaviour.trace.length === length;
      if (!aligned) this.notes.push(`FDR's trace for ${entry.name} does not line up with the whole run, so its steps are not attributed to it.`);
      const ref: ProcessRef = { path: entry.path, label: entry.name, ...(entry.leaf.definition ? { procedure: entry.leaf.definition } : {}), name: entry.name, ...(entry.name.length <= 24 ? { short: entry.name } : {}) };
      return {
        placed: entry,
        ref,
        steps: aligned ? entry.behaviour.trace.map((id) => this.name(id)) : [],
        ...(Array.isArray(entry.behaviour.acceptance) ? { acceptance: entry.behaviour.acceptance.map((id) => this.name(id) ?? String(id)) } : {}),
        ...(this.name(entry.behaviour.error_event) ? { errorEvent: this.name(entry.behaviour.error_event) } : {}),
      };
    });
    const loop = loopStart(impl);
    if (loop !== undefined) cx.loopStart = loop;
    // A 0 in the whole trace is a step only the other behaviour of a determinism counterexample takes.
    cx.steps = impl.trace.flatMap((id, index) => (id === 0 ? [] : [this.step(index, this.name(id) ?? String(id))])).map((step, index) => ({ ...step, index }));
    cx.final = this.procs.map((proc) => (proc.snap = this.snapshot(proc, kind, impl, loop)));
    if (kind === 'deadlock' || raw.type === 'failure') {
      const cycles = this.cycles();
      if (cycles.length) cx.cycles = cycles;
    }
    cx.summary = this.summary(kind, raw, impl, cx);
    if (this.notes.length) cx.notes = [...new Set(this.notes)];
    return cx;
  }

  /** The uses of a process that can be this event (`pickup.0.1` against `pickup.i.((i+1)%N)` with i = 0). */
  private usesOf(proc: Proc, event: string): Use[] {
    const atoms = splitDots(event);
    return proc.placed.leaf.uses.filter((use) => {
      if (use.channel !== atoms[0]) return false;
      for (let i = 0; i < use.fields.length; i++) {
        const value = use.fields[i].value;
        if (value && atoms[i + 1] !== undefined && show(value) !== atoms[i + 1] && `(${show(value)})` !== atoms[i + 1]) return false;
      }
      return true;
    });
  }

  private role(proc: Proc, event: string): 'writer' | 'reader' | 'sync' {
    const uses = this.usesOf(proc, event);
    if (uses.length && uses.every((use) => use.fields.some((f) => f.kind === '!') && !use.fields.some((f) => f.kind === '?'))) return 'writer';
    if (uses.length && uses.every((use) => use.fields.some((f) => f.kind === '?') && !use.fields.some((f) => f.kind === '!'))) return 'reader';
    return 'sync';
  }

  private at(proc: Proc, event: string): SourceRef | undefined {
    const use = this.usesOf(proc, event)[0];
    return use ? { uri: this.input.uri, span: use.at } : undefined;
  }

  /** The drawn link these processes share this event on. */
  private linkOf(event: string, members: readonly string[]): Link | undefined {
    const atoms = splitDots(event);
    const under = (key: string): boolean => {
      const parts = splitDots(key);
      return parts.every((part, i) => atoms[i] === part || atoms[i] === part.replace(/^\((.*)\)$/, '$1'));
    };
    const candidates = this.view.links.filter((link) => link.keys.some(under));
    return candidates.find((link) => members.every((member) => link.members.includes(member)) && link.members.length === Math.max(members.length, link.members.length)) ?? candidates.find((link) => members.every((member) => link.members.includes(member)));
  }

  private channelRef(link: Link | undefined): ChannelRef | undefined {
    return link ? { name: link.channel, kind: link.hub ? 'barrier' : 'channel', owner: [] } : undefined;
  }

  private step(index: number, whole: string): TraceStep {
    const takers = this.procs.filter((proc) => proc.steps[index] !== undefined);
    // Below a hiding the whole run shows τ; the processes show the event.
    const real = takers.map((proc) => proc.steps[index]!).find((name) => name !== 'τ') ?? whole;
    const visible = whole !== 'τ';
    if (real === '✓') return { index, event: real, kind: 'termination', participants: takers.map((proc) => ({ process: proc.ref, role: 'actor' as const })), description: `${listText(takers.map((proc) => proc.ref.label)) || 'the process'} terminate${takers.length === 1 ? 's' : ''} (✓)`, visible };
    if (real === 'τ') {
      const who = takers.map((proc) => proc.ref.label);
      return { index, event: 'τ', kind: 'internal', participants: takers.map((proc) => ({ process: proc.ref, role: 'actor' as const })), description: who.length ? `${listText(who)} take${who.length === 1 ? 's' : ''} an internal step (an internal choice, or a hidden event inside ${who.length === 1 ? 'it' : 'them'})` : 'an internal step', visible: false };
    }
    const sharing = takers.filter((proc) => proc.steps[index] === real);
    const link = this.linkOf(real, sharing.map((proc) => proc.placed.leaf.node));
    const participants = sharing.map((proc) => ({ process: proc.ref, role: this.role(proc, real), ...(this.at(proc, real) ? { at: this.at(proc, real)! } : {}) }));
    const writer = participants.find((p) => p.role === 'writer');
    const readers = participants.filter((p) => p.role === 'reader');
    const atoms = splitDots(real);
    const keyLength = link ? Math.max(...link.keys.filter((key) => splitDots(key).every((part, i) => atoms[i] === part)).map((key) => splitDots(key).length), 1) : 1;
    const value = atoms.slice(keyLength).join('.');
    const hidden = !visible ? ' (hidden)' : '';
    let description: string;
    if (!participants.length) description = `${real}${hidden}`;
    else if (writer && readers.length && participants.length === readers.length + 1) description = `${writer.process.label} outputs ${value || real} on ${atoms.slice(0, keyLength).join('.')}; ${listText(readers.map((p) => p.process.label))} input${readers.length === 1 ? 's' : ''} it${hidden}`;
    else if (participants.length === 1) description = `${participants[0].process.label} performs ${real}${visible && (link?.members.length === 1 || !link) ? ' with the environment' : ''}${hidden}`;
    else description = `${listText(participants.map((p) => p.process.label))} synchronise on ${real}${hidden}`;
    const channel = this.channelRef(link);
    return { index, event: real, kind: 'communication', ...(channel ? { channel } : {}), ...(value ? { value } : {}), participants, description, visible };
  }

  private trail(proc: Proc): Array<{ step: number; state: string }> | undefined {
    const states = proc.placed.behaviour.states ?? [];
    const out: Array<{ step: number; state: string }> = [];
    let current: string | undefined;
    states.forEach((state, step) => {
      if (state === '<unchanged>' || state === '<unnamed>') return;
      const name = machineName(state) ?? state;
      if (name !== current && !/…/.test(name)) out.push({ step, state: name });
      current = name;
    });
    return out.length ? out : undefined;
  }

  /** The definition a process was last in, by FDR's named states. */
  private definitionAt(proc: Proc): SourceRef | undefined {
    const states = [...(proc.placed.behaviour.states ?? [])].reverse();
    for (const state of states) {
      if (state === '<unchanged>' || state === '<unnamed>') continue;
      const name = parseState(machineName(state) ?? state).name;
      const def = this.input.globals.definitions.get(name)?.[0];
      if (def) return { uri: this.input.uri, span: def.span };
    }
    const def = proc.placed.leaf.definition ? this.input.globals.definitions.get(proc.placed.leaf.definition)?.[0] : undefined;
    return def ? { uri: this.input.uri, span: def.span } : undefined;
  }

  /** The other processes that must take part in an event with this one: the members of its drawn link. */
  private partnersFor(proc: Proc, event: string): Proc[] {
    const atoms = splitDots(event);
    const links = this.view.links.filter((link) => link.members.includes(proc.placed.leaf.node) && link.keys.some((key) => splitDots(key).every((part, i) => atoms[i] === part)));
    const ids = new Set(links.flatMap((link) => link.members).filter((id) => id !== proc.placed.leaf.node));
    // A box drawn once stands for several processes: partners are those whose own events match.
    return this.procs.filter((other) => other !== proc && ids.has(other.placed.leaf.node) && (other.placed.leaf !== proc.placed.leaf) && (!other.placed.leaf.replicated || this.usesOf(other, event).length > 0));
  }

  private snapshot(proc: Proc, kind: Counterexample['kind'], impl: FdrBehaviour, loop: number | undefined): ProcessSnapshot {
    const trail = this.trail(proc);
    const name = proc.ref.label;
    const base = { process: proc.ref, ...(trail ? { trail } : {}) };
    const lastState = [...(proc.placed.behaviour.states ?? [])].reverse().find((state) => state !== '<unchanged>' && state !== '<unnamed>');
    if (proc.errorEvent && kind !== 'deadlock') {
      const at = this.at(proc, proc.errorEvent);
      const spec = this.assertion.refinement ? spanText(this.input.text, this.assertion.refinement.spec.span) : 'the specification';
      return kind === 'nondeterminism'
        ? { ...base, status: 'running', ...(at ? { at } : {}), badge: `can do or refuse ${proc.errorEvent}`, description: `${name} can perform ${proc.errorEvent} next, and can also refuse it` }
        : { ...base, status: 'running', ...(at ? { at } : {}), badge: `can do ${proc.errorEvent}: refused`, description: `${name} can perform ${proc.errorEvent} next, which ${spec} does not allow` };
    }
    if (kind === 'divergence') {
      const inLoop = loop !== undefined && proc.steps.slice(loop).some((event) => event !== undefined);
      const at = this.definitionAt(proc);
      return inLoop
        ? { ...base, status: 'diverging', ...(at ? { at } : {}), description: `${name} takes part in the steps that repeat forever without the outside seeing any of them` }
        : { ...base, status: 'running', ...(at ? { at } : {}), description: `${name} is not in the steps that repeat` };
    }
    const refused = this.name(impl.error_event);
    if (!proc.acceptance && refused) {
      const at = this.definitionAt(proc);
      return { ...base, status: 'running', ...(at ? { at } : {}), description: `${name} does not take part in ${refused}` };
    }
    if (!proc.acceptance) {
      const at = this.definitionAt(proc);
      return { ...base, status: 'unknown', ...(at ? { at } : {}), description: `FDR did not say what ${name} offers at the end` };
    }
    const offers = proc.acceptance.filter((event) => event !== 'τ');
    if (offers.includes('✓') && offers.length === 1) return { ...base, status: 'terminated', description: `${name} has terminated (SKIP)` };
    if (kind !== 'deadlock') {
      // A failures counterexample: what it offers there is what it may refuse the rest of, not a wait that never ends.
      const at = this.definitionAt(proc);
      const shown = offers.length > 4 ? `${offers.slice(0, 3).join(', ')} and ${offers.length - 3} more` : listText(offers);
      return { ...base, status: 'running', ...(at ? { at } : {}), badge: offers.length ? `offers only ${offers.length > 3 ? `${offers.length} events` : offers.join(', ')}` : 'refuses everything', description: offers.length ? `${name} offers only ${shown} at this point: it may refuse every other event` : `${name} refuses every event at this point` };
    }
    if (!offers.length) {
      const stop = lastState && /^STOP$/.test(machineName(lastState) ?? '');
      const at = this.definitionAt(proc);
      return { ...base, status: 'blocked', ...(at ? { at } : {}), waits: [], description: stop ? `${name} is STOP: it offers nothing` : `${name} offers no event at all` };
    }
    // The values of one input (a.0, a.1, a.2 at the same `a?x`) are one wait.
    const groups = new Map<string, string[]>();
    for (const event of offers) {
      const use = this.usesOf(proc, event)[0];
      const key = use && use.fields.some((field) => field.kind === '?') ? `${use.at.start.line}:${use.at.start.col}` : `event:${event}`;
      groups.set(key, [...(groups.get(key) ?? []), event]);
    }
    const waits: WaitInfo[] = [...groups.values()].map((events) => this.wait(proc, events));
    const at = waits.find((wait) => wait.at)?.at ?? this.definitionAt(proc);
    const description = `${name} offers only ${listText(offers)}${waits.some((wait) => wait.partner) ? `: ${waits.filter((wait) => wait.partner).map((wait) => wait.partner!.detail).slice(0, 2).join('; ')}` : ''}`;
    return { ...base, status: 'blocked', ...(at ? { at } : {}), waits, description };
  }

  /** A wait for some events offered at one place: one event, or the values of one input. */
  private wait(proc: Proc, events: string[]): WaitInfo {
    const event = events[0];
    const role = event === '✓' ? 'other' : this.role(proc, event);
    const operation: WaitInfo['operation'] = role === 'writer' ? 'write' : role === 'reader' ? 'read' : role === 'other' ? 'other' : 'sync';
    const at = this.at(proc, event);
    const shown = events.length <= 3 ? listText(events).replace(/ and ([^ ]+)$/, ' or $1') : `${events.slice(0, 2).join(', ')} or ${events.length - 2} more`;
    const detail = event === '✓' ? 'waits to terminate' : role === 'writer' ? `waits to output ${shown}` : role === 'reader' ? `waits to input ${shown}` : `waits to sync on ${shown}`;
    const partners = event === '✓' ? [] : this.partnersFor(proc, event);
    // Who does not offer any of them.
    const blockers = partners.filter((other) => !events.some((name) => (other.acceptance ?? []).includes(name)));
    const wait: WaitInfo = { operation, ...(at ? { at } : {}), detail };
    // Nobody to share it with: a composition synchronises on it and its other side never performs it.
    const atoms = splitDots(event);
    const blocked = !partners.length ? this.view.blocked.find((entry) => entry.users.includes(proc.placed.leaf.node) && splitDots(entry.key).every((part, i) => atoms[i] === part)) : undefined;
    if (blocked) {
      const missing = this.procs.filter((other) => blocked.missing.includes(other.placed.leaf.node));
      const names = missing.length ? listText(missing.map((other) => other.ref.label)) : 'the other side';
      wait.partner = { ...(missing[0] ? { process: missing[0].ref } : {}), state: 'missing', detail: `${names} never ${missing.length === 1 ? 'performs' : 'perform'} ${event}, and ${blocked.operator} synchronises on it` };
      return wait;
    }
    if (blockers.length) {
      const first = blockers[0];
      const elsewhere = (first.acceptance ?? []).filter((name) => name !== 'τ');
      const state: NonNullable<WaitInfo['partner']>['state'] = elsewhere.length === 1 && elsewhere[0] === '✓' ? 'terminated' : 'blocked-elsewhere';
      const what = state === 'terminated' ? 'has terminated' : elsewhere.length ? `offers only ${listText(elsewhere.slice(0, 3))}${elsewhere.length > 3 ? ' and more' : ''}` : 'offers nothing';
      wait.partner = { process: first.ref, state, detail: `${listText(blockers.map((b) => b.ref.label))} ${blockers.length === 1 ? 'does' : 'do'} not offer ${events.length === 1 ? event : 'any of them'}${blockers.length === 1 ? ` (it ${what})` : ''}` };
    }
    return wait;
  }

  /** Circular waits: each process waits for an event the next does not offer. */
  private cycles(): NonNullable<Counterexample['cycles']> {
    const next = new Map<Proc, Array<{ to: Proc; event: string }>>();
    for (const proc of this.procs) {
      if (proc.snap?.status !== 'blocked') continue;
      const edges: Array<{ to: Proc; event: string }> = [];
      for (const event of (proc.acceptance ?? []).filter((name) => name !== 'τ' && name !== '✓')) {
        for (const other of this.partnersFor(proc, event)) if (!(other.acceptance ?? []).includes(event) && other.snap?.status === 'blocked') edges.push({ to: other, event });
      }
      next.set(proc, edges);
    }
    const found: Array<Array<{ proc: Proc; event: string }>> = [];
    const keys = new Set<string>();
    const walk = (start: Proc, at: Proc, chain: Array<{ proc: Proc; event: string }>, seen: Set<Proc>): void => {
      if (found.length >= 8) return;
      for (const edge of next.get(at) ?? []) {
        if (edge.to === start) {
          const cycle = [...chain, { proc: at, event: edge.event }];
          const key = cycle.map((entry) => entry.proc.ref.label).sort().join('|');
          if (!keys.has(key)) {
            keys.add(key);
            found.push(cycle);
          }
        } else if (!seen.has(edge.to) && chain.length < 24 && this.procs.indexOf(edge.to) > this.procs.indexOf(start)) {
          seen.add(edge.to);
          walk(start, edge.to, [...chain, { proc: at, event: edge.event }], seen);
          seen.delete(edge.to);
        }
      }
    };
    for (const proc of this.procs) walk(proc, proc, [], new Set([proc]));
    return found.map((cycle) => cycle.map(({ proc, event }) => {
      const link = this.linkOf(event, [proc.placed.leaf.node]);
      const channel = this.channelRef(link);
      return { process: proc.ref, ...(channel ? { channel } : {}) };
    }));
  }

  private summary(kind: Counterexample['kind'], raw: FdrCounterexample, impl: FdrBehaviour, cx: Counterexample): string {
    const visible = cx.steps.filter((step) => step.visible !== false).map((step) => step.event);
    const trace = `⟨${visible.join(', ')}⟩`;
    const n = cx.steps.length;
    const after = n === 0 ? 'at the start' : `after ${n} step${n === 1 ? '' : 's'}`;
    const subject = this.view.root.label;
    const spec = this.assertion.refinement ? spanOf(this.input, this.assertion.refinement.spec.span) : undefined;
    switch (kind) {
      case 'deadlock': {
        if (cx.final.length && cx.final.every((snap) => snap.status === 'terminated')) return `${subject} terminates ${after} (${trace}); FDR's deadlock check counts successful termination (SKIP) as a deadlock`;
        const cycle = cx.cycles?.[0];
        if (cycle) return `deadlock ${after} (${trace}): a circular wait, ${cycle.map((entry, i) => `${entry.process.label} waits for ${cycle[(i + 1) % cycle.length].process.label}`).join(', ')}`;
        // A wait nobody can ever answer is the cause; the processes waiting on those come after.
        const blocked = cx.final.filter((snap) => snap.status === 'blocked');
        const cause = (snap: ProcessSnapshot): number => (snap.waits?.some((wait) => wait.partner?.state === 'missing') ? 0 : 1);
        const stuck = [...blocked].sort((a, b) => cause(a) - cause(b)).slice(0, 2).map((snap) => snap.description);
        return `deadlock ${after} (${trace})${stuck.length ? `: ${stuck.join('; ')}` : ''}`;
      }
      case 'divergence': {
        const looping = cx.final.filter((snap) => snap.status === 'diverging').map((snap) => snap.process.label);
        const where = spec ? `, which ${spec} does not allow` : '';
        return `${subject} can diverge ${visible.length ? `after ${trace}` : 'at the start'}: ${looping.length ? listText(looping) : 'it'} can take internal steps forever${where}`;
      }
      case 'nondeterminism': {
        const event = this.name(impl.error_event) ?? this.name(raw.specification_behaviour?.error_event);
        return `${subject} is nondeterministic ${visible.length ? `after ${trace}` : 'at the start'}: it can ${event ? `perform ${event}` : 'perform an event'} and can also refuse it`;
      }
      default: {
        const errorEvent = this.name(impl.error_event);
        if (raw.type === 'trace' || errorEvent) {
          const doers = this.procs.filter((proc) => proc.errorEvent === errorEvent).map((proc) => proc.ref.label);
          return `${subject} can perform ${errorEvent ?? 'an event'} after ${trace}${doers.length ? ` (${listText(doers)})` : ''}, which ${spec ?? 'the specification'} does not allow`;
        }
        if (raw.type === 'failure' || Array.isArray(impl.acceptance)) {
          const offers = (impl.acceptance ?? []).map((id) => this.name(id) ?? String(id)).filter((name) => name !== 'τ');
          const specs = (raw.specification_behaviour as (FdrBehaviour & { acceptances?: number[][] }) | undefined)?.acceptances?.map((set) => `{${set.map((id) => this.name(id) ?? String(id)).join(', ')}}`);
          if (this.assertion.property?.name.startsWith('has trace')) {
            // In the failures models the trace must be one P cannot refuse: each event offered for certain at its turn.
            const model = this.assertion.property.model ?? 'F';
            const wanted = spanOf(this.input, this.assertion.property.trace?.span);
            if (model === 'T') return `${subject} does not have the trace ${wanted}: after ${trace} it can offer only {${offers.join(', ')}}`;
            const next = specs?.length ? specs.join(' or ') : 'the next event of the trace';
            return `${subject} can refuse ${next} after ${trace} (it may offer only {${offers.join(', ')}}): in the ${model} model, :[has trace] ${wanted} needs each event to be offered for certain at its turn; :[has trace [T]] asks only whether the trace is possible`;
          }
          return `after ${trace}, ${subject} can refuse ${offers.length ? `every event but {${offers.join(', ')}}` : 'every event'}${specs?.length ? `, while ${spec ?? 'the specification'} must then offer ${specs.length === 1 ? specs[0] : `one of ${specs.join(', ')}`}` : `, which ${spec ?? 'the specification'} does not allow`}`;
        }
        return `${this.assertion.text} fails ${after} (${trace})`;
      }
    }
  }
}

function spanOf(input: CspmExplainInput, span: Span | undefined): string {
  if (!span) return '';
  return spanText(input.text, span);
}

function listText(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
