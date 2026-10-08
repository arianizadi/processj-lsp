/**
 * Each procedure's communication state machine, read off the CSP model.
 *
 * A state is one of the model's own definitions: a procedure's entry, each
 * blocking point (a communication, a sync and its release, an alt, the start
 * of a par and each of its joins, a call's return point, a loop head, a point
 * where two paths meet) and, for a par branch or par for body, its slot
 * (waiting to be started) and its end (waiting to be collected). These are
 * the names FDR's --divide output gives the states of a process, so every
 * state a counterexample names is one of them. A transition is one way a
 * definition's body goes on to the next state, as the generator recorded it
 * (CspSourceMap.transitions): what happens on the way, and whether a condition
 * the model leaves to FDR decides it. Nothing here is derived from the
 * ProcessJ source again.
 *
 * There is one machine for the code a procedure's own process runs (its
 * thread) and one for each par branch and par for body, which run as
 * processes of their own. A call is a transition of the caller's machine,
 * to where the caller goes on; what happens inside is the callee's machine.
 */
import type { SourceRef } from '../verification';
import { parseState } from './fdr';
import { spanKey, type CspDefinitionInfo, type CspDefinitionKind, type CspModel, type CspTransition, type CspTransitionStep } from './model';

export interface CspMachine {
  /** Stable within a model: `philosopher`, `main#branch:27:8-27:47#1` (see machineKey). */
  key: string;
  /** `philosopher`, `main: branch 2 of the par at line 27`. */
  label: string;
  /** The ProcessJ procedure whose code it is. */
  procedure: string;
  /** The procedure's name in its declaration. */
  declaration?: SourceRef;
  /** The par branch or par for body the machine is the code of; absent for the procedure's own thread. */
  region?: CspDefinitionInfo['region'];
  /** The state a process of this machine starts in. */
  initial: string;
  states: CspMachineState[];
  transitions: CspMachineTransition[];
}

export interface CspMachineState {
  /** The definition's name (`philosopher__18`), or `return` / `STOP` for the ends that are not definitions. */
  id: string;
  kind: CspDefinitionKind | 'return' | 'stop';
  /** What a process in this state does next: `write right`, `alt: read left | read right`, `loop`, `wait for branch 2`. */
  label: string;
  /** The state's operation, statement or par. */
  at?: SourceRef;
  /** The first line of that statement, trimmed. */
  text?: string;
  /** A point the process passes without an operation of its own (a loop head, a meeting point, a return point). */
  passing?: boolean;
}

export interface CspMachineTransition {
  from: string;
  to: string;
  /** What happens on the way: `write left`, `[n < 2]`, `call chopstick`; empty when nothing does. */
  label: string;
  /** Taken only in the runs where a condition holds (an if or loop test, a precondition, a range check). */
  conditional: boolean;
  /** For an alt: the guard (0-based, in source order) the transition starts with. */
  guard?: number;
  /** A call on the way: the callee procedure, whose own machine says what happens inside. */
  call?: string;
  /** The callee's entry definition (`chopstick__body`): the state its machine starts in. */
  callee?: string;
  /** For a call: the call statement. */
  at?: SourceRef;
  /** The path ends in a runtime error. */
  error?: boolean;
}

/** Definitions that are states of a procedure's processes (not the network's helpers and harness). */
const STATE_KINDS = new Set<CspDefinitionKind>(['entry', 'point', 'join', 'slot', 'branch-end']);

/** The key of a machine: the procedure's entry definition base, and the region for a par branch or par for body. */
export function machineKey(base: string, region?: CspDefinitionInfo['region']): string {
  return region ? `${base}#${region.kind}:${spanKey(region.site.span)}${region.index !== undefined ? `#${region.index}` : ''}` : base;
}

