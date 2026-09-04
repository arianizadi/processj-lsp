/**
 * A source-mapped, editor-facing concurrency model. This is intentionally a
 * static topology: uncertain edges are retained and labelled instead of being
 * silently omitted or presented as runtime facts.
 */
import type * as A from './parser/ast';
import { pathToFileURL } from 'node:url';
import type { CheckResult, VarInfo } from './checker/checker';
import { forEachReachableStatement } from './checker/controlflow';
import type { ProcedureEffectSummary } from './checker/effects';
import type { DeclIndex, ProcSig } from './checker/index';
import { typeStr } from './checker/types';

export type GraphConfidence = 'exact' | 'conditional' | 'unknown';
export type ConcurrencyNodeKind = 'procedure' | 'parallel' | 'branch' | 'alternation' | 'channel' | 'barrier' | 'timer' | 'mobile';
export type ConcurrencyEdgeKind = 'contains' | 'spawn' | 'join' | 'call' | 'read' | 'write' | 'pass-read' | 'pass-write' | 'choice' | 'sync' | 'timeout';

export interface SourceLocation {
  uri?: string;
  span: A.Span;
}

export interface ConcurrencyNode {
  id: string;
  kind: ConcurrencyNodeKind;
  label: string;
  source: SourceLocation;
  confidence: GraphConfidence;
  detail?: string;
  replicated?: boolean;
}

export interface ConcurrencyEdge {
  id: string;
  kind: ConcurrencyEdgeKind;
  from: string;
  to: string;
  source: SourceLocation;
  confidence: GraphConfidence;
  label?: string;
}

export interface ConcurrencyDeadlock {
  id: string;
  confidence: 'exact';
  cause: 'circular-wait' | 'missing-peer';
  parallelNode?: string;
  waits: Array<{ branch: number; operation: 'read' | 'write'; channelNode: string; source: SourceLocation }>;
  finishedBranches: number[];
}

export interface ProcedureEffectView {
  label: string;
  confidence: GraphConfidence;
}

export interface ConcurrencyGraph {
  version: 1;
  uri?: string;
  nodes: ConcurrencyNode[];
  edges: ConcurrencyEdge[];
  deadlocks: ConcurrencyDeadlock[];
  procedureEffects: Record<string, ProcedureEffectView[]>;
}

/** The part of a procedure's effect summary the graph renders. */
export type GraphEffectSummary = Pick<ProcedureEffectSummary, 'decl' | 'transitive'>;

export interface ConcurrencyGraphOptions {
  uri?: string;
  effects?: ReadonlyMap<A.ProcDecl, GraphEffectSummary>;
}

const GRAPH_CONFIDENCE_RANK: Record<GraphConfidence, number> = { exact: 0, conditional: 1, unknown: 2 };

/** Compose evidence without ever upgrading a less-certain path. */
function combineConfidence(left: GraphConfidence, right: GraphConfidence): GraphConfidence {
  return GRAPH_CONFIDENCE_RANK[left] >= GRAPH_CONFIDENCE_RANK[right] ? left : right;
}

