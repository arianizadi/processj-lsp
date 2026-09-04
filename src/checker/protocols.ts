/**
 * Protocol-specific semantic facts for diagnostics, code actions and diagrams.
 *
 * This module is intentionally independent from the diagnostic reporter.  It
 * turns a checked syntax tree and its visible declaration index into stable,
 * span-rich facts that several LSP features can consume without walking the
 * tree again.  It does not attempt to invent session types: ProcessJ protocols
 * are tagged unions, so the flow facts below describe observed construction,
 * channel traffic and matching sites rather than guaranteed state transitions.
 */
import type * as A from '../parser/ast';
import { tokenize, type Token } from '../tokens';
import type { CheckResult, VarInfo } from './checker';
import { DeclIndex, type ProtocolInfo } from './index';
import { typeStr, type Type } from './types';

export type ProtocolIssueSeverity = 'error' | 'warning' | 'info';

export interface ProtocolAnalysisOptions {
  /** Stable URI/path used for syntax-tree facts from `program`. */
  file?: string;
  /** Enables exact spans when the parser's token stream is not available. */
  sourceText?: string;
  /** Reusing ParseResult.tokens avoids tokenizing `sourceText` a second time. */
  tokens?: readonly Token[];
}

/** Only the checker products this analysis needs. */
export type ProtocolSemanticInfo = Pick<CheckResult, 'types' | 'resolutions'>;

export interface ProtocolParentFact {
  id: string;
  name: string;
  span: A.Span;
  targetId?: string;
  resolved: boolean;
}

export interface ProtocolFieldFact {
  id: string;
  name: string;
  file?: string;
  span: A.Span;
  type: Type;
  typeLabel: string;
}

/**
 * One actual case declaration.  `ProtocolStructureFact.cases` contains only
 * declarations owned by that protocol, so a hierarchy does not duplicate the
 * same fact in every descendant.  Query results (for example missing switch
 * cases) may return a lightweight inherited view of the same declaration.
 */
export interface ProtocolCaseFact {
  /** Declaration identity; unchanged when the case is inherited elsewhere. */
  id: string;
  name: string;
  file?: string;
  span: A.Span;
  declaringProtocolId: string;
  declaringProtocolName: string;
  fields: ProtocolFieldFact[];
  inherited: boolean;
  inheritanceDepth: number;
  /** First direct parent followed from the viewed protocol, when inherited. */
  inheritedVia?: string;
  /** The declaration selected by the LSP's own-first, parent-order lookup. */
  effective: boolean;
}

export type ProtocolCollisionKind = 'own-and-inherited' | 'multiple-inheritance' | 'inherited-shadowing';

export interface ProtocolCollisionFact {
  id: string;
  protocolId: string;
  protocolName: string;
  file?: string;
  caseName: string;
  kind: ProtocolCollisionKind;
  /** Whether this declaration creates the conflict rather than merely inheriting it. */
  introduced: boolean;
  span: A.Span;
  /** Distinct declarations competing for this tag. */
  origins: ProtocolCaseFact[];
  /** What an own-first, left-to-right lookup selects. */
  effectiveCaseId: string;
}

export interface ProtocolStructureFact {
  id: string;
  name: string;
  file?: string;
  span: A.Span;
  nameSpan: A.Span;
  /** True only when this exact declaration belongs to the analyzed program. */
  local: boolean;
  /** A declaration ending in `;`, whose complete case set may live elsewhere. */
  forward: boolean;
  parents: ProtocolParentFact[];
  /** Cases declared by this protocol. Inherited cases are represented by parent links. */
  cases: ProtocolCaseFact[];
  /** False for a forward declaration, unresolved parent or inheritance cycle. */
  caseSetComplete: boolean;
  /** Collisions introduced at this declaration; inherited conflicts are not copied. */
  collisions: ProtocolCollisionFact[];
}

export interface ProtocolSwitchLabelFact {
  id: string;
  kind: 'case' | 'default';
  span: A.Span;
  groupIndex: number;
  labelIndex: number;
  name?: string;
  caseId?: string;
  valid: boolean;
  duplicate: boolean;
}

export type ProtocolCoverage = 'exhaustive' | 'non-exhaustive' | 'unknown';

export interface ProtocolSwitchFact {
  id: string;
  file?: string;
  span: A.Span;
  expressionSpan: A.Span;
  protocolId: string;
  protocolName: string;
  procedureId?: string;
  procedureName?: string;
  labels: ProtocolSwitchLabelFact[];
  handledCaseIds: string[];
  /** Known cases not named explicitly, even when a default handles them. */
  missingCases: ProtocolCaseFact[];
  defaultLabels: ProtocolSwitchLabelFact[];
  duplicateDefaults: ProtocolSwitchLabelFact[];
  coverage: ProtocolCoverage;
  /** Undefined means the visible case universe is incomplete. */
  exhaustive: boolean | undefined;
  /** Safe insertion position for generated `case` clauses. */
  insertAt?: A.Pos;
}

export type ProtocolFlowKind = 'construct' | 'send' | 'receive' | 'match' | 'test';

/** The value/channel expression involved in a flow site. */
export interface ProtocolValueFact {
  expressionId: string;
  span: A.Span;
  variableId?: string;
  variableName?: string;
}

