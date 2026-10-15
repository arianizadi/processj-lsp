/**
 * ProcessJ procedure bodies as control-flow graphs.
 *
 * Every procedure becomes a graph of small nodes: pure assignments (with the
 * checks Java would perform: division by zero, array bounds, null, and the
 * model's integer range on every store), branches, and the operations that
 * synchronise with another process (channel reads and writes, barrier syncs,
 * alts, pars, calls). Expressions are linearised in Java's evaluation order:
 * a read, call or assignment nested in an expression becomes a node of its
 * own before the expression that uses it, and `&&`, `||` and `?:` turn into
 * branches when their later operands have effects or can fail.
 *
 * A par branch and a par for body are regions of their own: each runs as a
 * separate process (a slot of the network, see network.ts).
 */
import type * as A from '../parser/ast';
import type { CheckResult, VarInfo } from '../checker/checker';
import type { ProcSig } from '../checker/index';
import { isPrim, type Type } from '../checker/types';
import { E, freeVars, mangle, type Ex } from './cspm';
import { D, type DataModel, type DType } from './data';

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

/**
 * A channel operand: the channel value, its acknowledgement when the writer
 * must wait for the reader to finish (extended rendezvous, mediated), and for
 * a mediated channel the events a reader takes the value with and says it is
 * done with (see `kind` in translate.ts).
 */
export interface ChanUse {
  ch: Ex;
  ack?: Ex;
  take?: Ex;
  done?: Ex;
  /** ProcessJ name the operation goes through (`out1`, `c`, `cs[i]`). */
  variable: string;
  source: ChanSource;
  /**
   * A whole array of channels (passed to a `chan<T>[]` parameter): `ch` is
   * the array (an indexed CSPm channel, or a parameter holding one) and `len`
   * its length. An element is an ordinary operand whose `ch` is `array.k`.
   */
  array?: boolean;
  len?: Ex;
}

export type ChannelKind = 'plain' | 'ack' | 'mediated';

/** A channel or barrier parameter (by index), or a channel or barrier declared in the procedure. */
export type ChanSource = { k: 'param'; index: number } | { k: 'local'; decl: LocalResource };

export interface LocalResource {
  kind: 'channel' | 'barrier';
  /** ProcessJ name. */
  name: string;
  /** CSPm channel name. */
  cspm: string;
  ack?: string;
  /** A mediated channel: its server's events, qualified by the procedure instance like a barrier. */
  mediated?: { take: string; done: string };
  ident: A.Ident;
  elem?: DType;
  elemText?: string;
  proc: ProcIR;
  /** The region whose process executes the declaration (a barrier's runtime counter lives there). */
  region: Region;
  /**
   * An array of channels (`chan<T> cs[] = new chan<T>[n]`): one CSPm channel
   * indexed by the element (`cs.k`). `len` is the variable holding its length
   * at runtime; `size` is the length expression, which the network evaluates
   * per procedure instance to know the elements (static elaboration).
   */
  array?: { len: string; size: Ex };
  /**
   * Declared in a procedure that is part of a recursion: an instance of it can
   * run inside another, so its events carry the procedure instance
   * (`m.pj_h`), like a barrier's.
   */
  instanced?: boolean;
}

export interface AltCaseIR {
  pre?: Ex;
  guard: { k: 'read'; ch: ChanUse; v: string; ext: boolean } | { k: 'skip' } | { k: 'timeout' };
  /** First node of the case: for an extended read guard, the rendezvous block. */
  body: number;
  at: A.Span;
}

export interface ParIR {
  id: number;
  kind: 'par' | 'par-for';
  stmt: A.ParBlock | A.ForStmt;
  /** Region run by each branch (one region for a par for body). */
  regions: Region[];
  enroll: Array<{ b: Ex; variable: string }>;
  /** par for: loop variable and the iteration values. */
  iter?: { v: string; variable: string; values?: number[]; lo?: Ex; hi?: Ex };
  /** Owner region. */
  owner: Region;
}

export interface CallIR {
  id: number;
  site: A.Invocation;
  callee: A.ProcDecl;
  /**
   * Argument per callee parameter (undefined for timers). `range` is the error
   * raised when an integer argument is outside the model: checked only when
   * the callee uses the parameter, since a dead parameter is never passed.
   */
  args: Array<{ value?: Ex; chan?: ChanUse; barrier?: Ex; range?: string }>;
  region: Region;
}

export interface Region {
  id: number;
  kind: 'thread' | 'branch' | 'iteration';
  entry: number;
  /** The node every path of the region ends in (`end` for the thread, `branch-end` for branches). */
  end: number;
  par?: ParIR;
  /** 1-based branch index. */
  index?: number;
  stmt?: A.Stmt;
}

export type Node = { id: number; region: Region; at?: A.Span; stmt?: A.Stmt } & (
  | { k: 'assign'; v: string; e: Ex; range?: string; next: number }
  | { k: 'check'; ok: Ex; err: string; next: number }
  | { k: 'branch'; c: Ex; t: number; f: number }
  | { k: 'write'; ch: ChanUse; e: Ex; next: number }
  | { k: 'read'; ch: ChanUse; v: string; ext: boolean; next: number }
  | { k: 'ack'; ch: ChanUse; role: 'writer' | 'reader'; next: number }
  | { k: 'sync'; b: Ex; variable: string; next: number }
  | { k: 'alt'; cases: AltCaseIR[]; replicated?: { v: string; set: Ex }; allPreErr?: string; next: number }
  | { k: 'par'; par: ParIR; next: number }
  | { k: 'call'; call: CallIR; ret?: string; next: number }
  | { k: 'return'; e: Ex }
  | { k: 'end' }
  | { k: 'stop' }
  | { k: 'error'; err: string }
  | { k: 'tick'; next: number }
  | { k: 'nop'; next: number; loopHead?: boolean; backEdgeTo?: number }
);

export interface ParamIR {
  name: string;
  cspm: string;
  type: DType;
  role: 'value' | 'channel' | 'barrier' | 'timer';
  /** For channel parameters bound to channels read with extended rendezvous or mediated. */
  ack?: string;
  /** For channel parameters bound to mediated channels. */
  take?: string;
  done?: string;
  /** A `chan<T>[]` parameter: it holds the array, and `len` (a data parameter) its length. */
  array?: boolean;
  len?: string;
  info?: VarInfo;
}

export interface VarIR {
  cspm: string;
  name: string;
  type: DType;
  role: 'value' | 'channel' | 'ack' | 'barrier' | 'instance' | 'iteration' | 'continuation';
  /** A temporary of the translation (a read nested in an expression, an alt precondition), not a ProcessJ variable. */
  temp?: boolean;
}

export interface ErrorSiteIR {
  ctor: string;
  kind: string;
  message: string;
  at: A.Span;
}

export interface UnitIR {
  program: A.Program;
  checked: CheckResult;
  file?: string;
  uri: string;
  text?: string;
}

export interface ProcIR {
  decl: A.ProcDecl;
  unit: UnitIR;
  /** CSPm base name (overloads get `_2`, ...). */
  name: string;
  params: ParamIR[];
  returns?: DType;
  nodes: Node[];
  regions: Region[];
  thread: Region;
  pars: ParIR[];
  calls: CallIR[];
  locals: LocalResource[];
  vars: Map<string, VarIR>;
  errors: ErrorSiteIR[];
  /** Filled by the network: whether the procedure (transitively) runs a par. */
  needsInstance: boolean;
  /** Nodes whose statement the model cannot translate. */
  unsupported: Array<{ message: string; at: A.Span }>;
  /** `code`: a known miscompilation the model does not reproduce (`compiler/stop-ignored`, see miscompile.ts). */
  warnings: Array<{ message: string; at: A.Span; code?: string }>;
}

// ---------------------------------------------------------------------------
// Context shared by all procedures
// ---------------------------------------------------------------------------

export interface LowerContext {
  data: DataModel;
  /** Global CSPm names, so local variables never shadow one they use. */
  globals: { has(name: string): boolean; fresh(base: string): string };
  /** The IR of a procedure declaration (created on demand by the translator). */
  procOf(decl: A.ProcDecl): ProcIR | undefined;
  /** Channel kind of a parameter or local declaration (all channels a value can flow between share one). */
  kindParam(decl: A.ProcDecl, index: number): ChannelKind;
  kindLocal(ident: A.Ident): ChannelKind;
  /** Value of a constant, when it can be computed. */
  constValue(name: string, unit: UnitIR): { e: Ex; t: DType } | undefined;
  /** Global CSPm name of a local channel or barrier declaration. */
  localName(proc: A.ProcDecl, ident: A.Ident, kind: 'channel' | 'barrier'): string;
  isMain(decl: A.ProcDecl): boolean;
  /** Channels and barriers declared in procedures, by variable, shared by the whole translation. */
  locals: Map<VarInfo, LocalResource>;
  /** Whether a procedure is part of a recursion (it calls itself, directly or through others). */
  recursive(decl: A.ProcDecl): boolean;
}

interface LoopCtx {
  label?: string;
  breaks: Edge[];
  continues: Edge[];
  /**
   * A loop takes break and continue, a `switch` only break, and any other
   * labelled statement (a block, an if) only a `break` naming its label.
   */
  kind: 'loop' | 'switch' | 'block';
}

type Edge = (target: number) => void;

interface Value {
  e: Ex;
  t: DType;
}

const SILENT_NATIVES = new Set(['println', 'print', 'initRandom']);

/**
 * Lower one procedure in two steps: `ir` (with its parameters) is available
 * before `body()` runs, so callers and recursive calls can refer to it.
 */
export function startProcedure(decl: A.ProcDecl, unit: UnitIR, name: string, ctx: LowerContext): { ir: ProcIR; body(): void } {
  const lowerer = new Lowerer(decl, unit, name, ctx);
  lowerer.signature();
  return { ir: lowerer.result, body: () => lowerer.body() };
}

class Lowerer {
  private readonly ir: ProcIR;
  private open: Edge[] = [];
  private region!: Region;
  private loops: LoopCtx[] = [];
  private pendingLabel: string | undefined;
  private temps = 0;
  private chooseIds = 0;
  private readonly varNames = new Map<VarInfo, string>();
  private readonly usedNames = new Set<string>();
  private readonly varsByIdent: Map<A.Ident, VarInfo>;

  constructor(
    private readonly decl: A.ProcDecl,
    private readonly unit: UnitIR,
    name: string,
    private readonly ctx: LowerContext,
  ) {
    this.varsByIdent = new Map(unit.checked.vars.map((v) => [v.decl, v]));
    const thread: Region = { id: 0, kind: 'thread', entry: -1, end: -1 };
    this.ir = {
      decl,
      unit,
      name,
      params: [],
      nodes: [],
      regions: [thread],
      thread,
      pars: [],
      calls: [],
      locals: [],
      vars: new Map(),
      errors: [],
      needsInstance: false,
      unsupported: [],
      warnings: [],
    };
    for (const reserved of ['pj_h', 'pj_k']) this.usedNames.add(reserved);
  }

  get result(): ProcIR {
    return this.ir;
  }

  signature(): void {
    const ir = this.ir;
    const ret = this.ctx.data.type(this.typeOfNode(this.decl.returnType));
    if (ret.k !== 'void') ir.returns = ret;
    this.decl.params.forEach((p, index) => {
      const info = this.varsByIdent.get(p.name);
      const t = info ? info.type : this.typeOfNode(p.type);
      const dt = this.ctx.data.type(t);
      const chanArray = chanArrayDims(dt) === 1;
      const role: ParamIR['role'] = dt.k === 'chan' || chanArray ? 'channel' : dt.k === 'barrier' ? 'barrier' : dt.k === 'timer' ? 'timer' : 'value';
      const cspm = info ? this.nameOf(info) : this.freshVar(p.name.name);
      const param: ParamIR = { name: p.name.name, cspm, type: dt, role, info };
      if (chanArrayDims(dt) > 1) this.unsupported('arrays of channels with more than one dimension are not modelled', p.span);
      let kind = role === 'channel' ? this.ctx.kindParam(this.decl, index) : 'plain';
      if (chanArray) {
        param.array = true;
        param.len = this.freshVar(`${cspm}__len`, true);
        ir.vars.set(param.len, { cspm: param.len, name: `${p.name.name}.size`, type: D.int, role: 'value' });
        if (kind !== 'plain') this.unsupported(`the channels of '${p.name.name}' need ${kind === 'ack' ? 'an acknowledgement (an extended rendezvous)' : 'a channel server (the model cannot pair the processes that use them directly: several processes, or one on both sides, use one element)'}; that is not modelled for an array of channels`, p.span);
        kind = 'plain';
      }
      if (kind !== 'plain') {
        param.ack = this.freshVar(`${cspm}__ack`, true);
        ir.vars.set(param.ack, { cspm: param.ack, name: `${p.name.name} (ack)`, type: dt, role: 'ack' });
      }
      if (kind === 'mediated') {
        param.take = this.freshVar(`${cspm}__take`, true);
        param.done = this.freshVar(`${cspm}__done`, true);
        ir.vars.set(param.take, { cspm: param.take, name: `${p.name.name} (take)`, type: dt, role: 'ack' });
        ir.vars.set(param.done, { cspm: param.done, name: `${p.name.name} (done)`, type: dt, role: 'ack' });
      }
      if (role !== 'timer') ir.vars.set(cspm, { cspm, name: p.name.name, type: dt, role: role === 'value' ? 'value' : role });
      ir.params.push(param);
    });
  }