/** Build a deterministic graph for one checked program. */
export function buildConcurrencyGraph(program: A.Program, checked: CheckResult, index: DeclIndex, opts: ConcurrencyGraphOptions = {}): ConcurrencyGraph {
  const nodes = new Map<string, ConcurrencyNode>();
  const edges: ConcurrencyEdge[] = [];
  const procIds = new Map<A.ProcDecl, string>();
  const variableNodes = new Map<VarInfo, string>();
  const variablesByDecl = new Map(checked.vars.map((variable) => [variable.decl, variable]));
  const channelFacts = new Map(checked.channels.map((fact) => [fact.variable, fact]));
  const parIds = new Map<A.ParBlock, string>();
  const procedureEffects: Record<string, ProcedureEffectView[]> = {};
  let edgeSerial = 0;

  const normalizedUri = (value: string | undefined): string | undefined => {
    if (!value) return value;
    // `C:\\...` is a filesystem path, not an RFC URI with scheme `c:`.
    return !/^[a-z]:[\\/]/i.test(value) && /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : pathToFileURL(value).toString();
  };
  const source = (span: A.Span, uri = opts.uri): SourceLocation => ({ uri: normalizedUri(uri), span });
  const stable = (kind: string, span: A.Span, suffix = '', uri = opts.uri): string => `${kind}:${normalizedUri(uri) ?? ''}:${span.start.line}:${span.start.col}:${span.end.line}:${span.end.col}${suffix}`;
  const addNode = (node: ConcurrencyNode): string => {
    const existing = nodes.get(node.id);
    if (existing) existing.confidence = combineConfidence(existing.confidence, node.confidence);
    else nodes.set(node.id, node);
    return node.id;
  };
  const addEdge = (kind: ConcurrencyEdgeKind, from: string, to: string, span: A.Span, confidence: GraphConfidence = 'exact', label?: string): void => {
    edges.push({ id: `edge:${edgeSerial++}:${kind}:${from}:${to}`, kind, from, to, source: source(span), confidence, label });
  };

  const procId = (decl: A.ProcDecl, file = opts.uri): string => {
    let id = procIds.get(decl);
    if (id) return id;
    id = stable('proc', decl.name.span, `:${decl.name.name}:${decl.params.length}`, file);
    procIds.set(decl, id);
    const effect = opts.effects?.get(decl);
    const effectConfidence = effect?.transitive.confidence;
    addNode({
      id,
      kind: decl.modifiers.includes('mobile') ? 'mobile' : 'procedure',
      label: decl.name.name,
      source: source(decl.name.span, file),
      confidence: effectConfidence === 'conservative' ? 'conditional' : effectConfidence ?? 'exact',
      detail: `${decl.name.name}(${decl.params.map((p) => p.name.name).join(', ')})`,
    });
    if (effect) procedureEffects[id] = effectLabels(effect);
    return id;
  };

  const valueNode = (v: VarInfo): string => {
    let id = variableNodes.get(v);
    if (id) return id;
    const kind: ConcurrencyNodeKind = v.type.k === 'prim' && v.type.name === 'barrier' ? 'barrier' : v.type.k === 'prim' && v.type.name === 'timer' ? 'timer' : 'channel';
    id = stable(kind, v.decl.span, `:${v.proc}:${v.name}`);
    variableNodes.set(v, id);
    const fact = channelFacts.get(v);
    addNode({ id, kind, label: v.name, source: source(v.decl.span), confidence: fact?.escaped ? 'conditional' : 'exact', detail: `${typeStr(v.type)}${fact?.hazard ? ` · ${fact.hazard.replaceAll('-', ' ')}` : ''}` });
    return id;
  };

  const syntheticResource = (e: A.Expr, confidence: GraphConfidence = 'exact'): string => {
    const type = checked.types.get(e);
    const kind: ConcurrencyNodeKind = type?.k === 'prim' && type.name === 'barrier' ? 'barrier' : type?.k === 'prim' && type.name === 'timer' ? 'timer' : 'channel';
    const path = aggregateResourcePath(e);
    const root = path ? checked.resolutions.get(path.root) : undefined;
    // A named aggregate field denotes the same resource at every use. Anchor
    // its identity to the resolved variable declaration plus its exact member
    // path, while array/dynamic/opaque expressions remain deliberately
    // source-site-specific because their runtime identity can vary.
    const reusable = root && path && path.members.length > 0;
    const id = reusable
      ? stable(`${kind}-aggregate`, root.decl.span, `:${root.proc}:${root.name}:${path.members.join('.')}`)
      : stable(`${kind}-expression`, e.span);
    return addNode({
      id,
      kind,
      label: reusable ? `${root.name}.${path.members.join('.')}` : expressionLabel(e),
      source: source(reusable ? root.decl.span : e.span),
      confidence: combineConfidence(confidence, !type || type.k === 'unknown' || type.k === 'error' ? 'unknown' : 'conditional'),
      detail: type ? typeStr(type) : 'unresolved concurrency resource expression',
    });
  };

  const channelNode = (e: A.Expr, confidence: GraphConfidence = 'exact'): string => {
    const name = rootName(e);
    const variable = name ? checked.resolutions.get(name) : undefined;
    const directResource = variable && (variable.type.k === 'chan' || (variable.type.k === 'prim' && (variable.type.name === 'barrier' || variable.type.name === 'timer')));
    return directResource ? valueNode(variable) : syntheticResource(e, confidence);
  };

  const expressionConfidence = (e: A.Expr, confidence: GraphConfidence): GraphConfidence => {
    const type = checked.types.get(e);
    return !type || type.k === 'unknown' || type.k === 'error' ? combineConfidence(confidence, 'unknown') : confidence;
  };

  for (const decl of program.decls) if (decl.kind === 'ProcDecl') procId(decl);
  for (const fact of checked.channels) valueNode(fact.variable);

  /** Visit subexpressions of an operated endpoint without treating `.read`/`.write` as a passed value. */
  const visitOperationTarget = (e: A.Expr, owner: string, confidence: GraphConfidence): void => {
    if (e.kind === 'ParenExpr' || e.kind === 'CastExpr' || e.kind === 'ChanEnd') return visitOperationTarget(e.kind === 'ParenExpr' || e.kind === 'CastExpr' ? e.expr : e.target, owner, confidence);
    if (e.kind === 'RecordAccess') return visitExpr(e.target, owner, confidence);
    if (e.kind === 'ArrayAccess') {
      visitExpr(e.target, owner, confidence);
      visitExpr(e.index, owner, confidence);
      return;
    }
    visitExpr(e, owner, confidence);
  };

  const visitExpr = (e: A.Expr, owner: string, confidence: GraphConfidence = 'exact'): void => {
    switch (e.kind) {
      case 'Literal':
      case 'NameExpr':
      case 'ErrorExpr':
        return;
      case 'ParenExpr':
        return visitExpr(e.expr, owner, confidence);
      case 'BinaryExpr':
        visitExpr(e.left, owner, confidence);
        visitExpr(e.right, owner, e.op === '&&' || e.op === '||' ? combineConfidence(confidence, 'conditional') : confidence);
        return;
      case 'UnaryExpr':
        return visitExpr(e.operand, owner, confidence);
      case 'AssignExpr':
        visitExpr(e.target, owner, confidence);
        visitExpr(e.value, owner, confidence);
        return;
      case 'TernaryExpr':
        visitExpr(e.cond, owner, confidence);
        visitExpr(e.then, owner, combineConfidence(confidence, 'conditional'));
        visitExpr(e.else, owner, combineConfidence(confidence, 'conditional'));
        return;
      case 'CastExpr':
      case 'IsExpr':
        return visitExpr(e.expr, owner, confidence);
      case 'Invocation': {
        if (e.target) visitExpr(e.target, owner, confidence);
        const target = checked.calls.get(e);
        if (target) addEdge('call', owner, procId(target.decl, target.file), e.name.span, confidence, signatureLabel(target));
        else {
          const unresolved = addNode({ id: stable('unresolved-proc', e.name.span, `:${e.name.name}`), kind: 'procedure', label: e.name.name, source: source(e.name.span), confidence: 'unknown', detail: 'unresolved or external call' });
          addEdge('call', owner, unresolved, e.name.span, combineConfidence(confidence, 'unknown'));
        }
        e.args.forEach((arg, i) => {
          visitExpr(arg, owner, confidence);
          // `c.write` emits its pass edge while visiting the ChanEnd node. An
          // already-separated endpoint (`out`, `record.output`) has no ChanEnd
          // syntax, so recover its direction from the checked actual/formal.
          if (isExplicitChanEnd(arg)) return;
          const actual = checked.types.get(arg);
          const formal = target?.params[i];
          const end = actual?.k === 'chan' && actual.end
            ? actual.end
            : (actual?.k === 'unknown' || actual?.k === 'error' || !actual) && formal?.k === 'chan'
              ? formal.end
              : undefined;
          if (!end) return;
          const passConfidence = combineConfidence(confidence, actual?.k === 'chan' && actual.end ? 'exact' : 'unknown');
          addEdge(end === 'read' ? 'pass-read' : 'pass-write', owner, channelNode(arg, passConfidence), arg.span, passConfidence);
        });
        return;
      }
      case 'RecordAccess':
        return visitExpr(e.target, owner, confidence);
      case 'ArrayAccess':
        visitExpr(e.target, owner, confidence);
        visitExpr(e.index, owner, confidence);
        return;
      case 'ChanEnd':
        visitExpr(e.target, owner, confidence);
        {
          const passConfidence = expressionConfidence(e, confidence);
          addEdge(e.end === 'read' ? 'pass-read' : 'pass-write', owner, channelNode(e.target, passConfidence), e.span, passConfidence);
        }
        return;
      case 'ChanRead':
        visitOperationTarget(e.target, owner, confidence);
        // A timer's `.read()` samples the clock; it is neither channel traffic
        // nor a suspension point.
        {
          const targetType = checked.types.get(e.target);
          if (targetType?.k === 'prim' && targetType.name === 'timer') return;
        }
        {
          const operationConfidence = expressionConfidence(e.target, confidence);
          addEdge('read', owner, channelNode(e.target, operationConfidence), e.span, operationConfidence, e.extended ? 'extended rendezvous' : undefined);
        }
        if (e.extended) visitBlock(e.extended, owner, confidence);
        return;
      case 'ChanWrite':
        visitOperationTarget(e.target, owner, confidence);
        visitExpr(e.value, owner, confidence);
        {
          const operationConfidence = expressionConfidence(e.target, confidence);
          addEdge('write', owner, channelNode(e.target, operationConfidence), e.span, operationConfidence);
        }
        return;
      case 'Sync':
        visitExpr(e.target, owner, confidence);
        addEdge('sync', owner, channelNode(e.target, expressionConfidence(e.target, confidence)), e.span, expressionConfidence(e.target, confidence));
        return;
      case 'Timeout':
        visitExpr(e.target, owner, confidence);
        visitExpr(e.delay, owner, confidence);
        addEdge('timeout', owner, channelNode(e.target, expressionConfidence(e.target, confidence)), e.span, expressionConfidence(e.target, confidence));
        return;
      case 'NewArray':
        for (const d of e.dimExprs) visitExpr(d, owner, confidence);
        if (e.init) visitExpr(e.init, owner, confidence);
        return;
      case 'ArrayLiteral':
        for (const item of e.elements) visitExpr(item, owner, confidence);
        return;
      case 'RecordLiteral':
      case 'ProtocolLiteral':
        for (const field of e.fields) visitExpr(field.value, owner, confidence);
        return;
      case 'NewMobile': {
        const candidates = index.procs.get(e.typeName.name) ?? [];
        const target = candidates.length === 1 ? procId(candidates[0].decl, candidates[0].file) : addNode({ id: stable('mobile-expression', e.span), kind: 'mobile', label: e.typeName.name, source: source(e.span), confidence: 'unknown' });
        addEdge('spawn', owner, target, e.span, combineConfidence(confidence, candidates.length === 1 ? 'exact' : 'unknown'), 'mobile process');
        return;
      }
    }
  };

  const visitLocal = (decl: A.LocalDecl, owner: string, confidence: GraphConfidence = 'exact'): void => {
    for (const item of decl.declarators) {
      if (item.init) visitExpr(item.init, owner, confidence);
      const variable = variablesByDecl.get(item.name);
      if (variable && (variable.type.k === 'chan' || (variable.type.k === 'prim' && (variable.type.name === 'barrier' || variable.type.name === 'timer')))) {
        const id = valueNode(variable);
        addEdge('contains', owner, id, item.name.span, confidence);
      }
    }
  };

  const visitBlock = (block: A.Block, owner: string, confidence: GraphConfidence = 'exact'): void => {
    forEachReachableStatement(block.stmts, (stmt) => visitStmt(stmt, owner, confidence));
  };

  const visitStmt = (stmt: A.Stmt, owner: string, confidence: GraphConfidence = 'exact'): void => {
    switch (stmt.kind) {
      case 'Block':
        return visitBlock(stmt, owner, confidence);
      case 'LocalDecl':
        return visitLocal(stmt, owner, confidence);
      case 'ExprStmt':
        return visitExpr(stmt.expr, owner, confidence);
      case 'IfStmt':
        visitExpr(stmt.cond, owner, confidence);
        visitStmt(stmt.then, owner, combineConfidence(confidence, 'conditional'));
        if (stmt.else) visitStmt(stmt.else, owner, combineConfidence(confidence, 'conditional'));
        return;
      case 'WhileStmt':
        visitExpr(stmt.cond, owner, confidence);
        visitStmt(stmt.body, owner, combineConfidence(confidence, 'conditional'));
        return;
      case 'DoStmt':
        // A do body executes once when the statement is reached; only later
        // iterations (which this topology does not duplicate) are optional.
        visitStmt(stmt.body, owner, confidence);
        visitExpr(stmt.cond, owner, combineConfidence(confidence, 'conditional'));
        return;
      case 'ForStmt': {
        if (stmt.init) Array.isArray(stmt.init) ? stmt.init.forEach((e) => visitExpr(e, owner, confidence)) : visitLocal(stmt.init, owner, confidence);
        if (stmt.cond) visitExpr(stmt.cond, owner, confidence);
        const iterationConfidence = combineConfidence(confidence, 'conditional');
        stmt.update.forEach((e) => visitExpr(e, owner, iterationConfidence));
        stmt.enroll.forEach((e) => visitExpr(e, owner, confidence));
        if (!stmt.isPar) return visitStmt(stmt.body, owner, iterationConfidence);
        const par = addNode({ id: stable('par-for', stmt.span), kind: 'parallel', label: 'par for', source: source(stmt.span), confidence, replicated: true, detail: 'replicated process' });
        const branch = addNode({ id: stable('par-for-branch', stmt.body.span), kind: 'branch', label: 'iteration × N', source: source(stmt.body.span), confidence: iterationConfidence, replicated: true });
        addEdge('contains', owner, par, stmt.span, confidence);
        addEdge('spawn', par, branch, stmt.body.span, iterationConfidence, 'one process per iteration');
        visitStmt(stmt.body, branch, iterationConfidence);
        addEdge('join', branch, par, stmt.body.span, iterationConfidence);
        return;
      }
      case 'ParBlock': {
        const par = addNode({ id: stable('par', stmt.span), kind: 'parallel', label: 'par', source: source(stmt.span), confidence, detail: `${stmt.body.stmts.length} lexical branches` });
        parIds.set(stmt, par);
        addEdge('contains', owner, par, stmt.span, confidence);
        stmt.barriers.forEach((e) => visitExpr(e, par, confidence));
        stmt.body.stmts.forEach((branchStmt, i) => {
          const branch = addNode({ id: stable('branch', branchStmt.span, `:${i + 1}`), kind: 'branch', label: `branch ${i + 1}`, source: source(branchStmt.span), confidence });
          addEdge('spawn', par, branch, branchStmt.span, confidence);
          visitStmt(branchStmt, branch, confidence);
          addEdge('join', branch, par, branchStmt.span, confidence);
        });
        return;
      }
      case 'SeqBlock':
        return visitBlock(stmt.body, owner, confidence);
      case 'ClaimStmt':
        for (const channel of stmt.channels) Array.isArray(channel) ? undefined : channel.kind === 'LocalDecl' ? visitLocal(channel, owner, confidence) : visitExpr(channel, owner, confidence);
        return visitStmt(stmt.body, owner, confidence);
      case 'SwitchStmt':
        visitExpr(stmt.expr, owner, confidence);
        for (const group of stmt.groups) {
          const groupConfidence = combineConfidence(confidence, 'conditional');
          for (const label of group.labels) if (label) visitExpr(label, owner, groupConfidence);
          forEachReachableStatement(group.stmts, (child) => visitStmt(child, owner, groupConfidence));
        }
        return;
      case 'AltStmt': {
        const alt = addNode({ id: stable('alt', stmt.span), kind: 'alternation', label: stmt.isPri ? 'pri alt' : 'alt', source: source(stmt.span), confidence, detail: `${stmt.cases.length} alternatives` });
        addEdge('contains', owner, alt, stmt.span, confidence);
        if (stmt.replicated) {
          if (stmt.replicated.init) Array.isArray(stmt.replicated.init) ? stmt.replicated.init.forEach((e) => visitExpr(e, alt, confidence)) : visitLocal(stmt.replicated.init, alt, confidence);
          if (stmt.replicated.cond) visitExpr(stmt.replicated.cond, alt, confidence);
          stmt.replicated.update.forEach((e) => visitExpr(e, alt, combineConfidence(confidence, 'conditional')));
        }
        stmt.cases.forEach((c, i) => {
          const choiceConfidence = combineConfidence(confidence, 'conditional');
          const choice = addNode({ id: stable('alt-choice', c.span, `:${i + 1}`), kind: 'branch', label: `choice ${i + 1}`, source: source(c.span), confidence: choiceConfidence });
          addEdge('choice', alt, choice, c.span, choiceConfidence);
          if (c.precondition) visitExpr(c.precondition, choice, choiceConfidence);
          if (c.guard?.kind === 'ReadGuard') visitExpr(c.guard.read, choice, choiceConfidence);
          else if (c.guard?.kind === 'TimeoutGuard') visitExpr(c.guard.timeout, choice, choiceConfidence);
          if (c.nested) visitStmt(c.nested, choice, choiceConfidence);
          if (c.body) visitStmt(c.body, choice, choiceConfidence);
        });
        return;
      }
      case 'ReturnStmt':
        if (stmt.expr) visitExpr(stmt.expr, owner, confidence);
        return;
      case 'LabeledStmt':
        return visitStmt(stmt.stmt, owner, confidence);
      default:
        return;
    }
  };

  for (const decl of program.decls) {
    if (decl.kind !== 'ProcDecl' || !decl.body) continue;
    const owner = procId(decl);
    for (const param of decl.params) {
      const variable = variablesByDecl.get(param.name);
      if (variable && (variable.type.k === 'chan' || (variable.type.k === 'prim' && (variable.type.name === 'barrier' || variable.type.name === 'timer')))) {
        addEdge('contains', owner, valueNode(variable), param.name.span);
      }
    }
    visitBlock(decl.body, owner);
  }

  const deadlocks: ConcurrencyDeadlock[] = checked.deadlocks.map((finding, i) => ({
    id: stable('deadlock', finding.par.span, `:${i}`),
    confidence: finding.confidence,
    cause: finding.cause,
    parallelNode: parIds.get(finding.par),
    waits: finding.waits.map((wait) => ({ branch: wait.branch, operation: wait.operation, channelNode: valueNode(wait.channel), source: source(wait.span) })),
    finishedBranches: finding.finishedBranches,
  }));

  return { version: 1, uri: normalizedUri(opts.uri), nodes: [...nodes.values()], edges, deadlocks, procedureEffects };
}