export interface ProtocolFlowFact {
  id: string;
  kind: ProtocolFlowKind;
  file?: string;
  span: A.Span;
  protocolId: string;
  protocolName: string;
  caseId?: string;
  caseName?: string;
  procedureId?: string;
  procedureName?: string;
  /** Declaration location for editor navigation; flow.span remains the observed operation. */
  procedureFile?: string;
  procedureSpan?: A.Span;
  /** Channel endpoint for send/receive; matched/tested value for match/test. */
  subject?: ProtocolValueFact;
}

interface ProtocolIssueBase {
  id: string;
  file?: string;
  span: A.Span;
  severity: ProtocolIssueSeverity;
  code: string;
  message: string;
}

export interface MissingProtocolCasesIssue extends ProtocolIssueBase {
  kind: 'missing-cases';
  code: 'pj/protocol/missing-cases';
  switchId: string;
  protocolId: string;
  missingCases: ProtocolCaseFact[];
  insertAt: A.Pos;
  /** Start of the `switch` keyword, so a generated body can match its indentation. */
  switchStart: A.Pos;
}

export interface DuplicateProtocolDefaultIssue extends ProtocolIssueBase {
  kind: 'duplicate-default';
  code: 'pj/protocol/duplicate-default';
  switchId: string;
  firstDefaultId: string;
}

export interface InheritedProtocolCollisionIssue extends ProtocolIssueBase {
  kind: 'inherited-case-collision';
  code: 'pj/protocol/inherited-case-collision';
  collisionId: string;
  protocolId: string;
  caseName: string;
  origins: ProtocolCaseFact[];
}

export type ProtocolIssue = MissingProtocolCasesIssue | DuplicateProtocolDefaultIssue | InheritedProtocolCollisionIssue;

export interface ProtocolAnalysis {
  protocols: ProtocolStructureFact[];
  switches: ProtocolSwitchFact[];
  flows: ProtocolFlowFact[];
  collisions: ProtocolCollisionFact[];
  issues: ProtocolIssue[];
}

/**
 * A deterministic identity for a source-backed fact.  Callers may persist these
 * across requests for an unchanged document; no process-local counters occur in
 * the value.
 */
export function protocolFactId(file: string | undefined, kind: string, span: A.Span, discriminator?: string): string {
  const source = encodeURIComponent(file ?? '<memory>');
  const where = `${span.start.line}:${span.start.col}-${span.end.line}:${span.end.col}`;
  const suffix = discriminator === undefined ? '' : `:${encodeURIComponent(discriminator)}`;
  return `protocol:${source}:${kind}:${where}${suffix}`;
}

