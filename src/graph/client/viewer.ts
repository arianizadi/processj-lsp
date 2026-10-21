/*
 * The process-network viewer page: pan and zoom, search, details, and the
 * verification overlay with its timeline, sequence chart and code pane.
 *
 * Compiled on its own (DOM library, no modules) and inlined into the page by
 * render-html.ts. Everything it shows comes from the payload the server
 * rendered; this script only arranges, highlights, animates and exports it.
 */

// ---------------------------------------------------------------------------
// Payload (the subset of src/graph/payload.ts this page reads)
// ---------------------------------------------------------------------------

type Confidence = 'exact' | 'conditional' | 'unknown';

interface Loc {
  uri: string;
  line: number;
  col: number;
}

interface VNode {
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
  source?: Loc;
  facts: string[];
  call?: { procedure: string; text: string; params: string[]; collapsed?: string; declaration?: Loc };
  replicated?: string;
  own?: boolean;
  confidence: Confidence;
  channel?: string;
  operations: Array<{ kind: string; channel: string; at: Loc; confidence: Confidence; via?: string }>;
  machine?: string;
}

interface VEdge {
  id: string;
  kind: string;
  from: string;
  to: string;
  channel: string;
  role: string;
  confidence: Confidence;
  label?: string;
  tags: string[];
}

interface VChannel {
  id: string;
  kind: string;
  name: string;
  type: string;
  shared: { read: boolean; write: boolean };
  writers: string[];
  readers: string[];
  members: string[];
  unenrolled: string[];
  hazard?: string;
  declaration?: Loc;
  port?: string;
}

interface VView {
  id: string;
  pending?: boolean;
  kind: 'program' | 'procedure';
  label: string;
  procedure: string;
  target: string;
  source: Loc;
  width: number;
  height: number;
  svg: string;
  nodes: VNode[];
  edges: VEdge[];
  channels: VChannel[];
  notes: string[];
  excalidraw: unknown;
  subtitle: string;
  processes: string;
  legend: LegendEntry[];
  knownUris?: string[];
  /** The heading the view is listed under (a CSPm file: Asserted, Defined). */
  section?: string;
}

interface LegendEntry {
  svg: string;
  width: number;
}

interface SourceRef {
  uri: string;
  span: { start: { line: number; col: number }; end: { line: number; col: number } };
}

interface Chip {
  report: number;
  check: string;
  producer: 'checker' | 'fdr';
  label: string;
  status: string;
  severity: 'error' | 'warning' | 'info';
  text: string;
  stats?: { states?: number; transitions?: number; ms?: number };
  stale: boolean;
  steps: number;
  views: string[];
  preferredView?: string;
  message?: string;
  limits?: string[];
  caveats?: string[];
  target: string;
  targetLabel?: string;
}

interface OverlayStep {
  index: number;
  kind: string;
  visible: boolean;
  event: string;
  value?: string;
  description: string;
  channel?: string;
  route: string[];
  participants: Array<{ node?: string; role: string; at?: SourceRef; label: string }>;
  caveat?: string;
}

/** A step of how the run locked up, after its trace (overlay.ts OverlayFormationStep). */
interface FormationStep {
  kind: 'stuck' | 'cycle' | 'dead-end';
  nodes: string[];
  keys: string[];
  after?: number;
  edges: string[];
  partners: string[];
  cycle?: number;
  link?: number;
  title: string;
  caption: string;
  at?: SourceRef;
}

interface Overlay {
  view: string;
  report: number;
  check: string;
  producer: 'checker' | 'fdr';
  label: string;
  status: string;
  severity: string;
  kind?: string;
  summary: string;
  stale: boolean;
  processes: Array<{ node: string; key: string; exact: boolean; status: string; badge: string; description: string; at?: SourceRef; label: string; name: string; cause?: 'root' | 'knock-on'; forGood?: boolean; trail?: Array<{ step: number; state: string }> }>;
  waits: Array<{ node: string; edge?: string; end?: string; operation: string; channel?: string; reason: string; short: string; detail: string; at?: SourceRef; partnerNode?: string; partnerState?: string; cause: 'root' | 'knock-on' }>;
  cycles: Array<{ nodes: string[]; edges: string[]; label: string }>;
  steps: OverlayStep[];
  loopStart?: number;
  error?: { message: string; node?: string; at?: SourceRef };
  ending: 'stuck' | 'loop' | 'error' | 'range' | 'end';
  choice?: { step: number; node?: string; at?: SourceRef; description: string };
  caveats: string[];
  story: string[];
  /** Absent in a payload from before it. */
  formation?: FormationStep[];
  unplaced: string[];
  relocated?: string;
  under: string;
  over: string;
  extent: { minX: number; minY: number; maxX: number; maxY: number };
  excalidraw: unknown;
  subtitle: string;
  legend: LegendEntry[];
}

interface Report {
  producer: 'checker' | 'fdr';
  tool?: { name: string; version?: string };
  assumptions: string[];
  checks: Array<{ id: string; label: string; status: string; message?: string; assertion?: string; counterexample?: { summary: string; kind: string } }>;
}

interface Payload {
  title: string;
  uri: string;
  documentVersion?: number;
  generatedAt: string;
  source?: { uri: string; text: string };
  views: VView[];
  defaultView: string;
  reports: Report[];
  chips: Chip[];
  overlays: Overlay[];
  charts: Record<string, string>;
  style: string;
  knownUris: string[];
  notes: string[];
  machines?: Record<string, Machine | MachineError>;
  focus?: Focus;
  /** `cspm` for a CSPm file: its views are processes, its results are FDR's on the file's own assertions. */
  language?: 'processj' | 'cspm';
  /** A file this one was generated from (a model from Convert to CSP: its ProcessJ source). */
  related?: { label: string; uri: string; note: string; graph?: string };
}

/** A check to show, and a process of its result to select (pathKey). */
interface Focus {
  check?: string;
  process?: string;
}

interface MachineRequest {
  target: string;
  ref: string;
  check?: string;
  process?: string;
}

interface MachineState {
  id: string;
  label: string;
  kind: string;
  definition: boolean;
  passing: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  at?: Loc;
  text?: string;
}

interface Machine {
  key: string;
  target: string;
  ref: string;
  label: string;
  procedure: string;
  model: string;
  width: number;
  height: number;
  svg: string;
  states: MachineState[];
  transitions: Array<{ from: string; to: string; label: string; conditional: boolean; call?: string; callRef?: string; guard?: number; error?: boolean; line?: number }>;
  initial: string;
  trail?: Array<{ step: number; state: string; id?: string; call?: number; inside?: string; label: string }>;
  process?: { label: string; status: string; description: string; waits: string[] };
  notes: string[];
}

interface MachineError {
  key: string;
  error: string;
}

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;
declare const buildExcalidrawScene: (input: unknown) => unknown;

// ---------------------------------------------------------------------------
// Page state
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
const root = document.documentElement;
const MODE = (root.dataset.mode ?? 'file') as 'file' | 'live' | 'webview';
const LIVE_BASE = root.dataset.base ?? '';
const vscode: VsCodeApi | undefined = MODE === 'webview' && typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/** One colour per process in a replay; each keeps white text above 4.5:1 in either theme. */
const PALETTE = ['#2563eb', '#be185d', '#047857', '#b45309', '#7c3aed', '#0e7490', '#be123c', '#4d7c0f'];

const $ = <T extends Element = HTMLElement>(id: string): T => document.getElementById(id) as unknown as T;

const stage = $('stage');
const canvas = $<SVGSVGElement>('canvas');
const viewport = $<SVGGElement>('viewport');
const graph = $<SVGGElement>('graph');
const dynamic = $<SVGGElement>('dynamic');
const marks = $<SVGGElement>('marks');
const panel = $('panel-body');
const verdicts = $('verdicts');
const viewSelect = $<HTMLSelectElement>('view-select');
const searchInput = $<HTMLInputElement>('search');
const searchCount = $('search-count');
const zoomLabel = $('zoom-reset');
const minimap = $<SVGSVGElement>('minimap-svg');
const minimapFrame = $<SVGRectElement>('minimap-frame');
const minimapBox = $('minimap');
const dock = $('dock');
const timeline = $('timeline');
const stepText = $('step-text');
const codePane = $('code');
const chartPane = $('chart');
const machinePane = $('machine');
const toast = $('toast');
const stageMessage = $('stage-message');

interface Transform {
  x: number;
  y: number;
  k: number;
}

let payload: Payload = JSON.parse(($('payload') as HTMLScriptElement).textContent ?? '{}') as Payload;
/** Shown when the file has no procedure with a body yet: the page still runs and follows the buffer. */
const EMPTY_VIEW: VView = { id: '', kind: 'program', label: 'no procedure yet', procedure: '', target: 'program', source: { uri: '', line: 0, col: 0 }, width: 0, height: 0, svg: '', nodes: [], edges: [], channels: [], notes: [], excalidraw: undefined, subtitle: '', processes: '', legend: [] };
let view: VView = payload.views.find((entry) => entry.id === payload.defaultView) ?? payload.views[0] ?? EMPTY_VIEW;
const transforms = new Map<string, Transform>();
let transform: Transform = { x: 0, y: 0, k: 1 };
let userMoved = false;
let selection: { type: 'node' | 'channel'; id: string } | undefined;
let active: { report: number; check: string } | undefined;
let overlay: Overlay | undefined;
let cursor = 0;
let playing = false;
let playTimer: number | undefined;
let speed = 1;
let searchMatches: string[] = [];
let searchIndex = -1;
let dockTab: 'code' | 'chart' | 'machine' = 'code';
let codeOpen = false;
/** The state machine the dock shows: the box it is for, and what was asked for it. */
let machineShown: { node: string; request: MachineRequest } | undefined;
/** State machines received (or refused) so far, by request key. */
const machineCache = new Map<string, Machine | MachineError>();
const toggles = { labels: true, types: true, conditional: true };
let nodeById = new Map<string, VNode>();
let edgeById = new Map<string, VEdge>();
let channelById = new Map<string, VChannel>();
let nodeEls = new Map<string, SVGGElement>();
let edgeEls = new Map<string, SVGGElement>();
let incident = new Map<string, Set<string>>();
let colors = new Map<string, string>();

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(`processj-graph:${key}`, value);
  } catch {
    /* storage can be unavailable (file://, private windows) */
  }
}

function recall(key: string): string | undefined {
  try {
    return localStorage.getItem(`processj-graph:${key}`) ?? undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Array<Node | string | undefined>): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') element.className = value;
    else element.setAttribute(key, value);
  }
  for (const child of children) {
    if (child === undefined) continue;
    element.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return element;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  return element;
}