/** Portable Markdown/DOT-like report for clients without the VS Code webview. */
export function formatConcurrencyMarkdown(title: string, graph: ConcurrencyGraph): string {
  const lines = [`# Concurrency graph — ${title}`, '', '```mermaid', 'flowchart LR'];
  const shortIds = new Map(graph.nodes.map((node, index) => [node.id, `n${index}`]));
  for (const node of graph.nodes) {
    const id = shortIds.get(node.id)!;
    const label = escapeMermaid(`${icon(node.kind)} ${node.label}${node.replicated ? ' × N' : ''}`);
    const shape = node.kind === 'channel' ? [`${id}[("${label}")]`] : node.kind === 'parallel' || node.kind === 'alternation' ? [`${id}{{"${label}"}}`] : [`${id}["${label}"]`];
    lines.push(`    ${shape[0]}`);
    if (node.confidence !== 'exact') lines.push(`    class ${id} uncertain`);
  }
  for (const edge of graph.edges) {
    const from = shortIds.get(edge.from);
    const to = shortIds.get(edge.to);
    if (!from || !to) continue;
    const label = escapeMermaid(edge.label ?? edge.kind);
    lines.push(`    ${from} ${edge.confidence === 'exact' ? '-->' : '-.->'}|${label}| ${to}`);
  }
  lines.push('    classDef uncertain stroke-dasharray: 5 5,opacity:0.75', '```', '');

  if (graph.deadlocks.length) {
    lines.push('## Confirmed deadlocks', '');
    for (const finding of graph.deadlocks) {
      const waits = finding.waits.map((wait) => `branch ${wait.branch} ${wait.operation}s on ${graph.nodes.find((n) => n.id === wait.channelNode)?.label ?? 'a channel'} (line ${wait.source.span.start.line + 1})`).join('; ');
      lines.push(`- **${finding.cause === 'circular-wait' ? 'Circular wait' : 'Missing peer'}:** ${waits}.`);
    }
    lines.push('');
  }

  const effectEntries = Object.entries(graph.procedureEffects).filter(([, facts]) => facts.length);
  if (effectEntries.length) {
    lines.push('## Procedure effects', '');
    for (const [id, facts] of effectEntries) {
      const proc = graph.nodes.find((node) => node.id === id);
      lines.push(`- **${proc?.label ?? id}:** ${facts.map((fact) => `${fact.label}${fact.confidence === 'exact' ? '' : ' (partial)'}`).join(', ')}`);
    }
    lines.push('');
  }

  lines.push('_Solid edges are exact. Dashed edges cross unresolved or conditional code._', '');
  return lines.join('\n');
}