/** Analyze visible protocol declarations and protocol use sites in one program. */
export function analyzeProtocols(
  program: A.Program,
  index: DeclIndex,
  checked?: ProtocolSemanticInfo,
  options: ProtocolAnalysisOptions = {},
): ProtocolAnalysis {
  const currentFile = options.file ?? inferCurrentFile(program, index);
  const localDecls = new Set(program.decls.filter((d): d is A.ProtocolDecl => d.kind === 'ProtocolDecl'));
  const completeness = computeCaseSetCompleteness(index);
  const protocols = [...index.protocols.values()]
    .map((info) => buildStructure(info, index, localDecls.has(info.decl), completeness.get(info.name) ?? false))
    .sort(compareProtocols);
  const structuresByName = new Map(protocols.map((protocol) => [protocol.name, protocol]));
  const resolver = new ProtocolCaseResolver(protocols);
  attachIntroducedCollisions(protocols, resolver);
  const collisions = protocols.flatMap((protocol) => protocol.collisions);
  const issues: ProtocolIssue[] = [];

  for (const protocol of protocols) {
    // Keep structural facts for broken hierarchies, but do not cascade a
    // collision warning from an unresolved/cyclic inheritance error that the
    // type checker already reports more directly.
    if (!protocol.local || !protocol.caseSetComplete) continue;
    for (const collision of protocol.collisions) {
      if (!collision.introduced) continue;
      const owners = collision.origins.map((origin) => `'${origin.declaringProtocolName}'`).join(', ');
      issues.push({
        id: protocolFactId(collision.file, 'issue-inherited-collision', collision.span, collision.id),
        kind: 'inherited-case-collision',
        code: 'pj/protocol/inherited-case-collision',
        severity: 'warning',
        file: collision.file,
        span: collision.span,
        message: `Case '${collision.caseName}' in protocol '${collision.protocolName}' has competing declarations from ${owners}; rename or consolidate the case so lookup is unambiguous`,
        collisionId: collision.id,
        protocolId: collision.protocolId,
        caseName: collision.caseName,
        origins: collision.origins,
      });
    }
  }

  const switches: ProtocolSwitchFact[] = [];
  const flows: ProtocolFlowFact[] = [];
  const locatorTokens = options.tokens ?? (options.sourceText === undefined ? undefined : tokenize(options.sourceText).tokens);
  const locator = locatorTokens === undefined ? undefined : new SourceLocator(locatorTokens);

  for (const declaration of program.decls) {
    if (declaration.kind === 'ProcDecl' && declaration.body) {
      const procedure: ProcedureContext = {
        id: protocolFactId(currentFile, 'procedure', declaration.name.span, declaration.name.name),
        name: declaration.name.name,
        file: currentFile,
        span: declaration.name.span,
      };
      visitAst(declaration.body, (node) => collectNode(node, procedure));
    } else if (declaration.kind === 'ConstDecl') {
      for (const declarator of declaration.declarators) {
        if (declarator.init) visitAst(declarator.init, (node) => collectNode(node, undefined));
      }
    }
  }

  function collectNode(node: AstNode, procedure: ProcedureContext | undefined): void {
    switch (node.kind) {
      case 'SwitchStmt': {
        const statement = node as unknown as A.SwitchStmt;
        const protocolName = protocolNameOfExpression(statement.expr, checked);
        const structure = protocolName === undefined ? undefined : structuresByName.get(protocolName);
        if (!structure) break;
        const fact = analyzeSwitch(statement, structure, resolver.effectiveCases(structure), currentFile, procedure, locator);
        switches.push(fact);
        addSwitchIssues(fact, issues);
        for (const label of fact.labels) {
          if (label.kind !== 'case' || !label.valid || !label.caseId || !label.name) continue;
          flows.push({
            id: protocolFactId(currentFile, 'flow-match', label.span, `${fact.id}:${label.id}`),
            kind: 'match',
            file: currentFile,
            span: label.span,
            protocolId: structure.id,
            protocolName: structure.name,
            caseId: label.caseId,
            caseName: label.name,
            procedureId: procedure?.id,
            procedureName: procedure?.name,
            procedureFile: procedure?.file,
            procedureSpan: procedure?.span,
            subject: valueFact(statement.expr, currentFile, checked),
          });
        }
        break;
      }
      case 'ProtocolLiteral': {
        const literal = node as unknown as A.ProtocolLiteral;
        const protocolName = protocolNameOfLiteral(literal, index, checked);
        const structure = protocolName === undefined ? undefined : structuresByName.get(protocolName);
        if (!structure) break;
        const protocolCase = resolver.effectiveCase(structure, literal.tag.name);
        flows.push({
          id: protocolFactId(currentFile, 'flow-construct', literal.span, literal.tag.name),
          kind: 'construct',
          file: currentFile,
          span: literal.span,
          protocolId: structure.id,
          protocolName: structure.name,
          caseId: protocolCase?.id,
          caseName: literal.tag.name,
          procedureId: procedure?.id,
          procedureName: procedure?.name,
          procedureFile: procedure?.file,
          procedureSpan: procedure?.span,
          subject: valueFact(literal, currentFile, checked),
        });
        break;
      }
      case 'ChanWrite': {
        const write = node as unknown as A.ChanWrite;
        const protocolName = protocolNameOfChannel(write.target, checked);
        const structure = protocolName === undefined ? undefined : structuresByName.get(protocolName);
        if (!structure) break;
        const literal = unwrapProtocolLiteral(write.value);
        const caseName = literal?.tag.name;
        const protocolCase = caseName === undefined ? undefined : resolver.effectiveCase(structure, caseName);
        flows.push({
          id: protocolFactId(currentFile, 'flow-send', write.span, structure.id),
          kind: 'send',
          file: currentFile,
          span: write.span,
          protocolId: structure.id,
          protocolName: structure.name,
          caseId: protocolCase?.id,
          caseName,
          procedureId: procedure?.id,
          procedureName: procedure?.name,
          procedureFile: procedure?.file,
          procedureSpan: procedure?.span,
          subject: valueFact(write.target, currentFile, checked),
        });
        break;
      }
      case 'ChanRead': {
        const read = node as unknown as A.ChanRead;
        const protocolName = protocolNameOfChannel(read.target, checked);
        const structure = protocolName === undefined ? undefined : structuresByName.get(protocolName);
        if (!structure) break;
        flows.push({
          id: protocolFactId(currentFile, 'flow-receive', read.span, structure.id),
          kind: 'receive',
          file: currentFile,
          span: read.span,
          protocolId: structure.id,
          protocolName: structure.name,
          procedureId: procedure?.id,
          procedureName: procedure?.name,
          procedureFile: procedure?.file,
          procedureSpan: procedure?.span,
          subject: valueFact(read.target, currentFile, checked),
        });
        break;
      }
      case 'IsExpr': {
        const test = node as unknown as A.IsExpr;
        const protocolName = protocolNameOfExpression(test.expr, checked);
        const structure = protocolName === undefined ? undefined : structuresByName.get(protocolName);
        if (!structure) break;
        const protocolCase = resolver.effectiveCase(structure, test.typeName.name);
        flows.push({
          id: protocolFactId(currentFile, 'flow-test', test.span, test.typeName.name),
          kind: 'test',
          file: currentFile,
          span: test.span,
          protocolId: structure.id,
          protocolName: structure.name,
          caseId: protocolCase?.id,
          caseName: test.typeName.name,
          procedureId: procedure?.id,
          procedureName: procedure?.name,
          procedureFile: procedure?.file,
          procedureSpan: procedure?.span,
          subject: valueFact(test.expr, currentFile, checked),
        });
        break;
      }
      default:
        break;
    }
  }

  switches.sort((a, b) => compareSpans(a.span, b.span) || a.id.localeCompare(b.id));
  flows.sort((a, b) => compareSpans(a.span, b.span) || flowRank(a.kind) - flowRank(b.kind) || a.id.localeCompare(b.id));
  issues.sort((a, b) => compareOptionalFiles(a.file, b.file) || compareSpans(a.span, b.span) || a.id.localeCompare(b.id));

  return { protocols, switches, flows, collisions, issues };
}

