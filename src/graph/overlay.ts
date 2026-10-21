/**
 * Placement of verification results on a drawn view.
 *
 * A counterexample names processes by spawn-site path, channels by declarator
 * and owner, and program points by span (src/verification.ts). This module finds
 * the box, the arrow and the arrow end each of those stands for, and words the
 * final state the way a person would explain it. Anything that cannot be placed
 * is kept in `unplaced` so the viewer still lists it.
 */
import type * as A from '../parser/ast';
import { isPartialDeadlock } from '../csp/report';
import { samePath, type ChannelRef, type CheckOutcome, type Counterexample, type ProcessPath, type ProcessRef, type ProcessSnapshot, type SourceRef, type TraceStep, type VerificationReport, type WaitInfo } from '../verification';
import { findChannel, findOperations, findProcess, relocateChannel, relocatePath, sameSource, viewPath, type NetChannel, type NetInstance, type NetNode, type NetworkModel, type NetworkView } from './network';

export interface OverlayProcess {
  node: string;
  /** The process's spawn path (pathKey): how an editor names it when it asks the page to focus it. */
  key: string;
  /** False when the snapshot's process is drawn only through an enclosing box. */
  exact: boolean;
  status: ProcessSnapshot['status'];
  /** Short badge text: `write a`, `read d`, `alt: read x | read y`, `done`. */
  badge: string;
  description: string;
  at?: SourceRef;
  label: string;
  /** The name that tells it apart from the report's other processes (ProcessRef.name, else the label). */
  name: string;
  /**
   * For a blocked process: `root` when one of its waits can never be met (the
   * partner finished, is missing or is not ready) or it is part of a circular
   * wait; `knock-on` when it only waits behind another stuck process. In a run
   * that repeats forever, a wait whose partner could still answer it (it does
   * not in that run) is `knock-on` too: nothing is stuck for good there.
   */
  cause?: 'root' | 'knock-on';
  /** For a blocked process: whether it can never go on (see stuckForGood); otherwise it is left waiting by a run that repeats forever. */
  forGood?: boolean;
  /** The producer's own states the process went through (ProcessSnapshot.trail), for the state machine. */
  trail?: ProcessSnapshot['trail'];
}

export interface OverlayWait {
  node: string;
  /** The drawn edge of the waiting operation's channel at this process, if any. */
  edge?: string;
  /** Which end of `edge` the waiting process is on. */
  end?: 'source' | 'target';
  operation: WaitInfo['operation'];
  channel?: string;
  /** `write never completes: consume has terminated`. */
  reason: string;
  /** What the canvas shows next to the marker: `consume has terminated`. */
  short: string;
  detail: string;
  at?: SourceRef;
  partnerNode?: string;
  /** The partner's state, as the producer gave it. */
  partnerState?: NonNullable<WaitInfo['partner']>['state'];
  /** See OverlayProcess.cause. */
  cause: 'root' | 'knock-on';
}

export interface OverlayCycle {
  nodes: string[];
  edges: string[];
  label: string;
}

export interface OverlayStep {
  index: number;
  kind: TraceStep['kind'];
  visible: boolean;
  event: string;
  value?: string;
  description: string;
  channel?: string;
  /** Edges a message travels along from writer to reader (through a junction when there is one, from or to a port when the other side is the caller). */
  route: string[];
  participants: Array<{ node?: string; role: TraceStep['participants'][number]['role']; at?: SourceRef; label: string }>;
  /** What the real program would need to take this step too (TraceStep.caveat). */
  caveat?: string;
}

/**
 * One step of the replay of how a run locked up, after its trace: a process
 * entering the wait it never leaves, a link of a circular wait closing, or the
 * dead end everything else waits behind. Each says only what the report does.
 */
export interface OverlayFormationStep {
  kind: 'stuck' | 'cycle' | 'dead-end';
  /** The boxes it is about: the process that becomes stuck, the two ends of a link, the processes at the dead end. */
  nodes: string[];
  /** The processes (pathKey) that become stuck at this step: one, or several drawn on the same box. */
  keys: string[];
  /** For `stuck`: index of the last trace step the process took part in; absent when it took part in none. */
  after?: number;
  /** Arrows this step adds: the operations it waits on (stuck, dead end), the link's (cycle). */
  edges: string[];
  /** Boxes of the processes it waits for. */
  partners: string[];
  /** For `cycle`: which circle of OverlayModel.cycles of the first instance, and how many of its links are closed now. */
  cycle?: number;
  link?: number;
  /** `philosopher(1, …) stuck at line 28`. */
  title: string;
  /** Who, what it waits for, at which line, and whom that depends on. */
  caption: string;
  at?: SourceRef;
}

export interface OverlayModel {
  view: string;
  /** Index of the report in the list given to `buildOverlays`. */
  report: number;
  check: string;
  producer: VerificationReport['producer'];
  label: string;
  status: CheckOutcome['status'];
  severity: CheckOutcome['severity'];
  kind?: Counterexample['kind'];
  summary: string;
  /** The report is about an older version of the document. */
  stale: boolean;
  processes: OverlayProcess[];
  waits: OverlayWait[];
  cycles: OverlayCycle[];
  steps: OverlayStep[];
  loopStart?: number;
  error?: { message: string; node?: string; at?: SourceRef };
  /** How the run ends: stuck, repeating forever, at a runtime error, where the model stops (integers), or just ends. */
  ending: 'stuck' | 'loop' | 'error' | 'range' | 'end';
  /** For nondeterminism: the internal step whose outcome decides what the outside can see. */
  choice?: { step: number; node?: string; at?: SourceRef; description: string };
  /** What the run relies on that the real program may not do (Counterexample.caveats). */
  caveats: string[];
  /** Plain-words account of the final state, one sentence per entry. */
  story: string[];
  /**
   * How an FDR run that ends stuck locked up, step by step after its trace
   * (formationSteps); empty for any other result.
   */
  formation: OverlayFormationStep[];
  /** What the report names that is not drawn in this view. */
  unplaced: string[];
  /** The report's paths were mapped onto an expanded call of the checked procedure. */
  relocated?: string;
}

export interface OverlayContext {
  /** Current document version: a report computed for another one is stale. */
  documentVersion?: number;
}

/** Every placeable (view, check) pair of every report with a counterexample. */
export function buildOverlays(model: NetworkModel, reports: readonly VerificationReport[], context: OverlayContext = {}): OverlayModel[] {
  const out: OverlayModel[] = [];
  reports.forEach((report, reportIndex) => {
    for (const check of report.checks) {
      if (!check.counterexample) continue;
      for (const view of model.views) {
        const overlay = overlayFor(model, view, report, reportIndex, check, context);
        if (overlay) out.push(overlay);
      }
    }
  });
  return out;
}

/** The procedure view of a checked procedure: its parameters are the ports. */
function ownView(model: NetworkModel, check: CheckOutcome): NetworkView | undefined {
  if (check.target.kind !== 'procedure') return undefined;
  return model.views.find((view) => view.kind === 'procedure' && view.procedure === check.target.name && (!check.target.at || view.source.span.start.line === check.target.at.span.start.line));
}

/** The view a check is best shown in: its target's own view, or the program view when it is expanded there. */
export function preferredView(model: NetworkModel, check: CheckOutcome, overlays: readonly OverlayModel[], report: number): string | undefined {
  const mine = overlays.filter((overlay) => overlay.check === check.id && overlay.report === report);
  const program = mine.find((overlay) => model.views.find((view) => view.id === overlay.view)?.kind === 'program');
  const own = mine.find((overlay) => model.views.find((view) => view.id === overlay.view)?.procedure === check.target.name && !overlay.relocated);
  if (check.target.kind === 'program') return program?.view ?? own?.view ?? mine[0]?.view;
  // The checker's proofs hold for every instance of a procedure whose par runs, so
  // they are shown in the whole program when that view places them exactly. A
  // procedure model-checked on its own (FDR) may only fail in an environment the
  // program never provides, so it opens on its own view.
  if (mine[0]?.producer === 'checker' && program && program.unplaced.length === 0 && program.processes.every((entry) => entry.exact)) return program.view;
  return own?.view ?? program?.view ?? mine[0]?.view;
}

