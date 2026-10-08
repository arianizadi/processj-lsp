/**
 * The static process network.
 *
 * Every process instance of the program is one leaf of a fixed parallel
 * composition: the root runs the target procedure; every par branch and every
 * par for iteration is a slot that waits to be started, runs, joins and waits
 * again (so a par inside a loop reuses its slots, exactly matching the
 * identity rule of src/verification.ts, which has no loop iterations in it).
 * Instances are unfolded from the root through calls: a procedure that runs a
 * par gets a fresh instance handle per call path, so two calls of `nandGate`
 * have separate slots.
 *
 * Channels synchronise only where their users meet: at a par, writers and
 * readers of a channel are grouped so the composition syncs on it exactly
 * once (several writers of a shared channel interleave, then meet the readers).
 * A barrier is not a sync set: every user talks to the barrier's runtime
 * counter (PJ_BAR), which lives at the process that declared the barrier.
 *
 * A channel or barrier declared in a par for body is one per iteration: its
 * resource key names the iteration, so iterations never synchronise on each
 * other's channels (the CSPm events have the same names; they interleave).
 *
 * No process of the network ends in SKIP: slots, servers and closed-off
 * operations end in STOP, and the program ends when the root's `pj_end`
 * happens (translate.ts wraps the network in `[| {pj_end} |> SKIP`). FDR's
 * distributed termination over n SKIPs costs about 2^n transitions.
 */
import type * as A from '../parser/ast';
import type { EffectAnalysis } from '../checker/effects';
import type { ChannelRef, ProcessPath, ProcessRef, SourceRef, SpawnSite } from '../verification';
import { show, type Ex } from './cspm';
import type { GeneratedProc } from './gen';
import type { ChanUse, LocalResource, Node, ParIR, ProcIR, Region } from './lower';
import type { CspNetworkNode, CspProcessInfo, CspUse } from './model';
import { siteKey } from './reach';

/** What a static variable (channel, ack, barrier parameter) of a procedure instance is bound to. */
export interface Binding {
  /** CSPm value (`a`, `santa_reindeer.1`, `pj_fork...`). */
  value: Ex;
  /** Profile key of the resource (channels only). */
  resource?: string;
  ref?: ChannelRef;
}

export interface Instance {
  proc: ProcIR;
  h: number;
  bindings: Map<string, Binding>;
  /** Path of the procedure instance: owner of its locals, prefix of its slots. */
  path: ProcessPath;
}

export interface Leaf {
  kind: 'root' | 'branch' | 'iteration' | 'barrier' | 'channel';
  definition: string;
  args: string[];
  process?: ProcessRef;
  barrier?: ChannelRef;
  /** For servers: the resource key of what they serve. */
  resource?: string;
  channels: Map<string, ChannelRef>;
  reads: Set<string>;
  writes: Set<string>;
  /** CSPm event sets of the resources this subtree touches, by resource key. */
  events: Map<string, string[]>;
  /** Pars this process runs (its own and its callees'). */
  pars: ParNode[];
  /**
   * Servers for what this process declares: barrier counters (PJ_BAR) and
   * mediated channels (PJ_MED). They sync with this process's whole subtree.
   */
  servers: Array<{ kind: 'barrier' | 'channel'; events: string[]; args: string[]; ref: ChannelRef; leaf: Leaf }>;
  /** Fork and join events of the pars this process runs. */
  ownEvents: string[];
  /** Channel resources this process's own code uses (not its children's). */
  own: Set<string>;
  /** Resources some par above this process synchronises between its side and another. */
  paired: Set<string>;
  /** This leaf and every leaf it starts, directly or below. */
  subtree: Leaf[];
  /** CSPm channels declared by the code this process runs (local to its subtree). */
  declared: Set<string>;
  /** Leaves in this subtree (for barrier bounds). */
  size: number;
  /** Channel and barrier operations of this process's own code, for explaining a stuck operation. */
  uses: CspUse[];
  /** Barriers the par starting this process enrolls it on. */
  enrolled: Array<{ channel: string; ref: ChannelRef; resource?: string }>;
}

export interface ParNode {
  par: ParIR;
  instance: Instance;
  slots: Leaf[];
  /** Fork and join events every slot of this par shares (par for). */
  shared: string[];
}

export interface NetworkInput {
  procs: ReadonlyMap<A.ProcDecl, ProcIR>;
  generated: ReadonlyMap<ProcIR, GeneratedProc>;
  effects: EffectAnalysis;
  needsInstance(proc: ProcIR): boolean;
  leadsToPar(proc: ProcIR): boolean;
  root: ProcIR;
  /** Bindings of the root's static parameters (procedure checks) and text of its data arguments. */
  rootBindings: Map<string, Binding>;
  rootArgs: string[];
  /** What the root does when its procedure returns (default `pj_end -> STOP`). */
  rootContinuation?: string;
  rootLabel: string;
  maxProcesses: number;
  /**
   * Hide what each sub-network does inside and compress it (`sbisim(diamond(...))`).
   * Much smaller state spaces for big networks; a compressed part is one
   * machine in FDR's counterexamples, so its processes have no states of their own.
   */
  compress?: boolean;
  /** The modelled integers: candidate iterations of a par for whose bounds are computed. */
  intRange: { lo: number; hi: number };
  /** Servers the translator composes around the network (a checked procedure's barrier parameters). */
  serversOutside?: boolean;
  sourceText(proc: ProcIR, span: A.Span): string | undefined;
}