function fileName(uri: string): string {
  try {
    return decodeURIComponent(uri.replace(/[?#].*$/, '').split('/').pop() ?? uri);
  } catch {
    return uri;
  }
}

function showToast(message: string): void {
  toast.textContent = message;
  toast.classList.add('visible');
  window.setTimeout(() => toast.classList.remove('visible'), 2600);
}

/** `philosopher(0, p0f0.write, p0f1.write)` as `philosopher(0, …)`: a call by its first argument. */
function shortName(label: string): string {
  const open = label.indexOf('(');
  if (open <= 0 || !label.endsWith(')')) return label;
  let depth = 0;
  for (let i = open + 1; i < label.length - 1; i++) {
    const ch = label[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) return `${label.slice(0, i)}, …)`;
  }
  return label;
}

/** A process of a result in a line of text: the producer's name for it, else its call by the first argument. */
function processWord(process: { label: string; name: string }): string {
  return process.name !== process.label ? process.name : shortName(process.label);
}

/** `a`, `a and b`, `a, b and c`. */
function listWords(words: string[]): string {
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0] ?? '';
}

/** A CSPm file's page: processes and events rather than procedures and channels. */
function isCspm(): boolean {
  return payload.language === 'cspm';
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : /(s|x|ch|sh)$/.test(word) ? 'es' : 's'}`;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function populateViews(): void {
  viewSelect.replaceChildren();
  viewSelect.disabled = !payload.views.length;
  if (!payload.views.length) {
    viewSelect.append(h('option', { value: '' }, isCspm() ? 'no process yet' : 'no procedure yet'));
    return;
  }
  if (payload.views.some((entry) => entry.section)) {
    // Views listed under their own headings, in order (a CSPm file: the asserted processes, then the others).
    const sections = new Map<string, VView[]>();
    for (const entry of payload.views) sections.set(entry.section ?? '', [...(sections.get(entry.section ?? '') ?? []), entry]);
    for (const [name, entries] of sections) {
      const group = h('optgroup', { label: name || 'Views' });
      for (const entry of entries) group.append(h('option', { value: entry.id }, entry.label));
      viewSelect.append(group);
    }
    viewSelect.value = view.id;
    return;
  }
  const program = payload.views.filter((entry) => entry.kind === 'program');
  const procedures = payload.views.filter((entry) => entry.kind === 'procedure');
  for (const entry of program) viewSelect.append(h('option', { value: entry.id }, entry.label));
  if (procedures.length) {
    const group = h('optgroup', { label: 'Each procedure on its own' });
    for (const entry of procedures) group.append(h('option', { value: entry.id }, entry.label));
    viewSelect.append(group);
  }
  viewSelect.value = view.id;
}

/** A view the payload only names: ask for it (live page, VS Code) or say why it is missing. */
function loadView(next: VView): void {
  viewSelect.value = next.id;
  graph.replaceChildren();
  dynamic.replaceChildren();
  stageMessage.hidden = false;
  if (MODE === 'live') {
    stageMessage.textContent = `Laying out ${next.label}…`;
    void fetch(`${LIVE_BASE}view?id=${encodeURIComponent(next.id)}`)
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<VView>;
      })
      .then((loaded) => receiveView(loaded))
      .catch(() => {
        stageMessage.textContent = `Could not lay out ${next.label}.`;
      });
  } else if (vscode) {
    stageMessage.textContent = `Laying out ${next.label}…`;
    vscode.postMessage({ type: 'view', id: next.id });
  } else {
    stageMessage.textContent = `${next.label} is not part of this file: it holds the first ${payload.views.filter((entry) => !entry.pending).length} views. Open the graph from your editor to browse every procedure.`;
  }
  // The panel and the dock describe the view on screen, not the one before.
  zoomLabel.textContent = '—';
  minimapBox.hidden = true;
  renderPanel(next);
  renderDock();
}

function receiveView(loaded: VView): void {
  const index = payload.views.findIndex((entry) => entry.id === loaded.id);
  if (index < 0) return;
  payload.views[index] = loaded;
  if (viewSelect.value === loaded.id) showView(loaded.id, { fit: true });
}

function showView(id: string, options: { fit?: boolean } = {}): void {
  const next = payload.views.find((entry) => entry.id === id) ?? (payload.views.length ? undefined : EMPTY_VIEW);
  if (!next) return;
  if (next.pending) {
    if (view && !view.pending && view !== EMPTY_VIEW) transforms.set(view.id, { ...transform });
    view = next;
    overlay = undefined;
    loadView(next);
    return;
  }
  stageMessage.hidden = next !== EMPTY_VIEW;
  if (next === EMPTY_VIEW) stageMessage.textContent = isCspm() ? 'This file defines no process yet. The network appears here as soon as it does.' : 'This file has no procedure with a body yet. The network appears here as soon as it has one.';
  if (view && !view.pending && view !== EMPTY_VIEW) transforms.set(view.id, { ...transform });
  view = next;
  viewSelect.value = view.id;
  nodeById = new Map(view.nodes.map((node) => [node.id, node]));
  edgeById = new Map(view.edges.map((edge) => [edge.id, edge]));
  channelById = new Map(view.channels.map((channel) => [channel.id, channel]));
  graph.innerHTML = view.svg;
  nodeEls = new Map();
  edgeEls = new Map();
  for (const element of graph.querySelectorAll<SVGGElement>('.pj-node[data-id]')) {
    const id = element.dataset.id!;
    nodeEls.set(id, element);
    const node = nodeById.get(id);
    if (!node) continue;
    element.setAttribute('tabindex', '0');
    element.setAttribute('role', 'button');
    element.setAttribute('aria-label', `${node.kind === 'group' ? 'container' : node.kind} ${node.name}`);
  }
  for (const element of graph.querySelectorAll<SVGGElement>('.pj-edge[data-id]')) edgeEls.set(element.dataset.id!, element);
  incident = new Map();
  for (const edge of view.edges) {
    for (const end of [edge.from, edge.to]) {
      for (let node: string | undefined = end; node; node = nodeById.get(node)?.parent) {
        let set = incident.get(node);
        if (!set) incident.set(node, (set = new Set()));
        set.add(edge.id);
      }
    }
  }
  minimap.setAttribute('viewBox', `${-20} ${-20} ${view.width + 40} ${view.height + 40}`);
  const saved = transforms.get(view.id);
  if (saved && !options.fit) {
    transform = { ...saved };
    applyTransform();
  } else openingView();
  overlay = active ? payload.overlays.find((entry) => entry.view === view.id && entry.report === active!.report && entry.check === active!.check) : undefined;
  if (selection && !(selection.type === 'node' ? nodeById.has(selection.id) : channelById.has(selection.id))) selection = undefined;
  if (machineShown && !nodeById.get(machineShown.node)?.machine) machineShown = undefined;
  else refreshMachineRequest();
  applySelection();
  applySearch(false);
  renderOverlayState(false);
  // The timeline belongs to the result shown in this view (or to none).
  renderDock();
  renderPanel();
}

// ---------------------------------------------------------------------------
// Pan and zoom
// ---------------------------------------------------------------------------

function applyTransform(): void {
  viewport.setAttribute('transform', `translate(${transform.x.toFixed(2)} ${transform.y.toFixed(2)}) scale(${transform.k.toFixed(4)})`);
  zoomLabel.textContent = `${Math.round(transform.k * 100)}%`;
  updateMinimap();
  scaleOverlayText();
}

/** Below this zoom the result's words grow around their anchors, so they stay readable (about 10 px on screen). */
const READABLE_ZOOM = 0.9;
let overlayText: SVGGElement[] = [];

function scaleOverlayText(): void {
  const scale = transform.k < READABLE_ZOOM ? Math.min(2.6, READABLE_ZOOM / transform.k) : 1;
  for (const element of overlayText) {
    const cx = Number(element.dataset.cx);
    const cy = Number(element.dataset.cy);
    // A badge grows no wider than the box it is about, so the box's own name stays readable.
    const limit = Number(element.dataset.limit);
    let k = Number.isFinite(limit) && limit > 0 ? Math.max(1, Math.min(scale, limit)) : scale;
    // A callout (the circular wait) grows no wider than the canvas, so a narrow window still shows all of it.
    const width = Number(element.dataset.width);
    if (Number.isFinite(width) && width > 0 && canvas.clientWidth > 0) k = Math.max(1, Math.min(k, (canvas.clientWidth - 24) / (width * transform.k)));
    if (k === 1 || !Number.isFinite(cx) || !Number.isFinite(cy)) element.removeAttribute('transform');
    else element.setAttribute('transform', `translate(${cx} ${cy}) scale(${k.toFixed(3)}) translate(${-cx} ${-cy})`);
  }
}

/** How far each badge may grow: to the width of the box it sits on; a reason pill less than a callout, so neighbours stay apart. */
function measureOverlayText(): void {
  for (const element of overlayText) {
    if (element.classList.contains('pj-ov-reason-wrap')) element.dataset.limit = '1.8';
    if (element.classList.contains('pj-ov-callout-wrap')) element.dataset.width = String(element.getBBox().width);
    if (!element.classList.contains('pj-ov-badge-wrap')) continue;
    const node = element.dataset.node ? nodeById.get(element.dataset.node) : undefined;
    const width = element.getBBox().width;
    if (node && width > 0) element.dataset.limit = String(node.width / width);
  }
}

/** What there is to see: the view, and the words its result draws around it (`withResult`: at its end state). */
function contentBounds(withResult = !!overlay): { x: number; y: number; width: number; height: number } {
  let minX = 0;
  let minY = 0;
  let maxX = view.width;
  let maxY = view.height;
  if (overlay && withResult) {
    minX = Math.min(minX, overlay.extent.minX);
    minY = Math.min(minY, overlay.extent.minY);
    maxX = Math.max(maxX, overlay.extent.maxX);
    maxY = Math.max(maxY, overlay.extent.maxY);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

let animation: number | undefined;

function animateTo(target: Transform, animate = true): void {
  if (animation) cancelAnimationFrame(animation);
  if (!animate || reduceMotion) {
    transform = target;
    applyTransform();
    return;
  }
  const start = { ...transform };
  const began = performance.now();
  const duration = 220;
  const step = (now: number): void => {
    const t = Math.min(1, (now - began) / duration);
    const ease = 1 - Math.pow(1 - t, 3);
    // Interpolate the scale geometrically so zooming feels even.
    const k = start.k * Math.pow(target.k / start.k, ease);
    transform = { x: start.x + (target.x - start.x) * ease, y: start.y + (target.y - start.y) * ease, k };
    applyTransform();
    if (t < 1) animation = requestAnimationFrame(step);
  };
  animation = requestAnimationFrame(step);
}

function fit(animate = true, bounds = contentBounds()): void {
  const rect = stage.getBoundingClientRect();
  const width = Math.max(rect.width, 100);
  const height = Math.max(rect.height, 100);
  const k = Math.min((width - 56) / Math.max(bounds.width, 1), (height - 56) / Math.max(bounds.height, 1), 1.6);
  animateTo({ k, x: (width - bounds.width * k) / 2 - bounds.x * k, y: (height - bounds.height * k) / 2 - bounds.y * k }, animate);
  userMoved = false;
}

/**
 * The first look at a view: all of it when that is legible, else its start (the
 * inputs, on the left) at a readable size; the minimap shows the rest and 0 fits.
 */
function openingView(): void {
  const rect = stage.getBoundingClientRect();
  const bounds = contentBounds();
  const k = Math.min((rect.width - 56) / Math.max(bounds.width, 1), (rect.height - 56) / Math.max(bounds.height, 1), 1.6);
  if (k >= 0.5) {
    fit(false);
    return;
  }
  // Never below a readable size: the minimap shows the rest.
  const readable = Math.max(0.6, Math.min(0.75, Math.max(k, (rect.height - 56) / Math.max(bounds.height, 1))));
  transform = { k: readable, x: 28 - bounds.x * readable, y: Math.max(28, (rect.height - bounds.height * readable) / 2) - bounds.y * readable };
  userMoved = false;
  applyTransform();
}

function zoomAt(factor: number, cx: number, cy: number, animate = false): void {
  const k = Math.min(8, Math.max(0.04, transform.k * factor));
  const ratio = k / transform.k;
  const target = { k, x: cx - (cx - transform.x) * ratio, y: cy - (cy - transform.y) * ratio };
  userMoved = true;
  animateTo(target, animate);
}

function zoomCenter(factor: number): void {
  const rect = stage.getBoundingClientRect();
  zoomAt(factor, rect.width / 2, rect.height / 2, true);
}

function actualSize(): void {
  const rect = stage.getBoundingClientRect();
  const cx = (rect.width / 2 - transform.x) / transform.k;
  const cy = (rect.height / 2 - transform.y) / transform.k;
  animateTo({ k: 1, x: rect.width / 2 - cx, y: rect.height / 2 - cy });
  userMoved = true;
}

/** Bring a box into view, zooming in only as far as is comfortable. */
function focusBox(box: { x: number; y: number; width: number; height: number }, minScale = 0.85): void {
  const rect = stage.getBoundingClientRect();
  const k = Math.min(Math.max(transform.k, minScale), (rect.width - 120) / Math.max(box.width, 1), (rect.height - 120) / Math.max(box.height, 1), 2);
  animateTo({ k, x: rect.width / 2 - (box.x + box.width / 2) * k, y: rect.height / 2 - (box.y + box.height / 2) * k });
  userMoved = true;
}

function updateMinimap(): void {
  const rect = stage.getBoundingClientRect();
  const bounds = contentBounds();
  const visible = { x: -transform.x / transform.k, y: -transform.y / transform.k, width: rect.width / transform.k, height: rect.height / transform.k };
  // Only useful while something drawn is off screen: the layout's own margin (28) and a little more may be.
  // Not over the little network left beside an open state machine either: it would cover the boxes the machine is about.
  const slack = 28 + 24 / transform.k;
  minimapBox.hidden = view === EMPTY_VIEW || (!dock.hidden && dock.classList.contains('machine-open') && !dock.classList.contains('collapsed')) || (visible.x <= bounds.x + slack && visible.y <= bounds.y + slack && visible.x + visible.width >= bounds.x + bounds.width - slack && visible.y + visible.height >= bounds.y + bounds.height - slack);
  minimapFrame.setAttribute('x', String(-transform.x / transform.k));
  minimapFrame.setAttribute('y', String(-transform.y / transform.k));
  minimapFrame.setAttribute('width', String(rect.width / transform.k));
  minimapFrame.setAttribute('height', String(rect.height / transform.k));
}

let drag: { x: number; y: number; tx: number; ty: number; moved: boolean; pointer: number } | undefined;

stage.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 && event.pointerType === 'mouse') return;
  drag = { x: event.clientX, y: event.clientY, tx: transform.x, ty: transform.y, moved: false, pointer: event.pointerId };
});

stage.addEventListener('pointermove', (event) => {
  if (!drag || drag.pointer !== event.pointerId) return;
  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  if (!drag.moved) {
    drag.moved = true;
    stage.setPointerCapture(event.pointerId);
    stage.classList.add('dragging');
  }
  transform = { ...transform, x: drag.tx + dx, y: drag.ty + dy };
  userMoved = true;
  applyTransform();
});

function endDrag(event: PointerEvent): void {
  if (!drag || drag.pointer !== event.pointerId) return;
  const moved = drag.moved;
  drag = undefined;
  stage.classList.remove('dragging');
  if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
  if (!moved) handleClick(event.target as Element | null);
}

stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', (event) => {
  drag = undefined;
  stage.classList.remove('dragging');
  if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
});

stage.addEventListener('wheel', (event) => {
  event.preventDefault();
  const rect = stage.getBoundingClientRect();
  const cx = event.clientX - rect.left;
  const cy = event.clientY - rect.top;
  // Pinch arrives as ctrl+wheel; a trackpad scroll has fine or sideways deltas; a mouse wheel zooms.
  const trackpadPan = !event.ctrlKey && event.deltaMode === 0 && (event.deltaX !== 0 || Math.abs(event.deltaY) < 40);
  if (trackpadPan) {
    transform = { ...transform, x: transform.x - event.deltaX, y: transform.y - event.deltaY };
    userMoved = true;
    applyTransform();
    return;
  }
  const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
  zoomAt(Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0018)), cx, cy);
}, { passive: false });

let minimapDrag = false;
function minimapNavigate(event: PointerEvent): void {
  const point = minimap.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const matrix = minimap.getScreenCTM();
  if (!matrix) return;
  const at = point.matrixTransform(matrix.inverse());
  const rect = stage.getBoundingClientRect();
  transform = { ...transform, x: rect.width / 2 - at.x * transform.k, y: rect.height / 2 - at.y * transform.k };
  userMoved = true;
  applyTransform();
}
minimapBox.addEventListener('pointerdown', (event) => {
  minimapDrag = true;
  minimapBox.setPointerCapture(event.pointerId);
  minimapNavigate(event);
  event.stopPropagation();
});
minimapBox.addEventListener('pointermove', (event) => {
  if (minimapDrag) minimapNavigate(event);
});
minimapBox.addEventListener('pointerup', (event) => {
  minimapDrag = false;
  if (minimapBox.hasPointerCapture(event.pointerId)) minimapBox.releasePointerCapture(event.pointerId);
});

new ResizeObserver(() => {
  if (!userMoved && view && !view.pending) openingView();
  else updateMinimap();
}).observe(stage);

// ---------------------------------------------------------------------------
// Selection, hover and search
// ---------------------------------------------------------------------------

function handleClick(target: Element | null): void {
  // A reason pill: replay to the step where the partner it names last acted (finished, or moved on).
  const reason = target?.closest<SVGGElement>('.pj-ov-reason-wrap[data-partner]');
  if (reason && overlay) {
    const partner = reason.dataset.partner!;
    let last = -1;
    overlay.steps.forEach((step, index) => {
      if (step.participants.some((participant) => participant.node === partner)) last = index;
    });
    if (last >= 0) {
      stopPlaying();
      setCursor(last + 1, false);
      showToast(`Step ${last + 1}: the last thing ${processName(partner)} did`);
      return;
    }
  }
  const element = target?.closest<SVGElement>('[data-id], [data-for]');
  if (!element || !graph.contains(element)) {
    if (target && graph.contains(target)) return;
    select(undefined);
    return;
  }
  const id = element.dataset.id ?? element.dataset.for!;
  if (nodeById.has(id)) {
    const node = nodeById.get(id)!;
    if ((node.kind === 'junction' || node.kind === 'barrier' || node.kind === 'stub') && node.channel) select({ type: 'channel', id: node.channel });
    else select({ type: 'node', id });
  } else if (edgeById.has(id)) select({ type: 'channel', id: edgeById.get(id)!.channel });
}

const narrow = window.matchMedia('(max-width: 900px)');

/** In a narrow window the details panel is a drawer over the network. */
function setDrawer(open: boolean): void {
  document.body.classList.toggle('panel-open', open);
  $('details-button').setAttribute('aria-expanded', String(open));
}

function select(next: typeof selection, reveal = false, drawer = true): void {
  selection = next;
  applySelection();
  renderPanel();
  if (next && narrow.matches && drawer) setDrawer(true);
  if (selection?.type === 'node') {
    const node = nodeById.get(selection.id);
    if (node && reveal) focusBox(node);
    scrollCodeToNode(selection.id);
  }
}

function applySelection(): void {
  for (const element of graph.querySelectorAll('.pj-selected')) element.classList.remove('pj-selected');
  if (selection?.type === 'node') nodeEls.get(selection.id)?.classList.add('pj-selected');
  else if (selection) {
    const channel = channelById.get(selection.id);
    for (const edge of view.edges) if (edge.channel === selection.id) edgeEls.get(edge.id)?.classList.add('pj-selected');
    if (channel) for (const node of view.nodes) if (node.channel === channel.id) nodeEls.get(node.id)?.classList.add('pj-selected');
  }
  drawMarks();
}

/**
 * Selection and search outlines, drawn above the result so a stuck box that is
 * selected or matched still shows it.
 */
function drawMarks(): void {
  marks.replaceChildren();
  const outline = (node: VNode, cls: string): void => {
    marks.append(svg('rect', { class: cls, x: node.x - 3, y: node.y - 3, width: node.width + 6, height: node.height + 6, rx: node.kind === 'group' ? 15 : 11 }));
  };
  for (const id of searchMatches) {
    const node = nodeById.get(id);
    if (node && node.kind !== 'junction') outline(node, 'pj-mark-match');
  }
  if (selection?.type === 'node') {
    const node = nodeById.get(selection.id);
    if (node) outline(node, 'pj-mark-selected');
    // The result's badges on the box stay readable above the outline.
    for (const badge of layer('over')?.querySelectorAll(`.pj-ov-badge-wrap[data-node="${CSS.escape(selection.id)}"]`) ?? []) marks.append(badge.cloneNode(true));
  }
}

function setHover(id: string | undefined): void {
  for (const element of graph.querySelectorAll('.pj-hl')) element.classList.remove('pj-hl');
  hoverOverlay(undefined);
  if (!id) {
    canvas.classList.remove('pj-hovering');
    return;
  }
  const edges = incident.get(id);
  if (!edges?.size) {
    canvas.classList.remove('pj-hovering');
    return;
  }
  canvas.classList.add('pj-hovering');
  const keep = new Set<string>([id]);
  for (const edgeId of edges) {
    const edge = edgeById.get(edgeId);
    edgeEls.get(edgeId)?.classList.add('pj-hl');
    graph.querySelector(`[data-for="${CSS.escape(edgeId)}"]`)?.classList.add('pj-hl');
    if (edge) {
      keep.add(edge.from);
      keep.add(edge.to);
    }
  }
  for (const nodeId of keep) {
    nodeEls.get(nodeId)?.classList.add('pj-hl');
    graph.querySelector(`[data-for="${CSS.escape(nodeId)}"]`)?.classList.add('pj-hl');
    // Everything drawn inside a highlighted container stays visible.
    for (const node of view.nodes) if (isInside(nodeId, node.id)) {
      nodeEls.get(node.id)?.classList.add('pj-hl');
      keep.add(node.id);
    }
  }
  hoverOverlay({ nodes: keep, edges });
}

/** The result's marks follow the hover: those about the hovered box and its arrows stay, the rest dim. */
function hoverOverlay(keep: { nodes: ReadonlySet<string>; edges: ReadonlySet<string> } | undefined): void {
  for (const element of graph.querySelectorAll<SVGElement>('.pj-overlay-under [data-node], .pj-overlay-under [data-edge], .pj-overlay-over [data-node], .pj-overlay-over [data-edge]')) {
    const lit = !keep || (element.dataset.node !== undefined && keep.nodes.has(element.dataset.node)) || (element.dataset.edge !== undefined && keep.edges.has(element.dataset.edge));
    element.classList.toggle('pj-ov-dim', !lit);
  }
}

function isInside(outer: string, inner: string): boolean {
  for (let node = nodeById.get(inner)?.parent; node; node = nodeById.get(node)?.parent) if (node === outer) return true;
  return false;
}

graph.addEventListener('pointerover', (event) => {
  if (drag?.moved) return;
  const element = (event.target as Element).closest<SVGElement>('.pj-node[data-id]');
  const node = element ? nodeById.get(element.dataset.id!) : undefined;
  setHover(node && node.kind !== 'group' ? node.id : undefined);
});
graph.addEventListener('pointerleave', () => setHover(undefined));
graph.addEventListener('dblclick', (event) => {
  const element = (event.target as Element).closest<SVGElement>('.pj-node[data-id]');
  const node = element ? nodeById.get(element.dataset.id!) : undefined;
  if (node?.machine) openMachine(node.id);
});
graph.addEventListener('focusin', (event) => {
  const element = (event.target as Element).closest<SVGElement>('.pj-node[data-id]');
  if (element) setHover(element.dataset.id);
});
graph.addEventListener('keydown', (event) => {
  const element = (event.target as Element).closest<SVGElement>('.pj-node[data-id]');
  if (!element || (event.key !== 'Enter' && event.key !== ' ')) return;
  event.preventDefault();
  handleClick(element);
  const node = nodeById.get(element.dataset.id!);
  if (node) focusBox(node);
});

function applySearch(reveal: boolean): void {
  for (const element of graph.querySelectorAll('.pj-match')) element.classList.remove('pj-match');
  const query = searchInput.value.trim().toLowerCase();
  searchMatches = [];
  if (!query) {
    searchCount.textContent = '';
    canvas.classList.remove('pj-searching');
    drawMarks();
    return;
  }
  canvas.classList.add('pj-searching');
  for (const node of view.nodes) {
    const text = `${node.label} ${node.name} ${node.detail ?? ''} ${node.call?.procedure ?? ''}`.toLowerCase();
    if (node.kind !== 'group' && node.kind !== 'junction' && text.includes(query)) searchMatches.push(node.id);
    else if (node.kind === 'group' && `${node.label} ${node.name}`.toLowerCase().includes(query)) searchMatches.push(node.id);
  }
  for (const channel of view.channels) {
    if (!channel.name.toLowerCase().includes(query)) continue;
    for (const edge of view.edges) if (edge.channel === channel.id) {
      edgeEls.get(edge.id)?.classList.add('pj-match');
      graph.querySelector(`[data-for="${CSS.escape(edge.id)}"]`)?.classList.add('pj-match');
    }
    for (const node of view.nodes) if (node.channel === channel.id) searchMatches.push(node.id);
  }
  for (const id of searchMatches) nodeEls.get(id)?.classList.add('pj-match');
  drawMarks();
  const channelHits = view.channels.filter((channel) => channel.name.toLowerCase().includes(query)).length;
  searchCount.textContent = searchMatches.length || channelHits ? `${plural(searchMatches.length, 'box')}${channelHits ? `, ${plural(channelHits, 'channel')}` : ''}` : 'no match';
  if (reveal && searchMatches.length) {
    searchIndex = -1;
    revealMatches();
  }
}

function revealMatches(): void {
  const boxes = searchMatches.map((id) => nodeById.get(id)).filter((node): node is VNode => !!node);
  if (!boxes.length) return;
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  fit(true, { x: x - 40, y: y - 40, width: right - x + 80, height: bottom - y + 80 });
  userMoved = true;
}

function nextMatch(direction: number): void {
  if (!searchMatches.length) return;
  searchIndex = (searchIndex + direction + searchMatches.length) % searchMatches.length;
  const id = searchMatches[searchIndex];
  const node = nodeById.get(id);
  if (!node) return;
  if (node.kind === 'junction' && node.channel) select({ type: 'channel', id: node.channel });
  else select({ type: 'node', id });
  focusBox(node);
  searchCount.textContent = `${searchIndex + 1} of ${searchMatches.length}`;
}

// ---------------------------------------------------------------------------
// Side panel
// ---------------------------------------------------------------------------

function sourceLink(loc: Loc | undefined, text?: string): HTMLElement {
  if (!loc) return h('span', { class: 'muted' }, 'no source');
  const label = `${fileName(loc.uri)}:${loc.line + 1}`;
  const link = h('button', { class: 'link', type: 'button', title: MODE === 'file' ? 'Copy the location' : 'Open in the editor' }, text ?? label);
  link.addEventListener('click', () => openSource(loc));
  return link;
}

function openSource(loc: Loc): void {
  if (vscode) {
    vscode.postMessage({ type: 'open', uri: loc.uri, line: loc.line, col: loc.col });
    return;
  }
  if (MODE === 'live') {
    void fetch(`${LIVE_BASE}reveal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(loc) })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        showToast(`Opened ${fileName(loc.uri)}:${loc.line + 1} in the editor`);
      })
      .catch(() => copyLocation(loc));
    return;
  }
  copyLocation(loc);
}

