/**
 * The process network of a ProcessJ program, drawn the way CSP and occam users
 * draw one by hand: processes are boxes, a channel is an arrow from the process
 * that writes it to the process that reads it, a par is a container of its
 * branches, and a barrier is a node joined to the processes enrolled on it.
 *
 * A view is elaborated from one root procedure: `main` for the whole program,
 * and every procedure on its own with its channel and barrier parameters as
 * boundary ports. A process that calls a procedure with a network of its own
 * (a par inside) is expanded in place, the callee's parameters bound to the
 * caller's channels, so an arrow always joins the processes that really
 * communicate. A callee without a par stays one box; what it reads and writes
 * comes from its transitive parameter uses.
 *
 * Identity follows src/verification.ts exactly: every process node carries its
 * spawn-site path, every channel its declarator and owner instance, and every
 * operation its statement span, so verification results from the checker or
 * from FDR land on the box and the arrow they are about. Uncertainty keeps the
 * repository's vocabulary: an operation is `exact` when it runs whenever its
 * process gets there, `conditional` under an if, a loop that may not run, a
 * switch or an alt alternative, and `unknown` through opaque code.
 */
import type * as A from '../parser/ast';
import type { CheckResult, VarInfo } from '../checker/checker';
import { directlyTransfersControl } from '../checker/controlflow';
import type { ProcedureEffectSummary } from '../checker/effects';
import type { DeclIndex, ProcSig } from '../checker/index';
import { typeStr } from '../checker/types';
import { pathMatches, samePath, type ChannelRef, type ProcessPath, type SourceRef, type SpawnSite } from '../verification';

export type Confidence = 'exact' | 'conditional' | 'unknown';

export interface NetworkModel {
  version: 1;
  generator: 'processj-lsp';
  uri: string;
  /** File name shown in titles. */
  title: string;
  views: NetworkView[];
  /** The program view when there is a `main`, else the first procedure that communicates. */
  defaultView: string;
  /** The language the network was drawn from: ProcessJ (when absent) or a CSPm file (src/cspm/network.ts). */
  language?: 'processj' | 'cspm';
}

export interface NetworkView {
  id: string;
  kind: 'program' | 'procedure';
  /** Root procedure name. */
  procedure: string;
  /** `main (whole program)`, `delta(in, out1, out2)`. */
  label: string;
  source: SourceRef;
  nodes: NetNode[];
  edges: NetEdge[];
  channels: NetChannel[];
  /** Facts about the view that are not drawn: unused channels, collapsed expansions. */
  notes: string[];
  /** Procedures expanded in this view, so a result about one procedure can be placed on each instance. */
  instances: NetInstance[];
  /** The heading the viewer lists the view under, when not the ProcessJ default (a CSPm file: `Asserted`, `Defined`). */
  section?: string;
  /** Drawn from a CSPm file: boxes are processes, arrows are the events they share (src/cspm/network.ts). */
  language?: 'cspm';
}

/** One expanded call: the callee's root process is `prefix`; its spawned processes start with `spawn`. */
export interface NetInstance {
  procedure: string;
  declaration: SourceRef;
  /** Process running the callee's own code. */
  prefix: ProcessPath;
  /** Prefix of every process the callee spawns (`prefix` plus the call step). */
  spawn: ProcessPath;
  /** The drawn container of the callee's processes. */
  node: string;
}

export type NetNodeKind = 'process' | 'group' | 'junction' | 'barrier' | 'port' | 'stub';

export interface NetNode {
  id: string;
  kind: NetNodeKind;
  /** Containing group. */
  parent?: string;
  /** What the box shows: the call (`delta(d, a, b)`) or the code of an inline branch (`c.write(1)`). */
  label: string;
  /** How results and explanations name the process: the call, or `branch 2`. */
  name: string;
  /** Second line of a process box: what an inline branch does next, or what a group runs. */
  detail?: string;
  /** Small kind badge: `proc`, `call`, `branch 2`, `par`, `par for`, `stmt 3`. */
  badge?: string;
  source?: SourceRef;
  confidence: Confidence;
  /** Spawn-site path of the process this box is; groups that are only containers have none. */
  path?: ProcessPath;
  /** Procedure whose code the process runs, when it is a call. */
  procedure?: string;
  call?: NetCall;
  /** A `par for` instance: drawn once, stands for `count` (or N) processes. */
  replicated?: { count?: number; text: string };
  /** A par for box that only holds its body's statements, each its own process in every iteration. */
  statements?: number;
  /** The `own code` box of a container: the operations of the container's process itself. */
  own?: boolean;
  /** Styling of a group: the procedure root, a par container, a replicated body, an expanded call, a branch running a par. */
  group?: 'procedure' | 'par' | 'par-for' | 'call' | 'branch';
  /** `index`: one channel of a channel-array parameter. */
  port?: { parameter: number; name: string; direction: 'in' | 'out' | 'sync' | 'unknown'; type: string; index?: number };
  /** A dangling side of a channel. */
  stub?: { side: 'no-writer' | 'no-reader'; proven: boolean };
  /** Barrier or channel this node stands for (barrier nodes, junctions, ports, stubs). */
  channel?: string;
  /** Plain facts for the details panel: effects, timers, compiler notes. */
  facts: string[];
  /** Every channel and barrier operation this box performs itself, with its source span. */
  operations: NetOperation[];
}

export interface NetCall {
  procedure: string;
  /** The call as written, shortened. */
  text: string;
  declaration?: SourceRef;
  /** Why the callee's own network is not drawn here. */
  collapsed?: 'depth' | 'recursion' | 'budget' | 'unavailable';
  /** Parameter names, for the details panel. */
  params: string[];
}

export type OperationKind = 'read' | 'write' | 'alt-guard' | 'extended-read' | 'sync' | 'pass';

export interface NetOperation {
  kind: OperationKind;
  /** NetChannel id. */
  channel: string;
  at: SourceRef;
  confidence: Confidence;
  /** The operation is inside this callee (a leaf call), reached through `parameter`. */
  via?: { procedure: string; parameter: string };
}

export interface NetChannel {
  id: string;
  kind: 'channel' | 'barrier';
  ref: ChannelRef;
  name: string;
  /** Element type for channels (`long`), `barrier` for barriers. */
  type: string;
  shared: { read: boolean; write: boolean };
  /** Group of the procedure instance that declared it. */
  container?: string;
  /** Boundary port standing for the environment, in a procedure view. */
  port?: string;
  writers: NetEndpoint[];
  readers: NetEndpoint[];
  /** Barriers: every process enrolled on it or syncing on it. */
  members: NetEndpoint[];
  /** The checker's proven hazard for this declaration, if any. */
  hazard?: 'no-writer' | 'no-reader' | 'self-deadlock';
  /** Drawn edges of this channel, in order. */
  edges: string[];
  junction?: string;
  stub?: string;
}

export interface NetEndpoint {
  node: string;
  confidence: Confidence;
  operations: NetOperation[];
  /** `alt` (only read in alt guards), `extended`, `enrolled`, `sync`, `via call`. */
  tags: string[];
}

export interface NetEdge {
  id: string;
  kind: 'channel' | 'barrier';
  from: string;
  to: string;
  channel: string;
  /** Shown once per channel: on the direct edge, or on the junction. */
  label?: string;
  confidence: Confidence;
  /** writer -> reader, writer -> junction, junction -> reader, a dangling stub, a barrier link. */
  role: 'direct' | 'fan-in' | 'fan-out' | 'dangling' | 'self' | 'barrier';
  tags: string[];
}

/** The part of an effect summary the network uses to cross-check its parameter uses. */
export type NetworkEffectSummary = Pick<ProcedureEffectSummary, 'decl' | 'transitive'>;

export interface NetworkUnit {
  checked: CheckResult;
  /** LSP URI of the file the declarations come from. */
  uri: string;
  text?: string;
}

export interface NetworkOptions {
  /** LSP URI of the document. */
  uri: string;
  /** Document text, for short labels. */
  text?: string;
  /** File name for titles (defaults to the last URI segment). */
  title?: string;
  effects?: ReadonlyMap<A.ProcDecl, NetworkEffectSummary>;
  /** Checker results of other files, so a callee declared there can be expanded. */
  unitFor?: (decl: A.ProcDecl) => NetworkUnit | undefined;
  /** Constants for par for counts. */
  index?: DeclIndex;
  /** Deepest chain of expanded calls (default 4). */
  maxDepth?: number;
  /** Processes per view before deeper expansions are collapsed (default 100). */
  maxProcesses?: number;
  /** Build only these views (`program` and/or procedure names); all by default. */
  only?: readonly string[];
  /**
   * The arguments a procedure's own view is drawn with: those its data
   * parameters take in every instance FDR checks it with (they decide its
   * network: recursion depth, channel-array lengths, par for counts), and
   * the length of each channel-array parameter, whose channels are then
   * ports of their own (CheckedWith in src/csp/model.ts).
   */
  procedureArguments?: (decl: A.ProcDecl) => ProcedureArguments | undefined;
}

/** Values by parameter name; `arrays`: channel-array parameters by their length. */
export interface ProcedureArguments {
  values: Readonly<Record<string, number | boolean>>;
  arrays: Readonly<Record<string, number>>;
  /** Said in the view's notes: `size = 6 (the call at line 75)`. */
  text?: string;
}

const CONFIDENCE_RANK: Record<Confidence, number> = { exact: 0, conditional: 1, unknown: 2 };

/** Compose evidence without ever upgrading a less-certain path. */
export function combineConfidence(left: Confidence, right: Confidence): Confidence {
  return CONFIDENCE_RANK[left] >= CONFIDENCE_RANK[right] ? left : right;
}

/** The more certain of two pieces of evidence for the same fact. */
export function bestConfidence(left: Confidence, right: Confidence): Confidence {
  return CONFIDENCE_RANK[left] <= CONFIDENCE_RANK[right] ? left : right;
}

/** Spawn step of the `index`-th (1-based) branch of a par. */
export function branchStep(statement: A.Stmt, index: number, uri: string): SpawnSite {
  return { kind: 'branch', site: { uri, span: statement.span }, index };
}

/** Spawn step of a par for, drawn once for every iteration. */
export function parForStep(statement: A.ForStmt, uri: string): SpawnSite {
  return { kind: 'par-for', site: { uri, span: statement.span } };
}

/** Spawn step of a call passed through on the way to a par. */
export function callStep(call: A.Invocation, uri: string): SpawnSite {
  return { kind: 'call', site: { uri, span: call.span } };
}

