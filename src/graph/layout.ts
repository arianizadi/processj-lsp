/**
 * Layout of a process-network view with ELK's layered algorithm (elkjs, EPL-2.0
 * OR GPL-3.0-or-later), run in-process from its bundled build: left to right,
 * with nested pars laid out together with their parents so an arrow between
 * two containers is routed across both.
 *
 * Every label is drawn in a monospace stack, so its width is known without a
 * browser: about 0.6 em per character. Sizes include room for the overlay
 * badges a verification result adds to a box. The same view always produces the
 * same coordinates, so ELK's answers are kept by what it was asked: an edit that
 * leaves a drawing as it was does not lay it out again.
 */
import { createHash } from 'node:crypto';
import type { NetEdge, NetNode, NetworkModel, NetworkView } from './network';

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LaidOutNode extends Box {
  /** Nesting depth, 0 for top-level boxes (groups are drawn back to front). */
  depth: number;
  /** A junction's channel label, placed by the layout. */
  label?: Box;
}

export interface LaidOutEdge {
  /** Polyline from the source box to the target box. */
  points: Point[];
  label?: Box;
}

export interface ViewLayout {
  view: string;
  width: number;
  height: number;
  nodes: Record<string, LaidOutNode>;
  edges: Record<string, LaidOutEdge>;
}

/** Typography shared by the layout and every renderer. */
export const METRICS = {
  /** Width of one monospace character per pixel of font size. */
  charWidth: 0.6,
  labelSize: 13,
  detailSize: 11,
  badgeSize: 9.5,
  edgeLabelSize: 11.5,
  groupLabelSize: 12.5,
  /** Height of a group's title row. */
  groupHeader: 34,
  processPadding: 14,
  minProcessWidth: 128,
  maxProcessWidth: 300,
} as const;

export const FONT_STACK = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

/** Estimated width of `text` in the monospace stack at `size` px. */
export function textWidth(text: string, size: number, letterSpacing = 0): number {
  let columns = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    // CJK and most emoji occupy two columns in monospace fonts.
    columns += code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || code >= 0x1f300) ? 2 : 1;
  }
  return columns * (size * METRICS.charWidth + letterSpacing);
}

/** Size of a process box: badge and label on the first line, detail below. */
export function processSize(node: NetNode): { width: number; height: number } {
  const badge = node.badge ? textWidth(node.badge.toUpperCase(), METRICS.badgeSize, 0.6) + 12 : 0;
  const replicated = node.replicated ? textWidth(node.replicated.text, METRICS.badgeSize + 1) + 14 : 0;
  const first = badge + (badge ? 8 : 0) + textWidth(node.label, METRICS.labelSize, 0) + (replicated ? replicated + 8 : 0);
  const second = node.detail ? textWidth(node.detail, METRICS.detailSize) : 0;
  const width = Math.min(METRICS.maxProcessWidth, Math.max(METRICS.minProcessWidth, Math.ceil(Math.max(first, second) + METRICS.processPadding * 2)));
  return { width, height: node.detail ? 54 : 40 };
}

/** Title row of a group: badge, label, and the replication count. */
export function groupHeaderWidth(node: NetNode): number {
  const badge = node.badge ? textWidth(node.badge.toUpperCase(), METRICS.badgeSize, 0.6) + 12 : 0;
  const replicated = node.replicated ? textWidth(node.replicated.text, METRICS.badgeSize + 1) + 22 : 0;
  const detail = node.detail ? textWidth(node.detail, METRICS.detailSize) + 12 : 0;
  return Math.ceil(badge + 8 + textWidth(node.label, METRICS.groupLabelSize) + detail + replicated + 32);
}

export function edgeLabelSize(text: string): { width: number; height: number } {
  return { width: Math.ceil(textWidth(text, METRICS.edgeLabelSize) + 16), height: 20 };
}

function leafSize(node: NetNode): { width: number; height: number } {
  switch (node.kind) {
    case 'junction': return { width: 14, height: 14 };
    case 'barrier': return { width: Math.ceil(textWidth(node.label, METRICS.labelSize - 1) + 40), height: 28 };
    case 'port': return { width: Math.ceil(textWidth(node.label, METRICS.labelSize - 1) + 30), height: 26 };
    case 'stub': return { width: Math.ceil(textWidth(node.label, METRICS.detailSize) + 22), height: 24 };
    default: return processSize(node);
  }
}

export interface ElkNode {
  id: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  children?: ElkNode[];
  labels?: Array<{ id?: string; text: string; width: number; height: number; x?: number; y?: number; layoutOptions?: Record<string, string> }>;
  layoutOptions?: Record<string, string>;
  edges?: ElkEdge[];
}