export interface Network {
  /** CSPm definitions of the network, root last. */
  definitions: string[];
  /** Name of the root network definition. */
  root: string;
  /** Parameters of the root network definition (data arguments of a checked procedure). */
  rootParams: string[];
  tree: CspNetworkNode;
  processes: CspProcessInfo[];
  /** Instance functions: call site -> clauses. */
  instanceFunctions: string[];
  /** Number of instances per procedure (for the instance-handle sets). */
  instances: Map<ProcIR, number>;
  /** Largest enroll count, for the barrier operation datatype. */
  maxEnroll: number;
  /** Every barrier counter: CSPm value, bound. */
  barrierMax: number;
  /** `resources`: the channel resources involved, so the translator can retry with mediated channels. */
  unsupported: Array<{ message: string; proc: ProcIR; at: A.Span; resources?: string[] }>;
  /**
   * The network is one process that ends by itself (its root ends in SKIP).
   * Otherwise nothing in it terminates and the program ends on the root's
   * `pj_end` (translate.ts wraps it in `[| {pj_end} |> SKIP`).
   */
  endsItself: boolean;
}

export function buildNetwork(input: NetworkInput): Network {
  return new Builder(input).build();
}

class Builder {
  private readonly counts = new Map<ProcIR, number>();
  private readonly instanceClauses = new Map<string, string[]>();
  private readonly unsupported: Network['unsupported'] = [];
  private leaves = 0;
  private maxEnroll = 1;
  private barrierMax = 2;
  private readonly defs: string[] = [];
  private readonly processes: CspProcessInfo[] = [];
  private readonly defNames = new Set<string>();

  constructor(private readonly input: NetworkInput) {}

  build(): Network {
    const { root } = this.input;
    const h = this.alloc(root);
    const instance: Instance = { proc: root, h, bindings: this.input.rootBindings, path: [] };
    const gen = this.input.generated.get(root)!;
    const args = [...(this.input.needsInstance(root) ? [String(h)] : []), ...this.rootEntryArgs(gen), this.input.rootContinuation ?? 'pj_end -> STOP'];
    const leaf = this.leaf('root', gen.entry, args, { path: [], label: this.input.rootLabel, procedure: root.decl.name.name });
    this.runRegion(leaf, instance, root.thread, [], []);
    const composed = this.compose(leaf, []);
    let { text, tree } = this.close(composed.text, composed.tree);
    // One process and nothing around it: it ends by itself (one SKIP costs FDR nothing). FDR compiles
    // `P [| {pj_end} |> SKIP` of a single process as one machine, which would lose its states' names.
    const endsItself = tree.kind === 'leaf' && !this.input.serversOutside;
    if (endsItself) {
      const ending = leaf.args[leaf.args.length - 1];
      const own = ending.replace(/pj_end -> STOP$/, 'pj_end -> SKIP');
      leaf.args[leaf.args.length - 1] = own;
      const info = this.processes[0];
      info.args = [...leaf.args];
      info.leaf = `${info.definition}(${leaf.args.join(', ')})`;
      text = info.leaf;
    }
    const rootName = 'PJ_NET';
    const params = this.input.rootArgs;
    this.defs.push(`${rootName}${params.length ? `(${params.join(', ')})` : ''} = ${text}`);
    const instanceFunctions: string[] = [];
    for (const [fn, clauses] of this.instanceClauses) instanceFunctions.push(...(clauses.length ? clauses : [`${fn}(_) = 0`]));
    const full: CspNetworkNode = { kind: 'named', name: rootName, child: tree };
    this.assignPositions(full, []);
    return {
      definitions: this.defs,
      root: rootName,
      rootParams: params,
      tree: full,
      processes: this.processes,
      instanceFunctions,
      instances: this.counts,
      maxEnroll: this.maxEnroll,
      barrierMax: this.barrierMax,
      unsupported: this.unsupported,
      endsItself,
    };
  }

  private assignPositions(node: CspNetworkNode, position: number[]): void {
    assignPositions(this.processes, node, position);
  }

  private rootEntryArgs(gen: GeneratedProc): string[] {
    const root = this.input.root;
    let data = 0;
    return gen.entryParams.map((p) => {
      const b = this.input.rootBindings.get(p);
      if (b) return show(b.value);
      const param = root.params.find((x) => x.cspm === p);
      if (param && param.role === 'value') return this.input.rootArgs[data++] ?? p;
      return p;
    });
  }

  private alloc(proc: ProcIR): number {
    const n = (this.counts.get(proc) ?? 0) + 1;
    this.counts.set(proc, n);
    return n;
  }

