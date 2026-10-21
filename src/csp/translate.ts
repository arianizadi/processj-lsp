/**
 * ProcessJ -> CSPm: a whole program from `main`, or one procedure with a test
 * harness around it. See docs/DETAILS.md ("Convert to CSP and check with
 * FDR") for the encoding and every abstraction it makes; lower.ts, gen.ts and
 * network.ts hold the pieces.
 */
import * as path from 'node:path';
import type * as A from '../parser/ast';
import type { CommentToken } from '../tokens';
import type { CheckResult, VarInfo } from '../checker/checker';
import { analyzeProcedureEffects } from '../checker/effects';
import type { DeclIndex } from '../checker/index';
import type { ChannelRef, CheckProperty, SourceRef } from '../verification';
import { commentText, E, mangle, NameTable, rangeText, show, type Ex } from './cspm';
import { ARRAY_HELPERS, D, DataModel, describe, inferRange, INT_HELPERS, type DType } from './data';
import { forkSetName, prepareProc, type ForkChannel, type GeneratedProc, type PreparedProc } from './gen';
import { charCode, forEachChildExpr, forEachChildStmt, forEachExprInStmt, parseIntLiteral, startProcedure, type ChannelKind, type LocalResource, type LowerContext, type ProcIR, type UnitIR } from './lower';
import { STANDARD_CHECKS, type CheckedWith, type CspAssertion, type CspChannelInfo, type CspDefinitionInfo, type CspDiagnostic, type CspModel, type CspNetworkNode, type CspProcessInfo, type CspSourceMap, type CspTransition, type TranslateOptions } from './model';
import { assignPositions, buildNetwork, instanceFunctionName, isTooBig, type Binding, type NetworkInput, type ObservedCall, type RootInstance } from './network';
import { fixedParams, structuralParams } from './structure';
import { miscompilations } from './miscompile';
import { reachability } from './reach';
import { saturate, type Saturation } from './relevance';

/** One checked program: the document itself first, then imported programs whose procedures it may call. */
export interface CspUnit {
  program: A.Program;
  checked: CheckResult;
  /** Absolute path, when the program is a file. */
  file?: string;
  /** LSP document URI (or pathToFileURL(file)) for source references. */
  uri: string;
  /** Source text: comments with //@csp directives and statement text in the CSPm comments. */
  text?: string;
  /** Comments of the program (from parse()); //@csp directives are read from these. */
  comments?: readonly CommentToken[];
}

export interface TranslateInput {
  /** The document first. */
  units: CspUnit[];
  /** Declarations visible to the document: its own, its imports, std. */
  index: DeclIndex;
  options?: TranslateOptions;
}

/** Translate a whole program, starting at its `main`. */
export function translateProgram(input: TranslateInput): CspModel {
  return translate(input, { kind: 'program' });
}

/** Translate one procedure with a harness: dedicated channels for its channel parameters, every value for its data parameters. */
export function translateProcedure(input: TranslateInput, name: string, at?: A.Pos): CspModel {
  return translate(input, { kind: 'procedure', name, at });
}

/**
 * What a procedure's own graph view is drawn with (graph/network.ts
 * procedureArguments): the arguments every instance of its check shares, a
 * channel-array parameter by its length. Undefined when it is checked with
 * every value.
 */
export function drawnArguments(model: Pick<CspModel, 'checkedWith'>): { values: Record<string, number | boolean>; arrays: Record<string, number>; text: string } | undefined {
  const instances = model.checkedWith?.instances;
  if (!instances?.length) return undefined;
  const common = <T>(of: (i: CheckedWith['instances'][number]) => Record<string, T>): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const [name, v] of Object.entries(of(instances[0]))) if (instances.every((i) => Object.prototype.hasOwnProperty.call(of(i), name) && of(i)[name] === v)) out[name] = v;
    return out;
  };
  const values = common((i) => i.values);
  const arrays = common((i) => i.arrays);
  const parts = [...Object.entries(arrays).map(([n, v]) => `${n} of length ${v}`), ...Object.entries(values).map(([n, v]) => `${n} = ${v}`)];
  if (!parts.length) return undefined;
  const differ = [...new Set(instances.flatMap((i) => [...Object.keys(i.values), ...Object.keys(i.arrays)]))].filter((n) => !(n in values) && !(n in arrays));
  return { values, arrays, text: `${listText(parts)}${differ.length ? ` (${listText(differ)} ${differ.length === 1 ? 'differs' : 'differ'} between the instances checked, so ${differ.length === 1 ? 'it is' : 'they are'} not fixed here)` : ''}` };
}

/**
 * Channels whose users a par cannot compose with plain synchronisation (a
 * branch that both writes and reads a channel others use too) become
 * mediated: a server process takes each written value and hands it to one
 * reader. The kind is decided per group of channels that values can flow
 * between, so a translation that finds such a channel starts over.
 */
function translate(input: TranslateInput, target: Target): CspModel {
  const mediated = new Set<string>();
  // A checked procedure whose data parameters decide its network is translated again with the
  // arguments it is checked with (their values widen the inferred integers).
  let plan: InstancePlan | undefined;
  for (let round = 0; ; round++) {
    const t = new Translation(input, target, mediated, plan);
    const model = t.run();
    if (!plan && t.plan) {
      plan = t.plan;
      round--;
      continue;
    }
    const more = t.retry.filter((slot) => !mediated.has(slot));
    if (more.length === 0 || round >= 3) return model;
    for (const slot of more) mediated.add(slot);
  }
}

/**
 * The arguments a procedure checked on its own is elaborated with, when some
 * of its data parameters decide its network (structure.ts): one tuple per
 * distinct set of values its calls from the program give (or a //@csp check
 * directive names); a parameter no tuple fixes takes every modelled value for
 * which the network is finite, each value an instance of its own.
 */
interface InstancePlan {
  /** Parameter indices each instance fixes: data parameters, and channel-array parameters by their length. */
  params: number[];
  source: 'calls' | 'directive' | 'range';
  tuples: Array<{ values: Map<number, number | boolean>; sites: SourceRef[] }>;
  /** Integers the tuples use: the inferred range must hold them. */
  literals: number[];
  /** Said while planning (a //@csp check that is ignored): the translation with the plan reports them. */
  warnings: CspDiagnostic[];
}

/** At most this many instances of a checked procedure (argument tuples). */
const MAX_INSTANCES = 64;

const LINTS = new Map<string, string>([
  ['pj/par-for-body', 'the model runs each par for iteration as one process (the language), while this ProcessJ build runs every statement of the body as its own process'],
  ['pj/timeout-deadline', 'time is abstract in the model, so this timeout is any wait; the compiled program treats the argument as an absolute deadline'],
  ['pj/shared-unlocked-end', 'the model locks shared channel ends (the language); this ProcessJ build does not lock this one and can hang where the model does not'],
  ['pj/multiple-alts', 'this ProcessJ build cannot compile this second replicated alt in one process; the model treats it like any other alt'],
  ['pj/compiler-limit', 'this ProcessJ build cannot compile this; the model follows the language'],
  ['pj/starving-loop', 'the model treats this loop as a livelock (it diverges); under the ProcessJ scheduler it freezes every process'],
  ['pj/parallel-usage', 'a variable shared by par branches without synchronisation: in the model each branch works on its own copy from before the par, and a value assigned by several branches is any of theirs'],
  ['pj/shared-channel-end', 'an unshared channel end used by several processes: the model lets them all use it'],
  ['pj/channel-direction', 'an operation on the wrong end of a channel: the model performs the operation as written'],
]);

/** Operators whose result is abstract when an operand is (literals in them never become modelled integers). */
const ARITHMETIC = new Set(['+', '-', '*', '/', '%', '<<', '>>', '>>>', '&', '|', '^']);

interface Target {
  kind: 'program' | 'procedure';
  name?: string;
  at?: A.Pos;
}

class Translation {
  private readonly units: UnitIR[];
  private readonly unitOf = new Map<A.ProcDecl, UnitIR>();
  private readonly names = new NameTable([
    'Int_t', 'PJ_Any', 'PJ_AnyT', 'pj_any', 'MAIN', 'PJ_NET', 'PJ_DONE', 'PJ_NOERR', 'PJ_HIDDEN', 'PJ_BAR', 'PJ_BAR_S', 'PJ_BAR_R', 'PJBarOp', 'pj_call', 'PJ_MED', 'PJ_SAFE',
    'pj_sync', 'pj_go', 'pj_resign', 'pj_enroll', 'pj_end', 'pj_tick', 'pj_skip', 'pj_timeout', 'pj_done', 'pj_error', 'PJ_Error', 'pj_no_error', 'pj_result',
    'Int_s', 'PJ_SAT', 'pj_sat', 'pj_satv', 'pj_clamp', 'PJ_ENROLLS', 'PJ_LOCAL', 'PJ_NET_B', 'PJ_RUN',
  ]);
  private readonly warnings: CspDiagnostic[] = [];
  private readonly unsupported: CspDiagnostic[] = [];
  private readonly procs = new Map<A.ProcDecl, ProcIR>();
  private readonly pending: Array<() => void> = [];
  private data!: DataModel;
  private readonly ackSlots = new UnionFind();
  private readonly extended = new Set<string>();
  private readonly procIds = new Map<A.ProcDecl, number>();
  private readonly localNames = new Map<A.Ident, string>();
  /** Procedures that call themselves, directly or through others. */
  private readonly recursive = new Set<A.ProcDecl>();
  private readonly baseNames = new Map<A.ProcDecl, string>();
  private root!: A.ProcDecl;
  private rootUnit!: UnitIR;
  private saturation: Saturation = { vars: new Map(), groups: new Set(), sites: 0 };
  private intSource: CspModel['intRange']['source'] = 'inferred';

  /** Channel groups (union-find slots) the network could not compose: the next round mediates them. */
  readonly retry: string[] = [];

  /** Set when a procedure check needs a second translation with the arguments it is checked with (translate()). */
  plan?: InstancePlan;
  private checkedWith?: CheckedWith;

  constructor(
    private readonly input: TranslateInput,
    private readonly target: Target,
    private readonly mediatedSlots: ReadonlySet<string> = new Set(),
    private readonly planned?: InstancePlan,
    /** A program translation that collects the calls elaboration unfolds (call sites of a checked procedure). */
    private readonly observe?: (call: ObservedCall) => void,
  ) {
    this.units = input.units.map((u) => ({ program: u.program, checked: u.checked, file: u.file, uri: u.uri, text: u.text }));
    if (planned) this.warnings.push(...planned.warnings);
    for (const u of this.units) for (const d of u.program.decls) if (d.kind === 'ProcDecl' && !this.unitOf.has(d)) this.unitOf.set(d, u);
  }

