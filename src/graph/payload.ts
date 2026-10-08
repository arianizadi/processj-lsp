/**
 * Everything the viewer page needs, computed on the server: every view laid out
 * and rendered, every placeable verification result as overlay fragments, the
 * sequence chart of every counterexample, and the source text for the code pane.
 * The page itself only arranges, animates and exports these.
 */
import { isPathPrefix, samePath, type VerificationReport } from '../verification';
import { fallbackLayout, layoutView, type ViewLayout } from './layout';
import { countText, viewProcesses, type Confidence, type NetNode, type NetworkModel, type NetworkView, type NetworkViewStub } from './network';
import { buildOverlays, verdictChips, type OverlayModel, type VerdictChip } from './overlay';
import { excalidrawInput, type ExcalidrawInput } from './render-excalidraw';
import { machineRef, machineStyle, type ViewerMachine, type ViewerMachineError } from './render-machine';
import { renderSequenceChart } from './render-msc';
import { legendEntries, networkSubtitle, overlaySubtitle, placeOverlay, renderNetworkBody, renderOverlayLayers, svgStyle, type LegendEntry, type SvgExtent } from './render-svg';

export interface ViewerLocation {
  uri: string;
  line: number;
  col: number;
}

export interface ViewerNode {
  id: string;
  kind: string;
  label: string;
  name: string;
  badge?: string;
  detail?: string;
  parent?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  isProcess: boolean;
  source?: ViewerLocation;
  facts: string[];
  call?: { procedure: string; text: string; params: string[]; collapsed?: string; declaration?: ViewerLocation };
  replicated?: string;
  /** The `own code` box of a container. */
  own?: boolean;
  confidence: Confidence;
  channel?: string;
  operations: Array<{ kind: string; channel: string; at: ViewerLocation; confidence: Confidence; via?: string }>;
  /** The state machine the process runs (machineRef), for a box that is a process. */
  machine?: string;
}

export interface ViewerEdge {
  id: string;
  kind: string;
  from: string;
  to: string;
  channel: string;
  role: string;
  confidence: Confidence;
  label?: string;
  /** `enrolled`, `sync`, `not enrolled` (barrier links), `alt`, `shared write`, ... */
  tags: string[];
}

export interface ViewerChannel {
  id: string;
  kind: string;
  name: string;
  type: string;
  shared: { read: boolean; write: boolean };
  writers: string[];
  readers: string[];
  members: string[];
  /** Barrier members that sync without being enrolled. */
  unenrolled: string[];
  hazard?: string;
  declaration?: ViewerLocation;
  port?: string;
}

export interface ViewerView {
  id: string;
  /** Not laid out in this payload: the page asks for it when it is opened (or says it is not included). */
  pending?: boolean;
  kind: NetworkView['kind'];
  label: string;
  procedure: string;
  /** The model a state machine of this view comes from: `program`, or `proc:<name>:<line>` (viewTarget). */
  target: string;
  source: ViewerLocation;
  width: number;
  height: number;
  /** Groups, arrows, boxes and labels in graph coordinates, with empty overlay layers. */
  svg: string;
  nodes: ViewerNode[];
  edges: ViewerEdge[];
  channels: ViewerChannel[];
  notes: string[];
  excalidraw: ExcalidrawInput;
  /** `process network · 6 processes · 4 channels`, counting processes rather than boxes. */
  subtitle: string;
  /** `6 processes`. */
  processes: string;
  /** Legend keys for what the view draws, for the page's SVG export. */
  legend: LegendEntry[];
  /** URIs this view links to, for a view laid out on demand (the page may reveal them too). */
  knownUris?: string[];
}

export interface ViewerOverlay extends OverlayModel {
  under: string;
  over: string;
  extent: SvgExtent;
  excalidraw: ExcalidrawInput;
  /** The verdict line of an exported picture. */
  subtitle: string;
  /** Legend keys for the view with this result drawn in. */
  legend: LegendEntry[];
}

export interface ViewerPayload {
  version: 1;
  generator: 'processj-lsp';
  title: string;
  uri: string;
  documentVersion?: number;
  generatedAt: string;
  source?: { uri: string; text: string };
  views: ViewerView[];
  defaultView: string;
  reports: VerificationReport[];
  chips: VerdictChip[];
  overlays: ViewerOverlay[];
  /** Sequence chart per `${report}:${check}`. */
  charts: Record<string, string>;
  /** The network's and the state machines' stylesheet with `--pj-*` custom properties (light fallbacks). */
  style: string;
  /** Every URI the page may ask the editor to open. */
  knownUris: string[];
  notes: string[];
  /** State machines carried by a page that cannot ask for them (a file), by machineRequestKey. */
  machines?: Record<string, ViewerMachine | ViewerMachineError>;
  /** What the page shows first: a check of a report (its id) and a process in it (pathKey). */
  focus?: ViewerFocus;
}

/** A check to open the page on, and optionally a process of its result to select. */
export interface ViewerFocus {
  check?: string;
  process?: string;
}

