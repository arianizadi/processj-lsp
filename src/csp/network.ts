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
import { E, show, type Ex } from './cspm';
import type { GeneratedProc } from './gen';
import { nodeSuccessors, type ChanUse, type LocalResource, type Node, type ParIR, type ProcIR, type Region } from './lower';
import type { CspNetworkNode, CspProcessInfo, CspUse } from './model';
import { siteKey } from './reach';
import { fixedParams } from './structure';

/** What a static variable (channel, ack, barrier parameter) of a procedure instance is bound to. */
export interface Binding {
  /** CSPm value (`a`, `santa_reindeer.1`, `pj_fork...`). */
  value: Ex;
  /** Profile key of the resource (channels only). */
  resource?: string;
  ref?: ChannelRef;
  /**
   * A whole array of channels: the resource key and identity of the array
   * declaration instance, and its length when elaboration knows it.
   */
  array?: { resource: string; ref: ChannelRef; size?: number };
  /** An element of an array of channels: its index (the CSPm event is `value.k`). */
  element?: number;
  /** A channel with an identity of its own under its event prefix (an element, a recursive procedure instance's channel). */
  part?: boolean;
  /** An element whose index is only known at runtime: any of these. */
  alts?: Binding[];
}

/** A value elaboration knows for a variable of a procedure instance (a parameter no statement changes, a loop variable of a par for). */
type Known = ReadonlyMap<string, number | boolean>;

export interface Instance {
  proc: ProcIR;
  h: number;
  bindings: Map<string, Binding>;
  /** Path of the procedure instance: owner of its locals, prefix of its slots. */
  path: ProcessPath;
  /** Data parameters whose value is known here (the call's arguments were). */
  values?: Known;
}