/** Every procedure's machines in the model, the thread first and then its branches, in definition order. */
export function stateMachines(model: Pick<CspModel, 'sourceMap'>): CspMachine[] {
  const definitions = Object.values(model.sourceMap.definitions).filter((d) => STATE_KINDS.has(d.kind) && !!d.procedure);
  // Overloads share a procedure name; their definitions share the entry's base (`f_2__body`, `f_2__14`).
  const entries = definitions.filter((d) => d.kind === 'entry' && d.name.endsWith('__body')).map((d) => ({ base: d.name.slice(0, -'__body'.length), entry: d }));
  const baseOf = (d: CspDefinitionInfo): string | undefined => entries
    .filter((e) => e.entry.procedure === d.procedure && d.name.startsWith(`${e.base}__`))
    .sort((a, b) => b.base.length - a.base.length)[0]?.base;
  const machines = new Map<string, CspMachine>();
  const owner = new Map<string, CspMachine>();
  for (const d of definitions) {
    const base = baseOf(d);
    if (!base) continue;
    const key = machineKey(base, d.region);
    let machine = machines.get(key);
    if (!machine) {
      const entry = entries.find((e) => e.base === base)!.entry;
      machine = { key, label: machineLabel(d.procedure!, d.region), procedure: d.procedure!, declaration: entry.at, ...(d.region ? { region: d.region } : {}), initial: '', states: [], transitions: [] };
      machines.set(key, machine);
    }
    machine.states.push(stateOf(d));
    owner.set(d.name, machine);
  }
  for (const machine of machines.values()) {
    // The thread starts at the entry, a branch at its slot.
    const start = machine.states.find((s) => s.kind === (machine.region ? 'slot' : 'entry'));
    machine.initial = start?.id ?? machine.states[0]?.id ?? '';
  }
  // Paths that say the same thing are one transition (both sides of an if going on to the same
  // write, say): conditional only when every one of those paths is.
  const merged = new Map<string, { machine: CspMachine; transition: CspMachineTransition }>();
  for (const t of model.sourceMap.transitions ?? []) {
    const machine = owner.get(t.from);
    if (!machine) continue;
    const to = t.to === 'pj_k' ? 'return' : t.to;
    if (!machine.states.some((s) => s.id === to)) machine.states.push(endState(to, model));
    const label = transitionLabel(t);
    const key = `${machine.key}|${t.from}|${to}|${label}|${t.guard ?? ''}`;
    const seen = merged.get(key);
    if (seen) {
      seen.transition.conditional &&= t.conditional;
      continue;
    }
    const transition: CspMachineTransition = {
      from: t.from,
      to,
      label,
      conditional: t.conditional,
      ...(t.guard !== undefined ? { guard: t.guard } : {}),
      ...(t.call ? { call: model.sourceMap.definitions[t.call]?.procedure ?? t.call.replace(/__body$/, ''), callee: t.call } : {}),
      ...(t.call && t.via.find((step) => step.kind === 'call')?.at ? { at: t.via.find((step) => step.kind === 'call')!.at } : {}),
      ...(t.via.some((step) => step.kind === 'error') ? { error: true } : {}),
    };
    merged.set(key, { machine, transition });
    machine.transitions.push(transition);
  }
  // The only way out of a state is always taken, whatever the conditions on its paths.
  for (const machine of machines.values()) {
    for (const t of machine.transitions) {
      if (t.conditional && machine.transitions.filter((u) => u.from === t.from).length === 1) t.conditional = false;
    }
  }
  return [...machines.values()];
}

/**
 * The machine a model state is in, with the state itself: `philosopher__18(p0f0, p0f1)`
 * is state `philosopher__18` of philosopher's machine. A process inside a call
 * names the callee's state, with the caller's continuation as an argument.
 */
export function machineOfState(machines: readonly CspMachine[], state: string): { machine: CspMachine; state: string } | undefined {
  const { name } = parseState(state);
  for (const machine of machines) {
    if (machine.states.some((s) => s.id === name && s.kind !== 'return' && s.kind !== 'stop')) return { machine, state: name };
  }
  return undefined;
}

