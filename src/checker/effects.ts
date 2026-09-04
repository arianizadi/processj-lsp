/**
 * Binding-aware procedure effect summaries.
 *
 * Effects are MAY-effects: a flag says that some execution path can perform the
 * operation. `confidence` describes how completely names/resources were resolved,
 * not whether the path is guaranteed to execute.
 *
 * The analysis is deliberately independent of the ProcessJ compiler. Call edges
 * come from the checker's exact overload resolution, while parameter channel
 * effects are substituted through calls. A caller/callee cycle is solved to a
 * fixed point inside its strongly-connected component.
 */
import type { CheckResult } from './checker';
import { forEachReachableStatement } from './controlflow';
import { isPrim } from './types';
import type * as A from '../parser/ast';

export type EffectConfidence = 'exact' | 'conservative' | 'unknown';

export type EffectKind =
  | 'channel-read'
  | 'channel-write'
  | 'blocking'
  | 'par'
  | 'alt'
  | 'barrier'
  | 'timer'
  | 'mobile'
  | 'unknown';

/** One parsed/checker result pair. Supply imported programs too for workspace summaries. */
export interface EffectUnit {
  program: A.Program;
  checked: CheckResult;
  file?: string;
}

/**
 * Summary facts for one procedure. Channel parameter sets contain zero-based
 * formal parameter indices; local-channel traffic is represented by the boolean
 * channel flags but does not escape into those sets.
 */
export interface EffectFacts {
  channelRead: boolean;
  channelWrite: boolean;
  channelReads: ReadonlySet<number>;
  channelWrites: ReadonlySet<number>;
  /** May suspend the cooperative process, including a scheduler yield in par/alt. */
  blocking: boolean;
  par: boolean;
  alt: boolean;
  barrier: boolean;
  timer: boolean;
  mobile: boolean;
  /** Some behavior or resource binding could not be characterized. */
  unknown: boolean;
  confidence: EffectConfidence;
}

/** A directly-written effect, retained for graph edges and source navigation. */
export interface EffectSite {
  kind: EffectKind;
  span: A.Span;
  /** Formal parameter involved in a direct channel operation, when known. */
  parameter?: number;
}

export type ArgumentOrigin =
  | { kind: 'parameter'; index: number }
  | { kind: 'local' }
  | { kind: 'unknown' };

export interface ProcedureCallEffect {
  call: A.Invocation;
  target?: A.ProcDecl;
  targetFile?: string;
  /** `exact` means the checker selected the overload and its unit was supplied. */
  resolution: 'exact' | 'unresolved' | 'external';
  arguments: readonly ArgumentOrigin[];
}

export interface ProcedureEffectSummary {
  decl: A.ProcDecl;
  file?: string;
  direct: EffectFacts;
  transitive: EffectFacts;
  sites: readonly EffectSite[];
  calls: readonly ProcedureCallEffect[];
  recursive: boolean;
  /** Stable only within this analysis result; useful for grouping recursive procedures. */
  scc: number;
}

export interface EffectAnalysis {
  summaries: ReadonlyMap<A.ProcDecl, ProcedureEffectSummary>;
  ordered: readonly ProcedureEffectSummary[];
  get(decl: A.ProcDecl): ProcedureEffectSummary | undefined;
}

interface MutableFacts extends Omit<EffectFacts, 'channelReads' | 'channelWrites'> {
  channelReads: Set<number>;
  channelWrites: Set<number>;
}

interface MutableSummary extends Omit<ProcedureEffectSummary, 'direct' | 'transitive' | 'sites' | 'calls'> {
  direct: MutableFacts;
  transitive: MutableFacts;
  sites: EffectSite[];
  calls: ProcedureCallEffect[];
}

const CONFIDENCE_RANK: Record<EffectConfidence, number> = {
  exact: 0,
  conservative: 1,
  unknown: 2,
};