export interface ElkEdge {
  id: string;
  sources: string[];
  targets: string[];
  labels?: ElkNode['labels'];
  sections?: Array<{ id: string; startPoint: Point; endPoint: Point; bendPoints?: Point[]; incomingSections?: string[]; outgoingSections?: string[] }>;
}

interface Elk {
  layout(graph: ElkNode, options?: { layoutOptions?: Record<string, string> }): Promise<ElkNode>;
}

let elkInstance: Elk | undefined;

function elk(): Elk {
  if (!elkInstance) {
    // The bundled build runs ELK in this thread: no worker, no network.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ELK = require('elkjs/lib/elk.bundled.js') as new () => Elk;
    // Inside a Web Worker (the browser build) the bundled build takes itself
    // for ELK's own worker: it claims `self.onmessage`, which carries the
    // language server's connection, and has no in-thread worker to offer. It
    // decides that in the constructor, by whether there is a `document`, so
    // one stands in for exactly that long.
    const scope = globalThis as { document?: unknown; self?: unknown };
    const standIn = scope.document === undefined && scope.self !== undefined;
    if (standIn) scope.document = {};
    try {
      elkInstance = new ELK();
    } finally {
      if (standIn) delete scope.document;
    }
  }
  return elkInstance;
}

/** ELK's answers, by a hash of the graph it was given with its ids by position (most recently used last). */
const elkAnswers = new Map<string, { result: ElkNode; size: number }>();
let elkAnswerSize = 0;
/** Characters of graph JSON whose answers are kept: a few hundred ordinary views. */
const ELK_ANSWER_BUDGET = 16_000_000;

/**
 * ELK's layout of a graph: the answer it gave for a graph of the same shape
 * if that is still kept, else a fresh one. Element ids carry source positions
 * (a box's id names the line of its par), so a keystroke above a procedure
 * renames every box without moving any. The graph ELK sees therefore has its
 * ids by position (`n0`, `e3`, …), which makes its answer depend on the shape
 * alone; the real ids are put back on a copy for the caller.
 */
async function layoutGraph(graph: ElkNode): Promise<ElkNode> {
  const { shape, ids } = byPosition(graph);
  const json = JSON.stringify(shape);
  const key = createHash('sha256').update(json).digest('hex');
  let kept = elkAnswers.get(key);
  if (kept) elkAnswers.delete(key);
  else {
    kept = { result: await elk().layout(shape), size: json.length };
    elkAnswerSize += kept.size;
  }
  elkAnswers.set(key, kept);
  for (const [oldest, entry] of elkAnswers) {
    if (elkAnswerSize <= ELK_ANSWER_BUDGET || oldest === key) break;
    elkAnswers.delete(oldest);
    elkAnswerSize -= entry.size;
  }
  return renamed(kept.result, (id) => ids.get(id) ?? id);
}

/** A copy of the graph with its nodes, edges and labels named by position, and each new name's real id. */
function byPosition(graph: ElkNode): { shape: ElkNode; ids: Map<string, string> } {
  const ids = new Map<string, string>();
  const nodes = new Map<string, string>();
  let next = 0;
  const name = (prefix: string, id: string): string => {
    const short = `${prefix}${next++}`;
    ids.set(short, id);
    return short;
  };
  // Nodes first: an edge may name a node that comes after it.
  const visit = (node: ElkNode): void => {
    nodes.set(node.id, name('n', node.id));
    for (const child of node.children ?? []) visit(child);
  };
  visit(graph);
  const shape = renamed(graph, (id) => nodes.get(id) ?? id, (label) => name('l', label), (edge) => name('e', edge));
  return { shape, ids };
}

/** A copy of a graph (or ELK's answer) with node ids mapped by `node`, and edge and label ids by their own maps. */
function renamed(graph: ElkNode, node: (id: string) => string, label: (id: string) => string = node, edge: (id: string) => string = node): ElkNode {
  const labels = (list: ElkNode['labels']): ElkNode['labels'] => list?.map((entry) => (entry.id === undefined ? { ...entry } : { ...entry, id: label(entry.id) }));
  const copy = (item: ElkNode): ElkNode => ({
    ...item,
    id: node(item.id),
    ...(item.labels ? { labels: labels(item.labels) } : {}),
    ...(item.children ? { children: item.children.map(copy) } : {}),
    ...(item.edges ? { edges: item.edges.map((entry) => ({ ...entry, id: edge(entry.id), sources: entry.sources.map(node), targets: entry.targets.map(node), ...(entry.labels ? { labels: labels(entry.labels) } : {}) })) } : {}),
  });
  return copy(graph);
}