/** The model a view's state machines come from: the program for the program view, else its procedure on its own. */
export function viewTarget(view: Pick<NetworkView, 'kind' | 'procedure' | 'source'>): string {
  return view.kind === 'program' ? 'program' : `proc:${view.procedure}:${view.source.span.start.line}`;
}

/**
 * The state machine a drawn process runs (machineRef): a call's callee, the
 * callee whose own code an expanded call's box runs, the view's procedure for
 * its root, and for an inline par branch or par for body that region of the
 * procedure whose code it is.
 */
export function nodeMachine(view: NetworkView, node: NetNode): string | undefined {
  const path = node.path;
  if (!path) return undefined;
  if (node.call?.declaration) return machineRef(node.call.procedure, node.call.declaration);
  const own = view.instances.find((instance) => samePath(instance.prefix, path));
  if (own) return machineRef(own.procedure, own.declaration);
  const last = path[path.length - 1];
  if (!last) return machineRef(view.procedure, view.source);
  if (last.kind === 'call') return undefined;
  // The innermost expanded call whose processes this one is among; the view's root procedure otherwise.
  const owner = view.instances
    .filter((instance) => instance.spawn.length < path.length && isPathPrefix(instance.spawn, path))
    .sort((a, b) => b.spawn.length - a.spawn.length)[0];
  const region = last.kind === 'branch' ? { kind: 'branch' as const, site: last.site, index: last.index } : { kind: 'par-for' as const, site: last.site };
  return owner ? machineRef(owner.procedure, owner.declaration, region) : machineRef(view.procedure, view.source, region);
}

export interface PayloadInput {
  model: NetworkModel;
  reports?: readonly VerificationReport[];
  source?: { uri: string; text: string };
  documentVersion?: number;
  /** Layouts already computed (cached by the caller), by view id. */
  layouts?: ReadonlyMap<string, ViewLayout>;
  /** Called with each new layout, so the caller can cache it. */
  onLayout?: (view: NetworkView, layout: ViewLayout) => void;
  now?: Date;
  /**
   * How much to lay out up front: the program view and every view a result is
   * placed in always are; other procedure views follow in source order while
   * they fit. The rest are sent as `pending`.
   */
  budget?: { views: number; nodes: number };
  /**
   * Every view of the document in display order, when the model holds only the
   * views built so far: the others are listed as pending.
   */
  stubs?: readonly NetworkViewStub[];
  /** What the page opens on (ViewerPayload.focus). */
  focus?: ViewerFocus;
}

export const DEFAULT_BUDGET = Object.freeze({ views: 40, nodes: 2500 });

/** Lay out one view, falling back to a plain arrangement if the layout engine fails. */
export async function layoutOrFallback(view: NetworkView, notes?: string[]): Promise<ViewLayout> {
  try {
    return await layoutView(view);
  } catch (error) {
    notes?.push(`The layout engine failed on ${view.label} (${error instanceof Error ? error.message : String(error)}); a plain arrangement is shown instead.`);
    return fallbackLayout(view);
  }
}

/** Lay out (or reuse) every view, place every result, and render the fragments the page shows. */
export async function buildViewerPayload(input: PayloadInput): Promise<ViewerPayload> {
  const { model } = input;
  const reports = [...(input.reports ?? [])];
  const notes: string[] = [];
  const overlays = buildOverlays(model, reports, { documentVersion: input.documentVersion });
  // Which views to lay out now.
  const budget = input.budget ?? DEFAULT_BUDGET;
  const eager = new Set<string>([model.defaultView, ...overlays.map((overlay) => overlay.view)]);
  let nodes = model.views.filter((view) => eager.has(view.id)).reduce((sum, view) => sum + view.nodes.length, 0);
  for (const view of model.views) {
    if (eager.has(view.id)) continue;
    if (eager.size >= budget.views || nodes + view.nodes.length > budget.nodes) break;
    eager.add(view.id);
    nodes += view.nodes.length;
  }
  const layouts = new Map<string, ViewLayout>();
  for (const view of model.views) {
    if (!eager.has(view.id)) continue;
    let layout = input.layouts?.get(view.id);
    if (!layout) {
      layout = await layoutOrFallback(view, notes);
      input.onLayout?.(view, layout);
    }
    layouts.set(view.id, layout);
  }
  const knownUris = new Set<string>([model.uri]);
  const built = new Map(model.views.map((view) => [view.id, view]));
  const views: ViewerView[] = (input.stubs ?? model.views).map((stub) => {
    const view = built.get(stub.id);
    const layout = view ? layouts.get(view.id) : undefined;
    return view && layout ? buildViewerView(model, view, layout, knownUris) : pendingView(view ?? stub, knownUris);
  });
  // Views left pending are announced by the page, which knows whether it can still ask for them.
  const viewerOverlays: ViewerOverlay[] = overlays.map((overlay) => {
    const view = model.views.find((entry) => entry.id === overlay.view)!;
    const layout = layouts.get(view.id)!;
    const extent: SvgExtent = { minX: 0, minY: 0, maxX: layout.width, maxY: layout.height };
    const placement = placeOverlay(view, layout, overlay);
    const layers = renderOverlayLayers(view, layout, overlay, extent, { placement });
    return { ...overlay, under: layers.under, over: layers.over, extent, excalidraw: excalidrawInput(view, layout, { title: model.title, overlay, placement }), subtitle: overlaySubtitle(overlay), legend: legendEntries(view, overlay, placement) };
  });
  const charts: Record<string, string> = {};
  reports.forEach((report, index) => {
    for (const check of report.checks) {
      if (!check.counterexample) continue;
      charts[`${index}:${check.id}`] = renderSequenceChart(check.counterexample, { themed: true, title: `${check.label} · ${report.producer === 'fdr' ? 'FDR' : 'static analysis'}` });
      for (const snapshot of check.counterexample.final) {
        if (snapshot.at) knownUris.add(snapshot.at.uri);
      }
    }
  });
  return {
    version: 1,
    generator: 'processj-lsp',
    title: model.title,
    uri: model.uri,
    documentVersion: input.documentVersion,
    generatedAt: (input.now ?? new Date()).toISOString(),
    source: input.source,
    views,
    defaultView: model.defaultView,
    reports,
    chips: verdictChips(model, reports, overlays, { documentVersion: input.documentVersion }),
    overlays: viewerOverlays,
    charts,
    style: `${svgStyle('themed')}${machineStyle('themed')}`,
    knownUris: [...knownUris].sort(),
    notes,
    ...(input.focus ? { focus: input.focus } : {}),
  };
}