function buildStructure(info: ProtocolInfo, index: DeclIndex, local: boolean, caseSetComplete: boolean): ProtocolStructureFact {
  const protocolId = protocolFactId(info.file, 'protocol', info.decl.name.span, info.name);
  const cases: ProtocolCaseFact[] = [];
  const selectedNames = new Set<string>();
  for (const protocolCase of info.decl.cases ?? []) {
    const id = protocolFactId(info.file, 'protocol-case', protocolCase.name.span, `${protocolId}:${protocolCase.name.name}`);
    const effective = !selectedNames.has(protocolCase.name.name);
    selectedNames.add(protocolCase.name.name);
    cases.push({
      id,
      name: protocolCase.name.name,
      file: info.file,
      span: protocolCase.name.span,
      declaringProtocolId: protocolId,
      declaringProtocolName: info.name,
      fields: protocolCase.members.map((field) => {
        const type = index.resolve(field.type);
        return {
          id: protocolFactId(info.file, 'protocol-field', field.name.span, `${id}:${field.name.name}`),
          name: field.name.name,
          file: info.file,
          span: field.name.span,
          type,
          typeLabel: typeStr(type),
        };
      }),
      inherited: false,
      inheritanceDepth: 0,
      effective,
    });
  }

  const parents = info.extends.map((name, i): ProtocolParentFact => {
    const target = index.protocols.get(name);
    const span = info.decl.extends[i]?.span ?? info.decl.name.span;
    return {
      id: protocolFactId(info.file, 'protocol-parent', span, `${protocolId}:${name}:${i}`),
      name,
      span,
      targetId: target ? protocolFactId(target.file, 'protocol', target.decl.name.span, target.name) : undefined,
      resolved: target !== undefined,
    };
  });

  return {
    id: protocolId,
    name: info.name,
    file: info.file,
    span: info.decl.span,
    nameSpan: info.decl.name.span,
    local,
    forward: info.decl.cases === undefined,
    parents,
    cases,
    caseSetComplete,
    collisions: [],
  };
}

/**
 * Resolve a protocol's effective cases only when a consumer needs that view.
 * The persisted/wire model stays declaration-linear; this helper materializes
 * at most one lightweight object per effective case for the selected protocol.
 */
export function effectiveProtocolCases(
  protocols: readonly ProtocolStructureFact[],
  protocol: ProtocolStructureFact | string,
): ProtocolCaseFact[] {
  const resolver = new ProtocolCaseResolver(protocols);
  const selected = typeof protocol === 'string'
    ? protocols.find((candidate) => candidate.id === protocol || candidate.name === protocol)
    : protocol;
  return selected ? resolver.effectiveCases(selected) : [];
}

/** Completeness is a graph property, so compute it once instead of walking every ancestry. */
function computeCaseSetCompleteness(index: DeclIndex): Map<string, boolean> {
  const remainingParents = new Map<string, number>();
  const children = new Map<string, string[]>();
  const hasUnresolvedParent = new Set<string>();
  const complete = new Map<string, boolean>();

  for (const info of index.protocols.values()) {
    let knownParents = 0;
    for (const parent of info.extends) {
      if (!index.protocols.has(parent)) {
        hasUnresolvedParent.add(info.name);
        continue;
      }
      knownParents++;
      const dependants = children.get(parent);
      if (dependants) dependants.push(info.name);
      else children.set(parent, [info.name]);
    }
    remainingParents.set(info.name, knownParents);
  }

  const ready = [...remainingParents].filter(([, count]) => count === 0).map(([name]) => name);
  for (let cursor = 0; cursor < ready.length; cursor++) {
    const name = ready[cursor];
    const info = index.protocols.get(name)!;
    const parentsComplete = info.extends.every((parent) => complete.get(parent) === true);
    complete.set(name, info.decl.cases !== undefined && !hasUnresolvedParent.has(name) && parentsComplete);
    for (const child of children.get(name) ?? []) {
      const left = (remainingParents.get(child) ?? 1) - 1;
      remainingParents.set(child, left);
      if (left === 0) ready.push(child);
    }
  }

  // Nodes not reached by the dependency order participate in, or depend on,
  // an inheritance cycle.  Their visible universe is necessarily incomplete.
  for (const name of index.protocols.keys()) if (!complete.has(name)) complete.set(name, false);
  return complete;
}

interface CaseTraversalFrame {
  protocol: ProtocolStructureFact;
  depth: number;
  via?: string;
}

/** Own-first, left-to-right case lookup over the compact parent graph. */
class ProtocolCaseResolver {
  private readonly byName: Map<string, ProtocolStructureFact>;
  private readonly byId: Map<string, ProtocolStructureFact>;
  private readonly directCases = new Map<string, Map<string, ProtocolCaseFact>>();
  private readonly effectiveLists = new Map<string, ProtocolCaseFact[]>();
  private readonly effectiveLookups = new Map<string, Map<string, ProtocolCaseFact>>();
  private readonly pointLookups = new Map<string, ProtocolCaseFact | null>();

  constructor(protocols: readonly ProtocolStructureFact[]) {
    this.byName = new Map(protocols.map((protocol) => [protocol.name, protocol]));
    this.byId = new Map(protocols.map((protocol) => [protocol.id, protocol]));
    for (const protocol of protocols) {
      const cases = new Map<string, ProtocolCaseFact>();
      for (const protocolCase of protocol.cases) {
        if (protocolCase.effective && !cases.has(protocolCase.name)) cases.set(protocolCase.name, protocolCase);
      }
      this.directCases.set(protocol.id, cases);
    }
  }

  protocolForParent(parent: ProtocolParentFact): ProtocolStructureFact | undefined {
    return (parent.targetId ? this.byId.get(parent.targetId) : undefined) ?? this.byName.get(parent.name);
  }

  directCase(protocol: ProtocolStructureFact, caseName: string): ProtocolCaseFact | undefined {
    return this.directCases.get(protocol.id)?.get(caseName);
  }