function machineLabel(procedure: string, region: CspDefinitionInfo['region']): string {
  if (!region) return procedure;
  const line = region.site.span.start.line + 1;
  return region.kind === 'par-for' ? `${procedure}: the par for body at line ${line}` : `${procedure}: branch ${region.index ?? '?'} of the par (line ${line})`;
}

function stateOf(d: CspDefinitionInfo): CspMachineState {
  const op = d.operation;
  const base: Omit<CspMachineState, 'label'> = { id: d.name, kind: d.kind, ...(d.at ? { at: d.at } : {}), ...(d.text ? { text: d.text } : {}) };
  switch (d.kind) {
    case 'entry':
      return { ...base, label: 'start', passing: true };
    case 'slot':
      return { ...base, label: 'not started: waits for its par' };
    case 'branch-end':
      return { ...base, label: 'finished: waits for its par to end' };
    case 'join':
      return { ...base, label: op?.branch !== undefined ? `wait for branch ${op.branch}` : 'wait for every iteration' };
    default:
      break;
  }
  const v = op?.variable ?? op?.channel;
  switch (op?.kind) {
    case 'write':
      return { ...base, label: `write ${v}` };
    case 'read':
      return { ...base, label: `read ${v}` };
    case 'extended-read':
      return { ...base, label: `read ${v} (extended)` };
    case 'ack':
      return { ...base, label: op.role === 'reader' ? `end the rendezvous on ${v}` : `wait for the reader of ${v}` };
    case 'sync':
      return { ...base, label: d.name.endsWith('_go') ? `wait for ${v} to complete` : `sync ${v}` };
    case 'alt': {
      const guards = (op.guards ?? []).map((g) => (g.kind === 'read' ? `read ${g.variable ?? g.channel}` : g.kind));
      return { ...base, label: `alt: ${guards.join(' | ') || 'no guard'}` };
    }
    case 'par':
      return { ...base, label: 'start the par' };
    case 'par-for':
      return { ...base, label: 'start the par for' };
    case 'loop':
      return { ...base, label: 'loop', passing: true };
    case 'call':
      return { ...base, label: 'back from the call', passing: true };
    case 'internal':
      return { ...base, label: 'go round the loop', passing: true };
    default:
      return { ...base, label: 'paths meet', passing: true };
  }
}

/** The end a transition reaches when it is not a definition: the caller's continuation, STOP, or a definition of another machine. */
function endState(id: string, model: Pick<CspModel, 'sourceMap'>): CspMachineState {
  if (id === 'return') return { id, kind: 'return', label: 'returns to its caller' };
  if (id === 'STOP') return { id, kind: 'stop', label: 'STOP: does nothing ever again' };
  const d = model.sourceMap.definitions[id];
  return d ? stateOf(d) : { id, kind: 'point', label: id };
}

function stepText(step: CspTransitionStep): string | undefined {
  switch (step.kind) {
    case 'write':
    case 'read':
    case 'sync':
      return `${step.kind} ${step.name ?? '?'}`;
    case 'ack':
      return `rendezvous on ${step.name ?? '?'} ends`;
    case 'go':
      return `${step.name ?? 'the barrier'} completes`;
    case 'skip':
    case 'timeout':
      return step.kind;
    case 'enroll':
      return `enroll on ${step.name ?? '?'}`;
    case 'fork':
      return 'start';
    case 'join':
      return step.branch !== undefined ? `branch ${step.branch} ends` : 'every iteration ends';
    case 'resign':
      return `resign from ${step.name ?? '?'}`;
    case 'call':
      return `call ${step.name ?? '?'}`;
    case 'test':
      return step.name ? `[${step.holds ? '' : 'not '}${step.name}]` : step.holds ? '[true]' : '[false]';
    case 'error':
      return `error: ${step.name ?? 'runtime error'}`;
    case 'stop':
      return 'stop';
    case 'tick':
      return undefined;
  }
}

function transitionLabel(t: CspTransition): string {
  return t.via.map(stepText).filter((text): text is string => !!text).join(', ');
}
