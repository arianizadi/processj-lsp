/**
 * Control-flow graphs to CSPm process definitions.
 *
 * Every program point where a process can stop (a communication, a barrier
 * sync, an alt, the start and the joins of a par, a call's return point, a
 * loop head, a point two paths meet) is a named definition whose parameters
 * are exactly the variables live there, so FDR's state names say where each
 * process is and dead variables never multiply states. Straight-line code
 * between two such points is folded into the arguments of the next one, with
 * every store range-checked and every Java runtime error turned into a
 * `pj_error` event.
 *
 * Procedures are continuation-passing: `delta__body(pj_h, in, out1, out2, pj_k)`
 * runs the body and then behaves as `pj_k`. A call passes the caller's next
 * definition as the continuation, so a process stopped inside a callee shows
 * the whole call chain in its state name.
 *
 * As each body is generated, every way it goes on to another definition (or
 * to STOP, or back to the caller) is recorded with the events on the way and
 * whether a condition the model leaves to FDR decides it: the procedure's
 * communication state machine, exactly as the CSPm says it (machine.ts).
 */
import type * as A from '../parser/ast';
import { atom, chooses, commentText, E, freeVars, rangeText, show, substitute, type Ex } from './cspm';
import type { CspDefinitionInfo, CspOperation, CspParam, CspTransition, CspTransitionStep } from './model';
import { isEventNode, nodeSuccessors, nodeUses, type Node, type ParIR, type ProcIR, type Region, type VarIR } from './lower';
import type { DataModel, DType } from './data';
import { siteKey, type Reach } from './reach';

export interface GenOptions {
  data: DataModel;
  /** Whether a procedure runs a par (directly or through calls) and so takes an instance handle. */
  needsInstance(proc: ProcIR): boolean;
  /** The IR of a callee. */
  procOf(decl: A.ProcDecl): ProcIR | undefined;
  /** Name of the function giving a callee's instance for a call site (`pj_inst_main_43`). */
  instanceFunction(proc: ProcIR, callId: number): string;
  /** CSPm source location text for comments (`commstime.pj:24`). */
  where(proc: ProcIR, span: A.Span): string;
  sourceText(proc: ProcIR, span: A.Span): string | undefined;
  /** Entry parameters of a callee in definition order, without the instance handle and the continuation. */
  entryParams(proc: ProcIR): string[];
  /**
   * Indices of the parameters a callee's entry takes, when known (a dead
   * parameter is not passed, so its argument is not live in the caller).
   */
  calleeUses?(proc: ProcIR): ReadonlySet<number> | undefined;
  /** What a process may still do from each node (reach.ts), for the definitions' `reach`. */
  reach?(proc: ProcIR): Reach | undefined;
}

/** The CSPm set of what a fork carries after the instance, per instance when it is instanced (translate.ts). */
export function forkSetName(fork: string): string {
  return fork.replace(/^pj_fork_/, 'pj_forkset_');
}

/** A bookkeeping channel a procedure needs declared: fork or join of a par branch, with its payload. */
export interface ForkChannel {
  name: string;
  role: 'fork' | 'join';
  proc: ProcIR;
  par: ParIR;
  /** 1-based branch of a join; absent for a fork (one event starts every branch or iteration) and a par for's join. */
  branch?: number;
  /**
   * CSPm sets of the leading payload fields, before `payload`: a par for's
   * computed first and last iteration (`{0..4}`, `{ -1..3}` for Int_t = 0..3).
   */
  bounds?: string[];
  /** Payload types after the instance handle (and the bounds). */
  payload: DType[];
  /** ProcessJ names of the payload fields (`l`; `first iteration`, `last iteration` for a par for's computed bounds). */
  fields: string[];
  /** For a fork: the CSPm variables the payload carries, in order (after the bounds). */
  vars?: string[];
  instanced: boolean;
}

export interface GeneratedProc {
  proc: ProcIR;
  /** Definitions in source order, each with its leading comment. */
  text: string[];
  definitions: CspDefinitionInfo[];
  channels: ForkChannel[];
  /** Entry parameters, in call order (data parameters that are dead at entry are left out). */
  entryParams: string[];
  entry: string;
  /** Per par: the slot definitions and what they need from the network. */
  slots: Map<ParIR, SlotInfo[]>;
  /** Static variables live in each region: what a slot needs from its instance. */
  regionStatics: Map<Region, string[]>;
  /** Every path from one of these definitions to the next state (CspSourceMap.transitions). */
  transitions: CspTransition[];
}

/** The path being generated from the start of one definition's body. */
interface Walk {
  from: string;
  via: CspTransitionStep[];
  /** Conditions passed on the way that the model leaves to FDR. */
  conditions: number;
  guard?: number;
  call?: string;
}

export interface SlotInfo {
  region: Region;
  definition: string;
  /** Parameters after the instance handle and the iteration value: static channels, acks and barriers. */
  statics: string[];
  fork: string;
  join: string;
}

interface Liveness {
  liveIn: Array<Set<string>>;
  liveOut: Array<Set<string>>;
  /** Outputs per branch region: variables it assigns that are live after its par. */
  outs: Map<Region, string[]>;
  /** Static variables (channels, barriers, instance handle, iteration) each branch region needs. */
  statics: Map<Region, string[]>;
  /** Data variables each branch region receives from its parent when it starts. */
  ins: Map<Region, string[]>;
}

const STATIC_ROLES = new Set<VarIR['role']>(['channel', 'ack', 'barrier', 'instance', 'iteration']);

/**
 * Analyse a procedure (ticks, liveness) without generating it yet, so every
 * procedure's entry parameters are known before any caller is generated.
 */
export function prepareProc(ir: ProcIR, opts: GenOptions): PreparedProc {
  return new Generator(ir, opts);
}

export interface PreparedProc {
  /** Entry parameters in definition order, without the instance handle and the continuation. */
  readonly entryParams: string[];
  run(): GeneratedProc;
}

class Generator implements PreparedProc {
  private readonly live: Liveness;
  private readonly preds: number[][];
  private readonly defNames = new Map<number, string>();
  private readonly usedNames = new Set<string>();
  private readonly out: string[] = [];
  private readonly infos: CspDefinitionInfo[] = [];
  private readonly channels: ForkChannel[] = [];
  private readonly slots = new Map<ParIR, SlotInfo[]>();
  private readonly instanced: boolean;
  private bindCounter = 0;
  private readonly transitions: CspTransition[] = [];
  private walk: Walk | undefined;

  constructor(
    private readonly ir: ProcIR,
    private readonly opts: GenOptions,
  ) {
    this.instanced = opts.needsInstance(ir);
    if (this.instanced) ir.vars.set('pj_h', { cspm: 'pj_h', name: 'instance', type: { k: 'int' }, role: 'instance' });
    ir.vars.set('pj_k', { cspm: 'pj_k', name: 'continuation', type: { k: 'void' }, role: 'continuation' });
    this.markTicks();
    this.preds = this.predecessors();
    this.live = this.liveness();
  }

  get entryParams(): string[] {
    return this.params(this.ir.thread.entry).filter((p) => p !== 'pj_k' && p !== 'pj_h');
  }

