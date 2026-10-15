/**
 * An Excalidraw scene of one laid-out view, from the same coordinates as the
 * SVG: rectangles for processes and containers, ellipses for junctions,
 * diamonds for barriers, and arrows bound to the shapes they join (so dragging
 * a box in Excalidraw drags its arrows), with labels bound to their shape or
 * arrow. Ids, seeds and nonces are hashes of the element's identity, so the same
 * view always produces the same file.
 *
 * `buildExcalidrawScene` refers to nothing outside its own body: the viewer page
 * embeds its source text to export the view it is showing.
 */
import type { ViewLayout } from './layout';
import type { NetworkView } from './network';
import type { OverlayModel } from './overlay';
import { overlaySubtitle, placeOverlay, wrapLines, wrapText, type OverlayPlacement } from './render-svg';

/** Plain data the scene is built from: what the viewer page also has. */
export interface ExcalidrawInput {
  title: string;
  nodes: Array<{
    id: string;
    kind: 'process' | 'group' | 'junction' | 'barrier' | 'port' | 'stub';
    group?: string;
    label: string;
    detail?: string;
    x: number;
    y: number;
    width: number;
    height: number;
    replicated?: string;
    dashed?: boolean;
    state?: 'blocked' | 'behind' | 'terminated' | 'error' | 'running';
    /** Containers this box is drawn in, innermost first: Excalidraw groups, so a container drags with its contents. */
    parents: string[];
    labelBox?: { x: number; y: number; width: number; height: number; text: string };
  }>;
  edges: Array<{
    id: string;
    from: string;
    to: string;
    points: Array<[number, number]>;
    label?: { text: string; x: number; y: number; width: number; height: number };
    style: 'solid' | 'dashed' | 'dotted';
    arrow: boolean;
    barrier: boolean;
    warn?: boolean;
    state?: 'stuck' | 'behind' | 'cycle';
    parents: string[];
  }>;
  /** Overlay notes where the SVG places them: badges, stop markers with their reasons, callouts. */
  notes: Array<{ id: string; kind: 'badge' | 'marker' | 'reason' | 'callout'; text: string; x: number; y: number; width: number; height: number; tone: string; group?: string }>;
  /** Circular-wait loops and `waits for` links. */
  curves: Array<{ id: string; points: Array<[number, number]>; tone: string }>;
}

export interface ExcalidrawScene {
  type: 'excalidraw';
  version: 2;
  source: string;
  elements: Array<Record<string, unknown>>;
  appState: { viewBackgroundColor: string; gridSize: null };
  files: Record<string, never>;
}

/** The scene for one view (with the final state of `overlay`, when given). */
export function renderExcalidraw(view: NetworkView, layout: ViewLayout, options: { title?: string; overlay?: OverlayModel } = {}): string {
  return `${JSON.stringify(buildExcalidrawScene(excalidrawInput(view, layout, options)), null, 2)}\n`;
}