function targetsView(view: NetworkView, check: CheckOutcome): boolean {
  if (check.target.kind === 'program') return view.kind === 'program';
  if (view.procedure !== check.target.name) return false;
  // Overloads share a name; the declaration line tells them apart.
  return !check.target.at || view.source.span.start.line === check.target.at.span.start.line;
}

function overlayFor(model: NetworkModel, view: NetworkView, report: VerificationReport, reportIndex: number, check: CheckOutcome, context: OverlayContext): OverlayModel | undefined {
  const counterexample = check.counterexample!;
  // Ports of the checked procedure: on its own, their other side is the producer's model of the caller.
  const ports = ownView(model, check)?.nodes.filter((node) => node.kind === 'port' && node.source).map((node) => node.source!) ?? [];
  const isPort = (ref: ChannelRef | undefined): boolean => !!ref?.declaration && ports.some((port) => sameSource(port, ref.declaration!));
  const looping = waitLoops(counterexample);
  const inCycle = (ref: ProcessRef): boolean => looping.has(pathKey(ref.path)) || (counterexample.cycles ?? []).some((cycle) => cycle.length > 1 && cycle.some((entry) => samePath(entry.process.path, ref.path)));
  // A run that repeats forever: a partner that is not ready could still answer, it just does not in this run.
  const lasso = counterexample.loopStart !== undefined;
  // Paths are relative to the checked root; in another view they are mapped onto each instance of it.
  let instances: Array<NetInstance | undefined>;
  if (targetsView(view, check)) instances = [undefined];
  else if (check.target.kind === 'procedure') {
    instances = view.instances.filter((instance) => instance.procedure === check.target.name && (!check.target.at || sameStart(instance.declaration.span, check.target.at.span)));
    if (!instances.length) return undefined;
  } else return undefined;

  const overlay: OverlayModel = {
    view: view.id,
    report: reportIndex,
    check: check.id,
    producer: report.producer,
    label: check.label,
    status: check.status,
    // A run that never ends while something waits for good is a defect, whatever the check's own severity (as on its chip).
    severity: check.status === 'failed' && isPartialDeadlock(counterexample) ? 'error' : check.severity,
    kind: counterexample.kind,
    summary: counterexample.summary,
    stale: context.documentVersion !== undefined && report.documentVersion !== undefined && report.documentVersion !== context.documentVersion,
    processes: [],
    waits: [],
    cycles: [],
    steps: [],
    loopStart: counterexample.loopStart,
    ending: endingOf(counterexample),
    caveats: [...(counterexample.caveats ?? [])],
    story: [],
    formation: [],
    unplaced: [],
    relocated: instances[0] ? `${check.target.name} as called here` : undefined,
  };
  // Where each blocked process and each link of a circle is drawn, over every instance: for the formation replay.
  const drawnStuck = new Map<ProcessSnapshot, DrawnPart>();
  const drawnLinks = new Map<string, DrawnPart>();
  const drawnPart = <K>(parts: Map<K, DrawnPart>, key: K): DrawnPart => {
    let part = parts.get(key);
    if (!part) parts.set(key, (part = { nodes: [], edges: [], partners: [] }));
    return part;
  };
  const unplacedSeen = new Set<string>();
  const unplaced = (text: string): void => {
    if (!unplacedSeen.has(text)) {
      unplacedSeen.add(text);
      overlay.unplaced.push(text);
    }
  };

  instances.forEach((instance, instanceIndex) => {
    const mapPath = (path: ProcessPath): ProcessPath => viewPath(view, instance ? relocatePath(instance, path) : path);
    const mapChannel = (ref: ChannelRef): ChannelRef => instance ? relocateChannel(instance, ref) : ref;
    const placeProcess = (ref: ProcessRef): { node: NetNode; exact: boolean } | undefined => findProcess(view, mapPath(ref.path));
    const placeChannel = (ref: ChannelRef | undefined): NetChannel | undefined => ref ? findChannel(view, mapChannel(ref))?.channel : undefined;
    // The caller of a procedure checked on its own, drawn as the port of the parameter it uses.
    // One channel of a channel-array parameter has a port of its own: the one with its index.
    const portOf = (ref: ChannelRef | undefined): string | undefined => (ref?.declaration && isPort(ref) ? view.nodes.find((node) => node.kind === 'port' && node.source && sameSource(node.source, ref.declaration!) && (node.port?.index === undefined || node.port.index === ref.index))?.id : undefined);

    for (const snapshot of counterexample.final) {
      const placed = placeProcess(snapshot.process);
      if (!placed) {
        unplaced(`${snapshot.process.label}: ${snapshot.description}`);
        continue;
      }
      const waits = snapshot.waits ?? [];
      if (snapshot.status === 'blocked') {
        const part = drawnPart(drawnStuck, snapshot);
        if (!part.nodes.includes(placed.node.id)) part.nodes.push(placed.node.id);
      }
      const rootCause = (wait: WaitInfo): boolean => !wait.partner || (wait.partner.state !== 'blocked-elsewhere' && !(lasso && wait.partner.state === 'not-ready')) || inCycle(snapshot.process);
      overlay.processes.push({
        node: placed.node.id,
        key: pathKey(snapshot.process.path),
        exact: placed.exact,
        status: snapshot.status,
        badge: snapshotBadge(snapshot),
        description: snapshot.description,
        at: snapshot.at,
        label: snapshot.process.label,
        name: snapshot.process.name ?? snapshot.process.label,
        cause: snapshot.status === 'blocked' ? (!waits.length || waits.some(rootCause) ? 'root' : 'knock-on') : undefined,
        ...(snapshot.status === 'blocked' ? { forGood: stuckForGood(snapshot, counterexample) } : {}),
        ...(snapshot.trail ? { trail: snapshot.trail } : {}),
      });
      if (!placed.exact) unplaced(`${snapshot.process.label} is inside ${placed.node.label}, which is drawn without its own processes here`);
      for (const wait of waits) {
        let channel = placeChannel(wait.channel);
        if (!channel && wait.at && OPERATION_KINDS[wait.operation]) {
          // No channel named: the drawn operation of the same kind at that statement.
          const kinds = OPERATION_KINDS[wait.operation]!;
          const operations = findOperations(view, wait.at).filter((entry) => kinds.includes(entry.operation.kind) && contains(wait.at!.span, entry.operation.at.span));
          const operation = operations.find((entry) => entry.node.id === placed.node.id) ?? operations[0];
          if (operation) channel = view.channels.find((entry) => entry.id === operation.operation.channel);
        }
        const partner = wait.partner?.process ? placeProcess(wait.partner.process) : undefined;
        const edge = channel ? edgeAt(view, channel, placed.node.id, partner?.node.id) : undefined;
        if (snapshot.status === 'blocked') {
          const part = drawnPart(drawnStuck, snapshot);
          if (edge && !part.edges.includes(edge.id)) part.edges.push(edge.id);
          // A par waits for all its branches; the report names only the first as its partner.
          if (partner && wait.operation !== 'other' && !part.partners.includes(partner.node.id)) part.partners.push(partner.node.id);
        }
        // Checked on its own, a procedure's port has the producer's model of a caller on its other side;
        // drawn here, that side is a real process the result says nothing about.
        const alone = instance && !wait.partner?.process && isPort(wait.channel) ? `${report.producer === 'fdr' ? "FDR's" : "the checker's"} check of ${check.target.name} on its own` : undefined;
        overlay.waits.push({
          node: placed.node.id,
          edge: edge?.id,
          end: edge ? (edge.from === placed.node.id || isInside(view, placed.node.id, edge.from) || isInside(view, edge.from, placed.node.id) ? 'source' : 'target') : undefined,
          operation: wait.operation,
          channel: channel?.id,
          reason: alone ? `${waitHead(wait)} in ${alone}: ${environmentText(wait)} there` : waitReason(wait, counterexample, snapshot.process),
          short: alone ? `as checked alone: ${environmentText(wait)}` : shortReason(wait, counterexample, snapshot.process),
          detail: wait.detail,
          at: wait.at,
          partnerNode: partner?.node.id,
          partnerState: wait.partner?.state,
          cause: rootCause(wait) ? 'root' : 'knock-on',
        });
        if (wait.channel && !channel) unplaced(`${snapshot.process.label} ${wait.detail}: channel '${wait.channel.name}' is not drawn in this view`);
      }
    }

    (counterexample.cycles ?? []).forEach((cycle, cycleIndex) => {
      const nodes: string[] = [];
      const edges: string[] = [];
      cycle.forEach((entry, index) => {
        const placed = placeProcess(entry.process);
        if (placed) nodes.push(placed.node.id);
        else unplaced(`the circular wait through ${entry.process.label}: it is not drawn in this view`);
        const next = cycle[(index + 1) % cycle.length];
        const nextPlaced = placeProcess(next.process);
        const channel = placeChannel(entry.channel);
        if (entry.channel && !channel) unplaced(`the circular wait on '${entry.channel.name}': the channel is not drawn in this view`);
        const link = drawnPart(drawnLinks, `${cycleIndex}:${index}`);
        for (const id of [placed?.node.id, nextPlaced?.node.id]) if (id && !link.nodes.includes(id)) link.nodes.push(id);
        if (placed && channel) {
          for (const id of routeBetween(view, channel, placed.node.id, nextPlaced?.node.id)) {
            if (!edges.includes(id)) edges.push(id);
            if (!link.edges.includes(id)) link.edges.push(id);
          }
        }
      });
      // Named as the boxes are drawn (`delta(d, a, b)`, shorter than the call as written).
      overlay.cycles.push({ nodes, edges, label: cycleLabel(cycle.map((entry) => placeProcess(entry.process)?.node.name ?? entry.process.label)) });
    });

    if (instanceIndex === 0) {
      for (const step of counterexample.steps) {
        const channel = placeChannel(step.channel);
        const participants = step.participants.map((participant) => ({
          node: placeProcess(participant.process)?.node.id,
          role: participant.role,
          at: participant.at,
          label: participant.process.name ?? participant.process.label,
        }));
        // A value from (or to) the caller of a procedure checked on its own travels through the port.
        const port = step.kind === 'communication' ? portOf(step.channel) : undefined;
        const writer = participants.find((participant) => participant.role === 'writer')?.node ?? (port && participants.some((participant) => participant.role === 'reader') ? port : undefined);
        const reader = participants.find((participant) => participant.role === 'reader')?.node ?? (port && writer !== port ? port : undefined);
        overlay.steps.push({
          index: step.index,
          kind: step.kind,
          visible: step.visible !== false,
          event: step.event,
          value: step.value,
          description: step.description,
          channel: channel?.id,
          route: channel && writer && step.kind === 'communication' ? routeBetween(view, channel, writer, reader) : [],
          participants,
          ...(step.caveat ? { caveat: step.caveat } : {}),
        });
        for (const participant of step.participants) {
          if (!placeProcess(participant.process)) unplaced(`step ${step.index + 1}: ${participant.process.label}`);
        }
        if (step.channel && !channel) unplaced(`step ${step.index + 1}: channel '${step.channel.name}' is not drawn in this view`);
      }
      if (counterexample.error) {
        const errorNode = counterexample.error.at ? findOperations(view, counterexample.error.at)[0]?.node.id : undefined;
        const failing = counterexample.final.find((snapshot) => snapshot.status === 'error');
        overlay.error = { message: counterexample.error.message, at: counterexample.error.at, node: errorNode ?? (failing ? placeProcess(failing.process)?.node.id : undefined) };
        if (!overlay.error.node) unplaced(`${counterexample.error.message}: where it happens is not drawn in this view`);
      }
      if (counterexample.kind === 'nondeterminism') {
        // The internal step the summary names: the last one the outside did not see.
        const step = [...counterexample.steps].reverse().find((entry) => entry.visible === false);
        const actor = step?.participants.find((participant) => participant.role === 'reader') ?? step?.participants[step.participants.length - 1];
        if (step) overlay.choice = { step: step.index, node: actor ? placeProcess(actor.process)?.node.id : undefined, at: actor?.at, description: step.description };
      }
    }
  });

  overlay.story = story(counterexample, check);
  // How FDR's run locked up, after its trace. The checker's results are proofs, not runs: nothing happens in an order.
  if (report.producer === 'fdr' && overlay.ending === 'stuck') {
    // Placed on a call, a procedure checked on its own waits on its environment at its ports, as the waits say.
    const alone = (wait: WaitInfo): string | undefined => (instances[0] && !wait.partner?.process && isPort(wait.channel) ? `FDR's check of ${check.target.name} on its own` : undefined);
    overlay.formation = formationSteps(counterexample, drawnStuck, drawnLinks, alone);
  }
  // Nothing at all landed in this view: it is not a view of this result.
  if (!overlay.processes.length && !overlay.steps.some((step) => step.participants.some((participant) => participant.node))) return undefined;
  return overlay;
}