  run(): GeneratedProc {
    const ir = this.ir;
    this.nameDefinitions();
    const entryName = `${ir.name}__body`;
    // Entry: the thread region's first node. Callers always pass the instance (when there is one) and a
    // continuation, even to a procedure that never returns.
    const entryParams = [...(this.instanced ? ['pj_h'] : []), ...this.entryParams, 'pj_k'];
    const entryBody = this.recording(entryName, () => this.gen(ir.thread.entry, identity(entryParams), true));
    this.emitDef(entryName, entryParams, entryBody, {
      kind: 'entry',
      at: this.ref(ir.decl.name.span),
      text: `${ir.decl.name.name}(${ir.decl.params.map((p) => p.name.name).join(', ')})`,
    }, ir.thread.entry);
    for (const node of ir.nodes) {
      const name = this.defNames.get(node.id);
      if (!name || node.id === ir.thread.entry) continue;
      if (node.k === 'end' && node.region.kind !== 'thread') {
        this.emitBranchEnd(node);
        continue;
      }
      const params = this.params(node.id);
      const body = this.recording(name, () => this.gen(node.id, identity(params), true));
      this.emitDef(name, params, body, this.describe(node), node.id);
      if (node.k === 'par') this.emitPar(node, name);
    }
    const regionStatics = new Map<Region, string[]>();
    for (const r of ir.regions) regionStatics.set(r, this.live.statics.get(r) ?? []);
    return {
      proc: ir,
      text: this.out,
      definitions: this.infos,
      channels: this.channels,
      entryParams: entryParams.filter((p) => p !== 'pj_k' && p !== 'pj_h'),
      entry: entryName,
      slots: this.slots,
      regionStatics,
      transitions: this.transitions,
    };
  }

  // -------------------------------------------------------------------------
  // Transitions: the paths of each body, recorded as it is generated
  // -------------------------------------------------------------------------

  /** Generate the body of definition `name` with `body`, recording its paths. */
  private recording<T>(name: string, body: () => T): T {
    const outer = this.walk;
    this.walk = { from: name, via: [], conditions: 0 };
    try {
      return body();
    } finally {
      this.walk = outer;
    }
  }

  /** Generate `body` with `ops` on the path (under a condition when `conditional`). */
  private along<T>(step: { ops?: CspTransitionStep[]; conditional?: boolean; guard?: number; call?: string }, body: () => T): T {
    const walk = this.walk;
    if (!walk) return body();
    const saved = { via: walk.via.length, conditions: walk.conditions, guard: walk.guard, call: walk.call };
    if (step.ops) walk.via.push(...step.ops);
    if (step.conditional) walk.conditions++;
    if (step.guard !== undefined) walk.guard = step.guard;
    if (step.call !== undefined) walk.call = step.call;
    try {
      return body();
    } finally {
      walk.via.length = saved.via;
      walk.conditions = saved.conditions;
      walk.guard = saved.guard;
      walk.call = saved.call;
    }
  }

  /** Generate text that no run reaches (the side of a condition that is constantly false): nothing is recorded. */
  private unreached<T>(body: () => T): T {
    const outer = this.walk;
    this.walk = undefined;
    try {
      return body();
    } finally {
      this.walk = outer;
    }
  }

  /** The path being generated reaches `to`: a definition, `STOP` or `pj_k`. */
  private reach(to: string): void {
    const walk = this.walk;
    if (!walk) return;
    this.transitions.push({
      from: walk.from,
      to,
      via: walk.via.map((step) => ({ ...step })),
      conditional: walk.conditions > 0,
      ...(walk.guard !== undefined ? { guard: walk.guard } : {}),
      ...(walk.call !== undefined ? { call: walk.call } : {}),
    });
  }

  /** The path that stops with runtime error `ctor` (under the condition that fails, when `conditional`). */
  private failure(ctor: string, conditional: boolean): void {
    const site = this.ir.errors.find((e) => e.ctor === ctor);
    this.along({ ops: [{ kind: 'error', name: site?.message ?? ctor, ...(site ? { at: this.ref(site.at) } : {}) }], conditional }, () => this.reach('STOP'));
  }

  /** The par branch or par for body whose process runs a definition of `region` (CspDefinitionInfo.region). */
  private regionOf(region: Region): Pick<CspDefinitionInfo, 'region'> {
    if (region.kind === 'thread' || !region.par) return {};
    const par = region.par;
    return region.kind === 'iteration'
      ? { region: { kind: 'par-for', site: this.ref(par.stmt.span) } }
      : { region: { kind: 'branch', site: this.ref(region.stmt?.span ?? par.stmt.span), index: region.index } };
  }

  // -------------------------------------------------------------------------
  // Analysis
  // -------------------------------------------------------------------------

  /**
   * A loop whose iteration can pass no event would make FDR unfold an
   * event-free recursion forever. Such back edges get a hidden `pj_tick`.
   */
  private markTicks(): void {
    const nodes = this.ir.nodes;
    const preds: number[][] = nodes.map(() => []);
    for (const n of nodes) for (const t of nodeSuccessors(n)) if (t >= 0) preds[t].push(n.id);
    for (const head of nodes) {
      if (head.k !== 'nop' || !head.loopHead) continue;
      // Nodes of this loop: reachable from the head without passing it again.
      const inLoop = new Set<number>();
      const stack = [...nodeSuccessors(head)];
      while (stack.length) {
        const id = stack.pop()!;
        if (id < 0 || id === head.id || inLoop.has(id) || nodes[id].region !== head.region) continue;
        inLoop.add(id);
        stack.push(...nodeSuccessors(nodes[id]));
      }
      // Must-analysis: has an event certainly happened since the head? (greatest fixpoint)
      const happened = new Map<number, boolean>();
      for (const id of inLoop) happened.set(id, true);
      const out = (id: number): boolean => id !== head.id && (happened.get(id)! || isEventNode(nodes[id]));
      let changed = true;
      while (changed) {
        changed = false;
        for (const id of inLoop) {
          const value = preds[id].filter((p) => p === head.id || inLoop.has(p)).every(out);
          if (value !== happened.get(id)) {
            happened.set(id, value);
            changed = true;
          }
        }
      }
      for (const id of inLoop) {
        const n = nodes[id];
        // The marker becomes a tick in place (same successor): `Node` allows both kinds.
        if (n.k === 'nop' && n.backEdgeTo === head.id && !happened.get(id)) Object.assign(n, { k: 'tick' });
      }
    }
  }

  private predecessors(): number[][] {
    const preds: number[][] = this.ir.nodes.map(() => []);
    for (const n of this.ir.nodes) for (const s of nodeSuccessors(n)) if (s >= 0) preds[s].push(n.id);
    return preds;
  }

  private isStatic(v: string): boolean {
    const info = this.ir.vars.get(v);
    return !!info && STATIC_ROLES.has(info.role);
  }