  run(): CspModel {
    const rootUnit = this.units[0];
    const fail = (message: string): CspModel => this.failed(message);
    if (!rootUnit) return fail('nothing to translate');
    this.rootUnit = rootUnit;
    const procedures = rootUnit.program.decls.filter((d): d is A.ProcDecl => d.kind === 'ProcDecl' && !!d.body);
    const wanted = this.target.kind === 'program' ? 'main' : this.target.name!;
    const candidates = procedures.filter((p) => p.name.name === wanted);
    const at = this.target.at;
    const root = at ? candidates.find((p) => contains(p.span, at)) ?? candidates[0] : candidates[0];
    if (!root) return fail(this.target.kind === 'program' ? 'the program has no main procedure' : `there is no procedure '${wanted}' with a body`);
    this.root = root;

    const directives = this.directives(rootUnit, this.input.units[0]?.comments);
    for (const c of directives.checks) {
      if (!procedures.some((p) => p.name.name === c.name)) this.warnings.push({ message: `//@csp check names '${c.name}', which is not a procedure with a body in this file; ignored`, at: c.at });
    }
    const reachable = this.reachable(root);
    // Integers.
    const options = this.input.options ?? {};
    let lo: number;
    let hi: number;
    if (options.intRange) {
      ({ lo, hi } = options.intRange);
      this.intSource = 'option';
    } else if (directives.range) {
      ({ lo, hi } = directives.range);
      this.intSource = 'comment';
    } else {
      const literals = this.literals(reachable);
      const inferred = inferRange(literals.values, options.maxInferredValues ?? 64);
      lo = inferred.lo;
      hi = inferred.hi;
      // The arguments a checked procedure is elaborated with are values its code computes with: the
      // range holds them exactly (no margin: they are given, not counted up to).
      for (const v of this.planned?.literals ?? []) {
        if (v < lo && hi - v + 1 <= (options.maxInferredValues ?? 64)) lo = v;
        if (v > hi && v - lo + 1 <= (options.maxInferredValues ?? 64)) hi = v;
      }
      if (inferred.dropped.length) {
        const shown = inferred.dropped.slice(0, 6).join(', ');
        this.warnings.push({
          message: `literals ${shown}${inferred.dropped.length > 6 ? ', ...' : ''} are outside the inferred integer range ${lo}..${hi}; a value that reaches them is reported as a range error. Lower the constants or set the range with //@csp int lo..hi`,
          at: literals.at.get(inferred.dropped[0]),
        });
      }
    }
    this.data = new DataModel(this.input.index, lo, hi, this.names);
    for (const name of this.input.index.records.keys()) this.data.family('record', name);
    for (const name of this.input.index.protocols.keys()) this.data.family('protocol', name);
    this.nameProcedures(reachable);
    this.channelKinds(reachable);
    this.findRecursion(reachable);
    if (this.target.kind === 'procedure') {
      // Harness channels and barriers are named after the parameters. They are global CSPm names,
      // and a parameter named like a channel would be a pattern: reserve them before any variable is named.
      const unit = this.unitOf.get(root)!;
      const vars = new Map(unit.checked.vars.map((v) => [v.decl, v]));
      for (const p of root.params) {
        const t = vars.get(p.name)?.type;
        if (t && (t.k === 'chan' || (t.k === 'prim' && t.name === 'barrier') || isChanArray(t))) this.harnessNames.set(p.name, this.names.fresh(mangle(p.name.name)));
      }
    }

    // Lower every reachable procedure (callees on demand).
    const ctx = this.lowerContext();
    for (const decl of reachable) this.procOf(decl, ctx);
    while (this.pending.length) this.pending.shift()!();
    for (const ir of this.procs.values()) {
      for (const u of ir.unsupported) this.unsupported.push({ message: u.message, at: this.ref(ir, u.at) });
      for (const w of ir.warnings) this.warnings.push({ message: w.message, at: this.ref(ir, w.at), ...(w.code ? { code: w.code } : {}) });
      if (ir.decl.modifiers.includes('mobile')) this.unsupported.push({ message: `'${ir.decl.name.name}' is a mobile procedure; mobile processes are not modelled`, at: this.ref(ir, ir.decl.name.span) });
    }
    this.lintWarnings(reachable);
    this.saturation = this.saturateIrrelevant(directives);

    const effects = analyzeProcedureEffects(this.units.map((u) => ({ program: u.program, checked: u.checked, file: u.file })));
    const instanced = this.instanceAnalysis();
    const rootIr = this.procs.get(root)!;
    // Arguments from calls or a directive: translated again with them (translate()), this model is never shown.
    // With neither, the model with every value for every data parameter stands when it is complete
    // (a par for with computed bounds covers every value as well); it is checked per value only when it is not.
    let unplanned: InstancePlan | undefined;
    if (this.target.kind === 'procedure' && !this.planned) {
      const plan = this.planInstances(rootIr, instanced, directives);
      if (plan && plan.source !== 'range') {
        this.plan = plan;
        return fail('translated again with the arguments it is checked with');
      }
      unplanned = plan;
    }
    const fallback = (model: CspModel): CspModel => {
      if (unplanned && model.unsupported.length) this.plan = unplanned;
      return model;
    };
    const gens = new Map<ProcIR, GeneratedProc>();
    const prepared = new Map<ProcIR, PreparedProc>();
    // What each process may still do from each point (explain.ts: who can still answer a stuck operation).
    const reach = reachability(this.procs.values(), (d) => this.procs.get(d));
    const genOptions = {
      data: this.data,
      reach: (p: ProcIR) => reach.get(p),
      needsInstance: (p: ProcIR) => instanced.needs.has(p),
      procOf: (d: A.ProcDecl) => this.procs.get(d),
      instanceFunction: (p: ProcIR, callId: number) => instanceFunctionName(p, callId),
      where: (p: ProcIR, span: A.Span) => `${p.unit.file ? path.basename(p.unit.file) : 'buffer'}:${span.start.line + 1}`,
      sourceText: (p: ProcIR, span: A.Span) => sourceLine(p.unit.text, span),
      entryParams: (p: ProcIR) => prepared.get(p)?.entryParams ?? [],
    };
    // Liveness through calls: a parameter the callee never uses is not passed, which can make
    // the caller's own variables dead in turn. Iterate until the entry parameters settle.
    let used = new Map<ProcIR, Set<number>>();
    for (let round = 0; round < 8; round++) {
      prepared.clear();
      const current = used;
      for (const ir of this.procs.values()) prepared.set(ir, prepareProc(ir, { ...genOptions, calleeUses: (p: ProcIR) => (round === 0 ? undefined : current.get(p)) }));
      const next = new Map<ProcIR, Set<number>>();
      for (const [ir, prep] of prepared) {
        const entry = new Set(prep.entryParams);
        next.set(ir, new Set(ir.params.flatMap((p, i) => (entry.has(p.cspm) || (p.ack && entry.has(p.ack)) || (p.len && entry.has(p.len)) ? [i] : []))));
      }
      const settled = round > 0 && [...next].every(([ir, set]) => sameNumbers(set, used.get(ir)));
      used = next;
      if (settled) break;
    }
    for (const [ir, prep] of prepared) gens.set(ir, prep.run());

    // The root and its harness.
    const harness = this.harness(rootIr, gens.get(rootIr)!);
    const networkInput = (rootInstances?: RootInstance[]): NetworkInput => ({
        procs: this.procs,
        generated: gens,
        effects,
        needsInstance: (p) => instanced.needs.has(p),
        leadsToPar: (p) => instanced.par.has(p),
        root: rootIr,
        rootBindings: harness.bindings,
        rootArgs: harness.args.map((a) => a.name),
        // A checked value-returning procedure shows its result: `pj_result.10`.
        rootContinuation: rootIr.returns ? '\\ pj_r @ pj_result!pj_r -> pj_end -> STOP' : undefined,
        rootLabel: this.target.kind === 'program' ? 'main' : `${root.name.name}(${root.params.map((p) => p.name.name).join(', ')})`,
        maxProcesses: options.maxProcesses ?? 2000,
        compress: options.compress ?? directives.compress ?? false,
        intRange: { lo: this.data.lo, hi: this.data.hi },
        serversOutside: harness.barriers.length > 0 || this.harnessChannels.some((h) => h.mediated),
        sourceText: (p, span) => sourceText(p.unit.text, span),
        rootInstances,
        observe: this.observe,
    });
    const roots = this.planned ? this.instances(rootIr, harness, networkInput) : undefined;
    if (typeof roots === 'string') return fail(roots);
    let network;
    try {
      network = buildNetwork(networkInput(roots));
    } catch (e) {
      if (isTooBig(e) && e.recursion) return fallback(fail(`'${e.recursion}' calls itself on the way to a par and does not stop within ${e.max} processes: recursion through par is modelled only when it stops after a number of steps known from the arguments`));
      if (isTooBig(e)) return fallback(fail(`${e.message}: the model would be too large for FDR. Check one procedure at a time, or lower the par for bounds`));
      throw e;
    }
    for (const w of network.warnings) {
      const at = this.ref(w.proc, w.at);
      if (!this.warnings.some((x) => x.code === w.code && x.message === w.message)) this.warnings.push({ message: w.message, at, code: w.code });
    }
    for (const u of network.unsupported) {
      const slots = (u.resources ?? []).map((r) => this.slotOfResource(r)).filter((x): x is string => !!x);
      const fresh = slots.filter((x) => ![...this.mediatedSlots].some((m) => this.ackSlots.find(m) === this.ackSlots.find(x)));
      if (fresh.length) this.retry.push(...fresh);
      else this.unsupported.push({ message: u.message, at: this.ref(u.proc, u.at) });
    }
    return fallback(this.assemble(rootIr, gens, network, harness, directives, roots));
  }

  private failed(message: string): CspModel {
    const at = this.root ? this.ref(this.procs.get(this.root) ?? ({ unit: this.rootUnit } as ProcIR), this.root.name.span) : undefined;
    // Marked as generated, like any model: the next translation of the file replaces it.
    const file = this.units[0]?.file ? path.basename(this.units[0].file) : 'buffer.pj';
    return {
      text: `-- Generated by processj-lsp from ${file}. Regenerated by Convert to CSP and by Check with FDR; edit the ProcessJ source, not this file.\n--\n-- processj-lsp could not translate this program: ${commentText(message)}\n`,
      target: { kind: this.target.kind, name: this.target.kind === 'program' ? 'main' : this.target.name ?? '?' },
      root: 'MAIN',
      intRange: { lo: 0, hi: 1, source: 'inferred' },
      assumptions: [],
      assertions: [],
      sourceMap: { definitions: {}, channels: {}, errors: {}, processes: [], network: { kind: 'leaf', process: -1 }, networkRoot: 'MAIN', constructors: {}, user: [] },
      warnings: this.warnings,
      unsupported: [...this.unsupported, { message, at }],
    };
  }

  private ref(ir: Pick<ProcIR, 'unit'>, span: A.Span): SourceRef {
    return { uri: ir.unit.uri, span };
  }

  // -------------------------------------------------------------------------
  // Directives: //@csp int lo..hi, //@csp assert ..., /*@csp ... */
  // -------------------------------------------------------------------------