/** Analyze one or more already-checked programs as a single call graph. */
export function analyzeProcedureEffects(units: readonly EffectUnit[]): EffectAnalysis {
  const summaries = new Map<A.ProcDecl, MutableSummary>();
  const owners = new Map<A.ProcDecl, EffectUnit>();
  const variablesByUnit = new Map(units.map((unit) => [unit, new Map(unit.checked.vars.map((variable) => [variable.decl, variable]))]));

  for (const unit of units) {
    for (const decl of unit.program.decls) {
      if (decl.kind !== 'ProcDecl' || summaries.has(decl)) continue;
      const facts = emptyFacts();
      summaries.set(decl, {
        decl,
        file: unit.file,
        direct: facts,
        transitive: cloneFacts(facts),
        sites: [],
        calls: [],
        recursive: false,
        scc: -1,
      });
      owners.set(decl, unit);
    }
  }

  // Collect direct facts only after all declarations are known, so calls can be
  // classified as internal/external independently of unit order.
  for (const summary of summaries.values()) {
    const unit = owners.get(summary.decl)!;
    collectDirect(summary, unit.checked, summaries, variablesByUnit.get(unit)!);
    summary.transitive = cloneFacts(summary.direct);
  }

  const components = stronglyConnectedComponents([...summaries.values()], summaries);
  components.forEach((component, id) => {
    const recursive = component.length > 1 || component.some((summary) => summary.calls.some((call) => call.target === summary.decl));
    for (const summary of component) {
      summary.scc = id;
      summary.recursive = recursive;
    }
  });

  // Tarjan emits sink components before callers for caller -> callee edges. An
  // acyclic component needs one merge; a recursive component needs a local
  // monotone fixed point because parameter indices may be permuted around a cycle.
  for (const component of components) {
    if (component.length === 1 && !component[0].recursive) {
      const summary = component[0];
      const next = cloneFacts(summary.direct);
      for (const call of summary.calls) {
        if (call.resolution !== 'exact' || !call.target) continue;
        const callee = summaries.get(call.target);
        if (callee) mergeCall(next, callee.transitive, call.arguments);
      }
      summary.transitive = next;
      continue;
    }
    const members = new Set(component);
    const callers = new Map(component.map((summary) => [summary, new Set<MutableSummary>()]));
    for (const caller of component) {
      for (const call of caller.calls) {
        if (call.resolution !== 'exact' || !call.target) continue;
        const callee = summaries.get(call.target);
        if (callee && members.has(callee)) callers.get(callee)!.add(caller);
      }
    }

    // Revisit only callers whose callee actually gained a fact. This avoids
    // repeated whole-component sweeps on large recursive call graphs.
    const pending = [...component];
    const queued = new Set(pending);
    while (pending.length) {
      const summary = pending.pop()!;
      queued.delete(summary);
      const next = cloneFacts(summary.direct);
      for (const call of summary.calls) {
        if (call.resolution !== 'exact' || !call.target) continue;
        const callee = summaries.get(call.target);
        if (callee) mergeCall(next, callee.transitive, call.arguments);
      }
      if (sameFacts(next, summary.transitive)) continue;
      summary.transitive = next;
      for (const caller of callers.get(summary)!) {
        if (queued.has(caller)) continue;
        pending.push(caller);
        queued.add(caller);
      }
    }
  }

  const ordered: ProcedureEffectSummary[] = [...summaries.values()];
  const exposed = summaries as ReadonlyMap<A.ProcDecl, ProcedureEffectSummary>;
  return {
    summaries: exposed,
    ordered,
    get: (decl) => exposed.get(decl),
  };
}