/** Longest circular-wait label drawn as is; a longer chain shortens its names, then just counts. */
const CYCLE_LABEL = 90;

/**
 * `circular wait: branch 1 → branch 2 → branch 1`. A long chain names each
 * call by its procedure and first argument (`philosopher(0, …)`), and one too
 * long for that only says how many processes it has (the panel lists them).
 */
export function cycleLabel(names: readonly string[]): string {
  const chain = (list: readonly string[]): string => `circular wait: ${[...list, list[0]].join(' → ')}`;
  if (chain(names).length <= CYCLE_LABEL) return chain(names);
  const short = names.map(firstArgument);
  if (chain(short).length <= CYCLE_LABEL) return chain(short);
  return `circular wait of ${names.length} processes, each waiting for the next`;
}

/** `philosopher(0, p0f0.write, p0f1.write)` as `philosopher(0, …)`: a call by its first argument. */
export function firstArgument(name: string): string {
  const open = name.indexOf('(');
  if (open <= 0 || !name.endsWith(')')) return name;
  let depth = 0;
  for (let i = open + 1; i < name.length - 1; i++) {
    const ch = name[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) return `${name.slice(0, i)}, …)`;
  }
  return name;
}

/** A process's spawn path as one string (the root is ''): the key of an overlay process. */
export function pathKey(path: ProcessPath): string {
  return path.map((step) => `${step.kind}:${step.site.uri}:${step.site.span.start.line}:${step.site.span.start.col}:${step.index ?? ''}`).join('/');
}

/**
 * Processes on a circular wait the producer named only through partners: each
 * waits on one operation whose partner is blocked elsewhere, and following the
 * partners comes back to it.
 */
function waitLoops(counterexample: Counterexample): Set<string> {
  const next = new Map<string, string>();
  for (const snapshot of counterexample.final) {
    const waits = snapshot.waits ?? [];
    const partner = snapshot.status === 'blocked' && waits.length === 1 && waits[0].partner?.state === 'blocked-elsewhere' ? waits[0].partner.process : undefined;
    if (partner) next.set(pathKey(snapshot.process.path), pathKey(partner.path));
  }
  const loops = new Set<string>();
  for (const start of next.keys()) {
    const seen: string[] = [];
    let at: string | undefined = start;
    while (at !== undefined && !seen.includes(at)) {
      seen.push(at);
      at = next.get(at);
    }
    if (at !== undefined) for (const entry of seen.slice(seen.indexOf(at))) loops.add(entry);
  }
  return loops;
}

/** Drawn operation kinds a wait of each kind can be. */
const OPERATION_KINDS: Partial<Record<WaitInfo['operation'], string[]>> = {
  read: ['read', 'extended-read'],
  write: ['write'],
  'alt-guard': ['alt-guard', 'read'],
  'extended-read': ['extended-read', 'read'],
  sync: ['sync'],
};

function contains(outer: A.Span, inner: A.Span): boolean {
  const before = (a: A.Pos, b: A.Pos): boolean => a.line < b.line || (a.line === b.line && a.col <= b.col);
  return before(outer.start, inner.start) && before(inner.end, outer.end);
}