function copyLocation(loc: Loc): void {
  let path = loc.uri;
  try {
    path = decodeURIComponent(new URL(loc.uri).pathname);
    // file:///C:/x.pj is C:/x.pj on Windows.
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  } catch {
    /* not a URL: keep it */
  }
  const text = `${path}:${loc.line + 1}:${loc.col + 1}`;
  const done = (): void => showToast(`Copied ${text}`);
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => showToast(text));
  else showToast(text);
}

function section(title: string, ...children: Array<Node | string | undefined>): HTMLElement {
  return h('section', { class: 'panel-section' }, h('h2', {}, title), ...children);
}

function list(items: Array<Node | string>): HTMLElement {
  return h('ul', {}, ...items.map((item) => h('li', {}, item)));
}

function processName(id: string): string {
  const node = nodeById.get(id);
  return node ? node.name : id;
}

function nodeButton(id: string): HTMLElement {
  const node = nodeById.get(id);
  const button = h('button', { class: 'link', type: 'button' }, node ? (node.kind === 'port' ? `port ${node.label}` : node.name) : id);
  button.addEventListener('click', () => {
    if (!node) return;
    select({ type: 'node', id }, true);
  });
  return button;
}

function renderPanel(pending?: VView): void {
  panel.replaceChildren();
  if (pending) {
    const note = MODE === 'file' && !vscode ? 'This view is not included in this file. Open the graph from your editor to see it.' : 'Laying it out…';
    panel.append(section(pending.label, h('p', { class: 'muted' }, note), sourceLink(pending.source)));
    if (active) panel.append(...verdictSection());
    return;
  }
  if (overlay || (active && !overlay)) panel.append(...verdictSection());
  if (selection?.type === 'node') panel.append(...nodeDetails(selection.id));
  else if (selection?.type === 'channel') panel.append(...channelDetails(selection.id));
  else if (!active) panel.append(...viewSummary());
}

function verdictSection(): HTMLElement[] {
  const chip = active ? payload.chips.find((entry) => entry.report === active!.report && entry.check === active!.check) : undefined;
  if (!chip) return [];
  const report = payload.reports[chip.report];
  const out: HTMLElement[] = [];
  const by = chip.producer === 'fdr' ? `FDR${report?.tool?.version ? ` ${report.tool.version}` : ''}` : 'static analysis';
  const stats = chip.stats ? [chip.stats.states !== undefined ? `${chip.stats.states.toLocaleString()} state${chip.stats.states === 1 ? '' : 's'}` : '', chip.stats.ms !== undefined ? `${chip.stats.ms} ms` : ''].filter(Boolean).join(', ') : '';
  const head = h('div', { class: `verdict-head ${chip.status} sev-${chip.severity}${chip.limits?.length ? ' limited' : ''}` }, h('strong', {}, chip.targetLabel ? `${chip.label} (${chip.targetLabel})` : chip.label), h('span', { class: 'verdict-status' }, chip.text));
  out.push(section('Result', head, h('div', { class: 'muted' }, `${by}${stats ? ` · ${stats}` : ''}`), chip.stale ? h('p', { class: 'warn' }, 'The file changed after this result was computed: positions may be off. Run the check again.') : undefined, overlay?.relocated ? h('p', { class: 'muted' }, `Shown on ${overlay.relocated}.`) : undefined));
  // What the run relies on that the real program may not do: said before the run itself.
  const caveats = overlay?.caveats ?? chip.caveats ?? [];
  if (caveats.length) out.push(h('section', { class: 'panel-section caveats' }, h('h2', {}, 'What this run relies on'), h('p', {}, 'The real program may not do this:'), list(caveats.map((caveat) => `${caveat}.`))));
  if (overlay) {
    const ending = endPosition() > 0 && cursor < endPosition();
    out.push(section(ending ? 'How it ends' : 'What happens', h('div', { class: `story sev-${overlay.severity}` }, ...overlay.story.map((sentence) => h('p', {}, sentence)))));
    if (overlay.unplaced.length) out.push(section('Not drawn in this view', list(overlay.unplaced)));
  } else {
    const views = chip.views.map((id) => payload.views.find((entry) => entry.id === id)?.label).filter((label): label is string => !!label);
    const tool = chip.producer === 'fdr' ? 'FDR' : 'The checker';
    // Only a failure has something to draw; say what each other outcome means.
    const where = chip.status === 'passed' ? `${tool} found no counterexample: nothing to draw.`
      : chip.status === 'timeout' ? `${tool} did not finish within its time limit: no counterexample, and no proof either.`
        : chip.status === 'error' ? `${tool} could not run this check: no counterexample.`
          : chip.status === 'cancelled' ? 'The check was cancelled before it finished: no counterexample.'
            : chip.status === 'skipped' ? 'The check was skipped: no counterexample.'
              : views.length ? `This result is shown in: ${views.join(', ')}.` : 'This result names nothing drawn in any view.';
    out.push(section('Where', h('p', {}, where)));
    const counterexample = report?.checks.find((check) => check.id === chip.check)?.counterexample;
    if (counterexample) out.push(section('Summary', h('p', {}, counterexample.summary)));
  }
  // A proof that does not cover everything says what it leaves out, as a warning. A failure's message is its
  // summary, which the dock already says.
  const summary = report?.checks.find((check) => check.id === chip.check)?.counterexample?.summary;
  if (chip.message && chip.message !== summary) out.push(section(chip.limits?.length ? 'What this does not cover' : 'Note', h('p', { class: chip.limits?.length ? 'warn' : '' }, chip.message)));
  if (report?.assumptions.length) {
    const details = h('details', {}, h('summary', {}, `How this was checked (${plural(report.assumptions.length, 'assumption')})`), list(report.assumptions));
    out.push(h('section', { class: 'panel-section' }, details));
  }
  const assertion = report?.checks.find((check) => check.id === chip.check)?.assertion;
  if (assertion) out.push(section('Assertion', h('pre', { class: 'assertion' }, assertion)));
  return out;
}

function nodeDetails(id: string): HTMLElement[] {
  const node = nodeById.get(id);
  if (!node) return [];
  const out: HTMLElement[] = [];
  const kind = node.kind === 'group' ? node.isProcess ? 'process running a network' : 'container' : node.kind;
  const rows: Array<[string, Node | string]> = [['kind', kind]];
  if (node.badge) rows.push(['role', node.badge]);
  if (node.replicated) rows.push(['instances', node.replicated.replace('×', '')]);
  rows.push(['source', sourceLink(node.source)]);
  if (node.call) {
    rows.push(['runs', h('span', {}, node.call.procedure, node.call.declaration ? ' · ' : '', node.call.declaration ? sourceLink(node.call.declaration, 'declaration') : '')]);
    if (node.call.params.length) rows.push(['parameters', node.call.params.join(', ')]);
    if (node.call.collapsed) rows.push(['network', node.call.collapsed === 'recursion' ? 'recursive: drawn once' : node.call.collapsed === 'unavailable' ? 'declared in a file not analysed here' : 'not expanded here (open its view)']);
  }
  rows.push(['certainty', node.confidence]);
  out.push(section(node.label, table(rows)));
  // What it communicates, per channel.
  const byChannel = new Map<string, VNode['operations']>();
  for (const operation of node.operations) {
    const list = byChannel.get(operation.channel);
    if (list) list.push(operation);
    else byChannel.set(operation.channel, [operation]);
  }
  if (byChannel.size) {
    const items: HTMLElement[] = [];
    for (const [channelId, operations] of byChannel) {
      const channel = channelById.get(channelId);
      const kinds = [...new Set(operations.map((operation) => operation.kind))].join(', ');
      const peers = channel ? (operations.some((operation) => operation.kind === 'write') ? channel.readers : channel.kind === 'barrier' ? channel.members : channel.writers).filter((peer) => peer !== id) : [];
      const channelButton = h('button', { class: 'link', type: 'button' }, channel ? `${channel.name}` : channelId);
      channelButton.addEventListener('click', () => select({ type: 'channel', id: channelId }));
      const lines = operations.map((operation) => {
        const link = sourceLink(operation.at, `${fileName(operation.at.uri) === fileName(payload.uri) ? '' : `${fileName(operation.at.uri)}:`}${operation.at.line + 1}`);
        return h('span', { class: `op op-${operation.confidence}` }, link, operation.via ? h('span', { class: 'muted' }, ` in ${operation.via}`) : '', operation.confidence === 'exact' ? '' : h('span', { class: 'muted' }, ` (${operation.confidence})`));
      });
      items.push(h('li', {}, channelButton, h('span', { class: 'muted' }, ` ${kinds}`), peers.length ? h('span', {}, ' with ', ...peers.flatMap((peer, index) => [index ? ', ' : '', nodeButton(peer)])) : '', h('div', { class: 'ops' }, ...lines.flatMap((line, index) => [index ? ' ' : '', line]))));
    }
    out.push(section('Communicates', h('ul', {}, ...items)));
  }
  if (node.facts.length) out.push(section('Facts', list(node.facts)));
  const state = overlay?.processes.filter((entry) => entry.node === id) ?? [];
  if (state.length) out.push(section('In this result', list(state.map((entry) => `${entry.label}: ${entry.description}${entry.exact ? '' : ' (drawn through this box)'}`))));
  if (node.machine) {
    const open = h('button', { class: 'action', type: 'button', title: 'Its states in the CSP model (double-click the box)' }, 'State machine');
    open.addEventListener('click', () => openMachine(id));
    const traced = state.some((entry) => entry.trail?.length);
    out.push(section('Behaviour', h('p', { class: 'muted' }, traced ? 'Its states in the model FDR checked, with the ones this run went through, in order.' : 'Its states in the CSP model: one per place it can wait.'), open));
  }
  return out;
}

function channelDetails(id: string): HTMLElement[] {
  const channel = channelById.get(id);
  if (!channel) return [];
  const people = (ids: string[]): HTMLElement => ids.length ? h('div', {}, ...ids.flatMap((peer, index) => [index ? ', ' : '', nodeButton(peer)])) : h('span', { class: 'muted' }, 'none drawn');
  if (isCspm()) {
    // Events, not channels: who must take part in them together, and in which direction data flows.
    const rows: Array<[string, Node | string]> = [['events', channel.name]];
    if (channel.port) rows.push(['other side', 'the environment (no process of this network)']);
    const out = [section(channel.kind === 'barrier' ? `events ${channel.name}` : channel.name, table(rows))];
    if (channel.members.length) out.push(section(channel.kind === 'barrier' ? 'All take part together' : 'Synchronise on them', people(channel.members)));
    if (channel.writers.length || channel.readers.length) out.push(section('Outputs (!)', people(channel.writers)), section('Inputs (?)', people(channel.readers)));
    return out;
  }
  const rows: Array<[string, Node | string]> = [['kind', channel.kind], ['carries', channel.kind === 'barrier' ? '—' : channel.type], ['declared', sourceLink(channel.declaration)]];
  if (channel.shared.read || channel.shared.write) rows.push(['shared', [channel.shared.read ? 'readers' : '', channel.shared.write ? 'writers' : ''].filter(Boolean).join(' and ')]);
  if (channel.port) rows.push(['boundary', 'a parameter of this procedure']);
  if (channel.hazard) rows.push(['proven hazard', channel.hazard.replace('-', ' ')]);
  const out = [section(`${channel.kind} ${channel.name}`, table(rows))];
  if (channel.kind === 'barrier') {
    out.push(section('Enrolled', people(channel.members.filter((member) => !channel.unenrolled.includes(member)))));
    // The runtime counts enrolled processes: a sync by any other process does not wait for them as written.
    if (channel.unenrolled.length) out.push(section('Syncs without being enrolled', people(channel.unenrolled), h('p', { class: 'warn' }, 'The barrier counts only enrolled processes, so these syncs do not wait for the enrolled ones as the code suggests (with nothing enrolled, each returns at once).')));
  } else out.push(section('Writers', people(channel.writers)), section('Readers', people(channel.readers)));
  return out;
}

function viewSummary(): HTMLElement[] {
  if (view === EMPTY_VIEW) return [section('No network yet', h('p', { class: 'muted' }, isCspm() ? 'This file defines no process. The page follows the buffer: the network appears as soon as it does.' : 'This file has no procedure with a body. The page follows the buffer: the network appears as soon as there is one.'))];
  const channels = view.channels.filter((channel) => channel.kind === 'channel' && (channel.writers.length || channel.readers.length)).length;
  const barriers = view.channels.filter((channel) => channel.kind === 'barrier').length;
  // Processes, not boxes: a par for box stands for each of its iterations.
  const counted = isCspm() ? `${plural(new Set(view.edges.map((edge) => edge.channel)).size, 'link')} between them` : `${plural(channels, 'channel')}${barriers ? `, ${plural(barriers, 'barrier')}` : ''}`;
  const out = [section(view.label, h('p', {}, `${view.processes || 'no processes'}, ${counted}.`), h('p', { class: 'muted' }, 'Click a box or an arrow for details; drag to pan, scroll or pinch to zoom, 0 fits, / searches.'), sourceLink(view.source))];
  const pending = payload.views.filter((entry) => entry.pending).length;
  const noun = isCspm() ? 'process view' : 'procedure view';
  const pendingNote = pending ? (MODE === 'file' && !vscode ? `${plural(pending, noun)} ${pending === 1 ? 'is' : 'are'} not included in this file; open the graph from your editor to see ${pending === 1 ? 'it' : 'them'}.` : `${plural(pending, noun)} ${pending === 1 ? 'is' : 'are'} laid out when first opened.`) : undefined;
  const notes = [...payload.notes, ...(pendingNote ? [pendingNote] : []), ...view.notes];
  if (notes.length) out.push(section('Notes', list(notes)));
  if (payload.related) {
    const related = payload.related;
    const parts: Array<Node | string> = [h('p', {}, related.note), sourceLink({ uri: related.uri, line: 0, col: 0 }, related.label)];
    if (related.graph) parts.push(' · ', h('a', { href: related.graph, target: '_blank', rel: 'noopener' }, 'its ProcessJ graph'));
    out.push(section('Generated from', ...parts));
  }
  if (!payload.chips.length) out.push(section('Verification', h('p', { class: 'muted' }, isCspm() ? "No FDR result yet. Check with FDR (:ProcessJFdr in Neovim) runs this file's own assertions and shows each result here." : 'No verification results yet. The checker found nothing it can prove stuck; that is not a proof of deadlock freedom.')));
  return out;
}

function table(rows: Array<[string, Node | string]>): HTMLElement {
  return h('dl', { class: 'facts' }, ...rows.flatMap(([key, value]) => [h('dt', {}, key), h('dd', {}, value)]));
}