/** Lay out any graph with the same in-process ELK the views use (the state machines do). */
export function runElk(graph: ElkNode): Promise<ElkNode> {
  return layoutGraph(graph);
}

export const LAYOUT_OPTIONS: Readonly<Record<string, string>> = Object.freeze({
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.json.edgeCoords': 'ROOT',
  'elk.json.shapeCoords': 'ROOT',
  'elk.randomSeed': '1',
  'elk.layered.spacing.nodeNodeBetweenLayers': '96',
  'elk.spacing.nodeNode': '40',
  'elk.spacing.edgeNode': '26',
  'elk.spacing.edgeEdge': '14',
  'elk.layered.spacing.edgeNodeBetweenLayers': '22',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '14',
  'elk.spacing.edgeLabel': '4',
  'elk.spacing.componentComponent': '48',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  // Boxes keep source order within a layer (ports in parameter order, branches as written):
  // on the corpus this costs one arrow crossing in all, and the drawing reads like the code.
  'elk.layered.crossingMinimization.forceNodeModelOrder': 'true',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.thoroughness': '12',
  'elk.padding': '[top=28,left=28,bottom=28,right=28]',
});

const GROUP_PADDING = `[top=${METRICS.groupHeader + 14},left=22,bottom=22,right=22]`;

/** Lay out one view; `overrides` replaces individual ELK options (for experiments and tests). */
export async function layoutView(view: NetworkView, overrides: Readonly<Record<string, string>> = {}): Promise<ViewLayout> {
  const children = new Map<string, NetNode[]>();
  for (const node of view.nodes) {
    const key = node.parent ?? '';
    const list = children.get(key);
    if (list) list.push(node);
    else children.set(key, [node]);
  }
  const depth = new Map<string, number>();
  const toElk = (node: NetNode, level: number): ElkNode => {
    depth.set(node.id, level);
    const kids = children.get(node.id) ?? [];
    // Replicated boxes are drawn with two stacked copies behind them.
    const stack: Record<string, string> = node.replicated ? { 'elk.margins': '[top=0,left=0,bottom=8,right=8]' } : {};
    if (node.kind === 'group' && kids.length) {
      const header = groupHeaderWidth(node);
      return {
        id: node.id,
        layoutOptions: {
          'elk.padding': GROUP_PADDING,
          'elk.nodeSize.constraints': 'MINIMUM_SIZE',
          'elk.nodeSize.minimum': `(${header}, ${METRICS.groupHeader + 40})`,
          ...stack,
        },
        children: kids.map((child) => toElk(child, level + 1)),
      };
    }
    const size = leafSize(node);
    const options: Record<string, string> = { ...stack };
    if (node.kind === 'port' && node.port?.direction === 'in') options['elk.layered.layering.layerConstraint'] = 'FIRST';
    if (node.kind === 'port' && node.port?.direction === 'out') options['elk.layered.layering.layerConstraint'] = 'LAST';
    if (node.kind === 'junction') {
      const text = junctionLabelText(view, node);
      options['elk.nodeLabels.placement'] = 'OUTSIDE V_TOP H_CENTER';
      return { id: node.id, width: size.width, height: size.height, layoutOptions: options, labels: [{ id: `${node.id}:label`, text, ...edgeLabelSize(text) }] };
    }
    return { id: node.id, width: size.width, height: size.height, layoutOptions: options };
  };
  const roots = (children.get('') ?? []).map((node) => toElk(node, 0));
  const reversed = backEdges(view);
  const edges: ElkEdge[] = view.edges.map((edge) => ({
    id: edge.id,
    sources: [reversed.has(edge.id) ? edge.to : edge.from],
    targets: [reversed.has(edge.id) ? edge.from : edge.to],
    // A loop back into the same box is too short to carry its label inline.
    labels: edge.label ? [{ id: `${edge.id}:label`, text: edge.label, ...edgeLabelSize(edgeLabelText(edge)), layoutOptions: { 'elk.edgeLabels.inline': edge.from === edge.to ? 'false' : 'true', 'elk.edgeLabels.placement': 'CENTER' } }] : undefined,
  }));
  const graph: ElkNode = { id: `${view.id}:graph`, layoutOptions: { ...LAYOUT_OPTIONS, ...overrides }, children: roots, edges };
  const result = await layoutGraph(graph);
  return collect(view, result, depth, reversed);
}

/**
 * Edges that close a cycle, found depth first in source order: ELK lays them
 * out forward and they are drawn back. ELK's own cycle breaking ignores the
 * source order when it lays out nested containers together, so a crossed pair
 * of branches could come out with branch 2 before branch 1.
 */