function rootName(e: A.Expr): A.NameExpr | undefined {
  if (e.kind === 'NameExpr') return e;
  if (e.kind === 'ParenExpr' || e.kind === 'CastExpr') return rootName(e.expr);
  if (e.kind === 'RecordAccess' || e.kind === 'ArrayAccess' || e.kind === 'ChanEnd') return rootName(e.target);
  return undefined;
}

/** A resolved root plus a purely static field path; arrays stay per-use. */
function aggregateResourcePath(e: A.Expr): { root: A.NameExpr; members: string[] } | undefined {
  if (e.kind === 'ParenExpr' || e.kind === 'CastExpr') return aggregateResourcePath(e.expr);
  if (e.kind === 'NameExpr') return { root: e, members: [] };
  if (e.kind !== 'RecordAccess') return undefined;
  const target = aggregateResourcePath(e.target);
  if (!target) return undefined;
  return { root: target.root, members: [...target.members, e.member.name] };
}

/** Whether visiting this argument already emits the endpoint-pass edge. */
function isExplicitChanEnd(e: A.Expr): boolean {
  while (e.kind === 'ParenExpr' || e.kind === 'CastExpr') e = e.expr;
  return e.kind === 'ChanEnd';
}

function expressionLabel(e: A.Expr): string {
  switch (e.kind) {
    case 'NameExpr': return e.name.name;
    case 'RecordAccess': return `${expressionLabel(e.target)}.${e.member.name}`;
    case 'ArrayAccess': return `${expressionLabel(e.target)}[…]`;
    case 'ChanEnd': return `${expressionLabel(e.target)}.${e.end}`;
    case 'ParenExpr':
    case 'CastExpr': return expressionLabel(e.expr);
    default: return '<channel expression>';
  }
}