// ---------------------------------------------------------------------------
// Verdict strip
// ---------------------------------------------------------------------------

function renderVerdicts(): void {
  verdicts.replaceChildren();
  if (!payload.chips.length) {
    verdicts.append(h('span', { class: 'verdict-empty' }, isCspm() ? 'No FDR result yet: check this file with FDR to see its assertions here.' : 'Static analysis: nothing proven stuck (not a proof of deadlock freedom).'));
    return;
  }
  for (const chip of payload.chips) {
    const by = chip.producer === 'fdr' ? 'FDR' : 'static';
    const stats = chip.stats?.states !== undefined ? ` · ${chip.stats.states.toLocaleString()} state${chip.stats.states === 1 ? '' : 's'}` : '';
    const time = chip.stats?.ms !== undefined ? ` · ${chip.stats.ms < 1000 ? `${chip.stats.ms} ms` : `${(chip.stats.ms / 1000).toFixed(1)} s`}` : '';
    const icon = chip.status === 'passed' ? '✓' : chip.status === 'failed' ? (chip.severity === 'info' ? 'ℹ' : '✕') : chip.status === 'timeout' ? '⏱' : '!';
    // The producer's own words in the tooltip: what a proof does not cover, what a run relies on.
    const note = chip.message && chip.message !== chip.text ? `\n${chip.message}` : '';
    const relies = chip.caveats?.length ? `\nRelies on: ${chip.caveats.join('; ')}` : '';
    const button = h('button', {
      class: `chip ${chip.status} sev-${chip.severity}${chip.stale ? ' stale' : ''}${chip.limits?.length ? ' limited' : ''}${chip.caveats?.length ? ' caveated' : ''}${active && active.report === chip.report && active.check === chip.check ? ' active' : ''}`,
      type: 'button',
      title: `${chip.targetLabel ? `${chip.targetLabel}: ` : ''}${chip.label}: ${chip.text} (${by}${stats}${time})${chip.stale ? ' — stale' : ''}${note}${relies}`,
      'aria-pressed': String(!!active && active.report === chip.report && active.check === chip.check),
    }, h('span', { class: 'chip-icon' }, icon), chip.targetLabel ? h('span', { class: 'chip-target' }, chip.targetLabel) : undefined, h('span', { class: 'chip-label' }, chip.label), h('span', { class: 'chip-text' }, chip.text), h('span', { class: 'chip-by' }, `${by}${stats}${time}${chip.stale ? ' · stale' : ''}`));
    // A passed check with nothing to draw still has its note to read (what it covers).
    button.disabled = !chip.views.length && chip.status === 'passed' && !chip.message;
    button.addEventListener('click', () => {
      if (active && active.report === chip.report && active.check === chip.check) activate(undefined);
      else activate({ report: chip.report, check: chip.check });
    });
    verdicts.append(button);
  }
}

function activate(next: typeof active): void {
  stopPlaying();
  active = next;
  colors = new Map();
  if (!active) {
    overlay = undefined;
    renderVerdicts();
    refreshMachineRequest();
    renderOverlayState(false);
    renderDock();
    renderPanel();
    return;
  }
  const chip = payload.chips.find((entry) => entry.report === active!.report && entry.check === active!.check);
  // The view the result is about (a procedure checked on its own opens on its own view), even when
  // the current view also places it: placed on a call, a result about one procedure can mislead.
  if (chip?.preferredView && chip.preferredView !== view.id) showView(chip.preferredView, { fit: true });
  overlay = payload.overlays.find((entry) => entry.view === view.id && entry.report === active!.report && entry.check === active!.check);
  cursor = endPosition();
  if (overlay) {
    // A colour per process, in order of appearance.
    for (const step of overlay.steps) for (const participant of step.participants) if (participant.node && !colors.has(participant.node)) colors.set(participant.node, PALETTE[colors.size % PALETTE.length]);
    for (const process of overlay.processes) if (!colors.has(process.node)) colors.set(process.node, PALETTE[colors.size % PALETTE.length]);
  }
  selection = undefined;
  applySelection();
  renderVerdicts();
  refreshMachineRequest();
  renderOverlayState(false);
  renderDock();
  renderPanel();
  if (overlay) frameResult(overlay);
}

/**
 * Bring a result into view: all of the view when that is readable, else what
 * explains it: the processes stuck for good (or in a circle), the arrows they
 * wait on and the other ends of those (partners, stubs, ports, junctions), and
 * the words drawn for them. The rest waits behind those, and the minimap shows it.
 */
function frameResult(result: Overlay): void {
  const rect = stage.getBoundingClientRect();
  const bounds = contentBounds();
  const fitScale = Math.min((rect.width - 56) / Math.max(bounds.width, 1), (rect.height - 56) / Math.max(bounds.height, 1));
  if (fitScale >= 0.6) {
    fit(true);
    return;
  }
  const roots = result.processes.filter((entry) => entry.cause === 'root' || entry.status === 'error');
  const key = new Set((roots.length ? roots : result.processes).map((entry) => entry.node));
  for (const cycle of result.cycles) for (const id of cycle.nodes) key.add(id);
  const waits = result.waits.filter((wait) => key.has(wait.node));
  const ids = new Set<string>([...key, ...waits.flatMap((wait) => (wait.partnerNode ? [wait.partnerNode] : []))]);
  if (result.error?.node) ids.add(result.error.node);
  const boxes: Array<{ x: number; y: number; width: number; height: number }> = [];
  for (const wait of waits) {
    const edge = wait.edge ? edgeById.get(wait.edge) : undefined;
    if (!edge) continue;
    ids.add(edge.from);
    ids.add(edge.to);
    const path = edgeEls.get(edge.id)?.querySelector<SVGPathElement>('path');
    if (path) boxes.push(path.getBBox());
  }
  for (const id of ids) {
    const node = nodeById.get(id);
    if (node) boxes.push(node);
  }
  // The badges, pills and callouts drawn for those processes (and the result's own notes).
  for (const element of layer('over')?.querySelectorAll<SVGGraphicsElement>('.pj-ov-badge-wrap, .pj-ov-reason-wrap, .pj-ov-callout-wrap') ?? []) {
    if (element.dataset.node === undefined || ids.has(element.dataset.node)) boxes.push(element.getBBox());
  }
  if (!boxes.length) return;
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  focusBox({ x: x - 40, y: y - 40, width: right - x + 80, height: bottom - y + 80 }, 0.6);
}

// ---------------------------------------------------------------------------
// The overlay at the timeline cursor
// ---------------------------------------------------------------------------

/**
 * Timeline positions: 0 is the start, k is just after step k (1..n), then
 * one position per step of how the run locked up (n+1..n+f), and the end
 * state has a position of its own after those (0 when there is nothing
 * before it), so the last step can be shown before the end state.
 */
function endPosition(): number {
  return overlay && (overlay.steps.length || formation().length) ? overlay.steps.length + formation().length + 1 : 0;
}

/** How the shown result locked up, step by step after its trace (none for any other result). */
function formation(): FormationStep[] {
  return overlay?.formation ?? [];
}

/** The step of how it locked up at the cursor, when the cursor is past the trace and before the end state. */
function formationAt(): number | undefined {
  if (!overlay) return undefined;
  const index = cursor - overlay.steps.length - 1;
  return index >= 0 && index < formation().length ? index : undefined;
}

/** The processes (pathKey) stuck by formation step `index`, and their boxes. */
function stuckBy(index: number): { keys: Set<string>; nodes: Set<string> } {
  const shown = formation().slice(0, index + 1).filter((step) => step.kind === 'stuck');
  return { keys: new Set(shown.flatMap((step) => step.keys)), nodes: new Set(shown.flatMap((step) => step.nodes)) };
}

function layer(name: 'under' | 'over'): SVGGElement | null {
  return graph.querySelector<SVGGElement>(name === 'under' ? '.pj-overlay-under' : '.pj-overlay-over');
}

function renderOverlayState(animateStep: boolean): void {
  const under = layer('under');
  const over = layer('over');
  if (under) under.innerHTML = '';
  if (over) over.innerHTML = '';
  dynamic.replaceChildren();
  overlayText = [];
  canvas.classList.remove('pj-stale-overlay');
  $('stale-banner').hidden = !overlay?.stale;
  // A run that relies on what the model abstracts says so on the canvas too: the panel lists what.
  const caveatBanner = $('caveat-banner');
  caveatBanner.hidden = !overlay?.caveats.length;
  if (overlay?.caveats.length) caveatBanner.textContent = `The real program may not do this: this run relies on ${overlay.caveats.length === 1 ? 'something' : `${overlay.caveats.length} things`} the model abstracts (see What this run relies on).`;
  for (const element of graph.querySelectorAll('.pj-done, .pj-current')) element.classList.remove('pj-done', 'pj-current');
  canvas.classList.toggle('pj-has-overlay', !!overlay);
  if (!overlay) {
    renderCode();
    renderChartCursor();
    drawMachineMarks();
    return;
  }
  const steps = overlay.steps;
  const final = cursor >= endPosition();
  const forming = formationAt();
  canvas.classList.toggle('pj-stale-overlay', overlay.stale);
  overlayText = [];
  if (final || forming !== undefined) {
    if (under) under.innerHTML = overlay.under;
    if (over) over.innerHTML = overlay.over;
    // While it locks up, only what has happened so far: the end state's marks of the processes stuck by now.
    if (forming !== undefined) revealFormation(forming);
    overlayText = [...(over?.querySelectorAll<SVGGElement>('.pj-ov-badge-wrap, .pj-ov-reason-wrap, .pj-ov-callout-wrap') ?? [])];
    measureOverlayText();
    scaleOverlayText();
  }
  const banner = $('formation-banner');
  banner.hidden = forming === undefined;
  if (forming !== undefined) banner.textContent = `How it locked, ${forming + 1} of ${formation().length}: ${formation()[forming].title}`;
  // Who has finished, and where each process last acted, up to the cursor.
  const lines = new Map<string, number>();
  const finished = new Set<string>();
  for (let i = 0; i < Math.min(cursor, steps.length); i++) {
    for (const participant of steps[i].participants) {
      if (!participant.node) continue;
      if (participant.at && participant.at.uri === payload.source?.uri) lines.set(participant.node, participant.at.span.start.line);
      if (steps[i].kind === 'termination') finished.add(participant.node);
    }
  }
  if (!final) for (const node of finished) nodeEls.get(node)?.classList.add('pj-done');
  // A process stuck by now shows the line it is stuck at.
  if (forming !== undefined) {
    const stuck = stuckBy(forming).keys;
    for (const process of overlay.processes) if (stuck.has(process.key) && process.at && process.at.uri === payload.source?.uri) lines.set(process.node, process.at.span.start.line);
  }
  // The end state is told by its badges; line chips follow the replay.
  if (!final) for (const [node, line] of lines) drawLineChip(node, line);
  if (forming !== undefined) drawFormationMarks(formation()[forming], animateStep);
  else if (!final && cursor > 0) {
    const step = steps[cursor - 1];
    for (const participant of step.participants) if (participant.node) {
      const element = nodeEls.get(participant.node);
      element?.classList.add('pj-current');
      if (animateStep && element) flash(element);
    }
    for (const edgeId of step.route) edgeEls.get(edgeId)?.classList.add('pj-current');
    if (animateStep) sendToken(step);
    else drawStepMarks(step);
  }
  renderCode();
  renderChartCursor();
  drawMachineMarks();
  updateStepText();
}

/**
 * The end state's marks as they stand at formation step `index`: a process's
 * outline, badge, stuck arrow, marker and reason once it is stuck; a circle's
 * band and loops link by link as it closes, and its callout once the last step
 * is shown. What has finished, or still runs, shows from the first step.
 */
function revealFormation(index: number): void {
  const steps = formation();
  const shown = steps.slice(0, index + 1);
  const { nodes } = stuckBy(index);
  const waited = new Set(shown.filter((step) => step.kind !== 'cycle').flatMap((step) => step.edges));
  const links = shown.filter((step) => step.kind === 'cycle');
  const closed = new Set(links.flatMap((step) => step.edges));
  const closedFrom = new Set(links.map((step) => step.nodes[0]));
  const complete = index === steps.length - 1 && steps[index].kind !== 'stuck';
  const blocked = new Set(overlay!.processes.filter((process) => process.status === 'blocked').map((process) => process.node));
  for (const element of graph.querySelectorAll<SVGElement>('.pj-overlay-under > *, .pj-overlay-over > *, .pj-overlay-under > .pj-ov-stale > *, .pj-overlay-over > .pj-ov-stale > *')) {
    if (element.classList.contains('pj-ov-stale')) continue;
    const { node, edge } = element.dataset;
    const keep = element.classList.contains('pj-ov-callout-wrap') ? complete
      : element.classList.contains('pj-ov-cycle-route') ? closed.has(edge ?? '')
        : element.classList.contains('pj-ov-cycle-edge') ? complete || closedFrom.has(node ?? '')
          : element.classList.contains('pj-ov-stuck-edge') ? waited.has(edge ?? '')
            : node === undefined || !blocked.has(node) || nodes.has(node);
    if (!keep) element.remove();
  }
}

/**
 * What formation step `step` is about: its process ringed (a link of a circle:
 * the process that waits), the arrows it adds drawn in from end to end (unless
 * motion is reduced), and the processes it waits for ringed with a dashed
 * line. All under the result's words, so its badges and reasons stay readable.
 */
function drawFormationMarks(step: FormationStep, animate: boolean): void {
  const target = layer('under') ?? dynamic;
  const ring = (id: string, cls: string, pad: number): SVGRectElement | undefined => {
    const node = nodeById.get(id);
    if (!node) return undefined;
    const rect = svg('rect', { class: cls, x: node.x - pad, y: node.y - pad, width: node.width + pad * 2, height: node.height + pad * 2, rx: (node.kind === 'group' ? 13 : 9) + pad });
    target.append(rect);
    return rect;
  };
  for (const id of step.partners) ring(id, 'pj-partner-ring', 7);
  // The arrows this step adds, drawn over the result: its waits, or the link of the circle.
  const paths = step.edges.map((id) => graph.querySelector<SVGPathElement>(`.pj-overlay-under [data-edge="${CSS.escape(id)}"]`) ?? edgeEls.get(id)?.querySelector<SVGPathElement>('path')).filter((path): path is SVGPathElement => !!path);
  if (step.kind === 'cycle' && !paths.length && step.nodes[0]) {
    const curve = graph.querySelector<SVGPathElement>(`.pj-overlay-under .pj-ov-cycle-edge[data-node="${CSS.escape(step.nodes[0])}"]`);
    if (curve) paths.push(curve);
  }
  for (const path of paths) {
    const now = svg('path', { class: `pj-now-edge${step.kind === 'cycle' ? ' pj-now-cycle' : ''}`, d: path.getAttribute('d') ?? '' });
    target.append(now);
    if (!animate || reduceMotion || typeof now.animate !== 'function') continue;
    const length = now.getTotalLength();
    now.style.strokeDasharray = String(length);
    now.animate([{ strokeDashoffset: length }, { strokeDashoffset: 0 }], { duration: Math.min(900, 700 / speed), easing: 'ease-out', fill: 'forwards' });
  }
  for (const id of step.kind === 'cycle' ? step.nodes.slice(0, 1) : step.nodes) {
    const now = ring(id, 'pj-now-ring', 4);
    if (animate && now && !reduceMotion) now.classList.add('pj-now-animate');
  }
  for (const id of step.nodes) nodeEls.get(id)?.classList.add('pj-current');
}

function drawLineChip(nodeId: string, line: number): void {
  const node = nodeById.get(nodeId);
  if (!node) return;
  const text = `L${line + 1}`;
  const width = text.length * 6.6 + 12;
  const x = node.x + 8;
  const y = node.kind === 'group' ? node.y + node.height - 9 : node.y + node.height - 9;
  const group = svg('g', { class: 'pj-line-chip' });
  const color = colors.get(nodeId) ?? PALETTE[0];
  const rect = svg('rect', { x, y, width, height: 18, rx: 9 });
  rect.style.fill = color;
  const label = svg('text', { x: x + 6, y: y + 12.5 });
  label.textContent = text;
  group.append(rect, label);
  group.addEventListener('pointerup', () => scrollCodeTo(line));
  dynamic.append(group);
}

function flash(element: Element): void {
  element.classList.remove('pj-flash');
  // Restart the animation.
  void (element as SVGGraphicsElement).getBBox?.();
  element.classList.add('pj-flash');
  window.setTimeout(() => element.classList.remove('pj-flash'), 950);
}

/** Paths of a step's route, writer to reader. */
function routePaths(step: OverlayStep): SVGPathElement[] {
  return step.route.map((id) => edgeEls.get(id)?.querySelector<SVGPathElement>('path')).filter((path): path is SVGPathElement => !!path);
}

function drawStepMarks(step: OverlayStep): void {
  const paths = routePaths(step);
  if (!paths.length) return;
  // Just delivered: by the reader's arrowhead, beside the line so the arrow's label stays readable.
  const last = paths[paths.length - 1];
  const length = last.getTotalLength();
  const at = Math.max(0, length - 18);
  const point = last.getPointAtLength(at);
  const before = last.getPointAtLength(Math.max(0, at - 4));
  // Above a horizontal arrow, to the left of a vertical one.
  const side = Math.abs(point.x - before.x) >= Math.abs(point.y - before.y) ? { x: 0, y: -1 } : { x: -1, y: 0 };
  drawToken(point.x + side.x * 22, point.y + side.y * 22, step);
}