  private leaf(kind: Leaf['kind'], definition: string, args: string[], process?: ProcessRef): Leaf {
    if (++this.leaves > this.input.maxProcesses) throw new TooBig(this.input.maxProcesses);
    const leaf: Leaf = { kind, definition, args, process, channels: new Map(), reads: new Set(), writes: new Set(), events: new Map(), pars: [], servers: [], ownEvents: [], own: new Set(), paired: new Set(), subtree: [], declared: new Set(), size: 1, uses: [], enrolled: [] };
    leaf.subtree.push(leaf);
    return leaf;
  }

  // -------------------------------------------------------------------------
  // Unfolding
  // -------------------------------------------------------------------------

  /**
   * Walk the code `leaf` runs in `region` of `inst`: record the channels it
   * uses, the pars it starts (their slots become children) and the calls it
   * makes (a callee that runs a par gets an instance whose code runs here).
   */
  private runRegion(leaf: Leaf, inst: Instance, region: Region, prefix: ProcessPath, iterations: number[], stack: ProcIR[] = [], iterValues: ReadonlyMap<string, number> = new Map()): void {
    const proc = inst.proc;
    const gen = this.input.generated.get(proc)!;
    // Barriers and mediated channels declared by this code: their server lives at this process.
    for (const local of proc.locals) {
      if (local.region !== region) continue;
      if (local.kind === 'channel') for (const n of [local.cspm, local.ack, local.mediated?.take, local.mediated?.done]) if (n) leaf.declared.add(n);
      const ref = this.localRef(local, inst);
      const resource = this.resourceKey(local, inst, iterValues);
      if (local.kind === 'barrier') {
        const value = `${local.cspm}.${inst.h}`;
        const counter = this.leaf('barrier', 'PJ_BAR', [value, '0']);
        counter.barrier = ref;
        counter.resource = resource;
        leaf.servers.push({ kind: 'barrier', events: [value], args: [value], ref, leaf: counter });
      } else if (local.mediated) {
        const names = [local.cspm, local.mediated.take, local.mediated.done, local.ack!].map((n) => `${n}.${inst.h}`);
        const server = this.leaf('channel', 'PJ_MED', names);
        server.barrier = ref;
        server.resource = resource;
        leaf.servers.push({ kind: 'channel', events: names, args: names, ref, leaf: server });
      }
    }
    for (const n of proc.nodes) {
      if (n.region !== region) continue;
      this.useNode(leaf, inst, n, iterValues);
      if (n.k === 'par') this.runPar(leaf, inst, n.par, gen, prefix, iterations, stack, iterValues);
      if (n.k === 'call') this.runCall(leaf, inst, n, prefix, iterations, stack, iterValues);
    }
  }

  private useNode(leaf: Leaf, inst: Instance, n: Node, iters: ReadonlyMap<string, number>): void {
    const span = n.at ?? n.stmt?.span;
    const here: SourceRef | undefined = span ? { uri: inst.proc.unit.uri, span } : undefined;
    const site = siteKey(inst.proc, n.id);
    const use = (value: Ex, op: CspUse['op'], b: Binding, at: SourceRef | undefined, ack = false): void => {
      leaf.uses.push({ channel: channelName(value), op, at, procedure: inst.proc.decl.name.name, ref: b.ref, ...(b.resource ? { resource: b.resource } : {}), site, ...(ack ? { ack } : {}) });
    };
    const chan = (c: ChanUse, dir: 'read' | 'write', at = here): void => {
      const b = this.bind(inst, c.ch, iters);
      if (!b) return;
      if (b.ref) leaf.channels.set(channelName(b.value), b.ref);
      // A mediated channel's readers take the value from its server.
      const taken = dir === 'read' && c.take ? this.bind(inst, c.take, iters) : undefined;
      use(taken?.value ?? b.value, dir, b, at);
      for (const extra of [c.ack, c.take, c.done]) {
        const a = extra ? this.bind(inst, extra, iters) : undefined;
        if (a && b.ref) leaf.channels.set(channelName(a.value), b.ref);
      }
      // A mediated channel's users never sync with each other, only with its server.
      if (!b.resource || c.take) return;
      (dir === 'read' ? leaf.reads : leaf.writes).add(b.resource);
      leaf.own.add(b.resource);
      const events = [show(b.value)];
      if (c.ack) {
        const a = this.bind(inst, c.ack, iters);
        if (a) events.push(show(a.value));
      }
      leaf.events.set(b.resource, events);
    };
    switch (n.k) {
      case 'write':
        chan(n.ch, 'write');
        break;
      case 'read':
        chan(n.ch, 'read');
        break;
      case 'alt':
        for (const c of n.cases) if (c.guard.k === 'read') chan(c.guard.ch, 'read', { uri: inst.proc.unit.uri, span: c.at });
        break;
      case 'sync': {
        const b = this.bind(inst, n.b, iters);
        if (b?.ref) leaf.channels.set(channelName(b.value), b.ref);
        if (b) use(b.value, 'sync', b, here);
        break;
      }
      case 'ack': {
        // The end of an extended rendezvous: the reader's completes the writer's wait (explain.ts).
        const b = this.bind(inst, n.ch.ch, iters);
        if (b) use(b.value, n.role === 'reader' ? 'read' : 'write', b, here, true);
        break;
      }
      default:
        break;
    }
  }