function collectDirect(
  summary: MutableSummary,
  checked: CheckResult,
  all: ReadonlyMap<A.ProcDecl, MutableSummary>,
  variablesByDecl: ReadonlyMap<A.Ident, CheckResult['vars'][number]>,
): void {
  const { decl, direct, sites, calls } = summary;
  const aliases = new Map<CheckResult['vars'][number], ArgumentOrigin>();
  const aggregateAliases = new Map<CheckResult['vars'][number], Map<string, ArgumentOrigin>>();
  if (decl.modifiers.includes('mobile')) {
    direct.mobile = true;
    sites.push({ kind: 'mobile', span: decl.name.span });
  }
  if (!decl.body) {
    markUnknown(direct, sites, decl.span, 'unknown');
    direct.blocking = true;
    return;
  }

  const parameterOrigin = (expr: A.Expr): ArgumentOrigin => argumentOrigin(expr, decl, checked, aliases, aggregateAliases);

  const channelEffect = (kind: 'channel-read' | 'channel-write', target: A.Expr, span: A.Span): void => {
    const origin = parameterOrigin(target);
    const parameter = origin.kind === 'parameter' ? origin.index : undefined;
    if (kind === 'channel-read') {
      direct.channelRead = true;
      if (parameter !== undefined) direct.channelReads.add(parameter);
    } else {
      direct.channelWrite = true;
      if (parameter !== undefined) direct.channelWrites.add(parameter);
    }
    direct.blocking = true;
    sites.push({ kind, span, parameter });
    if (origin.kind === 'unknown') {
      direct.unknown = true;
      lowerConfidence(direct, 'conservative');
    }
  };

  const localDecl = (statement: A.LocalDecl): void => {
    if (statement.isMobile) {
      direct.mobile = true;
      sites.push({ kind: 'mobile', span: statement.span });
    }
    for (const declarator of statement.declarators) {
      if (declarator.init) expression(declarator.init);
      const variable = variablesByDecl.get(declarator.name);
      if (!variable || !declarator.init) continue;
      const origin = localInitializerOrigin(declarator.init, parameterOrigin);
      if (origin.kind !== 'local') aliases.set(variable, origin);
    }
  };

  const call = (expr: A.Invocation): void => {
    const selected = checked.calls.get(expr);
    const arguments_ = expr.args.map(parameterOrigin);
    if (!selected) {
      calls.push({ call: expr, resolution: 'unresolved', arguments: arguments_ });
      markUnknown(direct, sites, expr.span, 'unknown');
      // An unresolved call must not make a "non-blocking" summary unsound.
      direct.blocking = true;
      return;
    }
    const target = selected.decl;
    const internal = all.has(target);
    calls.push({
      call: expr,
      target,
      targetFile: selected.file,
      resolution: internal ? 'exact' : 'external',
      arguments: arguments_,
    });
    if (!internal) {
      markUnknown(direct, sites, expr.span, 'unknown');
      direct.blocking = true;
      if (target.modifiers.includes('mobile')) direct.mobile = true;
    }
  };

  const expression = (expr: A.Expr): void => {
    switch (expr.kind) {
      case 'Literal':
      case 'NameExpr':
        return;
      case 'ErrorExpr':
        markUnknown(direct, sites, expr.span, 'unknown');
        return;
      case 'ParenExpr':
      case 'CastExpr':
      case 'IsExpr':
        expression(expr.expr);
        return;
      case 'BinaryExpr':
        expression(expr.left);
        expression(expr.right);
        return;
      case 'UnaryExpr':
        expression(expr.operand);
        return;
      case 'AssignExpr':
        expression(expr.target);
        expression(expr.value);
        // A mutable channel alias needs flow-sensitive joins to stay exact
        // across branches. Keep the useful sequential origin, but expose that
        // uncertainty instead of silently claiming a parameter is untouched.
        if (expr.op === '=' && expr.target.kind === 'NameExpr') {
          const variable = checked.resolutions.get(expr.target);
          if (variable && mayCarryChannel(variable.type)) {
            aliases.set(variable, parameterOrigin(expr.value));
            aggregateAliases.delete(variable);
            markUnknown(direct, sites, expr.span, 'conservative');
          }
        } else if (expr.op === '=' && (expr.target.kind === 'RecordAccess' || expr.target.kind === 'ArrayAccess')) {
          const root = aggregateRootVariable(expr.target, checked);
          if (root && mayCarryChannel(root.type)) {
            const path = staticAggregatePath(expr.target, checked);
            if (path && path.variable === root && path.members.length > 0) {
              let fields = aggregateAliases.get(root);
              if (!fields) {
                fields = new Map();
                aggregateAliases.set(root, fields);
              }
              const key = path.members.join('.');
              // Replacing an aggregate field also replaces every more-specific
              // origin previously remembered below it.
              for (const existing of fields.keys()) if (existing === key || existing.startsWith(`${key}.`)) fields.delete(existing);
              fields.set(key, parameterOrigin(expr.value));
            } else {
              // Array indices and other dynamic lvalues can alias any element.
              aliases.set(root, { kind: 'unknown' });
              aggregateAliases.delete(root);
            }
            markUnknown(direct, sites, expr.span, 'conservative');
          }
        }
        return;
      case 'TernaryExpr':
        expression(expr.cond);
        expression(expr.then);
        expression(expr.else);
        return;
      case 'Invocation':
        if (expr.target) expression(expr.target);
        for (const argument of expr.args) expression(argument);
        call(expr);
        return;
      case 'RecordAccess':
      case 'ChanEnd':
        expression(expr.target);
        return;
      case 'ArrayAccess':
        expression(expr.target);
        expression(expr.index);
        return;
      case 'ChanRead': {
        expression(expr.target);
        // `timer.read()` shares the parser node with a channel read but does not
        // rendezvous or block.
        const targetType = checked.types.get(expr.target);
        if (targetType && isPrim(targetType, 'timer')) {
          direct.timer = true;
          sites.push({ kind: 'timer', span: expr.span });
        } else {
          channelEffect('channel-read', expr.target, expr.span);
        }
        if (expr.extended) statement(expr.extended);
        return;
      }
      case 'ChanWrite':
        expression(expr.target);
        expression(expr.value);
        channelEffect('channel-write', expr.target, expr.span);
        return;
      case 'Sync':
        expression(expr.target);
        direct.barrier = true;
        direct.blocking = true;
        sites.push({ kind: 'barrier', span: expr.span });
        return;
      case 'Timeout':
        expression(expr.target);
        expression(expr.delay);
        direct.timer = true;
        direct.blocking = true;
        sites.push({ kind: 'timer', span: expr.span });
        return;
      case 'NewArray':
        for (const dimension of expr.dimExprs) expression(dimension);
        if (expr.init) expression(expr.init);
        return;
      case 'ArrayLiteral':
        for (const element of expr.elements) expression(element);
        return;
      case 'RecordLiteral':
      case 'ProtocolLiteral':
        for (const field of expr.fields) expression(field.value);
        return;
      case 'NewMobile':
        direct.mobile = true;
        // The compiler's yield rewriter treats process creation as a scheduler
        // suspension point even when the spawned procedure body is empty.
        direct.blocking = true;
        sites.push({ kind: 'mobile', span: expr.span }, { kind: 'blocking', span: expr.span });
        return;
    }
  };

  const statement = (stmt: A.Stmt): void => {
    switch (stmt.kind) {
      case 'Block':
        forEachReachableStatement(stmt.stmts, statement);
        return;
      case 'LocalDecl':
        localDecl(stmt);
        return;
      case 'ExprStmt':
        expression(stmt.expr);
        return;
      case 'IfStmt':
        expression(stmt.cond);
        statement(stmt.then);
        if (stmt.else) statement(stmt.else);
        return;
      case 'WhileStmt':
        expression(stmt.cond);
        statement(stmt.body);
        return;
      case 'DoStmt':
        statement(stmt.body);
        expression(stmt.cond);
        return;
      case 'ForStmt':
        if (stmt.init) Array.isArray(stmt.init) ? stmt.init.forEach(expression) : localDecl(stmt.init);
        if (stmt.cond) expression(stmt.cond);
        stmt.update.forEach(expression);
        stmt.enroll.forEach(expression);
        if (stmt.enroll.length) {
          direct.barrier = true;
          for (const enrolled of stmt.enroll) sites.push({ kind: 'barrier', span: enrolled.span });
        }
        if (stmt.isPar) {
          direct.par = true;
          direct.blocking = true;
          sites.push({ kind: 'par', span: stmt.span });
        }
        statement(stmt.body);
        return;
      case 'ParBlock':
        direct.par = true;
        direct.blocking = true;
        sites.push({ kind: 'par', span: stmt.span });
        for (const enrolled of stmt.barriers) {
          expression(enrolled);
          direct.barrier = true;
          sites.push({ kind: 'barrier', span: enrolled.span });
        }
        // A par block's lexical children are processes, not sequential
        // siblings: one branch returning does not make the next branch dead.
        for (const branch of stmt.body.stmts) statement(branch);
        return;
      case 'SeqBlock':
        statement(stmt.body);
        return;
      case 'ClaimStmt':
        direct.blocking = true;
        sites.push({ kind: 'blocking', span: stmt.span });
        for (const channel of stmt.channels) channel.kind === 'LocalDecl' ? localDecl(channel) : expression(channel);
        statement(stmt.body);
        return;
      case 'SwitchStmt':
        expression(stmt.expr);
        for (const group of stmt.groups) {
          for (const label of group.labels) if (label) expression(label);
          // Each label can enter its group independently; only the executable
          // prefix within that group is a sequential reachability region.
          forEachReachableStatement(group.stmts, statement);
        }
        return;
      case 'AltStmt':
        direct.alt = true;
        direct.blocking = true;
        sites.push({ kind: 'alt', span: stmt.span });
        if (stmt.replicated?.init) Array.isArray(stmt.replicated.init) ? stmt.replicated.init.forEach(expression) : localDecl(stmt.replicated.init);
        if (stmt.replicated?.cond) expression(stmt.replicated.cond);
        stmt.replicated?.update.forEach(expression);
        for (const altCase of stmt.cases) {
          if (altCase.precondition) expression(altCase.precondition);
          if (altCase.guard?.kind === 'ReadGuard') {
            expression(altCase.guard.target);
            expression(altCase.guard.read);
          } else if (altCase.guard?.kind === 'TimeoutGuard') {
            expression(altCase.guard.timeout);
          }
          if (altCase.nested) statement(altCase.nested);
          if (altCase.body) statement(altCase.body);
        }
        return;
      case 'ReturnStmt':
        if (stmt.expr) expression(stmt.expr);
        return;
      case 'LabeledStmt':
        statement(stmt.stmt);
        return;
      case 'SuspendStmt':
        direct.blocking = true;
        direct.mobile = true;
        sites.push({ kind: 'blocking', span: stmt.span }, { kind: 'mobile', span: stmt.span });
        return;
      case 'BreakStmt':
      case 'ContinueStmt':
      case 'SkipStmt':
      case 'StopStmt':
      case 'EmptyStmt':
        return;
    }
  };

  statement(decl.body);
}