  private directives(unit: UnitIR, comments: readonly CommentToken[] | undefined): { range?: { lo: number; hi: number }; compress?: boolean; asserts: Array<{ text: string; at: SourceRef }>; blocks: Array<{ text: string; at: SourceRef; sourceLine: number }>; checks: Array<{ name: string; args: string[]; at: SourceRef }> } {
    const out: ReturnType<Translation['directives']> = { asserts: [], blocks: [], checks: [] };
    for (const c of comments ?? []) {
      const at: SourceRef = { uri: unit.uri, span: { start: { line: c.line, col: c.col }, end: { line: c.endLine, col: c.endCol } } };
      if (c.kind === 'line') {
        const m = /^\/\/@csp\s+(.*)$/.exec(c.text.trim());
        if (!m) continue;
        const body = m[1].trim();
        const range = /^int\s+(-?\d+)\s*\.\.\s*(-?\d+)\s*$/.exec(body);
        if (range) {
          const lo = Number(range[1]);
          const hi = Number(range[2]);
          if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi)) this.warnings.push({ message: `//@csp int ${range[1]}..${range[2]} has a bound too large to model; ignored`, at });
          else if (lo <= hi) out.range = { lo, hi };
          else this.warnings.push({ message: `//@csp int ${lo}..${hi} is an empty range; ignored`, at });
          continue;
        }
        if (body === 'compress') {
          out.compress = true;
          continue;
        }
        // `check altFIFO(6)`: the arguments a procedure checked on its own is elaborated with.
        const check = /^check\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*$/.exec(body);
        if (check) {
          out.checks.push({ name: check[1], args: check[2].trim() ? check[2].split(',').map((a) => a.trim()) : [], at });
          continue;
        }
        if (/^assert\b/.test(body)) out.asserts.push({ text: body, at });
        else this.warnings.push({ message: `unknown //@csp directive '${body}' (expected 'int lo..hi', 'compress', 'check proc(arguments)' or 'assert ...')`, at });
      } else {
        const m = /^\/\*@csp\b([\s\S]*?)\*\/$/.exec(c.text.trim());
        if (!m) continue;
        // The block's first line in the source: the comment's, or the one after a line break that is dropped.
        const leading = /^\s*\n/.exec(m[1])?.[0] ?? '';
        out.blocks.push({ text: m[1].slice(leading.length).replace(/\s+$/, ''), at, sourceLine: c.line + (leading.match(/\n/g)?.length ?? 0) });
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Reachability, names, literals
  // -------------------------------------------------------------------------

  private reachable(root: A.ProcDecl): A.ProcDecl[] {
    const seen = new Set<A.ProcDecl>([root]);
    const order: A.ProcDecl[] = [root];
    for (let i = 0; i < order.length; i++) {
      const decl = order[i];
      const unit = this.unitOf.get(decl);
      if (!unit) continue;
      forEachExprInStmt(decl.body, (e) => {
        const visit = (x: A.Expr): void => {
          if (x.kind === 'Invocation') {
            const callee = unit.checked.calls.get(x)?.decl;
            if (callee?.body && !seen.has(callee)) {
              if (!this.unitOf.has(callee)) {
                this.warnings.push({ message: `the body of '${callee.name.name}' is in a file that was not analysed; calls to it are modelled as doing nothing`, at: { uri: unit.uri, span: x.span } });
              } else {
                seen.add(callee);
                order.push(callee);
              }
            }
          }
          forEachChildExpr(x, visit);
        };
        visit(e);
      });
    }
    return order;
  }

  private nameProcedures(reachable: A.ProcDecl[]): void {
    const sorted = [...reachable].sort((a, b) => this.units.indexOf(this.unitOf.get(a)!) - this.units.indexOf(this.unitOf.get(b)!) || a.span.start.line - b.span.start.line);
    sorted.forEach((d, i) => this.procIds.set(d, i));
    for (const d of sorted) this.baseNames.set(d, this.names.fresh(mangle(d.name.name)));
    // Local channels and barriers: the root's keep their names (they are what a trace shows), others are prefixed.
    for (const d of sorted) {
      const unit = this.unitOf.get(d)!;
      const vars = new Map(unit.checked.vars.map((v) => [v.decl, v]));
      const visit = (s: A.Stmt | undefined): void => {
        if (!s) return;
        if (s.kind === 'LocalDecl') {
          for (const decl of s.declarators) {
            const v = vars.get(decl.name);
            if (!v || (v.type.k !== 'chan' && !(v.type.k === 'prim' && v.type.name === 'barrier') && !isChanArray(v.type))) continue;
            const base = d === this.root ? mangle(decl.name.name) : `${this.baseNames.get(d)}_${mangle(decl.name.name)}`;
            this.localNames.set(decl.name, this.names.fresh(base));
          }
        }
        forEachChildStmt(s, visit);
      };
      visit(d.body);
    }
  }

  /** Integer literals of the reachable code (outside strings and printing), with where each first appears. */
  private literals(reachable: A.ProcDecl[]): { values: number[]; at: Map<number, SourceRef> } {
    const values: number[] = [];
    const at = new Map<number, SourceRef>();
    const add = (v: number, ref: SourceRef): void => {
      values.push(v);
      if (!at.has(v)) at.set(v, ref);
    };
    for (const d of reachable) {
      const unit = this.unitOf.get(d)!;
      const typeOf = (x: A.Expr) => unit.checked.types.get(x);
      /** A value the model abstracts: a timer reading, a string, a real (and arithmetic on one). */
      const abstract = (x: A.Expr): boolean => {
        const t = typeOf(x);
        if (t?.k === 'prim' && (t.name === 'string' || t.name === 'float' || t.name === 'double')) return true;
        if (x.kind === 'ChanRead') {
          const target = typeOf(x.target);
          return target?.k === 'prim' && target.name === 'timer';
        }
        if (x.kind === 'ParenExpr' || x.kind === 'CastExpr') return abstract(x.expr);
        if (x.kind === 'BinaryExpr' && ARITHMETIC.has(x.op)) return abstract(x.left) || abstract(x.right);
        return false;
      };
      const visit = (e: A.Expr, inString: boolean): void => {
        if (inString) return;
        // `-1` is a unary minus applied to the literal 1.
        if (e.kind === 'UnaryExpr' && e.op === '-' && e.operand.kind === 'Literal' && (e.operand.litKind === 'int' || e.operand.litKind === 'long' || e.operand.litKind === 'char')) {
          const v = e.operand.litKind === 'char' ? charCode(e.operand.text) : parseIntLiteral(e.operand.text);
          if (v !== undefined) add(-v, { uri: unit.uri, span: e.span });
          return;
        }
        // Arithmetic with an abstract value is abstract (`t.read() + 100`): its literals never become modelled integers.
        if (e.kind === 'BinaryExpr' && ARITHMETIC.has(e.op) && abstract(e)) return;
        if (e.kind === 'Literal' && (e.litKind === 'int' || e.litKind === 'long')) {
          const v = parseIntLiteral(e.text);
          if (v !== undefined) add(v, { uri: unit.uri, span: e.span });
          return;
        }
        if (e.kind === 'Literal' && e.litKind === 'char') {
          add(charCode(e.text), { uri: unit.uri, span: e.span });
          return;
        }
        if (e.kind === 'NameExpr' && !unit.checked.resolutions.get(e)) {
          const c = this.constValue(e.name.name, unit);
          if (c && c.e.k === 'int') add(c.e.v, { uri: unit.uri, span: e.span });
          return;
        }
        if (e.kind === 'Invocation') {
          const sig = unit.checked.calls.get(e);
          if (sig && (sig.name === 'println' || sig.name === 'print')) return;
        }
        if (e.kind === 'Timeout') return;
        const t = unit.checked.types.get(e);
        const str = !!t && t.k === 'prim' && t.name === 'string';
        forEachChildExpr(e, (x) => visit(x, str));
      };
      forEachExprInStmt(d.body, (e) => visit(e, false));
      // A loop that counts down to a bound (`for (k = n - 1; k >= 0; k--)`) leaves its variable one
      // below it: the value is stored, so it must be a modelled integer.
      const countDown = (s: A.Stmt | undefined): void => {
        if (!s) return;
        if (s.kind === 'ForStmt' && !s.isPar && s.cond?.kind === 'BinaryExpr' && (s.cond.op === '>=' || s.cond.op === '<=')) {
          const c = s.cond;
          const [variable, bound] = c.op === '>=' ? [c.left, c.right] : [c.right, c.left];
          const lit = bound.kind === 'Literal' && bound.litKind === 'int' ? parseIntLiteral(bound.text) : bound.kind === 'UnaryExpr' && bound.op === '-' && bound.operand.kind === 'Literal' && bound.operand.litKind === 'int' ? -(parseIntLiteral(bound.operand.text) ?? NaN) : undefined;
          const name = variable.kind === 'NameExpr' ? variable.name.name : undefined;
          const decrements = s.update.some((u) => (u.kind === 'UnaryExpr' && u.op === '--' && u.operand.kind === 'NameExpr' && u.operand.name.name === name) || (u.kind === 'AssignExpr' && u.op === '-=' && u.target.kind === 'NameExpr' && u.target.name.name === name));
          if (name && lit !== undefined && !Number.isNaN(lit) && decrements) add(lit - 1, { uri: unit.uri, span: bound.span });
        }
        forEachChildStmt(s, countDown);
      };
      countDown(d.body);
    }
    return { values, at };
  }

  /** The value of a constant declaration, when it is made of literals and other constants. */
  private constValue(name: string, unit: UnitIR, depth = 0): { e: Ex; t: DType } | undefined {
    const info = this.input.index.consts.get(name);
    if (!info || depth > 20) return undefined;
    const t = this.data ? this.data.type(info.type) : D.int;
    const decl = info.decl.declarators.find((x) => x.name.name === name);
    if (!decl?.init) return { e: E.any, t: D.any };
    const evaluate = (e: A.Expr): Ex | undefined => {
      switch (e.kind) {
        case 'Literal':
          if (e.litKind === 'int' || e.litKind === 'long') {
            const v = parseIntLiteral(e.text);
            return v === undefined ? undefined : E.int(v);
          }
          if (e.litKind === 'char') return E.int(charCode(e.text));
          if (e.litKind === 'boolean') return E.bool(e.text === 'true');
          return undefined;
        case 'ParenExpr':
          return evaluate(e.expr);
        case 'UnaryExpr': {
          const v = evaluate(e.operand);
          if (!v) return undefined;
          if (e.op === '-' && v.k === 'int') return E.int(-v.v);
          if (e.op === '!' && v.k === 'bool') return E.bool(!v.v);
          return e.op === '+' ? v : undefined;
        }
        case 'BinaryExpr': {
          const l = evaluate(e.left);
          const r = evaluate(e.right);
          if (!l || !r || l.k !== 'int' || r.k !== 'int') return undefined;
          switch (e.op) {
            case '+': return E.int(l.v + r.v);
            case '-': return E.int(l.v - r.v);
            case '*': return E.int(l.v * r.v);
            case '/': return r.v === 0 ? undefined : E.int(Math.trunc(l.v / r.v));
            case '%': return r.v === 0 ? undefined : E.int(l.v % r.v);
            default: return undefined;
          }
        }
        case 'NameExpr':
          return this.constValue(e.name.name, unit, depth + 1)?.e;
        default:
          return undefined;
      }
    };
    const v = evaluate(decl.init);
    if (!v) return { e: E.any, t: D.any };
    return { e: v, t: t.k === 'any' ? D.any : t };
  }

  // -------------------------------------------------------------------------
  // Channel kinds: a channel read with extended rendezvous needs an acknowledgement
  // -------------------------------------------------------------------------

  private channelKinds(reachable: A.ProcDecl[]): void {
    for (const d of reachable) {
      const unit = this.unitOf.get(d)!;
      const slotOf = (e: A.Expr): string | undefined => {
        // An element of a channel array is in its array's group: all of an array's channels are of one kind.
        while (e.kind === 'ParenExpr' || e.kind === 'ChanEnd' || e.kind === 'ArrayAccess') e = e.kind === 'ParenExpr' ? e.expr : e.target;
        if (e.kind !== 'NameExpr') return undefined;
        const v = unit.checked.resolutions.get(e);
        if (!v) return undefined;
        const index = v.isParam ? d.params.findIndex((p) => p.name === v.decl) : -1;
        return index >= 0 ? paramSlot(this.procIds.get(d)!, index) : `l:${identKey(unit, v.decl)}`;
      };
      forEachExprInStmt(d.body, (e) => {
        const visit = (x: A.Expr): void => {
          if (x.kind === 'ChanRead' && x.extended) {
            const slot = slotOf(x.target);
            if (slot) this.extended.add(slot);
          }
          if (x.kind === 'Invocation') {
            const callee = unit.checked.calls.get(x)?.decl;
            const id = callee ? this.procIds.get(callee) : undefined;
            if (callee && id !== undefined) {
              x.args.forEach((arg, i) => {
                const slot = slotOf(arg);
                if (slot) this.ackSlots.union(slot, paramSlot(id, i));
              });
            }
          }
          forEachChildExpr(x, visit);
        };
        visit(e);
      });
    }
    const roots = new Set([...this.extended].map((s) => this.ackSlots.find(s)));
    this.extended.clear();
    for (const r of roots) this.extended.add(r);
  }

  /** Procedures on a cycle of the call graph (an instance of one can run inside another instance of it). */
  private findRecursion(reachable: A.ProcDecl[]): void {
    const callees = new Map<A.ProcDecl, Set<A.ProcDecl>>();
    for (const d of reachable) {
      const unit = this.unitOf.get(d)!;
      const out = new Set<A.ProcDecl>();
      forEachExprInStmt(d.body, (e) => {
        const visit = (x: A.Expr): void => {
          if (x.kind === 'Invocation') {
            const callee = unit.checked.calls.get(x)?.decl;
            if (callee?.body && this.unitOf.has(callee)) out.add(callee);
          }
          forEachChildExpr(x, visit);
        };
        visit(e);
      });
      callees.set(d, out);
    }
    for (const d of reachable) {
      const seen = new Set<A.ProcDecl>();
      const work = [...(callees.get(d) ?? [])];
      while (work.length) {
        const x = work.pop()!;
        if (x === d) {
          this.recursive.add(d);
          break;
        }
        if (seen.has(x)) continue;
        seen.add(x);
        work.push(...(callees.get(x) ?? []));
      }
    }
  }

  /** The kind of the channel group a slot belongs to. */
  private kindOf(slot: string): ChannelKind {
    const root = this.ackSlots.find(slot);
    if ([...this.mediatedSlots].some((m) => this.ackSlots.find(m) === root)) return 'mediated';
    return this.extended.has(root) ? 'ack' : 'plain';
  }

  /** The union-find slot of a network resource key (a local channel instance or a harness channel). */
  private slotOfResource(resource: string): string | undefined {
    if (resource.startsWith('harness:')) {
      // An element of a channel-array parameter (`harness:chans[2]`) is in its array's group.
      const name = resource.slice('harness:'.length).replace(/\[\d+\]$/, '');
      const index = this.harnessChannels.findIndex((h) => h.name === name);
      const id = this.procIds.get(this.root);
      const param = this.harnessChannels[index]?.param;
      return id !== undefined && param !== undefined ? paramSlot(id, param) : undefined;
    }
    const cspm = resource.split('#')[0];
    for (const ir of this.procs.values()) {
      const local = ir.locals.find((l) => l.cspm === cspm);
      if (local) return `l:${identKey(ir.unit, local.ident)}`;
    }
    return undefined;
  }

  private lowerContext(): LowerContext {
    return {
      data: this.data,
      globals: { has: (n) => this.names.has(n), fresh: (b) => this.names.fresh(b) },
      procOf: (decl) => this.procOf(decl, this.lowerContext()),
      kindParam: (decl, index) => {
        const id = this.procIds.get(decl);
        return id === undefined ? 'plain' : this.kindOf(paramSlot(id, index));
      },
      kindLocal: (ident) => {
        for (const u of this.units) {
          const v = u.checked.vars.find((x) => x.decl === ident);
          if (v) return this.kindOf(`l:${identKey(u, ident)}`);
        }
        return 'plain';
      },
      constValue: (name, unit) => this.constValue(name, unit),
      locals: this.localResources,
      localName: (_proc, ident, kind) => this.localNames.get(ident) ?? this.names.fresh(`${kind}_${mangle(ident.name)}`),
      recursive: (decl) => this.recursive.has(decl),
      isMain: (decl) => decl === this.root,
    };
  }

  private procOf(decl: A.ProcDecl, ctx: LowerContext): ProcIR | undefined {
    const known = this.procs.get(decl);
    if (known) return known;
    const unit = this.unitOf.get(decl);
    const name = this.baseNames.get(decl);
    if (!unit || !name || !decl.body) return undefined;
    const started = startProcedure(decl, unit, name, ctx);
    this.procs.set(decl, started.ir);
    this.pending.push(() => started.body());
    return started.ir;
  }

  /** Which procedures run a par (they take an instance handle) and which declare barriers. */
  private instanceAnalysis(): { needs: Set<ProcIR>; par: Set<ProcIR> } {
    const par = new Set<ProcIR>();
    const needs = new Set<ProcIR>();
    for (const ir of this.procs.values()) {
      if (ir.pars.length) par.add(ir);
      if (ir.pars.length || ir.locals.some((l) => l.kind === 'barrier' || l.mediated || l.instanced)) needs.add(ir);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const ir of this.procs.values()) {
        for (const c of ir.calls) {
          const callee = this.procs.get(c.callee);
          if (!callee) continue;
          if (par.has(callee) && !par.has(ir)) {
            par.add(ir);
            changed = true;
          }
          if (needs.has(callee) && !needs.has(ir)) {
            needs.add(ir);
            changed = true;
          }
        }
      }
    }
    return { needs, par };
  }