function backEdges(view: NetworkView): Set<string> {
  const parent = new Map(view.nodes.map((node) => [node.id, node.parent]));
  const related = (a: string, b: string): boolean => {
    for (let node = parent.get(a); node; node = parent.get(node)) if (node === b) return true;
    for (let node = parent.get(b); node; node = parent.get(node)) if (node === a) return true;
    return false;
  };
  const outgoing = new Map<string, NetEdge[]>();
  for (const edge of view.edges) {
    if (edge.from === edge.to || related(edge.from, edge.to)) continue;
    const list = outgoing.get(edge.from);
    if (list) list.push(edge);
    else outgoing.set(edge.from, [edge]);
  }
  const state = new Map<string, 'open' | 'done'>();
  const back = new Set<string>();
  for (const start of view.nodes) {
    if (state.has(start.id)) continue;
    // Iterative DFS: a stack of (node, next outgoing edge index).
    const stack: Array<{ id: string; next: number }> = [{ id: start.id, next: 0 }];
    state.set(start.id, 'open');
    while (stack.length) {
      const top = stack[stack.length - 1];
      const edges = outgoing.get(top.id) ?? [];
      if (top.next >= edges.length) {
        state.set(top.id, 'done');
        stack.pop();
        continue;
      }
      const edge = edges[top.next++];
      const seen = state.get(edge.to);
      if (seen === 'open') back.add(edge.id);
      else if (!seen) {
        state.set(edge.to, 'open');
        stack.push({ id: edge.to, next: 0 });
      }
    }
  }
  return back;
}

/**
 * A plain arrangement for when the layout engine fails: containers stack their
 * boxes in a column, top-level boxes sit in a row, and arrows are straight.
 */
export function fallbackLayout(view: NetworkView): ViewLayout {
  const children = new Map<string, NetNode[]>();
  for (const node of view.nodes) {
    const key = node.parent ?? '';
    const list = children.get(key);
    if (list) list.push(node);
    else children.set(key, [node]);
  }
  const nodes: Record<string, LaidOutNode> = {};
  const place = (node: NetNode, x: number, y: number, depth: number): { width: number; height: number } => {
    const kids = children.get(node.id) ?? [];
    if (node.kind === 'group' && kids.length) {
      let bottom = y + METRICS.groupHeader + 14;
      let width = groupHeaderWidth(node);
      for (const kid of kids) {
        const size = place(kid, x + 22, bottom, depth + 1);
        bottom += size.height + 24;
        width = Math.max(width, size.width + 44);
      }
      const box = { x, y, width, height: bottom - y - 2, depth };
      nodes[node.id] = box;
      return box;
    }
    const size = leafSize(node);
    nodes[node.id] = { x, y, width: size.width, height: size.height, depth };
    return size;
  };
  let x = 28;
  let height = 0;
  for (const node of children.get('') ?? []) {
    const size = place(node, x, 28, 0);
    x += size.width + 60;
    height = Math.max(height, size.height);
  }
  const edges: Record<string, LaidOutEdge> = {};
  for (const edge of view.edges) {
    const from = nodes[edge.from];
    const to = nodes[edge.to];
    if (!from || !to) continue;
    edges[edge.id] = { points: [{ x: from.x + from.width, y: from.y + from.height / 2 }, { x: to.x, y: to.y + to.height / 2 }] };
  }
  return { view: view.id, width: Math.ceil(x), height: Math.ceil(height + 56), nodes, edges };
}

/** Lay out several views of one model; views not listed are skipped. */
export async function layoutModel(model: NetworkModel, views: readonly string[] = model.views.map((view) => view.id)): Promise<Map<string, ViewLayout>> {
  const out = new Map<string, ViewLayout>();
  for (const view of model.views) {
    if (!views.includes(view.id)) continue;
    out.set(view.id, await layoutView(view));
  }
  return out;
}

/** A junction's label: the channel it joins, with how it is shared. */
export function junctionLabelText(view: NetworkView, node: NetNode): string {
  const channel = view.channels.find((entry) => entry.id === node.channel);
  const shared = channel?.shared.read && channel.shared.write ? ' · shared' : channel?.shared.write ? ' · shared writers' : channel?.shared.read ? ' · shared readers' : '';
  return `${node.label}${shared}`;
}