/** Geometry and words of a laid-out view, in the shape `buildExcalidrawScene` takes. */
export function excalidrawInput(view: NetworkView, layout: ViewLayout, options: { title?: string; overlay?: OverlayModel; placement?: OverlayPlacement } = {}): ExcalidrawInput {
  const overlay = options.overlay;
  const placement = overlay ? options.placement ?? placeOverlay(view, layout, overlay) : undefined;
  const state = new Map<string, NonNullable<ExcalidrawInput['nodes'][number]['state']>>();
  for (const outline of placement?.outlines ?? []) {
    const kind = outline.tone === 'root' ? 'blocked' : outline.tone === 'behind' ? 'behind' : outline.tone === 'done' ? 'terminated' : outline.tone === 'error' ? 'error' : 'running';
    if (!state.has(outline.node)) state.set(outline.node, kind);
  }
  const edgeState = new Map<string, 'stuck' | 'behind'>((placement?.edges ?? []).filter((item) => item.tone !== 'loop').map((item) => [item.edge, item.tone === 'root' ? 'stuck' : 'behind'] as const));
  const byId = new Map(view.nodes.map((node) => [node.id, node]));
  const parents = (id: string | undefined): string[] => {
    const out: string[] = [];
    for (let node = id ? byId.get(id) : undefined; node; node = node.parent ? byId.get(node.parent) : undefined) if (node.kind === 'group') out.push(node.id);
    return out;
  };
  const nodes: ExcalidrawInput['nodes'] = [];
  const depth = (id: string): number => layout.nodes[id]?.depth ?? 0;
  const ordered = [...view.nodes].sort((a, b) => (a.kind === 'group' ? 0 : 1) - (b.kind === 'group' ? 0 : 1) || depth(a.id) - depth(b.id));
  for (const node of ordered) {
    const box = layout.nodes[node.id];
    if (!box) continue;
    nodes.push({
      id: node.id,
      kind: node.kind,
      group: node.group,
      // One line for the badge and the label; the second line, when there is one, is the detail.
      label: node.badge && (node.kind === 'group' || node.kind === 'process') && node.badge !== node.label ? `${node.badge} · ${node.label}` : node.label,
      detail: node.kind === 'process' || node.kind === 'group' ? node.detail : undefined,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      replicated: node.replicated?.text,
      dashed: node.confidence !== 'exact' || node.kind === 'stub',
      state: state.get(node.id),
      parents: parents(node.parent),
      labelBox: node.kind === 'junction' && box.label ? { ...box.label, text: node.label } : undefined,
    });
  }
  const edges: ExcalidrawInput['edges'] = view.edges.flatMap((edge) => {
    const laid = layout.edges[edge.id];
    if (!laid || laid.points.length < 2) return [];
    const target = byId.get(edge.to);
    // Grouped with the innermost container holding both ends.
    const from = parents(edge.from);
    const shared = parents(edge.to).filter((id) => from.includes(id));
    return [{
      id: edge.id,
      from: edge.from,
      to: edge.to,
      points: laid.points.map((point): [number, number] => [point.x, point.y]),
      label: edge.label && laid.label ? { text: edge.label, ...laid.label } : undefined,
      style: edge.kind === 'barrier' || edge.confidence === 'conditional' ? 'dashed' : edge.confidence === 'unknown' ? 'dotted' : 'solid',
      arrow: edge.kind === 'channel' && target?.kind !== 'junction' && !edge.tags.includes('undirected'),
      barrier: edge.kind === 'barrier',
      warn: edge.tags.includes('not enrolled'),
      state: edgeState.get(edge.id),
      parents: shared,
    }];
  });
  const notes: ExcalidrawInput['notes'] = [];
  for (const badge of placement?.badges ?? []) notes.push({ id: `badge:${badge.node}:${badge.text}`, kind: 'badge', text: badge.text, ...badge.box, tone: badge.tone, group: `note:${badge.node}` });
  placement?.markers.forEach((marker) => {
    // Only the waits that explain the result have their reason beside the marker.
    const reason = placement.reasons.find((entry) => entry.node === marker.node && entry.anchor === marker.at);
    notes.push({ id: `stuck:${marker.node}:${marker.edge}`, kind: 'marker', text: '', x: marker.at.x - 8, y: marker.at.y - 8, width: 16, height: 16, tone: marker.tone, group: `wait:${marker.node}:${marker.edge}` });
    if (reason) notes.push({ id: `reason:${marker.node}:${marker.edge}`, kind: 'reason', text: reason.text, ...reason.box, tone: reason.tone, group: `wait:${marker.node}:${marker.edge}` });
  });
  for (const callout of placement?.callouts ?? []) notes.push({ id: `callout:${callout.text}`, kind: 'callout', text: callout.text, ...callout.box, tone: callout.tone });
  const curves: ExcalidrawInput['curves'] = (placement?.curves ?? []).map((curve, index) => ({ id: `curve:${index}:${curve.from}:${curve.to}`, points: curve.points.map((point): [number, number] => [point.x, point.y]), tone: curve.tone }));
  const title = options.title ? `${options.title} · ${view.label}` : view.label;
  // The verdict in the SVG's words (a stale result says so), wrapped to the drawing rather than cut short,
  // and what the run relies on that the real program may not do.
  const verdict = overlay ? wrapLines(overlaySubtitle(overlay), 16, Math.max(layout.width, 576)) : [];
  const caveats = overlay ? overlay.caveats.flatMap((caveat) => wrapText(`Caveat: ${caveat}.`, 16, Math.max(layout.width, 576))) : [];
  return { title: [title, ...verdict, ...caveats].join('\n'), nodes, edges, notes, curves };
}