/** The drawn edge of `channel` at `node`, preferring the one that leads to `partner`. */
function edgeAt(view: NetworkView, channel: NetChannel, node: string, partner?: string): NetworkView['edges'][number] | undefined {
  const edges = channel.edges.map((id) => view.edges.find((edge) => edge.id === id)).filter((edge): edge is NetworkView['edges'][number] => !!edge);
  const touches = (edge: NetworkView['edges'][number], id: string): boolean => edge.from === id || edge.to === id || isInside(view, edge.from, id) || isInside(view, edge.to, id) || isInside(view, id, edge.from) || isInside(view, id, edge.to);
  const direct = edges.filter((edge) => edge.from === node || edge.to === node);
  const candidates = direct.length ? direct : edges.filter((edge) => touches(edge, node));
  if (partner) {
    const toPartner = candidates.find((edge) => touches(edge, partner));
    if (toPartner) return toPartner;
  }
  return candidates[0];
}

/** Edges from `from` to `to` on one channel: the direct edge, or writer -> junction -> reader. */
function routeBetween(view: NetworkView, channel: NetChannel, from: string, to?: string): string[] {
  const edges = channel.edges.map((id) => view.edges.find((edge) => edge.id === id)).filter((edge): edge is NetworkView['edges'][number] => !!edge);
  const same = (a: string, b: string): boolean => a === b || isInside(view, a, b) || isInside(view, b, a);
  const direct = edges.find((edge) => same(edge.from, from) && (!to || same(edge.to, to)));
  if (direct && (direct.role === 'direct' || direct.role === 'self' || direct.role === 'dangling')) return [direct.id];
  if (direct && !to) return [direct.id];
  const reverse = edges.find((edge) => to && same(edge.from, to) && same(edge.to, from));
  if (reverse) return [reverse.id];
  const into = edges.find((edge) => edge.role === 'fan-in' && (same(edge.from, from) || (to !== undefined && same(edge.from, to))));
  const out = edges.find((edge) => edge.role === 'fan-out' && ((to !== undefined && same(edge.to, to)) || same(edge.to, from)));
  return [into?.id, out?.id].filter((id): id is string => !!id);
}

/** Whether `inner` is drawn inside `outer`. */
function isInside(view: NetworkView, outer: string, inner: string): boolean {
  const parents = new Map(view.nodes.map((node) => [node.id, node.parent]));
  for (let node = parents.get(inner); node; node = parents.get(node)) if (node === outer) return true;
  return false;
}

function sameStart(a: A.Span, b: A.Span): boolean {
  return a.start.line === b.start.line && a.start.col === b.start.col;
}

const VERB: Record<WaitInfo['operation'], string> = {
  read: 'read',
  write: 'write',
  sync: 'sync',
  'alt-guard': 'read',
  'extended-read': 'read',
  timeout: 'timeout',
  other: 'wait',
};

function waitText(wait: WaitInfo): string {
  return wait.channel ? `${VERB[wait.operation]} ${wait.channel.name}` : wait.detail.replace(/^waits to /, '');
}

export function snapshotBadge(snapshot: ProcessSnapshot): string {
  if (snapshot.badge) return snapshot.badge;
  switch (snapshot.status) {
    case 'blocked': {
      const waits = snapshot.waits ?? [];
      if (!waits.length) return 'blocked';
      if (waits.length > 1 || waits[0].operation === 'alt-guard') return `alt: ${waits.map(waitText).join(' | ')}`;
      return waitText(waits[0]);
    }
    case 'terminated': return 'done';
    case 'error': return 'error';
    case 'diverging': return 'diverges';
    case 'running': return 'running';
    default: return '?';
  }
}

/** `reader`, `writer`, `partner`: who would complete a wait of this kind. */
function partnerSide(wait: WaitInfo): string {
  switch (wait.operation) {
    case 'write': return 'reader';
    case 'read':
    case 'alt-guard':
    case 'extended-read': return 'writer';
    case 'sync': return 'partner';
    default: return 'partner';
  }
}

/** What the other side would do: `read`, `write`, `sync on`. */
function partnerVerb(wait: WaitInfo): string {
  switch (wait.operation) {
    case 'write': return 'read';
    case 'read':
    case 'alt-guard':
    case 'extended-read': return 'write';
    case 'sync': return 'sync on';
    default: return 'meet';
  }
}

/** `write never completes`, `its par never finishes`. */
function waitHead(wait: WaitInfo): string {
  if (wait.operation === 'other') return 'never continues';
  if (wait.operation === 'timeout') return 'the timeout never fires';
  return `${VERB[wait.operation]} never completes`;
}

/** The environment of a procedure checked on its own, as the result describes it. */
function environmentText(wait: WaitInfo): string {
  const name = wait.channel?.name ?? 'it';
  return `nothing ${partnerVerb(wait) === 'read' ? 'reads' : partnerVerb(wait) === 'write' ? 'writes' : `${partnerVerb(wait)}s`} ${name}`;
}

/** Why a wait can never complete: `write never completes: consume has terminated`. */
export function waitReason(wait: WaitInfo, counterexample: Counterexample, self?: ProcessRef): string {
  const head = waitHead(wait);
  return wait.partner ? `${head}: ${wait.partner.detail || shortReason(wait, counterexample, self)}` : head;
}

/** Longest producer text the canvas shows as is next to a marker. */
const SHORT = 46;

/**
 * A process next to the arrow that leads to it, as short as that allows: a
 * call by its procedure (`delta(d, a, b)` reads as `delta`), an iteration as
 * the producer names it (`iteration i = 1`), a branch by its label.
 */
function shortWho(ref: ProcessRef): string {
  if (ref.short) return ref.short;
  if (/^\w+\(.*\)$/.test(ref.label)) return ref.label.replace(/^(\w+)\(.*\)$/, '$1');
  return /^iteration\b/.test(ref.label) && ref.name ? ref.name : ref.label;
}

/** The partner's part of the reason, short enough to sit next to the arrow. Says no more than the producer did. */
export function shortReason(wait: WaitInfo, counterexample: Counterexample, self?: ProcessRef): string {
  const partner = wait.partner;
  const side = partnerSide(wait);
  const detail = partner?.detail && partner.detail.length <= SHORT ? partner.detail : undefined;
  if (wait.operation === 'other' || wait.operation === 'timeout') {
    // A par waiting for its branches, a timer: no channel partner to name.
    if (!partner) return wait.operation === 'other' ? 'its par cannot finish' : 'waits on a timer';
    if (detail) return detail;
    const who = partner.process ? shortWho(partner.process) : undefined;
    if (partner.state === 'not-ready') return `${who ?? 'it'} is still running`;
    if (partner.state === 'terminated') return `${who ?? 'it'} has ended`;
    // In a run that repeats forever a branch may only be left waiting by that run, not stuck for good.
    const branch = partner.process ? counterexample.final.find((entry) => samePath(entry.process.path, partner.process!.path)) : undefined;
    const stuck = !branch || stuckForGood(branch, counterexample);
    return who ? `${who} ${stuck ? 'is stuck' : 'is left waiting'}` : stuck ? 'it can never continue' : 'this run never lets it go on';
  }
  if (!partner) return `no ${side} can come`;
  const full = partner.process;
  if (full && self && samePath(full.path, self.path)) return `its ${side} is this same process`;
  const who = full ? shortWho(full) : undefined;
  switch (partner.state) {
    case 'terminated': return `${who ?? `its ${side}`} has terminated`;
    // The process that could answer, and never does.
    case 'missing': return detail ?? (who && wait.channel ? (wait.operation === 'sync' ? `${who} never syncs on ${wait.channel.name}` : `${who} never ${partnerVerb(wait)}s ${wait.channel.name} again`) : `no ${side} can come`);
    // In a run that repeats forever the partner could still answer: the run never lets it.
    case 'not-ready': return counterexample.loopStart !== undefined ? `${who ?? `its ${side}`} could answer; this run never lets it` : `${who ?? `its ${side}`} is not ready`;
    case 'blocked-elsewhere': {
      const elsewhere = full ? counterexample.final.find((snapshot) => samePath(snapshot.process.path, full.path))?.waits?.[0] : undefined;
      if (who && elsewhere?.channel) return `${who} waits on ${elsewhere.channel.name} instead`;
      if (who && elsewhere) return `${who} ${elsewhere.detail}`;
      return detail ?? `${who ?? `its ${side}`} is blocked elsewhere`;
    }
  }
}