export interface Leaf {
  kind: 'root' | 'branch' | 'iteration' | 'barrier' | 'channel';
  definition: string;
  args: string[];
  process?: ProcessRef;
  barrier?: ChannelRef;
  /** For servers: the resource key of what they serve. */
  resource?: string;
  /** The known arguments of the call this process runs (`size = 4`; CspProcessInfo.known). */
  known?: string;
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
  /**
   * A checked procedure whose data parameters decide its network (recursion
   * depth, array lengths, par for counts) is elaborated once per argument
   * tuple: each instance is a network of its own (`PJ_NET_1`, ...), with the
   * values elaboration knows for its root (by CSPm name, a channel array's
   * length included), bindings of its own (channel-array parameters) and the
   * data arguments it still takes (its definition's parameters).
   */
  rootInstances?: RootInstance[];
  /** Called at every call elaboration unfolds, with the arguments it knows there (call sites of a checked procedure). */
  observe?: (call: ObservedCall) => void;
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

export interface RootInstance {
  values: ReadonlyMap<string, number | boolean>;
  bindings?: ReadonlyMap<string, Binding>;
  /** Data arguments left to the harness (`pj_call?x`): the CSPm names of the root definition's parameters. */
  args: string[];
  /** The text of the root's arguments, by CSPm name, for parameters fixed in this instance. */
  fixed?: ReadonlyMap<string, string>;
}

export interface ObservedCall {
  caller: ProcIR;
  callee: ProcIR;
  site: A.Invocation;
  /** Arguments elaboration knows, by callee parameter index; a channel array's length under its parameter. */
  values: Map<number, number | boolean>;
  /** The call runs inside an instance of the callee (a recursive call): not a call site from outside. */
  nested: boolean;
}

/** One elaborated root of a network (several for a procedure checked per argument tuple). */
export interface NetworkInstance {
  root: string;
  params: string[];
  tree: CspNetworkNode;
  processes: CspProcessInfo[];
  endsItself: boolean;
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
  /** `code`: where this ProcessJ build does not do what the language says and the model follows the language (explain.ts COMPILED_DIFFERS). */
  warnings: Array<{ message: string; proc: ProcIR; at: A.Span; code: string }>;
  /** Arrays of channels: the largest length any instance gives each declaration (its CSPm index set). */
  arraySizes: Map<LocalResource, number>;
  /**
   * Per par, per field of its fork event after the instance (a par for's
   * computed bounds, then the payload): every value a parent sends there,
   * when elaboration knows them all (undefined: any value of its type). FDR
   * compiles each slot on its own for every value its fork channel allows,
   * so the translator declares the fork channel with just these.
   */
  forkDomains: Map<ParIR, Array<Set<number | boolean> | undefined>>;
  /**
   * Per par, per instance of its procedure (0 when it is not instanced):
   * every tuple of fork fields a parent there sends, a field elaboration
   * does not know undefined (any value of its type). A slot takes only
   * these (gen.ts forkSetName): the product of forkDomains' fields holds
   * combinations no parent sends, for which nothing inside was elaborated.
   */
  forkTuples: Map<ParIR, Map<number, Array<Array<number | boolean | undefined>>>>;
  /**
   * The network is one process that ends by itself (its root ends in SKIP).
   * Otherwise nothing in it terminates and the program ends on the root's
   * `pj_end` (translate.ts wraps it in `[| {pj_end} |> SKIP`).
   */
  endsItself: boolean;
  /** Every elaborated root, the first one also in `root`, `tree`, `processes` and `endsItself`. */
  roots: NetworkInstance[];
}

export function buildNetwork(input: NetworkInput): Network {
  return new Builder(input).build();
}

class Builder {
  private readonly counts = new Map<ProcIR, number>();
  private readonly instanceClauses = new Map<string, string[]>();
  private readonly unsupported: Network['unsupported'] = [];
  private readonly warnings: Network['warnings'] = [];
  private leaves = 0;
  private maxEnroll = 1;
  private barrierMax = 2;
  private readonly defs: string[] = [];
  /** The processes of the root instance being elaborated (each instance has its own). */
  private processes: CspProcessInfo[] = [];
  private readonly defNames = new Set<string>();
  private readonly arraySizes = new Map<LocalResource, number>();
  private readonly forkDomains = new Map<ParIR, Array<Set<number | boolean> | undefined>>();
  private readonly forkTuples = new Map<ParIR, Map<number, Array<Array<number | boolean | undefined>>>>();
  private readonly unknownSizes = new Set<LocalResource>();
  /** Recursive procedure instances being unfolded, innermost last (procedure and known arguments). */
  private readonly unfolding: string[] = [];
  private readonly fixedCache = new Map<ProcIR, Set<string>>();

  constructor(private readonly input: NetworkInput) {}

  build(): Network {
    const specs: RootInstance[] = this.input.rootInstances?.length ? this.input.rootInstances : [{ values: new Map(), args: this.input.rootArgs }];
    const built: NetworkInstance[] = specs.map((spec, k) => this.buildInstance(spec, specs.length > 1 ? `PJ_NET_${k + 1}` : 'PJ_NET'));
    const instanceFunctions: string[] = [];
    for (const [fn, clauses] of this.instanceClauses) instanceFunctions.push(...(clauses.length ? clauses : [`${fn}(_) = 0`]));
    const first = built[0];
    return {
      definitions: this.defs,
      root: first.root,
      rootParams: first.params,
      tree: first.tree,
      processes: first.processes,
      instanceFunctions,
      instances: this.counts,
      maxEnroll: this.maxEnroll,
      barrierMax: this.barrierMax,
      unsupported: this.unsupported,
      warnings: this.warnings,
      arraySizes: this.arraySizes,
      forkDomains: this.forkDomains,
      forkTuples: this.forkTuples,
      endsItself: first.endsItself,
      roots: built,
    };
  }