  effectiveCases(protocol: ProtocolStructureFact): ProtocolCaseFact[] {
    const cached = this.effectiveLists.get(protocol.id);
    if (cached) return cached;
    const cases: ProtocolCaseFact[] = [];
    const byName = new Map<string, ProtocolCaseFact>();
    const seenProtocols = new Set<string>();
    const pending: CaseTraversalFrame[] = [{ protocol, depth: 0 }];
    while (pending.length > 0) {
      const frame = pending.pop()!;
      if (seenProtocols.has(frame.protocol.id)) continue;
      seenProtocols.add(frame.protocol.id);
      for (const protocolCase of this.directCases.get(frame.protocol.id)?.values() ?? []) {
        if (byName.has(protocolCase.name)) continue;
        const viewed = inheritedView(protocolCase, frame.depth, frame.via);
        byName.set(viewed.name, viewed);
        cases.push(viewed);
      }
      for (let i = frame.protocol.parents.length - 1; i >= 0; i--) {
        const parentFact = frame.protocol.parents[i];
        const parent = this.protocolForParent(parentFact);
        if (!parent) continue;
        pending.push({
          protocol: parent,
          depth: frame.depth + 1,
          via: frame.via ?? parent.name,
        });
      }
    }
    this.effectiveLists.set(protocol.id, cases);
    this.effectiveLookups.set(protocol.id, byName);
    return cases;
  }

  effectiveCase(protocol: ProtocolStructureFact, caseName: string): ProtocolCaseFact | undefined {
    const listed = this.effectiveLookups.get(protocol.id)?.get(caseName);
    if (listed) return listed;
    const key = `${protocol.id}\0${caseName}`;
    const cached = this.pointLookups.get(key);
    if (cached !== undefined) return cached ?? undefined;

    const seenProtocols = new Set<string>();
    const pending: CaseTraversalFrame[] = [{ protocol, depth: 0 }];
    while (pending.length > 0) {
      const frame = pending.pop()!;
      if (seenProtocols.has(frame.protocol.id)) continue;
      seenProtocols.add(frame.protocol.id);
      const direct = this.directCase(frame.protocol, caseName);
      if (direct) {
        const viewed = inheritedView(direct, frame.depth, frame.via);
        this.pointLookups.set(key, viewed);
        return viewed;
      }
      for (let i = frame.protocol.parents.length - 1; i >= 0; i--) {
        const parentFact = frame.protocol.parents[i];
        const parent = this.protocolForParent(parentFact);
        if (!parent) continue;
        pending.push({ protocol: parent, depth: frame.depth + 1, via: frame.via ?? parent.name });
      }
    }
    this.pointLookups.set(key, null);
    return undefined;
  }
}

function inheritedView(protocolCase: ProtocolCaseFact, depth: number, via: string | undefined): ProtocolCaseFact {
  if (depth === 0) return protocolCase;
  return { ...protocolCase, inherited: true, inheritanceDepth: depth, inheritedVia: via, effective: true };
}

/**
 * Attach only conflicts created at a declaration.  Repeating a parent's full
 * collision list in every descendant was another quadratic hierarchy cost and
 * added no new diagnostic location.
 */
function attachIntroducedCollisions(protocols: ProtocolStructureFact[], resolver: ProtocolCaseResolver): void {
  const declarationsByCase = new Map<string, ProtocolCaseFact[]>();
  const protocolById = new Map(protocols.map((protocol) => [protocol.id, protocol]));
  const children = new Map<string, string[]>();
  const remainingParents = new Map<string, number>();

  for (const protocol of protocols) {
    protocol.collisions = [];
    for (const protocolCase of protocol.cases) {
      if (!protocolCase.effective) continue;
      const declarations = declarationsByCase.get(protocolCase.name);
      if (declarations) declarations.push(protocolCase);
      else declarationsByCase.set(protocolCase.name, [protocolCase]);
    }
    let knownParents = 0;
    for (const parentFact of protocol.parents) {
      const parent = resolver.protocolForParent(parentFact);
      if (!parent) continue;
      knownParents++;
      const descendants = children.get(parent.id);
      if (descendants) descendants.push(protocol.id);
      else children.set(parent.id, [protocol.id]);
    }
    remainingParents.set(protocol.id, knownParents);
  }

  // Parents must be processed before children while a duplicated tag flows
  // through the graph. Nodes without a rank participate in, or depend on, an
  // invalid inheritance cycle and use the cycle-safe point resolver below.
  const topologicalRank = new Map<string, number>();
  const ready = protocols.filter((protocol) => remainingParents.get(protocol.id) === 0).map((protocol) => protocol.id);
  for (let cursor = 0; cursor < ready.length; cursor++) {
    const protocolId = ready[cursor];
    topologicalRank.set(protocolId, cursor);
    for (const childId of children.get(protocolId) ?? []) {
      const left = (remainingParents.get(childId) ?? 1) - 1;
      remainingParents.set(childId, left);
      if (left === 0) ready.push(childId);
    }
  }

  for (const [caseName, declarations] of declarationsByCase) {
    // One declaring protocol can arrive through many diamond paths without
    // ambiguity. Only globally multiply-declared tags need collision proof.
    const declaringProtocolIds = new Set(declarations.map((declaration) => declaration.declaringProtocolId));
    if (declaringProtocolIds.size < 2) continue;

    // The child index bounds work to families that can actually inherit this
    // tag. No full ProtocolCaseFact list is built for any parent.
    const affected = descendantClosure(declaringProtocolIds, children);
    const acyclic = [...affected]
      .filter((protocolId) => topologicalRank.has(protocolId))
      .sort((a, b) => topologicalRank.get(a)! - topologicalRank.get(b)!);
    const selectedOrigins = new Map<string, IndexedCaseOrigin>();

    for (const protocolId of acyclic) {
      const protocol = protocolById.get(protocolId)!;
      const own = resolver.directCase(protocol, caseName);
      const parentOrigins = indexedParentOrigins(protocol, resolver, selectedOrigins);
      const selected = own === undefined ? parentOrigins[0] : { declaration: own, depth: 0 };
      if (selected) selectedOrigins.set(protocol.id, selected);
      attachCollision(protocol, caseName, own, parentOrigins);
    }

    for (const protocolId of affected) {
      if (topologicalRank.has(protocolId)) continue;
      const protocol = protocolById.get(protocolId)!;
      const own = resolver.directCase(protocol, caseName);
      attachCollision(protocol, caseName, own, resolvedParentOrigins(protocol, caseName, resolver));
    }
  }

  for (const protocol of protocols) {
    protocol.collisions.sort((a, b) => a.caseName.localeCompare(b.caseName) || a.id.localeCompare(b.id));
  }
}