  /** Variables assigned by a region or anything nested in it. */
  private assigned(region: Region): Set<string> {
    const out = new Set<string>();
    const regions = new Set<Region>([region]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const r of this.ir.regions) {
        if (regions.has(r)) continue;
        if (r.par && regions.has(r.par.owner)) {
          regions.add(r);
          grew = true;
        }
      }
    }
    for (const n of this.ir.nodes) {
      if (!regions.has(n.region)) continue;
      if (n.k === 'assign' || n.k === 'read') out.add(n.v);
      if (n.k === 'call' && n.ret) out.add(n.ret);
      if (n.k === 'alt') for (const c of n.cases) if (c.guard.k === 'read') out.add(c.guard.v);
    }
    return out;
  }

  private liveness(): Liveness {
    const nodes = this.ir.nodes;
    const liveIn = nodes.map(() => new Set<string>());
    const liveOut = nodes.map(() => new Set<string>());
    const outs = new Map<Region, string[]>();
    const statics = new Map<Region, string[]>();
    const ins = new Map<Region, string[]>();
    const assignedBy = new Map<Region, Set<string>>();
    for (const r of this.ir.regions) if (r.kind !== 'thread') assignedBy.set(r, this.assigned(r));
    // Statics a branch needs: those its own nodes use, plus barriers its par enrolls (resigned at its end).
    for (const r of this.ir.regions) {
      if (r.kind === 'thread') continue;
      const s = new Set<string>();
      for (const n of nodes) {
        if (n.region !== r) continue;
        for (const v of nodeUses(n)) if (this.isStatic(v)) s.add(v);
        // A call to a procedure that runs a par picks the callee's instance from the enclosing iterations.
        if (n.k === 'call') {
          const callee = this.opts.procOf(n.call.callee);
          if (callee && this.opts.needsInstance(callee)) for (const v of this.iterationsAround(r)) s.add(v);
        }
      }
      for (const b of r.par!.enroll) for (const v of freeVars(b.b)) s.add(v);
      if (this.instanced) s.add('pj_h');
      if (r.kind === 'iteration' && r.par!.iter) s.add(r.par!.iter.v);
      statics.set(r, [...s]);
    }
    const parNodeOf = new Map<ParIR, Node>();
    for (const n of nodes) if (n.k === 'par') parNodeOf.set(n.par, n);
    let changed = true;
    let rounds = 0;
    while (changed && rounds++ < 1000) {
      changed = false;
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        const lo = new Set<string>();
        for (const s of nodeSuccessors(n)) if (s >= 0) for (const v of liveIn[s]) lo.add(v);
        let li: Set<string>;
        switch (n.k) {
          case 'end':
            if (n.region.kind === 'thread') li = new Set(['pj_k']);
            else {
              const par = n.region.par!;
              const after = par.kind === 'par' ? liveOut[parNodeOf.get(par)!.id] : new Set<string>();
              const assigned = assignedBy.get(n.region)!;
              const o = [...after].filter((v) => assigned.has(v) && !this.isStatic(v) && v !== 'pj_k').sort();
              outs.set(n.region, o);
              li = new Set([...o, ...statics.get(n.region)!]);
            }
            break;
          case 'return':
            li = new Set([...nodeUses(n), 'pj_k']);
            break;
          case 'alt': {
            li = new Set(nodeUses(n));
            for (const c of n.cases) {
              const body = new Set(liveIn[c.body]);
              if (c.guard.k === 'read') body.delete(c.guard.v);
              for (const v of body) li.add(v);
            }
            if (n.replicated) li.delete(n.replicated.v);
            break;
          }
          case 'par': {
            li = new Set(nodeUses(n));
            const allOuts = new Set<string>();
            if (n.par.kind === 'par') for (const r of n.par.regions) for (const v of assignedBy.get(r) ?? []) if (lo.has(v)) allOuts.add(v);
            for (const v of lo) if (!allOuts.has(v)) li.add(v);
            for (const r of n.par.regions) {
              const entryLive = [...liveIn[r.entry]].filter((v) => !this.isStatic(v)).sort();
              ins.set(r, entryLive);
              for (const v of entryLive) li.add(v);
            }
            if (this.instanced) li.add('pj_h');
            break;
          }
          case 'call': {
            li = new Set<string>();
            const callee = this.opts.procOf(n.call.callee);
            const used = callee ? this.opts.calleeUses?.(callee) : undefined;
            n.call.args.forEach((a, i) => {
              if (used && !used.has(i)) return;
              for (const e of [a.value, a.barrier, a.chan?.ch, a.chan?.ack, a.chan?.len]) if (e) for (const v of freeVars(e)) li.add(v);
            });
            for (const v of lo) if (v !== n.ret) li.add(v);
            if (callee && this.opts.needsInstance(callee)) {
              li.add('pj_h');
              for (const v of this.iterationsAround(n.region)) li.add(v);
            }
            break;
          }
          default: {
            // A dead assignment uses nothing (strong liveness): it is never generated.
            if (n.k === 'assign' && !lo.has(n.v)) {
              li = new Set(lo);
              break;
            }
            li = new Set(nodeUses(n));
            const def = n.k === 'assign' || n.k === 'read' ? n.v : undefined;
            for (const v of lo) if (v !== def) li.add(v);
          }
        }
        if (!sameSet(li, liveIn[i])) {
          liveIn[i] = li;
          changed = true;
        }
        if (!sameSet(lo, liveOut[i])) {
          liveOut[i] = lo;
          changed = true;
        }
      }
    }
    // Static variables a region uses are live everywhere in it (a slot gets them once, when the network is built).
    for (const r of this.ir.regions) {
      if (r.kind === 'thread') continue;
      const s = statics.get(r)!;
      for (const n of nodes) if (n.region === r) for (const v of s) liveIn[n.id].add(v);
    }
    return { liveIn, liveOut, outs, statics, ins };
  }

  /** Loop variables of the par fors enclosing a region (they select a callee's instance). */
  private iterationsAround(region: Region): string[] {
    const out: string[] = [];
    let r: Region | undefined = region;
    while (r && r.kind !== 'thread') {
      if (r.kind === 'iteration' && r.par?.iter) out.unshift(r.par.iter.v);
      r = r.par?.owner;
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Definitions
  // -------------------------------------------------------------------------

  private isDef(id: number): boolean {
    const n = this.ir.nodes[id];
    if (id === this.ir.thread.entry) return true;
    if (n.k === 'end') return n.region.kind !== 'thread';
    if (n.k === 'return' || n.k === 'stop' || n.k === 'error') return false;
    if (isEventNode(n)) return true;
    if (n.k === 'nop' && n.loopHead) return true;
    if (this.preds[id].length >= 2) return true;
    if (this.preds[id].some((p) => this.ir.nodes[p].k === 'call')) return true;
    return false;
  }

  private nameDefinitions(): void {
    const ir = this.ir;
    this.usedNames.add(`${ir.name}__body`);
    for (const n of ir.nodes) {
      if (n.id === ir.thread.entry || !this.isDef(n.id)) continue;
      // Branch entries are folded into their slot; a branch entry that is itself a definition keeps a name.
      let base: string;
      if (n.k === 'end') {
        const r = n.region;
        base = r.kind === 'iteration' ? `${ir.name}__parfor${line(r.par!.stmt.span)}__end` : `${ir.name}__par${line(r.par!.stmt.span)}_${r.index}__end`;
      } else {
        const span = this.spanOf(n);
        base = `${ir.name}__${span ? line(span) : 'x'}`;
      }
      this.defNames.set(n.id, this.unique(base));
    }
  }

  private unique(base: string): string {
    let name = base;
    for (let i = 2; this.usedNames.has(name); i++) name = `${base}_${i}`;
    this.usedNames.add(name);
    return name;
  }

  /** The source span a definition stands for: its own statement, or the next real statement for a join point. */
  private spanOf(n: Node): A.Span | undefined {
    let cur: Node | undefined = n;
    const seen = new Set<number>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.stmt?.span && cur.k !== 'nop') return cur.at ?? cur.stmt.span;
      if (cur.at && cur.k !== 'nop') return cur.at;
      if (cur.k === 'nop' && cur.loopHead && cur.at) return cur.at;
      const succ: number | undefined = nodeSuccessors(cur)[0];
      cur = succ !== undefined && succ >= 0 ? this.ir.nodes[succ] : undefined;
    }
    return n.at;
  }

  /** Parameters of a definition: instance, iteration, statics, data in name order, continuation last. */
  private params(id: number): string[] {
    const live = [...this.live.liveIn[id]];
    const rank = (v: string): number => {
      const role = this.ir.vars.get(v)?.role;
      switch (role) {
        case 'instance':
          return 0;
        case 'iteration':
          return 1;
        case 'channel':
        case 'ack':
        case 'barrier':
          return 2;
        case 'continuation':
          return 5;
        default:
          return 3;
      }
    };
    const order = this.declOrder();
    return live.sort((a, b) => rank(a) - rank(b) || (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9) || a.localeCompare(b));
  }

  private orderCache?: Map<string, number>;
  private declOrder(): Map<string, number> {
    if (this.orderCache) return this.orderCache;
    const m = new Map<string, number>();
    let i = 0;
    for (const p of this.ir.params) {
      m.set(p.cspm, i++);
      if (p.ack) m.set(p.ack, i++);
    }
    for (const v of this.ir.vars.keys()) if (!m.has(v)) m.set(v, i++);
    this.orderCache = m;
    return m;
  }

  /** `stop` statements reached by the body generated since the last definition was recorded. */
  private pendingStops: A.Span[] = [];

  /** Record a definition, with the `stop` statements its body reaches (FDR names a stopped state just STOP). */
  private addInfo(info: CspDefinitionInfo): void {
    if (this.pendingStops.length) info.stops = this.pendingStops.map((span) => this.ref(span));
    this.pendingStops = [];
    this.infos.push(info);
  }

  private emitDef(name: string, params: string[], body: string, info: Omit<CspDefinitionInfo, 'name' | 'params' | 'procedure'>, node?: number): void {
    const where = info.at ? this.opts.where(this.ir, info.at.span) : this.ir.name;
    const text = info.text ? `: ${commentText(info.text)}` : '';
    this.out.push(`-- ${where}${text}`);
    this.out.push(`${name}${params.length ? `(${params.join(', ')})` : ''} = ${body}`);
    this.addInfo({ name, params: params.map((p) => this.paramInfo(p)), procedure: this.ir.decl.name.name, ...info, ...(node !== undefined ? { ...this.reachFrom(node), ...this.regionOf(this.ir.nodes[node].region) } : {}) });
  }

  /** What a process at `node` may still do, for the definition's source map entry (reach.ts). */
  private reachFrom(node: number, extra: number[] = []): Pick<CspDefinitionInfo, 'reach' | 'exits'> {
    const r = this.opts.reach?.(this.ir);
    if (!r || node < 0 || !r.keys[node]) return {};
    return { reach: [...new Set([...r.keys[node], ...extra.map((id) => siteKey(this.ir, id))])].sort(), exits: r.exits[node] };
  }

  private paramInfo(p: string): CspParam {
    const v = this.ir.vars.get(p);
    const role: CspParam['role'] = !v ? 'value' : v.role === 'value' ? 'value' : v.role;
    // Temporaries are not ProcessJ variables: they carry no name a report could show.
    return { name: p, role, variable: v && v.role !== 'instance' && v.role !== 'continuation' && !v.temp ? v.name : undefined };
  }

  private describe(n: Node): Omit<CspDefinitionInfo, 'name' | 'params' | 'procedure'> {
    const at = this.spanOf(n);
    const stmtSpan = n.stmt?.span;
    const text = at ? this.opts.sourceText(this.ir, stmtSpan ?? at) : undefined;
    const info: Omit<CspDefinitionInfo, 'name' | 'params' | 'procedure'> = { kind: 'point', at: at ? this.ref(at) : undefined, text };
    if (stmtSpan && at && !sameSpan(stmtSpan, at)) info.statement = this.ref(stmtSpan);
    info.operation = this.operation(n);
    return info;
  }

  private ref(span: A.Span): { uri: string; span: A.Span } {
    return { uri: this.ir.unit.uri, span };
  }

  private operation(n: Node): CspOperation | undefined {
    switch (n.k) {
      case 'write':
        return { kind: 'write', channel: show(n.ch.ch), variable: n.ch.variable };
      case 'read':
        return { kind: n.ext ? 'extended-read' : 'read', channel: show(n.ch.ch), via: n.ch.take ? show(n.ch.take) : undefined, variable: n.ch.variable };
      case 'ack': {
        const event = n.role === 'reader' ? (n.ch.done ?? n.ch.ack) : n.ch.ack;
        return { kind: 'ack', channel: show(n.ch.ch), via: event ? show(event) : undefined, variable: n.ch.variable, role: n.role };
      }
      case 'sync':
        return { kind: 'sync', channel: show(n.b), variable: n.variable };
      case 'alt':
        return {
          kind: 'alt',
          guards: n.cases.map((c) => ({
            kind: c.guard.k,
            channel: c.guard.k === 'read' ? show(c.guard.ch.ch) : undefined,
            via: c.guard.k === 'read' && c.guard.ch.take ? show(c.guard.ch.take) : undefined,
            variable: c.guard.k === 'read' ? c.guard.ch.variable : undefined,
            at: this.ref(c.at),
            precondition: !!c.pre,
            // A constant or a parameter of the alt's definition: its value is in FDR's state name.
            ...(c.pre && (c.pre.k === 'bool' || (c.pre.k === 'var' && !n.replicated)) ? { pre: show(c.pre) } : {}),
          })),
        };
      case 'par':
        return { kind: n.par.kind === 'par' ? 'par' : 'par-for' };
      case 'nop':
        return n.loopHead ? { kind: 'loop' } : undefined;
      case 'tick':
        return { kind: 'internal' };
      default: {
        const pred = this.preds[n.id].map((p) => this.ir.nodes[p]).find((p) => p.k === 'call');
        if (pred && pred.k === 'call') return { kind: 'call' };
        return undefined;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Pars
  // -------------------------------------------------------------------------

  private forkName(par: ParIR, branch?: number): string {
    return `pj_fork_${this.ir.name}_${line(par.stmt.span)}${branch !== undefined ? `_${branch}` : ''}${par.id > 0 && this.parLineClash(par) ? `_p${par.id}` : ''}`;
  }

  private joinName(par: ParIR, branch?: number): string {
    return this.forkName(par, branch).replace(/^pj_fork_/, 'pj_join_');
  }

  private parLineClash(par: ParIR): boolean {
    return this.ir.pars.some((p) => p !== par && line(p.stmt.span) === line(par.stmt.span));
  }

  private slotName(par: ParIR, branch?: number): string {
    const base = par.kind === 'par-for' ? `${this.ir.name}__parfor${line(par.stmt.span)}` : `${this.ir.name}__par${line(par.stmt.span)}_${branch}`;
    return this.parLineClash(par) ? `${base}_p${par.id}` : base;
  }

  /** The par node's own definition was emitted by the generic path; add its fork, its joins and its slots. */
  private emitPar(n: Extract<Node, { k: 'par' }>, defName: string): void {
    const par = n.par;
    const h = this.instanced ? E.v('pj_h') : undefined;
    const slots: SlotInfo[] = [];
    // One fork event starts every branch (or iteration) together, as the runtime schedules them:
    // no run can leave a branch unstarted while its siblings run.
    const payload = this.forkPayload(par);
    const bounded = par.kind === 'par-for' && !!par.iter && !par.iter.values;
    const { lo, hi } = this.opts.data;
    this.channels.push({
      name: this.forkName(par),
      role: 'fork',
      proc: this.ir,
      par,
      // The computed first and last iteration, clamped to the slots (lower.ts checks that every iteration has one).
      bounds: bounded ? [rangeText(lo, hi + 1), rangeText(lo - 1, hi)] : undefined,
      payload: payload.map((v) => this.typeOfVar(v)),
      fields: [...(bounded ? ['first iteration', 'last iteration'] : []), ...payload.map((v) => this.varName(v))],
      vars: payload,
      instanced: this.instanced,
    });
    if (par.kind === 'par') {
      const outsAll = par.regions.map((r) => this.live.outs.get(r) ?? []);
      // Join k waits for branch k, collecting what it assigned; later branches' outputs are still unknown.
      const after = this.params(n.next).filter((v) => v !== 'pj_k' && v !== 'pj_h');
      const keep = after.filter((v) => !outsAll.some((o) => o.includes(v)));
      const extra = ['pj_k'].filter((v) => this.live.liveOut[n.id].has(v));
      const hParam = this.instanced ? ['pj_h'] : [];
      const multi = new Map<string, string[]>();
      outsAll.forEach((o, k) => o.forEach((v) => multi.set(v, [...(multi.get(v) ?? []), `${v}_b${k + 1}'`])));
      const collected: string[] = [];
      par.regions.forEach((r, k) => {
        const joinDef = `${defName}_join${k + 1}`;
        this.usedNames.add(joinDef);
        const params = [...hParam, ...keep, ...collected, ...extra];
        const outs = outsAll[k];
        const names = outs.map((v) => ((multi.get(v)?.length ?? 0) > 1 ? `${v}_b${k + 1}'` : v));
        const inputs = names.map((x) => `?${x}`).join('');
        const event = `${this.joinName(par, k + 1)}${h ? '.pj_h' : ''}${inputs}`;
        const cont = this.recording(joinDef, () => this.along({ ops: [{ kind: 'join', branch: k + 1, at: this.ref(par.stmt.span) }] }, () => {
          if (k + 1 < par.regions.length) {
            this.reach(`${defName}_join${k + 2}`);
            return `${defName}_join${k + 2}(${[...hParam, ...keep, ...collected, ...names, ...extra].join(', ')})`;
          }
          // All branches are back: continue after the par with every output bound.
          const env = identity([...hParam, ...keep, ...collected, ...names, ...extra]);
          const pending: Array<{ v: string; copies: string[] }> = [];
          for (const [v, copies] of multi) {
            if (copies.length > 1) pending.push({ v, copies });
            else env.set(v, E.v(copies[0].replace(/_b\d+'$/, '')));
          }
          let body = this.gen(n.next, env, false);
          for (const p of pending.reverse()) {
            // Several branches assigned the same variable: whichever wrote last wins (a data race).
            body = `|~| ${p.v} : {${p.copies.join(', ')}} @ ${body}`;
          }
          return body;
        }));
        collected.push(...names);
        this.out.push(`-- ${this.opts.where(this.ir, par.stmt.span)}: waiting for branch ${k + 1} of the par`);
        this.out.push(`${joinDef}${params.length ? `(${params.join(', ')})` : ''} = ${event} -> ${cont}`);
        this.addInfo({
          name: joinDef,
          kind: 'join',
          procedure: this.ir.decl.name.name,
          at: this.ref(par.stmt.span),
          text: this.opts.sourceText(this.ir, par.stmt.span),
          operation: { kind: 'join', branch: k + 1 },
          params: params.map((p) => this.paramInfo(p)),
          ...this.reachFrom(n.next),
          ...this.regionOf(n.region),
        });
        this.channels.push({ name: this.joinName(par, k + 1), role: 'join', proc: this.ir, par, branch: k + 1, payload: outs.map((v) => this.typeOfVar(v)), fields: outs.map((v) => this.varName(v)), instanced: this.instanced });
      });
      par.regions.forEach((r, k) => slots.push(this.emitSlot(par, r, k + 1, this.live.ins.get(r) ?? [], payload)));
    } else {
      const joinDef = `${defName}_join`;
      this.usedNames.add(joinDef);
      const params = this.joinParams(n);
      const event = `${this.joinName(par)}${h ? '.pj_h' : ''}`;
      const cont = this.recording(joinDef, () => this.along({ ops: [{ kind: 'join', at: this.ref(par.stmt.span) }] }, () => this.gen(n.next, identity(params), false)));
      this.out.push(`-- ${this.opts.where(this.ir, par.stmt.span)}: waiting for every iteration of the par for`);
      this.out.push(`${joinDef}${params.length ? `(${params.join(', ')})` : ''} = ${event} -> ${cont}`);
      this.addInfo({
        name: joinDef,
        kind: 'join',
        procedure: this.ir.decl.name.name,
        at: this.ref(par.stmt.span),
        text: this.opts.sourceText(this.ir, par.stmt.span),
        operation: { kind: 'join' },
        params: params.map((p) => this.paramInfo(p)),
        ...this.reachFrom(n.next),
        ...this.regionOf(n.region),
      });
      const r = par.regions[0];
      this.channels.push({ name: this.joinName(par), role: 'join', proc: this.ir, par, payload: [], fields: [], instanced: this.instanced });
      slots.push(this.emitSlot(par, r, undefined, this.live.ins.get(r) ?? [], payload));
    }
    this.slots.set(par, slots);
  }

  /** What a par's fork carries: every variable some branch needs from its parent, once each, in branch order. */
  private forkPayload(par: ParIR): string[] {
    const out: string[] = [];
    for (const r of par.regions) for (const v of this.live.ins.get(r) ?? []) if (!out.includes(v)) out.push(v);
    return out;
  }

  /** The node of a par statement: its site key is what a slot needs its parent to reach to run again. */
  private parNode(par: ParIR): number {
    return this.ir.nodes.find((x) => x.k === 'par' && x.par === par)?.id ?? -1;
  }

  /** Parameters of a par for's join: the instance handle (its join event needs it) and what is live after. */
  private joinParams(n: Extract<Node, { k: 'par' }>): string[] {
    const after = this.params(n.next).filter((v) => v !== 'pj_h');
    return this.instanced ? ['pj_h', ...after] : after;
  }

  private typeOfVar(v: string): DType {
    return this.ir.vars.get(v)?.type ?? { k: 'int' };
  }

  private varName(v: string): string {
    return this.ir.vars.get(v)?.name ?? v;
  }

  /**
   * A slot: waits to be started, runs its branch, joins, waits again. It never
   * terminates: the program ends when the root's `pj_end` happens (translate.ts).
   */
  private emitSlot(par: ParIR, r: Region, branch: number | undefined, ins: string[], payload: string[]): SlotInfo {
    const name = this.slotName(par, branch);
    this.usedNames.add(name);
    const statics = this.live.statics.get(r) ?? [];
    const order = this.params(r.entry).filter((v) => statics.includes(v));
    const params = [...order, ...statics.filter((v) => !order.includes(v))];
    const h = this.instanced ? '.pj_h' : '';
    const fork = this.forkName(par);
    const join = this.joinName(par, branch);
    const bounds = par.kind === 'par-for' && par.iter && !par.iter.values ? ['pj_lo', 'pj_hi'] : [];
    // The fork carries what every branch needs: this one binds its own and ignores the rest.
    // It takes only what its parent can send in this instance (translate.ts declares forkSetName):
    // FDR compiles a slot on its own for every value its input allows, and a value no parent sends
    // could reach an inner fork or instance function elaboration never prepared.
    const fields = [...bounds, ...payload.map((v) => (ins.includes(v) ? v : '_'))];
    const inputs = fields.length ? `?${fields.join('.')}:${forkSetName(fork)}${this.instanced ? '(pj_h)' : ''}` : '';
    const env = identity([...params, ...ins]);
    const bounded = bounds.length > 0 && !!par.iter;
    const run = this.recording(name, () => this.along({ ops: [{ kind: 'fork', at: this.ref(par.stmt.span) }] }, () => {
      const body = this.along({ conditional: bounded }, () => this.gen(r.entry, env, false));
      if (!bounded || !par.iter) return body;
      // Outside the computed bounds the iteration does not exist: it joins at once and waits again.
      this.along({ ops: [{ kind: 'join', at: this.ref(par.stmt.span) }], conditional: true }, () => this.reach(name));
      const skip = `${join}${h} -> ${name}(${params.join(', ')})`;
      return `if ${par.iter.v} >= pj_lo and ${par.iter.v} <= pj_hi then ${parenthesise(body)} else ${skip}`;
    }));
    const site = r.stmt?.span ?? par.stmt.span;
    this.out.push(`-- ${this.opts.where(this.ir, site)}: ${par.kind === 'par-for' ? 'iteration of the par for' : `branch ${branch} of the par`}`);
    this.out.push(`${name}${params.length ? `(${params.join(', ')})` : ''} = (${fork}${h}${inputs} -> ${run}) [] (pj_end -> STOP)`);
    this.addInfo({
      name,
      kind: 'slot',
      procedure: this.ir.decl.name.name,
      at: this.ref(site),
      text: this.opts.sourceText(this.ir, site),
      params: params.map((p) => this.paramInfo(p)),
      spawn: { kind: par.kind === 'par-for' ? 'par-for' : 'branch', site: this.ref(par.kind === 'par-for' ? par.stmt.span : site), index: branch, par: this.ref(par.stmt.span) },
      ...this.reachFrom(r.entry),
      restart: siteKey(this.ir, this.parNode(par)),
      ...this.regionOf(r),
    });
    return { region: r, definition: name, statics: params.filter((p) => p !== 'pj_h' && !(par.iter && p === par.iter.v)), fork, join };
  }

  private emitBranchEnd(n: Node): void {
    const r = n.region;
    const par = r.par!;
    const name = this.defNames.get(n.id)!;
    const params = this.params(n.id);
    const outs = this.live.outs.get(r) ?? [];
    const statics = this.live.statics.get(r) ?? [];
    const slot = this.slotName(par, r.kind === 'iteration' ? undefined : r.index);
    const slotParams = this.params(r.entry).filter((v) => statics.includes(v));
    const all = [...slotParams, ...statics.filter((v) => !slotParams.includes(v))];
    const resign = par.enroll.map((b) => `${prefix(b.b)}.pj_resign -> `).join('');
    const h = this.instanced ? '.pj_h' : '';
    const join = this.joinName(par, r.kind === 'iteration' ? undefined : r.index);
    const outputs = outs.map((v) => `!${v}`).join('');
    const site = r.stmt?.span ?? par.stmt.span;
    // Resign from the par's barriers, be collected by the parent, wait to be started again.
    const ending: CspTransitionStep[] = [
      ...par.enroll.map((b): CspTransitionStep => ({ kind: 'resign', name: b.variable })),
      { kind: 'join', ...(r.kind === 'iteration' ? {} : { branch: r.index }), at: this.ref(par.stmt.span) },
    ];
    this.recording(name, () => this.along({ ops: ending }, () => this.reach(slot)));
    this.out.push(`-- ${this.opts.where(this.ir, site)}: ${r.kind === 'iteration' ? 'iteration' : `branch ${r.index}`} finished, waiting for the parent`);
    this.out.push(`${name}${params.length ? `(${params.join(', ')})` : ''} = ${resign}${join}${h}${outputs} -> ${slot}${all.length ? `(${all.join(', ')})` : ''}`);
    this.addInfo({
      name,
      kind: 'branch-end',
      procedure: this.ir.decl.name.name,
      at: this.ref(site),
      text: this.opts.sourceText(this.ir, site),
      params: params.map((p) => this.paramInfo(p)),
      spawn: { kind: par.kind === 'par-for' ? 'par-for' : 'branch', site: this.ref(par.kind === 'par-for' ? par.stmt.span : site), index: r.index, par: this.ref(par.stmt.span) },
      // Done; started again, the branch runs from its entry.
      ...this.reachFrom(r.entry),
      exits: true,
      restart: siteKey(this.ir, this.parNode(par)),
      ...this.regionOf(r),
    });
  }

  // -------------------------------------------------------------------------
  // Process terms
  // -------------------------------------------------------------------------

  private call(id: number, env: Map<string, Ex>): string {
    const name = this.defNames.get(id)!;
    this.reach(name);
    const params = this.params(id);
    if (params.length === 0) return name;
    return this.withChoices(env, params.map((p) => env.get(p) ?? E.v(p)), (args) => `${name}(${args.map(show).join(', ')})`);
  }

  /**
   * Bind every nondeterministic value in `values` by an internal choice around
   * the process built from them. A choice already bound further out (the same
   * value used twice) is not chosen again: `build` gets an environment that
   * says which are bound.
   */
  private withChoices(env: Map<string, Ex>, values: Ex[], build: (values: Ex[], env: Map<string, Ex>) => string): string {
    const cs: Array<Extract<Ex, { k: 'choose' }>> = [];
    for (const v of values) chooses(v, cs);
    const fresh = cs.filter((c) => !env.has(`#c${c.id}`));
    if (fresh.length === 0) return build(values, env);
    const inner = new Map(env);
    for (const c of fresh) inner.set(`#c${c.id}`, E.bool(true));
    let body = build(values, inner);
    for (const c of fresh.reverse()) body = `|~| pj_c${c.id} : ${show(c.domain)} @ ${parenthesise(body)}`;
    return body;
  }

  /** The process that runs from node `id` with variables bound by `env`. */
  private gen(id: number, env: Map<string, Ex>, start: boolean): string {
    if (id < 0) {
      this.reach('STOP');
      return 'STOP';
    }
    const n = this.ir.nodes[id];
    if (!start && this.isDef(id)) return this.call(id, env);
    const val = (e: Ex): Ex => substitute(e, env);
    const at = n.at ? { at: this.ref(n.at) } : {};
    switch (n.k) {
      case 'nop':
        return this.gen(n.next, env, false);
      case 'tick':
        return this.along({ ops: [{ kind: 'tick', ...at }] }, () => `pj_tick -> ${this.gen(n.next, env, false)}`);
      case 'assign': {
        if (!this.live.liveOut[id].has(n.v)) return this.gen(n.next, env, false);
        const value = val(n.e);
        return this.withChoices(env, [value], ([v], env2) => {
          const next = new Map(env2);
          next.set(n.v, v);
          const checked = !!n.range && !(v.k === 'int' && v.v >= this.opts.data.lo && v.v <= this.opts.data.hi);
          const rest = this.along({ conditional: checked }, () => this.gen(n.next, next, false));
          if (!checked) return rest;
          this.failure(n.range!, true);
          return `if member(${show(v)}, Int_t) then ${parenthesise(rest)} else pj_error.${n.range} -> STOP`;
        });
      }
      case 'check': {
        const ok = val(n.ok);
        if (ok.k === 'bool' && ok.v) return this.gen(n.next, env, false);
        return this.withChoices(env, [ok], ([c], env2) => {
          // A check that always fails: the runtime error is the only way on.
          const fails = c.k === 'bool' && !c.v;
          const rest = fails ? this.unreached(() => this.gen(n.next, env2, false)) : this.along({ conditional: true }, () => this.gen(n.next, env2, false));
          this.failure(n.err, !fails);
          return `if ${show(c)} then ${parenthesise(rest)} else pj_error.${n.err} -> STOP`;
        });
      }
      case 'branch': {
        const c = val(n.c);
        if (c.k === 'bool') return this.gen(c.v ? n.t : n.f, env, false);
        const test = (holds: boolean): CspTransitionStep => ({ kind: 'test', holds, ...(n.at ? { name: this.opts.sourceText(this.ir, n.at), at: this.ref(n.at) } : {}) });
        return this.withChoices(env, [c], ([cc], env2) => {
          const then = this.along({ ops: [test(true)], conditional: true }, () => this.gen(n.t, env2, false));
          const otherwise = this.along({ ops: [test(false)], conditional: true }, () => this.gen(n.f, env2, false));
          return `if ${show(cc)} then ${parenthesise(then)} else ${parenthesise(otherwise)}`;
        });
      }
      case 'write':
        return this.withChoices(env, [val(n.e)], ([v], env2) => this.along({ ops: [{ kind: 'write', name: n.ch.variable, ...at }] }, () => `${show(val(n.ch.ch))}!${atom(v)} -> ${this.gen(n.next, env2, false)}`));
      case 'read': {
        const bind = this.binder(n.v, env);
        const next = new Map(env);
        next.set(n.v, E.v(bind));
        // A mediated channel's reader takes the value from the channel's server.
        return this.along({ ops: [{ kind: 'read', name: n.ch.variable, ...at }] }, () => `${show(val(n.ch.take ?? n.ch.ch))}?${bind} -> ${this.gen(n.next, next, false)}`);
      }
      case 'ack': {
        // Writers wait for the acknowledgement; readers send it (`done` to a mediated channel's server).
        const event = n.role === 'reader' ? (n.ch.done ?? n.ch.ack ?? n.ch.ch) : (n.ch.ack ?? n.ch.ch);
        return this.along({ ops: [{ kind: 'ack', name: n.ch.variable, ...at }] }, () => `${show(val(event))} -> ${this.gen(n.next, env, false)}`);
      }
      case 'sync': {
        // Arrive, then wait to be released: two states, so a stuck process says which.
        const goName = `${this.defNames.get(id)}_go`;
        const params = this.params(id);
        if (!this.usedNames.has(goName)) {
          this.usedNames.add(goName);
          const env2 = identity(params);
          const body = this.recording(goName, () => this.along({ ops: [{ kind: 'go', name: n.variable, ...at }] }, () => `${prefix(substitute(n.b, env2))}.pj_go -> ${this.gen(n.next, env2, false)}`));
          this.out.push(`-- ${this.opts.where(this.ir, n.at ?? this.ir.decl.span)}: waiting for the barrier to complete`);
          this.out.push(`${goName}${params.length ? `(${params.join(', ')})` : ''} = ${body}`);
          this.addInfo({
            name: goName,
            kind: 'point',
            procedure: this.ir.decl.name.name,
            at: n.at ? this.ref(n.at) : undefined,
            text: n.at ? this.opts.sourceText(this.ir, n.stmt?.span ?? n.at) : undefined,
            operation: { kind: 'sync', channel: show(n.b), variable: n.variable },
            params: params.map((p) => this.paramInfo(p)),
            // Still in the sync (waiting to be released), then on after it.
            ...this.reachFrom(n.next, [n.id]),
            ...this.regionOf(n.region),
          });
        }
        const args = params.map((p) => show(env.get(p) ?? E.v(p)));
        this.along({ ops: [{ kind: 'sync', name: n.variable, ...at }] }, () => this.reach(goName));
        return `${prefix(val(n.b))}.pj_sync -> ${goName}${params.length ? `(${args.join(', ')})` : ''}`;
      }
      case 'alt':
        return this.alt(n, env);
      case 'par':
        return this.parStart(n, env);
      case 'call':
        return this.callTerm(n, env);
      case 'return':
        return this.withChoices(env, [val(n.e)], ([v]) => {
          this.reach('pj_k');
          return `pj_k(${show(v)})`;
        });
      case 'end':
        if (n.region.kind !== 'thread') return this.call(id, env);
        this.reach('pj_k');
        // A value-returning procedure that falls off its end (Java rejects this) returns a default.
        if (this.ir.returns) return `pj_k(${this.opts.data.defaultValue(this.ir.returns)})`;
        return show(env.get('pj_k') ?? E.v('pj_k'));
      case 'stop':
        if (n.at) this.pendingStops.push(n.at);
        this.along({ ops: [{ kind: 'stop', ...at }] }, () => this.reach('STOP'));
        return 'STOP';
      case 'error':
        this.failure(n.err, false);
        return `pj_error.${n.err} -> STOP`;
    }
  }

  /** The name an input binds: the variable's own unless something still refers to its old value. */
  private binder(v: string, env: Map<string, Ex>): string {
    for (const [k, e] of env) {
      if (k === v) continue;
      // A prime never appears in a ProcessJ or generated global name.
      if (freeVars(e).has(v)) return `${v}${"'".repeat(++this.bindCounter)}`;
    }
    return v;
  }

  private alt(n: Extract<Node, { k: 'alt' }>, env: Map<string, Ex>): string {
    const val = (e: Ex): Ex => substitute(e, env);
    const cases = n.cases;
    if (cases.length === 0) {
      this.reach('STOP');
      return 'STOP';
    }
    const first = cases[0];
    // A first skip guard without a precondition is always ready: nothing else can be chosen (exact).
    if (first.guard.k === 'skip' && !first.pre && !n.replicated) return this.along({ ops: [{ kind: 'skip', at: this.ref(first.at) }], guard: 0 }, () => `pj_skip -> ${this.gen(first.body, env, false)}`);
    const pres = cases.map((c) => (c.pre ? val(c.pre) : undefined));
    return this.withChoices(env, pres.filter((p): p is Ex => !!p), (_values, envChosen) => {
      env = envChosen;
      const alternatives = cases.map((c, i) => {
        const guard = pres[i] ? `${show(pres[i]!)} & ` : '';
        const pre = pres[i];
        const g = c.guard;
        // A guard whose precondition is false is never chosen; any other precondition is a condition.
        const path = (op: CspTransitionStep, body: () => string): string => (pre?.k === 'bool' && !pre.v
          ? this.unreached(body)
          : this.along({ ops: [op], guard: i, conditional: !!pre && !(pre.k === 'bool' && pre.v) }, body));
        if (g.k === 'read') {
          const bind = this.binder(g.v, env);
          const next = new Map(env);
          next.set(g.v, E.v(bind));
          return path({ kind: 'read', name: g.ch.variable, at: this.ref(c.at) }, () => `(${guard}${show(val(g.ch.take ?? g.ch.ch))}?${bind} -> ${this.gen(c.body, next, false)})`);
        }
        // skip and timeout guards are internal events: hiding them makes the alt a sliding choice.
        const event = g.k === 'skip' ? 'pj_skip' : 'pj_timeout';
        return path({ kind: g.k, at: this.ref(c.at) }, () => `(${guard}${event} -> ${this.gen(c.body, env, false)})`);
      });
      let body = alternatives.join('\n    [] ');
      if (n.replicated) body = `[] ${n.replicated.v} : ${show(val(n.replicated.set))} @ (${body})`;
      if (n.allPreErr) {
        this.failure(n.allPreErr, true);
        const anyTrue = pres.map((p) => (p ? show(p) : 'true')).join(' or ');
        // A replicated alt's preconditions depend on its index: some index must have a true one.
        const noneTrue = n.replicated
          ? `empty({ ${n.replicated.v} | ${n.replicated.v} <- ${show(val(n.replicated.set))}, ${anyTrue} })`
          : `not (${anyTrue})`;
        body = `if ${noneTrue} then pj_error.${n.allPreErr} -> STOP else (${body})`;
      }
      return body;
    });
  }

  /** The parent of a par: enroll the branches on its barriers, start every branch with one event, then wait at the joins. */
  private parStart(n: Extract<Node, { k: 'par' }>, env: Map<string, Ex>): string {
    const par = n.par;
    const val = (e: Ex): Ex => substitute(e, env);
    const h = this.instanced ? '.pj_h' : '';
    const defName = this.defNames.get(n.id)!;
    const fork = `${this.forkName(par)}${h}`;
    const payload = this.forkPayload(par).map((v) => val(E.v(v)));
    // Enroll the branches on the par's barriers, start them, wait at the (first) join.
    const starting: CspTransitionStep[] = [
      ...par.enroll.map((b): CspTransitionStep => ({ kind: 'enroll', name: b.variable })),
      { kind: 'fork', at: this.ref(par.stmt.span) },
    ];
    this.along({ ops: starting }, () => this.reach(`${defName}_join${par.kind === 'par' ? '1' : ''}`));
    if (par.kind === 'par') {
      const enroll = par.enroll.map((b) => `${prefix(val(b.b))}.${enrollCount(par.regions.length)} -> `).join('');
      const outsAll = par.regions.map((r) => this.live.outs.get(r) ?? []);
      const after = this.params(n.next).filter((v) => v !== 'pj_k' && v !== 'pj_h');
      const keep = after.filter((v) => !outsAll.some((o) => o.includes(v)));
      const extra = ['pj_k'].filter((v) => this.live.liveOut[n.id].has(v));
      const hParam = this.instanced ? ['pj_h'] : [];
      const args = [...hParam, ...keep, ...extra].map((p) => show(val(E.v(p))));
      return this.withChoices(env, payload, (vals) => `${enroll}${fork}${vals.map((v) => `!${atom(v)}`).join('')} -> ${defName}_join1${args.length ? `(${args.join(', ')})` : ''}`);
    }
    const iter = par.iter!;
    // Computed bounds go on the fork clamped to the slots, which exist for every modelled integer:
    // first in lo..hi+1, last in lo-1..hi, an empty range staying empty (the range check in
    // lower.ts has stopped the run if some iteration has no slot).
    const { lo, hi } = this.opts.data;
    const bounds = iter.values ? [] : [E.call('pj_clamp', val(iter.lo!), E.int(lo), E.int(hi + 1)), E.call('pj_clamp', val(iter.hi!), E.int(lo - 1), E.int(hi))];
    const params = this.joinParams(n);
    return this.withChoices(env, [...bounds, ...payload], (vals) => {
      const count = iter.values ? enrollCount(iter.values.length) : `pj_enroll(${iterationCount(vals[0], vals[1])})`;
      const enroll = par.enroll.map((b) => `${prefix(val(b.b))}.${count} -> `).join('');
      return `${enroll}${fork}${vals.map((v) => `!${atom(v)}`).join('')} -> ${defName}_join${params.length ? `(${params.map((p) => show(val(E.v(p)))).join(', ')})` : ''}`;
    });
  }

  private callTerm(n: Extract<Node, { k: 'call' }>, env: Map<string, Ex>): string {
    const val = (e: Ex): Ex => substitute(e, env);
    const callee = this.opts.procOf(n.call.callee)!;
    const args: Ex[] = [];
    if (this.opts.needsInstance(callee)) {
      const iters = this.iterationsAround(n.region).map((v) => val(E.v(v)));
      args.push(E.call(this.opts.instanceFunction(this.ir, n.call.id), val(E.v('pj_h')), ...iters));
    }
    // Arguments in the order of the callee's entry definition (dead parameters are not passed).
    const checks: Array<{ value: Ex; err: string }> = [];
    for (const name of this.opts.entryParams(callee)) {
      const i = callee.params.findIndex((p) => p.cspm === name || p.ack === name || p.take === name || p.done === name || p.len === name);
      const p = callee.params[i];
      const a = n.call.args[i];
      if (!p || !a) {
        args.push(E.any);
        continue;
      }
      if (p.role === 'channel') {
        const c = a.chan;
        // A channel array's length is data: it goes through the length check like any integer argument.
        const part = p.ack === name ? c?.ack : p.take === name ? c?.take : p.done === name ? c?.done : p.len === name ? c?.len : c?.ch;
        args.push(val(part ?? (p.len === name ? E.any : c?.ch) ?? E.any));
      }
      else if (p.role === 'barrier') args.push(val(a.barrier ?? E.any));
      else {
        const v = val(a.value ?? E.any);
        args.push(v);
        if (a.range) checks.push({ value: v, err: a.range });
      }
    }
    const nextDef = this.defNames.get(n.next);
    const contParams = n.next >= 0 ? this.params(n.next) : [];
    return this.withChoices(env, args, (vals, envChosen) => {
      env = envChosen;
      // The callee's own states are in its machine; the caller goes on where its continuation says.
      const k = this.along({ ops: [{ kind: 'call', name: n.call.callee.name.name, at: this.ref(n.call.site.span) }], call: `${callee.name}__body`, conditional: checks.length > 0 }, () => {
        if (n.ret) {
          const env2 = new Map(env);
          env2.set(n.ret, E.v(n.ret));
          if (nextDef) this.reach(nextDef);
          return `\\ ${n.ret} @ ${nextDef ? `${nextDef}${contParams.length ? `(${contParams.map((p) => show(env2.get(p) ?? E.v(p))).join(', ')})` : ''}` : this.gen(n.next, env2, false)}`;
        }
        if (n.next >= 0) return this.gen(n.next, env, false);
        this.reach('STOP');
        return 'STOP';
      });
      let term = `${callee.name}__body(${[...vals.map(show), k].join(', ')})`;
      for (const c of checks.reverse()) {
        this.failure(c.err, true);
        term = `if member(${show(c.value)}, Int_t) then ${parenthesise(term)} else pj_error.${c.err} -> STOP`;
      }
      return term;
    });
  }
}

/** The barrier operation enrolling `n` processes: a constructor of its own (PJBarOp), so a barrier parameter type-checks. */
function enrollCount(n: number): string {
  return `pj_enroll_${n}`;
}

/** How many iterations run from `first` to `last` (none when last < first). */
function iterationCount(first: Ex, last: Ex): string {
  return `if ${atom(last)} >= ${atom(first)} then ${atom(last)} - ${atom(first)} + 1 else 0`;
}

function identity(params: string[]): Map<string, Ex> {
  return new Map(params.map((p) => [p, E.v(p)]));
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function sameSpan(a: A.Span, b: A.Span): boolean {
  return a.start.line === b.start.line && a.start.col === b.start.col && a.end.line === b.end.line && a.end.col === b.end.col;
}

function line(span: A.Span): number {
  return span.start.line + 1;
}

/** A channel or barrier value that more fields follow (`b.pj_h` in `b.pj_h.pj_sync`). */
function prefix(e: Ex): string {
  return e.k === 'dot' ? [prefix(e.head), ...e.fields.map(atom)].join('.') : atom(e);
}

/** Parenthesise a process term unless it is a simple name or application. */
export function parenthesise(p: string): string {
  return /^[A-Za-z_][A-Za-z0-9_']*(\([^()]*\))?$/.test(p) ? p : `(${p})`;
}