/** How a counterexample ends (OverlayModel.ending). */
function endingOf(counterexample: Counterexample): OverlayModel['ending'] {
  if (counterexample.loopStart !== undefined) return 'loop';
  if (counterexample.error) return counterexample.error.kind === 'range' ? 'range' : 'error';
  return counterexample.final.some((snapshot) => snapshot.status === 'blocked') ? 'stuck' : 'end';
}

/** Where a process stands in the story, which tells the most telling first. */
type Part = 'error' | 'diverging' | 'cause' | 'circle' | 'behind' | 'running' | 'waiting' | 'par' | 'done';
const PARTS: readonly Part[] = ['error', 'diverging', 'cause', 'circle', 'behind', 'running', 'waiting', 'par', 'done'];

/**
 * The failure told as a story, the cause first: a result that is about one
 * event (nondeterminism, a refused event) in its own words; then runtime
 * errors and loops; the waits nobody can ever answer; each circle of waits,
 * then the processes in it; the processes stuck behind those; what keeps
 * running; what a run that repeats forever only leaves waiting; and last, one
 * sentence each, the pars that wait for their branches and what has finished.
 * Processes whose sentences differ only in the name are told together.
 */
export function story(counterexample: Counterexample, check: CheckOutcome): string[] {
  const lines: string[] = [];
  const line = (ref?: SourceRef): string => ref ? ` at line ${ref.span.start.line + 1}` : '';
  const lasso = counterexample.loopStart !== undefined;
  if ((counterexample.kind === 'nondeterminism' || counterexample.kind === 'refinement') && counterexample.summary) lines.push(`${upperFirst(counterexample.summary)}.`);
  const inCycle = (snapshot: ProcessSnapshot): boolean => (counterexample.cycles ?? []).some((cycle) => cycle.length > 1 && cycle.some((entry) => samePath(entry.process.path, snapshot.process.path)));
  const partOf = (snapshot: ProcessSnapshot): Part | undefined => {
    switch (snapshot.status) {
      case 'error': return 'error';
      case 'diverging': return 'diverging';
      case 'running': return 'running';
      case 'terminated': return 'done';
      case 'blocked': {
        const waits = snapshot.waits ?? [];
        if (waits.length && waits.every((wait) => wait.operation === 'other')) return 'par';
        if (inCycle(snapshot)) return 'circle';
        if (!stuckForGood(snapshot, counterexample)) return 'waiting';
        return !waits.length || waits.some((wait) => !wait.partner || (wait.partner.state !== 'blocked-elsewhere' && !(lasso && wait.partner.state === 'not-ready'))) ? 'cause' : 'behind';
      }
      default: return undefined;
    }
  };
  // Sentences by part, each group of processes told the same way once.
  const groups = new Map<Part, Map<string, { snapshots: ProcessSnapshot[]; tell: (who: string, plural: boolean) => string }>>();
  // A process the producer marked (the one that can perform a refused event) is told first, in its words.
  for (const snapshot of counterexample.final) if (snapshot.badge && snapshot.status === 'running') lines.push(`${upperFirst(snapshot.description)}.`);
  for (const snapshot of counterexample.final) {
    if (snapshot.badge && snapshot.status === 'running') continue;
    const part = partOf(snapshot);
    if (!part) continue;
    const tell = sentence(snapshot, line, part, counterexample);
    const byText = groups.get(part) ?? new Map();
    groups.set(part, byText);
    const key = tell('\u0000', false);
    const group = byText.get(key);
    if (group) group.snapshots.push(snapshot);
    else byText.set(key, { snapshots: [snapshot], tell });
  }
  const who = (snapshots: readonly ProcessSnapshot[]): string => names(snapshots.map((snapshot) => nameOf(snapshot.process)), 4);
  for (const part of PARTS) {
    const byText = [...(groups.get(part)?.values() ?? [])];
    if (part === 'circle') lines.push(...circles(counterexample));
    if (!byText.length) continue;
    const all = byText.flatMap((group) => group.snapshots);
    if (part === 'running' && all.length > 1) {
      // What keeps running, in one sentence: where each one is.
      const each = all.map((snapshot) => `${nameOf(snapshot.process)}${snapshot.at ? ` (line ${snapshot.at.span.start.line + 1})` : ''}`);
      lines.push(lasso ? `${names(each, 6)} keep running: they take part in the steps that repeat.` : `${names(each, 6)} are still running.`);
    } else if (part === 'par' && all.length > 1) {
      // The pars waiting for their branches only follow from the rest: one sentence.
      const state = all.every((snapshot) => stuckForGood(snapshot, counterexample)) ? 'stuck' : 'left waiting';
      const at = all.map((snapshot) => snapshot.at?.span.start.line).filter((entry): entry is number => entry !== undefined).map((entry) => entry + 1);
      lines.push(`${names(all.map((snapshot) => nameOf(snapshot.process)), 4)} are ${state} at their pars${at.length ? ` (line${at.length === 1 ? '' : 's'} ${names([...new Set(at)].map(String), 6)})` : ''}, waiting for the processes they started to finish.`);
    } else if (part === 'done') {
      lines.push(`${names(all.map((snapshot) => nameOf(snapshot.process)), 4)} ${all.length === 1 ? 'has' : 'have'} finished.`);
    } else {
      for (const group of byText) lines.push(group.tell(who(group.snapshots), group.snapshots.length > 1));
    }
  }
  // A runtime error no process is stopped by in the final state is told on its own.
  if (counterexample.error && !counterexample.final.some((snapshot) => snapshot.status === 'error')) {
    lines.push(counterexample.error.kind === 'range'
      ? `The run leaves the modelled integers${line(counterexample.error.at)}: ${counterexample.error.message}. ${RANGE_NOTE}`
      : `Runtime error${line(counterexample.error.at)}: ${counterexample.error.message}.`);
  }
  if (!lines.length) lines.push(counterexample.summary || check.label);
  return lines;
}

/** What a value outside the modelled integers means, and what to do about it. */
const RANGE_NOTE = 'The model stops following the run there; that is not an error of the program (//@csp int lo..hi gives the model more integers).';

/**
 * The circular waits in words: circles of two that share a process (santa
 * and each reindeer, one iteration and each of the others) as one sentence
 * per process they share, any other circle once, and beyond four sentences
 * only how many more there are.
 */
function circles(counterexample: Counterexample): string[] {
  let rest = (counterexample.cycles ?? []).filter((cycle) => cycle.length > 1);
  const out: string[] = [];
  const key = (entry: { process: ProcessRef }): string => pathKey(entry.process.path);
  for (;;) {
    // The process in the most circles of two that are left.
    const pairs = rest.filter((cycle) => cycle.length === 2);
    const counts = new Map<string, number>();
    for (const cycle of pairs) for (const entry of cycle) counts.set(key(entry), (counts.get(key(entry)) ?? 0) + 1);
    const [hubKey, count] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [];
    if (!hubKey || (count ?? 0) < 2) break;
    const around = pairs.filter((cycle) => cycle.some((entry) => key(entry) === hubKey));
    const hub = around[0].find((entry) => key(entry) === hubKey)!;
    const others = around.map((cycle) => cycle.find((entry) => key(entry) !== hubKey)!);
    out.push(`Circular waits: ${nameOf(hub.process)} waits for each of ${names(others.map((entry) => nameOf(entry.process)), 6)}, and each of them waits for ${nameOf(hub.process)}.`);
    rest = rest.filter((cycle) => !around.includes(cycle));
  }
  for (const cycle of rest) {
    const full = cycle.map((entry) => nameOf(entry.process));
    // A long circle names each call by its first argument (`philosopher(0, …)`).
    const short = full.join('').length > 120 ? full.map(firstArgument) : full;
    out.push(`A circular wait: ${short.map((name, index) => `${name} waits for ${short[(index + 1) % short.length]}`).join(', ')}.`);
  }
  return out.length > 4 ? [...out.slice(0, 3), `${out.length - 3} more circular waits like these.`] : out;
}

/** The name a report gives a process in sentences. */
function nameOf(ref: ProcessRef): string {
  return ref.name ?? ref.label;
}