  private runPar(leaf: Leaf, inst: Instance, par: ParIR, gen: GeneratedProc, prefix: ProcessPath, iterations: number[], stack: ProcIR[], iterValues: ReadonlyMap<string, number>): void {
    const proc = inst.proc;
    const slots = gen.slots.get(par) ?? [];
    const node: ParNode = { par, instance: inst, slots: [], shared: [] };
    const hSuffix = this.input.needsInstance(proc) ? `.${inst.h}` : '';
    const label = (r: Region): { label: string; procedure?: string } => {
      const stmt = r.stmt;
      if (stmt?.kind === 'ExprStmt' && stmt.expr.kind === 'Invocation') {
        const text = this.input.sourceText(proc, stmt.expr.span) ?? stmt.expr.name.name;
        return { label: text.replace(/\s+/g, ' '), procedure: stmt.expr.name.name };
      }
      return { label: `branch ${r.index}` };
    };
    if (par.kind === 'par') {
      const k = par.regions.length;
      this.maxEnroll = Math.max(this.maxEnroll, k);
      par.regions.forEach((r, i) => {
        const slot = slots[i];
        if (!slot) return;
        const site: SpawnSite = { kind: 'branch', site: { uri: proc.unit.uri, span: r.stmt!.span }, index: i + 1 };
        const path = [...prefix, site];
        const args = [...(hSuffix ? [String(inst.h)] : []), ...slot.statics.map((v) => this.staticArg(inst, v, iterValues))];
        const child = this.leaf('branch', slot.definition, args, { path, ...label(r) });
        leaf.ownEvents.push(`${slot.fork}${hSuffix}`, `${slot.join}${hSuffix}`);
        this.runRegion(child, inst, r, path, iterations, stack, iterValues);
        node.slots.push(child);
      });
      // One fork event starts every branch: the slots synchronise on it with each other.
      if (slots[0]) node.shared.push(`${slots[0].fork}${hSuffix}`);
    } else {
      const r = par.regions[0];
      const slot = slots[0];
      const iter = par.iter!;
      const values = iter.values ?? range(this.input.intRange.lo, this.input.intRange.hi);
      this.maxEnroll = Math.max(this.maxEnroll, values.length);
      const stmt = par.stmt as A.ForStmt;
      for (const v of values) {
        const site: SpawnSite = { kind: 'par-for', site: { uri: proc.unit.uri, span: stmt.span }, index: v };
        const path = [...prefix, site];
        const body = r.stmt?.kind === 'Block' && r.stmt.stmts.length === 1 ? r.stmt.stmts[0] : r.stmt;
        const call = body?.kind === 'ExprStmt' && body.expr.kind === 'Invocation' ? body.expr : undefined;
        const callText = call ? (this.input.sourceText(proc, call.span) ?? call.name.name).replace(/\s+/g, ' ') : undefined;
        const values = new Map(iterValues).set(iter.v, v);
        const args = [...(hSuffix ? [String(inst.h)] : []), show({ k: 'int', v }), ...slot.statics.map((s) => this.staticArg(inst, s, values))];
        const child = this.leaf('iteration', slot.definition, args, {
          path,
          label: `${callText ?? 'iteration'} [${iter.variable} = ${v}]`,
          procedure: call?.name.name,
        });
        this.runRegion(child, inst, r, path, [...iterations, v], stack, values);
        node.slots.push(child);
      }
      node.shared.push(`${slot.fork}${hSuffix}`, `${slot.join}${hSuffix}`);
      leaf.ownEvents.push(`${slot.fork}${hSuffix}`, `${slot.join}${hSuffix}`);
    }
    for (const b of par.enroll) {
      const bound = this.bind(inst, b.b, iterValues);
      if (!bound?.ref) continue;
      leaf.channels.set(channelName(bound.value), bound.ref);
      for (const slot of node.slots) {
        slot.enrolled.push({ channel: channelName(bound.value), ref: bound.ref, ...(bound.resource ? { resource: bound.resource } : {}) });
        slot.channels.set(channelName(bound.value), bound.ref);
      }
    }
    leaf.pars.push(node);
  }