/**
 * A complete Excalidraw scene. Self-contained on purpose (no outside names), so
 * its source can run in the viewer page as well.
 */
export function buildExcalidrawScene(input: ExcalidrawInput): ExcalidrawScene {
  const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  /** Fractional-index keys in increasing order: a0..az, b00..bzz, c000... */
  const indexKey = (n: number): string => {
    if (n < 62) return `a${DIGITS[n]}`;
    let rest = n - 62;
    for (let digits = 2, head = 98; head <= 122; digits++, head++) {
      const capacity = Math.pow(62, digits);
      if (rest < capacity) {
        let key = '';
        for (let i = 0; i < digits; i++) {
          key = DIGITS[rest % 62] + key;
          rest = Math.floor(rest / 62);
        }
        return String.fromCharCode(head) + key;
      }
      rest -= capacity;
    }
    return `z${n}`;
  };
  /** 31-bit FNV-1a: deterministic seeds, nonces and ids. */
  const hash = (text: string): number => {
    let value = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 0x01000193) >>> 0;
    return value & 0x7fffffff;
  };
  const used = new Set<string>();
  const idFor = (key: string): string => {
    let id = `pj${hash(key).toString(36)}`;
    for (let n = 2; used.has(id); n++) id = `pj${hash(`${key}#${n}`).toString(36)}`;
    used.add(id);
    return id;
  };
  /** Excalidraw groups: one id per container or note, stable for the same input. */
  const groupId = (key: string): string => `g${hash(`group:${key}`).toString(36)}`;
  const round = (value: number): number => Math.round(value * 100) / 100;
  const elements: Array<Record<string, unknown>> = [];
  const element = (key: string, type: string, x: number, y: number, width: number, height: number, extra: Record<string, unknown>): Record<string, unknown> => {
    const id = idFor(key);
    const out: Record<string, unknown> = {
      id,
      type,
      x: round(x),
      y: round(y),
      width: round(width),
      height: round(height),
      angle: 0,
      strokeColor: '#1e1e1e',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 1,
      strokeStyle: 'solid',
      roughness: 0,
      opacity: 100,
      groupIds: [],
      frameId: null,
      index: indexKey(elements.length),
      roundness: null,
      seed: hash(`${key}:seed`) || 1,
      version: 1,
      versionNonce: hash(`${key}:nonce`),
      isDeleted: false,
      boundElements: null,
      updated: 1,
      link: null,
      locked: false,
      ...extra,
    };
    elements.push(out);
    return out;
  };
  const bind = (shape: Record<string, unknown>, id: string, type: 'arrow' | 'text'): void => {
    const list = (shape.boundElements as Array<{ id: string; type: string }> | null) ?? [];
    list.push({ id, type });
    shape.boundElements = list;
  };
  const FONT = 3; // Cascadia: monospace, like the SVG
  const measure = (text: string, size: number): { width: number; height: number } => {
    const lines = text.split('\n');
    return { width: Math.max(...lines.map((line) => line.length)) * size * 0.6, height: lines.length * size * 1.25 };
  };
  /** The largest size (at most `max`) at which `text` fits inside a box, as Excalidraw lays out bound text (5 px padding). */
  const fitSize = (text: string, width: number, height: number, max: number): number => {
    const lines = text.split('\n');
    const longest = Math.max(1, ...lines.map((line) => line.length));
    const size = Math.min(max, (width - 12) / (longest * 0.6), (height - 12) / (lines.length * 1.25));
    return Math.max(8, Math.floor(size * 10) / 10);
  };
  const text = (key: string, value: string, x: number, y: number, size: number, extra: Record<string, unknown> = {}): Record<string, unknown> => {
    const box = measure(value, size);
    return element(key, 'text', x, y, box.width, box.height, {
      text: value,
      originalText: value,
      fontSize: size,
      fontFamily: FONT,
      textAlign: 'left',
      verticalAlign: 'top',
      containerId: null,
      lineHeight: 1.25,
      autoResize: true,
      ...extra,
    });
  };
  const fills: Record<string, string> = { procedure: '#f8f9fa', par: '#edf2ff', branch: '#edf2ff', call: '#e7f5ff', 'par-for': '#ebfbee' };
  const strokes: Record<string, string> = { procedure: '#adb5bd', par: '#91a7ff', branch: '#91a7ff', call: '#74c0fc', 'par-for': '#8ce99a' };
  const RED = '#e03131';
  const AMBER = '#e8590c';
  const tones: Record<string, { stroke: string; fill: string; text: string }> = {
    root: { stroke: RED, fill: '#ffe3e3', text: RED },
    behind: { stroke: AMBER, fill: '#fff4e6', text: '#d9480f' },
    cycle: { stroke: RED, fill: '#ffe3e3', text: RED },
    done: { stroke: '#2f9e44', fill: '#ebfbee', text: '#2f9e44' },
    error: { stroke: AMBER, fill: '#fff4e6', text: '#d9480f' },
    fail: { stroke: RED, fill: '#ffe3e3', text: RED },
    choice: { stroke: '#1971c2', fill: '#e7f5ff', text: '#1971c2' },
    loop: { stroke: '#7048e8', fill: '#f3f0ff', text: '#7048e8' },
    info: { stroke: '#1971c2', fill: '#e7f5ff', text: '#1971c2' },
  };
  const groups = (parents: readonly string[]): string[] => parents.map(groupId);

  // The title ends above everything drawn: a result's notes can rise above the graph, and its verdict can take lines.
  let top = 0;
  for (const node of input.nodes) top = Math.min(top, node.y, node.labelBox?.y ?? 0);
  for (const note of input.notes) top = Math.min(top, note.y);
  for (const line of [...input.edges, ...input.curves]) for (const point of line.points) top = Math.min(top, point[1]);
  for (const edge of input.edges) if (edge.label) top = Math.min(top, edge.label.y);
  text('title', input.title, 0, top - 24 - measure(input.title, 16).height, 16, { strokeColor: '#1e1e1e' });

  // A circular wait's loop and `waits for` links: above the containers, below the boxes, as in the SVG.
  const drawCurves = (): void => {
    for (const curve of input.curves) {
      const [first, ...rest] = curve.points;
      if (!first) continue;
      const xs = curve.points.map((point) => point[0]);
      const ys = curve.points.map((point) => point[1]);
      const color = (tones[curve.tone] ?? tones.root).stroke;
      element(curve.id, 'arrow', first[0], first[1], Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), {
        strokeColor: color,
        strokeStyle: 'dashed',
        strokeWidth: curve.tone === 'cycle' ? 3 : 1,
        roundness: { type: 2 },
        points: [[0, 0], ...rest.map((point) => [round(point[0] - first[0]), round(point[1] - first[1])])],
        lastCommittedPoint: null,
        startBinding: null,
        endBinding: null,
        startArrowhead: null,
        endArrowhead: 'arrow',
        elbowed: false,
        // Drawn by the result, not bound to boxes: a loop or a `waits for` link.
        customData: { processj: curve.tone === 'cycle' ? 'circular wait' : 'waits for' },
      });
    }
  };
  let curvesDrawn = false;
  const shapes = new Map<string, Record<string, unknown>>();
  for (const node of input.nodes) {
    if (node.kind !== 'group' && !curvesDrawn) {
      drawCurves();
      curvesDrawn = true;
    }
    const stroke = node.state === 'blocked' || node.state === 'error' ? RED : node.state === 'behind' ? AMBER : undefined;
    const faded = node.state === 'terminated' ? 40 : 100;
    if (node.kind === 'group') {
      // A container and everything drawn in it share its group: dragging it in Excalidraw moves its contents.
      const own = groups([node.id, ...node.parents]);
      if (node.replicated) {
        element(`${node.id}:stack2`, 'rectangle', node.x + 8, node.y + 8, node.width, node.height, { strokeColor: '#adb5bd', backgroundColor: '#ffffff', roundness: { type: 3 }, opacity: faded, groupIds: own });
        element(`${node.id}:stack1`, 'rectangle', node.x + 4, node.y + 4, node.width, node.height, { strokeColor: '#adb5bd', backgroundColor: '#ffffff', roundness: { type: 3 }, opacity: faded, groupIds: own });
      }
      const group = node.group ?? 'par';
      const shape = element(node.id, 'rectangle', node.x, node.y, node.width, node.height, {
        strokeColor: stroke ?? strokes[group] ?? '#adb5bd',
        backgroundColor: fills[group] ?? '#f8f9fa',
        strokeStyle: group === 'par' || group === 'branch' ? 'dashed' : 'solid',
        strokeWidth: stroke ? 2 : 1,
        roundness: { type: 3 },
        opacity: faded,
        groupIds: own,
      });
      shapes.set(node.id, shape);
      const title = `${node.label}${node.replicated ? `  ${node.replicated}` : ''}${node.detail ? `  ${node.detail}` : ''}`;
      text(`${node.id}:title`, title, node.x + 14, node.y + 10, fitSize(title, node.width - 16, 30, 14), { strokeColor: '#343a40', groupIds: own });
      continue;
    }
    const own = groups(node.parents);
    if (node.kind === 'junction') {
      const shape = element(node.id, 'ellipse', node.x, node.y, node.width, node.height, { strokeColor: '#495057', backgroundColor: '#495057', groupIds: own });
      shapes.set(node.id, shape);
      if (node.labelBox) text(`${node.id}:label`, node.labelBox.text, node.labelBox.x + 8, node.labelBox.y + 2, 13, { strokeColor: '#343a40', groupIds: own });
      continue;
    }
    if (node.replicated) {
      element(`${node.id}:stack2`, 'rectangle', node.x + 8, node.y + 8, node.width, node.height, { strokeColor: '#868e96', backgroundColor: '#ffffff', roundness: { type: 3 }, opacity: faded, groupIds: own });
      element(`${node.id}:stack1`, 'rectangle', node.x + 4, node.y + 4, node.width, node.height, { strokeColor: '#868e96', backgroundColor: '#ffffff', roundness: { type: 3 }, opacity: faded, groupIds: own });
    }
    // A barrier is a pill like in the SVG: a diamond's text area is a quarter of its box.
    const shape = element(node.id, 'rectangle', node.x, node.y, node.width, node.height, {
      strokeColor: stroke ?? (node.kind === 'barrier' ? '#e8590c' : node.kind === 'stub' ? '#868e96' : '#495057'),
      backgroundColor: node.kind === 'barrier' ? '#fff4e6' : node.kind === 'stub' ? 'transparent' : node.kind === 'port' ? '#f1f3f5' : '#ffffff',
      strokeStyle: node.dashed ? 'dashed' : 'solid',
      strokeWidth: stroke ? 2 : node.kind === 'barrier' ? 2 : 1,
      roundness: { type: 3 },
      opacity: faded,
      groupIds: own,
    });
    shapes.set(node.id, shape);
    const content = `${node.label}${node.replicated ? ` ${node.replicated}` : ''}${node.detail ? `\n${node.detail}` : ''}`;
    const size = fitSize(content, node.width, node.height, node.kind === 'stub' ? 12 : 14);
    const box = measure(content, size);
    const label = text(`${node.id}:text`, content, node.x + (node.width - box.width) / 2, node.y + (node.height - box.height) / 2, size, {
      textAlign: 'center',
      verticalAlign: 'middle',
      containerId: shape.id,
      strokeColor: node.kind === 'barrier' ? '#d9480f' : node.kind === 'stub' ? '#868e96' : '#1e1e1e',
      opacity: faded,
      groupIds: own,
    });
    bind(shape, label.id as string, 'text');
  }

  if (!curvesDrawn) drawCurves();
  for (const edge of input.edges) {
    const [first, ...rest] = edge.points;
    if (!first) continue;
    const xs = edge.points.map((point) => point[0]);
    const ys = edge.points.map((point) => point[1]);
    const from = shapes.get(edge.from);
    const to = shapes.get(edge.to);
    const tone = edge.state === 'stuck' || edge.state === 'cycle' ? RED : edge.state === 'behind' || edge.warn ? AMBER : undefined;
    const arrow = element(edge.id, 'arrow', first[0], first[1], Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), {
      strokeColor: tone ?? (edge.barrier ? '#e8590c' : edge.style === 'dotted' ? '#868e96' : '#343a40'),
      strokeStyle: edge.warn ? 'dotted' : edge.style,
      strokeWidth: edge.state ? 2 : 1,
      points: [[0, 0], ...rest.map((point) => [round(point[0] - first[0]), round(point[1] - first[1])])],
      lastCommittedPoint: null,
      startBinding: from ? { elementId: from.id, focus: 0, gap: 1 } : null,
      endBinding: to ? { elementId: to.id, focus: 0, gap: 1 } : null,
      startArrowhead: null,
      endArrowhead: edge.arrow ? 'arrow' : null,
      elbowed: false,
      groupIds: groups(edge.parents),
    });
    if (from) bind(from, arrow.id as string, 'arrow');
    if (to) bind(to, arrow.id as string, 'arrow');
    if (edge.label) {
      const label = text(`${edge.id}:label`, edge.label.text, edge.label.x + 6, edge.label.y + 2, 13, {
        textAlign: 'center',
        verticalAlign: 'middle',
        containerId: arrow.id,
        strokeColor: edge.warn ? '#d9480f' : '#1e1e1e',
        groupIds: groups(edge.parents),
      });
      bind(arrow, label.id as string, 'text');
    }
  }

  // The result: badges, stop markers with their reasons, callouts.
  for (const note of input.notes) {
    const tone = tones[note.tone] ?? tones.root;
    const groupIds = note.group ? [groupId(note.group)] : [];
    if (note.kind === 'marker') {
      element(note.id, 'ellipse', note.x, note.y, note.width, note.height, { strokeColor: tone.stroke, backgroundColor: tone.stroke, groupIds });
      continue;
    }
    const strong = note.kind === 'callout' || (note.kind === 'badge' && note.tone === 'root');
    // As tall as Excalidraw needs for one line of bound text, centred where the SVG puts the note.
    const size = fitSize(note.text, note.width, 100, note.kind === 'callout' ? 13 : 11);
    const height = Math.max(note.height, size * 1.25 + 11);
    const y = note.y + note.height / 2 - height / 2;
    const shape = element(`${note.id}:box`, 'rectangle', note.x, y, note.width, height, {
      strokeColor: tone.stroke,
      backgroundColor: strong ? tone.stroke : tone.fill,
      roundness: { type: 3 },
      groupIds,
    });
    const box = measure(note.text, size);
    const label = text(note.id, note.text, note.x + (note.width - box.width) / 2, y + (height - box.height) / 2, size, {
      textAlign: 'center',
      verticalAlign: 'middle',
      containerId: shape.id,
      strokeColor: strong ? '#ffffff' : tone.text,
      groupIds,
    });
    bind(shape, label.id as string, 'text');
  }

  return { type: 'excalidraw', version: 2, source: 'processj-lsp', elements, appState: { viewBackgroundColor: '#ffffff', gridSize: null }, files: {} };
}