interface IndexedCaseOrigin {
  declaration: ProtocolCaseFact;
  depth: number;
  via?: string;
}

function descendantClosure(seeds: ReadonlySet<string>, children: ReadonlyMap<string, readonly string[]>): Set<string> {
  const affected = new Set(seeds);
  const pending = [...seeds];
  for (let cursor = 0; cursor < pending.length; cursor++) {
    for (const child of children.get(pending[cursor]) ?? []) {
      if (affected.has(child)) continue;
      affected.add(child);
      pending.push(child);
    }
  }
  return affected;
}

function indexedParentOrigins(
  protocol: ProtocolStructureFact,
  resolver: ProtocolCaseResolver,
  selectedOrigins: ReadonlyMap<string, IndexedCaseOrigin>,
): IndexedCaseOrigin[] {
  const origins: IndexedCaseOrigin[] = [];
  const seenDeclarations = new Set<string>();
  for (const parentFact of protocol.parents) {
    const parent = resolver.protocolForParent(parentFact);
    if (!parent) continue;
    const inherited = selectedOrigins.get(parent.id);
    if (!inherited || seenDeclarations.has(inherited.declaration.declaringProtocolId)) continue;
    seenDeclarations.add(inherited.declaration.declaringProtocolId);
    origins.push({ declaration: inherited.declaration, depth: inherited.depth + 1, via: parent.name });
  }
  return origins;
}

function resolvedParentOrigins(
  protocol: ProtocolStructureFact,
  caseName: string,
  resolver: ProtocolCaseResolver,
): IndexedCaseOrigin[] {
  const origins: IndexedCaseOrigin[] = [];
  const seenDeclarations = new Set<string>();
  for (const parentFact of protocol.parents) {
    const parent = resolver.protocolForParent(parentFact);
    if (!parent) continue;
    const inherited = resolver.effectiveCase(parent, caseName);
    if (!inherited || seenDeclarations.has(inherited.declaringProtocolId)) continue;
    seenDeclarations.add(inherited.declaringProtocolId);
    origins.push({ declaration: inherited, depth: inherited.inheritanceDepth + 1, via: parent.name });
  }
  return origins;
}

function attachCollision(
  protocol: ProtocolStructureFact,
  caseName: string,
  own: ProtocolCaseFact | undefined,
  parentOrigins: readonly IndexedCaseOrigin[],
): void {
  if (own ? parentOrigins.length === 0 : parentOrigins.length < 2) return;
  const selectedId = own?.id ?? parentOrigins[0].declaration.id;
  const origins = [
    ...(own ? [{ declaration: own, depth: 0 } satisfies IndexedCaseOrigin] : []),
    ...parentOrigins,
  ].map((origin) => {
    const inherited = origin.depth > 0;
    const effective = origin.declaration.id === selectedId;
    return {
      ...origin.declaration,
      inherited,
      inheritanceDepth: origin.depth,
      inheritedVia: inherited ? origin.via : undefined,
      effective,
    };
  });
  const span = own?.span ?? protocol.nameSpan;
  protocol.collisions.push({
    id: protocolFactId(protocol.file, 'protocol-collision', span, `${protocol.id}:${caseName}`),
    protocolId: protocol.id,
    protocolName: protocol.name,
    file: protocol.file,
    caseName,
    kind: own ? 'own-and-inherited' : 'multiple-inheritance',
    introduced: true,
    span,
    origins,
    effectiveCaseId: selectedId,
  });
}