function argumentOrigin(
  expr: A.Expr,
  owner: A.ProcDecl,
  checked: CheckResult,
  aliases: ReadonlyMap<CheckResult['vars'][number], ArgumentOrigin>,
  aggregateAliases: ReadonlyMap<CheckResult['vars'][number], ReadonlyMap<string, ArgumentOrigin>>,
): ArgumentOrigin {
  const path = staticAggregatePath(expr, checked);
  if (path && path.members.length > 0) {
    const fields = aggregateAliases.get(path.variable);
    // A parent-field replacement also owns all resources nested below it; use
    // the most-specific override available for this path.
    for (let length = path.members.length; fields && length > 0; length--) {
      const origin = fields.get(path.members.slice(0, length).join('.'));
      if (origin) return origin;
    }
  }
  // A channel can live in a record field or array element. Attribute that
  // traffic to the formal parameter that owns the resource, not merely to
  // parameters whose declared type is itself a channel.
  while (
    expr.kind === 'ParenExpr'
    || expr.kind === 'CastExpr'
    || expr.kind === 'ChanEnd'
    || expr.kind === 'RecordAccess'
    || expr.kind === 'ArrayAccess'
  ) {
    expr = expr.kind === 'ParenExpr' || expr.kind === 'CastExpr' ? expr.expr : expr.target;
  }
  if (expr.kind !== 'NameExpr') return { kind: 'unknown' };
  const variable = checked.resolutions.get(expr);
  if (!variable) return { kind: 'unknown' };
  const alias = aliases.get(variable);
  if (alias) return alias;
  if (!variable.isParam) return { kind: 'local' };
  const index = owner.params.findIndex((parameter) => parameter.name === variable.decl);
  return index >= 0 ? { kind: 'parameter', index } : { kind: 'unknown' };
}