/** `a`, `a and b`, `a, b and c`, `a, b, c and 3 more` (beyond `max`). */
function names(list: readonly string[], max: number): string {
  if (list.length <= 1) return list[0] ?? '';
  if (list.length > max) return `${list.slice(0, max - 1).join(', ')} and ${list.length - max + 1} more`;
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

function upperFirst(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/**
 * Whether a blocked process can never go on. In a deadlock nothing can, so
 * every blocked process. In a run that repeats forever only one each of whose
 * waits can never be met (its partner finished or is missing, or the par waits
 * for a branch that can never go on), or that is part of a circular wait; a
 * partner that could still answer (the run never lets it) leaves it waiting,
 * which does not make it stuck for good.
 */
export function stuckForGood(snapshot: ProcessSnapshot, counterexample: Counterexample, seen = new Set<ProcessSnapshot>()): boolean {
  if (snapshot.status !== 'blocked') return false;
  if (counterexample.loopStart === undefined) return true;
  if ((counterexample.cycles ?? []).some((cycle) => cycle.length > 1 && cycle.some((entry) => samePath(entry.process.path, snapshot.process.path)))) return true;
  if (seen.has(snapshot)) return false;
  seen.add(snapshot);
  const waits = snapshot.waits ?? [];
  return waits.length > 0 && waits.every((wait) => {
    const partner = wait.partner;
    if (partner?.state === 'terminated' || partner?.state === 'missing') return true;
    if (wait.operation !== 'other' || partner?.state !== 'blocked-elsewhere' || !partner.process) return false;
    const branch = counterexample.final.find((entry) => samePath(entry.process.path, partner.process!.path));
    return !!branch && stuckForGood(branch, counterexample, seen);
  });
}

/**
 * One snapshot's sentence, for one process or for several in the same state.
 * A blocked process that is not stuck for good (a run that repeats forever
 * could let it go on, this one does not) is left waiting. A par waiting for
 * its branches says only that: the branches are told on their own.
 */
function sentence(snapshot: ProcessSnapshot, line: (ref?: SourceRef) => string, part: Part, counterexample: Counterexample): (who: string, plural: boolean) => string {
  const be = (plural: boolean): string => plural ? 'are' : 'is';
  switch (snapshot.status) {
    case 'blocked': {
      const waits = snapshot.waits ?? [];
      const state = stuckForGood(snapshot, counterexample) ? 'stuck' : 'left waiting';
      if (!waits.length) return (who, plural) => `${who} ${be(plural)} blocked${line(snapshot.at)}: ${snapshot.description}`;
      const first = waits[0];
      const doing = waits.length > 1 ? ` choosing between ${waits.map(waitText).join(' and ')}` : first.operation === 'other' ? ` (${first.detail.replace(/^waits/, 'waiting')})` : ` ${gerund(first)}`;
      const why = first.partner && part !== 'par' ? `: ${partnerSentence(first)}` : '';
      return (who, plural) => `${who} ${be(plural)} ${state}${line(first.at ?? snapshot.at)}${doing}${why}.`;
    }
    // The producer's own account (it starts with the process's name, as written): the error, where, and the values it had.
    case 'error': return () => `${snapshot.description}.${counterexample.error?.kind === 'range' ? ` ${RANGE_NOTE}` : ''}`;
    case 'terminated': return (who, plural) => `${who} ${plural ? 'have' : 'has'} finished${line(snapshot.at)}.`;
    case 'diverging': return (who, plural) => `${who} ${plural ? 'keep' : 'keeps'} running internally without ever communicating${line(snapshot.at)}.`;
    default: return (who, plural) => counterexample.loopStart !== undefined
      ? `${who} ${plural ? 'keep' : 'keeps'} running${line(snapshot.at)}: ${plural ? 'they take' : 'it takes'} part in the steps that repeat.`
      : `${who} ${be(plural)} still running${line(snapshot.at)}.`;
  }
}

function gerund(wait: WaitInfo): string {
  // A wait named only by its detail (`waits to sync on pickup.0.1`) reads as `waiting to sync on pickup.0.1`.
  return gerundOf(wait).replace(/^waits /, 'waiting ');
}

function gerundOf(wait: WaitInfo): string {
  const name = wait.channel?.name;
  switch (wait.operation) {
    case 'write': return name ? `writing ${name}` : wait.detail;
    case 'read':
    case 'extended-read': return name ? `reading ${name}` : wait.detail;
    case 'alt-guard': return name ? `waiting in an alt for ${name}` : wait.detail;
    case 'sync': return name ? `syncing on ${name}` : wait.detail;
    case 'timeout': return 'waiting on a timer';
    default: return wait.detail;
  }
}

/** Why the partner never comes, in the producer's words when it gave some. */
function partnerSentence(wait: WaitInfo): string {
  const partner = wait.partner!;
  if (partner.detail) return partner.detail;
  const who = partner.process ? nameOf(partner.process) : undefined;
  switch (partner.state) {
    case 'terminated': return `${who ?? `its ${partnerSide(wait)}`} has finished`;
    case 'missing': return wait.operation === 'sync' ? 'no other enrolled process can still sync on it' : wait.operation === 'other' ? 'it can never continue' : `nothing can still ${partnerVerb(wait)} it`;
    case 'blocked-elsewhere': return `${who ?? `its ${partnerSide(wait)}`} is blocked elsewhere`;
    case 'not-ready': return `${who ?? `its ${partnerSide(wait)}`} is not ready`;
  }
}

/** Where one blocked process, or one link of a circle, is drawn: its boxes, the arrows it waits on, and its partners' boxes. */
export interface DrawnPart {
  nodes: string[];
  edges: string[];
  partners: string[];
}

/** Stuck processes beyond this are told one trace step at a time rather than one process at a time. */
const MAX_STUCK_STEPS = 40;
/** Links of circles beyond this close a whole circle per step. */
const MAX_LINK_STEPS = 24;
/** Circles beyond this are told one by one up to here, then the rest in one step. */
const MAX_CYCLE_STEPS = 12;
/** Longest circle a caption names in full; a longer one names calls by their first argument, then only counts. */
const CHAIN = 170;

/**
 * How a run that ends stuck locked up, told after its trace: one step per
 * blocked process, in the order each entered the wait it never leaves (just
 * after the last trace step it took part in; one that took part in none
 * first; ties in the report's order), processes drawn on one box that entered
 * it after the same step together; then each circular wait closing link by
 * link; then, where waits end at a partner that finished or never comes, that
 * dead end. The last step says who is stuck behind it all and, in a deadlock,
 * that nobody can move. Captions say only what the report does: the wait, its
 * line, and the partner's own wait.
 */
export function formationSteps(counterexample: Counterexample, drawnStuck: ReadonlyMap<ProcessSnapshot, DrawnPart> = new Map(), drawnLinks: ReadonlyMap<string, DrawnPart> = new Map(), alone: (wait: WaitInfo) => string | undefined = () => undefined): OverlayFormationStep[] {
  const blocked = counterexample.final.filter((snapshot) => snapshot.status === 'blocked');
  if (!blocked.length) return [];
  const drawn = (snapshot: ProcessSnapshot): DrawnPart => drawnStuck.get(snapshot) ?? { nodes: [], edges: [], partners: [] };
  const lastStep = (snapshot: ProcessSnapshot): number | undefined => {
    let last: number | undefined;
    counterexample.steps.forEach((step, index) => {
      if (step.participants.some((participant) => samePath(participant.process.path, snapshot.process.path))) last = index;
    });
    return last;
  };
  const after = new Map(blocked.map((snapshot) => [snapshot, lastStep(snapshot)]));
  const order = [...blocked].sort((a, b) => (after.get(a) ?? -1) - (after.get(b) ?? -1) || counterexample.final.indexOf(a) - counterexample.final.indexOf(b));
  // Processes drawn on one box that got stuck after the same step are one step: the drawing cannot tell them apart.
  const byBox = (snapshot: ProcessSnapshot): string => `${after.get(snapshot) ?? ''}|${[...drawn(snapshot).nodes].sort().join(',') || counterexample.final.indexOf(snapshot)}`;
  const byStep = (snapshot: ProcessSnapshot): string => String(after.get(snapshot) ?? '');
  const group = (key: (snapshot: ProcessSnapshot) => string): ProcessSnapshot[][] => {
    const groups = new Map<string, ProcessSnapshot[]>();
    for (const snapshot of order) groups.set(key(snapshot), [...(groups.get(key(snapshot)) ?? []), snapshot]);
    return [...groups.values()];
  };
  let groups = group(byBox);
  const crowded = groups.length > MAX_STUCK_STEPS;
  if (crowded) groups = group(byStep);
  const traced = counterexample.steps.length > 0;
  const steps: OverlayFormationStep[] = groups.map((members) => {
    const first = members[0];
    const parts = members.map(drawn);
    const nodes = unique(parts.flatMap((part) => part.nodes));
    const at = first.waits?.[0]?.at ?? first.at;
    const where = at ? ` at line ${at.span.start.line + 1}` : '';
    const when = whenStuck(after.get(first), traced);
    const rest = members.slice(1).map((snapshot) => nameOf(snapshot.process));
    let caption = stuckCaption(first, counterexample, when, alone);
    if (crowded && members.length > 1) caption = `${members.length} processes are stuck${when}: ${names(members.map((snapshot) => nameOf(snapshot.process)), 6)}.`;
    else if (rest.length) caption += ` On the same box, ${names(rest, 4)} ${rest.length === 1 ? 'is' : 'are'} stuck too.`;
    return {
      kind: 'stuck',
      nodes,
      keys: members.map((snapshot) => pathKey(snapshot.process.path)),
      ...(after.get(first) !== undefined ? { after: after.get(first) } : {}),
      edges: unique(parts.flatMap((part) => part.edges)),
      partners: unique(parts.flatMap((part) => part.partners)).filter((id) => !nodes.includes(id)),
      title: crowded && members.length > 1 ? `${members.length} processes stuck` : `${nameOf(first.process)}${rest.length ? ` and ${rest.length} more` : ''} stuck${where}`,
      caption,
      ...(at ? { at } : {}),
    };
  });

  // The circles, closing link by link (a whole circle a step when there are too many links).
  const cycles = (counterexample.cycles ?? []).map((cycle, index) => ({ cycle, index })).filter((entry) => entry.cycle.length > 1);
  const linkOf = (cycle: number, link: number): DrawnPart => drawnLinks.get(`${cycle}:${link}`) ?? { nodes: [], edges: [], partners: [] };
  const numbered = (index: number): string => (cycles.length > 1 ? ` ${index + 1} of ${cycles.length}` : '');
  const linkSteps = cycles.reduce((sum, entry) => sum + entry.cycle.length, 0) <= MAX_LINK_STEPS;
  cycles.forEach(({ cycle, index }, position) => {
    if (!linkSteps && position >= MAX_CYCLE_STEPS) return;
    const keys = cycle.map((entry) => pathKey(entry.process.path));
    if (!linkSteps) {
      const rest = position === MAX_CYCLE_STEPS - 1 && cycles.length > MAX_CYCLE_STEPS ? cycles.slice(position) : [{ cycle, index }];
      const links = rest.flatMap((entry) => entry.cycle.map((_, link) => linkOf(entry.index, link)));
      steps.push({
        kind: 'cycle',
        nodes: unique(links.flatMap((link) => link.nodes)),
        keys: unique(rest.flatMap((entry) => entry.cycle.map((member) => pathKey(member.process.path)))),
        edges: unique(links.flatMap((link) => link.edges)),
        partners: [],
        cycle: index,
        link: cycle.length,
        title: rest.length > 1 ? `${rest.length} more circular waits` : `circular wait${numbered(position)}`,
        caption: rest.length > 1 ? `${rest.length} more circular waits like these.` : `Circular wait${numbered(position)}: ${chain(cycle.map((entry) => nameOf(entry.process)))}.`,
      });
      return;
    }
    cycle.forEach((entry, link) => {
      const next = cycle[(link + 1) % cycle.length];
      const part = linkOf(index, link);
      const closed = link === cycle.length - 1;
      steps.push({
        kind: 'cycle',
        nodes: part.nodes,
        keys: unique([keys[link], keys[(link + 1) % keys.length]]),
        edges: part.edges,
        partners: part.nodes.slice(1),
        cycle: index,
        link: link + 1,
        title: closed ? `circular wait${numbered(position)} closed` : `circle${numbered(position)}, link ${link + 1} of ${cycle.length}`,
        caption: closed
          ? `Circular wait${numbered(position)}: ${chain(cycle.map((member) => nameOf(member.process)))}.`
          : `Closing the circle${numbered(position)}, link ${link + 1} of ${cycle.length}: ${nameOf(entry.process)} waits for ${nameOf(next.process)}${entry.channel ? ` on ${entry.channel.name}` : ''}.`,
      });
    });
  });

  // Where the waits end without a circle: a partner that finished, never comes, or cannot answer.
  const circled = (snapshot: ProcessSnapshot): boolean => cycles.some((entry) => entry.cycle.some((member) => samePath(member.process.path, snapshot.process.path)));
  const deadEnd = (wait: WaitInfo, snapshot: ProcessSnapshot): boolean => !wait.partner || wait.partner.state !== 'blocked-elsewhere' || (!!wait.partner.process && samePath(wait.partner.process.path, snapshot.process.path));
  const roots = blocked.filter((snapshot) => !circled(snapshot) && (!(snapshot.waits ?? []).length || (snapshot.waits ?? []).some((wait) => deadEnd(wait, snapshot))));
  const behind = blocked.filter((snapshot) => !circled(snapshot) && !roots.includes(snapshot));
  if (roots.length) {
    const parts = roots.map(drawn);
    const nodes = unique(parts.flatMap((part) => part.nodes));
    const told = roots.slice(0, 3).map((snapshot) => deadEndSentence(snapshot, (snapshot.waits ?? []).find((wait) => deadEnd(wait, snapshot)), alone));
    steps.push({
      kind: 'dead-end',
      nodes,
      keys: roots.map((snapshot) => pathKey(snapshot.process.path)),
      edges: unique(parts.flatMap((part) => part.edges)),
      partners: unique(parts.flatMap((part) => part.partners)).filter((id) => !nodes.includes(id)),
      title: roots.length > 1 ? 'dead ends' : 'dead end',
      caption: `${roots.length > 1 ? 'Dead ends' : 'Dead end'}: ${told.join('; ')}${roots.length > 3 ? `; and ${roots.length - 3} more` : ''}.`,
    });
  }
  // The last step says who waits behind it all, and that in the end nothing at all can move.
  const last = steps[steps.length - 1];
  if (last.kind !== 'stuck' && behind.length) last.caption += ` ${names(behind.map((snapshot) => nameOf(snapshot.process)), 4)} ${behind.length === 1 ? 'is' : 'are'} stuck behind ${cycles.length && roots.length ? 'these' : roots.length === 1 || (!roots.length && cycles.length === 1) ? 'it' : 'them'}.`;
  if (counterexample.final.every((snapshot) => snapshot.status === 'blocked' || snapshot.status === 'terminated')) last.caption += ' Nobody can move.';
  return steps;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** ` after step 4`, ` from the start` (a run with steps), or nothing (a result that is no run). */
function whenStuck(after: number | undefined, traced: boolean): string {
  return after !== undefined ? ` after step ${after + 1}` : traced ? ' from the start' : '';
}

/** `a → b → c → a`, shortened like the circle's callout when it is long. */
function chain(list: readonly string[]): string {
  const ring = (entries: readonly string[]): string => [...entries, entries[0]].join(' → ');
  if (ring(list).length <= CHAIN) return ring(list);
  const short = list.map(firstArgument);
  return ring(short).length <= CHAIN ? ring(short) : `a circle of ${list.length} processes, each waiting for the next`;
}

/** What a wait waits for, after `waits`: `to write true on right (p1f2)`, `at its par for a and b to finish`. */
function waitRest(wait: WaitInfo): string {
  if (wait.detail.startsWith('waits ')) return wait.detail.slice('waits '.length);
  return wait.channel ? `to ${VERB[wait.operation]} ${wait.channel.name}` : wait.detail;
}

/**
 * A process entering its last wait: `philosopher(1, …) is stuck at line 28
 * after step 2: it waits to write true on right (p1f2), whose reader
 * chopstick(p2f2.read, …) is itself waiting to read left (p2f2) for
 * philosopher(2, …).`
 */
function stuckCaption(snapshot: ProcessSnapshot, counterexample: Counterexample, when = '', alone: (wait: WaitInfo) => string | undefined = () => undefined): string {
  const who = nameOf(snapshot.process);
  const waits = snapshot.waits ?? [];
  const at = waits[0]?.at ?? snapshot.at;
  const head = `${who} is stuck${at ? ` at line ${at.span.start.line + 1}` : ''}${when}`;
  if (!waits.length) return `${head}: ${snapshot.description}.`;
  if (waits.length > 1) return `${head}: it waits in an alt for ${waits.map(waitText).join(' or ')} (${waits.map((wait) => `${waitText(wait)}: ${shortReason(wait, counterexample, snapshot.process)}`).join('; ')}).`;
  const environment = alone(waits[0]);
  return `${head}: it waits ${waitRest(waits[0])}${environment ? `; in ${environment}, ${environmentText(waits[0])} there` : dependency(waits[0], snapshot, counterexample)}.`;
}

/** Whom a wait depends on: the partner and what that partner waits for in turn, or why no partner comes. */
function dependency(wait: WaitInfo, snapshot: ProcessSnapshot, counterexample: Counterexample): string {
  const partner = wait.partner;
  const side = partnerSide(wait);
  // A par's wait names the branches it waits for; a timer has no partner.
  if (wait.operation === 'other' || (wait.operation === 'timeout' && !partner)) return '';
  if (!partner) return `, and no ${side} can come`;
  if (partner.process && samePath(partner.process.path, snapshot.process.path)) return `; ${partner.detail || `its ${side} is this same process`}`;
  if (partner.state !== 'blocked-elsewhere') return `; ${partnerSentence(wait)}`;
  if (!partner.process) return `; ${partner.detail || `its ${side} is blocked elsewhere`}`;
  const name = nameOf(partner.process);
  const theirs = counterexample.final.find((entry) => samePath(entry.process.path, partner.process!.path))?.waits ?? [];
  if (!theirs.length) return `, whose ${side} ${name} is blocked elsewhere`;
  if (theirs.length > 1) return `, whose ${side} ${name} is itself waiting in an alt for ${theirs.map(waitText).join(' or ')}`;
  const next = theirs[0].operation !== 'other' ? theirs[0].partner?.process : undefined;
  const whom = next ? ` for ${samePath(next.path, snapshot.process.path) ? 'it' : nameOf(next)}` : '';
  return `, whose ${side} ${name} is itself waiting ${waitRest(theirs[0])}${whom}`;
}

/** `main can never read c at line 8: nothing in the program writes c`. */
function deadEndSentence(snapshot: ProcessSnapshot, wait: WaitInfo | undefined, alone: (wait: WaitInfo) => string | undefined): string {
  const who = nameOf(snapshot.process);
  if (!wait) return snapshot.description;
  const at = wait.at ?? snapshot.at;
  const where = at ? ` at line ${at.span.start.line + 1}` : '';
  const environment = alone(wait);
  const why = environment ? `in ${environment}, ${environmentText(wait)} there` : wait.partner ? partnerSentence(wait) : `no ${partnerSide(wait)} can come`;
  if ((snapshot.waits ?? []).length > 1) return `${who} can never complete its alt${where}: ${waitText(wait)}: ${why}`;
  const rest = waitRest(wait);
  const doing = rest.startsWith('to ') ? rest.slice('to '.length) : wait.operation === 'other' ? 'finish its par' : waitText(wait);
  return `${who} can never ${doing}${where}: ${why}`;
}

/** Every check of every report, for verdict chips (with or without a counterexample). */
export interface VerdictChip {
  report: number;
  check: string;
  producer: VerificationReport['producer'];
  label: string;
  status: CheckOutcome['status'];
  severity: CheckOutcome['severity'];
  /** `deadlock after 6 steps`, `runs forever`, `no counterexample`. */
  text: string;
  stats?: CheckOutcome['stats'];
  stale: boolean;
  steps: number;
  views: string[];
  preferredView?: string;
  message?: string;
  /** What a passed check does not cover (CheckOutcome.limits). */
  limits?: string[];
  /** The run relies on something the real program may not do (Counterexample.caveats). */
  caveats?: string[];
  /** The model the check is about, as viewTarget names it: `program`, or `proc:<name>:<line>`. */
  target: string;
  /** A procedure FDR checked on its own: `succ on its own`. */
  targetLabel?: string;
}

export function verdictChips(model: NetworkModel, reports: readonly VerificationReport[], overlays: readonly OverlayModel[], context: OverlayContext = {}): VerdictChip[] {
  const chips: VerdictChip[] = [];
  reports.forEach((report, reportIndex) => {
    const stale = context.documentVersion !== undefined && report.documentVersion !== undefined && report.documentVersion !== context.documentVersion;
    for (const check of report.checks) {
      const counterexample = check.counterexample;
      const steps = counterexample?.steps.length ?? 0;
      const after = steps ? ` after ${steps} step${steps === 1 ? '' : 's'}` : '';
      // A run that never ends while something waits for good is a defect, whatever the check's own severity.
      const partial = check.status === 'failed' && !!counterexample && isPartialDeadlock(counterexample);
      // Nondeterminism is about what the outside sees: counted in visible steps, as the summary does.
      const seen = counterexample?.steps.filter((step) => step.visible !== false).length ?? 0;
      const text = check.status === 'passed'
        ? check.limits?.length ? `holds, ${check.limits.join('; ')}` : 'holds'
        : check.status === 'failed'
          ? counterexample
            ? partial ? `partial deadlock${after}`
              // The checker's channel hazards prove one operation stuck, not the whole program.
              : report.producer === 'checker' && check.property === 'custom' ? 'waits forever'
                // Leaving the modelled integers is where the model stops, not an error of the program.
                : counterexample.error?.kind === 'range' ? `out of the modelled integers${after}`
                  : counterexample.error ? `runtime error${after}`
                    // A run that does not terminate repeats forever, or gets stuck.
                    : counterexample.kind === 'no-termination' ? counterexample.loopStart !== undefined ? 'runs forever' : `gets stuck${after}`
                      : counterexample.kind === 'nondeterminism' ? `nondeterministic ${seen ? `after ${seen} visible step${seen === 1 ? '' : 's'}` : 'at the start'}`
                        // A user's `:[deadlock free]` on a program that ends: FDR counts the end as a deadlock.
                        : counterexample.kind === 'deadlock' && counterexample.final.length && counterexample.final.every((snapshot) => snapshot.status === 'terminated') ? `terminates${after} (FDR counts that as a deadlock)`
                          : model.language === 'cspm' && counterexample.kind === 'refinement' ? `fails${after}`
                            : `${counterexample.kind.replace('-', ' ')}${after}`
            : 'fails'
          : check.status;
      chips.push({
        report: reportIndex,
        check: check.id,
        producer: report.producer,
        label: check.label,
        status: check.status,
        severity: partial ? 'error' : check.severity,
        text,
        stats: check.stats,
        stale,
        steps,
        views: overlays.filter((overlay) => overlay.report === reportIndex && overlay.check === check.id).map((overlay) => overlay.view),
        preferredView: counterexample ? preferredView(model, check, overlays, reportIndex) : undefined,
        message: check.message,
        ...(check.limits?.length ? { limits: check.limits } : {}),
        ...(counterexample?.caveats?.length ? { caveats: counterexample.caveats } : {}),
        target: check.target.kind === 'program' ? 'program' : `proc:${check.target.name}:${check.target.at?.span.start.line ?? ''}`,
        // A CSPm file's assertions are about the processes the file defines: nothing is checked apart from its context.
        ...(check.target.kind === 'procedure' && report.producer === 'fdr' && model.language !== 'cspm' ? { targetLabel: `${check.target.name} on its own` } : {}),
      });
    }
  });
  return chips;
}