  /**
   * Integers that never decide anything are saturated instead of range-checked
   * (relevance.ts). What the environment of a checked procedure sees (its
   * channels, its result) and every channel a user's specification names keep
   * their exact values.
   */
  private saturateIrrelevant(directives: ReturnType<Translation['directives']>): Saturation {
    const rootIr = this.procs.get(this.root)!;
    const rootId = this.procIds.get(this.root)!;
    const observed = new Set<string>();
    if (this.target.kind === 'procedure') {
      rootIr.params.forEach((p, i) => {
        if (p.role === 'channel') observed.add(this.ackSlots.find(paramSlot(rootId, i)));
      });
    }
    const userText = [...directives.asserts, ...directives.blocks].map((d) => d.text).join('\n');
    for (const ir of this.procs.values()) {
      for (const local of ir.locals) {
        if (local.kind === 'channel' && new RegExp(`(^|[^A-Za-z0-9_'])${local.cspm}($|[^A-Za-z0-9_'])`).test(userText)) observed.add(this.ackSlots.find(`l:${identKey(ir.unit, local.ident)}`));
      }
    }
    const sat = saturate({
      procs: this.procs.values(),
      group: (p, source) => (source.k === 'param' ? this.ackSlots.find(paramSlot(this.procIds.get(p.decl)!, source.index)) : this.ackSlots.find(`l:${identKey(p.unit, source.decl.ident)}`)),
      observed,
      observedReturns: new Set(this.target.kind === 'procedure' && rootIr.returns ? [rootIr] : []),
      lo: this.data.lo,
      hi: this.data.hi,
    });
    if (sat.vars.size || sat.groups.size || sat.sites) this.data.saturated = true;
    return sat;
  }

  private lintWarnings(reachable: A.ProcDecl[]): void {
    const unit = this.rootUnit;
    const spans = reachable.filter((d) => this.unitOf.get(d) === unit).map((d) => d.span);
    const inside = (line: number): boolean => spans.some((s) => s.start.line <= line && line <= s.end.line);
    let errors = 0;
    for (const d of unit.checked.diagnostics) {
      if (!inside(d.line)) continue;
      const at: SourceRef = { uri: unit.uri, span: { start: { line: d.line, col: d.startCol ?? 0 }, end: { line: d.line, col: d.endCol ?? d.startCol ?? 0 } } };
      const note = d.code ? LINTS.get(d.code) : undefined;
      if (note) this.warnings.push({ message: `${d.message} — ${note}`, at, code: d.code });
      else if (d.severity === 'error') errors++;
    }
    if (errors) this.warnings.push({ message: `the checker reports ${errors} error${errors === 1 ? '' : 's'} in the translated code: the compiler may reject the program; the model follows the operations as written`, at: { uri: unit.uri, span: this.root.name.span } });
    // What this ProcessJ build gets wrong without a lint saying so (miscompile.ts).
    for (const d of reachable) {
      const owner = this.unitOf.get(d);
      if (owner) this.warnings.push(...miscompilations(d, owner.checked, this.input.index, owner.uri));
    }
  }

  // -------------------------------------------------------------------------
  // Harness
  // -------------------------------------------------------------------------

  /** Procedure checks: dedicated channels and barriers for the parameters, internal choice over every data value. */
  private harness(root: ProcIR, gen: GeneratedProc): { bindings: Map<string, Binding>; args: Array<{ name: string; domain: string; variable: string }>; channels: string[]; barriers: string[] } {
    const bindings = new Map<string, Binding>();
    const args: Array<{ name: string; domain: string; variable: string }> = [];
    const channels: string[] = [];
    const barriers: string[] = [];
    if (this.target.kind === 'program') return { bindings, args, channels, barriers };
    for (const p of root.params) {
      // Every channel and barrier parameter gets its own: par branches use them even when the body's start does not.
      const span = p.info?.decl.span ?? root.decl.name.span;
      if (p.role === 'channel' && p.array) {
        if (!this.planned) {
          // Checked per length instead (instances()), when this model is incomplete.
          this.unsupported.push({ message: `parameter '${p.name}' is an array of channels: a procedure checked on its own is given one of the length its calls give, and no call fixes it here`, at: this.ref(root, span) });
          continue;
        }
        // Fresh channels of the length each instance is checked with (instances()).
        const elem = p.type.k === 'array' && p.type.elem.k === 'chan' ? p.type.elem.elem : D.any;
        const name = (p.info && this.harnessNames.get(p.info.decl)) ?? this.names.fresh(p.cspm);
        const ref: ChannelRef = { name: p.name, kind: 'channel', declaration: this.ref(root, span), owner: [] };
        channels.push(name);
        this.harnessChannels.push({ name, type: elem, ack: false, mediated: false, ref, elem: p.info ? typeText(p.info.type) : '?', param: root.params.indexOf(p), array: 0 });
        continue;
      }
      if (p.role === 'channel') {
        const name = (p.info && this.harnessNames.get(p.info.decl)) ?? this.names.fresh(p.cspm);
        const ref: ChannelRef = { name: p.name, kind: 'channel', declaration: this.ref(root, span), owner: [] };
        bindings.set(p.cspm, { value: E.n(name), resource: `harness:${name}`, ref });
        if (p.ack) bindings.set(p.ack, { value: E.n(`${name}__ack`), resource: `harness:${name}`, ref });
        if (p.take) bindings.set(p.take, { value: E.n(`${name}__take`), resource: `harness:${name}`, ref });
        if (p.done) bindings.set(p.done, { value: E.n(`${name}__done`), resource: `harness:${name}`, ref });
        channels.push(name);
        this.harnessChannels.push({ name, type: p.type.k === 'chan' ? p.type.elem : D.any, ack: !!p.ack, mediated: !!p.take, ref, elem: p.info ? typeText(p.info.type) : '?', param: root.params.indexOf(p) });
      } else if (p.role === 'barrier') {
        const name = (p.info && this.harnessNames.get(p.info.decl)) ?? this.names.fresh(p.cspm);
        const ref: ChannelRef = { name: p.name, kind: 'barrier', declaration: this.ref(root, span), owner: [] };
        bindings.set(p.cspm, { value: E.n(name), ref, resource: `harness:${name}` });
        barriers.push(name);
        this.harnessBarriers.push({ name, ref });
      } else if (p.role === 'value' && gen.entryParams.includes(p.cspm)) {
        const domain = this.data.domain(p.type);
        if (!domain) {
          this.unsupported.push({ message: `parameter '${p.name}' (${describe(p.type)}) cannot be given every value: arrays are not enumerable. Check the procedure through a caller instead`, at: this.ref(root, span) });
          continue;
        }
        args.push({ name: p.cspm, domain, variable: p.name });
      }
    }
    return { bindings, args, channels, barriers };
  }

  /** Channels and barriers declared in the procedures, by variable (a branch region refers to its owner's). */
  private readonly localResources = new Map<VarInfo, LocalResource>();
  /** Harness channel names, reserved per parameter before lowering. */
  private readonly harnessNames = new Map<A.Ident, string>();
  /** `array`: a channel-array parameter, its longest length in the checked instances. */
  private readonly harnessChannels: Array<{ name: string; type: DType; ack: boolean; mediated: boolean; ref: ChannelRef; elem: string; param: number; array?: number }> = [];
  private readonly harnessBarriers: Array<{ name: string; ref: ChannelRef }> = [];

  // -------------------------------------------------------------------------
  // Instances: the arguments a procedure checked on its own is elaborated with
  // -------------------------------------------------------------------------

  /**
   * The plan for a checked procedure some of whose data parameters decide its
   * network (structure.ts), or undefined when none does: the tuples a
   * `//@csp check` directive names, else those its calls from the program
   * give, else every modelled value (each tuple checked as an instance).
   */
  private planInstances(root: ProcIR, instanced: { par: Set<ProcIR> }, directives: ReturnType<Translation['directives']>): InstancePlan | undefined {
    const structural = structuralParams(this.procs.values(), (d) => this.procs.get(d), (p) => instanced.par.has(p), (p) => this.recursive.has(p.decl)).get(root) ?? new Set<string>();
    const params = root.params.flatMap((p, i) => ((p.array && p.len) || (p.role === 'value' && structural.has(p.cspm)) ? [i] : []));
    if (!params.length) return undefined;
    const literals = (tuples: InstancePlan['tuples']): number[] => [...new Set(tuples.flatMap((t) => [...t.values].flatMap(([i, v]) => (typeof v === 'number' && !root.params[i].array ? [v] : []))))];
    const merge = (tuples: InstancePlan['tuples']): InstancePlan['tuples'] => {
      const byKey = new Map<string, InstancePlan['tuples'][number]>();
      for (const t of tuples) {
        const key = params.map((i) => String(t.values.get(i) ?? '?')).join(',');
        const known = byKey.get(key);
        if (!known) byKey.set(key, { values: t.values, sites: [...t.sites] });
        else for (const site of t.sites) if (!known.sites.some((x) => x.uri === site.uri && x.span.start.line === site.span.start.line && x.span.start.col === site.span.start.col)) known.sites.push(site);
      }
      return [...byKey.values()];
    };
    const before = this.warnings.length;
    const mine = directives.checks.filter((c) => c.name === root.decl.name.name);
    const named = mine.flatMap((c) => {
      const values = this.checkArguments(c, root, params);
      return values ? [{ values, sites: [c.at] }] : [];
    });
    const warnings = this.warnings.slice(before);
    if (named.length) return { params, source: 'directive', tuples: merge(named), literals: literals(named), warnings };
    const calls = merge(this.callSites(root.decl).map((c) => ({ values: new Map([...c.values].filter(([i]) => params.includes(i))), sites: [c.site] })));
    // Calls that fix none of them are no better than every value.
    if (calls.some((c) => c.values.size)) return { params, source: 'calls', tuples: calls, literals: literals(calls), warnings };
    return { params, source: 'range', tuples: [{ values: new Map(), sites: [] }], literals: [], warnings };
  }

  /** `//@csp check foo(0, 5, 6)` or `foo(i = 0, chans = 5, size = 6)`: data parameters in order, a channel array by its length. */
  private checkArguments(c: { name: string; args: string[]; at: SourceRef }, root: ProcIR, params: number[]): Map<number, number | boolean> | undefined {
    const data = root.params.flatMap((p, i) => (p.role === 'value' || p.array ? [i] : []));
    const values = new Map<number, number | boolean>();
    const value = (text: string): number | boolean | undefined => (text === 'true' ? true : text === 'false' ? false : /^-?\d+$/.test(text) ? Number(text) : undefined);
    const usage = `//@csp check ${root.decl.name.name}(${data.map((i) => root.params[i].name).join(', ')})`;
    for (const [k, arg] of c.args.entries()) {
      const m = /^([A-Za-z_$][\w$]*)\s*=\s*(.+)$/.exec(arg);
      const index = m ? root.params.findIndex((p) => p.name === m[1]) : data[k];
      const v = value((m ? m[2] : arg).trim());
      if (index === undefined || index < 0 || !data.includes(index) || v === undefined || (root.params[index].array && (typeof v !== 'number' || v < 0))) {
        this.warnings.push({ message: `//@csp check: '${arg}' is not an argument of ${usage} (a whole number or true/false per data parameter, a channel array by its length); ignored`, at: c.at });
        return undefined;
      }
      values.set(index, v);
    }
    const missing = params.filter((i) => !values.has(i));
    if (missing.length) this.warnings.push({ message: `//@csp check names no value for ${missing.map((i) => root.params[i].name).join(', ')}: ${missing.length === 1 ? 'it takes' : 'they take'} every modelled value for which the network is finite`, at: c.at });
    return new Map([...values].filter(([i]) => params.includes(i)));
  }