function aggregateRootVariable(expr: A.Expr, checked: CheckResult): CheckResult['vars'][number] | undefined {
  while (
    expr.kind === 'ParenExpr'
    || expr.kind === 'CastExpr'
    || expr.kind === 'ChanEnd'
    || expr.kind === 'RecordAccess'
    || expr.kind === 'ArrayAccess'
  ) {
    expr = expr.kind === 'ParenExpr' || expr.kind === 'CastExpr' ? expr.expr : expr.target;
  }
  return expr.kind === 'NameExpr' ? checked.resolutions.get(expr) : undefined;
}

/** A field-only path. Indexed and computed access is deliberately not exact. */
function staticAggregatePath(expr: A.Expr, checked: CheckResult): { variable: CheckResult['vars'][number]; members: string[] } | undefined {
  if (expr.kind === 'ParenExpr' || expr.kind === 'CastExpr' || expr.kind === 'ChanEnd') return staticAggregatePath(expr.kind === 'ChanEnd' ? expr.target : expr.expr, checked);
  if (expr.kind === 'NameExpr') {
    const variable = checked.resolutions.get(expr);
    return variable ? { variable, members: [] } : undefined;
  }
  if (expr.kind !== 'RecordAccess') return undefined;
  const target = staticAggregatePath(expr.target, checked);
  if (!target) return undefined;
  return { variable: target.variable, members: [...target.members, expr.member.name] };
}