  private runCall(leaf: Leaf, inst: Instance, n: Extract<Node, { k: 'call' }>, prefix: ProcessPath, iterations: number[], stack: ProcIR[], iters: ReadonlyMap<string, number>): void {
    const callee = this.input.procs.get(n.call.callee);
    if (!callee) return;
    // Channel traffic of the callee, through its effect summary (covers callees without an instance).
    const summary = this.input.effects.get(n.call.callee);
    if (summary) {
      const mark = (indices: ReadonlySet<number>, dir: 'read' | 'write'): void => {
        for (const i of indices) {
          const a = n.call.args[i];
          if (!a?.chan || a.chan.take) continue;
          const b = this.bind(inst, a.chan.ch, iters);
          if (!b?.resource) continue;
          (dir === 'read' ? leaf.reads : leaf.writes).add(b.resource);
          leaf.own.add(b.resource);
          const events = [show(b.value)];
          if (a.chan.ack) {
            const ack = this.bind(inst, a.chan.ack, iters);
            if (ack) events.push(show(ack.value));
          }
          leaf.events.set(b.resource, events);
          if (b.ref) leaf.channels.set(channelName(b.value), b.ref);
        }
      };
      mark(summary.transitive.channelReads, 'read');
      mark(summary.transitive.channelWrites, 'write');
    }
    const instanced = this.input.needsInstance(callee);
    const recursive = stack.includes(callee) || callee === inst.proc;
    if (recursive) {
      // A callee that runs no par runs in this process: its operations are recorded already.
      if (instanced) this.unsupported.push({ message: `'${callee.decl.name.name}' calls itself on the way to a par: recursion through par has unboundedly many processes and is not modelled`, proc: inst.proc, at: n.call.site.span });
      return;
    }
    const bindings = this.calleeBindings(inst, n, callee, iters);
    if (!instanced) {
      // The callee runs inside this process. Walk its code for the operations it performs, its own
      // local channels included: with no par below, nothing can ever be their partner, so they block.
      this.runRegion(leaf, { proc: callee, h: 0, bindings, path: prefix }, callee.thread, prefix, iterations, [...stack, inst.proc]);
      return;
    }
    const h = this.alloc(callee);
    const fn = instanceFunctionName(inst.proc, n.call.id);
    const clauses = this.instanceClauses.get(fn) ?? [];
    const key = [inst.h, ...iterations].map((x) => (x < 0 ? `(${x})` : String(x))).join(', ');
    clauses.push(`${fn}(${key}) = ${h}`);
    this.instanceClauses.set(fn, clauses);
    const path = this.input.leadsToPar(callee) ? [...prefix, { kind: 'call' as const, site: { uri: inst.proc.unit.uri, span: n.call.site.span } }] : prefix;
    const calleeInst: Instance = { proc: callee, h, bindings, path };
    this.runRegion(leaf, calleeInst, callee.thread, path, [], [...stack, inst.proc]);
  }

  /** What a callee's channel and barrier parameters are bound to at a call. */
  private calleeBindings(inst: Instance, n: Extract<Node, { k: 'call' }>, callee: ProcIR, iters: ReadonlyMap<string, number>): Map<string, Binding> {
    const bindings = new Map<string, Binding>();
    callee.params.forEach((p, i) => {
      const a = n.call.args[i];
      if (!a) return;
      if (p.role === 'channel' && a.chan) {
        const b = this.bind(inst, a.chan.ch, iters);
        if (b) bindings.set(p.cspm, b);
        const companions: Array<[string | undefined, Ex | undefined]> = [[p.ack, a.chan.ack], [p.take, a.chan.take], [p.done, a.chan.done]];
        for (const [name, value] of companions) {
          const bound = name && value ? this.bind(inst, value, iters) : undefined;
          if (name && bound) bindings.set(name, bound);
        }
      } else if (p.role === 'barrier' && a.barrier) {
        const b = this.bind(inst, a.barrier, iters);
        if (b) bindings.set(p.cspm, b);
      }
    });
    return bindings;
  }

  /**
   * The static value of a variable or global name in an instance. `iters`
   * holds the iteration values of the par fors the code runs in (of this
   * procedure instance): a channel or barrier declared inside one is a
   * different resource in every iteration.
   */
  private bind(inst: Instance, e: Ex, iters: ReadonlyMap<string, number> = new Map()): Binding | undefined {
    if (e.k === 'var') {
      const b = inst.bindings.get(e.name);
      if (b) return b;
      if (e.name === 'pj_h') return { value: { k: 'int', v: inst.h } };
      return undefined;
    }
    if (e.k === 'name') {
      const local = inst.proc.locals.find((l) => l.cspm === e.name || l.ack === e.name);
      if (!local) return { value: e };
      const ref = this.localRef(local, inst);
      const isAck = local.ack === e.name;
      return { value: e, resource: this.resourceKey(local, inst, iters), ref: isAck ? { ...ref } : ref };
    }
    if (e.k === 'dot' && e.head.k === 'name' && e.fields.length === 1 && e.fields[0].k === 'var' && e.fields[0].name === 'pj_h') {
      const name = e.head.name;
      const local = inst.proc.locals.find((l) => l.cspm === name || l.ack === name || l.mediated?.take === name || l.mediated?.done === name);
      const value: Ex = { k: 'dot', head: e.head, fields: [{ k: 'int', v: inst.h }] };
      return { value, ref: local ? this.localRef(local, inst) : undefined, ...(local ? { resource: this.resourceKey(local, inst, iters) } : {}) };
    }
    return undefined;
  }

  /**
   * The identity of one instance of a channel or barrier declaration: the
   * procedure instance and, for a declaration in a par for body, the
   * iteration of every par for around the declaring region.
   */
  private resourceKey(local: LocalResource, inst: Instance, iters: ReadonlyMap<string, number>): string {
    const iterations: string[] = [];
    for (let r: Region | undefined = local.region; r && r.kind !== 'thread'; r = r.par?.owner) {
      if (r.kind === 'iteration' && r.par?.iter) iterations.unshift(`${r.par.iter.v}=${iters.get(r.par.iter.v) ?? '?'}`);
    }
    return `${local.cspm}#${inst.proc.name}#${inst.h}#${pathKey(inst.path)}${iterations.length ? `#${iterations.join(',')}` : ''}`;
  }