/** The text an edge label shows: name and element type, plus how the channel is shared. */
export function edgeLabelText(edge: NetEdge): string {
  if (!edge.label) return '';
  const shared = edge.tags.includes('shared read') && edge.tags.includes('shared write') ? ' · shared' : edge.tags.includes('shared write') ? ' · shared writers' : edge.tags.includes('shared read') ? ' · shared readers' : '';
  // How the reader takes it, when that is not a plain read.
  const how = edge.tags.includes('alt') ? ' · in an alt' : edge.tags.includes('extended') ? ' · extended' : '';
  // Next to a parameter's port the name is on the port: the arrow says the type.
  if (edge.tags.includes('port')) return `${edge.label.split(' : ')[1] ?? edge.label}${shared}${how}`;
  // Events a hiding makes internal (a CSPm file).
  const hidden = edge.tags.includes('hidden') ? ' · hidden' : '';
  return `${edge.label}${shared}${how}${hidden}`;
}

function collect(view: NetworkView, result: ElkNode, depth: Map<string, number>, reversed: ReadonlySet<string>): ViewLayout {
  const nodes: Record<string, LaidOutNode> = {};
  const round = (value: number | undefined): number => Math.round((value ?? 0) * 10) / 10;
  const visit = (node: ElkNode): void => {
    const label = node.labels?.[0];
    nodes[node.id] = {
      x: round(node.x),
      y: round(node.y),
      width: round(node.width),
      height: round(node.height),
      depth: depth.get(node.id) ?? 0,
      label: label ? { x: round(label.x), y: round(label.y), width: round(label.width), height: round(label.height) } : undefined,
    };
    for (const child of node.children ?? []) visit(child);
  };
  for (const child of result.children ?? []) visit(child);
  keepSourceOrder(view, nodes);
  const edges: Record<string, LaidOutEdge> = {};
  for (const edge of result.edges ?? []) {
    const sections = edge.sections ?? [];
    const points: Point[] = [];
    for (const section of orderSections(sections)) {
      const part = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map((point) => ({ x: round(point.x), y: round(point.y) }));
      for (const point of part) {
        const last = points[points.length - 1];
        if (!last || last.x !== point.x || last.y !== point.y) points.push(point);
      }
    }
    const label = edge.labels?.[0];
    // An edge laid out forward to break a cycle is drawn from its real source.
    if (reversed.has(edge.id)) points.reverse();
    edges[edge.id] = { points, label: label ? { x: round(label.x), y: round(label.y), width: round(label.width), height: round(label.height) } : undefined };
  }
  return { view: view.id, width: Math.ceil(result.width ?? 0), height: Math.ceil(result.height ?? 0), nodes, edges };
}

/**
 * ELK ignores the model order of unconnected boxes inside a container when it
 * lays out the whole hierarchy at once. Boxes with no arrows at all can trade
 * places freely, so put them back in source order within the slots they got.
 */
function keepSourceOrder(view: NetworkView, nodes: Record<string, LaidOutNode>): void {
  const connected = new Set<string>();
  for (const edge of view.edges) {
    connected.add(edge.from);
    connected.add(edge.to);
  }
  const columns = new Map<string, NetNode[]>();
  for (const node of view.nodes) {
    const box = nodes[node.id];
    if (!box || node.kind === 'group' || connected.has(node.id)) continue;
    // Same container, same layer (boxes in a layer share their centre line), same height.
    const key = `${node.parent ?? ''}|${Math.round(box.x + box.width / 2)}|${box.height}`;
    const column = columns.get(key);
    if (column) column.push(node);
    else columns.set(key, [node]);
  }
  for (const column of columns.values()) {
    if (column.length < 2) continue;
    const slots = column.map((node) => ({ y: nodes[node.id].y, centre: nodes[node.id].x + nodes[node.id].width / 2 })).sort((a, b) => a.y - b.y);
    column.forEach((node, index) => {
      const box = nodes[node.id];
      box.y = slots[index].y;
      box.x = Math.round((slots[index].centre - box.width / 2) * 10) / 10;
    });
  }
}

/** Chain an edge's sections from its source to its target. */
function orderSections(sections: NonNullable<ElkEdge['sections']>): NonNullable<ElkEdge['sections']> {
  if (sections.length <= 1) return sections;
  const byId = new Map(sections.map((section) => [section.id, section]));
  const first = sections.find((section) => !section.incomingSections?.length) ?? sections[0];
  const ordered = [first];
  const seen = new Set([first.id]);
  for (let current = first; current.outgoingSections?.length;) {
    const next = byId.get(current.outgoingSections[0]);
    if (!next || seen.has(next.id)) break;
    ordered.push(next);
    seen.add(next.id);
    current = next;
  }
  for (const section of sections) if (!seen.has(section.id)) ordered.push(section);
  return ordered;
}