/** Build every view of one checked program. */
export function buildNetwork(program: A.Program, checked: CheckResult, options: NetworkOptions): NetworkModel {
  const title = options.title ?? decodeURIComponent(options.uri.replace(/[?#].*$/, '').split('/').pop() ?? 'program');
  const procedures = program.decls.filter((decl): decl is A.ProcDecl => decl.kind === 'ProcDecl' && !!decl.body);
  const rootUnit: NetworkUnit = { checked, uri: options.uri, text: options.text };
  const rootDecls = new Set(program.decls.filter((decl): decl is A.ProcDecl => decl.kind === 'ProcDecl'));
  const shared = new SharedAnalysis(rootUnit, rootDecls, options);
  const views: NetworkView[] = [];
  const main = procedures.find((decl) => decl.name.name === 'main');
  const wanted = (name: string): boolean => !options.only || options.only.includes(name);
  if (main && wanted('program')) views.push(buildView(main, 'program', shared, options));
  for (const decl of procedures) {
    if (decl === main || !wanted(decl.name.name)) continue;
    views.push(buildView(decl, 'procedure', shared, options));
  }
  const communicating = views.find((view) => view.kind === 'program') ?? views.find((view) => view.edges.length > 0) ?? views[0];
  return { version: 1, generator: 'processj-lsp', uri: options.uri, title, views, defaultView: communicating?.id ?? '' };
}

/** A view known by name before it is built: what a list of views needs. */
export type NetworkViewStub = Pick<NetworkView, 'id' | 'kind' | 'procedure' | 'label' | 'source' | 'notes' | 'section' | 'language'>;

/**
 * Every view a program has, without elaborating any: the program view when
 * there is a `main`, then each procedure with a body, in source order. Ids and
 * labels are the ones `buildNetwork` gives them.
 */
export function networkViewStubs(program: A.Program, uri: string): NetworkViewStub[] {
  const procedures = program.decls.filter((decl): decl is A.ProcDecl => decl.kind === 'ProcDecl' && !!decl.body);
  const main = procedures.find((decl) => decl.name.name === 'main');
  const stub = (decl: A.ProcDecl, kind: NetworkView['kind']): NetworkViewStub => ({
    id: viewIdOf(decl, kind),
    kind,
    procedure: decl.name.name,
    label: kind === 'program' ? `${decl.name.name} (whole program)` : shortSignature(decl),
    source: { uri, span: decl.name.span },
    notes: [],
  });
  return [...(main ? [stub(main, 'program')] : []), ...procedures.filter((decl) => decl !== main).map((decl) => stub(decl, 'procedure'))];
}

function viewIdOf(decl: A.ProcDecl, kind: NetworkView['kind']): string {
  return kind === 'program' ? 'view:program' : `view:${decl.name.name}:${decl.name.span.start.line}:${decl.name.span.start.col}`;
}

/**
 * Processes a view holds at most, whatever the expansion depth: a program
 * with more (thousands of explicit par branches) is not drawn, since the
 * layout and the page could not cope with it.
 */
export const MAX_VIEW_PROCESSES = 1000;

/** Thrown by an elaboration as soon as it passes its process limit, before it builds more. */
class ViewTooLarge extends Error {}

/** One view, shrinking the expansion depth until it fits the process budget. */
function buildView(decl: A.ProcDecl, kind: NetworkView['kind'], shared: SharedAnalysis, options: NetworkOptions): NetworkView {
  const budget = options.maxProcesses ?? 100;
  let depth = options.maxDepth ?? 4;
  for (;;) {
    // A depth that passes the budget is given up as soon as it does; at depth 0 only the hard limit stops it.
    const limit = depth === 0 ? Math.max(budget, MAX_VIEW_PROCESSES) : budget;
    const elaborator = new Elaborator(shared, depth, limit);
    let view: NetworkView;
    try {
      view = elaborator.view(decl, kind);
    } catch (error) {
      if (!(error instanceof ViewTooLarge)) throw error;
      if (depth > 0) {
        depth--;
        continue;
      }
      return new Elaborator(shared, 0, limit).tooLarge(decl, kind);
    }
    if (elaborator.processCount <= budget || depth === 0) {
      if (elaborator.processCount > budget) view.notes.push(`This view has ${elaborator.processCount} processes; calls are not expanded.`);
      else if (depth < (options.maxDepth ?? 4) && elaborator.collapsedForDepth) view.notes.push(`Calls nested deeper than ${depth} level${depth === 1 ? '' : 's'} are collapsed to keep the view readable; open the procedure's own view for its network.`);
      return view;
    }
    depth--;
  }
}

// ---------------------------------------------------------------------------
// Parameter uses: what a procedure does with each channel and barrier parameter
// ---------------------------------------------------------------------------

interface ParamUse {
  kind: OperationKind;
  at: SourceRef;
  confidence: Confidence;
  /** Innermost callee the operation was written in, when it is not this procedure. */
  via?: { procedure: string; parameter: string };
}

/** Per-file facts shared by every view: units, parameter uses, constants. */
class SharedAnalysis {
  private readonly paramUseCache = new Map<A.ProcDecl, ParamUse[][]>();
  private readonly inProgress = new Set<A.ProcDecl>();
  private readonly linesByUri = new Map<string, string[]>();

  constructor(readonly root: NetworkUnit, private readonly rootDecls: ReadonlySet<A.ProcDecl>, readonly options: NetworkOptions) {
    if (root.text !== undefined) this.linesByUri.set(root.uri, root.text.split(/\r\n|\r|\n/));
  }

  /** The checker result that resolved the names in this declaration's body. */
  unitOf(decl: A.ProcDecl): NetworkUnit | undefined {
    if (this.rootDecls.has(decl)) return this.root;
    const unit = this.options.unitFor?.(decl);
    if (unit?.text !== undefined && !this.linesByUri.has(unit.uri)) this.linesByUri.set(unit.uri, unit.text.split(/\r\n|\r|\n/));
    return unit;
  }

  variableByDecl(unit: NetworkUnit, name: A.Ident): VarInfo | undefined {
    return variableIndex(unit.checked).get(name);
  }

  /** Source text of a span, when the file's text is known and the span is on one line. */
  sourceText(uri: string, span: A.Span): string | undefined {
    const lines = this.linesByUri.get(uri);
    if (!lines) return undefined;
    if (span.start.line === span.end.line) return lines[span.start.line]?.slice(span.start.col, span.end.col);
    const first = lines[span.start.line]?.slice(span.start.col);
    return first === undefined ? undefined : `${first.trimEnd()} …`;
  }

  /** What each parameter of `decl` is used for, through every call in its body. */
  paramUses(decl: A.ProcDecl): ParamUse[][] {
    const cached = this.paramUseCache.get(decl);
    if (cached) return cached;
    const empty = decl.params.map((): ParamUse[] => []);
    const unit = this.unitOf(decl);
    if (!decl.body || !unit || this.inProgress.has(decl)) return this.summaryUses(decl, empty, unit);
    this.inProgress.add(decl);
    const uses = decl.params.map((): ParamUse[] => []);
    const paramIndex = new Map<VarInfo, number>();
    for (const variable of unit.checked.vars) {
      if (!variable.isParam) continue;
      const index = decl.params.findIndex((param) => param.name === variable.decl);
      if (index >= 0) paramIndex.set(variable, index);
    }
    const originOf = (target: A.Expr): number | undefined => {
      const root = rootName(target);
      const variable = root ? unit.checked.resolutions.get(root) : undefined;
      return variable ? paramIndex.get(variable) : undefined;
    };
    const add = (index: number | undefined, use: ParamUse): void => {
      if (index === undefined) return;
      uses[index].push(use);
    };
    const walker = new CodeWalker(this, unit, {
      read: (target, kind, at, confidence) => add(originOf(target), { kind, at, confidence }),
      write: (target, at, confidence) => add(originOf(target), { kind: 'write', at, confidence }),
      sync: (target, at, confidence) => add(originOf(target), { kind: 'sync', at, confidence }),
      call: (call, confidence) => {
        const selected = unit.checked.calls.get(call);
        const callee = selected?.decl;
        call.args.forEach((arg, argIndex) => {
          const origin = originOf(arg);
          if (origin === undefined) return;
          if (!callee?.body) {
            // An end handed to opaque code: it may be used either way.
            add(origin, { kind: 'pass', at: { uri: unit.uri, span: arg.span }, confidence: 'unknown' });
            return;
          }
          for (const use of this.paramUses(callee)[argIndex] ?? []) {
            add(origin, { ...use, confidence: combineConfidence(use.confidence, confidence), via: use.via ?? { procedure: callee.name.name, parameter: callee.params[argIndex]?.name.name ?? `#${argIndex + 1}` } });
          }
        });
      },
    });
    walker.walkBlock(decl.body, 'exact', new Map());
    this.inProgress.delete(decl);
    const result = this.summaryUses(decl, uses, unit);
    this.paramUseCache.set(decl, result);
    return result;
  }

  /** Add what the effect summary knows but the syntactic walk could not see (aliases, opaque calls). */
  private summaryUses(decl: A.ProcDecl, uses: ParamUse[][], unit: NetworkUnit | undefined): ParamUse[][] {
    const summary = this.options.effects?.get(decl);
    if (!summary) return uses;
    const at: SourceRef = { uri: unit?.uri ?? this.root.uri, span: decl.name.span };
    const confidence: Confidence = summary.transitive.confidence === 'exact' ? 'conditional' : 'unknown';
    for (const index of summary.transitive.channelReads) {
      if (uses[index] && !uses[index].some((use) => use.kind === 'read' || use.kind === 'alt-guard' || use.kind === 'extended-read' || use.kind === 'pass')) uses[index].push({ kind: 'read', at, confidence });
    }
    for (const index of summary.transitive.channelWrites) {
      if (uses[index] && !uses[index].some((use) => use.kind === 'write' || use.kind === 'pass')) uses[index].push({ kind: 'write', at, confidence });
    }
    return uses;
  }

  /** Integer or boolean value of a constant expression, with `env` for locals known at this point. */
  constant(expr: A.Expr, unit: NetworkUnit, env: ReadonlyMap<VarInfo, ConstValue>, depth = 0): ConstValue | undefined {
    if (depth > 32) return undefined;
    switch (expr.kind) {
      case 'Literal':
        if (expr.litKind === 'boolean') return expr.text === 'true';
        if (expr.litKind === 'int' || expr.litKind === 'long') {
          const text = expr.text.replace(/[lL]$/, '');
          const value = /^0[xX]/.test(text) ? Number.parseInt(text.slice(2), 16) : /^0[0-7]+$/.test(text) ? Number.parseInt(text, 8) : Number(text);
          return Number.isSafeInteger(value) ? value : undefined;
        }
        if (expr.litKind === 'char' && /^'.'$/.test(expr.text)) return expr.text.charCodeAt(1);
        return undefined;
      case 'ParenExpr':
        return this.constant(expr.expr, unit, env, depth + 1);
      case 'NameExpr': {
        const variable = unit.checked.resolutions.get(expr);
        if (variable) return env.get(variable);
        const info = this.options.index?.consts.get(expr.name.name);
        const declarator = info?.decl.declarators.find((entry) => entry.name.name === expr.name.name);
        return declarator?.init ? this.constant(declarator.init, unit, new Map(), depth + 1) : undefined;
      }
      case 'UnaryExpr': {
        if (!expr.prefix) return undefined;
        const value = this.constant(expr.operand, unit, env, depth + 1);
        if (value === undefined) return undefined;
        if (expr.op === '!' && typeof value === 'boolean') return !value;
        if (expr.op === '-' && typeof value === 'number') return -value;
        if (expr.op === '+' && typeof value === 'number') return value;
        return undefined;
      }
      case 'BinaryExpr': {
        const left = this.constant(expr.left, unit, env, depth + 1);
        if (left === undefined) return undefined;
        if (expr.op === '&&' && left === false) return false;
        if (expr.op === '||' && left === true) return true;
        const right = this.constant(expr.right, unit, env, depth + 1);
        if (right === undefined) return undefined;
        return binary(expr.op, left, right);
      }
      default:
        return undefined;
    }
  }
}

type ConstValue = number | boolean;

function binary(op: string, left: ConstValue, right: ConstValue): ConstValue | undefined {
  if (typeof left === 'boolean' || typeof right === 'boolean') {
    if (typeof left !== 'boolean' || typeof right !== 'boolean') return undefined;
    switch (op) {
      case '&&': return left && right;
      case '||': return left || right;
      case '==': return left === right;
      case '!=': return left !== right;
      default: return undefined;
    }
  }
  switch (op) {
    case '+': return checkedInteger(left + right);
    case '-': return checkedInteger(left - right);
    case '*': return checkedInteger(left * right);
    case '/': return right === 0 ? undefined : Math.trunc(left / right);
    case '%': return right === 0 ? undefined : left % right;
    case '<': return left < right;
    case '<=': return left <= right;
    case '>': return left > right;
    case '>=': return left >= right;
    case '==': return left === right;
    case '!=': return left !== right;
    default: return undefined;
  }
}

function checkedInteger(value: number): number | undefined {
  return Number.isSafeInteger(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// Code walking with reach confidence and a constant environment
// ---------------------------------------------------------------------------

interface CodeHandlers {
  /** `env`: the constants known where the operation runs (an index into a channel array, a call's arguments). */
  read(target: A.Expr, kind: 'read' | 'alt-guard' | 'extended-read', at: SourceRef, confidence: Confidence, env: ReadonlyMap<VarInfo, ConstValue>): void;
  write(target: A.Expr, at: SourceRef, confidence: Confidence, env: ReadonlyMap<VarInfo, ConstValue>): void;
  sync(target: A.Expr, at: SourceRef, confidence: Confidence, env: ReadonlyMap<VarInfo, ConstValue>): void;
  call(call: A.Invocation, confidence: Confidence, env: ReadonlyMap<VarInfo, ConstValue>): void;
  /** A par or par for reached in this code; return true when the handler elaborates it (its body is then not walked). */
  spawn?(statement: A.ParBlock | A.ForStmt, confidence: Confidence, env: Map<VarInfo, ConstValue>): boolean;
  timer?(at: SourceRef): void;
}

/**
 * Walks the executable code of one procedure body (or one process), reporting
 * every channel operation with how certainly it runs. Loops whose first test is
 * a known `true` (`while (true)`, `long l = 0; while (l < 9)`) run their body
 * at least once, so their operations stay exact. A statement that may leave its
 * block early (`if (k > 3) return;`, a `break` or `continue` under a condition)
 * or a loop that only a `break` ends makes everything after it conditional.
 */
class CodeWalker {
  constructor(private readonly shared: SharedAnalysis, private readonly unit: NetworkUnit, private readonly on: CodeHandlers) {}

  walkBlock(block: A.Block, confidence: Confidence, env: Map<VarInfo, ConstValue>): void {
    this.walkList(block.stmts, confidence, env);
  }

  walkList(statements: readonly A.Stmt[], confidence: Confidence, env: Map<VarInfo, ConstValue>): void {
    let current = confidence;
    for (const statement of statements) {
      // Judged with the constants known before the statement runs.
      const leaves = this.mayLeave(statement, env);
      this.statement(statement, current, env);
      // A direct return, break, continue or stop: nothing after it in this block runs.
      if (directlyTransfersControl(statement)) return;
      if (leaves) current = combineConfidence(current, 'conditional');
    }
  }

  /** Whether control may not come out of `statement` into the next one: an early exit, or a loop only a break ends. */
  private mayLeave(statement: A.Stmt, env: ReadonlyMap<VarInfo, ConstValue>): boolean {
    if (statement.kind === 'IfStmt') {
      const test = this.shared.constant(statement.cond, this.unit, env);
      return (test !== false && leavesStatement(statement.then)) || (test !== true && !!statement.else && leavesStatement(statement.else));
    }
    // `outer: while (true)` ends only through a break, like the bare loop; `break outer` itself lands after it.
    return this.endless(statement.kind === 'LabeledStmt' ? statement.stmt : statement, env) || leavesStatement(statement);
  }

  /** A sequential loop whose condition stays `true`: constant, or built only from locals the loop never assigns. */
  private endless(loop: A.Stmt, env: ReadonlyMap<VarInfo, ConstValue>): boolean {
    const cond = loop.kind === 'WhileStmt' || loop.kind === 'DoStmt' ? loop.cond : loop.kind === 'ForStmt' && !loop.isPar ? loop.cond ?? true : undefined;
    if (cond === undefined) return false;
    if (cond === true) return true;
    const assigned = assignedVariables(loop, this.unit.checked);
    const steady = new Map([...env].filter(([variable]) => !assigned.has(variable)));
    return this.shared.constant(cond, this.unit, steady) === true;
  }

  statement(statement: A.Stmt, confidence: Confidence, env: Map<VarInfo, ConstValue>): void {
    switch (statement.kind) {
      case 'Block':
        return this.walkBlock(statement, confidence, env);
      case 'LocalDecl':
        for (const declarator of statement.declarators) {
          if (declarator.init) this.expression(declarator.init, confidence, env);
          const variable = this.variableOf(declarator.name);
          if (!variable) continue;
          const value = declarator.init ? this.shared.constant(declarator.init, this.unit, env) : undefined;
          if (value === undefined) env.delete(variable);
          else env.set(variable, value);
        }
        return;
      case 'ExprStmt':
        this.expression(statement.expr, confidence, env);
        this.assignEffect(statement.expr, env);
        return;
      case 'IfStmt': {
        this.expression(statement.cond, confidence, env);
        const test = this.shared.constant(statement.cond, this.unit, env);
        const branches: Array<[A.Stmt | undefined, boolean]> = [[statement.then, test !== false], [statement.else, test !== true]];
        const conditional = combineConfidence(confidence, test === undefined ? 'conditional' : 'exact');
        for (const [branch, runs] of branches) {
          if (!branch || !runs) continue;
          this.statement(branch, conditional, new Map(env));
        }
        this.forget(statement, env);
        return;
      }
      case 'WhileStmt': {
        this.expression(statement.cond, confidence, env);
        const first = this.shared.constant(statement.cond, this.unit, env);
        this.forget(statement, env);
        if (first !== false) this.statement(statement.body, combineConfidence(confidence, first === true ? 'exact' : 'conditional'), new Map(env));
        this.forget(statement, env);
        return;
      }
      case 'DoStmt':
        this.statement(statement.body, confidence, new Map(env));
        this.forget(statement, env);
        this.expression(statement.cond, confidence, env);
        return;
      case 'ForStmt': {
        const local = new Map(env);
        if (statement.init) {
          if (Array.isArray(statement.init)) for (const expr of statement.init) {
            this.expression(expr, confidence, local);
            this.assignEffect(expr, local);
          }
          else this.statement(statement.init, confidence, local);
        }
        for (const barrier of statement.enroll) this.expression(barrier, confidence, local);
        if (statement.isPar && this.on.spawn?.(statement, confidence, local)) {
          this.forget(statement, env);
          return;
        }
        if (statement.cond) this.expression(statement.cond, confidence, local);
        const first = statement.cond ? this.shared.constant(statement.cond, this.unit, local) : true;
        // Iterations see a changing loop variable.
        this.forget(statement, local);
        if (first !== false) {
          // A par for whose first test is not known true may spawn nothing, like a for that may not run.
          const iteration = combineConfidence(confidence, first === true ? 'exact' : 'conditional');
          this.statement(statement.body, iteration, local);
          for (const update of statement.update) this.expression(update, combineConfidence(iteration, 'conditional'), local);
        }
        this.forget(statement, env);
        return;
      }
      case 'ParBlock':
        for (const barrier of statement.barriers) this.expression(barrier, confidence, env);
        if (this.on.spawn?.(statement, confidence, env)) {
          this.forget(statement, env);
          return;
        }
        // Branches are separate processes, not sequential siblings.
        for (const branch of statement.body.stmts) this.statement(branch, confidence, new Map(env));
        this.forget(statement, env);
        return;
      case 'SeqBlock':
        return this.walkBlock(statement.body, confidence, env);
      case 'ClaimStmt':
        for (const channel of statement.channels) {
          if (channel.kind === 'LocalDecl') this.statement(channel, confidence, env);
          else this.expression(channel, confidence, env);
        }
        this.statement(statement.body, confidence, env);
        return;
      case 'SwitchStmt': {
        this.expression(statement.expr, confidence, env);
        const conditional = combineConfidence(confidence, 'conditional');
        for (const group of statement.groups) {
          for (const label of group.labels) if (label) this.expression(label, conditional, env);
          this.walkList(group.stmts, conditional, new Map(env));
        }
        this.forget(statement, env);
        return;
      }
      case 'AltStmt':
        this.alt(statement, confidence, env);
        this.forget(statement, env);
        return;
      case 'ReturnStmt':
        if (statement.expr) this.expression(statement.expr, confidence, env);
        return;
      case 'LabeledStmt':
        return this.statement(statement.stmt, confidence, env);
      default:
        return;
    }
  }

  private alt(statement: A.AltStmt, confidence: Confidence, env: Map<VarInfo, ConstValue>): void {
    const choice = combineConfidence(confidence, 'conditional');
    // A replicated alt's guards see every value of its index (`cs[j]` for each j): the index is
    // not the constant its initialiser gives.
    const guards = new Map(env);
    if (statement.replicated?.init) {
      if (Array.isArray(statement.replicated.init)) statement.replicated.init.forEach((expr) => this.expression(expr, confidence, guards));
      else this.statement(statement.replicated.init, confidence, guards);
      this.forget(statement, guards);
      const init = statement.replicated.init;
      if (!Array.isArray(init) && init.kind === 'LocalDecl') {
        for (const declarator of init.declarators) {
          const variable = this.variableOf(declarator.name);
          if (variable) guards.delete(variable);
        }
      } else if (Array.isArray(init)) {
        for (const expr of init) {
          const target = expr.kind === 'AssignExpr' ? expr.target : expr.kind === 'UnaryExpr' ? expr.operand : undefined;
          const variable = target?.kind === 'NameExpr' ? this.unit.checked.resolutions.get(target) : undefined;
          if (variable) guards.delete(variable);
        }
      }
    }
    for (const altCase of statement.cases) {
      const local = new Map(guards);
      if (altCase.precondition) this.expression(altCase.precondition, choice, local);
      if (altCase.guard?.kind === 'ReadGuard') {
        const read = altCase.guard.read;
        this.expression(read.target, choice, local, true);
        if (!this.isTimer(read.target)) this.on.read(read.target, read.extended ? 'extended-read' : 'alt-guard', { uri: this.unit.uri, span: read.span }, choice, local);
        if (read.extended) this.walkBlock(read.extended, choice, local);
        this.expression(altCase.guard.target, choice, local, true);
        const variable = altCase.guard.target.kind === 'NameExpr' ? this.unit.checked.resolutions.get(altCase.guard.target) : undefined;
        if (variable) local.delete(variable);
      } else if (altCase.guard?.kind === 'TimeoutGuard') {
        this.expression(altCase.guard.timeout.delay, choice, local);
        this.on.timer?.({ uri: this.unit.uri, span: altCase.guard.timeout.span });
      }
      if (altCase.nested) this.statement(altCase.nested, choice, local);
      if (altCase.body) this.statement(altCase.body, choice, local);
    }
  }

  /** Visit an expression in evaluation order. `operand` skips the endpoint itself (`c` in `c.read()`). */
  expression(expr: A.Expr, confidence: Confidence, env: Map<VarInfo, ConstValue>, operand = false): void {
    switch (expr.kind) {
      case 'Literal':
      case 'NameExpr':
      case 'ErrorExpr':
      case 'NewMobile':
        return;
      case 'ParenExpr':
      case 'CastExpr':
      case 'IsExpr':
        return this.expression(expr.expr, confidence, env, operand);
      case 'BinaryExpr':
        this.expression(expr.left, confidence, env);
        this.expression(expr.right, expr.op === '&&' || expr.op === '||' ? combineConfidence(confidence, 'conditional') : confidence, env);
        return;
      case 'UnaryExpr':
        return this.expression(expr.operand, confidence, env);
      case 'AssignExpr':
        if (expr.target.kind !== 'NameExpr') this.expression(expr.target, confidence, env);
        this.expression(expr.value, confidence, env);
        return;
      case 'TernaryExpr':
        this.expression(expr.cond, confidence, env);
        this.expression(expr.then, combineConfidence(confidence, 'conditional'), env);
        this.expression(expr.else, combineConfidence(confidence, 'conditional'), env);
        return;
      case 'Invocation':
        if (expr.target) this.expression(expr.target, confidence, env);
        for (const arg of expr.args) if (!isEndArgument(arg)) this.expression(arg, confidence, env);
        this.on.call(expr, confidence, env);
        return;
      case 'RecordAccess':
      case 'ChanEnd':
        if (!operand) this.expression(expr.target, confidence, env, true);
        return;
      case 'ArrayAccess':
        this.expression(expr.target, confidence, env, true);
        this.expression(expr.index, confidence, env);
        return;
      case 'ChanRead':
        this.expression(expr.target, confidence, env, true);
        if (this.isTimer(expr.target)) {
          this.on.timer?.({ uri: this.unit.uri, span: expr.span });
          return;
        }
        this.on.read(expr.target, expr.extended ? 'extended-read' : 'read', { uri: this.unit.uri, span: expr.span }, confidence, env);
        if (expr.extended) this.walkBlock(expr.extended, confidence, new Map(env));
        return;
      case 'ChanWrite':
        this.expression(expr.target, confidence, env, true);
        this.expression(expr.value, confidence, env);
        this.on.write(expr.target, { uri: this.unit.uri, span: expr.span }, confidence, env);
        return;
      case 'Sync':
        this.expression(expr.target, confidence, env, true);
        this.on.sync(expr.target, { uri: this.unit.uri, span: expr.span }, confidence, env);
        return;
      case 'Timeout':
        this.expression(expr.target, confidence, env, true);
        this.expression(expr.delay, confidence, env);
        this.on.timer?.({ uri: this.unit.uri, span: expr.span });
        return;
      case 'NewArray':
        for (const dimension of expr.dimExprs) this.expression(dimension, confidence, env);
        if (expr.init) this.expression(expr.init, confidence, env);
        return;
      case 'ArrayLiteral':
        for (const element of expr.elements) this.expression(element, confidence, env);
        return;
      case 'RecordLiteral':
      case 'ProtocolLiteral':
        for (const field of expr.fields) this.expression(field.value, confidence, env);
        return;
    }
  }

  private isTimer(target: A.Expr): boolean {
    const type = this.unit.checked.types.get(target);
    return type?.k === 'prim' && type.name === 'timer';
  }

  private variableOf(name: A.Ident): VarInfo | undefined {
    return this.shared.variableByDecl(this.unit, name);
  }

  /** Track a straight-line assignment (`l = 0`, `i++`) in the constant environment. */
  private assignEffect(expr: A.Expr, env: Map<VarInfo, ConstValue>): void {
    if (expr.kind === 'AssignExpr' && expr.target.kind === 'NameExpr') {
      const variable = this.unit.checked.resolutions.get(expr.target);
      if (!variable) return;
      const value = expr.op === '=' ? this.shared.constant(expr.value, this.unit, env) : undefined;
      if (value === undefined) env.delete(variable);
      else env.set(variable, value);
      return;
    }
    if (expr.kind === 'UnaryExpr' && (expr.op === '++' || expr.op === '--') && expr.operand.kind === 'NameExpr') {
      const variable = this.unit.checked.resolutions.get(expr.operand);
      const value = variable ? env.get(variable) : undefined;
      if (!variable) return;
      if (typeof value === 'number') env.set(variable, value + (expr.op === '++' ? 1 : -1));
      else env.delete(variable);
    }
  }

  /** After a compound statement, a local it may assign is no longer known. */
  private forget(statement: A.Stmt, env: Map<VarInfo, ConstValue>): void {
    if (env.size === 0) return;
    for (const variable of assignedVariables(statement, this.unit.checked)) env.delete(variable);
  }
}

const assignedCache = new WeakMap<A.Stmt, Set<VarInfo>>();

/** Every local a statement may assign, for invalidating constants. */
function assignedVariables(statement: A.Stmt, checked: CheckResult): Set<VarInfo> {
  const cached = assignedCache.get(statement);
  if (cached) return cached;
  const out = new Set<VarInfo>();
  const declared = variableIndex(checked);
  const target = (expr: A.Expr): void => {
    if (expr.kind === 'NameExpr') {
      const variable = checked.resolutions.get(expr);
      if (variable) out.add(variable);
    }
  };
  visitStatement(statement, {
    expr(expr) {
      if (expr.kind === 'AssignExpr') target(expr.target);
      else if (expr.kind === 'UnaryExpr' && (expr.op === '++' || expr.op === '--')) target(expr.operand);
    },
    stmt(stmt) {
      if (stmt.kind === 'AltStmt') for (const altCase of stmt.cases) if (altCase.guard?.kind === 'ReadGuard') target(altCase.guard.target);
      if (stmt.kind === 'LocalDecl') for (const declarator of stmt.declarators) {
        const variable = declared.get(declarator.name);
        if (variable) out.add(variable);
      }
    },
  });
  assignedCache.set(statement, out);
  return out;
}

/** A plain syntactic visit of every statement and expression below a statement, parents first. */
export function visitStatement(statement: A.Stmt, visit: { expr(expr: A.Expr): void; stmt?(stmt: A.Stmt): void }): void {
  const expr = (e: A.Expr | undefined): void => {
    if (!e) return;
    visit.expr(e);
    switch (e.kind) {
      case 'ParenExpr': case 'CastExpr': case 'IsExpr': return expr(e.expr);
      case 'BinaryExpr': expr(e.left); expr(e.right); return;
      case 'UnaryExpr': return expr(e.operand);
      case 'AssignExpr': expr(e.target); expr(e.value); return;
      case 'TernaryExpr': expr(e.cond); expr(e.then); expr(e.else); return;
      case 'Invocation': expr(e.target); e.args.forEach(expr); return;
      case 'RecordAccess': case 'ChanEnd': case 'Sync': return expr(e.target);
      case 'ArrayAccess': expr(e.target); expr(e.index); return;
      case 'ChanRead': expr(e.target); if (e.extended) stmt(e.extended); return;
      case 'ChanWrite': expr(e.target); expr(e.value); return;
      case 'Timeout': expr(e.target); expr(e.delay); return;
      case 'NewArray': e.dimExprs.forEach(expr); expr(e.init); return;
      case 'ArrayLiteral': e.elements.forEach(expr); return;
      case 'RecordLiteral': case 'ProtocolLiteral': e.fields.forEach((field) => expr(field.value)); return;
      default: return;
    }
  };
  const stmt = (s: A.Stmt | undefined): void => {
    if (!s) return;
    visit.stmt?.(s);
    switch (s.kind) {
      case 'Block': s.stmts.forEach(stmt); return;
      case 'LocalDecl': s.declarators.forEach((declarator) => expr(declarator.init)); return;
      case 'ExprStmt': return expr(s.expr);
      case 'IfStmt': expr(s.cond); stmt(s.then); stmt(s.else); return;
      case 'WhileStmt': expr(s.cond); stmt(s.body); return;
      case 'DoStmt': stmt(s.body); expr(s.cond); return;
      case 'ForStmt':
        if (Array.isArray(s.init)) s.init.forEach(expr);
        else stmt(s.init);
        expr(s.cond); s.update.forEach(expr); s.enroll.forEach(expr); stmt(s.body); return;
      case 'ParBlock': s.barriers.forEach(expr); stmt(s.body); return;
      case 'SeqBlock': return stmt(s.body);
      case 'ClaimStmt': s.channels.forEach((channel) => channel.kind === 'LocalDecl' ? stmt(channel) : expr(channel)); stmt(s.body); return;
      case 'SwitchStmt': expr(s.expr); for (const group of s.groups) { group.labels.forEach(expr); group.stmts.forEach(stmt); } return;
      case 'AltStmt':
        for (const altCase of s.cases) {
          expr(altCase.precondition);
          if (altCase.guard?.kind === 'ReadGuard') { expr(altCase.guard.target); expr(altCase.guard.read); }
          else if (altCase.guard?.kind === 'TimeoutGuard') expr(altCase.guard.timeout);
          stmt(altCase.nested); stmt(altCase.body);
        }
        return;
      case 'ReturnStmt': return expr(s.expr);
      case 'LabeledStmt': return stmt(s.stmt);
      default: return;
    }
  };
  stmt(statement);
}

/**
 * Whether a return, a stop, or a break or continue aimed outside it can take
 * control out of `statement` before its end. A par's branches (and a par for's
 * body) are processes of their own: their exits end only themselves.
 */
function leavesStatement(statement: A.Stmt): boolean {
  const visit = (s: A.Stmt | undefined, loops: number, switches: number, labels: readonly string[]): boolean => {
    if (!s) return false;
    switch (s.kind) {
      case 'ReturnStmt':
      case 'StopStmt':
        return true;
      case 'BreakStmt':
        return s.label ? !labels.includes(s.label.name) : loops + switches === 0;
      case 'ContinueStmt':
        return s.label ? !labels.includes(s.label.name) : loops === 0;
      case 'Block':
        return s.stmts.some((child) => visit(child, loops, switches, labels));
      case 'IfStmt':
        return visit(s.then, loops, switches, labels) || visit(s.else, loops, switches, labels);
      case 'WhileStmt':
      case 'DoStmt':
        return visit(s.body, loops + 1, switches, labels);
      case 'ForStmt':
        return !s.isPar && visit(s.body, loops + 1, switches, labels);
      case 'SwitchStmt':
        return s.groups.some((group) => group.stmts.some((child) => visit(child, loops, switches + 1, labels)));
      case 'AltStmt':
        return s.cases.some((altCase) => visit(altCase.nested, loops, switches, labels) || visit(altCase.body, loops, switches, labels));
      case 'LabeledStmt':
        return visit(s.stmt, loops, switches, [...labels, s.label.name]);
      case 'SeqBlock':
        return visit(s.body, loops, switches, labels);
      case 'ClaimStmt':
        return visit(s.body, loops, switches, labels);
      default:
        return false;
    }
  };
  return visit(statement, 0, 0, []);
}

/** Pars and par fors in the code of one process (not inside nested pars or callees). */
function spawnCount(statements: readonly A.Stmt[]): number {
  let count = 0;
  const visit = (statement: A.Stmt | undefined): void => {
    if (!statement) return;
    switch (statement.kind) {
      case 'ParBlock': count++; return;
      case 'ForStmt': if (statement.isPar) { count++; return; } visit(statement.body); return;
      case 'Block': statement.stmts.forEach(visit); return;
      case 'IfStmt': visit(statement.then); visit(statement.else); return;
      case 'WhileStmt': case 'DoStmt': visit(statement.body); return;
      case 'SeqBlock': visit(statement.body); return;
      case 'ClaimStmt': visit(statement.body); return;
      case 'SwitchStmt': statement.groups.forEach((group) => group.stmts.forEach(visit)); return;
      case 'AltStmt': statement.cases.forEach((altCase) => { visit(altCase.nested); visit(altCase.body); }); return;
      case 'LabeledStmt': visit(statement.stmt); return;
      default: return;
    }
  };
  statements.forEach(visit);
  return count;
}

// ---------------------------------------------------------------------------
// Elaboration of one view
// ---------------------------------------------------------------------------

/** How many stages of a recursion through par the drawing unfolds below its first call. */
const MAX_DRAWN_STAGES = 8;

/**
 * Most channels of an array drawn for one element picked at run time (each
 * gets an arrow), and most ports of a channel-array parameter.
 */
const MAX_ARRAY_CHOICE = 128;

interface Frame {
  decl: A.ProcDecl;
  unit: NetworkUnit;
  /** Parameter variable -> what the caller passed. */
  bindings: Map<VarInfo, Binding>;
  /** Owner path of locals declared in this instance. */
  instance: ProcessPath;
  /** Group drawing this instance; its locals are declared there. */
  container: string;
  stack: readonly A.ProcDecl[];
  depth: number;
  /** Data parameters whose value the call fixes (`FIFO(6, ...)`: size is 6 here), for the constants of the body. */
  values?: ReadonlyMap<VarInfo, ConstValue>;
  /** Recursive procedure instances unfolded on the way here, with their known arguments: a repeat never stops. */
  unfolding?: readonly string[];
}

/** An array of channels: its declaration instance and, when the elaboration knows it, its length. */
interface ChanArray {
  variable: VarInfo;
  unit: NetworkUnit;
  owner: ProcessPath;
  container: string;
  size?: number;
}

/**
 * `choice`: one element of an array picked by an index only the run knows
 * (`cs[k]`, the array's length known): any of `channels`, as in the
 * translation, where the process is a user of every element it could pick.
 */
type Binding = { channel: string } | { unknown: string } | { array: ChanArray } | { choice: string[]; label: string };

interface ProcessCtx {
  /** Path of the process executing the code. */
  path: ProcessPath;
  /** Node that performs the operations. */
  node: string;
  /** Where spawned processes are drawn. */
  container: string;
  /** Prefix of spawned processes: `path` plus every call passed through. */
  spawn: ProcessPath;
  /** Whether a single par in this code may be drawn directly in `container`. */
  collapse: boolean;
}

interface ChannelState {
  channel: NetChannel;
  variable?: VarInfo;
  /** The known arguments of the procedure instance that declared it (`size = 5`), to tell same-named channels apart. */
  instance?: string;
  endpoints: Map<string, { ops: NetOperation[]; tags: Set<string>; enrolled: boolean }>;
}

class Elaborator {
  private readonly nodes = new Map<string, NetNode>();
  private readonly order: string[] = [];
  private readonly channels = new Map<string, ChannelState>();
  private readonly instances: NetInstance[] = [];
  private readonly notes: string[] = [];
  private readonly hazards: Map<VarInfo, NonNullable<NetChannel['hazard']>>;
  private readonly children = new Map<string, string[]>();
  /** Local end variables and the end they hold (null: not followed). */
  private readonly aliases = new Map<VarInfo, A.Expr | null>();
  processCount = 0;
  collapsedForDepth = false;
  /** The invocation a branch box stands for, while its statement is walked. */
  private ownedCall?: A.Invocation;

  constructor(private readonly shared: SharedAnalysis, private readonly maxDepth: number, private readonly maxProcesses = Infinity) {
    this.hazards = new Map();
    for (const fact of shared.root.checked.channels) if (fact.hazard) this.hazards.set(fact.variable, fact.hazard);
  }

  private rootNode(decl: A.ProcDecl, kind: NetworkView['kind']): NetNode {
    const viewId = viewIdOf(decl, kind);
    return this.addNode({
      id: `${viewId === 'view:program' ? 'n' : `n${decl.name.span.start.line}_${decl.name.span.start.col}`}:root`,
      kind: 'process',
      label: kind === 'program' ? decl.name.name : shortSignature(decl),
      name: decl.name.name,
      badge: kind === 'program' ? undefined : 'proc',
      source: { uri: this.shared.root.uri, span: decl.name.span },
      confidence: 'exact',
      path: [],
      procedure: decl.name.name,
      facts: this.procedureFacts(decl),
      operations: [],
    });
  }

  /** A view with more processes than can be drawn: its root alone, and a note saying why. */
  tooLarge(decl: A.ProcDecl, kind: NetworkView['kind']): NetworkView {
    const root = this.rootNode(decl, kind);
    return {
      id: viewIdOf(decl, kind),
      kind,
      procedure: decl.name.name,
      label: kind === 'program' ? `${decl.name.name} (whole program)` : shortSignature(decl),
      source: { uri: this.shared.root.uri, span: decl.name.span },
      nodes: [root],
      edges: [],
      channels: [],
      notes: [`This view has more than ${this.maxProcesses} processes even with no call expanded: it is too large to draw. Open the view of a procedure it calls.`],
      instances: [],
    };
  }

  view(decl: A.ProcDecl, kind: NetworkView['kind']): NetworkView {
    const unit = this.shared.root;
    const uri = unit.uri;
    const viewId = viewIdOf(decl, kind);
    const signature = shortSignature(decl);
    const root = this.rootNode(decl, kind);
    const frame: Frame = { decl, unit, bindings: new Map(), instance: [], container: root.id, stack: [decl], depth: 0 };
    // A procedure whose arguments decide its network is drawn as it is checked: with the values its calls give.
    const args = kind === 'procedure' ? this.shared.options.procedureArguments?.(decl) : undefined;
    if (args) {
      const values = new Map<VarInfo, ConstValue>();
      for (const param of decl.params) {
        const variable = this.shared.variableByDecl(unit, param.name);
        const value = args.values[param.name.name];
        if (variable && value !== undefined) values.set(variable, value);
      }
      if (values.size) frame.values = values;
      if (args.text) this.notes.push(`Drawn with ${args.text}: these arguments decide its network, and FDR checks it with them.`);
    }
    if (kind === 'procedure') this.addPorts(decl, frame, args);
    this.runProcedure(frame, { path: [], node: root.id, container: root.id, spawn: [], collapse: true });
    if (root.kind === 'group') root.group ??= 'procedure';
    const { edges, channels } = this.finish();
    return {
      id: viewId,
      kind,
      procedure: decl.name.name,
      label: kind === 'program' ? `${decl.name.name} (whole program)` : signature,
      source: { uri, span: decl.name.span },
      nodes: this.order.map((id) => this.nodes.get(id)!),
      edges,
      channels,
      notes: this.notes,
      instances: this.instances,
    };
  }

  // -- nodes -----------------------------------------------------------------

  private addNode(node: NetNode): NetNode {
    let id = node.id;
    for (let serial = 2; this.nodes.has(id); serial++) id = `${node.id}~${serial}`;
    node.id = id;
    this.nodes.set(id, node);
    this.order.push(id);
    if (node.parent) {
      const siblings = this.children.get(node.parent);
      if (siblings) siblings.push(id);
      else this.children.set(node.parent, [id]);
      this.makeGroup(node.parent);
    }
    return node;
  }

  /** A process box that gains children becomes a group; it keeps its identity and operations. */
  private makeGroup(id: string): void {
    const node = this.nodes.get(id);
    if (!node || node.kind === 'group' || node.kind !== 'process') return;
    node.kind = 'group';
    // Badges read `branch 2`, `stmt 1`: a branch that runs a call's network keeps the branch style.
    if (!node.group) node.group = node.badge === 'call' ? 'call' : node.badge?.startsWith('branch') || node.badge?.startsWith('stmt') ? 'branch' : node.replicated ? 'par-for' : 'procedure';
  }

  private node(id: string): NetNode {
    return this.nodes.get(id)!;
  }

  private procedureFacts(decl: A.ProcDecl): string[] {
    const summary = this.shared.options.effects?.get(decl);
    if (!summary) return [];
    const f = summary.transitive;
    const facts: string[] = [];
    const params = (set: ReadonlySet<number>): string => [...set].sort((a, b) => a - b).map((index) => decl.params[index]?.name.name ?? `#${index + 1}`).join(', ');
    if (f.channelReads.size) facts.push(`reads ${params(f.channelReads)}`);
    if (f.channelWrites.size) facts.push(`writes ${params(f.channelWrites)}`);
    if (f.channelRead && !f.channelReads.size) facts.push('reads local channels');
    if (f.channelWrite && !f.channelWrites.size) facts.push('writes local channels');
    if (f.par) facts.push('spawns parallel processes');
    if (f.alt) facts.push('chooses with alt');
    if (f.barrier) facts.push('syncs on a barrier');
    if (f.timer) facts.push('uses a timer');
    if (f.mobile) facts.push('uses mobile processes');
    if (f.unknown) facts.push(`has opaque effects (${f.confidence})`);
    return facts;
  }

  private addPorts(decl: A.ProcDecl, frame: Frame, args?: ProcedureArguments): void {
    decl.params.forEach((param, index) => {
      const variable = this.shared.variableByDecl(frame.unit, param.name);
      if (!variable) return;
      const type = variable.type;
      const length = args?.arrays[param.name.name];
      if (isChanArrayType(type) && length !== undefined && length <= MAX_ARRAY_CHOICE) {
        // An array of channels of a known length: each channel is a port of its own (`chans[2]`).
        const array: ChanArray = { variable, unit: frame.unit, owner: [], container: frame.container, size: length };
        const end = type.k === 'array' && type.elem.k === 'chan' ? type.elem.end : undefined;
        for (let k = 0; k < length; k++) {
          const channel = this.elementChannel(array, k);
          const port = this.addNode({
            id: `port:${index}:${k}`,
            kind: 'port',
            label: `${param.name.name}[${k}]`,
            name: `parameter ${param.name.name}[${k}]`,
            source: { uri: frame.unit.uri, span: param.name.span },
            confidence: 'exact',
            port: { parameter: index, name: `${param.name.name}[${k}]`, direction: end === 'read' ? 'in' : end === 'write' ? 'out' : 'unknown', type: typeStr(type), index: k },
            channel: channel.channel.id,
            facts: [`parameter ${index + 1}: ${typeStr(type)}, channel ${k} of ${length}`],
            operations: [],
          });
          channel.channel.port = port.id;
          channel.channel.container = undefined;
        }
        frame.bindings.set(variable, { array });
        return;
      }
      const barrier = type.k === 'prim' && type.name === 'barrier';
      if (type.k !== 'chan' && !barrier) return;
      const direction = barrier ? 'sync' : type.k === 'chan' && type.end === 'read' ? 'in' : type.k === 'chan' && type.end === 'write' ? 'out' : 'unknown';
      const channel = this.channelFor(variable, frame, { kind: barrier ? 'barrier' : 'channel', owner: [], isPort: true });
      const port = this.addNode({
        id: `port:${index}`,
        kind: 'port',
        label: param.name.name,
        name: `parameter ${param.name.name}`,
        source: { uri: frame.unit.uri, span: param.name.span },
        confidence: 'exact',
        port: { parameter: index, name: param.name.name, direction, type: typeStr(type) },
        channel: channel.channel.id,
        facts: [`parameter ${index + 1}: ${typeStr(type)}`],
        operations: [],
      });
      channel.channel.port = port.id;
      channel.channel.container = undefined;
      frame.bindings.set(variable, { channel: channel.channel.id });
    });
  }

  // -- channels --------------------------------------------------------------

  private channelFor(variable: VarInfo, frame: Frame, how: { kind: 'channel' | 'barrier'; owner: ProcessPath; member?: string; isPort?: boolean }): ChannelState {
    const name = how.member ? `${variable.name}.${how.member}` : variable.name;
    const key = `c${pathKey(how.owner, this.shared.root.uri)}@${uriTag(frame.unit.uri, this.shared.root.uri)}${variable.decl.span.start.line}_${variable.decl.span.start.col}${how.member ? `.${how.member}` : ''}`;
    let state = this.channels.get(key);
    if (state) return state;
    const type = variable.type;
    const elem = how.member ? '?' : type.k === 'chan' ? typeStr(type.elem) : typeStr(type);
    // An end (`shared chan<int>.write`) is shared on its own side; a whole channel on `sharedSide`, or both.
    const side = type.k === 'chan' ? type.end ?? type.sharedSide : undefined;
    const shared = type.k === 'chan' && type.shared
      ? { read: !side || side === 'read', write: !side || side === 'write' }
      : { read: false, write: false };
    const channel: NetChannel = {
      id: key,
      kind: how.kind,
      ref: { name, kind: how.kind, declaration: { uri: frame.unit.uri, span: variable.decl.span }, owner: how.owner },
      name,
      type: how.kind === 'barrier' ? 'barrier' : elem,
      shared,
      container: how.isPort ? undefined : frame.container,
      writers: [],
      readers: [],
      members: [],
      hazard: frame.unit === this.shared.root ? this.hazards.get(variable) : undefined,
      edges: [],
    };
    state = { channel, variable, endpoints: new Map(), instance: how.isPort ? undefined : valuesText(frame.values) };
    this.channels.set(key, state);
    return state;
  }

  /** The channel or barrier an operated or passed expression denotes in this frame. */
  private resolve(expr: A.Expr, frame: Frame, depth = 0, env: ReadonlyMap<VarInfo, ConstValue> = frame.values ?? new Map()): Binding | undefined {
    while (expr.kind === 'ParenExpr' || expr.kind === 'CastExpr' || expr.kind === 'ChanEnd') expr = expr.kind === 'ChanEnd' ? expr.target : expr.expr;
    if (expr.kind === 'ArrayAccess') {
      // One channel of an array: drawn on its own when the index is known here.
      const array = this.resolve(expr.target, frame, depth + 1, env);
      if (!array || !('array' in array)) return array && 'unknown' in array ? array : { unknown: exprLabel(expr) };
      const index = this.shared.constant(expr.index, frame.unit, env);
      const size = array.array.size;
      if (typeof index === 'number' && size !== undefined && (index < 0 || index >= size)) return { unknown: `${exprLabel(expr)} (index ${index}, outside the ${size} channels of '${array.array.variable.name}')` };
      if (size === undefined) return { unknown: exprLabel(expr) };
      if (typeof index !== 'number') {
        if (size === 0) return { unknown: exprLabel(expr) };
        // Too many to draw one by one: one unknown element, not an arrow to each (the length comes from the source).
        if (size > MAX_ARRAY_CHOICE) return { unknown: `${exprLabel(expr)} (one of the ${size} channels of '${array.array.variable.name}', too many to draw one by one)` };
        return { choice: Array.from({ length: size }, (_, k) => this.elementChannel(array.array, k).channel.id), label: `${array.array.variable.name}[${this.indexText(expr.index, frame)}]` };
      }
      return { channel: this.elementChannel(array.array, index).channel.id };
    }
    if (expr.kind === 'NameExpr') {
      const variable = frame.unit.checked.resolutions.get(expr);
      if (!variable) return { unknown: expr.name.name };
      const bound = frame.bindings.get(variable);
      if (bound) return bound;
      const type = variable.type;
      if (isChanArrayType(type) && !variable.isParam) return { array: { variable, unit: frame.unit, owner: frame.instance, container: frame.container, size: this.arraySize(variable, frame) } };
      const barrier = type.k === 'prim' && type.name === 'barrier';
      if (type.k !== 'chan' && !barrier) return undefined;
      if (variable.isParam) return { unknown: variable.name };
      // An end kept in a local (`chan<int>.write w = c.write;`) is that channel's end.
      const alias = depth < 8 ? this.endAlias(variable, frame) : undefined;
      if (alias) return this.resolve(alias, frame, depth + 1);
      return { channel: this.channelFor(variable, frame, { kind: barrier ? 'barrier' : 'channel', owner: frame.instance }).channel.id };
    }
    if (expr.kind === 'RecordAccess') {
      const members: string[] = [];
      let target: A.Expr = expr;
      while (target.kind === 'RecordAccess') {
        members.unshift(target.member.name);
        target = target.target;
      }
      while (target.kind === 'ParenExpr' || target.kind === 'CastExpr') target = target.expr;
      const variable = target.kind === 'NameExpr' ? frame.unit.checked.resolutions.get(target) : undefined;
      const type = frame.unit.checked.types.get(expr);
      if (!variable || variable.isParam || !(type?.k === 'chan' || (type?.k === 'prim' && type.name === 'barrier'))) return { unknown: exprLabel(expr) };
      const state = this.channelFor(variable, frame, { kind: type.k === 'chan' ? 'channel' : 'barrier', owner: frame.instance, member: members.join('.') });
      if (type.k === 'chan') state.channel.type = typeStr(type.elem);
      return { channel: state.channel.id };
    }
    return { unknown: exprLabel(expr) };
  }

  /** An index as written, when it is short (`k`, `i - 1`), else `…`. */
  private indexText(index: A.Expr, frame: Frame): string {
    const text = this.shared.sourceText(frame.unit.uri, index.span)?.replace(/\s+/g, ' ');
    return text && text.length <= 12 ? text : '…';
  }

  /**
   * The length of an array of channels declared with `new chan<T>[n]`, when n
   * follows from constants and the call's arguments (the declaration is what
   * creates the channels in this ProcessJ build).
   */
  private arraySize(variable: VarInfo, frame: Frame): number | undefined {
    if (!frame.decl.body) return undefined;
    let size: number | undefined;
    visitStatement(frame.decl.body, {
      expr: () => undefined,
      stmt: (stmt) => {
        if (stmt.kind !== 'LocalDecl') return;
        for (const declarator of stmt.declarators) {
          if (declarator.name !== variable.decl || declarator.init?.kind !== 'NewArray' || declarator.init.dimExprs.length !== 1) continue;
          const value = this.shared.constant(declarator.init.dimExprs[0], frame.unit, frame.values ?? new Map());
          if (typeof value === 'number' && value >= 0) size = value;
        }
      },
    });
    return size;
  }

  /** The drawn channel for one element of an array: `chans[2]`, with the array's declarator and owner. */
  private elementChannel(array: ChanArray, index: number): ChannelState {
    const variable = array.variable;
    const key = `c${pathKey(array.owner, this.shared.root.uri)}@${uriTag(array.unit.uri, this.shared.root.uri)}${variable.decl.span.start.line}_${variable.decl.span.start.col}[${index}]`;
    const known = this.channels.get(key);
    if (known) return known;
    const name = `${variable.name}[${index}]`;
    const elem = variable.type.k === 'array' && variable.type.elem.k === 'chan' ? typeStr(variable.type.elem.elem) : '?';
    const channel: NetChannel = {
      id: key,
      kind: 'channel',
      ref: { name, kind: 'channel', declaration: { uri: array.unit.uri, span: variable.decl.span }, owner: array.owner, index },
      name,
      type: elem,
      shared: { read: false, write: false },
      container: array.container,
      writers: [],
      readers: [],
      members: [],
      edges: [],
    };
    const state: ChannelState = { channel, variable, endpoints: new Map() };
    this.channels.set(key, state);
    return state;
  }

  /** What a local end variable was initialised with, when nothing assigns it again. */
  private endAlias(variable: VarInfo, frame: Frame): A.Expr | undefined {
    if (variable.type.k !== 'chan' || !variable.type.end || !frame.decl.body) return undefined;
    const cached = this.aliases.get(variable);
    if (cached !== undefined) return cached ?? undefined;
    let init: A.Expr | undefined;
    let reassigned = false;
    visitStatement(frame.decl.body, {
      expr: (expr) => {
        if (expr.kind === 'AssignExpr' && expr.target.kind === 'NameExpr' && frame.unit.checked.resolutions.get(expr.target) === variable) reassigned = true;
      },
      stmt: (stmt) => {
        if (stmt.kind === 'LocalDecl') for (const declarator of stmt.declarators) if (declarator.name === variable.decl) init = declarator.init;
      },
    });
    const alias = reassigned ? undefined : init;
    this.aliases.set(variable, alias ?? null);
    return alias;
  }

  private addOperation(nodeId: string, binding: Binding | undefined, op: Omit<NetOperation, 'channel'>, tags: string[] = []): void {
    if (!binding) return;
    const node = this.node(nodeId);
    if ('unknown' in binding) {
      const fact = `${op.kind === 'write' ? 'writes' : op.kind === 'sync' ? 'syncs on' : op.kind === 'pass' ? 'passes' : 'reads'} '${binding.unknown}', which this view cannot resolve`;
      if (!node.facts.includes(fact)) node.facts.push(fact);
      node.confidence = combineConfidence(node.confidence, 'conditional');
      return;
    }
    if ('array' in binding) {
      const fact = `hands the whole channel array '${binding.array.variable.name}' to code this view does not follow`;
      if (!node.facts.includes(fact)) node.facts.push(fact);
      return;
    }
    if ('choice' in binding) {
      // Drawn as a possible (dashed) use of every element the index could pick.
      const first = this.channels.get(binding.choice[0])?.channel.name;
      const last = this.channels.get(binding.choice[binding.choice.length - 1])?.channel.name;
      const fact = `${op.kind === 'write' ? 'writes' : op.kind === 'sync' ? 'syncs on' : op.kind === 'pass' ? 'passes' : 'reads'} ${binding.label}, an element chosen at run time: any of ${first === last ? first : `${first} to ${last}`}`;
      if (!node.facts.includes(fact)) node.facts.push(fact);
      for (const channel of binding.choice) this.addOperation(nodeId, { channel }, { ...op, confidence: combineConfidence(op.confidence, 'conditional') }, tags);
      return;
    }
    const state = this.channels.get(binding.channel);
    if (!state) return;
    const operation: NetOperation = { ...op, channel: state.channel.id };
    node.operations.push(operation);
    let endpoint = state.endpoints.get(nodeId);
    if (!endpoint) {
      endpoint = { ops: [], tags: new Set(), enrolled: false };
      state.endpoints.set(nodeId, endpoint);
    }
    endpoint.ops.push(operation);
    for (const tag of tags) endpoint.tags.add(tag);
  }

  private enroll(nodeId: string, binding: Binding | undefined): void {
    if (!binding || !('channel' in binding)) return;
    const state = this.channels.get(binding.channel);
    if (!state || state.channel.kind !== 'barrier') return;
    let endpoint = state.endpoints.get(nodeId);
    if (!endpoint) {
      endpoint = { ops: [], tags: new Set(), enrolled: true };
      state.endpoints.set(nodeId, endpoint);
    }
    endpoint.enrolled = true;
  }

  // -- code -------------------------------------------------------------------

  /** Elaborate a procedure body; `confidence` is how certainly the call that runs it happens. */
  private runProcedure(frame: Frame, ctx: ProcessCtx, confidence: Confidence = 'exact'): void {
    if (!frame.decl.body) return;
    const collapse = ctx.collapse && spawnCount(frame.decl.body.stmts) === 1;
    this.runCode(frame.decl.body.stmts, frame, { ...ctx, collapse }, confidence, new Map(frame.values ?? []));
    // The view's own locals are listed even when nothing here uses them.
    if (frame.depth > 0) return;
    const body = frame.decl.body.span;
    for (const variable of frame.unit.checked.vars) {
      if (variable.isParam || !inside(body, variable.decl.span) || this.endAlias(variable, frame)) continue;
      const barrier = variable.type.k === 'prim' && variable.type.name === 'barrier';
      if (variable.type.k === 'chan' || barrier) this.channelFor(variable, frame, { kind: barrier ? 'barrier' : 'channel', owner: frame.instance });
    }
  }

  private runCode(statements: readonly A.Stmt[], frame: Frame, ctx: ProcessCtx, confidence: Confidence, env: Map<VarInfo, ConstValue>): void {
    const walker = new CodeWalker(this.shared, frame.unit, {
      read: (target, kind, at, conf, known) => this.addOperation(ctx.node, this.resolve(target, frame, 0, known), { kind, at, confidence: conf }, kind === 'alt-guard' ? ['alt'] : kind === 'extended-read' ? ['extended'] : []),
      write: (target, at, conf, known) => this.addOperation(ctx.node, this.resolve(target, frame, 0, known), { kind: 'write', at, confidence: conf }),
      sync: (target, at, conf, known) => this.addOperation(ctx.node, this.resolve(target, frame, 0, known), { kind: 'sync', at, confidence: conf }, ['sync']),
      timer: () => {
        const node = this.node(ctx.node);
        if (!node.facts.includes('waits on a timer')) node.facts.push('waits on a timer');
      },
      call: (call, conf, known) => this.call(call, frame, ctx, conf, known),
      spawn: (statement, conf, spawnEnv) => {
        const container = ctx.collapse ? ctx.container : this.parGroup(statement, frame, ctx);
        if (statement.kind === 'ParBlock') this.spawnPar(statement, frame, { ...ctx, container }, conf, spawnEnv);
        else this.spawnParFor(statement, frame, { ...ctx, container }, conf, spawnEnv);
        return true;
      },
    });
    walker.walkList(statements, confidence, env);
  }

  /** An explicit container for one of several pars in the same code. */
  private parGroup(statement: A.ParBlock | A.ForStmt, frame: Frame, ctx: ProcessCtx): string {
    if (statement.kind === 'ForStmt') return ctx.container;
    const group = this.addNode({
      id: `g${pathKey(ctx.spawn, this.shared.root.uri)}:${uriTag(frame.unit.uri, this.shared.root.uri)}${statement.span.start.line}_${statement.span.start.col}`,
      kind: 'group',
      parent: ctx.container,
      group: 'par',
      label: `par (line ${statement.span.start.line + 1})`,
      name: `par at line ${statement.span.start.line + 1}${frame.depth > 0 ? ` of ${frame.decl.name.name}` : ''}`,
      badge: 'par',
      source: { uri: frame.unit.uri, span: statement.span },
      confidence: 'exact',
      facts: [],
      operations: [],
    });
    return group.id;
  }

  private spawnPar(par: A.ParBlock, frame: Frame, ctx: ProcessCtx, confidence: Confidence, env: Map<VarInfo, ConstValue>): void {
    const barriers = par.barriers.map((barrier) => this.resolve(barrier, frame));
    const container = this.node(ctx.container);
    if (par.barriers.length && container.kind !== 'port') {
      const names = par.barriers.map(exprLabel).join(', ');
      if (!container.facts.includes(`enrolls its branches on ${names}`)) container.facts.push(`enrolls its branches on ${names}`);
    }
    par.body.stmts.forEach((statement, index) => {
      const path = [...ctx.spawn, branchStep(statement, index + 1, frame.unit.uri)];
      const child = this.processFor(statement, 'branch', index + 1, path, frame, ctx.container, confidence, new Map(env));
      for (const barrier of barriers) this.enroll(child, barrier);
    });
  }

  private spawnParFor(loop: A.ForStmt, frame: Frame, ctx: ProcessCtx, spawned: Confidence, env: Map<VarInfo, ConstValue>): void {
    const { count, first } = this.iterations(loop, frame, env);
    const replicated = { count, text: count === undefined ? '×N' : `×${count}` };
    // The body runs only when there is at least one iteration: a known count above zero, or a first test known true.
    const confidence = combineConfidence(spawned, (count ?? 0) > 0 || (count === undefined && first === true) ? 'exact' : 'conditional');
    const path = [...ctx.spawn, parForStep(loop, frame.unit.uri)];
    const barriers = loop.enroll.map((barrier) => this.resolve(barrier, frame));
    const bodyEnv = new Map(env);
    for (const variable of assignedVariables(loop, frame.unit.checked)) bodyEnv.delete(variable);
    const statements = loop.body.kind === 'Block' ? loop.body.stmts : [loop.body];
    const bound = loop.cond ? this.shared.sourceText(frame.unit.uri, loop.cond.span) ?? exprLabel(loop.cond) : '';
    const { values } = this.iterations(loop, frame, env);
    const loopVariable = loop.init && !Array.isArray(loop.init) && loop.init.declarators.length === 1 ? this.shared.variableByDecl(frame.unit, loop.init.declarators[0].name) : undefined;
    if (statements.length === 1 && values?.length && values.length <= 32 && loopVariable && this.usesChannelArray(loop.body, frame)) {
      // Each iteration uses its own channels of an array (`foo(i, chans, ...)`): one box per iteration, so
      // every element is drawn as the channel between the iterations that use it. A branch that is
      // nothing but this par for is drawn as its container already: the iterations go there.
      const label = `par for ${bound}`.trim();
      const fact = `${values.length} iterations, ${loopVariable.name} = ${values[0]} to ${values[values.length - 1]}, each drawn on its own because each uses its own channels of an array`;
      const host = this.nodes.get(ctx.container);
      const reuse = host?.kind === 'group' && host.label === label && !!host.source && inside(host.source.span, loop.span) && !host.replicated;
      if (reuse) {
        host.group = 'par-for';
        host.badge = 'par for';
        if (!host.facts.includes(fact)) host.facts.push(fact);
      }
      const group = reuse ? host : this.addNode({
        id: `r${pathKey(path, this.shared.root.uri)}`,
        kind: 'group',
        parent: ctx.container,
        group: 'par-for',
        label: `par for ${bound}`.trim(),
        name: `par for ${bound}`.trim(),
        badge: 'par for',
        source: { uri: frame.unit.uri, span: loop.span },
        confidence,
        facts: [fact],
        operations: [],
      });
      for (const value of values) {
        const iterationEnv = new Map(bodyEnv).set(loopVariable, value);
        const step: SpawnSite = { ...parForStep(loop, frame.unit.uri), index: value };
        const child = this.processFor(statements[0], 'iteration', value, [...ctx.spawn, step], frame, group.id, confidence, iterationEnv, { loop, bound, value: `${loopVariable.name} = ${value}` });
        for (const barrier of barriers) this.enroll(child, barrier);
      }
      return;
    }
    if (statements.length > 1) {
      // The code generator runs each statement of a par for body as its own process.
      const group = this.addNode({
        id: `r${pathKey(path, this.shared.root.uri)}`,
        kind: 'group',
        parent: ctx.container,
        group: 'par-for',
        label: `par for ${bound}`.trim(),
        name: `par for ${bound}`.trim(),
        badge: 'par for',
        source: { uri: frame.unit.uri, span: loop.span },
        // Each iteration is this box's statements; a result about a whole iteration lands here.
        path,
        confidence,
        replicated,
        statements: statements.length,
        facts: [`each of the ${statements.length} statements of the body runs as its own process in every iteration (the code generator treats the body like a par block)`],
        operations: [],
      });
      statements.forEach((statement, index) => {
        const child = this.processFor(statement, 'stmt', index + 1, [...path, branchStep(statement, index + 1, frame.unit.uri)], frame, group.id, confidence, new Map(bodyEnv));
        for (const barrier of barriers) this.enroll(child, barrier);
      });
      return;
    }
    const child = this.processFor(statements[0] ?? loop.body, 'iteration', 0, path, frame, ctx.container, confidence, bodyEnv, { replicated, loop, bound });
    for (const barrier of barriers) this.enroll(child, barrier);
  }

  /** How many iterations a par for has, when known, and its first test (whether it spawns anything at all). */
  private iterations(loop: A.ForStmt, frame: Frame, env: Map<VarInfo, ConstValue>): { count?: number; first?: ConstValue; values?: number[] } {
    if (!loop.cond) return { first: true };
    const local = new Map(env);
    const assign = (expr: A.Expr): boolean => {
      if (expr.kind === 'AssignExpr' && expr.target.kind === 'NameExpr') {
        const variable = frame.unit.checked.resolutions.get(expr.target);
        const current = variable ? local.get(variable) : undefined;
        const value = this.shared.constant(expr.value, frame.unit, local);
        if (!variable || typeof value !== 'number') return false;
        if (expr.op === '=') local.set(variable, value);
        else if (expr.op === '+=' && typeof current === 'number') local.set(variable, current + value);
        else if (expr.op === '-=' && typeof current === 'number') local.set(variable, current - value);
        else return false;
        return true;
      }
      if (expr.kind === 'UnaryExpr' && (expr.op === '++' || expr.op === '--') && expr.operand.kind === 'NameExpr') {
        const variable = frame.unit.checked.resolutions.get(expr.operand);
        const current = variable ? local.get(variable) : undefined;
        if (!variable || typeof current !== 'number') return false;
        local.set(variable, current + (expr.op === '++' ? 1 : -1));
        return true;
      }
      return false;
    };
    if (loop.init) {
      if (Array.isArray(loop.init)) {
        if (!loop.init.every(assign)) return {};
      } else {
        for (const declarator of loop.init.declarators) {
          const variable = this.shared.variableByDecl(frame.unit, declarator.name);
          const value = declarator.init ? this.shared.constant(declarator.init, frame.unit, local) : undefined;
          if (!variable || typeof value !== 'number') return {};
          local.set(variable, value);
        }
      }
    }
    const first = this.shared.constant(loop.cond, frame.unit, local);
    // The loop variable's value in each iteration, while the count is small enough to draw them one by one.
    const loopVariable = loop.init && !Array.isArray(loop.init) && loop.init.declarators.length === 1 ? this.shared.variableByDecl(frame.unit, loop.init.declarators[0].name) : undefined;
    const values: number[] = [];
    for (let count = 0; count <= 100_000; count++) {
      const test = count === 0 ? first : this.shared.constant(loop.cond, frame.unit, local);
      if (test === false) return { count, first, ...(loopVariable && values.length === count ? { values } : {}) };
      const current = loopVariable ? local.get(loopVariable) : undefined;
      if (typeof current === 'number' && count < 64) values.push(current);
      if (test !== true) return { first };
      if (!loop.update.length || !loop.update.every(assign)) return { first };
    }
    return { first };
  }

  /**
   * The process one par branch (or par for body) runs. A single call is labelled
   * like the call and expanded when the callee has its own network; a branch that
   * is itself a par is drawn as that par's container.
   */
  private processFor(statement: A.Stmt, role: 'branch' | 'iteration' | 'stmt', index: number, path: ProcessPath, frame: Frame, container: string, confidence: Confidence, env: Map<VarInfo, ConstValue>, loop?: { replicated?: { count?: number; text: string }; loop: A.ForStmt; bound: string; value?: string }): string {
    if (++this.processCount > this.maxProcesses) throw new ViewTooLarge();
    let inner = statement;
    while (inner.kind === 'Block' && inner.stmts.length === 1) inner = inner.stmts[0];
    const uri = frame.unit.uri;
    const id = `p${pathKey(path, this.shared.root.uri)}`;
    const call = inner.kind === 'ExprStmt' && inner.expr.kind === 'Invocation' && !inner.expr.target ? inner.expr : undefined;
    const loopText = loop ? `par for ${loop.bound}`.trim() : undefined;
    // Branch numbers repeat in nested pars and expanded calls: say whose branch it is
    // (not for the iterations of a branch that is nothing but that par for).
    const of = role === 'iteration' && this.nodes.get(container)?.label === loopText ? '' : this.ownerSuffix(container, frame);
    const name = role === 'branch' ? `branch ${index}${of}` : role === 'stmt' ? `statement ${index}${of}` : `${loopText ?? 'iteration'}${of}`;
    const badge = role === 'branch' ? `branch ${index}` : role === 'stmt' ? `stmt ${index}` : 'par for';
    const base = {
      id,
      parent: container,
      source: { uri, span: statement.span },
      confidence,
      path,
      replicated: loop?.replicated,
      facts: [] as string[],
      operations: [] as NetOperation[],
    };
    if (call) {
      const label = this.callLabel(call, frame);
      // One box per iteration: the iteration's value is on its second line and in its name.
      const node = this.addNode({ ...base, kind: 'process', label, name: loop?.value ? `${label} [${loop.value}]` : label, badge: role === 'stmt' ? badge : 'call', detail: loop?.value ? `${loop.value} · ${loopText}` : loopText, procedure: call.name.name });
      // The call is this process; communication in its arguments happens in it too.
      this.ownedCall = call;
      this.runCode([inner], frame, { path, node: node.id, container: node.id, spawn: path, collapse: true }, confidence, env);
      return node.id;
    }
    if (inner.kind === 'ParBlock' || (inner.kind === 'ForStmt' && inner.isPar)) {
      // A branch that is itself a par (or par for) is drawn as that container.
      const header = headerText(inner, this.shared, uri);
      const node = this.addNode({ ...base, kind: 'group', group: loop ? 'par-for' : 'branch', label: loopText ?? header, name, badge: loop ? 'par for' : badge, detail: loop && inner.kind === 'ParBlock' ? header : undefined });
      this.runCode([inner], frame, { path, node: node.id, container: node.id, spawn: path, collapse: true }, confidence, env);
      return node.id;
    }
    const hint = this.codeHint(inner, frame);
    const node = this.addNode({ ...base, kind: 'process', label: hint.label ?? name, name, badge, detail: hint.detail ?? (loop && hint.label ? undefined : undefined) });
    if (loop && !hint.label) node.label = loopText ?? name;
    const code = inner.kind === 'Block' ? inner.stmts : [inner];
    this.runCode(code, frame, { path, node: node.id, container: node.id, spawn: path, collapse: spawnCount(code) === 1 }, confidence, env);
    return node.id;
  }

  /** Whether code names an array of channels (an element of one, or the whole array handed to a call). */
  private usesChannelArray(statement: A.Stmt, frame: Frame): boolean {
    let found = false;
    visitStatement(statement, {
      expr: (expr) => {
        if (found || expr.kind !== 'NameExpr') return;
        const variable = frame.unit.checked.resolutions.get(expr);
        if (variable && isChanArrayType(variable.type)) found = true;
      },
    });
    return found;
  }

  /**
   * ` of <owner>` for a process spawned below the top of the view: the callee of
   * an expanded call (`branch 1 of delta`), the branch a nested par runs in
   * (`branch 2 of branch 1`), or one of several pars in the same code.
   */
  private ownerSuffix(container: string, frame: Frame): string {
    const parent = this.nodes.get(container);
    const callee = frame.depth > 0 ? ` of ${frame.decl.name.name}` : '';
    if (!parent || parent.call || parent.group === 'call') return callee;
    if ((parent.path && parent.path.length > 0) || (parent.group === 'par' && !parent.path)) return ` of ${parent.name}`;
    return callee;
  }

  /** A call in a process's code: expand a callee with its own network, or add the callee's parameter uses. */
  private call(call: A.Invocation, frame: Frame, ctx: ProcessCtx, confidence: Confidence, env: ReadonlyMap<VarInfo, ConstValue> = new Map()): void {
    if (call.target) return;
    const selected = frame.unit.checked.calls.get(call);
    const owns = this.ownedCall === call;
    if (owns) this.ownedCall = undefined;
    this.callProcess(call, selected, frame, { ...ctx, spawn: [...ctx.spawn, callStep(call, frame.unit.uri)] }, confidence, owns, env);
  }

  /** The data parameters a call fixes: an argument known here, for a parameter the callee never assigns. */
  private calleeValues(call: A.Invocation, callee: A.ProcDecl, calleeUnit: NetworkUnit, callerUnit: NetworkUnit, env: ReadonlyMap<VarInfo, ConstValue>): Map<VarInfo, ConstValue> {
    const out = new Map<VarInfo, ConstValue>();
    const assigned = callee.body ? assignedVariables(callee.body, calleeUnit.checked) : new Set<VarInfo>();
    callee.params.forEach((param, index) => {
      const variable = this.shared.variableByDecl(calleeUnit, param.name);
      const arg = call.args[index];
      if (!variable || !arg || assigned.has(variable)) return;
      const value = this.shared.constant(arg, callerUnit, env);
      if (value !== undefined) out.set(variable, value);
    });
    return out;
  }

  private callProcess(call: A.Invocation, selected: ProcSig | undefined, frame: Frame, ctx: ProcessCtx, confidence: Confidence, ownsNode: boolean, env: ReadonlyMap<VarInfo, ConstValue> = new Map()): void {
    const node = this.node(ctx.node);
    const callee = selected?.decl;
    const calleeUnit = callee?.body ? this.shared.unitOf(callee) : undefined;
    const declaration: SourceRef | undefined = callee ? { uri: calleeUnit?.uri ?? fileUri(selected?.file) ?? frame.unit.uri, span: callee.name.span } : undefined;
    const text = this.callLabel(call, frame);
    const callInfo: NetCall = { procedure: call.name.name, text, declaration, params: callee?.params.map((param) => param.name.name) ?? [] };
    if (ownsNode) {
      node.call = callInfo;
      if (callee) node.facts.push(...this.procedureFacts(callee));
    }
    if (!selected) {
      if (ownsNode) node.confidence = combineConfidence(node.confidence, 'unknown');
      node.facts.push(`calls '${call.name.name}', which could not be resolved: its effects are unknown`);
      this.passArguments(call, frame, ctx, 'unknown', env);
      return;
    }
    if (!callee?.body) {
      // A native or bodyless declaration: only the trusted output leaves are known not to communicate.
      if (call.args.some((arg) => isEndArgument(arg) || this.isResourceArgument(arg, frame))) {
        node.facts.push(`passes channels to '${call.name.name}', which has no body here: what it does with them is unknown`);
        this.passArguments(call, frame, ctx, 'unknown', env);
      }
      return;
    }
    const spawns = !!this.shared.options.effects?.get(callee)?.transitive.par || hasSpawn(callee);
    const values = calleeUnit ? this.calleeValues(call, callee, calleeUnit, frame.unit, env) : new Map<VarInfo, ConstValue>();
    // Recursion through par is drawn unfolded when every data argument is known and the arguments
    // never repeat (altFIFO(6) .. altFIFO(1)): the stages of the recursion, nested.
    const key = `${callee.name.name}@${callee.name.span.start.line}|${[...values].map(([v, x]) => `${v.name}=${x}`).sort().join(',')}`;
    const dataParams = calleeUnit ? callee.params.map((param) => this.shared.variableByDecl(calleeUnit, param.name)).filter((v): v is VarInfo => !!v && (v.type.k === 'prim' && v.type.name !== 'barrier' && v.type.name !== 'timer')) : [];
    const onStack = frame.stack.includes(callee);
    const finite = onStack && dataParams.every((v) => values.has(v)) && !(frame.unfolding ?? []).includes(key) && !!calleeUnit && this.recursionEnds(callee, calleeUnit, values, frame.stack);
    // Deeper stages are not drawn: each adds a nested container, and past a few they only push the
    // stages out of sight. The model still checks them all.
    const capped = finite && (frame.unfolding?.length ?? 0) >= MAX_DRAWN_STAGES;
    const unfolds = finite && !capped;
    const expandable = spawns && !!calleeUnit && (unfolds || (!onStack && frame.depth < this.maxDepth));
    const known = valuesText(values);
    if (ownsNode && known && (expandable || onStack)) {
      // The call's known arguments tell the stages of an unfolded recursion apart (`size = 5`).
      node.name = `${node.name} (${known})`;
      node.detail = node.detail ? `${known} · ${node.detail}` : known;
    }
    if (!spawns && calleeUnit && callee.params.some((param) => isChanArrayType(this.shared.variableByDecl(calleeUnit, param.name)?.type))) {
      // A callee without a network of its own that is handed an array of channels: which elements it
      // uses depends on its arguments, so its code runs here with them (`foo(i, chans, ...)` in iteration 2).
      if (!onStack) {
        this.inlineCall(call, callee, calleeUnit, values, frame, ctx, confidence, env);
        return;
      }
    }
    if (!expandable) {
      if (spawns) {
        const reason: NetCall['collapsed'] = onStack ? 'recursion' : !calleeUnit ? 'unavailable' : 'depth';
        if (reason === 'depth') this.collapsedForDepth = true;
        if (ownsNode) {
          node.call = { ...callInfo, collapsed: reason };
          node.facts.push(capped ? `calls '${callee.name.name}' recursively: the stages from here on (${valuesText(values)}) are not drawn, to keep the drawing readable; the model checks every stage` : reason === 'recursion' ? `calls '${callee.name.name}' recursively: its network is drawn once, higher up` : reason === 'depth' ? `runs a network of its own (open the '${callee.name.name}' view to see it)` : `runs a network of its own declared in another file`);
        } else {
          node.facts.push(`calls '${callee.name.name}', which runs a network of its own${reason === 'recursion' ? ' (recursively)' : ''}`);
        }
      }
      this.leafCall(call, callee, frame, ctx, confidence, env);
      return;
    }
    // Expand: bind the callee's parameters to what this call passes.
    const bindings = new Map<VarInfo, Binding>();
    callee.params.forEach((param, index) => {
      const variable = this.shared.variableByDecl(calleeUnit!, param.name);
      const arg = call.args[index];
      if (!variable || !arg) return;
      const type = variable.type;
      if (type.k !== 'chan' && !(type.k === 'prim' && type.name === 'barrier') && !isChanArrayType(type)) return;
      const resolved = this.resolve(arg, frame, 0, env);
      if (resolved) bindings.set(variable, resolved);
    });
    let container = ctx.container;
    if (!ownsNode) {
      const group = this.addNode({
        id: `i${pathKey(ctx.spawn, this.shared.root.uri)}`,
        kind: 'group',
        parent: ctx.container,
        group: 'call',
        label: text,
        name: known ? `${text} (${known})` : text,
        ...(known ? { detail: known } : {}),
        badge: 'call',
        source: { uri: frame.unit.uri, span: call.span },
        confidence,
        procedure: callee.name.name,
        call: callInfo,
        facts: this.procedureFacts(callee),
        operations: [],
      });
      container = group.id;
    }
    this.instances.push({ procedure: callee.name.name, declaration: declaration!, prefix: ctx.path, spawn: ctx.spawn, node: container });
    const calleeFrame: Frame = { decl: callee, unit: calleeUnit!, bindings, instance: ctx.spawn, container, stack: [...frame.stack, callee], depth: frame.depth + 1, values, unfolding: onStack ? [...(frame.unfolding ?? []), key] : frame.unfolding };
    // Everything the callee does is only as certain as the call itself (`if (go) tee(...)`).
    this.runProcedure(calleeFrame, { path: ctx.path, node: ctx.node, container, spawn: ctx.spawn, collapse: true }, confidence);
  }

  /**
   * Whether a recursive call with these arguments stops calling itself within
   * 32 levels: the calls back into the recursion that the body can reach with
   * the known arguments (conditions on them decide), followed until none is left.
   */
  private recursionEnds(callee: A.ProcDecl, unit: NetworkUnit, values: ReadonlyMap<VarInfo, ConstValue>, stack: readonly A.ProcDecl[], depth = 0, seen = new Set<string>()): boolean {
    if (depth >= 32 || !callee.body) return depth < 32;
    const key = `${callee.name.name}@${callee.name.span.start.line}|${[...values].map(([v, x]) => `${v.name}=${x}`).sort().join(',')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const recursiveCalls: Array<{ call: A.Invocation; env: Map<VarInfo, ConstValue> }> = [];
    const onStack = new Set([...stack, callee]);
    const walker = new CodeWalker(this.shared, unit, {
      read: () => undefined,
      write: () => undefined,
      sync: () => undefined,
      call: (call, _confidence, env) => {
        const target = unit.checked.calls.get(call)?.decl;
        if (target && onStack.has(target)) recursiveCalls.push({ call, env: new Map(env) });
      },
    });
    walker.walkBlock(callee.body, 'exact', new Map(values));
    for (const { call, env } of recursiveCalls) {
      const target = unit.checked.calls.get(call)!.decl!;
      const targetUnit = this.shared.unitOf(target);
      if (!targetUnit) return false;
      const next = this.calleeValues(call, target, targetUnit, unit, env);
      const params = target.params.map((param) => this.shared.variableByDecl(targetUnit, param.name)).filter((v): v is VarInfo => !!v && v.type.k === 'prim' && v.type.name !== 'barrier' && v.type.name !== 'timer');
      if (!params.every((v) => next.has(v))) return false;
      if (!this.recursionEnds(target, targetUnit, next, stack, depth + 1, seen)) return false;
    }
    return true;
  }

  /**
   * A callee without a network of its own, handed an array of channels: its
   * code runs in the calling process with the call's channels and known
   * arguments, so each operation lands on the element it uses.
   */
  private inlineCall(call: A.Invocation, callee: A.ProcDecl, calleeUnit: NetworkUnit, values: Map<VarInfo, ConstValue>, frame: Frame, ctx: ProcessCtx, confidence: Confidence, env: ReadonlyMap<VarInfo, ConstValue>): void {
    const bindings = new Map<VarInfo, Binding>();
    callee.params.forEach((param, index) => {
      const variable = this.shared.variableByDecl(calleeUnit, param.name);
      const arg = call.args[index];
      if (!variable || !arg) return;
      const type = variable.type;
      if (type.k !== 'chan' && !(type.k === 'prim' && type.name === 'barrier') && !isChanArrayType(type)) return;
      const resolved = this.resolve(arg, frame, 0, env);
      if (resolved) bindings.set(variable, resolved);
    });
    // A call that leads to no par adds nothing to the path: the callee's locals belong to the calling process.
    const calleeFrame: Frame = { decl: callee, unit: calleeUnit, bindings, instance: ctx.spawn.slice(0, -1), container: ctx.container, stack: [...frame.stack, callee], depth: frame.depth, values, unfolding: frame.unfolding };
    if (callee.body) this.runCode(callee.body.stmts, calleeFrame, { ...ctx, spawn: ctx.spawn.slice(0, -1) }, confidence, new Map(values));
  }

  /** The operations of a callee without its own drawn network, attributed to the calling process. */
  private leafCall(call: A.Invocation, callee: A.ProcDecl, frame: Frame, ctx: ProcessCtx, confidence: Confidence, env: ReadonlyMap<VarInfo, ConstValue> = new Map()): void {
    const uses = this.shared.paramUses(callee);
    call.args.forEach((arg, index) => {
      const paramUses = uses[index];
      if (!paramUses?.length) return;
      const binding = this.resolve(arg, frame, 0, env);
      const parameter = callee.params[index]?.name.name ?? `#${index + 1}`;
      for (const use of paramUses) {
        const tags = ['via call', ...(use.kind === 'alt-guard' ? ['alt'] : use.kind === 'extended-read' ? ['extended'] : [])];
        this.addOperation(ctx.node, binding, {
          kind: use.kind,
          at: use.at,
          confidence: combineConfidence(confidence, use.confidence),
          via: use.via ?? { procedure: callee.name.name, parameter },
        }, use.kind === 'sync' ? [...tags, 'sync'] : tags);
      }
    });
  }

  /** Arguments handed to opaque code: the channel is used in an unknown way. */
  private passArguments(call: A.Invocation, frame: Frame, ctx: ProcessCtx, confidence: Confidence, env: ReadonlyMap<VarInfo, ConstValue> = new Map()): void {
    for (const arg of call.args) {
      if (!isEndArgument(arg) && !this.isResourceArgument(arg, frame)) continue;
      const end = endOfArgument(arg);
      const kind: OperationKind = end === 'read' ? 'read' : end === 'write' ? 'write' : 'pass';
      this.addOperation(ctx.node, this.resolve(arg, frame, 0, env), { kind, at: { uri: frame.unit.uri, span: arg.span }, confidence, via: { procedure: call.name.name, parameter: '?' } }, ['via call']);
    }
  }

  private isResourceArgument(arg: A.Expr, frame: Frame): boolean {
    const type = frame.unit.checked.types.get(arg);
    return type?.k === 'chan' || (type?.k === 'prim' && type.name === 'barrier');
  }

  private callLabel(call: A.Invocation, frame: Frame): string {
    return shortCall(call, (expr) => this.shared.sourceText(frame.unit.uri, expr.span));
  }

  /**
   * How an inline branch is shown: a simple statement as written; anything else
   * by its first communication, with what guards it (or what follows it) on the
   * second line.
   */
  private codeHint(statement: A.Stmt, frame: Frame): { label?: string; detail?: string } {
    const communications: A.Expr[] = [];
    visitStatement(statement, {
      expr: (expr) => {
        if (expr.kind === 'ChanRead' || expr.kind === 'ChanWrite' || expr.kind === 'Sync') {
          const type = frame.unit.checked.types.get(expr.target);
          if (!(type?.k === 'prim' && type.name === 'timer')) communications.push(expr);
        } else if (expr.kind === 'Invocation' && expr.name.name !== 'println' && expr.name.name !== 'print') communications.push(expr);
      },
    });
    const text = (node: { span: A.Span }, fallback: string): string => truncate(stripComments(this.shared.sourceText(frame.unit.uri, node.span) ?? fallback).replace(/;\s*$/, ''), 34);
    if (statement.kind === 'ExprStmt' || statement.kind === 'LocalDecl') return { label: text(statement, communications[0] ? exprLabel(communications[0]) : 'statement') };
    if (!communications.length) {
      const first = statement.kind === 'Block' ? statement.stmts[0] : statement;
      if (!first) return {};
      const more = statement.kind === 'Block' ? statement.stmts.length - 1 : 0;
      return { label: text(first, 'statement'), detail: more > 0 ? `+ ${more} more statement${more === 1 ? '' : 's'}` : undefined };
    }
    const [first, second] = communications;
    const guard = controlText(statement, (expr) => text(expr, exprLabel(expr)));
    return {
      label: text(first, exprLabel(first)),
      detail: guard ?? (second ? `then ${text(second, exprLabel(second))}${communications.length > 2 ? ' …' : ''}` : undefined),
    };
  }

  // -- finishing -------------------------------------------------------------

  /**
   * A process drawn as a container (it runs a par) whose own code also reads,
   * writes or syncs gets a small `own code` box inside it for those operations.
   * An arrow on the container's border then keeps one meaning: every process
   * inside uses the channel.
   */
  private splitOwnCode(): void {
    for (const node of [...this.nodes.values()]) {
      if (node.kind !== 'group' || !node.path || !node.operations.length) continue;
      const id = `${node.id}:own`;
      const own: NetNode = {
        id,
        kind: 'process',
        parent: node.id,
        label: 'own code',
        // The same process: results about it land here, where its operations are drawn.
        name: node.name,
        own: true,
        source: node.source,
        confidence: node.confidence,
        path: node.path,
        procedure: node.procedure,
        facts: ['the code this process runs itself, before, between or after its pars'],
        operations: node.operations,
      };
      this.nodes.set(id, own);
      // First among the container's boxes.
      this.order.splice(this.order.indexOf(node.id) + 1, 0, id);
      this.children.set(node.id, [id, ...(this.children.get(node.id) ?? [])]);
      node.operations = [];
      for (const state of this.channels.values()) {
        const endpoint = state.endpoints.get(node.id);
        if (!endpoint) continue;
        state.endpoints.delete(node.id);
        // Enrolment stays with the container (it is what a par enrolled); the operations move.
        if (endpoint.enrolled) state.endpoints.set(node.id, { ops: [], tags: new Set(), enrolled: true });
        if (endpoint.ops.length) state.endpoints.set(id, { ...endpoint, enrolled: endpoint.enrolled });
      }
    }
  }

  private finish(): { edges: NetEdge[]; channels: NetChannel[] } {
    this.splitOwnCode();
    // Channels of the same declaration in several procedure instances (the stages of an unfolded
    // recursion, each with its own `middle`) are named with the instance's known arguments.
    const byName = new Map<string, ChannelState[]>();
    for (const state of this.channels.values()) byName.set(state.channel.name, [...(byName.get(state.channel.name) ?? []), state]);
    for (const same of byName.values()) {
      if (same.length < 2 || new Set(same.map((state) => state.instance)).size < same.length) continue;
      for (const state of same) if (state.instance) state.channel.name = `${state.channel.name} (${state.instance})`;
    }
    const edges: NetEdge[] = [];
    const channels: NetChannel[] = [];
    let serial = 0;
    const edgeId = (channel: NetChannel): string => `e${serial++}:${channel.id}`;
    for (const state of this.channels.values()) {
      const channel = state.channel;
      const endpoints: NetEndpoint[] = [];
      for (const [node, endpoint] of state.endpoints) {
        endpoints.push({
          node,
          confidence: endpoint.ops.length ? endpoint.ops.map((op) => op.confidence).reduce(bestConfidence) : 'exact',
          operations: endpoint.ops,
          tags: [...endpoint.tags, ...(endpoint.enrolled ? ['enrolled'] : [])],
        });
      }
      if (channel.kind === 'barrier') {
        // The process that declares a barrier is enrolled on it from the start (the runtime's count begins at 1).
        const declarer = channel.port ? undefined : this.declarerOf(channel);
        for (const endpoint of endpoints) if (endpoint.node === declarer && !endpoint.tags.includes('enrolled')) endpoint.tags.push('enrolled');
        // A sync by a process nothing enrolled is not one the barrier counts. Through a parameter, the caller decides.
        if (!channel.port) for (const endpoint of endpoints) if (!endpoint.tags.includes('enrolled')) endpoint.tags.push('not enrolled');
        channel.members = this.withoutEnclosingGroups(endpoints);
        if (!channel.members.length && !channel.port) {
          this.notes.push(`No process drawn here enrolls or syncs on barrier '${channel.name}'.`);
          continue;
        }
        const drawnMembers = this.aggregate(channel.members, [], channel, (end) => !end.tags.includes('not enrolled'));
        const enrolled = this.processTotal(channel.members.filter((member) => member.tags.includes('enrolled')).map((member) => member.node));
        const unenrolled = channel.members.filter((member) => member.tags.includes('not enrolled'));
        const barrierNode = channel.port ?? this.addNode({
          id: `b:${channel.id}`,
          kind: 'barrier',
          parent: channel.container,
          label: channel.name,
          name: `barrier ${channel.name}`,
          source: channel.ref.declaration,
          confidence: 'exact',
          channel: channel.id,
          facts: [
            enrolled.count || enrolled.unsized ? `${countText(enrolled)} enrolled` : 'no process drawn here is enrolled on it',
            ...(unenrolled.length ? [`${unenrolled.map((member) => this.node(member.node).name).join(', ')} ${unenrolled.length === 1 ? 'syncs' : 'sync'} on it without being enrolled: the barrier counts only enrolled processes`] : []),
          ],
          operations: [],
        }).id;
        for (const member of drawnMembers) {
          const loose = member.tags.includes('not enrolled');
          const edge: NetEdge = { id: edgeId(channel), kind: 'barrier', from: barrierNode, to: member.node, channel: channel.id, confidence: member.confidence, role: 'barrier', tags: member.tags, label: loose ? 'not enrolled' : undefined };
          edges.push(edge);
          channel.edges.push(edge.id);
        }
        channels.push(channel);
        continue;
      }
      const isRead = (op: NetOperation): boolean => op.kind === 'read' || op.kind === 'alt-guard' || op.kind === 'extended-read';
      for (const endpoint of endpoints) {
        const reads = endpoint.operations.filter((op) => isRead(op) || op.kind === 'pass');
        const writes = endpoint.operations.filter((op) => op.kind === 'write' || op.kind === 'pass');
        if (writes.length) channel.writers.push({ ...endpoint, operations: writes, confidence: writes.map((op) => op.confidence).reduce(bestConfidence), tags: endpoint.tags.filter((tag) => tag !== 'alt' && tag !== 'extended') });
        // `alt` and `extended` describe the reader only when every read of it is one.
        if (reads.length) channel.readers.push({ ...endpoint, operations: reads, confidence: reads.map((op) => op.confidence).reduce(bestConfidence), tags: endpoint.tags.filter((tag) => (tag !== 'alt' || reads.every((op) => op.kind === 'alt-guard')) && (tag !== 'extended' || reads.every((op) => op.kind === 'extended-read'))) });
      }
      const port = channel.port ? this.node(channel.port) : undefined;
      // One arrow from a box whose every process writes (or reads) the channel.
      const writers = this.aggregate(channel.writers, channel.readers, channel);
      const readers = this.aggregate(channel.readers, channel.writers, channel);
      // The environment beyond a port is the other side.
      if (port?.port?.direction === 'in' || (port && port.port?.direction === 'unknown' && readers.length)) writers.unshift({ node: port.id, confidence: 'exact', tags: ['port'] });
      if (port?.port?.direction === 'out' || (port && port.port?.direction === 'unknown' && writers.length && !readers.length)) readers.push({ node: port.id, confidence: 'exact', tags: ['port'] });
      if (!writers.length && !readers.length) {
        if (!port) this.notes.push(`No process drawn here reads or writes channel '${channel.name}'.`);
        channels.push(channel);
        continue;
      }
      const label = channelLabel(channel);
      const tags = [...new Set([...(channel.shared.read ? ['shared read'] : []), ...(channel.shared.write ? ['shared write'] : [])])];
      if (!readers.length || !writers.length) {
        const side = readers.length ? 'no-writer' : 'no-reader';
        const proven = channel.hazard === side;
        const ends = readers.length ? readers : writers;
        const stub = this.addNode({
          id: `s:${channel.id}`,
          kind: 'stub',
          // Beside the processes it would connect to, not inside one of them.
          parent: this.lowestCommonParent(ends.map((end) => end.node)),
          label: side === 'no-writer' ? 'no writer' : 'no reader',
          name: `${side === 'no-writer' ? 'missing writer' : 'missing reader'} of ${channel.name}`,
          source: channel.ref.declaration,
          confidence: proven ? 'exact' : 'unknown',
          stub: { side, proven },
          channel: channel.id,
          facts: [proven ? `the checker proved nothing ever ${side === 'no-writer' ? 'writes' : 'reads'} '${channel.name}'` : `no ${side === 'no-writer' ? 'writer' : 'reader'} of '${channel.name}' is drawn in this view`],
          operations: [],
        });
        channel.stub = stub.id;
        ends.forEach((end, index) => {
          const edge: NetEdge = readers.length
            ? { id: edgeId(channel), kind: 'channel', from: stub.id, to: end.node, channel: channel.id, confidence: end.confidence, role: 'dangling', tags: [...tags, ...end.tags], label: index === 0 ? label : undefined }
            : { id: edgeId(channel), kind: 'channel', from: end.node, to: stub.id, channel: channel.id, confidence: end.confidence, role: 'dangling', tags: [...tags, ...end.tags], label: index === 0 ? label : undefined };
          edges.push(edge);
          channel.edges.push(edge.id);
        });
        channels.push(channel);
        continue;
      }
      if (writers.length === 1 && readers.length === 1) {
        const [writer] = writers;
        const [reader] = readers;
        const edge: NetEdge = {
          id: edgeId(channel),
          kind: 'channel',
          from: writer.node,
          to: reader.node,
          channel: channel.id,
          label,
          confidence: combineConfidence(writer.confidence, reader.confidence),
          role: writer.node === reader.node ? 'self' : 'direct',
          tags: [...tags, ...new Set([...writer.tags, ...reader.tags])],
        };
        edges.push(edge);
        channel.edges.push(edge.id);
        channels.push(channel);
        continue;
      }
      const junction = this.addNode({
        id: `j:${channel.id}`,
        kind: 'junction',
        parent: this.lowestCommonParent([...writers, ...readers].map((end) => end.node)),
        label,
        name: `channel ${channel.name}`,
        source: channel.ref.declaration,
        confidence: 'exact',
        channel: channel.id,
        // Processes, not drawn arrows: a par for box writes once per iteration.
        facts: [`${countText(this.processTotal(channel.writers.map((end) => end.node)), 'writer')}, ${countText(this.processTotal(channel.readers.map((end) => end.node)), 'reader')}${port ? ', and the environment through the parameter' : ''}`],
        operations: [],
      });
      channel.junction = junction.id;
      for (const writer of writers) {
        const edge: NetEdge = { id: edgeId(channel), kind: 'channel', from: writer.node, to: junction.id, channel: channel.id, confidence: writer.confidence, role: 'fan-in', tags: [...tags, ...writer.tags] };
        edges.push(edge);
        channel.edges.push(edge.id);
      }
      for (const reader of readers) {
        const edge: NetEdge = { id: edgeId(channel), kind: 'channel', from: junction.id, to: reader.node, channel: channel.id, confidence: reader.confidence, role: 'fan-out', tags: [...tags, ...reader.tags] };
        edges.push(edge);
        channel.edges.push(edge.id);
      }
      channels.push(channel);
    }
    return { edges, channels };
  }

  /**
   * Draw one arrow from a box instead of one from each process in it when every
   * process drawn in the box plays the same part on the channel (all write it,
   * all read it, all are enrolled). Never past the box that declares the channel,
   * and never into a box holding the other side.
   */
  private aggregate(ends: readonly { node: string; confidence: Confidence; tags: string[] }[], others: readonly { node: string }[], channel: NetChannel, mergeable: (end: { tags: string[] }) => boolean = () => true): Array<{ node: string; confidence: Confidence; tags: string[] }> {
    let current = ends.map((end) => ({ node: end.node, confidence: end.confidence, tags: [...end.tags] }));
    const blocked = new Set<string>();
    for (let node = channel.container; node; node = this.nodes.get(node)?.parent) blocked.add(node);
    for (let changed = true; changed;) {
      changed = false;
      const members = new Map(current.map((end) => [end.node, end]));
      const parents = [...new Set(current.map((end) => this.nodes.get(end.node)?.parent).filter((id): id is string => !!id && !blocked.has(id)))];
      for (const parent of parents) {
        const kids = (this.children.get(parent) ?? []).filter((id) => {
          const kind = this.nodes.get(id)?.kind;
          return kind === 'process' || kind === 'group';
        });
        if (kids.length < 2 || !kids.every((id) => members.has(id))) continue;
        if (others.some((other) => other.node === parent || this.isAncestor(parent, other.node))) continue;
        const merged = kids.map((id) => members.get(id)!);
        // A process that only syncs keeps its own (warning) link: one arrow for the box would say it is enrolled.
        if (!merged.every(mergeable) || (members.has(parent) && !mergeable(members.get(parent)!))) continue;
        const own = members.get(parent);
        const confidence = merged.map((end) => end.confidence).reduce(combineConfidence);
        current = current.filter((end) => !kids.includes(end.node) && end.node !== parent);
        current.push({ node: parent, confidence: own ? bestConfidence(own.confidence, confidence) : confidence, tags: [...new Set([...merged.flatMap((end) => end.tags), ...(own?.tags ?? []), 'every process inside'])] });
        changed = true;
        break;
      }
    }
    const order = new Map(this.order.map((id, index) => [id, index]));
    return current.sort((a, b) => (order.get(a.node) ?? 0) - (order.get(b.node) ?? 0));
  }

  /**
   * A barrier member that is a group whose processes inside are enrolled members
   * too is drawn through them. One whose processes inside only sync keeps its own
   * link: it is the one the barrier counts.
   */
  private withoutEnclosingGroups(members: NetEndpoint[]): NetEndpoint[] {
    return members.filter((member) => {
      if (member.operations.length) return true;
      const inside = members.filter((other) => other.node !== member.node && this.isAncestor(member.node, other.node));
      return !inside.length || !inside.every((other) => other.tags.includes('enrolled'));
    });
  }

  /** The drawn process that declared a local barrier: the instance its owner path names. */
  private declarerOf(channel: NetChannel): string | undefined {
    const owner = channel.ref.owner;
    const path = owner.length && owner[owner.length - 1].kind === 'call' ? owner.slice(0, -1) : owner;
    for (const node of this.nodes.values()) if (node.path && samePath(node.path, path)) return node.id;
    return undefined;
  }

  private processTotal(ids: readonly string[]): ProcessTotal {
    return processTotal(this.nodes, ids);
  }

  private isAncestor(ancestor: string, id: string): boolean {
    for (let node = this.nodes.get(id)?.parent; node; node = this.nodes.get(node)?.parent) if (node === ancestor) return true;
    return false;
  }

  private lowestCommonParent(ids: string[]): string | undefined {
    const chains = ids.map((id) => {
      const chain: string[] = [];
      for (let node = this.nodes.get(id)?.parent; node; node = this.nodes.get(node)?.parent) chain.unshift(node);
      return chain;
    });
    let common: string | undefined;
    for (let depth = 0; ; depth++) {
      const at = chains[0]?.[depth];
      if (!at || !chains.every((chain) => chain[depth] === at)) return common;
      common = at;
    }
  }
}

// Variable lookups are frequent and the checker keeps no index from declarator to variable.
const variableIndexes = new WeakMap<CheckResult, Map<A.Ident, VarInfo>>();

function variableIndex(checked: CheckResult): Map<A.Ident, VarInfo> {
  let index = variableIndexes.get(checked);
  if (!index) {
    index = new Map(checked.vars.map((variable) => [variable.decl, variable]));
    variableIndexes.set(checked, index);
  }
  return index;
}

function inside(outer: A.Span, inner: A.Span): boolean {
  const before = (a: A.Pos, b: A.Pos): boolean => a.line < b.line || (a.line === b.line && a.col <= b.col);
  return before(outer.start, inner.start) && before(inner.end, outer.end);
}

/** Processes some boxes stand for: `count` from boxes whose par for counts are known, `unsized` boxes inside a par for of unknown size. */
export interface ProcessTotal {
  count: number;
  unsized: number;
}

/** How many processes some drawn boxes stand for, a par for box counting each of its iterations. */
export function processTotal(nodes: ReadonlyMap<string, NetNode>, ids: readonly string[]): ProcessTotal {
  const total: ProcessTotal = { count: 0, unsized: 0 };
  const seen = new Set<string>();
  for (const id of new Set(ids)) {
    // A container and its `own code` box are one process.
    const path = nodes.get(id)?.path;
    const key = path ? `path:${path.map((step) => `${step.kind}:${step.site.uri}:${step.site.span.start.line}:${step.site.span.start.col}:${step.index ?? ''}`).join('/')}` : id;
    if (seen.has(key)) continue;
    seen.add(key);
    let factor: number | undefined = 1;
    for (let node = nodes.get(id); node && factor !== undefined; node = node.parent ? nodes.get(node.parent) : undefined) {
      if (node.replicated) factor = node.replicated.count === undefined ? undefined : factor * node.replicated.count;
    }
    if (factor === undefined) total.unsized++;
    else total.count += factor;
  }
  return total;
}

/** Every process a view draws below its root: calls, branches, statements of a par for body, each par for iteration. */
export function viewProcesses(view: NetworkView): ProcessTotal {
  const nodes = new Map(view.nodes.map((node) => [node.id, node]));
  // In a CSPm view a group is a composition, not a process of its own: only its operands count.
  return processTotal(nodes, view.nodes.filter((node) => node.path && node.path.length > 0 && !node.statements && !node.own && (view.language !== 'cspm' || node.kind === 'process')).map((node) => node.id));
}

/** `4 processes`, `2 processes and a par for of unknown size`. */
export function countText(total: ProcessTotal, noun = 'process'): string {
  const plural = (count: number): string => `${count} ${noun}${count === 1 ? '' : noun.endsWith('s') ? 'es' : 's'}`;
  if (!total.unsized) return plural(total.count);
  const unknown = `${total.unsized === 1 ? 'a par for' : `${total.unsized} par fors`} of unknown size`;
  return total.count ? `${plural(total.count)} and ${unknown}` : `the ${noun}${noun.endsWith('s') ? 'es' : 's'} of ${unknown}`;
}

/** Whether a procedure body contains a par or par for (directly; calls are followed by the effect summary). */
function hasSpawn(decl: A.ProcDecl): boolean {
  return !!decl.body && spawnCount(decl.body.stmts) > 0;
}

function rootName(expr: A.Expr): A.NameExpr | undefined {
  while (expr.kind === 'ParenExpr' || expr.kind === 'CastExpr' || expr.kind === 'ChanEnd') expr = expr.kind === 'ChanEnd' ? expr.target : expr.expr;
  return expr.kind === 'NameExpr' ? expr : undefined;
}

function isEndArgument(expr: A.Expr): boolean {
  while (expr.kind === 'ParenExpr' || expr.kind === 'CastExpr') expr = expr.expr;
  return expr.kind === 'ChanEnd';
}

function endOfArgument(expr: A.Expr): 'read' | 'write' | undefined {
  while (expr.kind === 'ParenExpr' || expr.kind === 'CastExpr') expr = expr.expr;
  return expr.kind === 'ChanEnd' ? expr.end : undefined;
}

/** `size = 5, n = 2`: the data arguments a procedure instance is known to have. */
function valuesText(values: ReadonlyMap<VarInfo, ConstValue> | undefined): string | undefined {
  if (!values?.size) return undefined;
  return [...values].map(([variable, value]) => `${variable.name} = ${String(value)}`).join(', ');
}

function channelLabel(channel: NetChannel): string {
  return `${channel.name} : ${channel.type}`;
}

/** `delta(in, out1, out2)`, with the parameter list cut short for long signatures. */
function shortSignature(decl: A.ProcDecl, limit = 48): string {
  const names = decl.params.map((param) => param.name.name);
  const kept: string[] = [];
  for (const name of names) {
    if (`${decl.name.name}(${[...kept, name].join(', ')}${kept.length + 1 < names.length ? ', …' : ''})`.length > limit) break;
    kept.push(name);
  }
  return `${decl.name.name}(${[...kept, ...(kept.length < names.length ? ['…'] : [])].join(', ')})`;
}

/** The call as written, shortened: channel ends lose `.read`/`.write`, long expressions become `…`. */
export function shortCall(call: A.Invocation, text: (expr: A.Expr) => string | undefined, limit = 30): string {
  const args = call.args.map((arg) => {
    let inner = arg;
    while (inner.kind === 'ParenExpr' || inner.kind === 'CastExpr') inner = inner.expr;
    if (inner.kind === 'ChanEnd') return exprLabel(inner.target);
    if (inner.kind === 'NameExpr' || inner.kind === 'Literal' || inner.kind === 'RecordAccess') return exprLabel(inner);
    const written = text(arg)?.replace(/\s+/g, ' ');
    return written && written.length <= 12 ? written : '…';
  });
  const name = call.name.name;
  const full = `${name}(${args.join(', ')})`;
  if (full.length <= limit) return full;
  // Keep the leading arguments that fit, then an ellipsis.
  const kept: string[] = [];
  for (const arg of args) {
    if (`${name}(${[...kept, arg].join(', ')}, …)`.length > limit) break;
    kept.push(arg);
  }
  return `${name}(${[...kept, '…'].join(', ')})`;
}

export function exprLabel(expr: A.Expr): string {
  switch (expr.kind) {
    case 'NameExpr': return expr.name.name;
    case 'Literal': return expr.text.length > 12 ? `${expr.text.slice(0, 11)}…` : expr.text;
    case 'RecordAccess': return `${exprLabel(expr.target)}.${expr.member.name}`;
    case 'ArrayAccess': return `${exprLabel(expr.target)}[${expr.index.kind === 'NameExpr' || expr.index.kind === 'Literal' ? exprLabel(expr.index) : '…'}]`;
    case 'ChanEnd': return `${exprLabel(expr.target)}.${expr.end}`;
    case 'ParenExpr':
    case 'CastExpr': return exprLabel(expr.expr);
    case 'ChanRead': return `${exprLabel(expr.target)}.read()`;
    case 'ChanWrite': return `${exprLabel(expr.target)}.write(${exprLabel(expr.value)})`;
    case 'Sync': return `${exprLabel(expr.target)}.sync()`;
    case 'Invocation': return `${expr.name.name}(${expr.args.length ? '…' : ''})`;
    case 'BinaryExpr': return `${exprLabel(expr.left)} ${expr.op} ${exprLabel(expr.right)}`;
    default: return '…';
  }
}

function headerText(statement: A.ParBlock | A.ForStmt, shared: SharedAnalysis, uri: string): string {
  if (statement.kind === 'ParBlock') return statement.barriers.length ? `par enroll (${statement.barriers.map(exprLabel).join(', ')})` : 'par';
  const bound = statement.cond ? shared.sourceText(uri, statement.cond.span) ?? exprLabel(statement.cond) : '';
  return `par for ${bound}`.trim();
}

/** Source text without comments, on one line. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ').replace(/\s+/g, ' ').trim();
}

/** What guards the communication of a compound statement: `if l != 5`, `while (true)`, `alt`. */
function controlText(statement: A.Stmt, text: (expr: A.Expr) => string): string | undefined {
  switch (statement.kind) {
    case 'IfStmt': return `if ${text(statement.cond)}`;
    case 'WhileStmt': return `in while (${text(statement.cond)})`;
    case 'DoStmt': return 'in a do loop';
    case 'ForStmt': return statement.cond ? `in for (… ${text(statement.cond)} …)` : 'in a for loop';
    case 'AltStmt': return `one of ${statement.cases.length} alt guards`;
    case 'SwitchStmt': return `in switch (${text(statement.expr)})`;
    default: return undefined;
  }
}

export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

function fileUri(file: string | undefined): string | undefined {
  if (!file) return undefined;
  if (!/^[a-z]:[\\/]/i.test(file) && /^[a-z][a-z0-9+.-]*:/i.test(file)) return file;
  return `file://${file.split('\\').join('/').replace(/^([^/])/, '/$1')}`;
}

/** Compact, id-safe rendering of a path; steps in another file carry a short hash of its URI. */
export function pathKey(path: ProcessPath, rootUri: string): string {
  return path.map((step) => `${step.kind[0]}${uriTag(step.site.uri, rootUri)}${step.site.span.start.line}_${step.site.span.start.col}${step.index === undefined ? '' : `_${step.index}`}`).map((part) => `.${part}`).join('');
}

function uriTag(uri: string, rootUri: string): string {
  if (uri === rootUri) return '';
  let hash = 0x811c9dc5;
  for (let i = 0; i < uri.length; i++) hash = Math.imul(hash ^ uri.charCodeAt(i), 0x01000193) >>> 0;
  return `${hash.toString(36)}-`;
}

// ---------------------------------------------------------------------------
// Finding drawn elements for verification results
// ---------------------------------------------------------------------------

export interface ProcessMatch {
  node: NetNode;
  /** False when only an enclosing process is drawn (a collapsed call, a hidden iteration). */
  exact: boolean;
}

/** The drawn process for a path: an exact (par for wildcard) match, else the nearest drawn ancestor. */
export function findProcess(view: NetworkView, path: ProcessPath): ProcessMatch | undefined {
  let exact: NetNode | undefined;
  let ancestor: NetNode | undefined;
  for (const node of view.nodes) {
    if (!node.path) continue;
    if (pathMatches(node.path, path)) {
      if (!exact || samePath(node.path, path)) exact = node;
    } else if (node.path.length < path.length && pathMatches(node.path, path.slice(0, node.path.length)) && (!ancestor || node.path.length > ancestor.path!.length)) {
      ancestor = node;
    }
  }
  if (exact) return { node: exact, exact: true };
  if (!ancestor) return undefined;
  // The nearest drawn ancestor stands in only for processes this view does not
  // draw: inside a collapsed call, or below a box with no drawn processes. A
  // path that should be among drawn siblings but is not is simply not here.
  const depth = ancestor.path!.length;
  const below = view.nodes.filter((node) => node.path && node.path.length > depth && pathMatches(ancestor!.path!, node.path.slice(0, depth)));
  if (!below.length) return { node: ancestor, exact: false };
  const next = path[depth];
  const drawnNext = below.some((node) => pathMatches([node.path![depth]], [next]));
  return next.kind === 'call' && !drawnNext ? { node: ancestor, exact: false } : undefined;
}

/**
 * The drawn channel (or barrier) for a reference: same declarator and owner,
 * tolerating the owner written with or without the call steps; a declarator
 * drawn once is accepted whatever owner the producer computed.
 */
export function findChannel(view: NetworkView, ref: ChannelRef): { channel: NetChannel; exact: boolean } | undefined {
  if (!ref.declaration) {
    const named = view.channels.filter((channel) => channel.name === ref.name && channel.kind === ref.kind);
    return named.length === 1 ? { channel: named[0], exact: false } : undefined;
  }
  const declared = view.channels.filter((channel) => channel.ref.declaration && sameSource(channel.ref.declaration, ref.declaration!) && (channel.ref.name === ref.name || channel.ref.name.startsWith(`${ref.name}.`) || ref.name.startsWith(`${channel.ref.name}.`)));
  const exact = declared.find((channel) => pathMatches(channel.ref.owner, ref.owner) || pathMatches(ref.owner, channel.ref.owner));
  if (exact) return { channel: exact, exact: true };
  const withoutCalls = (path: ProcessPath): ProcessPath => path.filter((step) => step.kind !== 'call');
  const loose = declared.find((channel) => pathMatches(withoutCalls(channel.ref.owner), withoutCalls(ref.owner)));
  if (loose) return { channel: loose, exact: true };
  return declared.length === 1 ? { channel: declared[0], exact: false } : undefined;
}

/** Drawn operations whose source overlaps a program point. */
export function findOperations(view: NetworkView, at: SourceRef): Array<{ node: NetNode; operation: NetOperation }> {
  const out: Array<{ node: NetNode; operation: NetOperation }> = [];
  for (const node of view.nodes) {
    for (const operation of node.operations) if (operation.at.uri === at.uri && overlaps(operation.at.span, at.span)) out.push({ node, operation });
  }
  return out;
}

/** The drawn element for a process, a channel, or a statement. */
export function locate(view: NetworkView, target: { process?: ProcessPath; channel?: ChannelRef; at?: SourceRef }): { node?: NetNode; channel?: NetChannel; exact: boolean } | undefined {
  if (target.process) {
    const match = findProcess(view, target.process);
    if (match) return { node: match.node, exact: match.exact };
  }
  if (target.channel) {
    const match = findChannel(view, target.channel);
    if (match) return { channel: match.channel, exact: match.exact };
  }
  if (target.at) {
    const [first] = findOperations(view, target.at);
    if (first) return { node: first.node, channel: view.channels.find((channel) => channel.id === first.operation.channel), exact: false };
  }
  return undefined;
}

export function sameSource(left: SourceRef, right: SourceRef): boolean {
  return left.uri === right.uri
    && left.span.start.line === right.span.start.line
    && left.span.start.col === right.span.start.col
    && left.span.end.line === right.span.end.line
    && left.span.end.col === right.span.end.col;
}

/** Half-open spans that share at least one position, or a point inside the other. */
export function overlaps(left: A.Span, right: A.Span): boolean {
  const before = (a: A.Pos, b: A.Pos): boolean => a.line < b.line || (a.line === b.line && a.col < b.col);
  const leftEmpty = !before(left.start, left.end);
  const rightEmpty = !before(right.start, right.end);
  if (leftEmpty || rightEmpty) {
    const point = leftEmpty ? left.start : right.start;
    const span = leftEmpty ? right : left;
    return !before(point, span.start) && (before(point, span.end) || (leftEmpty && rightEmpty));
  }
  return before(left.start, right.end) && before(right.start, left.end);
}

/**
 * A producer's path in the view's terms. A par for whose body has several
 * statements is drawn as the compiled program runs it, each statement a
 * process of its own below the par for's box; the language (and so the CSP
 * model) runs each iteration as one process, whose paths have no step for the
 * statement. Below such a par for the step is added: the statement that
 * contains the next spawn site.
 */
export function viewPath(view: NetworkView, path: ProcessPath): ProcessPath {
  const groups = view.nodes.filter((node) => node.path && (node.statements ?? 0) > 1);
  if (!groups.length || !path.some((step) => step.kind === 'par-for')) return path;
  const out: ProcessPath = [];
  path.forEach((step, index) => {
    out.push(step);
    const next = path[index + 1];
    if (step.kind !== 'par-for' || !next) return;
    const group = groups.find((node) => pathMatches(node.path!, out));
    if (!group) return;
    const depth = group.path!.length;
    const statements = view.nodes.filter((node) => node.parent === group.id && node.path?.length === depth + 1).map((node) => node.path![depth]);
    if (statements.some((statement) => pathMatches([statement], [next]))) return;
    const holder = statements.find((statement) => statement.site.uri === next.site.uri && spanContains(statement.site.span, next.site.span));
    if (holder) out.push(holder);
  });
  return out;
}

function spanContains(outer: A.Span, inner: A.Span): boolean {
  const before = (a: A.Pos, b: A.Pos): boolean => a.line < b.line || (a.line === b.line && a.col <= b.col);
  return before(outer.start, inner.start) && before(inner.end, outer.end);
}

/** Paths of a procedure instance's processes as seen from the view root: [] is the instance's own process. */
export function relocatePath(instance: NetInstance, path: ProcessPath): ProcessPath {
  return path.length === 0 ? instance.prefix : [...instance.spawn, ...path];
}

export function relocateChannel(instance: NetInstance, ref: ChannelRef): ChannelRef {
  return { ...ref, owner: ref.owner.length === 0 ? instance.spawn : [...instance.spawn, ...ref.owner] };
}


/** `chan<T>[]`: an array of channels (one dimension; deeper ones are not drawn element by element). */
function isChanArrayType(type: { k: string; elem?: unknown } | undefined): boolean {
  return type?.k === 'array' && (type.elem as { k?: string } | undefined)?.k === 'chan';
}