  private staticArg(inst: Instance, v: string, iterValues: ReadonlyMap<string, number>): string {
    const it = iterValues.get(v);
    if (it !== undefined) return show({ k: 'int', v: it });
    const b = this.bind(inst, { k: 'var', name: v });
    return b ? show(b.value) : v;
  }

  private localRef(local: LocalResource, inst: Instance): ChannelRef {
    return { name: local.name, kind: local.kind === 'barrier' ? 'barrier' : 'channel', declaration: { uri: inst.proc.unit.uri, span: local.ident.span }, owner: inst.path };
  }

  // -------------------------------------------------------------------------
  // Composition
  // -------------------------------------------------------------------------

  /** The CSPm term for a process and everything it starts, with its tree for the source map. */
  private compose(leaf: Leaf, position: number[]): { text: string; tree: CspNetworkNode } {
    const leafText = `${leaf.definition}${leaf.args.length ? `(${leaf.args.join(', ')})` : ''}`;
    const index = this.recordLeaf(leaf, leafText, position);
    this.leafOf.set(index, leaf);
    // A placeholder: whether the leaf must be closed off (see close()) is known only when the whole tree is built.
    let text = `@@leaf${index}@@`;
    let tree: CspNetworkNode = { kind: 'leaf', process: index };
    const parts: Array<{ text: string; tree: CspNetworkNode }> = [];
    leaf.pars.forEach((p, i) => parts.push(this.composePar(p, [...position, 1, i])));
    if (parts.length) {
      const children = parts.reduce((acc, part) => ({ text: `(${acc.text} [| {pj_end} |] ${part.text})`, tree: { kind: 'parallel', sync: '{pj_end}', left: acc.tree, right: part.tree } as CspNetworkNode }));
      const sync = `{| ${[...new Set(leaf.ownEvents), 'pj_end'].join(', ')} |}`;
      text = `(${text} [| ${sync} |] ${children.text})`;
      tree = { kind: 'parallel', sync, left: tree, right: children.tree };
      for (const p of leaf.pars) for (const sl of p.slots) this.absorb(leaf, sl);
    }
    if (leaf.servers.length) {
      const servers = leaf.servers.map((sv) => {
        let t: string;
        if (sv.kind === 'barrier') {
          // Enrolled and waiting counts never exceed the processes below the declaring one.
          const max = Math.max(2, leaf.size + 1);
          this.barrierMax = Math.max(this.barrierMax, max);
          sv.leaf.args = [...sv.args, String(max)];
          t = `PJ_BAR(${sv.leaf.args.join(', ')})`;
        } else {
          t = `PJ_MED(${sv.args.join(', ')})`;
        }
        return { text: t, tree: { kind: 'leaf', process: this.recordLeaf(sv.leaf, t, []) } as CspNetworkNode };
      });
      const all = servers.reduce((acc, c) => ({ text: `(${acc.text} [| {pj_end} |] ${c.text})`, tree: { kind: 'parallel', sync: '{pj_end}', left: acc.tree, right: c.tree } as CspNetworkNode }));
      const sync = `{| ${[...leaf.servers.flatMap((sv) => sv.events), 'pj_end'].join(', ')} |}`;
      text = `(${text} [| ${sync} |] ${all.text})`;
      tree = { kind: 'parallel', sync, left: tree, right: all.tree };
    }
    if (leaf.pars.length || leaf.servers.length) {
      // A named definition per process with children: FDR shows the name in --divide.
      const name = this.uniqueDef(`PJ_NET_${leaf.definition}${leaf.args.filter((a) => /^\(?-?\d+\)?$/.test(a)).map((a) => `_${a.replace(/[()-]/g, (c) => (c === '-' ? 'm' : ''))}`).join('')}`);
      if (leaf.kind === 'root') return { text, tree };
      if (this.input.compress) {
        // Everything this sub-network does inside: its pars' forks and joins, its servers, its own channels.
        const inside = new Set<string>(['pj_tick', 'pj_skip', 'pj_timeout']);
        for (const l of leaf.subtree) {
          for (const e of l.ownEvents) inside.add(e);
          for (const sv of l.servers) for (const e of sv.events) inside.add(e);
          for (const c of l.declared) inside.add(c);
        }
        const hidden = `{| ${[...inside].join(', ')} |}`;
        this.defs.push(`${name} = sbisim(diamond(${text} \\ ${hidden}))`);
        return { text: name, tree: { kind: 'compressed', name, hidden, child: tree } };
      }
      this.defs.push(`${name} = ${text}`);
      return { text: name, tree: { kind: 'named', name, child: tree } };
    }
    return { text, tree };
  }

  /** Fold a child's profile into its parent's (the parent's subtree contains it). */
  private absorb(parent: Leaf, child: Leaf): void {
    for (const r of child.reads) parent.reads.add(r);
    for (const w of child.writes) parent.writes.add(w);
    for (const [k, v] of child.events) parent.events.set(k, v);
    parent.size += child.size;
    parent.subtree.push(...child.subtree);
  }