function localInitializerOrigin(expr: A.Expr, resolve: (expr: A.Expr) => ArgumentOrigin): ArgumentOrigin {
  const resolved = resolve(expr);
  if (resolved.kind !== 'unknown') return resolved;
  while (expr.kind === 'ParenExpr' || expr.kind === 'CastExpr') expr = expr.expr;
  switch (expr.kind) {
    case 'NewArray':
    case 'ArrayLiteral':
    case 'RecordLiteral':
    case 'ProtocolLiteral':
    case 'NewMobile':
      return { kind: 'local' };
    default:
      return resolved;
  }
}

function mayCarryChannel(type: CheckResult['vars'][number]['type']): boolean {
  // Aggregate declarations may contain channels at arbitrary field depth. The
  // compact checker Type intentionally stores only their nominal name here, so
  // a mutable record/protocol alias must be treated as channel-carrying unless
  // a future declaration-aware proof establishes otherwise.
  if (type.k === 'chan' || type.k === 'record' || type.k === 'protocol' || type.k === 'unknown') return true;
  return type.k === 'array' && mayCarryChannel(type.elem);
}

function emptyFacts(): MutableFacts {
  return {
    channelRead: false,
    channelWrite: false,
    channelReads: new Set(),
    channelWrites: new Set(),
    blocking: false,
    par: false,
    alt: false,
    barrier: false,
    timer: false,
    mobile: false,
    unknown: false,
    confidence: 'exact',
  };
}

function cloneFacts(facts: EffectFacts): MutableFacts {
  return {
    channelRead: facts.channelRead,
    channelWrite: facts.channelWrite,
    channelReads: new Set(facts.channelReads),
    channelWrites: new Set(facts.channelWrites),
    blocking: facts.blocking,
    par: facts.par,
    alt: facts.alt,
    barrier: facts.barrier,
    timer: facts.timer,
    mobile: facts.mobile,
    unknown: facts.unknown,
    confidence: facts.confidence,
  };
}