function analyzeSwitch(
  statement: A.SwitchStmt,
  protocol: ProtocolStructureFact,
  effectiveCases: readonly ProtocolCaseFact[],
  file: string | undefined,
  procedure: ProcedureContext | undefined,
  locator: SourceLocator | undefined,
): ProtocolSwitchFact {
  const id = protocolFactId(file, 'protocol-switch', statement.span, protocol.id);
  const labels: ProtocolSwitchLabelFact[] = [];
  const casesByName = new Map(effectiveCases.map((protocolCase) => [protocolCase.name, protocolCase]));
  const seenCases = new Set<string>();
  let defaultCount = 0;

  statement.groups.forEach((group, groupIndex) => {
    const defaultSpans = locator?.defaultLabelSpans(group) ?? [];
    let defaultInGroup = 0;
    group.labels.forEach((label, labelIndex) => {
      if (label === undefined) {
        const span = defaultSpans[defaultInGroup++] ?? fallbackDefaultSpan(group, labelIndex);
        const duplicate = defaultCount++ > 0;
        labels.push({
          id: protocolFactId(file, 'protocol-default', span, `${id}:${groupIndex}:${labelIndex}`),
          kind: 'default',
          span,
          groupIndex,
          labelIndex,
          valid: true,
          duplicate,
        });
        return;
      }
      const name = label.kind === 'NameExpr' && !label.qualifier?.length ? label.name.name : undefined;
      const protocolCase = name === undefined ? undefined : casesByName.get(name);
      const duplicate = name !== undefined && seenCases.has(name);
      if (name !== undefined) seenCases.add(name);
      labels.push({
        id: protocolFactId(file, 'protocol-switch-case', label.span, `${id}:${groupIndex}:${labelIndex}`),
        kind: 'case',
        span: label.span,
        groupIndex,
        labelIndex,
        name,
        caseId: protocolCase?.id,
        valid: protocolCase !== undefined,
        duplicate,
      });
    });
  });

  const handledCaseIds = distinctBy(
    labels.filter((label): label is ProtocolSwitchLabelFact & { caseId: string } => label.kind === 'case' && label.valid && label.caseId !== undefined),
    (label) => label.caseId,
  ).map((label) => label.caseId);
  const handled = new Set(handledCaseIds);
  const missingCases = effectiveCases.filter((protocolCase) => !handled.has(protocolCase.id));
  const defaultLabels = labels.filter((label) => label.kind === 'default');
  const duplicateDefaults = defaultLabels.filter((label) => label.duplicate);
  const coverage: ProtocolCoverage = defaultLabels.length > 0
    ? 'exhaustive'
    : !protocol.caseSetComplete
      ? 'unknown'
      : missingCases.length === 0
        ? 'exhaustive'
        : 'non-exhaustive';

  return {
    id,
    file,
    span: statement.span,
    expressionSpan: statement.expr.span,
    protocolId: protocol.id,
    protocolName: protocol.name,
    procedureId: procedure?.id,
    procedureName: procedure?.name,
    labels,
    handledCaseIds,
    missingCases,
    defaultLabels,
    duplicateDefaults,
    coverage,
    exhaustive: coverage === 'unknown' ? undefined : coverage === 'exhaustive',
    insertAt: locator ? locator.closingBrace(statement.span) : beforeSpanEnd(statement.span),
  };
}

function addSwitchIssues(fact: ProtocolSwitchFact, issues: ProtocolIssue[]): void {
  // An invalid case already has a precise checker error (usually with a typo
  // suggestion). A simultaneous exhaustiveness warning would repeat the same
  // root cause and offer a misleading bulk insertion.
  const hasInvalidCase = fact.labels.some((label) => label.kind === 'case' && !label.valid);
  if (fact.coverage === 'non-exhaustive' && !hasInvalidCase && fact.insertAt) {
    const names = fact.missingCases.map((protocolCase) => `'${protocolCase.name}'`).join(', ');
    issues.push({
      id: protocolFactId(fact.file, 'issue-missing-cases', fact.expressionSpan, fact.id),
      kind: 'missing-cases',
      code: 'pj/protocol/missing-cases',
      severity: 'warning',
      file: fact.file,
      span: fact.expressionSpan,
      message: `Switch on protocol '${fact.protocolName}' does not handle ${names}`,
      switchId: fact.id,
      protocolId: fact.protocolId,
      missingCases: fact.missingCases,
      insertAt: fact.insertAt,
      switchStart: fact.span.start,
    });
  }
  const firstDefault = fact.defaultLabels[0];
  if (!firstDefault) return;
  for (const duplicate of fact.duplicateDefaults) {
    issues.push({
      id: protocolFactId(fact.file, 'issue-duplicate-default', duplicate.span, duplicate.id),
      kind: 'duplicate-default',
      code: 'pj/protocol/duplicate-default',
      severity: 'error',
      file: fact.file,
      span: duplicate.span,
      message: `Protocol switch has more than one default label; the first is already exhaustive`,
      switchId: fact.id,
      firstDefaultId: firstDefault.id,
    });
  }
}

function protocolNameOfExpression(expr: A.Expr, checked: ProtocolSemanticInfo | undefined): string | undefined {
  const direct = checked?.types.get(expr);
  if (direct?.k === 'protocol') return direct.name;
  if (expr.kind === 'NameExpr') {
    const resolved = checked?.resolutions.get(expr)?.type;
    if (resolved?.k === 'protocol') return resolved.name;
  }
  return undefined;
}

function protocolNameOfLiteral(literal: A.ProtocolLiteral, index: DeclIndex, checked: ProtocolSemanticInfo | undefined): string | undefined {
  const type = checked?.types.get(literal);
  if (type?.k === 'protocol') return type.name;
  if (!literal.typeName.qualifier?.length && index.protocols.has(literal.typeName.name)) return literal.typeName.name;
  return undefined;
}

function protocolNameOfChannel(target: A.Expr, checked: ProtocolSemanticInfo | undefined): string | undefined {
  const type = checked?.types.get(target);
  return type?.k === 'chan' && type.elem.k === 'protocol' ? type.elem.name : undefined;
}

function unwrapProtocolLiteral(expr: A.Expr): A.ProtocolLiteral | undefined {
  let current = expr;
  while (current.kind === 'ParenExpr' || current.kind === 'CastExpr') current = current.expr;
  return current.kind === 'ProtocolLiteral' ? current : undefined;
}