function locationOf(ref: { uri: string; span: { start: { line: number; col: number } } } | undefined, known: Set<string>): ViewerLocation | undefined {
  if (!ref) return undefined;
  known.add(ref.uri);
  return { uri: ref.uri, line: ref.span.start.line, col: ref.span.start.col };
}

/** A view the page can show: its rendered body and what the details panel needs. */
export function buildViewerView(model: NetworkModel, view: NetworkView, layout: ViewLayout, known: Set<string> = new Set()): ViewerView {
  const location = (ref: Parameters<typeof locationOf>[0]): ViewerLocation | undefined => locationOf(ref, known);
  return {
    id: view.id,
    kind: view.kind,
    label: view.label,
    procedure: view.procedure,
    target: viewTarget(view),
    source: location(view.source)!,
    width: layout.width,
    height: layout.height,
    svg: renderNetworkBody(view, layout, 'pj'),
    nodes: view.nodes.filter((node) => layout.nodes[node.id]).map((node): ViewerNode => {
      const box = layout.nodes[node.id];
      return {
        id: node.id,
        kind: node.kind,
        label: node.label,
        name: node.name,
        badge: node.badge,
        detail: node.detail,
        parent: node.parent,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        depth: box.depth,
        isProcess: !!node.path,
        source: location(node.source),
        facts: node.facts,
        call: node.call ? { procedure: node.call.procedure, text: node.call.text, params: node.call.params, collapsed: node.call.collapsed, declaration: location(node.call.declaration) } : undefined,
        replicated: node.replicated?.text,
        own: node.own,
        confidence: node.confidence,
        channel: node.channel,
        operations: node.operations.map((operation) => ({ kind: operation.kind, channel: operation.channel, at: location(operation.at)!, confidence: operation.confidence, via: operation.via ? `${operation.via.procedure}(${operation.via.parameter})` : undefined })),
        machine: nodeMachine(view, node),
      };
    }),
    edges: view.edges.map((edge) => ({ id: edge.id, kind: edge.kind, from: edge.from, to: edge.to, channel: edge.channel, role: edge.role, confidence: edge.confidence, label: edge.label, tags: edge.tags })),
    channels: view.channels.map((channel) => ({
      id: channel.id,
      kind: channel.kind,
      name: channel.name,
      type: channel.type,
      shared: channel.shared,
      writers: channel.writers.map((end) => end.node),
      readers: channel.readers.map((end) => end.node),
      members: channel.members.map((end) => end.node),
      unenrolled: channel.members.filter((end) => end.tags.includes('not enrolled')).map((end) => end.node),
      hazard: channel.hazard,
      declaration: location(channel.ref.declaration),
      port: channel.port,
    })),
    notes: view.notes,
    excalidraw: excalidrawInput(view, layout, { title: model.title }),
    subtitle: networkSubtitle(view),
    processes: countText(viewProcesses(view)),
    legend: legendEntries(view),
  };
}

/** A view listed by name only: laid out when the page asks for it. */
function pendingView(view: NetworkViewStub, known: Set<string>): ViewerView {
  return {
    id: view.id,
    pending: true,
    kind: view.kind,
    label: view.label,
    procedure: view.procedure,
    target: viewTarget(view),
    source: locationOf(view.source, known)!,
    width: 0,
    height: 0,
    svg: '',
    nodes: [],
    edges: [],
    channels: [],
    notes: view.notes,
    excalidraw: { title: view.label, nodes: [], edges: [], notes: [], curves: [] },
    subtitle: '',
    processes: '',
    legend: [],
  };
}