  private readonly leafOf = new Map<number, Leaf>();

  /**
   * A program is closed: a channel operation can only happen with a partner
   * process of the program. A process whose own operation on a channel meets
   * no par that synchronises it with another side would otherwise offer the
   * event to FDR's environment, so it is closed off by synchronising those
   * events with STOP: they never happen (the operation blocks forever, as it
   * does at runtime). The process's other events are not affected, and the
   * program still ends on the root's `pj_end`. Harness channels of a checked
   * procedure stay open: the environment is the procedure's caller.
   */
  private close(text: string, tree: CspNetworkNode): { text: string; tree: CspNetworkNode } {
    const closedLeaves = new Map<number, string>();
    for (const [index, leaf] of this.leafOf) {
      const open = [...leaf.own].filter((r) => !leaf.paired.has(r) && !r.startsWith('harness:'));
      if (!open.length) continue;
      const events = [...new Set(open.flatMap((r) => leaf.events.get(r) ?? []))];
      if (events.length) closedLeaves.set(index, `{| ${events.join(', ')} |}`);
    }
    const leafText = (index: number): string => {
      const p = this.processes[index];
      const block = closedLeaves.get(index);
      return block ? `(${p.leaf} [| ${block} |] STOP)` : p.leaf;
    };
    const rewrite = (node: CspNetworkNode): CspNetworkNode => {
      switch (node.kind) {
        case 'leaf': {
          const block = closedLeaves.get(node.process);
          return block ? { kind: 'block', events: block, child: node } : node;
        }
        case 'parallel':
          return { ...node, left: rewrite(node.left), right: rewrite(node.right) };
        case 'named':
        case 'hide':
        case 'block':
        case 'compressed':
        case 'exception':
          return { ...node, child: rewrite(node.child) };
      }
    };
    const fill = (t: string): string => t.replace(/@@leaf(\d+)@@/g, (_, i) => leafText(Number(i)));
    for (let i = 0; i < this.defs.length; i++) this.defs[i] = fill(this.defs[i]);
    return { text: fill(text), tree: rewrite(tree) };
  }

  private uniqueDef(base: string): string {
    let name = base;
    for (let i = 2; this.defNames.has(name); i++) name = `${base}_${i}`;
    this.defNames.add(name);
    return name;
  }

  private recordLeaf(leaf: Leaf, text: string, position: number[]): number {
    const index = this.processes.length;
    this.processes.push({
      position,
      leaf: text,
      definition: leaf.definition,
      args: leaf.args,
      kind: leaf.kind,
      process: leaf.process,
      barrier: leaf.barrier,
      ...(leaf.resource ? { resource: leaf.resource } : {}),
      channels: Object.fromEntries(leaf.channels),
      uses: leaf.uses,
      enrolled: leaf.enrolled,
    });
    return index;
  }