function valueFact(expr: A.Expr, file: string | undefined, checked: ProtocolSemanticInfo | undefined): ProtocolValueFact {
  let named: A.Expr = expr;
  for (;;) {
    if (named.kind === 'ParenExpr' || named.kind === 'CastExpr') named = named.expr;
    else if (named.kind === 'ChanEnd') named = named.target;
    else break;
  }
  const variable = named.kind === 'NameExpr' ? checked?.resolutions.get(named) : undefined;
  return {
    expressionId: protocolFactId(file, 'expression', expr.span),
    span: expr.span,
    variableId: variable === undefined ? undefined : variableFactId(variable, file),
    variableName: variable?.name,
  };
}

function variableFactId(variable: VarInfo, file: string | undefined): string {
  return protocolFactId(file, variable.isParam ? 'parameter' : 'variable', variable.decl.span, `${variable.proc}:${variable.name}`);
}

interface ProcedureContext {
  id: string;
  name: string;
  file?: string;
  span: A.Span;
}

interface AstNode {
  kind: string;
  [key: string]: unknown;
}

/** Generic tree walk kept private so new AST forms are automatically observed. */
function visitAst(root: unknown, visit: (node: AstNode) => void): void {
  const seen = new WeakSet<object>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value === null || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    const object = value as Record<string, unknown>;
    if (typeof object.kind === 'string') visit(object as AstNode);
    for (const [key, child] of Object.entries(object)) {
      if (key !== 'span') walk(child);
    }
  };
  walk(root);
}

class SourceLocator {
  constructor(private readonly tokens: readonly Token[]) {}

  defaultLabelSpans(group: A.SwitchGroup): A.Span[] {
    const end = group.stmts[0]?.span.start ?? group.span.end;
    const out: A.Span[] = [];
    for (let i = this.lowerBound(group.span.start); i < this.tokens.length; i++) {
      const token = this.tokens[i];
      if (!before(tokenStart(token), end)) break;
      if (token.text === 'default') out.push(tokenSpan(token));
    }
    return out;
  }

  closingBrace(span: A.Span): A.Pos | undefined {
    const end = this.lowerBound(span.end);
    let opening = -1;
    for (let i = this.lowerBound(span.start); i < end; i++) {
      if (this.tokens[i].text === '{') {
        opening = i;
        break;
      }
    }
    if (opening < 0) return undefined;
    let depth = 0;
    for (let i = opening; i < end; i++) {
      const token = this.tokens[i];
      if (token.text === '{') depth++;
      else if (token.text === '}' && --depth === 0) return tokenStart(token);
    }
    // An unmatched or recovery-truncated switch has no safe insertion point.
    return undefined;
  }

  private lowerBound(position: A.Pos): number {
    let low = 0;
    let high = this.tokens.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (before(tokenStart(this.tokens[mid]), position)) low = mid + 1;
      else high = mid;
    }
    return low;
  }
}

function tokenStart(token: Token): A.Pos {
  return { line: token.line, col: token.col };
}

function tokenEnd(token: Token): A.Pos {
  return { line: token.line, col: token.end };
}

function tokenSpan(token: Token): A.Span {
  return { start: tokenStart(token), end: tokenEnd(token) };
}

function before(a: A.Pos, b: A.Pos): boolean {
  return a.line < b.line || (a.line === b.line && a.col < b.col);
}

function fallbackDefaultSpan(group: A.SwitchGroup, labelIndex: number): A.Span {
  if (labelIndex === 0) {
    return {
      start: group.span.start,
      end: { line: group.span.start.line, col: group.span.start.col + 'default'.length },
    };
  }
  return group.span;
}

function beforeSpanEnd(span: A.Span): A.Pos {
  if (span.end.col > 0) return { line: span.end.line, col: span.end.col - 1 };
  return span.end;
}

function inferCurrentFile(program: A.Program, index: DeclIndex): string | undefined {
  const declarations = new Set<A.Decl>(program.decls);
  for (const info of index.protocols.values()) if (declarations.has(info.decl)) return info.file;
  for (const signatures of index.procs.values()) {
    for (const signature of signatures) if (declarations.has(signature.decl)) return signature.file;
  }
  for (const info of index.records.values()) if (declarations.has(info.decl)) return info.file;
  for (const info of index.consts.values()) if (declarations.has(info.decl)) return info.file;
  return undefined;
}

function distinctBy<T, K>(values: readonly T[], key: (value: T) => K): T[] {
  const seen = new Set<K>();
  const out: T[] = [];
  for (const value of values) {
    const k = key(value);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(value);
  }
  return out;
}

function compareProtocols(a: ProtocolStructureFact, b: ProtocolStructureFact): number {
  return a.name.localeCompare(b.name) || compareOptionalFiles(a.file, b.file) || compareSpans(a.span, b.span);
}

function compareOptionalFiles(a: string | undefined, b: string | undefined): number {
  return (a ?? '').localeCompare(b ?? '');
}

function compareSpans(a: A.Span, b: A.Span): number {
  return a.start.line - b.start.line || a.start.col - b.start.col || a.end.line - b.end.line || a.end.col - b.end.col;
}

function flowRank(kind: ProtocolFlowKind): number {
  switch (kind) {
    case 'construct': return 0;
    case 'send': return 1;
    case 'receive': return 2;
    case 'match': return 3;
    case 'test': return 4;
  }
}