  /** Elaborate the root once (with what this instance fixes) and compose its network under `rootName`. */
  private buildInstance(spec: RootInstance, rootName: string): NetworkInstance {
    const { root } = this.input;
    this.processes = [];
    this.leafOf.clear();
    const h = this.alloc(root);
    const bindings = new Map(this.input.rootBindings);
    for (const [k, v] of spec.bindings ?? []) bindings.set(k, v);
    const instance: Instance = { proc: root, h, bindings, path: [], ...(spec.values.size ? { values: spec.values } : {}) };
    const gen = this.input.generated.get(root)!;
    const args = [...(this.input.needsInstance(root) ? [String(h)] : []), ...this.rootEntryArgs(gen, bindings, spec), this.input.rootContinuation ?? 'pj_end -> STOP'];
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
    const params = spec.args;
    this.defs.push(`${rootName}${params.length ? `(${params.join(', ')})` : ''} = ${text}`);
    const full: CspNetworkNode = { kind: 'named', name: rootName, child: tree };
    const processes = this.processes;
    assignPositions(processes, full, []);
    return { root: rootName, params, tree: full, processes, endsItself };
  }

  private rootEntryArgs(gen: GeneratedProc, bindings: ReadonlyMap<string, Binding>, spec: RootInstance): string[] {
    const root = this.input.root;
    let data = 0;
    const free = this.input.rootArgs;
    return gen.entryParams.map((p) => {
      const b = bindings.get(p);
      if (b) return show(b.value);
      const fixed = spec.fixed?.get(p);
      if (fixed !== undefined) {
        if (root.params.some((x) => x.cspm === p && x.role === 'value')) data++;
        return fixed;
      }
      const param = root.params.find((x) => x.cspm === p);
      if (param && param.role === 'value') return free[data++] ?? p;
      return p;
    });
  }

  private alloc(proc: ProcIR): number {
    const n = (this.counts.get(proc) ?? 0) + 1;
    this.counts.set(proc, n);
    return n;
  }