  /** Every call of `decl` from outside it that elaboration of the program (from main) unfolds, with the arguments it knows there. */
  private callSites(decl: A.ProcDecl): Array<{ values: Map<number, number | boolean>; site: SourceRef }> {
    const found: Array<{ values: Map<number, number | boolean>; site: SourceRef }> = [];
    try {
      new Translation(this.input, { kind: 'program' }, new Set(), undefined, (call) => {
        if (call.callee.decl === decl && !call.nested) found.push({ values: call.values, site: { uri: call.caller.unit.uri, span: call.site.span } });
      }).run();
    } catch (e) {
      // A program elaboration gives up (too many processes): the calls it reached still count.
      if (!isTooBig(e)) throw e;
    }
    return found;
  }

  /**
   * The root instances of a planned procedure check: each tuple of the plan,
   * a parameter it leaves open taking every modelled value whose network is
   * finite. A string says why there is none (not modelled).
   */
  private instances(root: ProcIR, harness: ReturnType<Translation['harness']>, networkInput: (roots?: RootInstance[]) => NetworkInput): RootInstance[] | string {
    const plan = this.planned!;
    const { lo, hi } = this.data;
    const proc = root.decl.name.name;
    const names = (indices: number[]): string => listText(indices.map((i) => root.params[i].name));
    // One value more than a parameter may take is enough to know there are too many combinations (checked below).
    const most = MAX_INSTANCES * 4;
    const domain = (i: number): Array<number | boolean> | undefined => {
      const p = root.params[i];
      // An array of no channels gives no network to check (and this ProcessJ build hangs on its empty par for).
      if (p.array) return range(1, Math.min(Math.max(1, hi), most + 1));
      if (p.type.k === 'bool') return [false, true];
      return p.type.k === 'int' ? range(lo, Math.min(hi, lo + most)) : undefined;
    };
    const fixed = fixedParams(root);
    const modelled = (indices: number[]): string => {
      const values = indices.some((i) => !root.params[i].array) ? [`${lo}..${hi}`] : [];
      return [...values, ...(indices.some((i) => root.params[i].array) ? [`lengths 1..${Math.max(1, hi)}`] : [])].join(', ');
    };
    const spec = (values: Map<number, number | boolean>): RootInstance => {
      const byName = new Map<string, number | boolean>();
      const text = new Map<string, string>();
      const bindings = new Map<string, Binding>();
      for (const [i, v] of values) {
        const p = root.params[i];
        const shown = typeof v === 'number' ? show(E.int(v)) : String(v);
        if (p.array && p.len) {
          byName.set(p.len, v);
          text.set(p.len, shown);
          const h = this.harnessChannels.find((x) => x.param === i)!;
          bindings.set(p.cspm, { value: E.n(h.name), array: { resource: `harness:${h.name}`, ref: h.ref, size: Number(v) } });
        } else {
          if (fixed.has(p.cspm)) byName.set(p.cspm, v);
          text.set(p.cspm, shown);
        }
      }
      return { values: byName, fixed: text, bindings, args: harness.args.filter((a) => !text.has(a.name)).map((a) => a.name) };
    };
    const finite = (s: RootInstance): string | undefined => {
      try {
        // A composition a channel server fixes (the next round mediates it) is not about the arguments.
        const n = buildNetwork(networkInput([s]));
        return n.unsupported.find((u) => !u.resources?.length)?.message;
      } catch (e) {
        if (isTooBig(e)) return e.message;
        throw e;
      }
    };
    const kept: Array<{ values: Map<number, number | boolean>; sites: SourceRef[] }> = [];
    const dropped: Array<{ values: Map<number, number | boolean>; why: string }> = [];
    const opened = new Set<number>();
    const outsideRange: string[] = [];
    for (const t of plan.tuples) {
      // A value outside the modelled integers (set with //@csp int or the settings) cannot be checked.
      const outside = [...t.values].filter(([i, v]) => typeof v === 'number' && !root.params[i].array && (v < lo || v > hi));
      if (outside.length) {
        outsideRange.push(...outside.map(([i, v]) => `${root.params[i].name} = ${v}`));
        this.warnings.push({ message: `${proc} is not checked with ${outside.map(([i, v]) => `${root.params[i].name} = ${v}`).join(', ')}${t.sites.length ? ` (${where(t.sites[0], this.rootUnit.uri)})` : ''}: outside the modelled integers ${lo}..${hi}`, at: t.sites[0] });
        continue;
      }
      const open = plan.params.filter((i) => !t.values.has(i));
      for (const i of open) opened.add(i);
      let combos: Array<Map<number, number | boolean>> = [new Map(t.values)];
      for (const i of open) {
        const values = domain(i);
        if (!values) return `'${proc}' on its own: its parameter '${root.params[i].name}' decides its network and no call fixes it; values of its type cannot be enumerated. Call ${proc} from main with a concrete argument, or name one with //@csp check ${proc}(...)`;
        combos = combos.flatMap((c) => values.map((v) => new Map(c).set(i, v)));
        if (combos.length > MAX_INSTANCES * 4) break;
      }
      if (combos.length > MAX_INSTANCES * 4) return `'${proc}' on its own: ${names(open)} decide its network and no call fixes them; every modelled combination (${lo}..${hi}) is too many instances to check. Call ${proc} from main with concrete arguments, or name them with //@csp check ${proc}(...)`;
      for (const values of combos) {
        const why = open.length ? finite(spec(values)) : undefined;
        if (why) dropped.push({ values, why });
        else kept.push({ values, sites: t.sites });
      }
    }
    const label = (values: Map<number, number | boolean>): string => plan.params.filter((i) => values.has(i)).map((i) => (root.params[i].array ? `${root.params[i].name} of length ${values.get(i)}` : `${root.params[i].name} = ${values.get(i)}`)).join(', ');
    const data = root.params.flatMap((p, i) => (p.role === 'value' || p.array ? [i] : []));
    const example = data.every((i) => plan.params.includes(i))
      ? `//@csp check ${proc}(${data.map((i) => `<${root.params[i].name}>`).join(', ')})`
      : `//@csp check ${proc}(${plan.params.map((i) => `${root.params[i].name} = <${root.params[i].name}>`).join(', ')})`;
    if (!kept.length && outsideRange.length && !dropped.length) {
      return `'${proc}' on its own: ${plan.source === 'directive' ? '//@csp check gives' : 'its calls give'} ${listText([...new Set(outsideRange)])}, outside the modelled integers ${lo}..${hi}. Widen the range with //@csp int, or name smaller arguments above the procedure with ${example}`;
    }
    if (!kept.length) {
      const why = dropped[0]?.why;
      const one = plan.params.length === 1;
      return `'${proc}' on its own: ${names(plan.params)} ${one ? 'decides' : 'decide'} its network, no call in the program fixes ${one ? 'it' : 'them'}, and for no modelled value (${lo}..${hi}) does elaboration end${why ? ` (${lowerFirst(why)})` : ''}. If it ends for some ${one ? 'argument' : 'arguments'}, call ${proc} from main with ${one ? 'it' : 'them'}, or name ${one ? 'it' : 'them'} above the procedure with ${example}`;
    }
    if (kept.length > MAX_INSTANCES) return `'${proc}' on its own: ${kept.length} argument tuples (${names(plan.params)}) would each be an instance to check, more than ${MAX_INSTANCES}. Name the ones to check with ${example}`;
    const specs = kept.map((k) => spec(k.values));
    // A channel-array parameter's CSPm channel holds the longest instance's channels.
    for (const k of kept) {
      for (const [i, v] of k.values) {
        const h = root.params[i].array ? this.harnessChannels.find((x) => x.param === i) : undefined;
        if (h) h.array = Math.max(h.array ?? 0, Number(v));
      }
    }
    // What the report says it was checked with.
    const short = plan.params.map((i) => {
      const p = root.params[i];
      const vs = [...new Set(kept.map((k) => k.values.get(i)))].filter((v) => v !== undefined) as Array<number | boolean>;
      const sorted = vs.every((v) => typeof v === 'number') ? (vs as number[]).sort((a, b) => a - b) : vs;
      const consecutive = sorted.length > 2 && sorted.every((v, k) => typeof v === 'number' && (k === 0 || v === (sorted[k - 1] as number) + 1));
      const text = consecutive ? `${sorted[0]}..${sorted[sorted.length - 1]}` : sorted.join(', ');
      return p.array ? `${p.name} of length ${text}` : `${p.name} = ${text}`;
    }).join(', ');
    const sites = kept.flatMap((k) => k.sites).filter((x, n, all) => all.findIndex((y) => y.uri === x.uri && y.span.start.line === x.span.start.line) === n);
    const lines = sites.map((x) => where(x, this.rootUnit.uri).replace(/^line /, ''));
    const count = kept.length > 1 ? `${kept.length} instances, each checked; ` : '';
    const from = plan.source === 'directive'
      ? `from //@csp check at ${sites.length === 1 ? 'line' : 'lines'} ${listText(lines)}`
      : plan.source === 'calls'
        ? `${sites.length === 1 ? 'the call' : 'the calls'} at ${sites.length === 1 ? 'line' : 'lines'} ${listText(lines)}`
        : `no call in the program fixes ${names(plan.params)}: every modelled value (${modelled(plan.params)}) for which the network is finite`;
    const leftOpen = plan.source !== 'range' && opened.size ? `; ${names([...opened])} ${opened.size === 1 ? 'takes' : 'take'} every modelled value (${modelled([...opened])}) for which the network is finite, as not every call fixes ${opened.size === 1 ? 'it' : 'them'}` : '';
    const notChecked = dropped.length ? `; not checked with ${listText(dropped.slice(0, 4).map((d) => label(d.values)))}${dropped.length > 4 ? ' and others' : ''} (${lowerFirst(dropped[0].why)})` : '';
    const detail = `${short} (${count}${from}${leftOpen}${notChecked})`;
    this.checkedWith = {
      text: `${proc} checked with ${detail}`,
      detail,
      short,
      source: plan.source,
      instances: kept.map((k) => ({
        label: label(k.values),
        values: Object.fromEntries([...k.values].filter(([i]) => !root.params[i].array).map(([i, v]) => [root.params[i].name, v])),
        arrays: Object.fromEntries([...k.values].filter(([i]) => root.params[i].array).map(([i, v]) => [root.params[i].name, Number(v)])),
        sites: k.sites,
      })),
    };
    return specs;
  }

  // -------------------------------------------------------------------------
  // The file
  // -------------------------------------------------------------------------