function signatureLabel(sig: ProcSig): string {
  return `${sig.name}(${sig.params.map(typeStr).join(', ')})`;
}

function effectLabels(summary: GraphEffectSummary): ProcedureEffectView[] {
  const f = summary.transitive;
  const confidence: GraphConfidence = f.confidence === 'conservative' ? 'conditional' : f.confidence;
  const out: ProcedureEffectView[] = [];
  const add = (on: boolean, label: string): void => { if (on) out.push({ label, confidence }); };
  const addChannels = (on: boolean, parameters: ReadonlySet<number>, verb: 'reads' | 'writes'): void => {
    if (!on) return;
    const ordered = [...parameters].sort((left, right) => left - right);
    if (ordered.length === 0) add(true, `${verb} channels`);
    else for (const parameter of ordered) add(true, `${verb} channel #${parameter + 1}`);
  };
  addChannels(f.channelRead, f.channelReads, 'reads');
  addChannels(f.channelWrite, f.channelWrites, 'writes');
  add(f.blocking, 'may block');
  add(f.par, 'spawns parallel work');
  add(f.alt, 'selects an alternative');
  add(f.barrier, 'waits on a barrier');
  add(f.timer, 'uses a timer');
  add(f.mobile, 'uses mobile-process semantics');
  add(f.unknown, 'has opaque effects');
  return out;
}

function icon(kind: ConcurrencyNodeKind): string {
  switch (kind) {
    case 'channel': return '↔';
    case 'parallel': return '⑂';
    case 'branch': return '⑂';
    case 'alternation': return '◇';
    case 'barrier': return '⏸';
    case 'timer': return '◷';
    case 'mobile': return '⇢';
    case 'procedure': return 'ƒ';
  }
}

function escapeMermaid(value: string): string {
  return value.replace(/["<>]/g, (character) => character === '"' ? "'" : character === '<' ? '‹' : '›').replace(/\|/g, '¦');
}