  body(): void {
    const ir = this.ir;
    this.aliased = this.aliasedAggregates();
    this.region = ir.thread;
    const entry = this.add({ k: 'nop', next: -1 } as Node);
    ir.thread.entry = entry;
    if (this.decl.body) this.stmt(this.decl.body);
    this.open = [...this.open, ...this.returns];
    const end = this.add({ k: 'end' } as Node);
    ir.thread.end = end;
    this.open = [];
  }

  // -------------------------------------------------------------------------
  // Graph building
  // -------------------------------------------------------------------------

  /** Append a node, link every open edge to it, and leave its own successor open. */
  private add(node: Node | Omit<Node, 'id' | 'region'>): number {
    const id = this.ir.nodes.length;
    const full = { ...node, id, region: this.region } as Node;
    this.ir.nodes.push(full);
    for (const link of this.open) link(id);
    this.open = [];
    if ('next' in full) this.open = [(t) => ((full as { next: number }).next = t)];
    return id;
  }

  private terminal(node: Omit<Node, 'id' | 'region'>, at?: A.Span): void {
    if (this.open.length === 0) return;
    this.add({ ...node, at } as Node);
    this.open = [];
  }

  private nop(extra: Partial<Extract<Node, { k: 'nop' }>> = {}): number {
    return this.add({ k: 'nop', next: -1, ...extra } as Node);
  }

  private reachable(): boolean {
    return this.open.length > 0;
  }

  // -------------------------------------------------------------------------
  // Names
  // -------------------------------------------------------------------------

  private nameOf(info: VarInfo): string {
    const known = this.varNames.get(info);
    if (known) return known;
    const name = this.freshVar(info.name);
    this.varNames.set(info, name);
    return name;
  }

  private freshVar(base: string, raw = false): string {
    const root = raw ? base : mangle(base);
    let name = root;
    for (let i = 2; this.usedNames.has(name) || this.ctx.globals.has(name); i++) name = `${root}_${i}`;
    this.usedNames.add(name);
    return name;
  }

  private temp(t: DType, hint = 't'): string {
    const name = this.freshVar(`pj_${hint}${++this.temps}`, true);
    this.ir.vars.set(name, { cspm: name, name, type: t, role: 'value', temp: true });
    return name;
  }

  private variable(info: VarInfo): string {
    const name = this.nameOf(info);
    if (!this.ir.vars.has(name)) {
      const dt = this.ctx.data.type(info.type);
      this.ir.vars.set(name, { cspm: name, name: info.name, type: dt, role: 'value' });
    }
    return name;
  }

  private typeOfNode(node: A.TypeNode): Type {
    return this.ctx.data.index.resolve(node);
  }

  private typeOf(e: A.Expr): Type {
    return this.unit.checked.types.get(e) ?? { k: 'unknown' };
  }

  private dtypeOf(e: A.Expr): DType {
    return this.ctx.data.type(this.typeOf(e));
  }

  // -------------------------------------------------------------------------
  // Diagnostics and errors
  // -------------------------------------------------------------------------

  private unsupported(message: string, at: A.Span): void {
    this.ir.unsupported.push({ message, at });
  }

  private warn(message: string, at: A.Span, code?: string): void {
    this.ir.warnings.push({ message, at, code });
  }

  /** A new `pj_error` constructor for a runtime error at `at`. */
  private errorSite(kind: string, message: string, at: A.Span): string {
    const short = kind === 'division-by-zero' ? 'divzero' : kind === 'array-index' ? 'index' : kind === 'alt-preconditions' ? 'alt' : kind;
    // A double underscore keeps error names apart from every variable (a parameter named like a constructor is a pattern).
    const ctor = this.ctx.globals.fresh(`${short}__${this.ir.name}_${at.start.line + 1}`);
    this.ir.errors.push({ ctor, kind, message, at });
    return ctor;
  }

  private check(ok: Ex, kind: string, message: string, at: A.Span): void {
    if (ok.k === 'bool' && ok.v) return;
    const err = this.errorSite(kind, message, at);
    this.add({ k: 'check', ok, err, next: -1, at } as Node);
  }

  private choose(domain: string): Ex {
    return { k: 'choose', id: ++this.chooseIds, domain: E.n(domain) };
  }

  /** Store `value` into variable `v`, range-checked when the variable is an integer. */
  private assign(v: string, value: Value, t: DType, at: A.Span, what: string): void {
    let e = value.e;
    if (t.k === 'int' && value.t.k !== 'int') e = this.toConcrete(value, t);
    else if (t.k === 'bool' && value.t.k !== 'bool') e = this.toConcrete(value, t);
    else if (t.k === 'any') e = E.any;
    const range = t.k === 'int' && !isConstInt(e, this.ctx.data.lo, this.ctx.data.hi)
      ? this.errorSite('range', `${what} gets a value outside the modelled integers ${this.ctx.data.lo}..${this.ctx.data.hi}`, at)
      : undefined;
    this.add({ k: 'assign', v, e, range, next: -1, at } as Node);
  }

  /** A value of an abstract type used where a concrete one is needed: any value of the target domain. */
  private toConcrete(value: Value, t: DType): Ex {
    if (value.t.k === t.k) return value.e;
    if (t.k === 'int') return value.t.k === 'any' ? this.choose('Int_t') : value.e;
    if (t.k === 'bool') return value.t.k === 'any' ? this.choose('Bool') : value.e;
    return value.e;
  }

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------

  private stmt(s: A.Stmt): void {
    if (!this.reachable()) return;
    switch (s.kind) {
      case 'Block':
        for (const st of s.stmts) {
          if (!this.reachable()) break;
          this.stmt(st);
        }
        return;
      case 'EmptyStmt':
      case 'SkipStmt':
        return;
      case 'LocalDecl':
        return this.localDecl(s);
      case 'ExprStmt':
        this.effect(s.expr, s);
        return;
      case 'IfStmt': {
        const c = this.condition(s.cond);
        const [t, f] = this.branch(c, s.cond.span);
        this.open = [t];
        this.stmt(s.then);
        const afterThen = this.open;
        this.open = [f];
        if (s.else) this.stmt(s.else);
        this.open = [...afterThen, ...this.open];
        return;
      }
      case 'WhileStmt':
        return this.loop(s, undefined, s.cond, [], s.body, false);
      case 'DoStmt':
        return this.loop(s, undefined, s.cond, [], s.body, true);
      case 'ForStmt':
        if (s.isPar) return this.parFor(s);
        if (s.init) {
          if (Array.isArray(s.init)) for (const e of s.init) this.effect(e, s);
          else this.localDecl(s.init);
        }
        return this.loop(s, s.init, s.cond, s.update, s.body, false);
      case 'ParBlock':
        return this.par(s);
      case 'SeqBlock':
        return this.stmt(s.body);
      case 'ClaimStmt':
        this.unsupported("'claim' is not modelled", s.span);
        return this.stmt(s.body);
      case 'SwitchStmt':
        return this.switchStmt(s);
      case 'AltStmt':
        return this.alt(s);
      case 'ReturnStmt': {
        if (this.ir.returns && s.expr) {
          const v = this.expr(s.expr);
          const e = this.ir.returns.k === 'int' || this.ir.returns.k === 'bool' ? this.toConcrete(v, this.ir.returns) : v.e;
          if (this.ir.returns.k === 'int') this.rangeCheck(e, s.expr.span, `the value returned by '${this.decl.name.name}'`);
          this.terminal({ k: 'return', e } as Node, s.span);
          return;
        }
        if (s.expr) this.effect(s.expr, s);
        this.toRegionEnd(s.span);
        return;
      }
      case 'BreakStmt': {
        const target = this.findLoop(s.label?.name, false);
        if (!target) {
          this.unsupported(`'break${s.label ? ` ${s.label.name}` : ''}' has no enclosing loop or switch`, s.span);
          this.open = [];
          return;
        }
        target.breaks.push(...this.open);
        this.open = [];
        return;
      }
      case 'ContinueStmt': {
        const target = this.findLoop(s.label?.name, true);
        if (!target) {
          this.unsupported(`'continue${s.label ? ` ${s.label.name}` : ''}' has no enclosing loop`, s.span);
          this.open = [];
          return;
        }
        target.continues.push(...this.open);
        this.open = [];
        return;
      }
      case 'StopStmt':
        this.warn("'stop' — the model stops this process here for good (CSP STOP), as the language says; this ProcessJ build ignores it and carries on (test/differential/stop_ignored.pj)", s.span, 'compiler/stop-ignored');
        this.terminal({ k: 'stop' } as Node, s.span);
        return;
      case 'SuspendStmt':
        this.unsupported("'suspend' (mobile processes) is not modelled", s.span);
        return;
      case 'LabeledStmt': {
        const inner = s.stmt;
        if (inner.kind === 'WhileStmt' || inner.kind === 'DoStmt' || (inner.kind === 'ForStmt' && !inner.isPar) || inner.kind === 'SwitchStmt') {
          // The loop or switch takes the label (takeLabel).
          this.pendingLabel = s.label.name;
          this.stmt(inner);
          this.pendingLabel = undefined;
          return;
        }
        // Any other labelled statement: `break label` leaves it (Java), and nothing else targets it.
        const ctx: LoopCtx = { label: s.label.name, breaks: [], continues: [], kind: 'block' };
        this.loops.push(ctx);
        this.stmt(inner);
        this.loops.pop();
        if (ctx.breaks.length) this.warn(`'break ${s.label.name}' leaves a labelled statement that is not a loop — this ProcessJ build cannot compile that (error 806 "Break statement outside loop or switch construct", or a silent ProcessJc failure inside a loop); the model follows the language`, s.label.span, 'compiler/labelled-break');
        this.open = [...this.open, ...ctx.breaks];
        return;
      }
    }
  }

  /** A `return` (or the last statement) of the region: the thread continues with its caller, a branch ends. */
  private toRegionEnd(at: A.Span): void {
    if (!this.reachable()) return;
    if (this.region.kind !== 'thread') {
      if (this.region.end < 0) this.region.end = this.addDetached({ k: 'end' } as Node);
      for (const link of this.open) link(this.region.end);
      this.open = [];
      return;
    }
    // Thread: jump to the procedure's end node, created when the body is done.
    this.returns.push(...this.open);
    this.open = [];
    void at;
  }

  private readonly returns: Edge[] = [];

  private addDetached(node: Omit<Node, 'id' | 'region'>): number {
    const saved = this.open;
    this.open = [];
    const id = this.add(node);
    this.open = saved;
    return id;
  }

  /** The loop, switch or labelled statement a break or continue jumps out of (or to the next iteration of). */
  private findLoop(label: string | undefined, isContinue: boolean): LoopCtx | undefined {
    for (let i = this.loops.length - 1; i >= 0; i--) {
      const l = this.loops[i];
      if (label) {
        if (l.label !== label) continue;
        // `continue label` must name a loop (Java rejects anything else).
        return isContinue && l.kind !== 'loop' ? undefined : l;
      }
      if (isContinue ? l.kind === 'loop' : l.kind !== 'block') return l;
    }
    return undefined;
  }

  private branch(c: Ex, at: A.Span): [Edge, Edge] {
    const id = this.add({ k: 'branch', c, t: -1, f: -1, at } as Node);
    const node = this.ir.nodes[id] as Extract<Node, { k: 'branch' }>;
    this.open = [];
    return [(t) => (node.t = t), (t) => (node.f = t)];
  }