function drawToken(x: number, y: number, step: OverlayStep): SVGGElement {
  const value = step.value ?? '';
  const width = Math.max(20, value.length * 6.9 + 14);
  const token = svg('g', { class: `pj-token${step.visible ? '' : ' pj-token-hidden'}`, transform: `translate(${x} ${y})` });
  token.append(svg('rect', { x: -width / 2, y: -11, width, height: 22, rx: 11 }));
  const label = svg('text', { x: 0, y: 4.5, 'text-anchor': 'middle' });
  label.textContent = value || '•';
  token.append(label);
  dynamic.append(token);
  return token;
}

function sendToken(step: OverlayStep): void {
  const paths = routePaths(step);
  if (!paths.length || reduceMotion) {
    drawStepMarks(step);
    return;
  }
  const lengths = paths.map((path) => path.getTotalLength());
  const total = lengths.reduce((a, b) => a + b, 0);
  const token = drawToken(0, 0, step);
  const duration = Math.min(1100, 420 + total * 1.2) / speed;
  const began = performance.now();
  const frame = (now: number): void => {
    if (!token.isConnected) return;
    const t = Math.min(1, (now - began) / duration);
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    let distance = ease * total;
    let index = 0;
    while (index < lengths.length - 1 && distance > lengths[index]) {
      distance -= lengths[index];
      index++;
    }
    const point = paths[index].getPointAtLength(Math.min(distance, lengths[index]));
    token.setAttribute('transform', `translate(${point.x} ${point.y})`);
    if (t < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Timeline dock
// ---------------------------------------------------------------------------

function renderDock(): void {
  const show = !!overlay || codeOpen || !!machineShown;
  dock.hidden = !show;
  document.body.classList.toggle('dock-open', show);
  timeline.replaceChildren();
  const controls = $('timeline-controls');
  controls.hidden = !overlay || endPosition() === 0;
  if (overlay) {
    const steps = overlay.steps;
    const track = h('div', { class: 'ticks', role: 'group', 'aria-label': 'Counterexample steps' });
    track.append(tick(0, 'start', 'Start: nothing has happened yet'));
    steps.forEach((step, index) => {
      const button = tick(index + 1, `${step.kind}${step.visible ? '' : ' hidden'}${step.caveat ? ' assumed' : ''}`, `${index + 1}. ${step.description || step.event}${step.caveat ? ` (assumed: ${step.caveat})` : ''}`);
      button.textContent = String(index + 1);
      track.append(button);
    });
    // How it locked up: a tick per process that gets stuck (numbered), per link of a circle (↻), for the dead end (⊘).
    const forming = formation();
    if (forming.length) track.append(h('span', { class: 'tick-phase', 'aria-hidden': 'true' }, 'how it locked'));
    let stuckCount = 0;
    forming.forEach((step, index) => {
      const button = tick(steps.length + 1 + index, `formation fm-${step.kind}`, `How it locked, ${index + 1} of ${forming.length}: ${step.caption}`);
      button.textContent = step.kind === 'stuck' ? String(++stuckCount) : step.kind === 'cycle' ? `↻${step.link ?? ''}` : '⊘';
      track.append(button);
    });
    const end = tick(endPosition(), `final ${overlay.status} kind-${overlay.kind ?? 'other'} sev-${overlay.severity}`, overlay.summary);
    // The same word as the chip: how the run ends.
    end.textContent = overlay.ending === 'stuck' ? 'stuck' : overlay.ending === 'loop' ? 'loops' : overlay.ending === 'error' ? 'error' : overlay.ending === 'range' ? 'stops' : 'end';
    if (endPosition() > 0) track.append(end);
    else {
      track.replaceChildren(end);
    }
    if (overlay.loopStart !== undefined && steps.length) {
      track.classList.add('has-loop');
      for (const element of track.querySelectorAll<HTMLElement>('.tick')) {
        const position = Number(element.dataset.position);
        if (position > overlay.loopStart && position <= steps.length && !element.classList.contains('final')) element.classList.add('in-loop');
      }
    }
    timeline.append(track);
  }
  $('tab-chart').hidden = !overlay || !payload.charts[`${overlay.report}:${overlay.check}`];
  $('tab-machine').hidden = !machineShown;
  if (dockTab === 'chart' && $('tab-chart').hidden) dockTab = 'code';
  if (dockTab === 'machine' && !machineShown) dockTab = 'code';
  setTab(dockTab);
  renderChart();
  renderCode();
  renderMachine();
  updateStepText();
}

function tick(position: number, kind: string, title: string): HTMLButtonElement {
  const button = h('button', { class: `tick ${kind}`, type: 'button', title, 'aria-label': title });
  button.dataset.position = String(position);
  button.addEventListener('click', () => {
    stopPlaying();
    setCursor(position, false);
  });
  return button;
}

function setCursor(position: number, animate: boolean): void {
  if (!overlay) return;
  const before = cursor;
  const end = endPosition();
  cursor = Math.max(0, Math.min(position, end));
  renderOverlayState(animate);
  // The story's heading says whether this is the end state yet.
  if ((before >= end) !== (cursor >= end) || !selection) renderPanel();
}

function updateStepText(): void {
  for (const element of timeline.querySelectorAll<HTMLElement>('.tick')) element.classList.toggle('current', Number(element.dataset.position) === cursor);
  if (!overlay) {
    stepText.textContent = dockTab === 'machine' && machineShown ? 'State machine' : codeOpen ? 'Source' : '';
    return;
  }
  const steps = overlay.steps;
  const forming = formationAt();
  if (cursor >= endPosition()) {
    stepText.replaceChildren(h('strong', {}, steps.length ? `End state, after step ${steps.length}: ` : 'End state: '), overlay.summary);
  } else if (cursor === 0) {
    stepText.textContent = formation().length
      ? `Start: ${steps.length ? `${plural(steps.length, 'step')}, then ` : ''}how it locked, one process at a time. Press play or step forward.`
      : `Start: ${plural(steps.length, 'step')} to the ${overlay.kind === 'deadlock' ? 'deadlock' : 'end'}. Press play or step forward.`;
  } else if (forming !== undefined) {
    stepText.replaceChildren(h('strong', { class: 'formation-head' }, `How it locked, ${forming + 1} of ${formation().length}: `), formation()[forming].caption);
  } else {
    const step = steps[cursor - 1];
    stepText.replaceChildren(h('strong', {}, `Step ${cursor} of ${steps.length}: `), step.description || step.event, step.visible ? '' : h('span', { class: 'muted' }, ' (internal, not visible outside)'), step.caveat ? h('span', { class: 'warn' }, ` Assumed: ${step.caveat}.`) : '', h('code', { class: 'event' }, step.event));
  }
  // Long sentences are cut at two lines: a click shows all of it.
  stepText.title = stepText.textContent ?? '';
  const current = timeline.querySelector<HTMLElement>('.tick.current');
  current?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
  $('play').textContent = playing ? '❚❚' : '▶';
  $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

/** Time a step is shown while playing, at 1×. */
const STEP_MS = 1200;

function play(): void {
  if (!overlay || endPosition() === 0) return;
  if (playing) {
    stopPlaying();
    return;
  }
  playing = true;
  if (cursor >= endPosition()) cursor = overlay.loopStart ?? 0;
  const advance = (): void => {
    if (!overlay || !playing) return;
    if (cursor >= endPosition()) {
      // A divergence repeats its loop; anything else stops at its end state.
      if (overlay.loopStart !== undefined) cursor = overlay.loopStart;
      else {
        stopPlaying();
        return;
      }
    }
    setCursor(cursor + 1, true);
    playTimer = window.setTimeout(advance, STEP_MS / speed);
  };
  advance();
  updateStepText();
}

function stopPlaying(): void {
  playing = false;
  if (playTimer) window.clearTimeout(playTimer);
  playTimer = undefined;
  if (overlay) updateStepText();
}

function setTab(tab: 'code' | 'chart' | 'machine'): void {
  dockTab = tab;
  // A state machine is opened for a box: the page does not open on one next time.
  if (tab !== 'machine') remember('tab', tab);
  codePane.hidden = tab !== 'code';
  chartPane.hidden = tab !== 'chart';
  machinePane.hidden = tab !== 'machine';
  dock.classList.toggle('machine-open', tab === 'machine');
  updateMinimap();
  for (const name of ['code', 'chart', 'machine'] as const) {
    $(`tab-${name}`).classList.toggle('active', tab === name);
    $(`tab-${name}`).setAttribute('aria-selected', String(tab === name));
  }
  if (tab === 'chart') renderChartCursor();
  if (tab === 'machine') drawMachineMarks();
}

// ---------------------------------------------------------------------------
// Sequence chart
// ---------------------------------------------------------------------------

function renderChart(): void {
  const chart = overlay ? payload.charts[`${overlay.report}:${overlay.check}`] : undefined;
  chartPane.innerHTML = chart ?? '';
  // Keep the lifeline names in view while the rows scroll.
  const full = chartPane.querySelector<SVGSVGElement>('svg.pj-msc');
  const heads = full?.querySelector('.pj-msc-heads');
  if (full && heads) {
    const bottom = Number(full.dataset.heads ?? 46);
    const width = full.getAttribute('width') ?? '0';
    const sticky = document.createElementNS(SVG_NS, 'svg');
    sticky.setAttribute('class', 'pj-msc pj-msc-sticky');
    sticky.setAttribute('width', width);
    sticky.setAttribute('height', String(bottom));
    sticky.setAttribute('viewBox', `0 0 ${width} ${bottom}`);
    const style = full.querySelector('style');
    if (style) sticky.append(style.cloneNode(true));
    // The same pixels as the chart's own top (its title and heads), laid over it: one row of heads, not two.
    const title = full.querySelector('.pj-msc-title');
    sticky.append(svg('rect', { class: 'pj-msc-bg', x: 0, y: 0, width, height: bottom }), ...(title ? [title.cloneNode(true)] : []), heads.cloneNode(true));
    const holder = h('div', { class: 'chart-head' });
    holder.style.marginBottom = `-${bottom}px`;
    holder.append(sticky);
    chartPane.prepend(holder);
  }
  for (const row of chartPane.querySelectorAll<SVGGElement>('[data-step]')) {
    row.addEventListener('click', () => {
      const index = row.dataset.step === 'final' ? endPosition() : Number(row.dataset.step) + 1;
      stopPlaying();
      setCursor(index, false);
    });
  }
  // A lane's `stuck from here`: the step of how it locked where that process gets stuck.
  for (const mark of chartPane.querySelectorAll<SVGGElement>('[data-stuck]')) {
    mark.style.cursor = 'pointer';
    mark.addEventListener('click', () => {
      const index = formation().findIndex((step) => step.kind === 'stuck' && step.keys.includes(mark.dataset.stuck!));
      if (index < 0 || !overlay) return;
      stopPlaying();
      setCursor(overlay.steps.length + 1 + index, false);
    });
  }
  renderChartCursor();
}

function renderChartCursor(): void {
  for (const element of chartPane.querySelectorAll('.pj-current')) element.classList.remove('pj-current');
  if (!overlay) return;
  const forming = formationAt();
  // While it locks up: where the lanes of this step's processes become stuck.
  const from = forming !== undefined ? [...chartPane.querySelectorAll<SVGGElement>('svg.pj-msc:not(.pj-msc-sticky) [data-stuck]')].filter((element) => formation()[forming].keys.includes(element.dataset.stuck!)) : [];
  for (const element of from) element.classList.add('pj-current');
  const target = cursor >= endPosition() ? chartPane.querySelector('svg.pj-msc:not(.pj-msc-sticky) [data-step="final"]') : forming !== undefined ? from[0] : cursor > 0 ? chartPane.querySelector(`svg.pj-msc:not(.pj-msc-sticky) [data-step="${cursor - 1}"]`) : undefined;
  if (forming === undefined) target?.classList.add('pj-current');
  if (target && !chartPane.hidden) (target as Element).scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/** A request's key, as the server makes it (render-machine.ts machineRequestKey). */
function machineKey(request: MachineRequest): string {
  return [request.target, request.ref, request.check ?? '', request.process ?? ''].join('\u0001');
}

/** The result shown, when FDR's: a trail is in the model FDR checked. */
function fdrChip(): Chip | undefined {
  const chip = active ? payload.chips.find((entry) => entry.report === active!.report && entry.check === active!.check) : undefined;
  return chip?.producer === 'fdr' ? chip : undefined;
}

/** The processes of the result shown that a box stands for (several for a par for drawn once), with their trails. */
function tracedProcesses(nodeId: string): NonNullable<Overlay['processes']> {
  return overlay?.processes.filter((entry) => entry.node === nodeId && entry.trail?.length) ?? [];
}

/**
 * What to ask for a box: its machine from the model FDR checked while an FDR
 * result is shown (with the process's trail when the result names it), else
 * from the model of the view.
 */
function machineRequest(nodeId: string, process?: string): MachineRequest | undefined {
  const node = nodeById.get(nodeId);
  if (!node?.machine) return undefined;
  const chip = fdrChip();
  const traced = tracedProcesses(nodeId);
  const placed = traced.find((entry) => entry.key === process) ?? traced[0];
  return { target: chip?.target ?? view.target, ref: node.machine, ...(chip && placed ? { check: chip.check, process: placed.key } : {}) };
}

/** Show a box's state machine in the dock (`process` picks one of the processes a par for box stands for). */
function openMachine(nodeId: string, process?: string): void {
  const request = machineRequest(nodeId, process);
  if (!request) return;
  machineShown = { node: nodeId, request };
  dockTab = 'machine';
  renderDock();
  loadMachine(request);
}

/** After the result or the view changed, the machine shown asks again for what fits it now. */
function refreshMachineRequest(): void {
  if (!machineShown) return;
  const request = machineRequest(machineShown.node, machineShown.request.process);
  if (!request) {
    machineShown = undefined;
    return;
  }
  if (machineKey(request) === machineKey(machineShown.request)) return;
  machineShown = { node: machineShown.node, request };
  loadMachine(request);
}

function loadMachine(request: MachineRequest): void {
  const key = machineKey(request);
  const fail = (error: string): void => {
    machineCache.set(key, { key, error });
    renderMachine();
  };
  if (machineCache.has(key)) return renderMachine();
  const embedded = payload.machines?.[key];
  if (embedded) {
    machineCache.set(key, embedded);
    return renderMachine();
  }
  if (MODE === 'live') {
    renderMachine('Laying out the state machine…');
    const query = new URLSearchParams({ target: request.target, ref: request.ref });
    if (request.check) query.set('check', request.check);
    if (request.process !== undefined) query.set('process', request.process);
    void fetch(`${LIVE_BASE}machine?${query.toString()}`)
      .then((response) => (response.ok ? response.json() as Promise<Machine | MachineError> : Promise.reject(new Error(String(response.status)))))
      .then((machine) => receiveMachine({ ...machine, key }))
      .catch(() => fail('The language server has no state machine for this process.'));
  } else if (vscode) {
    renderMachine('Laying out the state machine…');
    vscode.postMessage({ type: 'machine', request });
  } else fail('This state machine is not part of this file: open the graph from your editor to see every process\'s state machine.');
}

function receiveMachine(machine: Machine | MachineError): void {
  machineCache.set(machine.key, machine);
  if (machineShown && machineKey(machineShown.request) === machine.key) renderMachine();
}

function shownMachine(): Machine | undefined {
  const machine = machineShown ? machineCache.get(machineKey(machineShown.request)) : undefined;
  return machine && !('error' in machine) ? machine : undefined;
}

/** Fit the machine to the dock (`fit`), show it at its own size (`actual`), or fit it only while that stays readable (unset). */
let machineSize = recall('machine-size') === 'fit' ? 'fit' : recall('machine-size') === 'actual' ? 'actual' : undefined;
/** Below this scale a fitted machine's words are too small to read: it is shown at its own size, scrolled to the run. */
const READABLE_MACHINE = 0.6;

function renderMachine(message?: string): void {
  if (!machineShown) {
    machinePane.replaceChildren();
    return;
  }
  const node = nodeById.get(machineShown.node);
  const entry = machineCache.get(machineKey(machineShown.request));
  machinePane.replaceChildren();
  if (!entry || 'error' in entry) {
    machinePane.append(h('p', { class: 'muted machine-message' }, entry && 'error' in entry ? entry.error : message ?? 'Laying out the state machine…'));
    return;
  }
  const machine = entry;
  const traced = tracedProcesses(machineShown.node);
  const who = machine.process?.label ?? node?.name ?? machine.label;
  const states = machine.states.filter((state) => state.definition).length;
  // Fitted only when its words stay readable, unless asked for one or the other.
  const room = machinePane.getBoundingClientRect();
  const scale = Math.min(Math.max(room.width - 340, 200) / Math.max(machine.width, 1), Math.max(room.height - 60, 120) / Math.max(machine.height, 1));
  const machineFit = machineSize === 'fit' || (machineSize !== 'actual' && scale >= READABLE_MACHINE);
  const fit = h('button', { type: 'button', title: 'Fit the machine to the panel, or show it at its own size' }, machineFit ? 'Actual size' : 'Fit');
  fit.addEventListener('click', () => {
    machineSize = machineFit ? 'actual' : 'fit';
    remember('machine-size', machineSize);
    renderMachine();
  });
  const exportButton = h('button', { type: 'button', title: 'Save this state machine, with the run marked, as SVG' }, 'Export SVG');
  exportButton.addEventListener('click', () => exportAs('machine'));
  const head = h('div', { class: 'machine-head' },
    h('strong', {}, machine.label === who ? `${machine.label}` : `${who} runs ${machine.label}`),
    h('span', { class: 'muted' }, ` · ${plural(states, 'state')} of ${machine.model}${machine.trail ? ' · numbered: the states this run went through, in order' : ''}`));
  const tools = h('div', { class: 'machine-tools' });
  if (traced.length > 1) {
    // A par for drawn once stands for every iteration: pick the one to follow.
    const pick = h('select', { title: 'Which process this box stands for' });
    for (const process of traced) pick.append(h('option', { value: process.key }, process.label));
    pick.value = machineShown.request.process ?? traced[0].key;
    pick.addEventListener('change', () => openMachine(machineShown!.node, pick.value));
    tools.append(pick);
  }
  tools.append(fit, exportButton);
  head.append(tools);
  const drawing = document.createElementNS(SVG_NS, 'svg');
  drawing.setAttribute('class', 'pj-net pj-sm-svg');
  drawing.setAttribute('viewBox', `0 0 ${machine.width} ${machine.height}`);
  if (!machineFit) {
    drawing.setAttribute('width', String(machine.width));
    drawing.setAttribute('height', String(machine.height));
  } else drawing.style.maxWidth = `${Math.ceil(machine.width * 1.5)}px`;
  drawing.innerHTML = machine.svg;
  for (const element of drawing.querySelectorAll<SVGGElement>('.pj-sm-state[data-state]')) {
    const state = machine.states.find((entry) => entry.id === element.dataset.state);
    if (!state?.at) continue;
    element.addEventListener('click', () => {
      if (state.at!.uri === payload.source?.uri) scrollCodeTo(state.at!.line);
      else openSource(state.at!);
    });
  }
  for (const element of drawing.querySelectorAll<SVGGElement>('.pj-sm-edge-label.pj-sm-call[data-index]')) {
    const transition = machine.transitions[Number(element.dataset.index)];
    if (!transition?.callRef) continue;
    element.setAttribute('role', 'button');
    element.addEventListener('click', () => {
      const request = { ...machineShown!.request, ref: transition.callRef! };
      machineShown = { node: machineShown!.node, request };
      loadMachine(request);
    });
  }
  const body = h('div', { class: `machine-body${machineFit ? ' fit' : ''}` });
  body.dataset.fit = String(machineFit);
  body.append(drawing);
  const side = h('div', { class: 'machine-side' });
  if (machine.trail?.length) {
    const items = machine.trail.map((entry, index) => {
      const when = entry.step === 0 ? 'at the start' : `after step ${entry.step}`;
      const item = h('li', { 'data-trail': String(index), class: entry.id || entry.call !== undefined ? '' : 'elsewhere', title: entry.state },
        h('span', { class: 'trail-when' }, when), ' ', h('span', {}, entry.label), h('code', {}, entry.state));
      item.addEventListener('click', () => {
        stopPlaying();
        setCursor(entry.step, false);
      });
      return item;
    });
    side.append(h('div', { class: 'machine-side-head' }, h('span', { class: 'caps' }, 'FDR\'s states, in order'), h('div', { class: 'machine-who' }, who)), h('ol', { class: 'machine-trail' }, ...items));
  } else {
    // A result with no run for this box: the checker's has no states, or FDR's names no process drawn here.
    side.append(h('p', { class: 'muted' }, !overlay ? 'No result is shown: these are the states it can be in. Run Check with FDR to see a run go through them.'
      : overlay.producer !== 'fdr' ? 'The static checker\'s results have no states: run Check with FDR to see a run go through them.'
        : 'This result names no process that is drawn as this box, so no run is shown here.'));
  }
  for (const note of machine.notes) side.append(h('p', { class: 'muted' }, note));
  side.append(h('p', { class: 'muted machine-key' }, 'Each box is one definition of the CSP model (its name is under it), where the process waits for its next event. Dashed arrows are taken only when their condition holds; blue labels are calls (click one for the callee\'s machine).'));
  machinePane.append(head, h('div', { class: 'machine-main' }, body, side));
  drawMachineMarks();
}

/**
 * The run at the timeline's cursor on the machine: the states the process has
 * been in so far numbered in order, the transitions it took, and where it is
 * now (at the end, where it is stuck, with what it waits for). A process
 * inside a call is on that call's arrow: in the callee, not yet back at the
 * state it goes on at (the callee's own machine, a click on the call, shows
 * where in it).
 */
function drawMachineMarks(): void {
  const machine = shownMachine();
  const drawing = machinePane.querySelector<SVGSVGElement>('svg.pj-sm-svg');
  if (!machine || !drawing) return;
  const fitted = machinePane.querySelector<HTMLElement>('.machine-body')?.dataset.fit === 'true';
  for (const element of drawing.querySelectorAll('.pj-sm-visited, .pj-sm-current, .pj-sm-stuck, .pj-sm-taken')) element.classList.remove('pj-sm-visited', 'pj-sm-current', 'pj-sm-stuck', 'pj-sm-taken');
  const marks = drawing.querySelector<SVGGElement>('.pj-sm-marks');
  marks?.replaceChildren();
  for (const item of machinePane.querySelectorAll('.machine-trail li')) item.classList.remove('current', 'reached');
  const trail = machine.trail ?? [];
  if (!trail.length || !marks) return;
  // While it locks up the trace is over: the process is stuck once the replay has told it so.
  const forming = formationAt();
  const told = forming !== undefined && machineShown?.request.process !== undefined && stuckBy(forming).keys.has(machineShown.request.process);
  const atEnd = !overlay || cursor >= endPosition() || told;
  const reached = trail.filter((entry) => atEnd || forming !== undefined || entry.step <= cursor);
  const current = reached[reached.length - 1];
  const stateEl = (id: string): SVGGElement | null => drawing.querySelector<SVGGElement>(`.pj-sm-state[data-state="${CSS.escape(id)}"]`);
  const edgeEls = (index: number): Element[] => [...drawing.querySelectorAll(`.pj-sm-edge[data-index="${index}"], .pj-sm-edge-label[data-index="${index}"]`)];
  const box = (id: string): MachineState | undefined => machine.states.find((state) => state.id === id);
  // Where a call's arrow is: its label, else the middle of the arrow.
  const callBox = (index: number): { x: number; y: number; width: number; height: number } | undefined => {
    const label = drawing.querySelector<SVGGraphicsElement>(`.pj-sm-edge-label[data-index="${index}"] rect`);
    if (label) return label.getBBox();
    const path = drawing.querySelector<SVGPathElement>(`.pj-sm-edge[data-index="${index}"] path`);
    if (!path) return undefined;
    const middle = path.getPointAtLength(path.getTotalLength() / 2);
    return { x: middle.x - 8, y: middle.y - 8, width: 16, height: 16 };
  };
  // Transitions between consecutive places, through the points a process passes without stopping.
  const passing = new Set(machine.states.filter((state) => state.passing).map((state) => state.id));
  const route = (from: string, to: string): number[] => {
    if (from === to) return [];
    const queue: Array<{ at: string; path: number[] }> = [{ at: from, path: [] }];
    const seen = new Set<string>([from]);
    while (queue.length) {
      const { at, path } = queue.shift()!;
      for (const [index, t] of machine.transitions.entries()) {
        if (t.from !== at) continue;
        if (t.to === to) return [...path, index];
        if (passing.has(t.to) && !seen.has(t.to) && path.length < 8) {
          seen.add(t.to);
          queue.push({ at: t.to, path: [...path, index] });
        }
      }
    }
    return [];
  };
  // A place is entered at one state and left at another: a state is both; a call leaves where it starts and goes on where it returns.
  const placeOf = (entry: NonNullable<Machine['trail']>[number]): { enter: string; exit: string; call?: number } | undefined => {
    if (entry.id) return { enter: entry.id, exit: entry.id };
    const t = entry.call !== undefined ? machine.transitions[entry.call] : undefined;
    return t ? { enter: t.from, exit: t.to, call: entry.call } : undefined;
  };
  const places = reached.map(placeOf).filter((place): place is NonNullable<ReturnType<typeof placeOf>> => !!place);
  // From the start to the first place FDR names (it does not name the points a process passes), then place to place.
  const way = places.length && places[0].enter !== machine.initial ? [{ enter: machine.initial, exit: machine.initial }, ...places] : places;
  for (let i = 1; i < way.length; i++) {
    for (const index of route(way[i - 1].exit, way[i].enter)) edgeEls(index).forEach((element) => element.classList.add('pj-sm-taken'));
    // A call the process came back from was taken all the way.
    const left = way[i - 1].call;
    if (left !== undefined) edgeEls(left).forEach((element) => element.classList.add('pj-sm-taken'));
  }
  // Numbers in order, several on a state (or a call) the run came back to.
  const orders = new Map<string, { numbers: number[]; at?: { x: number; y: number; width: number; height: number } }>();
  trail.forEach((entry, index) => {
    if (!reached.includes(entry)) return;
    const key = entry.id !== undefined ? `s:${entry.id}` : entry.call !== undefined ? `c:${entry.call}` : undefined;
    if (!key) return;
    const at = entry.id !== undefined ? box(entry.id) : callBox(entry.call!);
    const known = orders.get(key);
    if (known) known.numbers.push(index + 1);
    else orders.set(key, { numbers: [index + 1], at });
  });
  const last = trail.indexOf(current) + 1;
  for (const [key, { numbers, at }] of orders) {
    if (key.startsWith('s:')) stateEl(key.slice(2))?.classList.add('pj-sm-visited');
    if (!at) continue;
    const shown = numbers.length > 3 ? [...numbers.slice(0, 2), numbers[numbers.length - 1]] : numbers;
    shown.forEach((n, k) => {
      const cx = at.x + at.width - 2 - (shown.length - 1 - k) * 19;
      const cy = at.y - 1;
      const g = svg('g', { class: `pj-sm-order${n === last ? ' pj-sm-order-last' : ''}` });
      g.append(svg('circle', { cx, cy, r: 9 }));
      const t = svg('text', { x: cx, y: cy + 3.6, 'text-anchor': 'middle' });
      t.textContent = numbers.length > 3 && k === 1 ? '…' : String(n);
      g.append(t);
      marks.append(g);
    });
  }
  const item = machinePane.querySelector<HTMLElement>(`.machine-trail li[data-trail="${trail.indexOf(current)}"]`);
  for (const entry of reached) machinePane.querySelector(`.machine-trail li[data-trail="${trail.indexOf(entry)}"]`)?.classList.add('reached');
  item?.classList.add('current');
  if (!current || (current.id === undefined && current.call === undefined)) return;
  const stuck = atEnd && machine.process?.status === 'blocked';
  const call = current.id === undefined ? machine.transitions[current.call!] : undefined;
  const b = current.id !== undefined ? box(current.id) : callBox(current.call!);
  const element = current.id !== undefined ? stateEl(current.id) : drawing.querySelector<SVGGElement>(`.pj-sm-edge-label[data-index="${current.call}"]`);
  if (current.id !== undefined) element?.classList.add(stuck ? 'pj-sm-stuck' : 'pj-sm-current');
  else edgeEls(current.call!).forEach((entry) => entry.classList.add(stuck ? 'pj-sm-stuck' : 'pj-sm-current'));
  if (!b) return;
  if (stuck) marks.prepend(svg('rect', { class: 'pj-sm-halo', x: b.x - 4, y: b.y - 4, width: b.width + 8, height: b.height + 8, rx: 12 }));
  // Under it: what it waits for at the end (in the callee, inside a call), else what it does next.
  const inside = call ? `in ${call.call ?? 'the call'}: ` : '';
  const text = atEnd && machine.process
    ? machine.process.status === 'blocked' ? `${inside}${machine.process.waits[0] ?? machine.process.description}` : machine.process.description
    : `here after step ${current.step}${call ? ` (inside the call of ${call.call ?? 'a procedure'})` : ''}`;
  const width = Math.min(text.length * 6.6 + 16, 420);
  const shownText = text.length * 6.6 + 16 > 420 ? `${text.slice(0, Math.floor((420 - 16) / 6.6) - 1)}…` : text;
  const callout = svg('g', { class: `pj-sm-callout${stuck ? '' : ' pj-sm-callout-info'}` });
  const x = Math.max(4, Math.min(b.x + b.width / 2 - width / 2, machine.width - width - 4));
  const y = b.y + b.height + 6;
  callout.append(svg('rect', { x, y, width, height: 20, rx: 10 }));
  const label = svg('text', { x: x + 8, y: y + 14 });
  label.textContent = shownText;
  callout.append(label);
  marks.append(callout);
  // A callout under the bottom row would be cut off: grow the drawing to hold it.
  if (y + 24 > machine.height) {
    drawing.setAttribute('viewBox', `0 0 ${machine.width} ${y + 26}`);
    if (!fitted) drawing.setAttribute('height', String(y + 26));
  }
  if (!fitted) element?.scrollIntoView({ block: 'nearest', inline: 'center' });
}

// ---------------------------------------------------------------------------
// Code pane
// ---------------------------------------------------------------------------

let codeLines: HTMLElement[] = [];

function buildCode(): void {
  codePane.replaceChildren();
  codeLines = [];
  const text = payload.source?.text;
  if (text === undefined) {
    codePane.append(h('p', { class: 'muted' }, 'The source text is not part of this page.'));
    return;
  }
  const fragment = document.createDocumentFragment();
  text.split(/\r\n|\r|\n/).forEach((line, index) => {
    const row = h('div', { class: 'code-line', 'data-line': String(index) }, h('span', { class: 'gutter' }, String(index + 1)), h('span', { class: 'code-text' }, line || ' '));
    row.addEventListener('click', () => focusLine(index));
    codeLines.push(row);
    fragment.append(row);
  });
  codePane.append(fragment);
}

function renderCode(): void {
  if (!codeLines.length) return;
  for (const row of codePane.querySelectorAll('.code-line.mark')) {
    row.classList.remove('mark', 'stuck', 'behind', 'warning', 'done', 'step', 'loop', 'assumed', 'choice', 'now');
    (row as HTMLElement).style.removeProperty('--mark');
    row.querySelector('.lens')?.remove();
  }
  if (!overlay) return;
  const uri = payload.source?.uri;
  const marks: Array<{ line: number; kind: 'stuck' | 'behind' | 'warning' | 'done' | 'step' | 'loop' | 'assumed' | 'choice'; node?: string; text?: string; root?: boolean; now?: boolean }> = [];
  // A value leaving the modelled integers is a warning: amber, as on the canvas.
  const failure = overlay.severity === 'warning' ? 'warning' : 'stuck';
  const steps = overlay.steps;
  // Red where a process can never go on; amber where it waits behind one, or a run that repeats forever only leaves it waiting.
  const tone = (process: Overlay['processes'][number]): 'stuck' | 'behind' => (process.cause === 'knock-on' || process.forGood === false ? 'behind' : 'stuck');
  if (cursor >= endPosition()) {
    // Where the run relies on what the model abstracts, and where a nondeterministic result turns: said on
    // their lines rather than that a process is still running or finished there.
    const special: typeof marks = [];
    for (const step of steps) {
      const at = step.participants.find((participant) => participant.at)?.at;
      if (step.caveat && at && at.uri === uri) special.push({ line: at.span.start.line, kind: 'assumed', text: `assumed at step ${step.index + 1}: ${step.caveat}` });
    }
    if (overlay.choice?.at && overlay.choice.at.uri === uri) special.unshift({ line: overlay.choice.at.span.start.line, kind: 'choice', node: overlay.choice.node, text: `the choice (step ${overlay.choice.step + 1}): ${overlay.choice.description}` });
    const told = new Set(special.map((mark) => mark.line));
    // Errors first: the line that failed is the one to read.
    if (overlay.error?.at && overlay.error.at.uri === uri) marks.push({ line: overlay.error.at.span.start.line, kind: failure, node: overlay.error.node, text: failure === 'warning' ? overlay.error.message : `error: ${overlay.error.message}` });
    // In a run that repeats forever a blocked process may only be left waiting by that run, not stuck for good.
    const waiting = (process: Overlay['processes'][number]): string => (process.forGood === false ? 'is left waiting' : 'is stuck');
    for (const process of overlay.processes) {
      if (!process.at || process.at.uri !== uri) continue;
      const wait = overlay.waits.find((entry) => entry.node === process.node);
      const who = processWord(process);
      // Several processes stuck at one statement (a procedure each of them runs) share its line: named together.
      const same = overlay.processes.filter((other) => other.status === 'blocked' && other.at?.uri === uri && other.at.span.start.line === process.at!.span.start.line);
      if (process.status === 'blocked' && same.length > 1 && same[0] !== process) continue;
      if (process.status === 'blocked' && same.length > 1) {
        // `write p0f1, p1f2 and p2f0`: one verb for the waits when they share it.
        const badges = [...new Set(same.map((other) => other.badge))];
        const verb = badges.every((badge) => badge.split(' ')[0] === badges[0].split(' ')[0]) && badges.every((badge) => badge.split(' ').length === 2) ? badges[0].split(' ')[0] : undefined;
        const what = badges.length === 1 ? badges[0] : verb ? `${verb} ${listWords(badges.map((badge) => badge.split(' ')[1]))}` : listWords(badges);
        const names = same.length > 3 ? `${processWord(same[0])} and ${same.length - 1} more` : listWords(same.map(processWord));
        const root = same.some((other) => tone(other) === 'stuck');
        marks.push({ line: process.at.span.start.line, kind: root ? 'stuck' : 'behind', node: process.node, text: `${names} ${same.every((other) => other.forGood !== false) ? 'are stuck' : 'are left waiting'}: ${what}`, root });
      } else if (process.status === 'blocked') marks.push({ line: process.at.span.start.line, kind: tone(process), node: process.node, text: `${who} ${waiting(process)}: ${process.badge}${wait ? ` — ${wait.short}` : ''}`, root: tone(process) === 'stuck' });
      else if (process.status === 'error') marks.push({ line: process.at.span.start.line, kind: failure, node: process.node, text: failure === 'warning' ? `${who} leaves the modelled integers here (not an error of the program)` : `${who} stops with a runtime error here` });
      else if (process.status === 'diverging') marks.push({ line: process.at.span.start.line, kind: 'loop', node: process.node, text: `${who} loops here without communicating` });
      else if (told.has(process.at.span.start.line)) continue;
      // A running process the result is about (it can perform the event a specification refuses) says so.
      else if (process.status === 'running' && process.badge !== 'running') marks.push({ line: process.at.span.start.line, kind: 'stuck', node: process.node, text: `${who}: ${process.badge}`, root: true });
      else if (process.status === 'running') marks.push({ line: process.at.span.start.line, kind: 'step', node: process.node, text: `${who} is still running here` });
      else if (process.status === 'terminated') marks.push({ line: process.at.span.start.line, kind: 'done', node: process.node, text: `${who} finished` });
    }
    marks.push(...special);
  } else if (formationAt() !== undefined) {
    // While it locks up: the line of each process stuck by now, the ones this step is about first.
    const step = formation()[formationAt()!];
    const stuck = stuckBy(formationAt()!).keys;
    const now = (process: Overlay['processes'][number]): boolean => step.keys.includes(process.key) && (step.kind === 'stuck' || stuck.has(process.key));
    const shown = overlay.processes.filter((process) => process.status === 'blocked' && stuck.has(process.key) && process.at?.uri === uri);
    for (const process of [...shown.filter(now), ...shown.filter((process) => !now(process))]) {
      const wait = overlay.waits.find((entry) => entry.node === process.node);
      marks.push({ line: process.at!.span.start.line, kind: tone(process), node: process.node, text: `${processWord(process)} ${process.forGood === false ? 'is left waiting' : 'is stuck'}: ${process.badge}${wait ? ` — ${wait.short}` : ''}`, root: tone(process) === 'stuck', now: now(process) });
    }
  } else if (cursor > 0 && cursor <= steps.length) {
    const step = steps[cursor - 1];
    for (const participant of step.participants) {
      if (!participant.at || participant.at.uri !== uri) continue;
      marks.push({ line: participant.at.span.start.line, kind: 'step', node: participant.node, text: `${participant.label}: ${participant.role} · step ${cursor}` });
    }
  }
  // The line to show: what the step of how it locked is about, else where a process is stuck for good, else stuck
  // behind one, else the first mark.
  const rank = (mark: (typeof marks)[number]): number => (mark.now ? -1 : mark.kind === 'stuck' || mark.kind === 'warning' || mark.kind === 'choice' ? (mark.root === false ? 1 : 0) : mark.kind === 'behind' ? 1 : 2);
  let first: { row: HTMLElement; rank: number } | undefined;
  for (const mark of marks) {
    const row = codeLines[mark.line];
    if (!row) continue;
    row.classList.add('mark', mark.kind);
    if (mark.now) row.classList.add('now');
    if (mark.node && colors.has(mark.node) && mark.kind === 'step') row.style.setProperty('--mark', colors.get(mark.node)!);
    if (mark.text && !row.querySelector('.lens')) row.append(h('span', { class: `lens ${mark.kind}` }, mark.text));
    if (!first || rank(mark) < first.rank) first = { row, rank: rank(mark) };
  }
  if (first && !codePane.hidden) first.row.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
}

function scrollCodeTo(line: number): void {
  const row = codeLines[line];
  if (!row || dock.hidden) return;
  setTab('code');
  row.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
  row.classList.add('pulse');
  window.setTimeout(() => row.classList.remove('pulse'), 900);
}

/** The line a process is at: its place in the result, else its own source line. */
function scrollCodeToNode(id: string): void {
  if (dock.hidden) return;
  const placed = overlay?.processes.find((entry) => entry.node === id && entry.at?.uri === payload.source?.uri);
  const node = nodeById.get(id);
  const line = placed?.at?.span.start.line ?? (node?.source?.uri === payload.source?.uri ? node?.source?.line : undefined);
  if (line !== undefined) scrollCodeTo(line);
}

/** Clicking a line focuses the process that is (or acts) there. */
function focusLine(line: number): void {
  const uri = payload.source?.uri;
  const fromResult = overlay?.processes.find((entry) => entry.at !== undefined && entry.at.uri === uri && entry.at.span.start.line === line);
  let id = fromResult?.node;
  if (!id) id = view.nodes.find((node) => node.kind !== 'group' && node.operations.some((operation) => operation.at.uri === uri && operation.at.line === line))?.id;
  if (!id) id = view.nodes.find((node) => node.operations.some((operation) => operation.at.uri === uri && operation.at.line === line))?.id;
  if (!id) id = view.nodes.find((node) => node.source !== undefined && node.source.uri === uri && node.source.line === line)?.id;
  if (!id) {
    showToast(`Nothing drawn here runs line ${line + 1}`);
    return;
  }
  select({ type: 'node', id }, true);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/** The page's themed stylesheet with each custom property replaced by its light fallback. */
function plainStyle(style: string): string {
  return style.replace(/var\(--pj-[a-z-]+, ([^)]+\)?)\)/g, '$1');
}

/** `text` wrapped to `width` in at most `count` lines; a cut is marked with an ellipsis. */
function firstLines(text: string, size: number, width: number, count: number): string[] {
  const lines = wrapWords(text, size, width);
  if (lines.length <= count) return lines;
  const perLine = Math.max(12, Math.floor(width / (size * 0.6)));
  const kept = lines.slice(0, count);
  const last = kept[count - 1];
  kept[count - 1] = last.length + 1 > perLine ? `${last.slice(0, perLine - 1)}…` : `${last}…`;
  return kept;
}

/** Greedy word wrap for the monospace stack (0.6 em a character), as the server's SVG does it. */
function wrapWords(text: string, size: number, width: number): string[] {
  const perLine = Math.max(12, Math.floor(width / (size * 0.6)));
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    const next = current ? `${current} ${word}` : word;
    if (next.length <= perLine) current = next;
    else {
      if (current) lines.push(current);
      current = word.length > perLine ? `${word.slice(0, perLine - 1)}…` : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * The view as on screen (at the timeline's cursor), framed like the server's
 * SVG: title, the verdict, the drawing, the account of the result (or of the
 * step shown), and a legend.
 */
function currentSvg(): string {
  const final = !!overlay && cursor >= endPosition();
  const forming = formationAt();
  // A step of the replay draws none of the end state's words: no room is kept for them. How it locked draws some.
  const bounds = contentBounds(final || forming !== undefined);
  const margin = 24;
  const width = Math.max(bounds.width + margin * 2, 600);
  const x = bounds.x - margin;
  const column = width - margin * 2;
  const titleText = `${payload.title} · ${view.label}`;
  const subtitle = overlay ? overlay.subtitle : view.subtitle;
  const subtitleLines = firstLines(subtitle, 11.5, column, 3);
  const head = 40 + subtitleLines.length * 16;
  const step = overlay && !final && cursor > 0 && cursor <= overlay.steps.length ? overlay.steps[cursor - 1] : undefined;
  // The end state's story with what the run relies on, as the server's SVG has it; a step says what it assumes.
  const account = overlay ? final ? [...overlay.story, ...overlay.caveats.map((caveat) => `Caveat: ${caveat}.`)]
    : forming !== undefined ? [`How it locked, ${forming + 1} of ${formation().length}: ${formation()[forming].caption}`]
      : step ? [`Step ${cursor} of ${overlay.steps.length}: ${step.description || step.event}${step.caveat ? ` (assumed: ${step.caveat})` : ''}`] : [`Start: ${plural(overlay.steps.length, 'step')} to the end state.`] : [];
  const caption = account.flatMap((sentence) => wrapWords(sentence, 11.5, column));
  const entries = overlay && final ? overlay.legend : view.legend;
  const rows: string[] = [];
  let row: string[] = [];
  let at = 0;
  for (const entry of entries) {
    if (at > 0 && at + entry.width - 18 > column) {
      rows.push(row.join(''));
      row = [];
      at = 0;
    }
    row.push(`<g transform="translate(${at.toFixed(1)} 0)">${entry.svg}</g>`);
    at += entry.width;
  }
  if (row.length) rows.push(row.join(''));
  const graphTop = head - bounds.y;
  const captionTop = graphTop + bounds.y + bounds.height + margin;
  const legendTop = captionTop + (caption.length ? caption.length * 16 + 14 : 0);
  const height = legendTop + (rows.length ? rows.length * 24 + 6 : 0) + 20;
  const defs = canvas.querySelector('defs')?.innerHTML ?? '';
  const content = graph.cloneNode(true) as SVGGElement;
  for (const element of content.querySelectorAll('[tabindex]')) {
    element.removeAttribute('tabindex');
    element.removeAttribute('role');
  }
  for (const element of content.querySelectorAll('.pj-selected, .pj-hl, .pj-match, .pj-ov-dim')) element.classList.remove('pj-selected', 'pj-hl', 'pj-match', 'pj-ov-dim');
  // Words scaled up for a zoomed-out screen go back to their size.
  for (const element of content.querySelectorAll('.pj-ov-badge-wrap, .pj-ov-reason-wrap, .pj-ov-callout-wrap')) element.removeAttribute('transform');
  const extra = dynamic.cloneNode(true) as SVGGElement;
  const left = x + margin;
  const text = (cls: string, value: string, y: number): string => `<text class="${cls}" x="${left}" y="${y.toFixed(1)}">${escapeText(value)}</text>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!-- generated by processj-lsp: ProcessJ process network -->\n<svg xmlns="http://www.w3.org/2000/svg" class="pj-net" viewBox="${x} 0 ${width} ${height}" width="${Math.ceil(width)}" height="${Math.ceil(height)}"><title>${escapeText(`${titleText} · ${subtitle}`)}</title><style>${plainStyle(payload.style)}${EXPORT_EXTRA}</style><defs>${defs}</defs><rect class="pj-bg" x="${x}" y="0" width="${width}" height="${height}"/>${text('pj-title', titleText, 28)}${subtitleLines.map((line, index) => text('pj-subtitle', line, 47 + index * 16)).join('')}<g transform="translate(0 ${graphTop.toFixed(1)})">${content.outerHTML}${extra.outerHTML}</g>${caption.map((line, index) => text('pj-caption-text', line, captionTop + 12 + index * 16)).join('')}${rows.length ? `<g class="pj-legend" transform="translate(${left} ${legendTop.toFixed(1)})">${rows.map((entry, index) => `<g transform="translate(0 ${index * 24})">${entry}</g>`).join('')}</g>` : ''}</svg>\n`;
}

/**
 * The state machine as on screen, as a file: a title row, the machine with
 * the run marked up to the timeline's cursor, and the states of that run as a
 * caption, in light colours.
 */
function machineSvg(machine: Machine, drawing: SVGSVGElement): string {
  const margin = 24;
  const [, , vw, vh] = (drawing.getAttribute('viewBox') ?? `0 0 ${machine.width} ${machine.height}`).split(/\s+/).map(Number);
  const width = Math.max(vw + margin * 2, 560);
  const column = width - margin * 2;
  const who = machine.process?.label ?? (machineShown ? nodeById.get(machineShown.node)?.name : undefined) ?? machine.label;
  const titleText = `${payload.title} · ${who === machine.label ? machine.label : `${who} runs ${machine.label}`} · state machine`;
  const subtitle = `${machine.model}${overlay ? ` · ${overlay.subtitle}` : ''}`;
  const subtitleLines = firstLines(subtitle, 11.5, column, 3);
  const head = 40 + subtitleLines.length * 16;
  const reached = (machine.trail ?? []).filter((entry) => !overlay || cursor >= endPosition() || entry.step <= cursor);
  const caption = reached.flatMap((entry, index) => wrapWords(`${index + 1}. ${entry.step === 0 ? 'at the start' : `after step ${entry.step}`}: ${entry.label} (${entry.state})`, 11.5, column));
  const ending = machine.process && (!overlay || cursor >= endPosition()) ? wrapWords(`${who} ends ${machine.process.status}: ${machine.process.description}`, 11.5, column) : [];
  const lines = [...caption, ...ending];
  const height = head + vh + margin + (lines.length ? lines.length * 16 + 10 : 0) + 16;
  const content = drawing.cloneNode(true) as SVGSVGElement;
  const text = (cls: string, value: string, y: number): string => `<text class="${cls}" x="${margin}" y="${y.toFixed(1)}">${escapeText(value)}</text>`;
  const marker = canvas.querySelector('#pj-sm-arrow')?.outerHTML ?? '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!-- generated by processj-lsp: a process's state machine in the CSP model -->\n<svg xmlns="http://www.w3.org/2000/svg" class="pj-net" viewBox="0 0 ${width} ${height}" width="${Math.ceil(width)}" height="${Math.ceil(height)}"><title>${escapeText(titleText)}</title><style>${plainStyle(payload.style)}</style><defs>${marker}</defs><rect class="pj-bg" x="0" y="0" width="${width}" height="${height}"/>${text('pj-title', titleText, 28)}${subtitleLines.map((line, index) => text('pj-subtitle', line, 47 + index * 16)).join('')}<g transform="translate(${margin} ${head})">${content.innerHTML}</g>${lines.map((line, index) => text('pj-caption-text', line, head + vh + margin + 12 + index * 16)).join('')}</svg>\n`;
}

/** The step marks drawn by this page (line chips, tokens, how it locked), in light colours. */
const EXPORT_EXTRA = '.pj-line-chip text, .pj-token text { font-size: 10.5px; font-weight: 700; fill: #ffffff; } .pj-token rect { fill: #0f172a; } .pj-token-hidden rect { fill: #64748b; } .pj-current .pj-box, .pj-current .pj-group-box { stroke: #2563eb; stroke-width: 2.4; } .pj-edge.pj-current .pj-edge-line { stroke: #2563eb; stroke-width: 2.6; } .pj-done { opacity: 0.4; } .pj-now-ring { fill: none; stroke: #dc2626; stroke-width: 3; } .pj-partner-ring { fill: none; stroke: #dc2626; stroke-width: 1.8; stroke-dasharray: 6 4; } .pj-now-edge { fill: none; stroke: #dc2626; stroke-width: 5; stroke-linecap: round; opacity: 0.75; }';

function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function exportName(suffix: string): string {
  const stem = payload.title.replace(/\.pj$/, '');
  const part = view.kind === 'program' ? '' : `.${view.procedure}`;
  return `${stem}${part}${suffix}`;
}

function save(name: string, data: string | Blob, mime: string): void {
  if (vscode) {
    if (typeof data === 'string') {
      vscode.postMessage({ type: 'export', name, data, encoding: 'utf8' });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      vscode.postMessage({ type: 'export', name, data: result.slice(result.indexOf(',') + 1), encoding: 'base64' });
    };
    reader.readAsDataURL(data);
    return;
  }
  const blob = typeof data === 'string' ? new Blob([data], { type: mime }) : data;
  const url = URL.createObjectURL(blob);
  const anchor = h('a', { href: url, download: name });
  document.body.append(anchor);
  anchor.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
    anchor.remove();
  }, 2000);
  showToast(`Saved ${name}`);
}

function exportAs(format: string): void {
  if (view === EMPTY_VIEW || view.pending) {
    showToast(view === EMPTY_VIEW ? 'Nothing to export yet: this file has no procedure with a body.' : 'This view is not laid out yet.');
    return;
  }
  switch (format) {
    case 'svg':
      save(exportName('.graph.svg'), currentSvg(), 'image/svg+xml');
      return;
    case 'png': {
      const text = currentSvg();
      const width = Number(/width="(\d+)"/.exec(text)?.[1] ?? 800);
      const height = Number(/height="(\d+)"/.exec(text)?.[1] ?? 600);
      const image = new Image();
      image.onload = () => {
        const scale = 2;
        const target = document.createElement('canvas');
        target.width = width * scale;
        target.height = height * scale;
        const context = target.getContext('2d');
        if (!context) return;
        context.scale(scale, scale);
        context.drawImage(image, 0, 0, width, height);
        target.toBlob((blob) => {
          if (blob) save(exportName('.graph.png'), blob, 'image/png');
        }, 'image/png');
      };
      image.onerror = () => showToast('This page could not draw the PNG; export SVG instead.');
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
      return;
    }
    case 'excalidraw': {
      const input = overlay && cursor >= endPosition() ? overlay.excalidraw : view.excalidraw;
      save(exportName('.graph.excalidraw'), `${JSON.stringify(buildExcalidrawScene(input), null, 2)}\n`, 'application/json');
      return;
    }
    case 'json': {
      const data = { generator: 'processj-lsp', title: payload.title, uri: payload.uri, view: { ...view, svg: undefined, excalidraw: undefined }, reports: payload.reports, overlay: overlay ? { ...overlay, under: undefined, over: undefined, excalidraw: undefined } : undefined };
      save(exportName('.graph.json'), `${JSON.stringify(data, null, 2)}\n`, 'application/json');
      return;
    }
    case 'machine': {
      const machine = shownMachine();
      const drawing = machinePane.querySelector<SVGSVGElement>('svg.pj-sm-svg');
      if (!machine || !drawing) {
        showToast('Open a process\'s state machine first (double-click its box).');
        return;
      }
      save(`${payload.title.replace(/\.pj$/, '')}.${machine.procedure}.machine.svg`, machineSvg(machine, drawing), 'image/svg+xml');
      return;
    }
    case 'chart': {
      // The chart itself, not the copy of its lane heads that stays at the top while it scrolls.
      const chart = chartPane.querySelector<SVGSVGElement>('svg.pj-msc:not(.pj-msc-sticky)');
      if (!chart) {
        showToast('Select a result with a counterexample first.');
        return;
      }
      const clone = chart.cloneNode(true) as SVGSVGElement;
      for (const element of clone.querySelectorAll('.pj-current')) element.classList.remove('pj-current');
      const style = clone.querySelector('style');
      if (style) style.textContent = (style.textContent ?? '').replace(/var\(--pj-msc-[a-z-]+, ([^)]+\)?)\)/g, '$1');
      save(exportName('.sequence.svg'), `<?xml version="1.0" encoding="UTF-8"?>\n<!-- generated by processj-lsp: counterexample sequence chart -->\n${new XMLSerializer().serializeToString(clone)}\n`, 'image/svg+xml');
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function applyToggles(): void {
  canvas.classList.toggle('pj-hide-labels', !toggles.labels);
  canvas.classList.toggle('pj-hide-types', !toggles.types);
  canvas.classList.toggle('pj-hide-conditional', !toggles.conditional);
  remember('toggles', JSON.stringify(toggles));
}

function wireControls(): void {
  viewSelect.addEventListener('change', () => showView(viewSelect.value));
  searchInput.addEventListener('input', () => applySearch(true));
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      nextMatch(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      searchInput.value = '';
      applySearch(false);
      searchInput.blur();
    }
  });
  $('zoom-in').addEventListener('click', () => zoomCenter(1.25));
  $('zoom-out').addEventListener('click', () => zoomCenter(0.8));
  $('zoom-fit').addEventListener('click', () => fit(true));
  zoomLabel.addEventListener('click', () => actualSize());
  for (const key of ['labels', 'types', 'conditional'] as const) {
    const input = $<HTMLInputElement>(`toggle-${key}`);
    input.checked = toggles[key];
    input.addEventListener('change', () => {
      toggles[key] = input.checked;
      applyToggles();
    });
  }
  const exportButton = $('export-button');
  const exportMenu = $('export-menu');
  exportButton.addEventListener('click', () => {
    exportMenu.hidden = !exportMenu.hidden;
    exportButton.setAttribute('aria-expanded', String(!exportMenu.hidden));
  });
  for (const item of exportMenu.querySelectorAll<HTMLButtonElement>('[data-format]')) {
    item.addEventListener('click', () => {
      exportMenu.hidden = true;
      exportButton.setAttribute('aria-expanded', 'false');
      exportAs(item.dataset.format!);
    });
  }
  document.addEventListener('click', (event) => {
    if (!exportMenu.hidden && !(event.target as Element).closest('#export-button, #export-menu')) exportMenu.hidden = true;
  });
  $('details-button').addEventListener('click', () => setDrawer(!document.body.classList.contains('panel-open')));
  // The dock: drag its top edge (or use the arrow keys on it) to give the network more room, or fold it away.
  const resizer = $('dock-resize');
  const setDockHeight = (pixels: number): void => {
    const height = Math.round(Math.max(120, Math.min(window.innerHeight * 0.6, pixels)));
    dock.style.setProperty('--dock-height', `${height}px`);
    dock.style.maxHeight = '60vh';
    remember('dock-height', String(height));
  };
  resizer.addEventListener('pointerdown', (event) => {
    resizer.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = dock.getBoundingClientRect().height;
    const move = (moveEvent: PointerEvent): void => setDockHeight(startHeight + startY - moveEvent.clientY);
    const up = (): void => {
      resizer.removeEventListener('pointermove', move);
      resizer.removeEventListener('pointerup', up);
    };
    resizer.addEventListener('pointermove', move);
    resizer.addEventListener('pointerup', up);
  });
  resizer.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    setDockHeight(dock.getBoundingClientRect().height + (event.key === 'ArrowUp' ? 40 : -40));
  });
  const savedHeight = Number(recall('dock-height'));
  if (savedHeight > 0) {
    dock.style.setProperty('--dock-height', `${savedHeight}px`);
    dock.style.maxHeight = '60vh';
  }
  const collapse = $('dock-collapse');
  const setCollapsed = (collapsed: boolean): void => {
    dock.classList.toggle('collapsed', collapsed);
    collapse.setAttribute('aria-expanded', String(!collapsed));
    remember('dock-collapsed', String(collapsed));
  };
  collapse.addEventListener('click', () => setCollapsed(!dock.classList.contains('collapsed')));
  if (recall('dock-collapsed') === 'true') setCollapsed(true);
  $('legend-button').addEventListener('click', () => {
    const legend = $('legend');
    legend.hidden = !legend.hidden;
  });
  $('code-button').addEventListener('click', () => {
    codeOpen = !codeOpen;
    if (codeOpen) dockTab = 'code';
    renderDock();
    if (selection?.type === 'node') scrollCodeToNode(selection.id);
  });
  $('play').addEventListener('click', () => play());
  // A long account of the step (or of the end state) is cut at two lines: a click shows all of it.
  stepText.addEventListener('click', () => stepText.classList.toggle('expanded'));
  $('step-back').addEventListener('click', () => {
    stopPlaying();
    setCursor(cursor - 1, false);
  });
  $('step-forward').addEventListener('click', () => {
    stopPlaying();
    setCursor(cursor + 1, true);
  });
  $('to-start').addEventListener('click', () => {
    stopPlaying();
    setCursor(0, false);
  });
  $('to-end').addEventListener('click', () => {
    stopPlaying();
    setCursor(endPosition(), false);
  });
  const speedSelect = $<HTMLSelectElement>('speed');
  speedSelect.addEventListener('change', () => {
    speed = Number(speedSelect.value) || 1;
  });
  $('tab-code').addEventListener('click', () => setTab('code'));
  $('tab-chart').addEventListener('click', () => setTab('chart'));
  $('tab-machine').addEventListener('click', () => setTab('machine'));
  document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement;
    const typing = target.matches('input, select, textarea');
    if (typing) return;
    if (event.metaKey || event.ctrlKey || event.altKey) {
      if ((event.key === 'f' || event.key === 'F') && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        searchInput.focus();
        searchInput.select();
      }
      return;
    }
    switch (event.key) {
      case '/':
        event.preventDefault();
        searchInput.focus();
        searchInput.select();
        return;
      case '+':
      case '=':
        zoomCenter(1.25);
        return;
      case '-':
      case '_':
        zoomCenter(0.8);
        return;
      case '0':
        fit(true);
        return;
      case '1':
        actualSize();
        return;
      case 'Escape':
        if (document.body.classList.contains('panel-open')) setDrawer(false);
        else if (selection) select(undefined);
        else if (active) activate(undefined);
        return;
      case ' ':
        if (overlay && endPosition() > 0 && !target.matches('button')) {
          event.preventDefault();
          play();
        }
        return;
      case 'ArrowLeft':
      case 'ArrowRight':
        // With a replay shown, left and right step it (Shift pans the network instead).
        if (overlay && endPosition() > 0 && !event.shiftKey) {
          event.preventDefault();
          stopPlaying();
          setCursor(cursor + (event.key === 'ArrowRight' ? 1 : -1), event.key === 'ArrowRight');
          return;
        }
        break;
      case ']':
      case '.':
        stopPlaying();
        setCursor(cursor + 1, true);
        return;
      case '[':
      case ',':
        stopPlaying();
        setCursor(cursor - 1, false);
        return;
      case 'Home':
        stopPlaying();
        setCursor(0, false);
        return;
      case 'End':
        stopPlaying();
        setCursor(endPosition(), false);
        return;
    }
    if (!target.closest('#stage')) return;
    const pan = 60;
    const moves: Record<string, [number, number]> = { ArrowLeft: [pan, 0], ArrowRight: [-pan, 0], ArrowUp: [0, pan], ArrowDown: [0, -pan] };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      transform = { ...transform, x: transform.x + move[0], y: transform.y + move[1] };
      userMoved = true;
      applyTransform();
    }
  });
  const savedTab = recall('tab');
  if (savedTab === 'chart' || savedTab === 'code') dockTab = savedTab;
  try {
    const saved = JSON.parse(recall('toggles') ?? '{}') as Partial<typeof toggles>;
    for (const key of ['labels', 'types', 'conditional'] as const) if (typeof saved[key] === 'boolean') toggles[key] = saved[key]!;
  } catch {
    /* ignore a corrupt preference */
  }
  for (const key of ['labels', 'types', 'conditional'] as const) $<HTMLInputElement>(`toggle-${key}`).checked = toggles[key];
  applyToggles();
}

// ---------------------------------------------------------------------------
// Updates from the editor
// ---------------------------------------------------------------------------

/** A chip's identity across payloads: producer and check (report indexes can shift). */
function chipKey(chip: Chip): string {
  return `${chip.producer}:${chip.check}`;
}

function applyPayload(next: Payload): void {
  const previousView = view === EMPTY_VIEW ? undefined : view.id;
  const previousChip = active ? payload.chips.find((chip) => chip.report === active!.report && chip.check === active!.check) : undefined;
  const previousFailures = new Set(payload.chips.filter((chip) => chip.status === 'failed').map(chipKey));
  const wasAtEnd = !!overlay && cursor >= endPosition();
  const previousCursor = cursor;
  // A state machine is of one version of the model, and its run of one result: asked again only when either changed.
  const sameModel = next.documentVersion === payload.documentVersion && JSON.stringify(next.reports.filter((report) => report.producer === 'fdr')) === JSON.stringify(payload.reports.filter((report) => report.producer === 'fdr'));
  payload = next;
  if (!sameModel) machineCache.clear();
  buildCode();
  $('title').textContent = payload.title;
  const target = payload.views.find((entry) => entry.id === previousView) ?? payload.views.find((entry) => entry.id === payload.defaultView) ?? payload.views[0] ?? EMPTY_VIEW;
  view = target;
  populateViews();
  const kept = previousChip ? payload.chips.find((chip) => chipKey(chip) === chipKey(previousChip)) : undefined;
  active = kept ? { report: kept.report, check: kept.check } : undefined;
  showView(target.id);
  renderVerdicts();
  if (active) {
    overlay = payload.overlays.find((entry) => entry.view === view.id && entry.report === active!.report && entry.check === active!.check);
    cursor = overlay ? wasAtEnd ? endPosition() : Math.min(previousCursor, endPosition()) : 0;
  }
  renderOverlayState(false);
  renderDock();
  renderPanel();
  if (machineShown && !sameModel) loadMachine(machineShown.request);
  root.dataset.updated = payload.generatedAt;
  // A failure that was not there before (a model checker just published): show it, or point at it.
  // Only a model checker's: the checker's own results come and go with every edit.
  const fresh = payload.chips.find((chip) => chip.producer !== 'checker' && chip.status === 'failed' && chip.severity !== 'info' && chip.views.length && !previousFailures.has(chipKey(chip)));
  if (!fresh) return;
  if (!active || previousChip?.producer === 'checker') activate({ report: fresh.report, check: fresh.check });
  else {
    showToast(`${fresh.producer === 'fdr' ? 'FDR' : 'The checker'}: ${fresh.label}, ${fresh.text}. Its chip is above.`);
    const index = payload.chips.indexOf(fresh);
    const chip = verdicts.querySelectorAll<HTMLElement>('.chip')[index];
    chip?.classList.add('fresh');
    window.setTimeout(() => chip?.classList.remove('fresh'), 4000);
  }
}

/**
 * Show what an editor asked for: a check (its result's view, at the end state)
 * and a process of it, selected, with its state machine open.
 */
function applyFocus(focus: Focus | undefined, announce = false): void {
  if (!focus) return;
  const chip = focus.check !== undefined ? payload.chips.find((entry) => entry.check === focus.check) : undefined;
  if (chip) {
    if (!active || active.report !== chip.report || active.check !== chip.check) activate({ report: chip.report, check: chip.check });
    if (announce) showToast(`${chip.producer === 'fdr' ? 'FDR' : 'The checker'}: ${chip.targetLabel ? `${chip.targetLabel}, ` : ''}${chip.label}: ${chip.text}`);
  }
  if (focus.process === undefined || !overlay) return;
  const placed = overlay.processes.find((entry) => entry.key === focus.process);
  if (!placed) return;
  // In a narrow window the drawer would cover the network the editor asked to show: it stays shut.
  select({ type: 'node', id: placed.node }, true, false);
  if (nodeById.get(placed.node)?.machine) openMachine(placed.node, placed.key);
}

/** The focus an update event carries (live server: `{"at": ..., "focus": {...}}`). */
function focusOf(data: unknown): Focus | undefined {
  try {
    const parsed = JSON.parse(String(data)) as { focus?: Focus };
    return parsed && typeof parsed === 'object' && parsed.focus && typeof parsed.focus === 'object' ? parsed.focus : undefined;
  } catch {
    return undefined;
  }
}

let liveSource: EventSource | undefined;

function refresh(focus?: Focus): void {
  void fetch(`${LIVE_BASE}payload`)
    .then(async (response) => {
      // The document was closed in the editor: what is shown is its last state, and its results are gone.
      if (response.status === 410) {
        const said = await response.json().then((body: { error?: unknown }) => (typeof body.error === 'string' ? body.error : undefined), () => undefined);
        setLiveState(false, `${said ?? 'This document is no longer open in the editor.'} The page shows it as it was; open the file again to follow it.`);
        $('closed-banner').hidden = false;
        return undefined;
      }
      if (!response.ok) throw new Error(String(response.status));
      return response.json() as Promise<Payload>;
    })
    .then((next) => {
      if (!next) return;
      $('closed-banner').hidden = true;
      setLiveState(true);
      applyPayload(next);
      // What the editor asked for while this page was in the background comes with the payload.
      applyFocus(focus ?? next.focus, true);
    })
    .catch(() => showToast('Could not refresh the graph'));
}

function setLiveState(online: boolean, why?: string): void {
  const dot = $('live-state');
  dot.classList.toggle('offline', !online);
  dot.title = online ? 'Live: follows your edits and new results' : why ?? 'Not connected: the language server stopped, or restarted on another address. Open the graph from the editor again for a live page.';
}

/**
 * Follow the buffer over Server-Sent Events while the page is visible. A hidden
 * page lets go of its stream (a browser keeps only six connections per server,
 * and every open graph page shares this one) and checks in every 30 s
 * instead, so the editor knows it is still open: a result it is asked to show
 * meanwhile waits for it. Shown again, it catches up first; closed, it says so.
 */
function connectLive(): void {
  if (MODE !== 'live' || typeof EventSource === 'undefined') return;
  let checkIns: number | undefined;
  const checkIn = (): void => {
    void fetch(`${LIVE_BASE}ping`, { method: 'POST' }).catch(() => undefined);
  };
  const open = (): void => {
    if (liveSource) return;
    const source = new EventSource(`${LIVE_BASE}events`);
    liveSource = source;
    source.addEventListener('update', (event) => refresh(focusOf((event as MessageEvent).data)));
    source.addEventListener('error', () => setLiveState(false));
    source.addEventListener('open', () => setLiveState(true));
  };
  const close = (): void => {
    liveSource?.close();
    liveSource = undefined;
  };
  const stopCheckIns = (): void => {
    if (checkIns !== undefined) window.clearInterval(checkIns);
    checkIns = undefined;
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      close();
      checkIn();
      stopCheckIns();
      checkIns = window.setInterval(checkIn, 30_000);
    } else {
      stopCheckIns();
      if (!liveSource) {
        open();
        refresh();
      }
    }
  });
  window.addEventListener('pagehide', () => {
    close();
    stopCheckIns();
    // Closed (or left): the editor opens a new page for the next result.
    navigator.sendBeacon?.(`${LIVE_BASE}gone`);
  });
  if (document.visibilityState !== 'hidden') open();
  else {
    checkIn();
    checkIns = window.setInterval(checkIn, 30_000);
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string; payload?: Payload; view?: VView; focus?: Focus; machine?: Machine | MachineError } | undefined;
  if (vscode && data?.type === 'update' && data.payload) {
    applyPayload(data.payload);
    applyFocus(data.focus, !!data.focus);
  }
  if (vscode && data?.type === 'focus') applyFocus(data.focus, true);
  if (vscode && data?.type === 'view' && data.view) receiveView(data.view);
  if (vscode && data?.type === 'machine' && data.machine) receiveMachine(data.machine);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

function start(): void {
  $('title').textContent = payload.title;
  populateViews();
  buildCode();
  wireControls();
  renderVerdicts();
  showView(view.id, { fit: true });
  renderDock();
  connectLive();
  // Open on the first failure, so the problem is the first thing on screen. Not on a result that only
  // informs (a program meant to run forever does not terminate): its chip shows it on a click.
  const failure = payload.chips.find((chip) => chip.status === 'failed' && chip.severity === 'error' && chip.views.length)
    ?? payload.chips.find((chip) => chip.status === 'failed' && chip.severity !== 'info' && chip.views.length);
  // An editor's focus: in the URL (live page), else in the page (a file, VS Code).
  const params = new URLSearchParams(location.search);
  const requested: Focus | undefined = params.has('check') || params.has('process') ? { check: params.get('check') ?? undefined, process: params.get('process') ?? undefined } : payload.focus;
  const chosen = requested?.check !== undefined ? payload.chips.find((chip) => chip.check === requested.check) ?? failure : failure;
  if (chosen && root.dataset.autoselect !== 'false') activate({ report: chosen.report, check: chosen.check });
  if (requested && root.dataset.autoselect !== 'false') applyFocus(requested);
  root.dataset.ready = 'true';
}

// A failure of this script is recorded on the page, where a test (or a curious user) can read it.
window.addEventListener('error', (event) => {
  root.dataset.error = String(event.message ?? event.error);
});

start();