  /**
   * Compose the slots of one par. Users of a channel on the same side
   * interleave; writers meet readers once, at the node that joins the last
   * of them. When no tree can do that (a branch that both reads and writes a
   * channel another branch also uses), the par is not modelled.
   */
  private composePar(p: ParNode, position: number[]): { text: string; tree: CspNetworkNode } {
    // Composing a slot completes its profile (it absorbs everything it starts).
    const composed = p.slots.map((s, i) => ({ ...this.compose(s, [...position, i]), leaf: s }));
    interface Group {
      text: string;
      tree: CspNetworkNode;
      members: Set<number>;
      reads: Set<string>;
      writes: Set<string>;
      closed: Set<string>;
    }
    const users = new Map<string, Set<number>>();
    const events = new Map<string, string[]>();
    composed.forEach((c, i) => {
      for (const r of [...c.leaf.reads, ...c.leaf.writes]) {
        const set = users.get(r) ?? new Set<number>();
        set.add(i);
        users.set(r, set);
      }
      for (const [k, v] of c.leaf.events) events.set(k, v);
    });
    // A resource one slot both reads and writes, with another user: no grouping can sync it exactly.
    for (const [r, u] of users) {
      if (u.size < 2) continue;
      for (const i of u) {
        const c = composed[i].leaf;
        if (c.reads.has(r) && c.writes.has(r)) {
          this.unsupported.push({
            message: `channel '${resourceName(r)}' is both read and written inside branch ${i + 1} of this par while another branch also uses it; several processes sharing one side of a channel with an internal rendezvous are not modelled yet`,
            proc: p.instance.proc,
            at: p.par.stmt.span,
            resources: [r],
          });
          break;
        }
      }
    }
    let groups: Group[] = composed.map((c, i) => ({
      text: c.text,
      tree: c.tree,
      members: new Set([i]),
      reads: new Set([...c.leaf.reads].filter((r) => (users.get(r)?.size ?? 0) > 1)),
      writes: new Set([...c.leaf.writes].filter((r) => (users.get(r)?.size ?? 0) > 1)),
      closed: new Set<string>(),
    }));
    const shared = [...p.shared, 'pj_end'];
    let failed = false;
    while (groups.length > 1) {
      let chosen: { i: number; j: number; sync: string[] } | undefined;
      // Adjacent pairs first (source order reads best), then any pair.
      const pairs: Array<[number, number]> = [];
      for (let d = 1; d < groups.length; d++) for (let i = 0; i + d < groups.length; i++) pairs.push([i, i + d]);
      for (const [i, j] of pairs) {
        const sync = this.mergeable(groups[i], groups[j], users);
        if (sync) {
          chosen = { i, j, sync };
          break;
        }
      }
      if (!chosen) {
        if (!failed) this.unsupported.push({ message: 'the branches of this par share channels in a pattern the model cannot compose (several writers and readers of crossing channels)', proc: p.instance.proc, at: p.par.stmt.span, resources: [...users.keys()] });
        failed = true;
        chosen = { i: 0, j: 1, sync: [] };
      }
      const a = groups[chosen.i];
      const b = groups[chosen.j];
      // Every process on either side now has a partner side for these channels.
      for (const m of [...a.members, ...b.members]) for (const l of composed[m].leaf.subtree) for (const r of chosen.sync) l.paired.add(r);
      const syncEvents = [...chosen.sync.flatMap((r) => events.get(r) ?? []), ...shared];
      const sync = `{| ${[...new Set(syncEvents)].join(', ')} |}`;
      const merged: Group = {
        text: `(${a.text} [| ${sync} |] ${b.text})`,
        tree: { kind: 'parallel', sync, left: a.tree, right: b.tree },
        members: new Set([...a.members, ...b.members]),
        reads: new Set([...a.reads, ...b.reads]),
        writes: new Set([...a.writes, ...b.writes]),
        closed: new Set([...a.closed, ...b.closed, ...chosen.sync]),
      };
      groups = groups.filter((_, k) => k !== chosen!.i && k !== chosen!.j);
      groups.splice(Math.min(chosen.i, chosen.j), 0, merged);
    }
    return { text: groups[0]?.text ?? 'SKIP', tree: groups[0]?.tree ?? { kind: 'leaf', process: -1 } };
  }

  /** The resources two groups sync on when merged, or undefined when merging them would be wrong. */
  private mergeable(
    a: { members: Set<number>; reads: Set<string>; writes: Set<string>; closed: Set<string> },
    b: { members: Set<number>; reads: Set<string>; writes: Set<string>; closed: Set<string> },
    users: Map<string, Set<number>>,
  ): string[] | undefined {
    const sync: string[] = [];
    const resources = new Set([...a.reads, ...a.writes, ...b.reads, ...b.writes]);
    for (const r of resources) {
      const aUses = a.reads.has(r) || a.writes.has(r);
      const bUses = b.reads.has(r) || b.writes.has(r);
      if (!aUses || !bUses) continue;
      if (a.closed.has(r) || b.closed.has(r)) return undefined;
      const aPure = a.reads.has(r) !== a.writes.has(r);
      const bPure = b.reads.has(r) !== b.writes.has(r);
      if (!aPure || !bPure) return undefined;
      if (a.writes.has(r) === b.writes.has(r)) continue; // same side: interleave
      // Writers meet readers: only when the merge contains every user of the channel.
      const all = users.get(r)!;
      for (const u of all) if (!a.members.has(u) && !b.members.has(u)) return undefined;
      sync.push(r);
    }
    return sync;
  }
}

class TooBig extends Error {
  constructor(readonly max: number) {
    super(`the program has more than ${max} processes`);
  }
}

export function isTooBig(e: unknown): e is TooBig {
  return e instanceof TooBig;
}

/** Each leaf's position in a network tree: child indices (0 = left or only child, 1 = right). */
export function assignPositions(processes: CspProcessInfo[], node: CspNetworkNode, position: number[]): void {
  switch (node.kind) {
    case 'leaf':
      if (node.process >= 0) processes[node.process].position = position;
      return;
    case 'parallel':
      assignPositions(processes, node.left, [...position, 0]);
      assignPositions(processes, node.right, [...position, 1]);
      return;
    case 'named':
    case 'hide':
    case 'compressed':
      assignPositions(processes, node.child, [...position, 0]);
      return;
    case 'block':
    case 'exception':
      // FDR shows `P [| A |] STOP` and `P [| A |> SKIP` with the process first.
      assignPositions(processes, node.child, [...position, 0]);
      return;
  }
}

export function instanceFunctionName(proc: ProcIR, callId: number): string {
  return `pj_inst_${proc.name}_${callId + 1}`;
}

function channelName(e: Ex): string {
  if (e.k === 'name') return e.name;
  if (e.k === 'dot') return channelName(e.head);
  return show(e);
}

function resourceName(r: string): string {
  return r.split('#')[0];
}

function pathKey(path: ProcessPath): string {
  return path.map((s) => `${s.kind}@${s.site.span.start.line}:${s.site.span.start.col}${s.index !== undefined ? `[${s.index}]` : ''}`).join('/');
}

function range(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let i = lo; i <= hi; i++) out.push(i);
  return out;
}