  private localDecl(d: A.LocalDecl): void {
    if (d.isMobile) this.unsupported('mobile variables are not modelled', d.span);
    for (const decl of d.declarators) {
      const info = this.varsByIdent.get(decl.name);
      if (!info) continue;
      const dt = this.ctx.data.type(info.type);
      if (dt.k === 'chan' || dt.k === 'barrier') {
        if (dt.k === 'chan' && dt.end) {
          this.unsupported('a variable holding a channel end is not modelled (and does not compile with this ProcessJ build)', decl.span);
          continue;
        }
        const kind = dt.k === 'chan' ? 'channel' : 'barrier';
        const cspm = this.ctx.localName(this.decl, decl.name, kind);
        const local: LocalResource = { kind, name: info.name, cspm, ident: decl.name, proc: this.ir, region: this.region };
        if (dt.k === 'chan' && this.ctx.recursive(this.decl)) local.instanced = true;
        if (dt.k === 'chan') {
          local.elem = dt.elem;
          local.elemText = typeText(info.type);
          const kind = this.ctx.kindLocal(decl.name);
          if (kind !== 'plain') local.ack = `${cspm}__ack`;
          if (kind === 'mediated') local.mediated = { take: `${cspm}__take`, done: `${cspm}__done` };
        }
        this.ir.locals.push(local);
        this.ctx.locals.set(info, local);
        continue;
      }
      if (dt.k === 'timer') continue;
      if (chanArrayDims(dt) > 0) {
        this.chanArrayDecl(decl, info, dt);
        continue;
      }
      const v = this.variable(info);
      if (decl.init?.kind === 'ChanRead' && !isPrim(this.typeOf(decl.init.target), 'timer') && (dt.k === 'int' || dt.k === 'bool' || dt.k === 'record' || dt.k === 'protocol')) {
        // `int v = c.read()` binds v directly in the input.
        this.read(decl.init, v);
      } else if (decl.init) {
        const value = decl.init.kind === 'ArrayLiteral' ? this.arrayLiteral(decl.init, dt) : this.expr(decl.init, dt);
        this.assign(v, value, dt, decl.span, `'${info.name}'`);
      } else {
        this.add({ k: 'assign', v, e: defaultEx(this.ctx.data, dt), next: -1, at: decl.span } as Node);
      }
    }
  }

  /**
   * `chan<T> cs[] = new chan<T>[n]`: n channels, one indexed CSPm channel
   * (`cs.k`). The length is stored in a variable when the declaration runs
   * (range-checked like any integer, a negative one is Java's
   * NegativeArraySizeException); which elements exist is decided per
   * procedure instance by the network, which evaluates the length there.
   */
  private chanArrayDecl(decl: A.Declarator, info: VarInfo, dt: DType): void {
    if (chanArrayDims(dt) > 1) {
      this.unsupported('arrays of channels with more than one dimension are not modelled', decl.span);
      return;
    }
    const init = decl.init;
    if (!init || init.kind !== 'NewArray' || init.init || init.dimExprs.length !== 1) {
      this.unsupported(init && (init.kind === 'ArrayLiteral' || (init.kind === 'NewArray' && init.init))
        ? 'an array literal of channels ({ a, b }) is not modelled; declare it with new chan<T>[n]'
        : `the channel array '${info.name}' is modelled only when it is declared with 'new chan<T>[n]' (this ProcessJ build creates its channels only there)`, decl.span);
      return;
    }
    const kind = this.ctx.kindLocal(decl.name);
    if (kind !== 'plain') {
      this.unsupported(`the channels of '${info.name}' need ${kind === 'ack' ? 'an acknowledgement (an extended rendezvous)' : 'a channel server (the model cannot pair the processes that use them directly: several processes, or one on both sides, use one element)'}; that is not modelled for an array of channels`, decl.span);
      return;
    }
    const size = this.toConcrete(this.expr(init.dimExprs[0], D.int), D.int);
    this.check(E.bin('>=', size, E.int(0)), 'array-index', 'negative array size', init.dimExprs[0].span);
    const cspm = this.ctx.localName(this.decl, decl.name, 'channel');
    const len = this.freshVar(`${cspm}__len`, true);
    this.ir.vars.set(len, { cspm: len, name: `${info.name}.size`, type: D.int, role: 'value' });
    this.assign(len, { e: size, t: D.int }, D.int, decl.span, `the size of '${info.name}'`);
    const elemType = info.type.k === 'array' ? info.type.elem : info.type;
    const elem = dt.k === 'array' && dt.elem.k === 'chan' ? dt.elem.elem : D.any;
    const local: LocalResource = { kind: 'channel', name: info.name, cspm, ident: decl.name, proc: this.ir, region: this.region, elem, elemText: typeText(elemType), array: { len, size } };
    if (this.ctx.recursive(this.decl)) local.instanced = true;
    this.ir.locals.push(local);
    this.ctx.locals.set(info, local);
  }

  private loop(s: A.WhileStmt | A.DoStmt | A.ForStmt, _init: unknown, cond: A.Expr | undefined, update: A.Expr[], body: A.Stmt, bodyFirst: boolean): void {
    const ctx: LoopCtx = { label: this.takeLabel(), breaks: [], continues: [], kind: 'loop' };
    const head = this.nop({ loopHead: true });
    (this.ir.nodes[head] as { stmt?: A.Stmt }).stmt = s;
    this.ir.nodes[head].at = s.span;
    this.loops.push(ctx);
    if (bodyFirst) {
      this.stmt(body);
      this.open.push(...ctx.continues);
      ctx.continues = [];
      if (this.reachable()) {
        const c = cond ? this.condition(cond) : E.bool(true);
        const [t, f] = this.branch(c, cond?.span ?? s.span);
        this.open = [t];
        this.backEdge(head);
        this.open = [f];
      }
    } else {
      const c = cond ? this.condition(cond) : E.bool(true);
      if (c.k === 'bool' && c.v) {
        // while (true): no exit edge.
      } else {
        const [t, f] = this.branch(c, cond?.span ?? s.span);
        ctx.breaks.push(f);
        this.open = [t];
      }
      this.stmt(body);
      this.open.push(...ctx.continues);
      ctx.continues = [];
      if (this.reachable()) {
        for (const u of update) this.effect(u, s);
        this.backEdge(head);
      }
    }
    this.loops.pop();
    this.open = [...this.open, ...ctx.breaks];
  }

  private takeLabel(): string | undefined {
    const label = this.pendingLabel;
    this.pendingLabel = undefined;
    return label;
  }

  /** Close a loop iteration: a marker node that becomes a tick when the iteration may pass no event. */
  private backEdge(head: number): void {
    if (!this.reachable()) return;
    const id = this.nop({ backEdgeTo: head });
    (this.ir.nodes[id] as { next: number }).next = head;
    this.open = [];
  }

  private switchStmt(s: A.SwitchStmt): void {
    const subject = this.expr(s.expr);
    const t = this.typeOf(s.expr);
    const v = this.temp(subject.t, 'sw');
    this.add({ k: 'assign', v, e: subject.e, next: -1, at: s.expr.span } as Node);
    const value = E.v(v);
    const ctx: LoopCtx = { label: this.takeLabel(), breaks: [], continues: [], kind: 'switch' };
    this.loops.push(ctx);
    // Test the labels in order; each group's statements fall through into the next group's.
    const groupEntries: Edge[][] = s.groups.map(() => []);
    let defaultGroup = -1;
    s.groups.forEach((g, gi) => {
      for (const label of g.labels) {
        if (!label) {
          defaultGroup = gi;
          continue;
        }
        const test = this.caseTest(value, t, label);
        const [yes, no] = this.branch(test, label.span);
        groupEntries[gi].push(yes);
        this.open = [no];
      }
    });
    const noMatch = this.open;
    if (defaultGroup >= 0) groupEntries[defaultGroup].push(...noMatch);
    else ctx.breaks.push(...noMatch);
    this.open = [];
    s.groups.forEach((g, gi) => {
      this.open = [...this.open, ...groupEntries[gi]];
      for (const st of g.stmts) {
        if (!this.reachable()) break;
        this.stmt(st);
      }
    });
    this.loops.pop();
    this.open = [...this.open, ...ctx.breaks];
  }

  private caseTest(value: Ex, t: Type, label: A.Expr): Ex {
    if (t.k === 'protocol' && label.kind === 'NameExpr') {
      const ctor = this.ctx.data.protocolCtor(t.name, label.name.name);
      const fam = this.ctx.data.family('protocol', t.name);
      if (!ctor) {
        this.unsupported(`'${label.name.name}' is not a case of ${t.name}`, label.span);
        return E.bool(false);
      }
      return E.call(`${fam.type}_is_${ctor.ctor}`, value);
    }
    if (isPrim(t, 'string')) return this.choose('Bool');
    const l = this.pure(label);
    return E.bin('==', value, l.e);
  }

  // -------------------------------------------------------------------------
  // Concurrency
  // -------------------------------------------------------------------------

  private par(s: A.ParBlock): void {
    const par: ParIR = { id: this.ir.pars.length, kind: 'par', stmt: s, regions: [], enroll: [], owner: this.region };
    this.ir.pars.push(par);
    for (const b of s.barriers) {
      const bar = this.barrierOf(b);
      if (bar) par.enroll.push(bar);
    }
    const node = this.add({ k: 'par', par, next: -1, at: s.span, stmt: s } as Node);
    const after = this.open;
    const outer = this.region;
    const outerLoops = this.loops;
    s.body.stmts.forEach((branch, i) => {
      const region: Region = { id: this.ir.regions.length, kind: 'branch', entry: -1, end: -1, par, index: i + 1, stmt: branch };
      this.ir.regions.push(region);
      par.regions.push(region);
      this.region = region;
      this.loops = [];
      this.open = [];
      region.entry = this.addDetached({ k: 'nop', next: -1 } as Node);
      const entryNode = this.ir.nodes[region.entry] as { next: number };
      this.open = [(t) => (entryNode.next = t)];
      this.stmt(branch);
      this.toRegionEnd(branch.span);
      if (region.end < 0) region.end = this.addDetached({ k: 'end' } as Node);
    });
    this.region = outer;
    this.loops = outerLoops;
    this.open = after;
    void node;
  }

  private parFor(s: A.ForStmt): void {
    const par: ParIR = { id: this.ir.pars.length, kind: 'par-for', stmt: s, regions: [], enroll: [], owner: this.region };
    this.ir.pars.push(par);
    for (const b of s.enroll) {
      const bar = this.barrierOf(b);
      if (bar) par.enroll.push(bar);
    }
    // The loop variable is per iteration: each iteration is a slot that knows its value.
    const init = s.init;
    let loopVar: VarInfo | undefined;
    let start: A.Expr | undefined;
    if (init && !Array.isArray(init) && init.declarators.length === 1) {
      loopVar = this.varsByIdent.get(init.declarators[0].name);
      start = init.declarators[0].init;
    } else if (Array.isArray(init) && init.length === 1 && init[0].kind === 'AssignExpr' && init[0].op === '=' && init[0].target.kind === 'NameExpr') {
      loopVar = this.unit.checked.resolutions.get(init[0].target);
      start = init[0].value;
    }
    if (!loopVar || !start) {
      this.unsupported("this 'par for' header is not modelled; write 'par for (int i = a; i < b; i++)'", s.span);
      return;
    }
    const v = this.variable(loopVar);
    this.ir.vars.set(v, { cspm: v, name: loopVar.name, type: D.int, role: 'iteration' });
    const iter = this.iterationSet(loopVar, start, s.cond, s.update, s.span);
    if (!iter) return;
    par.iter = { v, variable: loopVar.name, ...iter };
    this.add({ k: 'par', par, next: -1, at: s.span, stmt: s } as Node);
    const after = this.open;
    const outer = this.region;
    const outerLoops = this.loops;
    const region: Region = { id: this.ir.regions.length, kind: 'iteration', entry: -1, end: -1, par, stmt: s.body };
    this.ir.regions.push(region);
    par.regions.push(region);
    this.region = region;
    this.loops = [];
    this.open = [];
    region.entry = this.addDetached({ k: 'nop', next: -1 } as Node);
    const entryNode = this.ir.nodes[region.entry] as { next: number };
    this.open = [(t) => (entryNode.next = t)];
    this.stmt(s.body);
    this.toRegionEnd(s.body.span);
    if (region.end < 0) region.end = this.addDetached({ k: 'end' } as Node);
    this.region = outer;
    this.loops = outerLoops;
    this.open = after;
  }