function mergeCall(into: MutableFacts, callee: EffectFacts, arguments_: readonly ArgumentOrigin[]): void {
  into.channelRead ||= callee.channelRead;
  into.channelWrite ||= callee.channelWrite;
  into.blocking ||= callee.blocking;
  into.par ||= callee.par;
  into.alt ||= callee.alt;
  into.barrier ||= callee.barrier;
  into.timer ||= callee.timer;
  into.mobile ||= callee.mobile;
  into.unknown ||= callee.unknown;
  lowerConfidence(into, callee.confidence);

  substituteParameters(into, into.channelReads, callee.channelReads, arguments_);
  substituteParameters(into, into.channelWrites, callee.channelWrites, arguments_);
}

function substituteParameters(into: MutableFacts, destination: Set<number>, source: ReadonlySet<number>, arguments_: readonly ArgumentOrigin[]): void {
  for (const parameter of source) {
    const origin = arguments_[parameter];
    if (origin?.kind === 'parameter') destination.add(origin.index);
    else if (!origin || origin.kind === 'unknown') {
      into.unknown = true;
      lowerConfidence(into, 'conservative');
    }
    // A local actual is deliberately absent from the caller's formal sets.
  }
}

function markUnknown(facts: MutableFacts, sites: EffectSite[], span: A.Span, confidence: EffectConfidence): void {
  facts.unknown = true;
  lowerConfidence(facts, confidence);
  sites.push({ kind: 'unknown', span });
}

function lowerConfidence(facts: MutableFacts, confidence: EffectConfidence): void {
  if (CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK[facts.confidence]) facts.confidence = confidence;
}

function sameFacts(a: EffectFacts, b: EffectFacts): boolean {
  return a.channelRead === b.channelRead
    && a.channelWrite === b.channelWrite
    && setEqual(a.channelReads, b.channelReads)
    && setEqual(a.channelWrites, b.channelWrites)
    && a.blocking === b.blocking
    && a.par === b.par
    && a.alt === b.alt
    && a.barrier === b.barrier
    && a.timer === b.timer
    && a.mobile === b.mobile
    && a.unknown === b.unknown
    && a.confidence === b.confidence;
}

function setEqual(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/** Iterative Kosaraju SCCs, emitted callee-first for caller -> callee edges. */
function stronglyConnectedComponents(nodes: readonly MutableSummary[], all: ReadonlyMap<A.ProcDecl, MutableSummary>): MutableSummary[][] {
  const adjacency = new Map(nodes.map((node) => [node, new Set<MutableSummary>()]));
  const reverse = new Map(nodes.map((node) => [node, new Set<MutableSummary>()]));
  for (const caller of nodes) {
    for (const call of caller.calls) {
      if (call.resolution !== 'exact' || !call.target) continue;
      const callee = all.get(call.target);
      if (!callee) continue;
      adjacency.get(caller)!.add(callee);
      reverse.get(callee)!.add(caller);
    }
  }

  const visited = new Set<MutableSummary>();
  const finished: MutableSummary[] = [];
  for (const root of nodes) {
    if (visited.has(root)) continue;
    const stack: Array<{ node: MutableSummary; finish: boolean }> = [{ node: root, finish: false }];
    while (stack.length) {
      const { node, finish } = stack.pop()!;
      if (finish) {
        finished.push(node);
        continue;
      }
      if (visited.has(node)) continue;
      visited.add(node);
      stack.push({ node, finish: true });
      const targets = [...adjacency.get(node)!];
      for (let i = targets.length - 1; i >= 0; i--) if (!visited.has(targets[i])) stack.push({ node: targets[i], finish: false });
    }
  }

  const assigned = new Set<MutableSummary>();
  const sourceFirst: MutableSummary[][] = [];
  for (let i = finished.length - 1; i >= 0; i--) {
    const root = finished[i];
    if (assigned.has(root)) continue;
    const component: MutableSummary[] = [];
    const stack = [root];
    assigned.add(root);
    while (stack.length) {
      const node = stack.pop()!;
      component.push(node);
      for (const caller of reverse.get(node)!) {
        if (assigned.has(caller)) continue;
        assigned.add(caller);
        stack.push(caller);
      }
    }
    sourceFirst.push(component);
  }
  return sourceFirst.reverse();
}