  private leaf(kind: Leaf['kind'], definition: string, args: string[], process?: ProcessRef): Leaf {
    if (++this.leaves > this.input.maxProcesses) throw new TooBig(this.input.maxProcesses, this.unfolding.length ? this.unfolding[0].split('|')[0] : undefined);
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
  private runRegion(leaf: Leaf, inst: Instance, region: Region, prefix: ProcessPath, iterations: number[], stack: ProcIR[] = [], outerValues: ReadonlyMap<string, number> = new Map()): void {
    const proc = inst.proc;
    const gen = this.input.generated.get(proc)!;
    const iterValues = new Map(outerValues);
    // Arrays of channels declared here: elaboration needs their length (which elements exist).
    for (const local of proc.locals) {
      if (local.region !== region || !local.array) continue;
      leaf.declared.add(local.cspm);
      const size = evaluate(local.array.size, this.known(inst, iterValues), this.input.intRange);
      if (typeof size === 'number' && size >= 0) {
        iterValues.set(local.array.len, size);
        this.arraySizes.set(local, Math.max(size, this.arraySizes.get(local) ?? 0));
      } else if (!this.unknownSizes.has(local)) {
        this.unknownSizes.add(local);
        this.unsupported.push({ message: `the length of the channel array '${local.name}' is not known before the program runs (it must follow from constants and from arguments known where the procedure is called): its channels cannot be laid out, so it is not modelled`, proc, at: local.ident.span });
      }
    }
    // Barriers and mediated channels declared by this code: their server lives at this process.
    for (const local of proc.locals) {
      if (local.region !== region || local.array) continue;
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
    // Code a condition elaboration can decide never runs here (the other side of `if (i == 0)` in iteration 0).
    const live = this.liveNodes(proc, region, this.known(inst, iterValues));
    for (const n of proc.nodes) {
      if (n.region !== region || (live && !live.has(n.id))) continue;
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
      leaf.uses.push({ channel: b.part && value === b.value ? bindingKey(b) : channelName(value), op, at, procedure: inst.proc.decl.name.name, ref: b.ref, ...(b.resource ? { resource: b.resource } : {}), site, ...(ack ? { ack } : {}) });
    };
    const chan = (c: ChanUse, dir: 'read' | 'write', at = here): void => {
      const bound = this.bind(inst, c.ch, iters);
      // An element whose index is only known at runtime may be any of them.
      for (const b of bound?.alts ?? (bound ? [bound] : [])) one(c, b, dir, at);
    };
    const one = (c: ChanUse, b: Binding, dir: 'read' | 'write', at: SourceRef | undefined): void => {
      if (b.ref) leaf.channels.set(bindingKey(b), b.ref);
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
    this.noteFork(inst, par, gen, iterValues);
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
        const args = [...(hSuffix ? [String(inst.h)] : []), ...slot.statics.map((v) => this.staticArg(inst, v, iterValues, par))];
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
      const values = iter.values ?? this.knownIterations(iter, this.known(inst, iterValues)) ?? range(this.input.intRange.lo, this.input.intRange.hi);
      this.maxEnroll = Math.max(this.maxEnroll, values.length);
      const stmt = par.stmt as A.ForStmt;
      for (const v of values) {
        const site: SpawnSite = { kind: 'par-for', site: { uri: proc.unit.uri, span: stmt.span }, index: v };
        const path = [...prefix, site];
        const body = r.stmt?.kind === 'Block' && r.stmt.stmts.length === 1 ? r.stmt.stmts[0] : r.stmt;
        const call = body?.kind === 'ExprStmt' && body.expr.kind === 'Invocation' ? body.expr : undefined;
        const callText = call ? (this.input.sourceText(proc, call.span) ?? call.name.name).replace(/\s+/g, ' ') : undefined;
        const values = new Map(iterValues).set(iter.v, v);
        const args = [...(hSuffix ? [String(inst.h)] : []), show({ k: 'int', v }), ...slot.statics.map((s) => this.staticArg(inst, s, values, par))];
        const child = this.leaf('iteration', slot.definition, args, {
          path,
          label: `${callText ?? 'iteration'} [${iter.variable} = ${v}]`,
          procedure: call?.name.name,
        });
        this.runRegion(child, inst, r, path, [...iterations, v], stack, values);
        node.slots.push(child);
      }
      // No iteration runs in this instance (elaboration knows the bounds): the parent forks and joins alone,
      // as the language says. This build's par for waits for good when it starts no process.
      if (!node.slots.length) {
        if (!this.warnings.some((w) => w.code === 'compiler/empty-par-for' && w.at === stmt.span)) {
          this.warnings.push({
            message: `no iteration of this par for runs${this.input.needsInstance(proc) || inst.values?.size ? ` in ${proc.decl.name.name}${inst.values?.size ? ` (${[...inst.values].map(([k, v]) => `${proc.vars.get(k)?.name ?? k} = ${v}`).join(', ')})` : ''}` : ''} — the model lets it end at once, as the language says; this ProcessJ build never ends a par for that starts no process: it waits for one to finish, and the program hangs here (test/differential/par_for_empty.pj)`,
            proc,
            at: stmt.span,
            code: 'compiler/empty-par-for',
          });
        }
        return;
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
    const instanced = this.input.needsInstance(callee);
    const recursive = stack.includes(callee) || callee === inst.proc;
    if (summary) {
      const mark = (indices: ReadonlySet<number>, dir: 'read' | 'write'): void => {
        for (const i of indices) {
          const a = n.call.args[i];
          if (!a?.chan || a.chan.take) continue;
          const bound = this.bind(inst, a.chan.ch, iters);
          // A whole array: the walk of the callee below finds the elements it uses, unless it is not walked.
          const all = bound?.array ? (recursive && !instanced ? this.elements(bound) : []) : bound?.alts ?? (bound ? [bound] : []);
          for (const b of all) {
          if (!b.resource) continue;
          (dir === 'read' ? leaf.reads : leaf.writes).add(b.resource);
          leaf.own.add(b.resource);
          const events = [show(b.value)];
          if (a.chan.ack) {
            const ack = this.bind(inst, a.chan.ack, iters);
            if (ack) events.push(show(ack.value));
          }
          leaf.events.set(b.resource, events);
          if (b.ref) leaf.channels.set(bindingKey(b), b.ref);
          }
        }
      };
      mark(summary.transitive.channelReads, 'read');
      mark(summary.transitive.channelWrites, 'write');
    }
    const values = this.calleeValues(inst, n, callee, iters);
    if (this.input.observe) {
      const byIndex = new Map<number, number | boolean>();
      callee.params.forEach((p, i) => {
        const v = values.get(p.len ?? p.cspm);
        if (v !== undefined && (p.role === 'value' || p.len)) byIndex.set(i, v);
      });
      this.input.observe({ caller: inst.proc, callee, site: n.call.site, values: byIndex, nested: recursive });
    }
    let unfold: string | undefined;
    if (recursive) {
      // A callee that runs no par runs in this process: its operations are recorded already.
      if (!instanced) return;
      // Recursion through par is unfolded when elaboration knows every argument: it ends where a
      // condition on them stops calling (altFIFO(1) runs no par), within the process budget.
      const name = callee.decl.name.name;
      const unknown = callee.params.filter((p) => p.role === 'value' && (p.type.k === 'int' || p.type.k === 'bool') && !values.has(p.cspm)).map((p) => p.name);
      unfold = `${callee.name}|${[...values].map(([k, v]) => `${k}=${v}`).sort().join(',')}`;
      const why = unknown.length
        ? `with ${unknown.length === 1 ? 'an argument' : 'arguments'} (${unknown.join(', ')}) that elaboration cannot compute (not known before the program runs, or outside the modelled integers ${this.input.intRange.lo}..${this.input.intRange.hi})`
        : this.unfolding.includes(unfold)
          ? `with the same arguments again (${[...values].map(([k, v]) => `${callee.vars.get(k)?.name ?? k} = ${v}`).join(', ') || 'none'}), so the arguments do not tell how many levels run (whether it stops depends on what happens at run time, or it never does)`
          : this.unfolding.length >= MAX_UNFOLDING
            ? `more than ${MAX_UNFOLDING} levels deep`
            : undefined;
      if (why) {
        this.unsupported.push({ message: `'${name}' calls itself on the way to a par ${why}: recursion through par is modelled only when it stops after a number of steps known from the arguments`, proc: inst.proc, at: n.call.site.span });
        return;
      }
    }
    const bindings = this.calleeBindings(inst, n, callee, iters);
    if (!instanced) {
      // The callee runs inside this process. Walk its code for the operations it performs, its own
      // local channels included: with no par below, nothing can ever be their partner, so they block.
      this.runRegion(leaf, { proc: callee, h: 0, bindings, path: prefix, values }, callee.thread, prefix, iterations, [...stack, inst.proc]);
      return;
    }
    const h = this.alloc(callee);
    const fn = instanceFunctionName(inst.proc, n.call.id);
    const clauses = this.instanceClauses.get(fn) ?? [];
    const key = [inst.h, ...iterations].map((x) => (x < 0 ? `(${x})` : String(x))).join(', ');
    clauses.push(`${fn}(${key}) = ${h}`);
    this.instanceClauses.set(fn, clauses);
    const path = this.input.leadsToPar(callee) ? [...prefix, { kind: 'call' as const, site: { uri: inst.proc.unit.uri, span: n.call.site.span } }] : prefix;
    const calleeInst: Instance = { proc: callee, h, bindings, path, values };
    // The process that is this call: its known arguments name it apart from other instances (explain.ts processNames).
    const shown = callee.params.filter((p) => p.role === 'value' && values.has(p.cspm)).map((p) => `${p.name} = ${String(values.get(p.cspm))}`);
    if (shown.length && !leaf.known && leaf.process?.procedure === callee.decl.name.name && leaf.process.path.length === prefix.length) leaf.known = shown.join(', ');
    if (unfold) this.unfolding.push(unfold);
    try {
      this.runRegion(leaf, calleeInst, callee.thread, path, [], [...stack, inst.proc]);
    } finally {
      if (unfold) this.unfolding.pop();
    }
  }

  /**
   * The data parameters of a callee elaboration knows at this call: an
   * argument computed from what is known here, for a parameter the callee
   * never changes (`FIFO(6, ...)`: size is 6 in that instance).
   */
  private calleeValues(inst: Instance, n: Extract<Node, { k: 'call' }>, callee: ProcIR, iters: ReadonlyMap<string, number>): Map<string, number | boolean> {
    const out = new Map<string, number | boolean>();
    const env = this.known(inst, iters);
    const fixed = this.fixed(callee);
    callee.params.forEach((p, i) => {
      const a = n.call.args[i];
      if (!a) return;
      if (p.role === 'value' && a.value && fixed.has(p.cspm)) {
        const v = evaluate(a.value, env, this.input.intRange);
        if (v !== undefined) out.set(p.cspm, v);
      }
      if (p.len && a.chan?.len) {
        const v = evaluate(a.chan.len, env, this.input.intRange);
        if (v !== undefined) out.set(p.len, v);
      }
    });
    return out;
  }

  /** Parameters no statement of the procedure assigns: their value is the call's argument throughout. */
  private fixed(proc: ProcIR): Set<string> {
    const known = this.fixedCache.get(proc);
    if (known) return known;
    const out = fixedParams(proc);
    this.fixedCache.set(proc, out);
    return out;
  }

  /** What elaboration knows in an instance: its fixed parameters, the par for iterations and channel-array lengths around the code. */
  private known(inst: Instance, iters: ReadonlyMap<string, number>): Known {
    if (!inst.values?.size) return iters;
    return new Map<string, number | boolean>([...inst.values, ...iters]);
  }

  /**
   * The nodes of a region that can run when the known values decide some of
   * its conditions; undefined when they decide none (every node can run).
   */
  private liveNodes(proc: ProcIR, region: Region, env: Known): Set<number> | undefined {
    if (!env.size) return undefined;
    let pruned = false;
    const seen = new Set<number>();
    const work = [region.entry];
    while (work.length) {
      const id = work.pop()!;
      if (id < 0 || seen.has(id)) continue;
      const n = proc.nodes[id];
      if (!n) continue;
      seen.add(id);
      if (n.k === 'branch') {
        const c = evaluate(n.c, env, this.input.intRange);
        if (typeof c === 'boolean') {
          pruned = true;
          work.push(c ? n.t : n.f);
          continue;
        }
      }
      if (n.k === 'check' && evaluate(n.ok, env, this.input.intRange) === false) {
        // A runtime error happens here for certain: nothing after it runs.
        pruned = true;
        continue;
      }
      work.push(...nodeSuccessors(n));
    }
    return pruned ? seen : undefined;
  }

  /**
   * The iterations of a par for with computed bounds, when elaboration knows
   * them (`i < size` with size known in this instance): one slot per
   * iteration that runs, not one per modelled integer. They stay within the
   * modelled integers, where the generated range check lets a run go on.
   */
  private knownIterations(iter: NonNullable<ParIR['iter']>, env: Known): number[] | undefined {
    if (!iter.lo || !iter.hi) return undefined;
    const lo = evaluate(iter.lo, env, this.input.intRange);
    const hi = evaluate(iter.hi, env, this.input.intRange);
    if (typeof lo !== 'number' || typeof hi !== 'number') return undefined;
    const { lo: L, hi: H } = this.input.intRange;
    return range(Math.max(lo, L), Math.min(hi, H));
  }

  /** Record what this instance's fork of `par` carries (Network.forkDomains). */
  private noteFork(inst: Instance, par: ParIR, gen: GeneratedProc, iterValues: ReadonlyMap<string, number>): void {
    const fork = gen.channels.find((c) => c.role === 'fork' && c.par === par);
    if (!fork) return;
    const env = this.known(inst, iterValues);
    const { lo: L, hi: H } = this.input.intRange;
    const inRange = (v: number | boolean | undefined): number | boolean | undefined => (typeof v === 'number' && (v < L || v > H) ? undefined : v);
    const values: Array<number | boolean | undefined> = [];
    if (fork.bounds && par.iter?.lo && par.iter.hi) {
      const lo = evaluate(par.iter.lo, env, this.input.intRange);
      const hi = evaluate(par.iter.hi, env, this.input.intRange);
      // As gen.ts clamps them to the slots.
      values.push(typeof lo === 'number' ? Math.min(Math.max(lo, L), H + 1) : undefined, typeof hi === 'number' ? Math.min(Math.max(hi, L - 1), H) : undefined);
    }
    for (const v of fork.vars ?? []) values.push(inRange(env.get(v)));
    const known = this.forkDomains.get(par);
    const fields = values.map((v, i) => {
      if (known && !known[i]) return undefined;
      if (v === undefined) return undefined;
      const set = known?.[i] ?? new Set<number | boolean>();
      set.add(v);
      return set;
    });
    this.forkDomains.set(par, fields);
    const h = fork.instanced ? inst.h : 0;
    const perInstance = this.forkTuples.get(par) ?? new Map<number, Array<Array<number | boolean | undefined>>>();
    const tuples = perInstance.get(h) ?? [];
    if (!tuples.some((t) => t.every((v, i) => v === values[i]))) tuples.push(values);
    perInstance.set(h, tuples);
    this.forkTuples.set(par, perInstance);
  }

  /** Every element of an array binding, when its length is known. */
  private elements(b: Binding): Binding[] {
    const size = b.array?.size;
    if (!b.array || size === undefined) return [];
    return Array.from({ length: size }, (_, k) => this.element(b, k));
  }

  private element(arr: Binding, k: number): Binding {
    const a = arr.array!;
    return { value: E.dot(arr.value, E.int(k)), resource: `${a.resource}[${k}]`, ref: { ...a.ref, name: `${a.ref.name}[${k}]`, index: k }, element: k, part: true };
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
      if (local.array) {
        const size = iters.get(local.array.len);
        return { value: e, array: { resource: this.resourceKey(local, inst, iters), ref: this.localRef(local, inst), ...(size !== undefined ? { size } : {}) } };
      }
      const ref = this.localRef(local, inst);
      const isAck = local.ack === e.name;
      return { value: e, resource: this.resourceKey(local, inst, iters), ref: isAck ? { ...ref } : ref };
    }
    const last = e.k === 'dot' ? e.fields[e.fields.length - 1] : undefined;
    if (e.k === 'dot' && last && !(last.k === 'var' && last.name === 'pj_h')) {
      // An element of an array of channels: known index, or any element.
      const arr = this.bind(inst, E.dot(e.head, ...e.fields.slice(0, -1)), iters);
      if (arr?.array) {
        if (arr.array.size === undefined) return undefined;
        const k = evaluate(last, this.known(inst, iters), this.input.intRange);
        if (typeof k === 'number') return k >= 0 && k < arr.array.size ? this.element(arr, k) : undefined;
        const alts = this.elements(arr);
        return alts.length ? { value: e, alts } : undefined;
      }
    }
    if (e.k === 'dot' && e.head.k === 'name' && e.fields.length === 1 && e.fields[0].k === 'var' && e.fields[0].name === 'pj_h') {
      const name = e.head.name;
      const local = inst.proc.locals.find((l) => l.cspm === name || l.ack === name || l.mediated?.take === name || l.mediated?.done === name);
      const value: Ex = { k: 'dot', head: e.head, fields: [{ k: 'int', v: inst.h }] };
      if (local?.array) {
        const size = iters.get(local.array.len);
        return { value, array: { resource: this.resourceKey(local, inst, iters), ref: this.localRef(local, inst), ...(size !== undefined ? { size } : {}) } };
      }
      return { value, ref: local ? this.localRef(local, inst) : undefined, ...(local ? { resource: this.resourceKey(local, inst, iters) } : {}), ...(local?.instanced ? { part: true } : {}) };
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

  private staticArg(inst: Instance, v: string, iterValues: ReadonlyMap<string, number>, par: ParIR): string {
    const it = iterValues.get(v);
    if (it !== undefined) return show({ k: 'int', v: it });
    const b = this.bind(inst, { k: 'var', name: v });
    if (b?.alts) {
      this.unsupported.push({ message: `a par branch here uses '${inst.proc.vars.get(v)?.name ?? v}', an element of a channel array whose index is only known at runtime; a process is given its channels before it starts, so this is not modelled`, proc: inst.proc, at: par.stmt.span });
    }
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
      ...(leaf.known ? { known: leaf.known } : {}),
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

/** Deepest recursion through par the network unfolds (each level is at least one more process). */
const MAX_UNFOLDING = 200;

class TooBig extends Error {
  constructor(readonly max: number, readonly recursion?: string) {
    super(`the program has more than ${max} processes${recursion ? ` (unfolding the recursion of '${recursion}' through par)` : ''}`);
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

/** The key a leaf's channel map and uses give a channel: `chans.2` for an element of an array, else the CSPm channel. */
function bindingKey(b: Binding): string {
  return b.part ? show(b.value) : channelName(b.value);
}

/**
 * The value of an expression from what elaboration knows, or undefined.
 * Integers follow Java (division truncates); a saturated integer is known
 * only while it is inside the modelled range.
 */
export function evaluate(e: Ex, env: Known, range: { lo: number; hi: number }): number | boolean | undefined {
  const num = (x: Ex): number | undefined => {
    const v = evaluate(x, env, range);
    return typeof v === 'number' ? v : undefined;
  };
  switch (e.k) {
    case 'int':
    case 'bool':
      return e.v;
    case 'var':
      return env.get(e.name);
    case 'not': {
      const v = evaluate(e.e, env, range);
      return typeof v === 'boolean' ? !v : undefined;
    }
    case 'neg': {
      const v = num(e.e);
      return v === undefined ? undefined : -v;
    }
    case 'if': {
      const c = evaluate(e.c, env, range);
      return typeof c === 'boolean' ? evaluate(c ? e.t : e.e, env, range) : undefined;
    }
    case 'sat': {
      const v = num(e.e);
      return v !== undefined && v >= e.lo && v <= e.hi ? v : undefined;
    }
    case 'call': {
      if ((e.fn === 'pj_div' || e.fn === 'pj_mod') && e.args.length === 2) {
        const a = num(e.args[0]);
        const b = num(e.args[1]);
        if (a === undefined || b === undefined || b === 0) return undefined;
        return e.fn === 'pj_div' ? Math.trunc(a / b) : a % b;
      }
      return undefined;
    }
    case 'bin': {
      if (e.op === 'and' || e.op === 'or') {
        const l = evaluate(e.l, env, range);
        if (typeof l === 'boolean' && (e.op === 'and' ? !l : l)) return l;
        const r = evaluate(e.r, env, range);
        if (typeof l === 'boolean' && typeof r === 'boolean') return r;
        return typeof r === 'boolean' && (e.op === 'and' ? !r : r) ? r : undefined;
      }
      const l = evaluate(e.l, env, range);
      const r = evaluate(e.r, env, range);
      if (l === undefined || r === undefined) return undefined;
      if (typeof l === 'boolean' || typeof r === 'boolean') {
        if (typeof l !== typeof r) return undefined;
        return e.op === '==' ? l === r : e.op === '!=' ? l !== r : undefined;
      }
      switch (e.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '==': return l === r;
        case '!=': return l !== r;
        case '<': return l < r;
        case '<=': return l <= r;
        case '>': return l > r;
        case '>=': return l >= r;
      }
      return undefined;
    }
    default:
      return undefined;
  }
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