  /** The values a `par for` iterates over: computed when the bounds are constants, a CSPm range otherwise. */
  private iterationSet(loopVar: VarInfo, start: A.Expr, cond: A.Expr | undefined, update: A.Expr[], at: A.Span): { values?: number[]; lo?: Ex; hi?: Ex } | undefined {
    const step = stepOf(loopVar, update, this.unit.checked);
    const bound = cond ? boundOf(loopVar, cond, this.unit.checked) : undefined;
    if (step === undefined || !bound) {
      this.unsupported("this 'par for' is not modelled: write 'i < n', 'i <= n', 'i > n' or 'i >= n' with 'i++', 'i--', 'i += k' or 'i -= k'", at);
      return undefined;
    }
    const s0 = this.pure(start);
    const b = this.pure(bound.expr);
    if (s0.e.k === 'int' && b.e.k === 'int') {
      const values: number[] = [];
      for (let i = s0.e.v; values.length <= 4096; i += step) {
        const ok = bound.op === '<' ? i < b.e.v : bound.op === '<=' ? i <= b.e.v : bound.op === '>' ? i > b.e.v : bound.op === '>=' ? i >= b.e.v : i !== b.e.v;
        if (!ok) break;
        values.push(i);
      }
      if (values.length > 4096) {
        this.unsupported("this 'par for' runs more than 4096 iterations", at);
        return undefined;
      }
      return { values };
    }
    if (Math.abs(step) !== 1 || bound.op === '!=') {
      this.unsupported("a 'par for' with computed bounds is modelled only with a step of 1 and a '<', '<=', '>' or '>=' bound", at);
      return undefined;
    }
    // Iterations run from start toward the bound; slots exist for every modelled integer, so an
    // iteration whose value is outside them cannot be modelled: that is a range error (the fork
    // event then carries the bounds clamped to the slots, gen.ts).
    const lo = step > 0 ? s0.e : bound.op === '>' ? E.bin('+', b.e, E.int(1)) : b.e;
    const hi = step > 0 ? (bound.op === '<' ? E.bin('-', b.e, E.int(1)) : b.e) : s0.e;
    const { lo: L, hi: H } = this.ctx.data;
    this.check(E.or(E.bin('<', hi, lo), E.and(E.bin('>=', lo, E.int(L)), E.bin('<=', hi, E.int(H)))), 'range', `the iterations of this par for go outside the modelled integers ${L}..${H}`, at);
    return { lo, hi };
  }

  private alt(s: A.AltStmt): void {
    const cases: Array<{ c: A.AltCase; pre?: Ex }> = [];
    const flatten = (alt: A.AltStmt): void => {
      if (alt.replicated && alt !== s) this.unsupported('a replicated alt nested in an alt is not modelled', alt.span);
      for (const c of alt.cases) {
        if (c.nested) flatten(c.nested);
        else cases.push({ c });
      }
    };
    flatten(s);
    let replicated: { v: string; set: Ex } | undefined;
    let replicatedVar: VarInfo | undefined;
    if (s.replicated) {
      const r = s.replicated;
      const init = r.init;
      let loopVar: VarInfo | undefined;
      let start: A.Expr | undefined;
      if (init && !Array.isArray(init) && init.declarators.length === 1) {
        loopVar = this.varsByIdent.get(init.declarators[0].name);
        start = init.declarators[0].init;
      }
      const step = loopVar ? stepOf(loopVar, r.update, this.unit.checked) : undefined;
      const bound = loopVar && r.cond ? boundOf(loopVar, r.cond, this.unit.checked) : undefined;
      if (!loopVar || !start || step !== 1 || !bound || (bound.op !== '<' && bound.op !== '<=')) {
        this.unsupported("this replicated alt header is not modelled; write 'alt (int i = a; i < b; i++)'", s.span);
        return;
      }
      const v = this.variable(loopVar);
      const lo = this.pure(start).e;
      const hiBound = this.pure(bound.expr).e;
      replicated = { v, set: { k: 'range', lo, hi: bound.op === '<' ? E.bin('-', hiBound, E.int(1)) : hiBound } };
      replicatedVar = loopVar;
    }
    // Java evaluates every boolean precondition before the alt waits.
    for (const entry of cases) {
      if (!entry.c.precondition) continue;
      const pre = this.expr(entry.c.precondition);
      entry.pre = this.toConcrete(pre, D.bool);
      if (entry.pre.k !== 'bool' && entry.pre.k !== 'var' && !replicated) {
        const t = this.temp(D.bool, 'pre');
        this.add({ k: 'assign', v: t, e: entry.pre, next: -1, at: entry.c.precondition.span } as Node);
        entry.pre = E.v(t);
      }
    }
    // The guards' channels (an element of a channel array is bounds-checked here, before the alt waits).
    const guardChannels = new Map<A.AltCase, ChanUse | undefined>();
    for (const { c } of cases) {
      if (c.guard?.kind !== 'ReadGuard') continue;
      guardChannels.set(c, this.chanOf(c.guard.read.target, replicated && replicatedVar ? { ...replicated, info: replicatedVar } : undefined));
    }
    const allGuarded = cases.length > 0 && cases.every((x) => x.pre);
    const allPreErr = allGuarded
      ? this.errorSite('alt-preconditions', 'every precondition of this alt is false: the ProcessJ runtime stops the program ("One of the boolean pre-guards must be true!")', s.span)
      : undefined;
    const irCases: AltCaseIR[] = [];
    const node = this.add({ k: 'alt', cases: irCases, replicated, allPreErr, next: -1, at: s.span, stmt: s } as Node);
    this.open = [];
    const ends: Edge[] = [];
    for (const { c, pre } of cases) {
      const g = c.guard;
      if (!g) continue;
      const bodyEntry = this.addDetached({ k: 'nop', next: -1 } as Node);
      const entryNode = this.ir.nodes[bodyEntry] as { next: number };
      this.open = [(t) => (entryNode.next = t)];
      if (g.kind === 'ReadGuard') {
        const ch = guardChannels.get(c);
        if (!ch) {
          this.open = [];
          continue;
        }
        const targetVar = this.simpleTarget(g.target);
        const tdt = this.dtypeOf(g.read);
        const v = targetVar ?? this.temp(tdt, 'g');
        const ext = !!g.read.extended;
        irCases.push({ pre, guard: { k: 'read', ch, v, ext }, body: bodyEntry, at: g.span });
        if (ext) {
          this.stmt(g.read.extended!);
          if (this.reachable()) this.add({ k: 'ack', ch, role: 'reader', next: -1, at: g.read.span } as Node);
        } else if (ch.ack) {
          this.add({ k: 'ack', ch, role: 'reader', next: -1, at: g.read.span } as Node);
        }
        if (!targetVar) this.store(g.target, { e: E.v(v), t: tdt }, g.span);
      } else {
        irCases.push({ pre, guard: { k: g.kind === 'SkipGuard' ? 'skip' : 'timeout' }, body: bodyEntry, at: g.span });
        if (g.kind === 'TimeoutGuard') this.effectOnly(g.timeout.delay);
      }
      if (c.body) this.stmt(c.body);
      ends.push(...this.open);
    }
    void node;
    this.open = ends;
  }

  private barrierOf(e: A.Expr): { b: Ex; variable: string } | undefined {
    if (e.kind === 'NameExpr') {
      const info = this.unit.checked.resolutions.get(e);
      if (info) {
        const local = this.ctx.locals.get(info);
        if (local && local.proc === this.ir) return { b: this.localBarrier(local), variable: info.name };
        const index = this.decl.params.findIndex((p) => p.name === info.decl);
        if (index >= 0) return { b: E.v(this.ir.params[index].cspm), variable: info.name };
      }
    }
    this.unsupported('this barrier expression is not modelled; use a barrier variable or parameter', e.span);
    return undefined;
  }

  /**
   * A barrier declared here. Its runtime counter is per procedure instance, so
   * the value carries the instance handle (`santa_reindeer.pj_h`); see network.ts.
   */
  private localBarrier(local: LocalResource): Ex {
    return E.dot(E.n(local.cspm), E.v('pj_h'));
  }

  /**
   * An array of channels named by `target` (a local declared with `new
   * chan<T>[n]`, or a `chan<T>[]` parameter): the CSPm value of the array, its
   * length, and where its channels come from.
   */
  private chanArrayOf(target: A.Expr): { base: Ex; len: Ex; source: ChanSource; name: string } | undefined {
    let e = target;
    while (e.kind === 'ParenExpr') e = e.expr;
    if (e.kind !== 'NameExpr') return undefined;
    const info = this.unit.checked.resolutions.get(e);
    if (!info) return undefined;
    const local = this.ctx.locals.get(info);
    if (local?.array && local.proc === this.ir) return { base: local.instanced ? E.dot(E.n(local.cspm), E.v('pj_h')) : E.n(local.cspm), len: E.v(local.array.len), source: { k: 'local', decl: local }, name: info.name };
    const index = info.isParam ? this.decl.params.findIndex((p) => p.name === info.decl) : -1;
    const p = index >= 0 ? this.ir.params[index] : undefined;
    if (p?.array && p.len) return { base: E.v(p.cspm), len: E.v(p.len), source: { k: 'param', index }, name: info.name };
    return undefined;
  }

  /**
   * An element of a channel array: `cs.k` for a statically known index, an
   * index computed in CSPm otherwise, after Java's bounds check (an index
   * outside the array is a runtime error: ArrayIndexOutOfBoundsException).
   * In a replicated alt the index may be the alt's own variable: the check
   * then covers the whole range before the alt waits.
   */
  private chanElementOf(e: A.ArrayAccess, replicated?: { v: string; set: Ex; info: VarInfo }): ChanUse | undefined {
    const arr = this.chanArrayOf(e.target);
    if (!arr) return undefined;
    let index = e.index;
    while (index.kind === 'ParenExpr') index = index.expr;
    let idx: Ex;
    if (replicated && index.kind === 'NameExpr' && this.unit.checked.resolutions.get(index) === replicated.info) {
      idx = E.v(replicated.v);
      const set = replicated.set;
      if (set.k !== 'range') return undefined;
      this.check(E.or(E.bin('<', set.hi, set.lo), E.and(E.bin('>=', set.lo, E.int(0)), E.bin('<', set.hi, arr.len))), 'array-index', `an index of '${exprText(e.target)}' this replicated alt uses is outside the array`, e.span);
    } else {
      if (replicated && mentions(e.index, replicated.info, this.unit.checked)) {
        this.unsupported(`a replicated alt over '${exprText(e)}' is modelled only when the index is the alt's own variable`, e.span);
        return undefined;
      }
      idx = this.toConcrete(this.expr(e.index), D.int);
      this.check(E.and(E.bin('>=', idx, E.int(0)), E.bin('<', idx, arr.len)), 'array-index', `the index of '${exprText(e.target)}' is outside the array`, e.span);
    }
    return { ch: E.dot(arr.base, idx), variable: exprText(e), source: arr.source };
  }