  private assemble(
    root: ProcIR,
    gens: Map<ProcIR, GeneratedProc>,
    network: ReturnType<typeof buildNetwork>,
    harness: ReturnType<Translation['harness']>,
    directives: ReturnType<Translation['directives']>,
    /** The root instances of a procedure checked per argument tuple (instances()). */
    specs?: RootInstance[],
  ): CspModel {
    const unit = this.rootUnit;
    const allProcesses = network.roots.flatMap((r) => r.processes);
    const fileName = unit.file ? path.basename(unit.file) : 'buffer.pj';
    const program = this.target.kind === 'program';
    // A checked procedure's process is named after it (its definitions all have a `__` suffix).
    const rootName = program ? 'MAIN' : root.name;
    const lines: string[] = [];
    const channels: Record<string, CspChannelInfo> = {};
    const definitions: Record<string, CspDefinitionInfo> = {};
    const transitions: CspTransition[] = [];
    const hidden: string[] = [];

    // Data first: it can find more that is not modelled, which the header lists.
    const dataLines = this.data.declarations();
    for (const u of new Set(this.data.unsupported)) this.unsupported.push({ message: `${u} are not modelled` });
    // So can channels whose values the model cannot enumerate (a checked procedure's too) and par branches given such values.
    for (const h of this.harnessChannels) {
      if (!this.data.domain(h.type)) this.unsupported.push({ message: `channel parameter '${h.ref.name}' carries ${describe(h.type)}, which the model cannot enumerate`, at: h.ref.declaration });
    }
    for (const [ir, g] of gens) {
      for (const local of ir.locals) {
        if (local.kind === 'channel' && local.elem && !this.data.domain(local.elem)) this.unsupported.push({ message: `channel '${local.name}' carries ${describe(local.elem)}, which the model cannot enumerate`, at: this.ref(ir, local.ident.span) });
      }
      for (const c of g.channels) for (const t of c.payload) if (!this.data.domain(t)) this.badPayload(ir, c.par.stmt.span, t);
    }

    // Header and summary.
    lines.push(`-- Generated by processj-lsp from ${fileName}. Regenerated by Convert to CSP and by Check with FDR; edit the ProcessJ source, not this file.`);
    lines.push('--');
    lines.push(program
      ? '-- Target: the whole program, from main (MAIN).'
      : this.checkedWith
        ? `-- Target: procedure ${root.decl.name.name} on its own (${rootName}): ${commentText(this.checkedWith.text)}${harness.args.some((a) => !specs?.every((x) => x.fixed?.has(a.name))) ? '; its other data parameters take every value (pj_call)' : ''}.`
        : `-- Target: procedure ${root.decl.name.name} on its own (${rootName}), called with every value for its data parameters (pj_call).`);
    lines.push(`-- Integers: byte, short, char, int and long range over Int_t = ${rangeText(this.data.lo, this.data.hi)} (${this.intSource === 'comment' ? 'from //@csp int' : this.intSource === 'option' ? 'from the settings' : 'inferred from the literals'}).`);
    const assumptions = this.assumptions();
    for (const a of assumptions.slice(1)) if (!this.checkedWith || !a.startsWith(this.checkedWith.text)) lines.push(`-- ${commentText(a)}`);
    if (this.warnings.length) {
      lines.push('-- Warnings:');
      for (const w of this.warnings) lines.push(`--   ${w.at ? `${fileName}:${w.at.span.start.line + 1}: ` : ''}${commentText(w.message)}`);
    }
    if (this.unsupported.length) {
      lines.push('-- NOT MODELLED (no check of this model can be trusted):');
      for (const u of this.unsupported) lines.push(`--   ${u.at ? `${fileName}:${u.at.span.start.line + 1}: ` : ''}${commentText(u.message)}`);
    }
    lines.push('');
    if (network.definitions.some((d) => d.includes('sbisim(diamond('))) lines.push('transparent sbisim, diamond', '');

    // Data.
    lines.push('-- Data');
    lines.push(...dataLines);
    lines.push(...INT_HELPERS, ...ARRAY_HELPERS);
    lines.push('');

    // Channels.
    lines.push('-- Channels');
    const procList = [...gens.keys()];
    const declareChannel = (name: string, type: string | undefined, info: CspChannelInfo): void => {
      lines.push(`channel ${name}${type ? ` : ${type}` : ''}`);
      channels[name] = info;
      if (info.hidden) hidden.push(name);
    };
    const ackMeaning = 'the reader finished with the value (after its extended rendezvous block): the writer goes on';
    for (const h of this.harnessChannels) {
      const domain = this.data.domain(h.type) ?? 'PJ_Any';
      if (h.array !== undefined) {
        // A channel-array parameter: fresh channels, as many as the longest instance is given; the
        // index field covers every index a length in Int_t allows (as for an array declared here).
        const size = Math.max(1, h.array);
        declareChannel(h.name, `${rangeText(0, Math.max(size - 1, this.data.hi))}.${domain}`, { name: h.name, role: 'channel', ref: h.ref, elementType: h.elem, hidden: false, harness: true, array: size });
        for (const p of allProcesses) {
          for (const [key, ref] of Object.entries(p.channels)) {
            if (!key.startsWith(`${h.name}.`) || channels[key]) continue;
            channels[key] = { name: key, role: 'channel', ref, elementType: h.elem, hidden: false, harness: true, part: { channel: h.name, index: Number(key.slice(h.name.length + 1)) } };
          }
        }
        continue;
      }
      declareChannel(h.name, domain, { name: h.name, role: 'channel', ref: h.ref, elementType: h.elem, hidden: false, harness: true });
      if (h.ack) declareChannel(`${h.name}__ack`, undefined, { name: `${h.name}__ack`, role: 'ack', of: h.name, hidden: true, meaning: ackMeaning });
      if (h.mediated) {
        declareChannel(`${h.name}__take`, domain, { name: `${h.name}__take`, role: 'channel', of: h.name, ref: h.ref, elementType: h.elem, hidden: false, harness: true, meaning: 'a reader takes the value the channel server holds' });
        declareChannel(`${h.name}__done`, undefined, { name: `${h.name}__done`, role: 'ack', of: h.name, hidden: true, meaning: 'the reader is done with the value' });
      }
    }
    for (const ir of procList) {
      const count = network.instances.get(ir) ?? 0;
      for (const local of ir.locals) {
        if (local.kind !== 'channel') continue;
        const domain = local.elem ? this.data.domain(local.elem) : undefined;
        if (local.array || (local.instanced && !local.mediated)) {
          // One CSPm channel for an array, its first field the element (as many as the longest instance has);
          // a recursive procedure's channel carries the procedure instance first.
          const size = Math.max(1, network.arraySizes.get(local) ?? 1);
          const fallback: ChannelRef = { name: local.name, kind: 'channel', declaration: this.ref(ir, local.ident.span), owner: [] };
          // The index field covers every index a length in Int_t allows: FDR compiles each process on its
          // own, for every length its parent could hand it, and the bounds check only rules out indices past that length.
          const index = local.array ? `${rangeText(0, Math.max(size - 1, this.data.hi))}.` : '';
          const inst = local.instanced ? `${rangeText(1, Math.max(1, count))}.` : '';
          declareChannel(local.cspm, `${inst}${index}${domain ?? 'PJ_Any'}`, { name: local.cspm, role: 'channel', ref: fallback, elementType: local.elemText, hidden: ir !== root, ...(local.array ? { array: size } : {}), ...(local.instanced ? { instanced: true } : {}) });
          if (local.ack) declareChannel(local.ack, inst ? inst.slice(0, -1) : undefined, { name: local.ack, role: 'ack', of: local.cspm, ref: fallback, hidden: true, meaning: ackMeaning, ...(inst ? { instanced: true } : {}) });
          // Each channel the network gave an identity of its own (an element, an instance's channel): an entry per event prefix.
          for (const p of allProcesses) {
            for (const [key, ref] of Object.entries(p.channels)) {
              if (!key.startsWith(`${local.cspm}.`) || channels[key]) continue;
              const rest = key.slice(local.cspm.length + 1).split('.').map(Number);
              const part = { channel: local.cspm, ...(local.instanced ? { instance: rest[0] } : {}), ...(local.array ? { index: rest[local.instanced ? 1 : 0] } : {}) };
              channels[key] = { name: key, role: 'channel', ref, elementType: local.elemText, hidden: ir !== root, part };
            }
          }
          continue;
        }
        const ref = this.channelRef(local, ir, network);
        // A mediated channel's events carry the procedure instance, like a barrier's.
        const inst = local.mediated ? `${rangeText(1, Math.max(1, count))}.` : '';
        const hiddenLocal = ir !== root;
        const instanced = inst ? true : undefined;
        declareChannel(local.cspm, `${inst}${domain ?? 'PJ_Any'}`, { name: local.cspm, role: 'channel', ref, elementType: local.elemText, hidden: hiddenLocal, meaning: local.mediated ? 'a writer hands its value to the channel server' : undefined, instanced });
        if (local.ack) declareChannel(local.ack, inst ? inst.slice(0, -1) : undefined, { name: local.ack, role: 'ack', of: local.cspm, ref, hidden: true, meaning: ackMeaning, instanced });
        if (local.mediated) {
          declareChannel(local.mediated.take, `${inst}${domain ?? 'PJ_Any'}`, { name: local.mediated.take, role: 'channel', of: local.cspm, ref, elementType: local.elemText, hidden: hiddenLocal, meaning: 'a reader takes the value the channel server holds', instanced });
          declareChannel(local.mediated.done, inst.slice(0, -1), { name: local.mediated.done, role: 'ack', of: local.cspm, ref, hidden: true, meaning: 'the reader is done with the value', instanced });
        }
      }
    }
    // Barriers: each counter speaks the runtime's protocol (sync, go, enroll, resign). Enrolling n
    // processes is a constructor of its own: FDR cannot type `b.pj_enroll.2` on a barrier parameter.
    const enrollMax = Math.max(network.maxEnroll, network.barrierMax);
    const enrollCtors = Array.from({ length: enrollMax + 1 }, (_, n) => `pj_enroll_${n}`);
    lines.push(`datatype PJBarOp = pj_sync | pj_go | pj_resign | ${enrollCtors.join(' | ')}`);
    lines.push(...enrollCtors.map((c, n) => `pj_enroll(${n}) = ${c}`));
    lines.push(`PJ_ENROLLS = {${enrollCtors.map((c, n) => `(${c}, ${n})`).join(', ')}}`);
    for (const h of this.harnessBarriers) declareChannel(h.name, 'PJBarOp', { name: h.name, role: 'barrier', ref: h.ref, hidden: false });
    for (const ir of procList) {
      const count = network.instances.get(ir) ?? 0;
      for (const local of ir.locals) {
        if (local.kind !== 'barrier') continue;
        declareChannel(local.cspm, `${rangeText(1, Math.max(1, count))}.PJBarOp`, { name: local.cspm, role: 'barrier', ref: this.channelRef(local, ir, network), hidden: ir !== root, instanced: true });
      }
    }
    // Errors and bookkeeping (only the errors some definition can raise).
    const generatedText = procList.map((ir) => gens.get(ir)!.text.join('\n')).join('\n');
    const raised = new Set([...generatedText.matchAll(/pj_error\.([A-Za-z0-9_']+)/g)].map((m) => m[1]));
    const errorCtors = procList.flatMap((ir) => ir.errors).filter((e) => raised.has(e.ctor));
    lines.push(`datatype PJ_Error = ${errorCtors.length ? errorCtors.map((e) => e.ctor).join(' | ') : 'pj_no_error'}`);
    declareChannel('pj_error', 'PJ_Error', { name: 'pj_error', role: 'error', hidden: false, meaning: 'a runtime error: the program stops' });
    const internal: Array<[string, string]> = [
      ['pj_end', 'the root finished: the program ends (every waiting branch and server with it)'],
      ['pj_tick', 'one iteration of a loop that may pass no other event'],
      ['pj_skip', 'an alt chose its skip guard'],
      ['pj_timeout', 'an alt chose a timeout guard (time is abstract)'],
    ];
    for (const [name, meaning] of internal) declareChannel(name, undefined, { name, role: 'internal', hidden: true, meaning });
    declareChannel('pj_done', undefined, { name: 'pj_done', role: 'internal', hidden: false, meaning: 'marker after termination, so that termination is not reported as deadlock' });
    if (root.returns) {
      declareChannel('pj_result', this.data.domain(root.returns) ?? 'PJ_Any', { name: 'pj_result', role: 'internal', hidden: false, meaning: `${root.decl.name.name} returned this value` });
    }
    if (harness.args.length) {
      declareChannel('pj_call', harness.args.map((a) => a.domain).join('.'), {
        name: 'pj_call',
        role: 'internal',
        hidden: false,
        meaning: `the checked procedure is called with these values for ${harness.args.map((a) => a.variable).join(', ')}`,
        fields: harness.args.map((a) => a.variable),
      });
    }
    for (const ir of procList) {
      const count = network.instances.get(ir) ?? 0;
      lines.push(`PJInst_${ir.name} = ${rangeText(1, Math.max(1, count))}`);
      for (const c of gens.get(ir)!.channels) {
        // A fork carries only what elaboration found every parent sends (network.ts forkDomains).
        const known = c.role === 'fork' ? network.forkDomains.get(c.par) : undefined;
        const field = (i: number, full: string): string => {
          const set = known?.[i];
          return set ? `{ ${[...set].sort((a, b) => Number(a) - Number(b)).map(String).join(', ')} }` : full;
        };
        const bounds = (c.bounds ?? []).map((b, i) => field(i, b));
        const fields = [...(c.instanced ? [`PJInst_${ir.name}`] : []), ...bounds, ...c.payload.map((t, i) => field(bounds.length + i, this.data.domain(t) ?? 'PJ_Any'))];
        if (c.role === 'fork' && fields.length > (c.instanced ? 1 : 0)) lines.push(...forkSets(c, fields.slice(c.instanced ? 1 : 0), network.forkTuples.get(c.par), count));
        const where = `${path.basename(ir.unit.file ?? 'buffer')}:${c.par.stmt.span.start.line + 1}`;
        const what = c.par.kind === 'par' ? 'branch' : 'iteration';
        declareChannel(c.name, fields.length ? fields.join('.') : undefined, {
          name: c.name,
          role: 'internal',
          hidden: true,
          instanced: c.instanced || undefined,
          fields: c.fields,
          spawns: c.par.kind === 'par' ? 'branches' : 'iterations',
          ...(c.bounds ? { computedBounds: true } : {}),
          meaning: c.role === 'fork'
            ? `starts every ${what} of the ${c.par.kind === 'par' ? 'par' : 'par for'} at ${where}`
            : `${c.branch ? `branch ${c.branch}` : 'every iteration'} of the ${c.par.kind === 'par' ? 'par' : 'par for'} at ${where} has finished`,
        });
      }
    }
    lines.push('');

    // Processes.
    lines.push('-- Processes');
    for (const ir of procList) {
      const g = gens.get(ir)!;
      lines.push(`-- ${ir.decl.name.name}`);
      lines.push(...g.text);
      for (const d of g.definitions) definitions[d.name] = d;
      transitions.push(...g.transitions);
      lines.push('');
    }
    if (network.instanceFunctions.length) {
      lines.push('-- Instance of a procedure that runs a par, for each call site and caller instance');
      lines.push(...network.instanceFunctions);
      lines.push('');
    }
    lines.push('-- A barrier as the ProcessJ runtime implements it (PJBarrier): a counter of enrolled and waiting');
    lines.push('-- processes. A sync completes when the last enrolled process arrives; a terminating branch resigns,');
    lines.push('-- but resigning never completes a barrier, so processes already waiting stay blocked.');
    lines.push('-- (n: enrolled, w: waiting, mx: a bound on both, so FDR can compile the counter on its own.)');
    lines.push('PJ_BAR(pj_b, pj_mx) = PJ_BAR_S(pj_b, pj_mx, 1, 0)');
    lines.push('PJ_BAR_S(pj_b, pj_mx, pj_n, pj_w) =');
    lines.push('     pj_b.pj_sync -> (if pj_w + 1 == pj_n then PJ_BAR_R(pj_b, pj_mx, pj_n, pj_w + 1) else if pj_w + 1 < pj_mx then PJ_BAR_S(pj_b, pj_mx, pj_n, pj_w + 1) else STOP)');
    lines.push('  [] pj_b.pj_resign -> PJ_BAR_S(pj_b, pj_mx, if pj_n > 1 then pj_n - 1 else pj_n, pj_w)');
    lines.push('  [] ([] (pj_e, pj_m) : {(pj_x, pj_y) | (pj_x, pj_y) <- PJ_ENROLLS, pj_y <= pj_mx, pj_n + pj_y - 1 >= 0, pj_n + pj_y - 1 <= pj_mx} @ pj_b.pj_e -> PJ_BAR_S(pj_b, pj_mx, pj_n + pj_m - 1, pj_w))');
    lines.push('  [] pj_end -> STOP');
    lines.push('PJ_BAR_R(pj_b, pj_mx, pj_n, pj_r) = if pj_r == 0 then PJ_BAR_S(pj_b, pj_mx, pj_n, 0) else pj_b.pj_go -> PJ_BAR_R(pj_b, pj_mx, pj_n, pj_r - 1)');
    for (const name of ['PJ_BAR', 'PJ_BAR_S', 'PJ_BAR_R']) {
      const params: CspDefinitionInfo['params'] = [
        { name: 'pj_b', role: 'barrier' },
        { name: 'pj_mx', role: 'value', variable: 'bound' },
        { name: 'pj_n', role: 'value', variable: 'enrolled' },
        { name: name === 'PJ_BAR_R' ? 'pj_r' : 'pj_w', role: 'value', variable: name === 'PJ_BAR_R' ? 'still to release' : 'waiting' },
      ];
      definitions[name] = { name, kind: 'helper', params: name === 'PJ_BAR' ? params.slice(0, 2) : params };
    }
    lines.push('-- A mediated channel (several processes on both of its sides): a server takes one written value,');
    lines.push('-- hands it to one reader, waits for the reader to finish and releases the writer. Same rendezvous,');
    lines.push('-- but writers and readers never synchronise with each other directly.');
    lines.push('PJ_MED(pj_c, pj_t, pj_d, pj_a) = (pj_c?pj_v -> pj_t!pj_v -> pj_d -> pj_a -> PJ_MED(pj_c, pj_t, pj_d, pj_a)) [] (pj_end -> STOP)');
    definitions.PJ_MED = { name: 'PJ_MED', kind: 'helper', params: [{ name: 'pj_c', role: 'channel' }, { name: 'pj_t', role: 'channel' }, { name: 'pj_d', role: 'ack' }, { name: 'pj_a', role: 'ack' }] };
    lines.push('');

    // Network and harness.
    lines.push('-- The process network: every process instance is one leaf (see the source map)');
    lines.push(...network.definitions);
    const mediatedHarness = this.harnessChannels.filter((h) => h.mediated);
    const leafInfo = (kind: 'barrier' | 'channel', definition: string, args: string[], ref: ChannelRef, resource: string): CspProcessInfo => ({
      position: [], leaf: `${definition}(${args.join(', ')})`, definition, args, kind, barrier: ref, resource, channels: {}, uses: [], enrolled: [],
    });
    // Each root instance (one, unless a checked procedure is checked per argument tuple): its network, with the harness's servers.
    const many = network.roots.length > 1;
    const built = network.roots.map((r, k) => {
      const suffix = many ? `_${k + 1}` : '';
      const processes = [...r.processes];
      let tree: CspNetworkNode = r.tree;
      const servers = [
        // A barrier parameter of a checked procedure: its counter as if the caller enrolled nobody else.
        ...this.harnessBarriers.map((b) => ({ info: leafInfo('barrier', 'PJ_BAR', [b.name, String(Math.max(2, network.barrierMax))], b.ref, `harness:${b.name}`), events: [b.name] })),
        ...mediatedHarness.map((h) => {
          const names = [h.name, `${h.name}__take`, `${h.name}__done`, `${h.name}__ack`];
          return { info: leafInfo('channel', 'PJ_MED', names, h.ref, `harness:${h.name}`), events: names };
        }),
      ];
      const args = r.params.length ? `(${r.params.join(', ')})` : '';
      if (servers.length) {
        // Servers of the harness, as leaves of their own (explain.ts reads a barrier parameter's counter).
        let serverText = '';
        let serverTree: CspNetworkNode | undefined;
        for (const sv of servers) {
          processes.push(sv.info);
          const leaf: CspNetworkNode = { kind: 'leaf', process: processes.length - 1 };
          serverText = serverTree ? `(${serverText} [| {pj_end} |] ${sv.info.leaf})` : sv.info.leaf;
          serverTree = serverTree ? { kind: 'parallel', sync: '{pj_end}', left: serverTree, right: leaf } : leaf;
        }
        const sync = `{| ${[...servers.flatMap((sv) => sv.events), 'pj_end'].join(', ')} |}`;
        lines.push(`PJ_NET_B${suffix}${args} = (${r.root}${args} [| ${sync} |] ${serverText})`);
        tree = { kind: 'named', name: `PJ_NET_B${suffix}`, child: { kind: 'parallel', sync, left: r.tree, right: serverTree! } };
      }
      const net = servers.length ? `PJ_NET_B${suffix}` : r.root;
      const netCall = r.params.length ? `${net}(${r.params.join(', ')})` : net;
      // No process of the network terminates on its own (network.ts): the program ends when the root's
      // pj_end happens, and the exception turns that into SKIP. A network of one process ends by itself.
      const ending = r.endsItself ? netCall : `(${netCall} [| {pj_end} |> SKIP)`;
      const top: CspNetworkNode = { kind: 'hide', hidden: 'PJ_HIDDEN', child: r.endsItself ? tree : { kind: 'exception', events: '{pj_end}', child: tree } };
      assignPositions(processes, top, []);
      return { suffix, args, ending, processes, top, params: r.params, spec: specs?.[k] };
    });
    hidden.push('pj_end');
    lines.push(`PJ_HIDDEN = {| ${[...new Set(hidden)].join(', ')} |}`);
    // A checked procedure's own channels and barriers: what its branches say to each other. Visible
    // in the process (a specification may name them), hidden for divergence and determinism, which
    // are about what its caller sees.
    const local = program ? [] : root.locals.flatMap((l) => (l.kind === 'barrier' ? [l.cspm] : [l.cspm, ...(l.mediated ? [l.mediated.take] : [])]));
    if (local.length) lines.push(`PJ_LOCAL = {| ${local.join(', ')} |}`);
    // The data arguments of a checked procedure are its first event: every check covers every
    // value, and a counterexample starts with the values it needs (`pj_call.3`). The network
    // under each value is one named definition, which FDR's --divide output shows by name.
    let networkRoot = rootName;
    const runDefinition = (name: string, params: string[]): CspDefinitionInfo => ({ name, kind: 'process', params: params.map((n) => ({ name: n, role: 'value', variable: harness.args.find((a) => a.name === n)?.variable ?? n })), procedure: root.decl.name.name, at: this.ref(root, root.decl.name.span) });
    const instanceRoots: string[] = [];
    if (!specs) {
      const [only] = built;
      if (harness.args.length) {
        const params = harness.args.map((a) => a.name).join(', ');
        networkRoot = 'PJ_RUN';
        lines.push(`${rootName} = pj_call${harness.args.map((a) => `?${a.name}`).join('')} -> PJ_RUN(${params})`);
        lines.push(`PJ_RUN(${params}) = ${only.ending} \\ PJ_HIDDEN`);
        definitions.PJ_RUN = runDefinition('PJ_RUN', harness.args.map((a) => a.name));
      } else {
        lines.push(`${rootName} = (${only.ending} \\ PJ_HIDDEN)`);
      }
    } else if (!harness.args.length && !many) {
      lines.push(`${rootName} = (${built[0].ending} \\ PJ_HIDDEN)`);
    } else {
      // Checked per argument tuple (checkedWith): `pj_call` names the fixed arguments of each instance,
      // the others are any value as before; the caller chooses which instance it calls.
      const branches = built.map((b) => {
        const name = `PJ_RUN${b.suffix}`;
        instanceRoots.push(name);
        lines.push(`${name}${b.args} = ${b.ending} \\ PJ_HIDDEN`);
        definitions[name] = runDefinition(name, b.params);
        const call = harness.args.length ? `pj_call${harness.args.map((a) => (b.spec?.fixed?.has(a.name) ? `.${b.spec.fixed.get(a.name)}` : `?${a.name}`)).join('')} -> ` : '';
        return `${call}${name}${b.args}`;
      });
      networkRoot = instanceRoots[0];
      lines.push(`${rootName} = ${branches.length > 1 ? branches.map((x) => `(${x})`).join(' [] ') : branches[0]}`);
    }
    lines.push('PJ_DONE = pj_done -> PJ_DONE');
    lines.push('-- Errors end the program (and are reported by the error check), so they are not deadlocks:');
    lines.push('PJ_NOERR(pj_p) = (pj_p [| {| pj_error |} |> PJ_DONE) ; PJ_DONE');
    lines.push('-- Every trace without an error, ending or not:');
    lines.push('PJ_SAFE = SKIP [] ([] pj_e : diff(Events, {| pj_error |}) @ pj_e -> PJ_SAFE)');
    definitions[rootName] = { name: rootName, kind: 'process', params: [], procedure: root.decl.name.name, at: this.ref(root, root.decl.name.span) };
    lines.push('');
    const processes = built[0].processes;
    const network2 = built[0].top;

    // Assertions.
    lines.push('-- Assertions');
    const assertions: CspAssertion[] = [];
    const user: CspSourceMap['user'] = [];
    const targetInfo = { kind: this.target.kind, name: root.decl.name.name, at: this.ref(root, root.decl.name.span), ...(this.checkedWith ? { arguments: this.checkedWith.short } : {}) };
    const add = (id: string, property: CheckProperty, label: string, severity: CspAssertion['severity'], assertion: string, at?: SourceRef, negated?: boolean): void => {
      assertions.push({ id, index: assertions.length, property, label, severity, target: targetInfo, assertion, at, ...(negated ? { negated } : {}) });
      lines.push(`assert ${assertion}`);
    };
    // FDR reads `assert not...` as a negated assertion even inside a name (`assert notGate ...` is a lexical error).
    const first = /^not/.test(rootName) ? `(${rootName})` : rootName;
    const quiet = local.length ? `(${rootName} \\ PJ_LOCAL)` : first;
    const asserted: Record<string, string> = {
      'deadlock-free': `PJ_NOERR(${rootName}) :[deadlock free [F]]`,
      'divergence-free': `${quiet} :[divergence free]`,
      'no-runtime-errors': `PJ_SAFE [T= ${rootName}`,
      terminates: `SKIP [FD= ${rootName} \\ Events`,
      deterministic: `${quiet} :[deterministic [F]]`,
    };
    for (const check of STANDARD_CHECKS[program ? 'program' : 'procedure']) add(check.id, check.property, check.label, check.severity, asserted[check.id]);
    directives.asserts.forEach((a, i) => {
      const text = a.text.replace(/^assert\s+/, '');
      const kind = assertionKind(text);
      user.push({ line: lineCount(lines) + 1, lines: 1, at: a.at, sourceLine: a.at.span.start.line });
      add(`user-${i + 1}`, kind.property, text, 'error', text, a.at, kind.negated);
    });
    if (directives.blocks.length) {
      lines.push('');
      lines.push('-- From /*@csp ... */ blocks in the source, copied verbatim');
      let n = 0;
      for (const b of directives.blocks) {
        lines.push(`-- ${fileName}:${b.at.span.start.line + 1}`);
        user.push({ line: lineCount(lines) + 1, lines: b.text.split('\n').length, at: b.at, sourceLine: b.sourceLine });
        lines.push(b.text);
        // FDR checks the block's assertions in order; one inside a CSPm comment is not one.
        for (const text of blockAssertions(b.text)) {
          const kind = assertionKind(text);
          assertions.push({ id: `block-${++n}`, index: assertions.length, property: kind.property, label: text, severity: 'error', target: targetInfo, assertion: text, at: b.at, ...(kind.negated ? { negated: true } : {}) });
        }
      }
    }
    lines.push('');

    const errors: CspSourceMap['errors'] = {};
    for (const ir of procList) for (const e of ir.errors) if (raised.has(e.ctor)) errors[e.ctor] = { kind: e.kind, message: e.message, at: this.ref(ir, e.at), procedure: ir.decl.name.name };
    return {
      text: lines.join('\n'),
      target: targetInfo,
      root: rootName,
      intRange: { lo: this.data.lo, hi: this.data.hi, source: this.intSource },
      assumptions,
      assertions,
      sourceMap: {
        definitions,
        channels,
        errors,
        processes,
        network: network2,
        networkRoot,
        ...(instanceRoots.length > 1
          ? {
            instances: built.map((b, k) => ({
              label: this.checkedWith?.instances[k]?.label ?? `instance ${k + 1}`,
              networkRoot: instanceRoots[k],
              network: b.top,
              processes: b.processes,
              ...(harness.args.length ? { call: harness.args.map((a) => b.spec?.fixed?.get(a.name)?.replace(/^\((-?\d+)\)$/, '$1')) } : {}),
            })),
          }
          : {}),
        constructors: this.constructors(),
        user,
        transitions,
      },
      warnings: this.warnings,
      unsupported: this.unsupported,
      ...(this.checkedWith ? { checkedWith: this.checkedWith } : {}),
    };
  }

  /** Record and protocol constructors by CSPm name, for reading values back. */
  private constructors(): CspSourceMap['constructors'] {
    const out: CspSourceMap['constructors'] = {};
    for (const fam of this.data.families.values()) {
      const root = fam.ctors[0]?.owner ?? fam.type;
      out[fam.nullCtor] = { kind: 'null', type: root, fields: [] };
      for (const c of fam.ctors) out[c.ctor] = { kind: fam.kind, type: c.owner, tag: c.tag, fields: c.fields.map((f) => f.name) };
    }
    return out;
  }

  private badPayload(ir: ProcIR, at: A.Span, t: DType): void {
    this.unsupported.push({ message: `a par branch receives a ${describe(t)} value from its parent, which the model cannot enumerate`, at: this.ref(ir, at) });
  }

  private channelRef(local: { name: string; kind: 'channel' | 'barrier'; ident: A.Ident }, ir: ProcIR, network: ReturnType<typeof buildNetwork>): ChannelRef {
    for (const p of network.roots.flatMap((r) => r.processes)) {
      const ref = p.channels[this.localNames.get(local.ident) ?? ''];
      if (ref) return ref;
    }
    return { name: local.name, kind: local.kind, declaration: this.ref(ir, local.ident.span), owner: [] };
  }

  /** `main: x; squarer: v; channels a, b`: what is saturated, for the header and the assumptions. */
  private saturatedText(): string {
    const parts: string[] = [];
    for (const [ir, vars] of this.saturation.vars) {
      const names = [...new Set([...vars].map((v) => ir.vars.get(v)?.name ?? v).filter((n) => !/^pj_/.test(n)))];
      if (names.length) parts.push(`${ir.decl.name.name}: ${names.join(', ')}`);
    }
    const channels: string[] = [];
    for (const ir of this.procs.values()) {
      for (const local of ir.locals) if (local.kind === 'channel' && local.elem?.k === 'int' && local.elem.sat) channels.push(local.cspm);
    }
    if (channels.length) parts.push(`channel${channels.length === 1 ? '' : 's'} ${channels.join(', ')}`);
    return parts.join('; ');
  }

  private assumptions(): string[] {
    return [
      `Integers (byte, short, char, int, long) range over ${this.data.lo}..${this.data.hi}; storing or sending a value outside the range is reported as a runtime error of the model, not wrapped.`,
      ...(this.checkedWith ? [`${this.checkedWith.text}: its arguments decide its network (how many processes and channels it runs), so it is checked as called, not with every value.`] : []),
      ...(this.data.saturated
        ? [`Integers that never decide anything (no condition, loop, index, divisor or specification depends on them: they are only passed on, kept in variables or printed) are not range-checked: outside ${this.data.lo}..${this.data.hi} they become one value, shown as "a value outside ${this.data.lo}..${this.data.hi}", which cannot change a verdict.${this.saturatedText() ? ` Here: ${this.saturatedText()}.` : ''}`]
        : []),
      'Time is abstract: timer reads give one abstract value and a timeout may end at any moment.',
      'string, float and double values are one abstract value; a decision that depends on one is a nondeterministic choice.',
      'alt and pri alt both choose any ready guard (the runtime takes the first ready one in source order); a skip guard written first is exact.',
      'Shared channel ends are locked as the language specifies; channels are synchronous rendezvous.',
      'Barriers follow the ProcessJ runtime exactly: a sync completes when the last enrolled process arrives, and a branch that ends resigns without completing a barrier.',
      'Records, protocols and arrays are values: a change through one reference is not seen through another.',
      'println and print do nothing; random numbers are any modelled integer.',
    ];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class UnionFind {
  private readonly parent = new Map<string, string>();
  find(x: string): string {
    let root = x;
    while (this.parent.has(root) && this.parent.get(root) !== root) root = this.parent.get(root)!;
    this.parent.set(x, root);
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/**
 * The set a fork's slots take their fields from (gen.ts forkSetName): per
 * instance, the tuples its parents send (a field elaboration does not know
 * ranges over its declared set); every declared value for an instance
 * elaboration never reached.
 */
function forkSets(c: ForkChannel, domains: string[], known: ReadonlyMap<number, Array<Array<number | boolean | undefined>>> | undefined, count: number): string[] {
  const name = forkSetName(c.name);
  const vars = domains.map((_, i) => `pj_f${i}`);
  const pattern = vars.join('.');
  const all = `{ ${pattern} | ${vars.map((v, i) => `${v} <- ${domains[i]}`).join(', ')} }`;
  const setOf = (tuples: Array<Array<number | boolean | undefined>> | undefined): string => {
    if (!tuples?.length) return all;
    const parts = tuples.map((t) => {
      if (t.every((v) => v !== undefined)) return `{ ${t.map(String).join('.')} }`;
      const free = vars.filter((_, i) => t[i] === undefined);
      return `{ ${vars.map((v, i) => (t[i] === undefined ? v : String(t[i]))).join('.')} | ${free.map((v) => `${v} <- ${domains[vars.indexOf(v)]}`).join(', ')} }`;
    });
    return parts.length === 1 ? parts[0] : `Union({ ${parts.join(', ')} })`;
  };
  if (!c.instanced) return [`${name} = ${setOf(known?.get(0))}`];
  return Array.from({ length: Math.max(1, count) }, (_, i) => `${name}(${i + 1}) = ${setOf(known?.get(i + 1))}`);
}

function range(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let i = lo; i <= hi; i++) out.push(i);
  return out;
}

/** `a`, `a and b`, `a, b and c`. */
function listText(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** `line 75`, or `line 3 of util.pj` outside the document. */
function where(ref: SourceRef, documentUri: string): string {
  return ref.uri === documentUri ? `line ${ref.span.start.line + 1}` : `line ${ref.span.start.line + 1} of ${decodeURIComponent(ref.uri.split('/').pop() ?? ref.uri)}`;
}

function sameNumbers(a: ReadonlySet<number>, b: ReadonlySet<number> | undefined): boolean {
  return !!b && a.size === b.size && [...a].every((x) => b.has(x));
}

function paramSlot(procId: number, index: number): string {
  return `p:${procId}:${index}`;
}

function identKey(unit: UnitIR, ident: A.Ident): string {
  return `${unit.uri}:${ident.span.start.line}:${ident.span.start.col}`;
}

function contains(span: A.Span, pos: A.Pos): boolean {
  const after = pos.line > span.start.line || (pos.line === span.start.line && pos.col >= span.start.col);
  const before = pos.line < span.end.line || (pos.line === span.end.line && pos.col <= span.end.col);
  return after && before;
}

/** The source of a span (several lines joined), for labels. */
function sourceText(text: string | undefined, span: A.Span): string | undefined {
  if (!text) return undefined;
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (let l = span.start.line; l <= span.end.line && l < lines.length; l++) {
    const line = lines[l];
    const from = l === span.start.line ? span.start.col : 0;
    const to = l === span.end.line ? span.end.col : line.length;
    // Drop line comments (a crude cut that ignores '//' inside strings, which only shortens a label).
    out.push(line.slice(from, to).replace(/\/\/.*$/, ''));
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/** The first line of a span's source, for comments and definition texts. */
function sourceLine(text: string | undefined, span: A.Span): string | undefined {
  const full = sourceText(text, span);
  if (!full) return undefined;
  return full.length > 100 ? `${full.slice(0, 97)}...` : full;
}

/** What a user's assertion checks; `assert not ...` holds when the property after `not` fails. */
function assertionKind(assertion: string): { property: CheckProperty; negated: boolean } {
  const negated = /^not\b/.test(assertion.trim());
  return { property: negated ? 'custom' : propertyOf(assertion), negated };
}

/** Lines of generated text so far (entries can hold several lines). */
function lineCount(lines: string[]): number {
  return lines.reduce((n, l) => n + 1 + (l.match(/\n/g)?.length ?? 0), 0);
}

/**
 * The assertions of a CSPm block, in order: each `assert` that starts a line
 * outside a comment, with the lines after it that are indented further (an
 * assertion can span lines), whitespace collapsed.
 */
export function blockAssertions(text: string): string[] {
  const out: string[] = [];
  const lines = stripCspmComments(text).split('\n');
  const indent = (l: string): number => l.length - l.trimStart().length;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)assert\s+(.*)$/.exec(lines[i]);
    if (!m) continue;
    const parts = [m[2]];
    while (i + 1 < lines.length && lines[i + 1].trim() && indent(lines[i + 1]) > m[1].length) parts.push(lines[++i].trim());
    const assertion = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (assertion) out.push(assertion);
  }
  return out;
}

/** CSPm with its comments (`-- ...` to the end of a line, nested `{- ... -}`) turned into spaces; line breaks stay. */
export function stripCspmComments(text: string): string {
  let out = '';
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (depth === 0 && !inString && ch === '"') inString = true;
    else if (inString && ch === '"' && text[i - 1] !== '\\') inString = false;
    if (inString) {
      out += ch;
      continue;
    }
    if (ch === '{' && next === '-') {
      depth++;
      out += '  ';
      i++;
      continue;
    }
    if (depth > 0 && ch === '-' && next === '}') {
      depth--;
      out += '  ';
      i++;
      continue;
    }
    if (depth > 0) {
      out += ch === '\n' ? '\n' : ' ';
      continue;
    }
    if (ch === '-' && next === '-') {
      while (i < text.length && text[i] !== '\n') {
        out += ' ';
        i++;
      }
      if (i < text.length) out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

function propertyOf(assertion: string): CheckProperty {
  if (/:\[\s*deadlock\s+free/.test(assertion)) return 'deadlock-free';
  if (/:\[\s*divergence\s+free/.test(assertion)) return 'divergence-free';
  if (/:\[\s*deterministic/.test(assertion)) return 'deterministic';
  if (/\[(T|F|FD)=/.test(assertion)) return 'refinement';
  return 'custom';
}

function typeText(t: { k: string; name?: string; elem?: unknown }): string {
  const x = t as { k: string; name?: string; elem?: { k: string; name?: string } };
  if (x.k === 'chan' && x.elem) return typeText(x.elem);
  return x.name ?? x.k;
}

function isChanArray(t: { k: string; elem?: unknown }): boolean {
  let x: { k: string; elem?: unknown } = t;
  while (x.k === 'array' && x.elem) x = x.elem as { k: string; elem?: unknown };
  return x !== t && x.k === 'chan';
}