  /** The channel an operation goes through. */
  private chanOf(target: A.Expr, replicated?: { v: string; set: Ex; info: VarInfo }): ChanUse | undefined {
    let e = target;
    while (e.kind === 'ParenExpr' || e.kind === 'ChanEnd') e = e.kind === 'ParenExpr' ? e.expr : e.target;
    if (e.kind === 'ArrayAccess') {
      const element = this.chanElementOf(e, replicated);
      if (element) return element;
    }
    if (e.kind === 'NameExpr') {
      const arr = this.chanArrayOf(e);
      if (arr) return { ch: arr.base, len: arr.len, array: true, variable: arr.name, source: arr.source };
      const info = this.unit.checked.resolutions.get(e);
      if (info) {
        const local = this.ctx.locals.get(info);
        if (local && local.kind === 'channel' && local.proc === this.ir) {
          if (local.mediated) {
            // A mediated channel's server is per procedure instance, like a barrier's counter.
            const q = (name: string): Ex => E.dot(E.n(name), E.v('pj_h'));
            return { ch: q(local.cspm), ack: q(local.ack!), take: q(local.mediated.take), done: q(local.mediated.done), variable: info.name, source: { k: 'local', decl: local } };
          }
          const q = (name: string): Ex => (local.instanced ? E.dot(E.n(name), E.v('pj_h')) : E.n(name));
          return { ch: q(local.cspm), ack: local.ack ? q(local.ack) : undefined, variable: info.name, source: { k: 'local', decl: local } };
        }
        const index = this.decl.params.findIndex((p) => p.name === info.decl);
        if (index >= 0 && this.ir.params[index].role === 'channel') {
          const p = this.ir.params[index];
          const v = (name: string | undefined): Ex | undefined => (name ? E.v(name) : undefined);
          return { ch: E.v(p.cspm), ack: v(p.ack), take: v(p.take), done: v(p.done), variable: info.name, source: { k: 'param', index } };
        }
      }
    }
    this.unsupported('this channel expression is not modelled; operate on a channel variable or a channel-end parameter', target.span);
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------

  /** Evaluate an expression statement for its effects. */
  private effect(e: A.Expr, stmt?: A.Stmt): void {
    switch (e.kind) {
      case 'ChanWrite': {
        const ch = this.chanOf(e.target);
        const value = this.expr(e.value);
        if (!ch) return;
        const elem = this.dtypeOf(e.value);
        const chanType = this.typeOf(e.target);
        const elemType = chanType.k === 'chan' ? this.ctx.data.type(chanType.elem) : elem;
        const out = elemType.k === 'int' || elemType.k === 'bool' ? this.toConcrete(value, elemType) : elemType.k === 'any' ? E.any : value.e;
        if (elemType.k === 'int') this.rangeCheck(out, e.value.span, `the value written to '${ch.variable}'`);
        this.add({ k: 'write', ch, e: out, next: -1, at: e.span, stmt } as Node);
        if (ch.ack) this.add({ k: 'ack', ch, role: 'writer', next: -1, at: e.span, stmt } as Node);
        return;
      }
      case 'Sync': {
        const bar = this.barrierOf(e.target);
        if (bar) this.add({ k: 'sync', b: bar.b, variable: bar.variable, next: -1, at: e.span, stmt } as Node);
        return;
      }
      case 'Timeout':
        // Time is abstract: a timeout lets time pass and returns.
        this.effectOnly(e.delay);
        return;
      case 'Invocation':
        this.invocation(e, true, stmt);
        return;
      case 'ChanRead':
        this.read(e, undefined, stmt);
        return;
      case 'ParenExpr':
        return this.effect(e.expr, stmt);
      default:
        this.expr(e);
    }
  }

  /** Evaluate only for side effects, discarding the value. */
  private effectOnly(e: A.Expr): void {
    if (hasEffects(e)) this.expr(e);
  }

  /** A channel read; stores into `target` (a variable name) or a fresh temporary. */
  private read(e: A.ChanRead, into: string | undefined, stmt?: A.Stmt): Value {
    const targetType = this.typeOf(e.target);
    if (isPrim(targetType, 'timer')) return { e: E.any, t: D.any };
    const ch = this.chanOf(e.target);
    const t = this.dtypeOf(e);
    if (!ch) return { e: defaultEx(this.ctx.data, t), t };
    const v = into ?? this.temp(t, 'r');
    const ext = !!e.extended;
    this.add({ k: 'read', ch, v, ext, next: -1, at: e.span, stmt } as Node);
    if (ext) {
      this.stmt(e.extended!);
      if (this.reachable()) this.add({ k: 'ack', ch, role: 'reader', next: -1, at: e.span, stmt } as Node);
    } else if (ch.ack) {
      this.add({ k: 'ack', ch, role: 'reader', next: -1, at: e.span, stmt } as Node);
    }
    return { e: E.v(v), t };
  }

  /** A variable that can be bound directly by an input (`x = c.read()`). */
  private simpleTarget(target: A.Expr): string | undefined {
    if (target.kind !== 'NameExpr') return undefined;
    const info = this.unit.checked.resolutions.get(target);
    if (!info || this.ctx.locals.has(info)) return undefined;
    const dt = this.ctx.data.type(info.type);
    if (dt.k === 'chan' || dt.k === 'barrier' || dt.k === 'timer') return undefined;
    return this.variable(info);
  }

  /** An expression that is normally a constant (a bound, a case label): lowered like any other. */
  private pure(e: A.Expr): Value {
    return this.expr(e);
  }

  /** A condition as a concrete boolean. */
  private condition(e: A.Expr): Ex {
    return this.toConcrete(this.expr(e), D.bool);
  }

  /**
   * Lower an expression: emit nodes for its effects and checks, in Java's
   * evaluation order, and return its value.
   */
  private expr(e: A.Expr, expected?: DType): Value {
    const t = this.dtypeOf(e);
    switch (e.kind) {
      case 'Literal':
        return this.literal(e, expected ?? t);
      case 'ParenExpr':
        return this.expr(e.expr, expected);
      case 'NameExpr':
        return this.name(e, t);
      case 'BinaryExpr':
        return this.binary(e, t);
      case 'UnaryExpr':
        return this.unary(e, t);
      case 'AssignExpr':
        return this.assignment(e);
      case 'TernaryExpr': {
        const c = this.condition(e.cond);
        if (!hasEffects(e.then) && !hasEffects(e.else) && !mayFail(e.then) && !mayFail(e.else)) {
          const a = this.expr(e.then, t);
          const b = this.expr(e.else, t);
          return { e: E.if(c, this.coerce(a, t), this.coerce(b, t)), t };
        }
        const v = this.temp(t, 'q');
        const [yes, no] = this.branch(c, e.cond.span);
        this.open = [yes];
        const a = this.expr(e.then, t);
        this.add({ k: 'assign', v, e: this.coerce(a, t), next: -1, at: e.then.span } as Node);
        const afterThen = this.open;
        this.open = [no];
        const b = this.expr(e.else, t);
        this.add({ k: 'assign', v, e: this.coerce(b, t), next: -1, at: e.else.span } as Node);
        this.open = [...afterThen, ...this.open];
        return { e: E.v(v), t };
      }
      case 'CastExpr':
        return this.cast(e, t);
      case 'IsExpr': {
        const value = this.expr(e.expr);
        const st = this.typeOf(e.expr);
        if (st.k !== 'protocol') return { e: this.choose('Bool'), t: D.bool };
        const ctor = this.ctx.data.protocolCtor(st.name, e.typeName.name);
        const fam = this.ctx.data.family('protocol', st.name);
        return { e: ctor ? E.call(`${fam.type}_is_${ctor.ctor}`, value.e) : E.bool(false), t: D.bool };
      }
      case 'Invocation':
        return this.invocation(e, false);
      case 'RecordAccess':
        return this.access(e, t);
      case 'ArrayAccess': {
        const arr = this.expr(e.target);
        const idx = this.toConcrete(this.expr(e.index), D.int);
        this.check(E.and(E.bin('>=', idx, E.int(0)), E.bin('<', idx, E.call('length', arr.e))), 'array-index', `the index of '${exprText(e.target)}' is outside the array`, e.span);
        return { e: E.call('pj_nth', arr.e, idx), t };
      }
      case 'ChanEnd': {
        const ch = this.chanOf(e.target);
        return { e: ch?.ch ?? E.any, t };
      }
      case 'ChanRead':
        return this.read(e, undefined);
      case 'ChanWrite':
      case 'Sync':
      case 'Timeout':
        this.effect(e);
        return { e: E.any, t: D.void };
      case 'NewArray':
        return this.newArray(e, t);
      case 'ArrayLiteral':
        return this.arrayLiteral(e, expected ?? t);
      case 'RecordLiteral':
        return this.recordLiteral(e, t);
      case 'ProtocolLiteral':
        return this.protocolLiteral(e, t);
      case 'NewMobile':
        this.unsupported("'new mobile' processes are not modelled", e.span);
        return { e: E.any, t };
      case 'ErrorExpr':
        this.unsupported('this expression has a syntax error', e.span);
        return { e: E.any, t };
    }
  }

  private literal(e: A.Literal, t: DType): Value {
    switch (e.litKind) {
      case 'int':
      case 'long': {
        const v = parseIntLiteral(e.text);
        return v === undefined ? { e: E.any, t: D.any } : { e: E.int(v), t: D.int };
      }
      case 'char':
        return { e: E.int(charCode(e.text)), t: D.int };
      case 'boolean':
        return { e: E.bool(e.text === 'true'), t: D.bool };
      case 'null':
        return { e: defaultEx(this.ctx.data, t), t };
      default:
        return { e: E.any, t: D.any };
    }
  }

  private name(e: A.NameExpr, t: DType): Value {
    const info = this.unit.checked.resolutions.get(e);
    if (info) {
      const local = this.ctx.locals.get(info);
      if (local && local.proc === this.ir) return { e: local.kind === 'barrier' || local.instanced ? this.localBarrier(local) : E.n(local.cspm), t };
      const dt = this.ctx.data.type(info.type);
      if (dt.k === 'timer') return { e: E.any, t: D.any };
      const index = info.isParam ? this.decl.params.findIndex((p) => p.name === info.decl) : -1;
      if (index >= 0) return { e: E.v(this.ir.params[index].cspm), t: dt };
      return { e: E.v(this.variable(info)), t: dt };
    }
    const c = this.ctx.constValue(e.name.name, this.unit);
    if (c) return c;
    this.unsupported(`'${e.name.name}' is not modelled (no variable or constant of that name is known)`, e.span);
    return { e: E.any, t };
  }

  private coerce(v: Value, t: DType): Ex {
    if (t.k === 'int' || t.k === 'bool') return this.toConcrete(v, t);
    if (t.k === 'any') return E.any;
    return v.e;
  }

  private binary(e: A.BinaryExpr, t: DType): Value {
    if (e.op === '&&' || e.op === '||') {
      const l = this.condition(e.left);
      if (!hasEffects(e.right) && !mayFail(e.right)) {
        const r = this.condition(e.right);
        return { e: e.op === '&&' ? E.and(l, r) : E.or(l, r), t: D.bool };
      }
      const v = this.temp(D.bool, 'b');
      this.add({ k: 'assign', v, e: l, next: -1, at: e.left.span } as Node);
      const [yes, no] = this.branch(E.v(v), e.left.span);
      this.open = [e.op === '&&' ? yes : no];
      const r = this.condition(e.right);
      this.add({ k: 'assign', v, e: r, next: -1, at: e.right.span } as Node);
      this.open = [...this.open, e.op === '&&' ? no : yes];
      return { e: E.v(v), t: D.bool };
    }
    const l = this.expr(e.left);
    const r = this.expr(e.right);
    return this.operator(e.op, l, r, this.dtypeOf(e.left), this.dtypeOf(e.right), t, e.span, exprText(e), isNull(e.left) || isNull(e.right));
  }

  /** Apply a binary operator (also used by compound assignments such as `x += e`). */
  private operator(op: string, l: Value, r: Value, lt: DType, rt: DType, t: DType, at: A.Span, text: string, withNull = false): Value {
    const isCmp = ['==', '!=', '<', '<=', '>', '>='].includes(op);
    if (isCmp) {
      if (l.t.k === 'any' || r.t.k === 'any' || lt.k === 'any' || rt.k === 'any') return { e: this.choose('Bool'), t: D.bool };
      const reference = lt.k === 'record' || lt.k === 'protocol' || lt.k === 'array' || rt.k === 'record' || rt.k === 'protocol' || rt.k === 'array';
      if (reference && op !== '==' && op !== '!=') return { e: this.choose('Bool'), t: D.bool };
      if (reference && !withNull) this.warn('records, protocols and arrays are compared by value in the model; Java compares references', at);
      return { e: E.bin(op as '==', l.e, r.e), t: D.bool };
    }
    if (t.k === 'any') return { e: E.any, t: D.any };
    if (t.k === 'bool') {
      // Non-short-circuit boolean operators.
      if (op === '&') return { e: E.and(l.e, r.e), t };
      if (op === '|') return { e: E.or(l.e, r.e), t };
      if (op === '^') return { e: E.bin('!=', l.e, r.e), t };
    }
    if (t.k !== 'int') return { e: E.any, t: D.any };
    // Arithmetic on an abstract value (a timer reading, `t.read() + 100`) is abstract too:
    // it becomes some modelled integer only where it is stored or decides something. A
    // division still fails when its divisor may be zero.
    if (l.t.k === 'any' || r.t.k === 'any') {
      if (op === '/' || op === '%') this.check(E.bin('!=', this.toConcrete(r, D.int), E.int(0)), 'division-by-zero', `division by zero in '${text}'`, at);
      return { e: E.any, t: D.any };
    }
    const a = this.toConcrete(l, D.int);
    const b = this.toConcrete(r, D.int);
    switch (op) {
      case '+':
      case '-':
      case '*':
        return { e: E.bin(op, a, b), t };
      case '/':
      case '%': {
        this.check(E.bin('!=', b, E.int(0)), 'division-by-zero', `division by zero in '${text}'`, at);
        if (a.k === 'int' && b.k === 'int' && b.v !== 0) return { e: E.int(op === '/' ? Math.trunc(a.v / b.v) : a.v % b.v), t };
        return { e: E.call(op === '/' ? 'pj_div' : 'pj_mod', a, b), t };
      }
      case '&':
        return { e: E.call('pj_band', a, b), t };
      case '|':
        return { e: E.call('pj_bor', a, b), t };
      case '^':
        return { e: E.call('pj_bxor', a, b), t };
      case '<<':
        return { e: E.call('pj_shl', a, b), t };
      case '>>':
        return { e: E.call('pj_shr', a, b), t };
      case '>>>':
        this.warn("'>>>' is modelled as '>>': for a negative value Java's unsigned shift gives a large number the model's range does not hold", at);
        return { e: E.call('pj_shr', a, b), t };
      default:
        return { e: E.any, t: D.any };
    }
  }

  private unary(e: A.UnaryExpr, t: DType): Value {
    if (e.op === '++' || e.op === '--') {
      const lv = this.lvalue(e.operand);
      const old = lv.current();
      const next: Value = { e: E.bin(e.op === '++' ? '+' : '-', this.toConcrete(old, D.int), E.int(1)), t: D.int };
      if (!e.prefix) {
        // Keep the old value for the expression before the variable changes.
        const keep = this.temp(t, 'old');
        this.add({ k: 'assign', v: keep, e: old.e, next: -1, at: e.span } as Node);
        lv.store(next, e.span);
        return { e: E.v(keep), t };
      }
      lv.store(next, e.span);
      return next;
    }
    const v = this.expr(e.operand);
    switch (e.op) {
      case '-':
        if (v.t.k !== 'int') return { e: E.any, t: D.any };
        return { e: v.e.k === 'int' ? E.int(-v.e.v) : { k: 'neg', e: v.e }, t };
      case '+':
        return v;
      case '!':
        return { e: E.not(this.toConcrete(v, D.bool)), t: D.bool };
      case '~':
        return v.t.k === 'int' ? { e: E.call('pj_bnot', v.e), t } : { e: E.any, t: D.any };
      default:
        return { e: E.any, t: D.any };
    }
  }

  private assignment(e: A.AssignExpr): Value {
    const tt = this.dtypeOf(e.target);
    if (chanArrayDims(tt) > 0) {
      this.unsupported('assigning an array of channels is not modelled (this ProcessJ build creates its channels only in the declaration)', e.span);
      return { e: E.any, t: tt };
    }
    if (e.op === '=' && e.value.kind === 'ChanRead' && !isPrim(this.typeOf(e.value.target), 'timer')) {
      // `x = c.read()` binds x directly in the input.
      const direct = this.simpleTarget(e.target);
      if (direct) {
        this.read(e.value, direct);
        return { e: E.v(direct), t: tt };
      }
    }
    // Java: the target's array and index (or record) first, then the value, then the store.
    const lv = this.lvalue(e.target);
    let value: Value;
    if (e.op === '=') {
      value = e.value.kind === 'ArrayLiteral' ? this.arrayLiteral(e.value, tt) : this.expr(e.value, tt);
    } else {
      const operand = this.expr(e.value);
      value = this.operator(e.op.slice(0, -1), lv.current(), operand, tt, this.dtypeOf(e.value), tt, e.span, exprText(e));
    }
    lv.store(value, e.span);
    return { e: this.coerce(value, tt), t: tt };
  }

  /** Store into a variable, record field or array element (the target evaluated now). */
  private store(target: A.Expr, value: Value, at: A.Span): void {
    this.lvalue(target).store(value, at);
  }

  /**
   * An assignment target with its sub-expressions (array, index, record)
   * evaluated in Java's order. `store` performs the checks Java performs when
   * storing (null, bounds) and updates the variable that holds the aggregate.
   */
  private lvalue(target: A.Expr): { current(): Value; store(value: Value, at: A.Span): void } {
    while (target.kind === 'ParenExpr') target = target.expr;
    const tt = this.dtypeOf(target);
    if (target.kind === 'NameExpr') {
      const info = this.unit.checked.resolutions.get(target);
      if (!info) {
        this.unsupported(`cannot assign to '${target.name.name}'`, target.span);
        return { current: () => ({ e: E.any, t: tt }), store: () => undefined };
      }
      const dt = this.ctx.data.type(info.type);
      const index = info.isParam ? this.decl.params.findIndex((p) => p.name === info.decl) : -1;
      const v = index >= 0 ? this.ir.params[index].cspm : this.variable(info);
      return {
        current: () => ({ e: E.v(v), t: dt }),
        store: (value, at) => this.assign(v, value, dt, at, `'${info.name}'`),
      };
    }
    if (target.kind === 'RecordAccess') {
      const ownerType = this.typeOf(target.target);
      if (ownerType.k !== 'record') {
        this.unsupported(`assigning to '${exprText(target)}' is not modelled`, target.span);
        return { current: () => ({ e: E.any, t: tt }), store: () => undefined };
      }
      const fam = this.ctx.data.family('record', ownerType.name);
      const owner = this.lvalue(target.target);
      const field = mangle(target.member.name);
      return {
        current: () => ({ e: E.call(`${fam.type}_get_${field}`, owner.current().e), t: tt }),
        store: (value, at) => {
          const record = owner.current();
          this.check(E.bin('!=', record.e, E.n(fam.nullCtor)), 'null', `'${exprText(target.target)}' is null`, target.span);
          const fieldValue = this.coerce(value, tt);
          if (tt.k === 'int') this.rangeCheck(fieldValue, at, `field '${target.member.name}'`);
          this.warnAliasedStore(target);
          owner.store({ e: E.call(`${fam.type}_set_${field}`, record.e, fieldValue), t: record.t }, at);
        },
      };
    }
    if (target.kind === 'ArrayAccess') {
      const arr = this.lvalue(target.target);
      const idx = this.toConcrete(this.expr(target.index), D.int);
      // Hold the index in a variable: evaluating the value may change what the expression means.
      const held = idx.k === 'int' ? idx : (() => {
        const t = this.temp(D.int, 'i');
        this.add({ k: 'assign', v: t, e: idx, next: -1, at: target.index.span } as Node);
        return E.v(t);
      })();
      return {
        current: () => ({ e: E.call('pj_nth', arr.current().e, held), t: tt }),
        store: (value, at) => {
          const a = arr.current();
          this.check(E.and(E.bin('>=', held, E.int(0)), E.bin('<', held, E.call('length', a.e))), 'array-index', `the index of '${exprText(target.target)}' is outside the array`, target.span);
          const elem = this.coerce(value, tt);
          if (tt.k === 'int') this.rangeCheck(elem, at, `an element of '${exprText(target.target)}'`);
          this.warnAliasedStore(target);
          arr.store({ e: E.call('pj_update', a.e, held, elem), t: a.t }, at);
        },
      };
    }
    this.unsupported(`assigning to '${exprText(target)}' is not modelled`, target.span);
    return { current: () => ({ e: E.any, t: tt }), store: () => undefined };
  }

  /** Arrays and records something else may also refer to (aliasedAggregates). */
  private aliased = new Set<VarInfo>();
  private readonly warnedAliases = new Set<VarInfo>();

  /**
   * A store into an element or field of an array or record that another
   * variable, a caller or another process may also refer to: Java changes the
   * one object they share, the model changes a copy. Said once per variable,
   * with a code, so verdicts that may depend on it say so (explain.ts).
   */
  private warnAliasedStore(target: A.RecordAccess | A.ArrayAccess): void {
    let root: A.Expr = target;
    while (root.kind === 'RecordAccess' || root.kind === 'ArrayAccess' || root.kind === 'ParenExpr') root = root.kind === 'ParenExpr' ? root.expr : root.target;
    if (root.kind !== 'NameExpr') return;
    const v = this.unit.checked.resolutions.get(root);
    if (!v || !this.aliased.has(v) || this.warnedAliases.has(v)) return;
    this.warnedAliases.add(v);
    const what = target.kind === 'ArrayAccess' ? 'array' : 'record';
    this.warn(`'${v.name}' may share its ${what} with another variable, a caller or another process: Java changes the one ${what} they share, the model a copy, so the others do not see this change`, target.span, 'model/aliasing');
  }

  /**
   * Arrays, records and protocol values of this procedure that may share their
   * object with something else: the target of a store of an existing object
   * (`b = a`, `x = c.read()`, `p = ps[i]`) and every such variable in a value
   * that is stored, sent or put into an array or record (`b = a`, `c.write(r)`,
   * `ps[0] = p`, `{ p, q }`). A fresh object (`new int[2]`, a literal) shares
   * nothing; a call shares only what its arguments may return.
   */
  private aliasedAggregates(): Set<VarInfo> {
    const out = new Set<VarInfo>();
    const checked = this.unit.checked;
    const aggregate = (t: Type | undefined): boolean => !!t && (t.k === 'array' || t.k === 'record' || t.k === 'protocol');
    /** Aggregate variables a value may refer to, and whether it may be an object that exists already. */
    const refers = (e: A.Expr): { vars: VarInfo[]; existing: boolean } => {
      const vars: VarInfo[] = [];
      let existing = false;
      const visit = (x: A.Expr): void => {
        if (x.kind === 'NameExpr') {
          const v = checked.resolutions.get(x);
          if (v && aggregate(v.type)) {
            vars.push(v);
            existing = true;
          }
          return;
        }
        if (x.kind === 'ChanRead' && !isPrim(this.typeOf(x.target), 'timer')) existing = true;
        forEachChildExpr(x, visit);
      };
      visit(e);
      return { vars, existing };
    };
    const rootVar = (e: A.Expr): VarInfo | undefined => {
      while (e.kind === 'RecordAccess' || e.kind === 'ArrayAccess' || e.kind === 'ParenExpr') e = e.kind === 'ParenExpr' ? e.expr : e.target;
      return e.kind === 'NameExpr' ? checked.resolutions.get(e) : undefined;
    };
    // A literal's type may be unknown to the checker; it is an array, record or protocol all the same.
    const aggregateValue = (x: A.Expr): boolean => aggregate(this.typeOf(x)) || x.kind === 'ArrayLiteral' || x.kind === 'RecordLiteral' || x.kind === 'ProtocolLiteral' || x.kind === 'NewArray';
    const stored = (target: VarInfo | undefined, value: A.Expr): void => {
      // Only a stored array, record or protocol value is a reference that can be shared.
      if (!aggregateValue(value)) return;
      const { vars, existing } = refers(value);
      for (const v of vars) out.add(v);
      if (target && aggregate(target.type) && existing) out.add(target);
      // A store into an element or field puts the object inside another one.
      if (target && vars.length) out.add(target);
    };
    const visit = (e: A.Expr): void => {
      if (e.kind === 'AssignExpr' && e.op === '=') stored(rootVar(e.target), e.value);
      else if (e.kind === 'ChanWrite' && aggregate(this.typeOf(e.value))) for (const v of refers(e.value).vars) out.add(v);
      else if ((e.kind === 'ArrayLiteral' || e.kind === 'RecordLiteral' || e.kind === 'ProtocolLiteral')) {
        const parts = e.kind === 'ArrayLiteral' ? e.elements : e.fields.map((f) => f.value);
        for (const x of parts) if (aggregate(this.typeOf(x))) for (const v of refers(x).vars) out.add(v);
      }
      forEachChildExpr(e, visit);
    };
    const visitStmt = (s: A.Stmt | undefined): void => {
      if (!s) return;
      if (s.kind === 'LocalDecl') {
        for (const d of s.declarators) {
          const v = this.varsByIdent.get(d.name);
          if (d.init) stored(v, d.init);
        }
      }
      if (s.kind === 'AltStmt') {
        for (const c of s.cases) if (c.guard?.kind === 'ReadGuard') stored(rootVar(c.guard.target), c.guard.read);
      }
    };
    const walk = (s: A.Stmt | undefined): void => {
      if (!s) return;
      visitStmt(s);
      forEachChildStmt(s, walk);
    };
    walk(this.decl.body);
    forEachExprInStmt(this.decl.body, visit);
    return out;
  }

  private cast(e: A.CastExpr, t: DType): Value {
    const v = this.expr(e.expr);
    if (t.k === 'int') {
      if (v.t.k !== 'int') return { e: this.choose('Int_t'), t };
      const to = this.typeOf(e);
      if (isPrim(to, 'byte')) return { e: E.call('pj_to_byte', v.e), t };
      if (isPrim(to, 'short')) return { e: E.call('pj_to_short', v.e), t };
      if (isPrim(to, 'char')) return { e: E.call('pj_to_char', v.e), t };
      return v;
    }
    if (t.k === 'any') return { e: E.any, t };
    return { e: v.e, t };
  }

  private access(e: A.RecordAccess, t: DType): Value {
    const ownerType = this.typeOf(e.target);
    if (ownerType.k === 'array' && (e.member.name === 'length' || e.member.name === 'size')) {
      const channels = this.chanArrayOf(e.target);
      if (channels) return { e: channels.len, t: D.int };
      const arr = this.expr(e.target);
      return { e: E.call('length', arr.e), t: D.int };
    }
    if (isPrim(ownerType, 'string')) return { e: t.k === 'int' ? this.choose('Int_t') : E.any, t };
    const owner = this.expr(e.target);
    if (ownerType.k === 'record' || ownerType.k === 'protocol') {
      const fam = this.ctx.data.family(ownerType.k, ownerType.name);
      this.check(E.bin('!=', owner.e, E.n(fam.nullCtor)), 'null', `'${exprText(e.target)}' is null`, e.span);
      return { e: E.call(`${fam.type}_get_${mangle(e.member.name)}`, owner.e), t };
    }
    this.unsupported(`'${exprText(e)}' is not modelled`, e.span);
    return { e: E.any, t };
  }

  private newArray(e: A.NewArray, t: DType): Value {
    if (e.init) return this.arrayLiteral(e.init, t);
    if (t.k !== 'array') return { e: E.any, t };
    const dims = e.dimExprs.map((d) => this.toConcrete(this.expr(d), D.int));
    const build = (level: number, type: DType): Ex => {
      if (level >= dims.length || type.k !== 'array') return defaultEx(this.ctx.data, type);
      return E.call('pj_new_array', dims[level], build(level + 1, type.elem));
    };
    for (const [i, d] of dims.entries()) this.check(E.bin('>=', d, E.int(0)), 'array-index', 'negative array size', e.dimExprs[i].span);
    return { e: build(0, t), t };
  }

  private arrayLiteral(e: A.ArrayLiteral, t: DType): Value {
    const elemType = t.k === 'array' ? t.elem : D.any;
    const items = e.elements.map((x) => {
      const v = x.kind === 'ArrayLiteral' ? this.arrayLiteral(x, elemType) : this.expr(x, elemType);
      return this.coerce(v, elemType);
    });
    return { e: { k: 'seq', items }, t };
  }

  private recordLiteral(e: A.RecordLiteral, t: DType): Value {
    if (t.k !== 'record') return { e: E.any, t };
    const ctor = this.ctx.data.recordCtor(t.name);
    if (!ctor) return { e: E.any, t };
    const given = new Map(e.fields.map((f) => [f.name.name, f.value]));
    const fields = ctor.fields.map((f) => {
      const x = given.get(f.name);
      if (!x) return defaultEx(this.ctx.data, f.type);
      return this.fieldValue(this.expr(x, f.type), f.type, x.span, `field '${f.name}'`);
    });
    return { e: ctorValue(ctor.ctor, fields), t };
  }

  private protocolLiteral(e: A.ProtocolLiteral, t: DType): Value {
    if (t.k !== 'protocol') return { e: E.any, t };
    const ctor = this.ctx.data.protocolCtor(t.name, e.tag.name);
    if (!ctor) return { e: E.any, t };
    const given = new Map(e.fields.map((f) => [f.name.name, f.value]));
    const fields = ctor.fields.map((f) => {
      const x = given.get(f.name);
      if (!x) return defaultEx(this.ctx.data, f.type);
      return this.fieldValue(this.expr(x, f.type), f.type, x.span, `field '${f.name}' of ${e.tag.name}`);
    });
    return { e: ctorValue(ctor.ctor, fields), t };
  }

  /** A value stored in a field: range-checked like any other store. */
  private fieldValue(v: Value, t: DType, at: A.Span, what: string): Ex {
    const e = this.coerce(v, t);
    if (t.k === 'int') this.rangeCheck(e, at, what);
    return e;
  }

  /** A value about to be stored or sent must be a modelled integer. */
  private rangeCheck(e: Ex, at: A.Span, what: string): void {
    if (isConstInt(e, this.ctx.data.lo, this.ctx.data.hi)) return;
    this.check(E.call('member', e, E.n('Int_t')), 'range', `${what} is outside the modelled integers ${this.ctx.data.lo}..${this.ctx.data.hi}`, at);
  }

  // -------------------------------------------------------------------------
  // Calls
  // -------------------------------------------------------------------------

  private invocation(e: A.Invocation, statement: boolean, stmt?: A.Stmt): Value {
    const t = this.dtypeOf(e);
    if (e.target) this.effectOnly(e.target);
    const sig: ProcSig | undefined = this.unit.checked.calls.get(e);
    const callee = sig?.decl;
    if (!sig || !callee) {
      for (const a of e.args) this.effectOnly(a);
      this.warn(`'${e.name.name}' could not be resolved; the call is modelled as doing nothing`, e.span);
      return { e: t.k === 'int' ? this.choose('Int_t') : t.k === 'bool' ? this.choose('Bool') : E.any, t };
    }
    const ir = callee.body ? this.ctx.procOf(callee) : undefined;
    if (!ir) return this.native(e, sig, t);
    // Arguments are evaluated left to right, then the callee runs.
    const args: CallIR['args'] = [];
    e.args.forEach((arg, i) => {
      const p = ir.params[i];
      if (!p) {
        this.effectOnly(arg);
        return;
      }
      if (p.role === 'timer') {
        this.effectOnly(arg);
        args.push({});
        return;
      }
      if (p.role === 'channel') {
        const ch = this.chanOf(arg);
        args.push({ chan: ch });
        return;
      }
      if (p.role === 'barrier') {
        const b = this.barrierOf(arg);
        args.push({ barrier: b?.b });
        return;
      }
      const v = arg.kind === 'ArrayLiteral' ? this.arrayLiteral(arg, p.type) : this.expr(arg, p.type);
      const value = this.coerce(v, p.type);
      const range = p.type.k === 'int' && !isConstInt(value, this.ctx.data.lo, this.ctx.data.hi)
        ? this.errorSite('range', `argument '${p.name}' of ${sig.name} is outside the modelled integers ${this.ctx.data.lo}..${this.ctx.data.hi}`, arg.span)
        : undefined;
      if (p.type.k === 'array' || p.type.k === 'record' || p.type.k === 'protocol') this.noteMutableArgument(ir, i, arg.span);
      args.push({ value, range });
    });
    const call: CallIR = { id: this.ir.calls.length, site: e, callee, args, region: this.region };
    this.ir.calls.push(call);
    const ret = ir.returns ? this.temp(ir.returns, 'ret') : undefined;
    this.add({ k: 'call', call, ret, next: -1, at: e.span, stmt } as Node);
    if (ret) return { e: E.v(ret), t: ir.returns! };
    void statement;
    return { e: E.any, t: D.void };
  }

  private noteMutableArgument(callee: ProcIR, index: number, at: A.Span): void {
    const p = callee.params[index];
    if (!p?.info) return;
    // Only warn when the callee (or a procedure it hands the parameter to) writes into its fields or elements.
    if (!mutatesParameter(callee, index, (d) => this.ctx.procOf(d))) return;
    this.warn(`'${callee.decl.name.name}' changes its ${p.type.k} parameter '${p.name}': in Java the caller sees the change, the model passes a copy, so the caller does not`, at, 'model/aliasing');
  }

  /** A library procedure: printing does nothing, random values are any value, the rest is abstract. */
  private native(e: A.Invocation, sig: ProcSig, t: DType): Value {
    const name = sig.name;
    const args = e.args.map((a) => this.expr(a));
    if (SILENT_NATIVES.has(name)) return { e: E.any, t: D.void };
    if (name === 'longRandom' || name === 'random' || name === 'intRandom') return { e: this.choose('Int_t'), t: D.int };
    if (name === 'abs' && args.length === 1 && args[0].t.k === 'int') return { e: E.call('pj_abs', args[0].e), t: D.int };
    if (t.k === 'void') {
      this.warn(`'${name}' is a library procedure the model does not know; it is modelled as doing nothing`, e.span);
      return { e: E.any, t: D.void };
    }
    if (t.k === 'int') return { e: this.choose('Int_t'), t };
    if (t.k === 'bool') return { e: this.choose('Bool'), t };
    return { e: E.any, t: D.any };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A record or protocol value. Fields go through a constructor function: in
 * CSPm `c!C.x` on a channel parameter can be read as sending `C` then `x`.
 */
export function ctorValue(ctor: string, fields: Ex[]): Ex {
  return fields.length ? E.call(`pj_new_${ctor}`, ...fields) : E.n(ctor);
}

export function defaultEx(data: DataModel, t: DType): Ex {
  switch (t.k) {
    case 'int':
      return E.int(0);
    case 'bool':
      return E.bool(false);
    case 'record':
    case 'protocol': {
      const fam = data.familyByType(t.family);
      return E.n(fam?.nullCtor ?? 'pj_any');
    }
    case 'array':
      return { k: 'seq', items: [] };
    default:
      return E.any;
  }
}

/**
 * Whether a value is certainly inside the modelled integers without a check:
 * every integer variable is (each store into one is checked), and so is a
 * choice over Int_t.
 */
function isConstInt(e: Ex, lo: number, hi: number): boolean {
  switch (e.k) {
    case 'int':
      return e.v >= lo && e.v <= hi;
    case 'var':
      return true;
    case 'choose':
      return e.domain.k === 'name' && e.domain.name === 'Int_t';
    case 'if':
      return isConstInt(e.t, lo, hi) && isConstInt(e.e, lo, hi);
    default:
      return false;
  }
}

function isNull(e: A.Expr): boolean {
  return e.kind === 'Literal' && e.litKind === 'null';
}

export function parseIntLiteral(text: string): number | undefined {
  const clean = text.replace(/[lL]$/, '').replace(/_/g, '');
  const v = /^0[xX]/.test(clean) ? parseInt(clean.slice(2), 16) : /^0[0-7]+$/.test(clean) ? parseInt(clean, 8) : Number(clean);
  return Number.isFinite(v) ? v : undefined;
}

export function charCode(text: string): number {
  const inner = text.slice(1, -1);
  if (!inner.startsWith('\\')) return inner.codePointAt(0) ?? 0;
  const escapes: Record<string, number> = { n: 10, t: 9, r: 13, b: 8, f: 12, '0': 0, '\\': 92, "'": 39, '"': 34 };
  return escapes[inner[1]] ?? inner.codePointAt(1) ?? 0;
}

/** Whether evaluating the expression has an effect the model must sequence: a read, call, assignment or synchronisation. */
export function hasEffects(e: A.Expr): boolean {
  switch (e.kind) {
    case 'ChanRead':
    case 'ChanWrite':
    case 'Sync':
    case 'Timeout':
    case 'Invocation':
    case 'AssignExpr':
    case 'NewMobile':
      return true;
    case 'UnaryExpr':
      return e.op === '++' || e.op === '--' || hasEffects(e.operand);
    case 'ParenExpr':
    case 'CastExpr':
    case 'IsExpr':
      return hasEffects(e.expr);
    case 'BinaryExpr':
      return hasEffects(e.left) || hasEffects(e.right);
    case 'TernaryExpr':
      return hasEffects(e.cond) || hasEffects(e.then) || hasEffects(e.else);
    case 'RecordAccess':
    case 'ChanEnd':
      return hasEffects(e.target);
    case 'ArrayAccess':
      return hasEffects(e.target) || hasEffects(e.index);
    case 'NewArray':
      return e.dimExprs.some(hasEffects) || (!!e.init && hasEffects(e.init));
    case 'ArrayLiteral':
      return e.elements.some(hasEffects);
    case 'RecordLiteral':
    case 'ProtocolLiteral':
      return e.fields.some((f) => hasEffects(f.value));
    default:
      return false;
  }
}

/** Whether evaluating the expression can raise a modelled runtime error. */
export function mayFail(e: A.Expr): boolean {
  switch (e.kind) {
    case 'BinaryExpr':
      return e.op === '/' || e.op === '%' || mayFail(e.left) || mayFail(e.right);
    case 'ArrayAccess':
    case 'RecordAccess':
      return true;
    case 'ParenExpr':
    case 'CastExpr':
    case 'IsExpr':
      return mayFail(e.expr);
    case 'UnaryExpr':
      return mayFail(e.operand);
    case 'TernaryExpr':
      return mayFail(e.cond) || mayFail(e.then) || mayFail(e.else);
    case 'RecordLiteral':
    case 'ProtocolLiteral':
      return true;
    case 'NewArray':
      return true;
    default:
      return false;
  }
}

/** The constant step of a `for` update on the loop variable. */
function stepOf(v: VarInfo, update: A.Expr[], checked: CheckResult): number | undefined {
  if (update.length !== 1) return undefined;
  const u = update[0];
  const isVar = (x: A.Expr): boolean => x.kind === 'NameExpr' && checked.resolutions.get(x) === v;
  if (u.kind === 'UnaryExpr' && (u.op === '++' || u.op === '--') && isVar(u.operand)) return u.op === '++' ? 1 : -1;
  if (u.kind === 'AssignExpr' && isVar(u.target)) {
    const lit = (x: A.Expr): number | undefined => (x.kind === 'Literal' && x.litKind === 'int' ? parseIntLiteral(x.text) : undefined);
    if (u.op === '+=' || u.op === '-=') {
      const k = lit(u.value);
      return k === undefined ? undefined : u.op === '+=' ? k : -k;
    }
    if (u.op === '=' && u.value.kind === 'BinaryExpr' && isVar(u.value.left) && (u.value.op === '+' || u.value.op === '-')) {
      const k = lit(u.value.right);
      return k === undefined ? undefined : u.value.op === '+' ? k : -k;
    }
  }
  return undefined;
}

/** `i < n` (or `<=`, `>`, `>=`, `!=`) with the loop variable on the left. */
function boundOf(v: VarInfo, cond: A.Expr, checked: CheckResult): { op: '<' | '<=' | '>' | '>=' | '!='; expr: A.Expr } | undefined {
  while (cond.kind === 'ParenExpr') cond = cond.expr;
  if (cond.kind !== 'BinaryExpr') return undefined;
  const isVar = (x: A.Expr): boolean => x.kind === 'NameExpr' && checked.resolutions.get(x) === v;
  const flip: Record<string, '<' | '<=' | '>' | '>='> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=' };
  if (['<', '<=', '>', '>=', '!='].includes(cond.op)) {
    if (isVar(cond.left)) return { op: cond.op as '<', expr: cond.right };
    if (isVar(cond.right) && cond.op !== '!=') return { op: flip[cond.op], expr: cond.left };
  }
  return undefined;
}

/**
 * Whether a procedure assigns into a field or element of its parameter
 * `index`, itself or through a procedure it passes the parameter on to.
 */
function mutatesParameter(proc: ProcIR, index: number, procOf: (decl: A.ProcDecl) => ProcIR | undefined, seen = new Set<string>()): boolean {
  const key = `${proc.name}#${index}`;
  const param = proc.params[index]?.info;
  if (!param || seen.has(key)) return false;
  seen.add(key);
  const checked = proc.unit.checked;
  let found = false;
  const rootOf = (e: A.Expr): A.Expr => {
    while (e.kind === 'RecordAccess' || e.kind === 'ArrayAccess' || e.kind === 'ParenExpr') e = e.kind === 'ParenExpr' ? e.expr : e.target;
    return e;
  };
  const isParam = (e: A.Expr): boolean => {
    const root = rootOf(e);
    return root.kind === 'NameExpr' && checked.resolutions.get(root) === param;
  };
  const visitExpr = (e: A.Expr): void => {
    if (found) return;
    if (e.kind === 'AssignExpr' && (e.target.kind === 'RecordAccess' || e.target.kind === 'ArrayAccess') && isParam(e.target)) found = true;
    if (e.kind === 'Invocation') {
      const callee = checked.calls.get(e)?.decl;
      const ir = callee?.body ? procOf(callee) : undefined;
      if (ir) e.args.forEach((a, i) => {
        if (!found && isParam(a) && mutatesParameter(ir, i, procOf, seen)) found = true;
      });
    }
    forEachChildExpr(e, visitExpr);
  };
  forEachExprInStmt(proc.decl.body, visitExpr);
  return found;
}

export function forEachChildExpr(e: A.Expr, visit: (e: A.Expr) => void): void {
  switch (e.kind) {
    case 'ParenExpr':
    case 'CastExpr':
    case 'IsExpr':
      visit(e.expr);
      return;
    case 'BinaryExpr':
      visit(e.left);
      visit(e.right);
      return;
    case 'UnaryExpr':
      visit(e.operand);
      return;
    case 'AssignExpr':
      visit(e.target);
      visit(e.value);
      return;
    case 'TernaryExpr':
      visit(e.cond);
      visit(e.then);
      visit(e.else);
      return;
    case 'Invocation':
      if (e.target) visit(e.target);
      e.args.forEach(visit);
      return;
    case 'RecordAccess':
    case 'ChanEnd':
      visit(e.target);
      return;
    case 'ArrayAccess':
      visit(e.target);
      visit(e.index);
      return;
    case 'ChanRead':
      visit(e.target);
      return;
    case 'ChanWrite':
      visit(e.target);
      visit(e.value);
      return;
    case 'Sync':
      visit(e.target);
      return;
    case 'Timeout':
      visit(e.target);
      visit(e.delay);
      return;
    case 'NewArray':
      e.dimExprs.forEach(visit);
      if (e.init) visit(e.init);
      return;
    case 'ArrayLiteral':
      e.elements.forEach(visit);
      return;
    case 'RecordLiteral':
    case 'ProtocolLiteral':
      e.fields.forEach((f) => visit(f.value));
      return;
    default:
      return;
  }
}

/** Child statements, for walks that do not care about order. */
export function forEachChildStmt(s: A.Stmt, visit: (s: A.Stmt | undefined) => void): void {
  switch (s.kind) {
    case 'Block':
      s.stmts.forEach(visit);
      return;
    case 'IfStmt':
      visit(s.then);
      visit(s.else);
      return;
    case 'WhileStmt':
    case 'DoStmt':
      visit(s.body);
      return;
    case 'ForStmt':
      if (s.init && !Array.isArray(s.init)) visit(s.init);
      visit(s.body);
      return;
    case 'ParBlock':
    case 'SeqBlock':
      visit(s.body);
      return;
    case 'ClaimStmt':
      visit(s.body);
      return;
    case 'SwitchStmt':
      for (const g of s.groups) g.stmts.forEach(visit);
      return;
    case 'AltStmt':
      for (const c of s.cases) {
        if (c.nested) visit(c.nested);
        visit(c.body);
        if (c.guard?.kind === 'ReadGuard' && c.guard.read.extended) visit(c.guard.read.extended);
      }
      return;
    case 'LabeledStmt':
      visit(s.stmt);
      return;
    case 'ExprStmt':
    case 'LocalDecl': {
      // Extended rendezvous blocks can declare things too.
      const exprs: A.Expr[] = s.kind === 'ExprStmt' ? [s.expr] : s.declarators.flatMap((d) => (d.init ? [d.init] : []));
      const walk = (e: A.Expr): void => {
        if (e.kind === 'ChanRead' && e.extended) visit(e.extended);
        forEachChildExpr(e, walk);
      };
      exprs.forEach(walk);
      return;
    }
    default:
      return;
  }
}

/** Visit every expression of a statement tree (including extended-rendezvous blocks). */
export function forEachExprInStmt(s: A.Stmt | undefined, visit: (e: A.Expr) => void): void {
  if (!s) return;
  const stmt = (x: A.Stmt | undefined): void => forEachExprInStmt(x, visit);
  const expr = (e: A.Expr): void => {
    visit(e);
    if (e.kind === 'ChanRead' && e.extended) stmt(e.extended);
  };
  switch (s.kind) {
    case 'Block':
      s.stmts.forEach(stmt);
      return;
    case 'LocalDecl':
      for (const d of s.declarators) if (d.init) expr(d.init);
      return;
    case 'ExprStmt':
      expr(s.expr);
      return;
    case 'IfStmt':
      expr(s.cond);
      stmt(s.then);
      stmt(s.else);
      return;
    case 'WhileStmt':
    case 'DoStmt':
      expr(s.cond);
      stmt(s.body);
      return;
    case 'ForStmt':
      if (s.init) Array.isArray(s.init) ? s.init.forEach(expr) : stmt(s.init);
      if (s.cond) expr(s.cond);
      s.update.forEach(expr);
      s.enroll.forEach(expr);
      stmt(s.body);
      return;
    case 'ParBlock':
      s.barriers.forEach(expr);
      stmt(s.body);
      return;
    case 'SeqBlock':
      stmt(s.body);
      return;
    case 'ClaimStmt':
      for (const c of s.channels) c.kind === 'LocalDecl' ? stmt(c) : expr(c);
      stmt(s.body);
      return;
    case 'SwitchStmt':
      expr(s.expr);
      for (const g of s.groups) {
        for (const l of g.labels) if (l) expr(l);
        g.stmts.forEach(stmt);
      }
      return;
    case 'AltStmt':
      for (const c of s.cases) {
        if (c.precondition) expr(c.precondition);
        if (c.guard?.kind === 'ReadGuard') {
          expr(c.guard.target);
          expr(c.guard.read);
        } else if (c.guard?.kind === 'TimeoutGuard') expr(c.guard.timeout);
        if (c.nested) stmt(c.nested);
        stmt(c.body);
      }
      return;
    case 'ReturnStmt':
      if (s.expr) expr(s.expr);
      return;
    case 'LabeledStmt':
      stmt(s.stmt);
      return;
    default:
      return;
  }
}

export function exprText(e: A.Expr): string {
  switch (e.kind) {
    case 'NameExpr':
      return e.name.name;
    case 'Literal':
      return e.text;
    case 'ParenExpr':
      return `(${exprText(e.expr)})`;
    case 'RecordAccess':
      return `${exprText(e.target)}.${e.member.name}`;
    case 'ArrayAccess':
      return `${exprText(e.target)}[${exprText(e.index)}]`;
    case 'ChanEnd':
      return `${exprText(e.target)}.${e.end}`;
    case 'BinaryExpr':
      return `${exprText(e.left)} ${e.op} ${exprText(e.right)}`;
    case 'UnaryExpr':
      return e.prefix ? `${e.op}${exprText(e.operand)}` : `${exprText(e.operand)}${e.op}`;
    case 'Invocation':
      return `${e.name.name}(${e.args.map(exprText).join(', ')})`;
    default:
      return e.kind;
  }
}

function typeText(t: Type): string {
  if (t.k === 'chan') return typeText(t.elem);
  if (t.k === 'prim') return t.name;
  if (t.k === 'record' || t.k === 'protocol') return t.name;
  if (t.k === 'array') return `${typeText(t.elem)}${'[]'.repeat(t.dims)}`;
  return '?';
}

/** Variables a node reads (uses) and writes (defs), by CSPm name. Region-level facts (par inputs) are added by liveness. */
export function nodeUses(n: Node): Set<string> {
  const out = new Set<string>();
  const add = (e: Ex | undefined): void => {
    if (e) freeVars(e, out);
  };
  const chan = (c: ChanUse): void => {
    add(c.ch);
    add(c.ack);
    add(c.take);
    add(c.done);
    add(c.len);
  };
  switch (n.k) {
    case 'assign':
      add(n.e);
      break;
    case 'check':
      add(n.ok);
      break;
    case 'branch':
      add(n.c);
      break;
    case 'write':
      chan(n.ch);
      add(n.e);
      break;
    case 'read':
      chan(n.ch);
      break;
    case 'ack':
      chan(n.ch);
      break;
    case 'sync':
      add(n.b);
      break;
    case 'alt':
      for (const c of n.cases) {
        add(c.pre);
        if (c.guard.k === 'read') chan(c.guard.ch);
      }
      if (n.replicated) add(n.replicated.set);
      break;
    case 'par':
      for (const b of n.par.enroll) add(b.b);
      if (n.par.iter?.lo) add(n.par.iter.lo);
      if (n.par.iter?.hi) add(n.par.iter.hi);
      break;
    case 'call':
      for (const a of n.call.args) {
        add(a.value);
        add(a.barrier);
        if (a.chan) chan(a.chan);
      }
      break;
    case 'return':
      add(n.e);
      break;
    default:
      break;
  }
  return out;
}

/** How many dimensions of channels an array type has (`chan<int>[][]` is 2); 0 for anything else. */
export function chanArrayDims(t: DType): number {
  let dims = 0;
  while (t.k === 'array') {
    dims++;
    t = t.elem;
  }
  return t.k === 'chan' ? dims : 0;
}

/** Whether an expression mentions a variable. */
function mentions(e: A.Expr, info: VarInfo, checked: CheckResult): boolean {
  let found = false;
  const visit = (x: A.Expr): void => {
    if (found) return;
    if (x.kind === 'NameExpr' && checked.resolutions.get(x) === info) found = true;
    forEachChildExpr(x, visit);
  };
  visit(e);
  return found;
}

export function nodeSuccessors(n: Node): number[] {
  switch (n.k) {
    case 'branch':
      return [n.t, n.f];
    case 'alt':
      return n.cases.map((c) => c.body);
    case 'return':
    case 'end':
    case 'stop':
    case 'error':
      return [];
    default:
      return n.next >= 0 ? [n.next] : [];
  }
}

/** Whether a node performs at least one event every time it runs (so a loop through it never spins silently). */
export function isEventNode(n: Node): boolean {
  return n.k === 'write' || n.k === 'read' || n.k === 'ack' || n.k === 'sync' || n.k === 'alt' || n.k === 'par' || n.k === 'tick';
}
