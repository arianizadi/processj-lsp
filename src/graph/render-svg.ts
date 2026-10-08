/**
 * Standalone SVG of one laid-out view: processes as rounded boxes, pars and
 * procedures as labelled translucent groups, channels as arrows from writer to
 * reader with their name and element type on a pill, junctions where several
 * processes share a side, barriers joined by dashed links, boundary ports in a
 * procedure view. With an overlay, the final state of a counterexample is drawn
 * in: stuck processes and the operation they wait on, finished processes faded,
 * circular waits in bold red.
 *
 * Colours are CSS custom properties with a light default and a white
 * background, so an exported file reads well on paper; the viewer redefines them
 * for dark themes. Every piece of text is escaped.
 */
import { FONT_STACK, METRICS, edgeLabelText, groupHeaderWidth, junctionLabelText, textWidth, type Box, type LaidOutNode, type Point, type ViewLayout } from './layout';
import { countText, truncate, viewProcesses, type NetEdge, type NetNode, type NetworkView } from './network';
import { firstArgument, type OverlayModel } from './overlay';
import { escapeXml, num, pointAlong, polylineLength, roundedPath } from './svg';

export interface SvgOptions {
  /** File name for the title row. */
  title?: string;
  overlay?: OverlayModel;
  legend?: boolean;
  /** Prefix for ids (markers), unique per SVG on one page. */
  idPrefix?: string;
  /** XML declaration and generator comment (default true). */
  standalone?: boolean;
  showTypes?: boolean;
  /** Read colours from `--pj-*` custom properties (the viewer); plain light colours otherwise. */
  themed?: boolean;
}

const MARGIN = 20;

/** Light theme, used as is in exported files; the viewer overrides each colour through `--pj-<name>`. */
export const LIGHT_THEME = {
  bg: '#ffffff',
  text: '#0f172a',
  muted: '#64748b',
  faint: '#94a3b8',
  'process-fill': '#ffffff',
  'process-stroke': '#94a3b8',
  shadow: 'rgba(15, 23, 42, 0.08)',
  'root-fill': '#f8fafc',
  'root-stroke': '#cbd5e1',
  'par-fill': 'rgba(99, 102, 241, 0.045)',
  'par-stroke': '#c7d2fe',
  'call-fill': 'rgba(14, 165, 233, 0.05)',
  'call-stroke': '#a5d8f3',
  'rep-fill': 'rgba(16, 185, 129, 0.05)',
  'rep-stroke': '#a7e3cc',
  count: '#047857',
  'badge-fill': '#eef2ff',
  'badge-text': '#4338ca',
  'call-badge-fill': '#e0f2fe',
  'call-badge-text': '#0369a1',
  edge: '#475569',
  'label-fill': '#ffffff',
  'label-stroke': '#dbe2ea',
  barrier: '#b45309',
  'barrier-fill': '#fffbeb',
  'port-fill': '#f1f5f9',
  danger: '#dc2626',
  /** Fill behind white text: as dark as `danger` in light themes, darker in dark ones. */
  'danger-strong': '#dc2626',
  'danger-fill': '#fef2f2',
  'danger-soft': 'rgba(220, 38, 38, 0.28)',
  ok: '#15803d',
  'ok-fill': '#f0fdf4',
  warn: '#b45309',
  'warn-fill': '#fffbeb',
  info: '#2563eb',
  loop: '#7c3aed',
  'loop-strong': '#7c3aed',
  'loop-fill': '#f5f3ff',
  veil: 'rgba(255, 255, 255, 0.62)',
} as const;

export type ThemeColor = keyof typeof LIGHT_THEME;

/**
 * The stylesheet of a network SVG. `plain` writes the light colours directly, for
 * files read by tools without CSS custom properties (librsvg, Inkscape,
 * Illustrator); `themed` reads `--pj-<name>` with the light colour as fallback.
 */
export function svgStyle(mode: 'plain' | 'themed' = 'plain'): string {
  const c = (name: ThemeColor): string => mode === 'plain' ? LIGHT_THEME[name] : `var(--pj-${name}, ${LIGHT_THEME[name]})`;
  return `
.pj-net { font-family: ${FONT_STACK}; }
.pj-net text { font-family: ${FONT_STACK}; }
.pj-bg { fill: ${c('bg')}; }
.pj-title { font-size: 15px; font-weight: 600; fill: ${c('text')}; }
.pj-subtitle { font-size: 11.5px; fill: ${c('muted')}; }
.pj-group-box { stroke-width: 1.2; }
.pj-group-procedure .pj-group-box { fill: ${c('root-fill')}; stroke: ${c('root-stroke')}; }
.pj-group-par .pj-group-box, .pj-group-branch .pj-group-box { fill: ${c('par-fill')}; stroke: ${c('par-stroke')}; stroke-dasharray: 5 3; }
.pj-group-call .pj-group-box { fill: ${c('call-fill')}; stroke: ${c('call-stroke')}; }
.pj-group-par-for .pj-group-box { fill: ${c('rep-fill')}; stroke: ${c('rep-stroke')}; }
.pj-stack { fill: ${c('process-fill')}; stroke: ${c('process-stroke')}; stroke-width: 1; }
.pj-group-title { font-size: ${METRICS.groupLabelSize}px; font-weight: 600; fill: ${c('text')}; }
.pj-group-detail { font-size: ${METRICS.detailSize}px; fill: ${c('muted')}; }
.pj-group-title-bg { fill: ${c('bg')}; opacity: 0.88; }
.pj-box { fill: ${c('process-fill')}; stroke: ${c('process-stroke')}; stroke-width: 1.3; }
.pj-shadow { fill: ${c('shadow')}; }
.pj-label { font-size: ${METRICS.labelSize}px; font-weight: 600; fill: ${c('text')}; }
.pj-detail { font-size: ${METRICS.detailSize}px; fill: ${c('muted')}; }
.pj-badge-box { fill: ${c('badge-fill')}; }
.pj-badge { font-size: ${METRICS.badgeSize}px; font-weight: 700; letter-spacing: 0.6px; fill: ${c('badge-text')}; }
.pj-badge-call .pj-badge-box { fill: ${c('call-badge-fill')}; }
.pj-badge-call .pj-badge { fill: ${c('call-badge-text')}; }
.pj-count-box { fill: ${c('rep-fill')}; stroke: ${c('rep-stroke')}; }
.pj-count { font-size: ${METRICS.badgeSize + 1}px; font-weight: 700; fill: ${c('count')}; }
.pj-uncertain .pj-box { stroke-dasharray: 4 3; }
.pj-edge-line { fill: none; stroke: ${c('edge')}; stroke-width: 1.6; }
.pj-edge-conditional .pj-edge-line { stroke-dasharray: 7 4; }
.pj-edge-unknown .pj-edge-line { stroke-dasharray: 2 4; stroke: ${c('faint')}; }
.pj-edge-barrier .pj-edge-line { stroke: ${c('barrier')}; stroke-dasharray: 3 3; stroke-width: 1.4; }
.pj-edge-dangling .pj-edge-line { stroke: ${c('faint')}; }
.pj-arrow { fill: ${c('edge')}; }
.pj-edge-unknown .pj-arrow, .pj-edge-dangling .pj-arrow { fill: ${c('faint')}; }
.pj-edge-label-box { fill: ${c('label-fill')}; stroke: ${c('label-stroke')}; }
.pj-edge-label { font-size: ${METRICS.edgeLabelSize}px; fill: ${c('text')}; }
.pj-edge-label .pj-name { font-weight: 600; }
.pj-edge-label .pj-type, .pj-edge-label .pj-tag { fill: ${c('muted')}; }
.pj-junction { fill: ${c('edge')}; stroke: ${c('bg')}; stroke-width: 2; }
.pj-junction-label { font-size: ${METRICS.edgeLabelSize}px; fill: ${c('text')}; }
.pj-barrier-box { fill: ${c('barrier-fill')}; stroke: ${c('barrier')}; stroke-width: 1.6; }
.pj-barrier-bar { fill: ${c('barrier')}; }
.pj-barrier-label { font-size: ${METRICS.labelSize - 1}px; font-weight: 600; fill: ${c('barrier')}; }
.pj-port-box { fill: ${c('port-fill')}; stroke: ${c('process-stroke')}; stroke-width: 1.3; }
.pj-port-label { font-size: ${METRICS.labelSize - 1}px; font-weight: 600; fill: ${c('text')}; }
.pj-stub-box { fill: none; stroke: ${c('faint')}; stroke-dasharray: 3 3; }
.pj-stub-label { font-size: ${METRICS.detailSize}px; fill: ${c('muted')}; }
.pj-stub-proven .pj-stub-box { stroke: ${c('danger')}; }
.pj-stub-proven .pj-stub-label { fill: ${c('danger')}; font-weight: 600; }
.pj-legend-text { font-size: 11px; fill: ${c('muted')}; }
.pj-caption-text { font-size: 11.5px; fill: ${c('text')}; }
.pj-legend-line { fill: none; stroke: ${c('edge')}; stroke-width: 1.6; }
.pj-ov-halo { fill: none; stroke: ${c('danger-soft')}; stroke-width: 7; animation: pj-pulse 1.8s ease-in-out infinite; }
.pj-ov-blocked { fill: none; stroke: ${c('danger')}; stroke-width: 2.4; }
.pj-ov-blocked.pj-ov-behind { stroke: ${c('warn')}; stroke-width: 2; }
.pj-ov-veil { fill: ${c('veil')}; }
.pj-ov-badge-box { stroke-width: 1.2; }
.pj-ov-badge { font-size: 11px; font-weight: 700; }
.pj-ov-blocked-badge .pj-ov-badge-box { fill: ${c('danger-strong')}; stroke: ${c('danger-strong')}; }
.pj-ov-blocked-badge .pj-ov-badge, .pj-ov-blocked-badge .pj-ov-pause rect { fill: #ffffff; }
.pj-ov-behind-badge .pj-ov-badge-box { fill: ${c('warn-fill')}; stroke: ${c('warn')}; }
.pj-ov-behind-badge .pj-ov-badge, .pj-ov-behind-badge .pj-ov-pause rect { fill: ${c('warn')}; }
.pj-ov-done-badge .pj-ov-badge-box { fill: ${c('ok-fill')}; stroke: ${c('ok')}; }
.pj-ov-done-badge .pj-ov-badge { fill: ${c('ok')}; }
.pj-ov-error-badge .pj-ov-badge-box { fill: ${c('warn-fill')}; stroke: ${c('warn')}; }
.pj-ov-error-badge .pj-ov-badge { fill: ${c('warn')}; }
.pj-ov-fail-badge .pj-ov-badge-box { fill: ${c('danger-strong')}; stroke: ${c('danger-strong')}; }
.pj-ov-fail-badge .pj-ov-badge { fill: #ffffff; }
.pj-ov-fail-badge .pj-ov-icon-warn { stroke: #ffffff; }
.pj-ov-choice-badge .pj-ov-badge-box { fill: ${c('info')}; stroke: ${c('info')}; }
.pj-ov-choice-badge .pj-ov-badge { fill: #ffffff; }
.pj-ov-choice-badge .pj-ov-icon-info { fill: #ffffff; }
.pj-ov-loop-badge .pj-ov-badge-box { fill: ${c('loop-fill')}; stroke: ${c('loop')}; }
.pj-ov-loop-badge .pj-ov-badge { fill: ${c('loop')}; }
.pj-ov-info-badge .pj-ov-badge-box { fill: ${c('bg')}; stroke: ${c('info')}; }
.pj-ov-info-badge .pj-ov-badge { fill: ${c('info')}; }
.pj-ov-icon { fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.pj-ov-icon-ok { stroke: ${c('ok')}; }
.pj-ov-icon-warn { stroke: ${c('warn')}; }
.pj-ov-icon-loop { stroke: ${c('loop')}; }
.pj-ov-icon-info { fill: ${c('info')}; }
.pj-arrow-faint { fill: ${c('faint')}; }
.pj-arrow-danger { fill: ${c('danger')}; }
.pj-arrow-behind { fill: ${c('warn')}; }
.pj-legend-faint { stroke: ${c('faint')}; }
.pj-legend-stuck { stroke: ${c('danger')}; stroke-width: 2.2; }
.pj-legend-behind { stroke: ${c('warn')}; stroke-width: 2; }
.pj-legend-running { stroke: ${c('info')}; stroke-width: 2; }
.pj-legend-cycle { fill: none; stroke: ${c('danger')}; stroke-width: 3; stroke-dasharray: 7 4; }
.pj-legend-loop { fill: none; stroke: ${c('loop')}; stroke-width: 2.6; stroke-dasharray: 7 4; }
.pj-legend-unenrolled { fill: none; stroke: ${c('warn')}; stroke-width: 1.6; stroke-dasharray: 1.5 3; }
.pj-ov-stuck-edge { fill: none; stroke: ${c('danger')}; stroke-width: 2.6; }
.pj-ov-stuck-edge.pj-ov-behind { stroke: ${c('warn')}; stroke-width: 2.2; }
.pj-ov-stuck-edge.pj-ov-loop { stroke: ${c('loop')}; stroke-width: 2.8; stroke-dasharray: 9 6; animation: pj-flow 0.9s linear infinite; }
.pj-ov-cycle-edge { fill: none; stroke: ${c('danger')}; stroke-width: 3.2; stroke-dasharray: 9 6; stroke-linecap: round; animation: pj-flow 0.9s linear infinite; }
.pj-ov-cycle-route { fill: none; stroke: ${c('danger-soft')}; stroke-width: 10; stroke-linecap: round; stroke-linejoin: round; }
.pj-ov-waits-for { fill: none; stroke-width: 1.6; stroke-dasharray: 4 4; }
.pj-ov-waits-for.pj-ov-root { stroke: ${c('danger')}; }
.pj-ov-waits-for.pj-ov-behind { stroke: ${c('warn')}; }
.pj-ov-marker { fill: ${c('danger-strong')}; stroke: ${c('bg')}; stroke-width: 2; }
.pj-ov-behind .pj-ov-marker { fill: ${c('warn')}; }
.pj-ov-marker-bar { fill: #ffffff; }
.pj-ov-reason-box { fill: ${c('danger-fill')}; stroke: ${c('danger')}; stroke-width: 1; }
.pj-ov-reason { font-size: 10.5px; fill: ${c('danger')}; font-weight: 600; }
.pj-ov-behind .pj-ov-reason-box { fill: ${c('warn-fill')}; stroke: ${c('warn')}; }
.pj-ov-behind .pj-ov-reason { fill: ${c('warn')}; }
.pj-ov-leader { fill: none; stroke: ${c('danger')}; stroke-width: 1; stroke-dasharray: 2 2; }
.pj-ov-behind .pj-ov-leader { stroke: ${c('warn')}; }
.pj-ov-callout-box { fill: ${c('danger-strong')}; }
.pj-ov-loop .pj-ov-callout-box { fill: ${c('loop-strong')}; }
.pj-ov-callout { font-size: 11.5px; font-weight: 700; fill: #ffffff; }
.pj-ov-running { fill: none; stroke: ${c('info')}; stroke-width: 2; }
.pj-ov-running.pj-ov-loop { stroke: ${c('loop')}; stroke-width: 2.4; }
.pj-ov-approx { stroke-dasharray: 5 3; }
.pj-ov-stale { opacity: 0.5; }
.pj-ov-stale .pj-ov-blocked, .pj-ov-stale .pj-ov-stuck-edge { stroke-dasharray: 6 4; }
.pj-ov-stale .pj-ov-halo, .pj-ov-stale .pj-ov-cycle-edge, .pj-ov-stale .pj-ov-stuck-edge { animation: none; }
.pj-edge-barrier.pj-edge-unenrolled .pj-edge-line { stroke: ${c('warn')}; stroke-dasharray: 1.5 3; stroke-width: 1.8; }
.pj-edge-unenrolled-label .pj-edge-label-box { stroke: ${c('warn')}; fill: ${c('warn-fill')}; }
.pj-edge-unenrolled-label .pj-edge-label { fill: ${c('warn')}; font-weight: 600; }
@keyframes pj-pulse { 0%, 100% { opacity: 0.9; } 50% { opacity: 0.25; } }
@keyframes pj-flow { to { stroke-dashoffset: -30; } }
@media (prefers-reduced-motion: reduce) { .pj-ov-halo, .pj-ov-cycle-edge, .pj-ov-stuck-edge { animation: none; } }
`;
}

export interface SvgExtent {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** A complete standalone SVG document for one view. */
export function renderNetworkSvg(view: NetworkView, layout: ViewLayout, options: SvgOptions = {}): string {
  const prefix = options.idPrefix ?? 'pj';
  const extent: SvgExtent = { minX: 0, minY: 0, maxX: Math.max(layout.width, 320), maxY: layout.height };
  const layers = options.overlay ? renderOverlayLayers(view, layout, options.overlay, extent, { prefix }) : undefined;
  const body = renderNetworkBody(view, layout, prefix, options, layers);
  const titleText = options.title ? `${options.title} · ${view.label}` : view.label;
  const subtitle = options.overlay ? overlaySubtitle(options.overlay) : networkSubtitle(view);
  const minX = Math.min(0, extent.minX) - MARGIN;
  const width = Math.max(extent.maxX - minX + MARGIN, textWidth(titleText, 15) + 2 * MARGIN, 600);
  const textColumn = width - 2 * MARGIN;
  const subtitleLines = wrapLines(subtitle, 11.5, textColumn);
  const titleHeight = 40 + subtitleLines.length * 16;
  // With a result, the plain-words account goes under the drawing, as a caption, with what the run relies on.
  const caption = options.overlay ? overlayCaption(options.overlay).flatMap((sentence) => wrapText(sentence, 11.5, textColumn)) : [];
  const legend = options.legend === false ? [] : legendRows(legendEntries(view, options.overlay, layers?.placement), textColumn);
  const graphTop = titleHeight - Math.min(0, extent.minY);
  const captionTop = graphTop + extent.maxY + 18;
  const legendTop = captionTop + (caption.length ? caption.length * 16 + 14 : 0);
  const height = legendTop + (legend.length ? legend.length * 24 + 6 : 0) + MARGIN;
  const head = options.standalone === false ? '' : '<?xml version="1.0" encoding="UTF-8"?>\n<!-- generated by processj-lsp: ProcessJ process network -->\n';
  const x = num(minX + MARGIN);
  return `${head}<svg xmlns="http://www.w3.org/2000/svg" class="pj-net" viewBox="${num(minX)} 0 ${num(width)} ${num(height)}" width="${Math.ceil(width)}" height="${Math.ceil(height)}" data-view="${escapeXml(view.id)}" role="img" aria-label="${escapeXml(titleText)}">
<title>${escapeXml(titleText)}</title>
<desc>${escapeXml(`${subtitle}. Boxes are processes, arrows are channels from the writing process to the reading one; dashed arrows are conditional.`)}</desc>
<style>${svgStyle(options.themed ? 'themed' : 'plain')}</style>
<defs>${markerDefs(prefix)}</defs>
<rect class="pj-bg" x="${num(minX)}" y="0" width="${num(width)}" height="${num(height)}"/>
<text class="pj-title" x="${x}" y="28">${escapeXml(titleText)}</text>
${subtitleLines.map((line, index) => `<text class="pj-subtitle" x="${x}" y="${47 + index * 16}">${escapeXml(line)}</text>`).join('\n')}
<g class="pj-graph" transform="translate(0 ${num(graphTop)})">
${body}
</g>
${caption.length ? `<g class="pj-caption">${caption.map((line, index) => `<text class="pj-caption-text" x="${x}" y="${num(captionTop + 12 + index * 16)}">${escapeXml(line)}</text>`).join('')}</g>` : ''}
${legend.length ? `<g class="pj-legend" transform="translate(${x} ${num(legendTop)})">${legend.map((row, index) => `<g transform="translate(0 ${index * 24})">${row}</g>`).join('')}</g>` : ''}
</svg>
`;
}

/** Greedy word wrap for the monospace stack. */
export function wrapText(text: string, size: number, width: number): string[] {
  const perLine = Math.max(12, Math.floor(width / (size * METRICS.charWidth)));
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    const next = current ? `${current} ${word}` : word;
    if (next.length <= perLine) current = next;
    else {
      if (current) lines.push(current);
      current = word.length > perLine ? truncate(word, perLine) : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** `text` wrapped to `width` in at most three lines; a cut is marked. */
export function wrapLines(text: string, size: number, width: number): string[] {
  const wrapped = wrapText(text, size, width);
  return wrapped.length > 3 ? [...wrapped.slice(0, 2), truncate(`${wrapped[2]} ${wrapped[3]}`, wrapped[2].length)] : wrapped;
}

/** `process network · 6 processes · 4 channels`: processes, not boxes (a par for box counts each iteration). */
export function networkSubtitle(view: NetworkView): string {
  const channels = new Set(view.edges.filter((edge) => edge.kind === 'channel').map((edge) => edge.channel)).size;
  return `process network · ${countText(viewProcesses(view))} · ${channels} channel${channels === 1 ? '' : 's'}`;
}

/** The account of a result under a picture of it: its story, then each caveat of the run. */
export function overlayCaption(overlay: Pick<OverlayModel, 'story' | 'caveats'>): string[] {
  return [...overlay.story, ...overlay.caveats.map((caveat) => `Caveat: ${caveat}.`)];
}

export function overlaySubtitle(overlay: OverlayModel): string {
  const by = overlay.producer === 'fdr' ? 'FDR' : 'static analysis';
  const verdict = overlay.status === 'failed' ? overlay.summary || overlay.label : `${overlay.label}: ${overlay.status}`;
  return `${by}${overlay.stale ? ' (stale: the file changed since)' : ''} · ${verdict}`;
}

function markerDefs(prefix: string): string {
  return `<marker id="${prefix}-arrow" viewBox="0 0 10 10" refX="9.5" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto"><path class="pj-arrow" d="M0,0.8 L10,5 L0,9.2 Z"/></marker>`
    + `<marker id="${prefix}-arrow-faint" viewBox="0 0 10 10" refX="9.5" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto"><path class="pj-arrow-faint" d="M0,0.8 L10,5 L0,9.2 Z"/></marker>`
    + `<marker id="${prefix}-arrow-danger" viewBox="0 0 10 10" refX="9.5" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto"><path class="pj-arrow-danger" d="M0,0.8 L10,5 L0,9.2 Z"/></marker>`
    + `<marker id="${prefix}-arrow-behind" viewBox="0 0 10 10" refX="9.5" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto"><path class="pj-arrow-behind" d="M0,0.8 L10,5 L0,9.2 Z"/></marker>`;
}

/** Groups, edges, nodes and labels of a view, in graph coordinates. */
export function renderNetworkBody(view: NetworkView, layout: ViewLayout, prefix: string, options: Pick<SvgOptions, 'showTypes'> = {}, overlay?: OverlayLayers): string {
  const out: string[] = [];
  const byId = new Map(view.nodes.map((node) => [node.id, node]));
  const groups = view.nodes.filter((node) => node.kind === 'group' && layout.nodes[node.id]).sort((a, b) => layout.nodes[a.id].depth - layout.nodes[b.id].depth);
  out.push('<g class="pj-groups">');
  for (const node of groups) out.push(renderGroup(node, layout.nodes[node.id]));
  out.push('</g>');
  out.push('<g class="pj-edges">');
  for (const edge of view.edges) {
    const laid = layout.edges[edge.id];
    if (!laid || laid.points.length < 2) continue;
    out.push(renderEdge(edge, laid.points, byId, prefix));
  }
  out.push('</g>');
  out.push(`<g class="pj-overlay-under">${overlay?.under ?? ''}</g>`);
  out.push('<g class="pj-nodes">');
  for (const node of view.nodes) {
    const box = layout.nodes[node.id];
    if (!box || node.kind === 'group') continue;
    out.push(renderLeaf(node, box));
  }
  out.push('</g>');
  out.push('<g class="pj-labels">');
  for (const node of groups) out.push(renderGroupTitle(node, layout.nodes[node.id]));
  for (const edge of view.edges) {
    const laid = layout.edges[edge.id];
    if (!laid?.label || !edge.label) continue;
    out.push(renderEdgeLabel(edge, laid.label, options.showTypes !== false));
  }
  for (const node of view.nodes) {
    if (node.kind !== 'junction' || !layout.nodes[node.id]) continue;
    out.push(renderJunctionLabel(node, layout.nodes[node.id], view));
  }
  out.push('</g>');
  out.push(`<g class="pj-overlay-over">${overlay?.over ?? ''}</g>`);
  return out.join('\n');
}

function dataAttributes(node: NetNode): string {
  return `data-id="${escapeXml(node.id)}" data-kind="${node.kind}"`;
}

function renderGroup(node: NetNode, box: Box): string {
  const stack = node.replicated ? `<rect class="pj-stack" x="${num(box.x + 8)}" y="${num(box.y + 8)}" width="${num(box.width)}" height="${num(box.height)}" rx="13"/><rect class="pj-stack" x="${num(box.x + 4)}" y="${num(box.y + 4)}" width="${num(box.width)}" height="${num(box.height)}" rx="13"/>` : '';
  return `<g class="pj-node pj-group pj-group-${node.group ?? 'par'}${node.confidence !== 'exact' ? ' pj-uncertain' : ''}" ${dataAttributes(node)}>${stack}<rect class="pj-group-box" x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}" rx="13"/></g>`;
}

function renderGroupTitle(node: NetNode, box: Box): string {
  let x = box.x + 14;
  const y = box.y + 22;
  const parts: string[] = [];
  const badge = node.badge ? renderBadge(node.badge, x, y - 11, node.badge === 'call' ? 'pj-badge-call' : '') : undefined;
  if (badge) {
    parts.push(badge.svg);
    x += badge.width + 8;
  }
  const available = box.width - (x - box.x) - 14 - (node.replicated ? textWidth(node.replicated.text, METRICS.badgeSize + 1) + 22 : 0);
  const label = fitText(node.label, METRICS.groupLabelSize, available);
  parts.push(`<text class="pj-group-title" x="${num(x)}" y="${num(y)}">${escapeXml(label)}</text>`);
  x += textWidth(label, METRICS.groupLabelSize) + 10;
  if (node.detail) {
    const detail = fitText(node.detail, METRICS.detailSize, box.x + box.width - x - 14 - (node.replicated ? textWidth(node.replicated.text, METRICS.badgeSize + 1) + 22 : 0));
    if (detail) parts.push(`<text class="pj-group-detail" x="${num(x)}" y="${num(y)}">${escapeXml(detail)}</text>`);
  }
  if (node.replicated) parts.push(renderCount(node.replicated.text, box.x + box.width - 12, y - 11));
  const width = Math.min(box.width - 6, (x - box.x) + 4);
  return `<g class="pj-group-head" data-for="${escapeXml(node.id)}"><rect class="pj-group-title-bg" x="${num(box.x + 6)}" y="${num(box.y + 5)}" width="${num(Math.max(0, width))}" height="24" rx="6"/>${parts.join('')}</g>`;
}

function renderBadge(text: string, x: number, y: number, extraClass: string): { svg: string; width: number } {
  const label = text.toUpperCase();
  const width = textWidth(label, METRICS.badgeSize, 0.6) + 12;
  return {
    width,
    svg: `<g class="pj-badge-wrap ${extraClass}"><rect class="pj-badge-box" x="${num(x)}" y="${num(y)}" width="${num(width)}" height="15" rx="4"/><text class="pj-badge" x="${num(x + 6)}" y="${num(y + 11)}">${escapeXml(label)}</text></g>`,
  };
}

/** `×3` pill, right-aligned at `right`. */
function renderCount(text: string, right: number, y: number): string {
  const width = textWidth(text, METRICS.badgeSize + 1) + 12;
  return `<rect class="pj-count-box" x="${num(right - width)}" y="${num(y)}" width="${num(width)}" height="16" rx="8"/><text class="pj-count" x="${num(right - width + 6)}" y="${num(y + 12)}">${escapeXml(text)}</text>`;
}

/** Text shortened with an ellipsis to fit `available` px at `size`. */
export function fitText(text: string, size: number, available: number): string {
  if (textWidth(text, size) <= available + 0.5) return text;
  const perChar = size * METRICS.charWidth;
  return truncate(text, Math.max(1, Math.floor(available / perChar)));
}

function renderLeaf(node: NetNode, box: Box): string {
  switch (node.kind) {
    case 'junction': {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      return `<g class="pj-node pj-junction-node" ${dataAttributes(node)}><circle class="pj-junction" cx="${num(cx)}" cy="${num(cy)}" r="6"/></g>`;
    }
    case 'barrier': {
      const label = fitText(node.label, METRICS.labelSize - 1, box.width - 36);
      return `<g class="pj-node pj-barrier" ${dataAttributes(node)}><rect class="pj-barrier-box" x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}" rx="${num(box.height / 2)}"/>`
        + `<rect class="pj-barrier-bar" x="${num(box.x + 12)}" y="${num(box.y + 7)}" width="3" height="${num(box.height - 14)}" rx="1"/><rect class="pj-barrier-bar" x="${num(box.x + 18)}" y="${num(box.y + 7)}" width="3" height="${num(box.height - 14)}" rx="1"/>`
        + `<text class="pj-barrier-label" x="${num(box.x + 28)}" y="${num(box.y + box.height / 2 + 4.5)}">${escapeXml(label)}</text></g>`;
    }
    case 'port': {
      const tip = 9;
      const d = `M${num(box.x + 5)},${num(box.y)} H${num(box.x + box.width - tip)} L${num(box.x + box.width)},${num(box.y + box.height / 2)} L${num(box.x + box.width - tip)},${num(box.y + box.height)} H${num(box.x + 5)} Q${num(box.x)},${num(box.y + box.height)} ${num(box.x)},${num(box.y + box.height - 5)} V${num(box.y + 5)} Q${num(box.x)},${num(box.y)} ${num(box.x + 5)},${num(box.y)} Z`;
      return `<g class="pj-node pj-port" ${dataAttributes(node)}><path class="pj-port-box" d="${d}"/><text class="pj-port-label" x="${num(box.x + 10)}" y="${num(box.y + box.height / 2 + 4.5)}">${escapeXml(fitText(node.label, METRICS.labelSize - 1, box.width - 22))}</text></g>`;
    }
    case 'stub':
      return `<g class="pj-node pj-stub${node.stub?.proven ? ' pj-stub-proven' : ''}" ${dataAttributes(node)}><rect class="pj-stub-box" x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}" rx="12"/><text class="pj-stub-label" x="${num(box.x + 11)}" y="${num(box.y + box.height / 2 + 4)}">${escapeXml(node.label)}</text></g>`;
    default:
      return renderProcess(node, box);
  }
}

function renderProcess(node: NetNode, box: Box): string {
  const parts: string[] = [];
  if (node.replicated) {
    parts.push(`<rect class="pj-stack" x="${num(box.x + 8)}" y="${num(box.y + 8)}" width="${num(box.width)}" height="${num(box.height)}" rx="9"/>`);
    parts.push(`<rect class="pj-stack" x="${num(box.x + 4)}" y="${num(box.y + 4)}" width="${num(box.width)}" height="${num(box.height)}" rx="9"/>`);
  } else {
    parts.push(`<rect class="pj-shadow" x="${num(box.x + 1)}" y="${num(box.y + 2)}" width="${num(box.width)}" height="${num(box.height)}" rx="9"/>`);
  }
  parts.push(`<rect class="pj-box" x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}" rx="9"/>`);
  let x = box.x + METRICS.processPadding;
  const firstLine = node.detail ? box.y + 22 : box.y + box.height / 2 + 4.5;
  if (node.badge) {
    const badge = renderBadge(node.badge, x, firstLine - 11, node.badge === 'call' ? 'pj-badge-call' : '');
    parts.push(badge.svg);
    x += badge.width + 8;
  }
  const countWidth = node.replicated ? textWidth(node.replicated.text, METRICS.badgeSize + 1) + 20 : 0;
  const label = fitText(node.label, METRICS.labelSize, box.x + box.width - METRICS.processPadding - x - countWidth);
  parts.push(`<text class="pj-label" x="${num(x)}" y="${num(firstLine)}">${escapeXml(label)}</text>`);
  if (node.replicated) parts.push(renderCount(node.replicated.text, box.x + box.width - 10, firstLine - 12));
  if (node.detail) {
    const detail = fitText(node.detail, METRICS.detailSize, box.width - METRICS.processPadding * 2);
    parts.push(`<text class="pj-detail" x="${num(box.x + METRICS.processPadding)}" y="${num(box.y + 40)}">${escapeXml(detail)}</text>`);
  }
  return `<g class="pj-node pj-process${node.confidence !== 'exact' ? ' pj-uncertain' : ''}" ${dataAttributes(node)}>${parts.join('')}</g>`;
}

function renderEdge(edge: NetEdge, points: readonly Point[], byId: Map<string, NetNode>, prefix: string): string {
  const target = byId.get(edge.to);
  // Lines into a junction merge there; the arrow is drawn once, at the reader.
  const arrow = edge.kind === 'channel' && target?.kind !== 'junction'
    ? ` marker-end="url(#${prefix}-arrow${edge.confidence === 'unknown' || edge.role === 'dangling' ? '-faint' : ''})"`
    : '';
  const classes = ['pj-edge', `pj-edge-${edge.kind === 'barrier' ? 'barrier' : edge.confidence}`];
  if (edge.role === 'dangling') classes.push('pj-edge-dangling');
  if (edge.tags.includes('not enrolled')) classes.push('pj-edge-unenrolled');
  return `<g class="${classes.join(' ')}" data-id="${escapeXml(edge.id)}" data-channel="${escapeXml(edge.channel)}" data-from="${escapeXml(edge.from)}" data-to="${escapeXml(edge.to)}"><path class="pj-edge-line" d="${roundedPath(points)}"${arrow}/></g>`;
}

function renderEdgeLabel(edge: NetEdge, box: Box, showTypes: boolean): string {
  if (edge.tags.includes('port')) {
    // The port box names the parameter; its arrow carries the type.
    return `<g class="pj-edge-label-wrap pj-port-edge-label" data-for="${escapeXml(edge.id)}"><rect class="pj-edge-label-box" x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}" rx="${num(box.height / 2)}"/><text class="pj-edge-label" x="${num(box.x + 8)}" y="${num(box.y + box.height / 2 + 4)}"><tspan class="pj-type" x="${num(box.x + 8)}">${escapeXml(edgeLabelText(edge))}</tspan></text></g>`;
  }
  const [name, type] = (edge.label ?? '').split(' : ');
  const tag = edgeLabelText(edge).slice((edge.label ?? '').length);
  return `<g class="pj-edge-label-wrap${edge.tags.includes('not enrolled') ? ' pj-edge-unenrolled-label' : ''}" data-for="${escapeXml(edge.id)}"><rect class="pj-edge-label-box" x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}" rx="${num(box.height / 2)}"/><text class="pj-edge-label" x="${num(box.x + 8)}" y="${num(box.y + box.height / 2 + 4)}">${labelSpans(box.x + 8, name, type, tag, showTypes)}</text></g>`;
}

/** A junction's channel label, where the layout reserved room for it. */
function renderJunctionLabel(node: NetNode, box: LaidOutNode, view: NetworkView): string {
  const [name, type] = node.label.split(' : ');
  const full = junctionLabelText(view, node);
  const shared = full.slice(node.label.length);
  const label = box.label ?? { x: box.x + box.width / 2 - (textWidth(full, METRICS.edgeLabelSize) + 16) / 2, y: box.y - 26, width: textWidth(full, METRICS.edgeLabelSize) + 16, height: 20 };
  return `<g class="pj-edge-label-wrap" data-for="${escapeXml(node.id)}"><rect class="pj-edge-label-box" x="${num(label.x)}" y="${num(label.y)}" width="${num(label.width)}" height="${num(label.height)}" rx="${num(label.height / 2)}"/><text class="pj-edge-label" x="${num(label.x + 8)}" y="${num(label.y + label.height / 2 + 4)}">${labelSpans(label.x + 8, name, type, shared, true)}</text></g>`;
}

/**
 * Name, `: type` and the sharing tag of a channel label. Each part is placed at
 * its own x (the font is monospace), since renderers disagree on whether a
 * space at the start of a tspan survives.
 */
function labelSpans(x: number, name: string, type: string | undefined, tag: string, showTypes: boolean): string {
  const size = METRICS.edgeLabelSize;
  const parts = [`<tspan class="pj-name" x="${num(x)}">${escapeXml(name)}</tspan>`];
  let at = x + textWidth(`${name} `, size);
  if (type && showTypes) {
    parts.push(`<tspan class="pj-type" x="${num(at)}">${escapeXml(`: ${type}`)}</tspan>`);
    at += textWidth(`: ${type} `, size);
  }
  const trimmed = tag.trim();
  if (trimmed) parts.push(`<tspan class="pj-tag" x="${num(at)}">${escapeXml(trimmed)}</tspan>`);
  return parts.join('');
}

// ---------------------------------------------------------------------------
// Verification overlay
// ---------------------------------------------------------------------------

export interface OverlayLayers {
  /** Edge highlights, loops and halos: drawn above the arrows, below boxes and labels. */
  under: string;
  /** Outlines, badges, stop markers, reasons and callouts: drawn on top. */
  over: string;
  placement: OverlayPlacement;
}

/**
 * How strongly something is drawn: `root` is a wait that can never be met (or
 * a circular wait), `behind` a process only waiting on another stuck one,
 * `loop` a divergence, `done` a finished process.
 */
/** `error` is a value leaving the modelled integers (the model's limit, amber); `fail` a runtime error of the program (red); `choice` the internal step a nondeterminism turns on. */
export type OverlayTone = 'root' | 'behind' | 'done' | 'error' | 'fail' | 'info' | 'loop' | 'choice';

/** Where every piece of a result goes on a laid-out view: shared by the SVG, the viewer and the Excalidraw scene. */
export interface OverlayPlacement {
  outlines: Array<{ node: string; box: Box; rx: number; tone: Exclude<OverlayTone, 'info'> | 'running'; approx: boolean; stack: number }>;
  /** Arrows to highlight; `arrow` when the arrowhead is drawn at this end (not into a junction). */
  edges: Array<{ edge: string; tone: 'root' | 'behind' | 'loop'; arrow: boolean }>;
  badges: Array<{ node: string; box: Box; text: string; tone: OverlayTone; title: string }>;
  markers: Array<{ node: string; edge: string; at: Point; tone: 'root' | 'behind'; title: string }>;
  reasons: Array<{ node: string; box: Box; text: string; tone: 'root' | 'behind'; title: string; anchor: Point; leader?: { from: Point; to: Point }; partner?: string }>;
  callouts: Array<{ box: Box; text: string; tone: 'root' | 'loop' }>;
  /**
   * A circular wait drawn as its own loop where no arrow joins two of its
   * processes, and `waits for` links between processes the arrows do not join.
   */
  curves: Array<{ points: Point[]; tone: 'cycle' | 'root' | 'behind'; from: string; to: string; title: string }>;
  /** Arrows a circular wait runs along: drawn over in its marching dashes. */
  cycleEdges: string[];
}

/**
 * Space taken by what is already drawn, so overlay text lands where it hides
 * nothing: boxes, group titles, labels, arrow segments, and earlier overlay items.
 */
class Occupancy {
  private readonly boxes: Array<{ box: Box; owner?: string; weight: number }> = [];

  constructor(view: NetworkView, layout: ViewLayout) {
    for (const node of view.nodes) {
      const box = layout.nodes[node.id];
      if (!box) continue;
      if (node.kind === 'group') {
        this.boxes.push({ box: { x: box.x, y: box.y, width: Math.min(box.width, groupHeaderWidth(node)), height: 30 }, owner: node.id, weight: 8 });
        // Its frame: text across a border is harder to read than text across an arrow.
        for (const edge of [{ x: box.x - 2, y: box.y - 2, width: box.width + 4, height: 4 }, { x: box.x - 2, y: box.y + box.height - 2, width: box.width + 4, height: 4 }, { x: box.x - 2, y: box.y, width: 4, height: box.height }, { x: box.x + box.width - 2, y: box.y, width: 4, height: box.height }]) {
          this.boxes.push({ box: edge, owner: node.id, weight: 2 });
        }
      } else this.boxes.push({ box: inflate(box, 2), owner: node.id, weight: 10 });
      if (box.label) this.boxes.push({ box: box.label, owner: node.id, weight: 10 });
    }
    for (const edge of view.edges) {
      const laid = layout.edges[edge.id];
      if (!laid) continue;
      if (laid.label) this.boxes.push({ box: laid.label, owner: edge.id, weight: 10 });
      this.line(laid.points, edge.id, 1);
    }
  }

  /** Something drawn by the overlay: as important to keep clear as a box. */
  add(box: Box, owner?: string, weight = 10): void {
    this.boxes.push({ box, owner, weight });
  }

  /** A drawn polyline, kept clear like an arrow. */
  line(points: readonly Point[], owner?: string, weight = 1): void {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      this.boxes.push({ box: { x: Math.min(a.x, b.x) - 3, y: Math.min(a.y, b.y) - 3, width: Math.abs(a.x - b.x) + 6, height: Math.abs(a.y - b.y) + 6 }, owner, weight });
    }
  }

  /** Covered area, weighted: boxes and labels matter most, arrows least. */
  overlap(box: Box, ignore: ReadonlySet<string>): number {
    let total = 0;
    for (const entry of this.boxes) {
      if (entry.owner && ignore.has(entry.owner)) continue;
      const w = Math.min(box.x + box.width, entry.box.x + entry.box.width) - Math.max(box.x, entry.box.x);
      const h = Math.min(box.y + box.height, entry.box.y + entry.box.height) - Math.max(box.y, entry.box.y);
      if (w > 0 && h > 0) total += w * h * entry.weight;
    }
    return total;
  }

  /** The first candidate that covers nothing, else the one that covers least. */
  place(candidates: Box[], ignore: ReadonlySet<string> = new Set()): Box {
    let best = candidates[0];
    let bestOverlap = Infinity;
    for (const candidate of candidates) {
      const overlap = this.overlap(candidate, ignore);
      if (overlap === 0) return candidate;
      if (overlap < bestOverlap) {
        best = candidate;
        bestOverlap = overlap;
      }
    }
    return best;
  }
}

function inflate(box: Box, by: number): Box {
  return { x: box.x - by, y: box.y - by, width: box.width + 2 * by, height: box.height + 2 * by };
}

const BADGE_HEIGHT = 21;
const REASON_HEIGHT = 18;

/** Width of an overlay badge holding `text` (icon, text, padding). */
export function badgeWidth(text: string): number {
  return textWidth(text, 11) + 30;
}

/** Width of a reason pill holding `text`. */
export function reasonWidth(text: string): number {
  return textWidth(text, 10.5) + 14;
}

/**
 * Lay out a result on a view. Instances drawn on one box (the iterations of a
 * par for, the processes of a collapsed call) are told once with a count, and
 * so are identical waits on one arrow end.
 */
export function placeOverlay(view: NetworkView, layout: ViewLayout, overlay: OverlayModel): OverlayPlacement {
  const placement: OverlayPlacement = { outlines: [], edges: [], badges: [], markers: [], reasons: [], callouts: [], curves: [], cycleEdges: [] };
  const space = new Occupancy(view, layout);
  const nodes = new Map(view.nodes.map((node) => [node.id, node]));
  const edges = new Map(view.edges.map((edge) => [edge.id, edge]));
  const edgePoints = (id: string | undefined): Point[] | undefined => id ? layout.edges[id]?.points : undefined;
  const nested = (a: string, b: string): boolean => a === b || isAncestorIn(nodes, a, b) || isAncestorIn(nodes, b, a);
  const unique = <T>(values: T[]): T[] => [...new Set(values)];

  // Circular waits first: their loops are what the eye should find. Where an arrow joins two
  // neighbours of the circle the loop runs along it; elsewhere (a barrier, a junction) a curve joins them.
  const cycleNodes = new Set(overlay.cycles.flatMap((cycle) => cycle.nodes));
  const joined = (a: string, b: string): boolean => view.edges.some((edge) => layout.edges[edge.id] && ((nested(edge.from, a) && nested(edge.to, b)) || (nested(edge.from, b) && nested(edge.to, a))));
  for (const cycle of overlay.cycles) {
    for (const id of cycle.edges) if (layout.edges[id] && !placement.cycleEdges.includes(id)) placement.cycleEdges.push(id);
    const ids = cycle.nodes.filter((id, index) => layout.nodes[id] && id !== cycle.nodes[(index + 1) % cycle.nodes.length]);
    if (ids.length < 2) continue;
    const centre = centreOf(ids.map((id) => layout.nodes[id]));
    ids.forEach((id, index) => {
      const next = ids[(index + 1) % ids.length];
      if (nested(id, next) || joined(id, next)) return;
      const points = arc(layout.nodes[id], layout.nodes[next], ids.length === 2 ? undefined : centre, ids.length === 2 ? 0.42 : 0.3);
      space.line(points, undefined, 4);
      placement.curves.push({ points, tone: 'cycle', from: id, to: next, title: `${nodes.get(id)?.name ?? id} waits for ${nodes.get(next)?.name ?? next}` });
    });
  }

  // Divergence: the steps that repeat forever, along their arrows.
  const loopSteps = overlay.kind === 'divergence' && overlay.loopStart !== undefined ? overlay.steps.slice(overlay.loopStart) : [];
  const loopEdges = new Set(loopSteps.flatMap((step) => step.route));

  // Arrows of stuck operations: red where a wait can never be met, amber behind another stuck process.
  const waitGroups = new Map<string, { node: string; edge?: string; end?: string; short: string; reasons: string[]; details: string[]; root: boolean; count: number; partner?: string }>();
  for (const wait of overlay.waits) {
    const key = `${wait.node}|${wait.edge ?? ''}|${wait.end ?? ''}|${wait.short}`;
    const group = waitGroups.get(key);
    if (group) {
      group.count++;
      group.root ||= wait.cause === 'root';
      group.reasons.push(wait.reason);
      group.details.push(wait.detail);
    } else waitGroups.set(key, { node: wait.node, edge: wait.edge, end: wait.end, short: wait.short, reasons: [wait.reason], details: [wait.detail], root: wait.cause === 'root', count: 1, partner: wait.partnerNode });
  }
  const edgeTone = new Map<string, 'root' | 'behind' | 'loop'>();
  for (const group of waitGroups.values()) {
    if (!group.edge) continue;
    if (group.root || cycleNodes.has(group.node)) edgeTone.set(group.edge, 'root');
    else if (!edgeTone.has(group.edge)) edgeTone.set(group.edge, 'behind');
  }
  for (const id of loopEdges) if (!edgeTone.has(id)) edgeTone.set(id, 'loop');
  for (const [id, tone] of edgeTone) {
    if (!layout.edges[id]) continue;
    const edge = edges.get(id);
    placement.edges.push({ edge: id, tone, arrow: edge?.kind === 'channel' && nodes.get(edge.to)?.kind !== 'junction' });
  }

  // Each box once: its state, and how many of the instances drawn on it are in it.
  const byNode = new Map<string, OverlayModel['processes']>();
  for (const process of overlay.processes) {
    const list = byNode.get(process.node);
    if (list) list.push(process);
    else byNode.set(process.node, [process]);
  }
  const badgeQueue: Array<{ node: string; text: string; tone: OverlayTone; title: string }> = [];
  for (const [id, processes] of byNode) {
    const box = layout.nodes[id];
    const node = nodes.get(id);
    if (!box || !node) continue;
    const rx = node.kind === 'group' ? 13 : 9;
    const approx = processes.every((process) => !process.exact);
    const stack = node.replicated && node.kind !== 'group' ? 8 : 0;
    const blocked = processes.filter((process) => process.status === 'blocked');
    const done = processes.filter((process) => process.status === 'terminated');
    const errors = processes.filter((process) => process.status === 'error');
    const diverging = processes.filter((process) => process.status === 'diverging');
    const running = processes.filter((process) => process.status === 'running');
    // How many instances the box stands for: the iterations of every par for around it.
    let replicated = false;
    let total: number | undefined = 1;
    for (let at: NetNode | undefined = node; at; at = at.parent ? nodes.get(at.parent) : undefined) {
      if (!at.replicated) continue;
      replicated = true;
      total = total === undefined || at.replicated.count === undefined ? undefined : total * at.replicated.count;
    }
    if (!replicated) total = undefined;
    const counted = (list: OverlayModel['processes'], word: string, what?: string): string => {
      const texts = unique(list.map((process) => process.badge));
      const doing = what ?? (texts.length === 1 ? texts[0] : `${texts.length} different waits`);
      if (list.length === 1 && !replicated) return what === undefined ? doing : word;
      return `${list.length}${total !== undefined ? ` of ${total}` : ''} ${word}${what === undefined ? ` · ${doing}` : ''}`;
    };
    const title = (list: OverlayModel['processes']): string => unique(list.map((process) => `${process.label}: ${process.description}`)).slice(0, 8).join('\n');
    if (blocked.length) {
      const root = blocked.some((process) => process.cause !== 'knock-on') || cycleNodes.has(id);
      placement.outlines.push({ node: id, box, rx, tone: root ? 'root' : 'behind', approx, stack });
      badgeQueue.push({ node: id, text: counted(blocked, 'stuck'), tone: root ? 'root' : 'behind', title: title(blocked) });
    } else if (errors.length) {
      placement.outlines.push({ node: id, box, rx, tone: 'error', approx, stack });
    } else if (diverging.length) {
      placement.outlines.push({ node: id, box, rx, tone: 'loop', approx, stack });
    } else if (running.length) {
      placement.outlines.push({ node: id, box, rx, tone: 'running', approx, stack });
    } else if (done.length && node.kind !== 'group' && (total === undefined || done.length >= total)) {
      // Faded only when every instance it stands for has finished.
      placement.outlines.push({ node: id, box, rx, tone: 'done', approx, stack });
    }
    // The error message badge says it; a second "error" badge would only cover it.
    if (errors.length && overlay.error?.node !== id) badgeQueue.push({ node: id, text: counted(errors, 'failed', 'error'), tone: overlay.severity === 'warning' ? 'error' : 'fail', title: title(errors) });
    // Where a nondeterministic result turns: the process whose internal step decides what the outside sees.
    if (overlay.choice?.node === id) badgeQueue.push({ node: id, text: `the choice (step ${overlay.choice.step + 1})`, tone: 'choice', title: `${overlay.choice.description}: what the outside can see next depends on it` });
    if (diverging.length) badgeQueue.push({ node: id, text: counted(diverging, 'diverge', 'diverges'), tone: 'loop', title: title(diverging) });
    if (running.length) badgeQueue.push({ node: id, text: counted(running, 'running', 'running'), tone: 'info', title: title(running) });
    if (done.length) badgeQueue.push({ node: id, text: counted(done, 'done', 'done'), tone: 'done', title: title(done) });
  }

  // Badges say what each process is doing; stacked when one box has several.
  const badgesOn = new Map<string, number>();
  for (const badge of badgeQueue) {
    const box = layout.nodes[badge.node];
    const text = truncate(badge.text, 40);
    const width = badgeWidth(text);
    const shift = (badgesOn.get(badge.node) ?? 0) * (BADGE_HEIGHT + 3);
    badgesOn.set(badge.node, (badgesOn.get(badge.node) ?? 0) + 1);
    const right = box.x + box.width - width - 8;
    const left = box.x + 8;
    const placed = space.place([
      { x: right, y: box.y - 11 - shift, width, height: BADGE_HEIGHT },
      { x: left, y: box.y - 11 - shift, width, height: BADGE_HEIGHT },
      { x: right, y: box.y + box.height - 10 + shift, width, height: BADGE_HEIGHT },
      { x: left, y: box.y + box.height - 10 + shift, width, height: BADGE_HEIGHT },
      { x: box.x + box.width - width, y: box.y - 27 - shift, width, height: BADGE_HEIGHT },
      { x: box.x + box.width - width, y: box.y + box.height + 6 + shift, width, height: BADGE_HEIGHT },
    ], new Set([badge.node]));
    space.add(placed);
    placement.badges.push({ node: badge.node, box: placed, text, tone: badge.tone, title: badge.title });
  }

  // A stop marker on each stuck arrow end, with the reason beside it (a count when several instances wait there).
  for (const group of waitGroups.values()) {
    const points = edgePoints(group.edge);
    // A wait on no drawn arrow (its par, a timer) is told by the badge alone.
    if (!points || points.length < 2 || !group.edge) continue;
    const tone: 'root' | 'behind' = group.root || cycleNodes.has(group.node) ? 'root' : 'behind';
    const length = polylineLength(points);
    const offset = Math.min(16, length / 4);
    const marker = pointAlong(points, group.end === 'target' ? length - offset : offset).point;
    const markerBox = { x: marker.x - 10, y: marker.y - 10, width: 20, height: 20 };
    space.add(markerBox);
    const title = `${unique(group.details).join('; ')}: ${unique(group.reasons).join('; ')}`;
    placement.markers.push({ node: group.node, edge: group.edge, at: marker, tone, title });
    // A wait behind another stuck process keeps its marker (and its reason as the marker's title):
    // the words go to the waits that explain the result.
    if (tone !== 'root') continue;
    const text = truncate(group.count > 1 ? `×${group.count} · ${group.short}` : group.short, 50);
    const width = reasonWidth(text);
    // Nearest free spot around the marker: above and below first, then beside it.
    const candidates: Box[] = [];
    for (const distance of [12, 30, 52, 76]) {
      for (const shift of [0, -0.35, 0.35, -0.6, 0.6]) {
        candidates.push(
          { x: marker.x - width / 2 + shift * width, y: marker.y - distance - REASON_HEIGHT, width, height: REASON_HEIGHT },
          { x: marker.x - width / 2 + shift * width, y: marker.y + distance, width, height: REASON_HEIGHT },
        );
      }
      candidates.push(
        { x: marker.x + distance, y: marker.y - REASON_HEIGHT / 2, width, height: REASON_HEIGHT },
        { x: marker.x - distance - width, y: marker.y - REASON_HEIGHT / 2, width, height: REASON_HEIGHT },
      );
    }
    const placed = space.place(candidates);
    space.add(placed);
    // A leader line when the reason had to move away from its marker.
    const cx = Math.max(placed.x, Math.min(marker.x, placed.x + width));
    const cy = Math.max(placed.y, Math.min(marker.y, placed.y + REASON_HEIGHT));
    const leader = Math.hypot(cx - marker.x, cy - marker.y) > 16 ? { from: marker, to: { x: cx, y: cy } } : undefined;
    placement.reasons.push({ node: group.node, box: placed, text, tone, title: unique(group.reasons).join('\n'), anchor: marker, leader, partner: group.partner });
  }

  // `waits for` links the arrows do not already draw: a process blocked behind one it does not talk to here.
  const linked = new Set<string>();
  for (const group of waitGroups.values()) {
    const partner = group.partner;
    if (!partner || !layout.nodes[partner] || !layout.nodes[group.node] || nested(group.node, partner) || cycleNodes.has(group.node)) continue;
    const edge = group.edge ? edges.get(group.edge) : undefined;
    if (edge && (nested(edge.from, partner) || nested(edge.to, partner))) continue;
    const key = `${group.node}>${partner}`;
    if (linked.has(key)) continue;
    linked.add(key);
    const points = arc(layout.nodes[group.node], layout.nodes[partner], undefined, 0.18);
    space.line(points, undefined, 2);
    placement.curves.push({ points, tone: group.root ? 'root' : 'behind', from: group.node, to: partner, title: `${nodes.get(group.node)?.name ?? group.node} waits for ${nodes.get(partner)?.name ?? partner}` });
  }

  // One callout per circular wait; a process in a circle with each of several others (santa and each
  // reindeer) is one callout naming them all.
  const calloutFor = (ids: readonly string[], label: string): void => {
    const boxes = ids.map((id) => layout.nodes[id]).filter((box): box is NonNullable<typeof box> => !!box);
    const text = truncate(label, 90);
    if (boxes.length) placement.callouts.push({ box: placeCallout(space, boxes, text), text, tone: 'root' });
  };
  // Circles whose processes all land on one box (the iterations of a par for drawn once) are told on that box,
  // and circles drawn on the same boxes (one per iteration) once, with how many there are.
  const within = new Map<string, number>();
  const drawn = new Map<string, { cycle: OverlayModel['cycles'][number]; ids: string[]; count: number }>();
  for (const cycle of overlay.cycles) {
    const ids = unique(cycle.nodes);
    if (ids.length === 1 && cycle.nodes.length > 1) within.set(ids[0], (within.get(ids[0]) ?? 0) + 1);
    else {
      const key = [...ids].sort().join('|');
      const seen = drawn.get(key);
      if (seen) seen.count++;
      else drawn.set(key, { cycle, ids, count: 1 });
    }
  }
  for (const [id, count] of within) calloutFor([id], `${count === 1 ? 'a circular wait' : `${count} circular waits`} among the ${nodes.get(id)?.replicated ? 'iterations' : 'processes'} of ${nodes.get(id)?.name ?? id}`);
  const across = [...drawn.values()];
  const pairs = across.filter((entry) => entry.ids.length === 2);
  const hub = pairs.length > 1 && pairs.length === across.length ? pairs[0].ids.find((id) => pairs.every((entry) => entry.ids.includes(id))) : undefined;
  const others = hub ? unique(pairs.map((entry) => entry.ids.find((id) => id !== hub)).filter((id): id is string => !!id)) : [];
  if (hub && others.length) {
    // Each named by the box, then (when that is too long) by its first argument.
    const full = (id: string): string => nodes.get(id)?.name ?? id;
    const long = [hub, ...others].reduce((sum, id) => sum + full(id).length, 0) > 70;
    const name = (id: string): string => (long ? firstArgument(full(id)) : full(id));
    const list = others.length > 1 ? `${others.slice(0, -1).map(name).join(', ')} and ${name(others[others.length - 1])}` : name(others[0]);
    calloutFor([hub, ...others], `circular waits: ${name(hub)} with each of ${list}`);
  } else for (const entry of across) calloutFor(entry.ids, entry.count > 1 ? `${entry.cycle.label} (×${entry.count})` : entry.cycle.label);
  if (loopSteps.length) {
    const ids = unique(loopSteps.flatMap((step) => step.participants.map((participant) => participant.node)).filter((id): id is string => !!id && !!layout.nodes[id]));
    const events = unique(loopSteps.map((step) => step.event));
    const text = truncate(`repeats forever: ${events.join(', ')}`, 90);
    if (ids.length) placement.callouts.push({ box: placeCallout(space, ids.map((id) => layout.nodes[id]), text), text, tone: 'loop' });
  }

  if (overlay.error) {
    const box = overlay.error.node ? layout.nodes[overlay.error.node] : undefined;
    if (box) {
      // A value outside the modelled integers leads with the range, so a cut keeps it.
      const range = /^(.*?) (?:is|gets a value|go) outside the modelled integers (-?\d+\.\.-?\d+)$/.exec(overlay.error.message);
      const text = truncate(range ? `outside ${range[2]}: ${range[1]}` : overlay.error.message, 60);
      const width = badgeWidth(text);
      const placed = space.place([
        { x: box.x, y: box.y + box.height + 8, width, height: BADGE_HEIGHT },
        { x: box.x, y: box.y - 31, width, height: BADGE_HEIGHT },
        { x: box.x + box.width + 8, y: box.y, width, height: BADGE_HEIGHT },
      ], new Set([overlay.error.node!]));
      space.add(placed);
      placement.badges.push({ node: overlay.error.node!, box: placed, text, tone: overlay.severity === 'warning' ? 'error' : 'fail', title: overlay.error.message });
    }
  }
  return placement;
}

function placeCallout(space: Occupancy, boxes: readonly Box[], text: string): Box {
  const top = Math.min(...boxes.map((box) => box.y));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  const left = Math.min(...boxes.map((box) => box.x));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const width = textWidth(text, 11.5) + 22;
  const height = 24;
  const middle = (left + right) / 2 - width / 2;
  const candidates: Box[] = [];
  for (const distance of [16, 44, 72, 100]) {
    candidates.push(
      { x: middle, y: top - distance - height, width, height },
      { x: middle, y: bottom + distance, width, height },
      { x: left, y: top - distance - height, width, height },
      { x: left, y: bottom + distance, width, height },
    );
  }
  const placed = space.place(candidates);
  space.add(placed);
  return placed;
}

function isAncestorIn(nodes: ReadonlyMap<string, NetNode>, ancestor: string, id: string): boolean {
  for (let node = nodes.get(id)?.parent; node; node = nodes.get(node)?.parent) if (node === ancestor) return true;
  return false;
}

function centreOf(boxes: readonly Box[]): Point {
  return { x: boxes.reduce((sum, box) => sum + box.x + box.width / 2, 0) / boxes.length, y: boxes.reduce((sum, box) => sum + box.y + box.height / 2, 0) / boxes.length };
}

/** Where the line from a box's centre toward `toward` leaves the box. */
function boundaryPoint(box: Box, toward: Point): Point {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const scale = Math.min(dx === 0 ? Infinity : (box.width / 2) / Math.abs(dx), dy === 0 ? Infinity : (box.height / 2) / Math.abs(dy));
  return { x: cx + dx * scale, y: cy + dy * scale };
}

/**
 * A curved link from one box to another, as points: it bulges to the left of
 * its direction (so two links between the same boxes form a loop), or away from
 * `centre` when the link is part of a larger ring.
 */
function arc(from: Box, to: Box, centre: Point | undefined, bend: number): Point[] {
  const a0 = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const b0 = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  const distance = Math.max(1, Math.hypot(b0.x - a0.x, b0.y - a0.y));
  let nx = (b0.y - a0.y) / distance;
  let ny = -(b0.x - a0.x) / distance;
  const middle = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
  if (centre && (middle.x - centre.x) * nx + (middle.y - centre.y) * ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  const bulge = Math.max(46, distance * bend);
  const control = { x: middle.x + nx * bulge, y: middle.y + ny * bulge };
  const start = boundaryPoint(from, control);
  const end = boundaryPoint(to, control);
  const points: Point[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    points.push({ x: (1 - t) * (1 - t) * start.x + 2 * (1 - t) * t * control.x + t * t * end.x, y: (1 - t) * (1 - t) * start.y + 2 * (1 - t) * t * control.y + t * t * end.y });
  }
  return points;
}

function smoothPath(points: readonly Point[]): string {
  return points.map((point, index) => `${index ? 'L' : 'M'}${num(point.x)},${num(point.y)}`).join(' ');
}

/** Growth of `extent` to everything a placement draws. */
export function placementExtent(placement: OverlayPlacement, extent: SvgExtent): void {
  const grow = (box: Box): void => {
    extent.minX = Math.min(extent.minX, box.x);
    extent.minY = Math.min(extent.minY, box.y);
    extent.maxX = Math.max(extent.maxX, box.x + box.width);
    extent.maxY = Math.max(extent.maxY, box.y + box.height);
  };
  for (const item of [...placement.badges, ...placement.reasons, ...placement.callouts]) grow(item.box);
  for (const marker of placement.markers) grow({ x: marker.at.x - 10, y: marker.at.y - 10, width: 20, height: 20 });
  for (const curve of placement.curves) for (const point of curve.points) grow({ x: point.x - 4, y: point.y - 4, width: 8, height: 8 });
}

/** The final state of a counterexample over the network. `extent` grows to include everything drawn. */
export function renderOverlayLayers(view: NetworkView, layout: ViewLayout, overlay: OverlayModel, extent?: SvgExtent, options: { prefix?: string; placement?: OverlayPlacement } = {}): OverlayLayers {
  const prefix = options.prefix ?? 'pj';
  const placement = options.placement ?? placeOverlay(view, layout, overlay);
  if (extent) placementExtent(placement, extent);
  const under: string[] = [];
  const over: string[] = [];
  const toneClass = (tone: string): string => tone === 'root' ? 'pj-ov-root' : tone === 'behind' ? 'pj-ov-behind' : tone === 'loop' ? 'pj-ov-loop' : `pj-ov-${tone}`;

  // A circular wait that runs along arrows: a red band under them.
  for (const id of placement.cycleEdges) {
    const points = layout.edges[id]?.points;
    if (points) under.push(`<path class="pj-ov-cycle-route" data-edge="${escapeXml(id)}" d="${roundedPath(points)}"/>`);
  }
  for (const item of placement.edges) {
    const points = layout.edges[item.edge]?.points;
    if (!points) continue;
    const marker = item.arrow && item.tone !== 'loop' ? ` marker-end="url(#${prefix}-arrow-${item.tone === 'root' ? 'danger' : 'behind'})"` : '';
    under.push(`<path class="pj-ov-stuck-edge ${toneClass(item.tone)}" data-edge="${escapeXml(item.edge)}" d="${roundedPath(points)}"${marker}/>`);
  }
  for (const curve of placement.curves) {
    const cls = curve.tone === 'cycle' ? 'pj-ov-cycle-edge' : `pj-ov-waits-for ${toneClass(curve.tone)}`;
    under.push(`<path class="${cls}" data-node="${escapeXml(curve.from)}" d="${smoothPath(curve.points)}" marker-end="url(#${prefix}-arrow-${curve.tone === 'behind' ? 'behind' : 'danger'})"><title>${escapeXml(curve.title)}</title></path>`);
  }
  for (const outline of placement.outlines) {
    const { box, rx, node } = outline;
    const approx = outline.approx ? ' pj-ov-approx' : '';
    if (outline.tone === 'root') under.push(`<rect class="pj-ov-halo" data-node="${escapeXml(node)}" x="${num(box.x - 5)}" y="${num(box.y - 5)}" width="${num(box.width + 10)}" height="${num(box.height + 10)}" rx="${rx + 4}"/>`);
    if (outline.tone === 'done') {
      over.push(`<rect class="pj-ov-veil" data-node="${escapeXml(node)}" x="${num(box.x - 1)}" y="${num(box.y - 1)}" width="${num(box.width + 2 + outline.stack)}" height="${num(box.height + 2 + outline.stack)}" rx="${rx}"/>`);
      continue;
    }
    // A value outside the modelled integers is the model's limit (a warning), not an error of the program.
    const error = overlay.severity === 'warning' ? 'pj-ov-blocked pj-ov-behind' : 'pj-ov-blocked';
    const cls = outline.tone === 'root' ? 'pj-ov-blocked' : outline.tone === 'error' ? error : outline.tone === 'behind' ? 'pj-ov-blocked pj-ov-behind' : outline.tone === 'loop' ? 'pj-ov-running pj-ov-loop' : 'pj-ov-running';
    over.push(`<rect class="${cls}${approx}" data-node="${escapeXml(node)}" x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}" rx="${rx}"/>`);
  }
  for (const badge of placement.badges) {
    const { box } = badge;
    const kind = badge.tone === 'root' ? 'blocked' : badge.tone === 'behind' ? 'behind' : badge.tone === 'done' ? 'done' : badge.tone === 'error' ? 'error' : badge.tone === 'fail' ? 'fail' : badge.tone === 'loop' ? 'loop' : badge.tone === 'choice' ? 'choice' : 'info';
    over.push(`<g class="pj-ov-badge-wrap pj-ov-${kind}-badge" data-node="${escapeXml(badge.node)}" data-cx="${num(box.x + box.width / 2)}" data-cy="${num(box.y + box.height / 2)}"><rect class="pj-ov-badge-box" x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${BADGE_HEIGHT}" rx="10.5"/>${badgeIcon(kind, box.x + 11, box.y + 10.5)}<text class="pj-ov-badge" x="${num(box.x + 21)}" y="${num(box.y + 14.5)}">${escapeXml(badge.text)}</text><title>${escapeXml(badge.title)}</title></g>`);
  }
  for (const marker of placement.markers) {
    over.push(`<g class="pj-ov-stuck ${toneClass(marker.tone)}" data-node="${escapeXml(marker.node)}" data-edge="${escapeXml(marker.edge)}"><circle class="pj-ov-marker" cx="${num(marker.at.x)}" cy="${num(marker.at.y)}" r="9"/><rect class="pj-ov-marker-bar" x="${num(marker.at.x - 4.5)}" y="${num(marker.at.y - 1.6)}" width="9" height="3.2" rx="1"/><title>${escapeXml(marker.title)}</title></g>`);
  }
  for (const callout of placement.callouts) {
    const { box } = callout;
    over.push(`<g class="pj-ov-callout-wrap ${toneClass(callout.tone)}" data-cx="${num(box.x + box.width / 2)}" data-cy="${num(box.y + box.height / 2)}"><rect class="pj-ov-callout-box" x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}" rx="12"/><text class="pj-ov-callout" x="${num(box.x + 11)}" y="${num(box.y + 16)}">${escapeXml(callout.text)}</text></g>`);
  }
  for (const reason of placement.reasons) {
    const { box } = reason;
    const leader = reason.leader ? `<path class="pj-ov-leader" d="M${num(reason.leader.from.x)},${num(reason.leader.from.y)} L${num(reason.leader.to.x)},${num(reason.leader.to.y)}"/>` : '';
    over.push(`<g class="pj-ov-reason-wrap ${toneClass(reason.tone)}" data-node="${escapeXml(reason.node)}"${reason.partner ? ` data-partner="${escapeXml(reason.partner)}"` : ''} data-cx="${num(reason.anchor.x)}" data-cy="${num(reason.anchor.y)}">${leader}<rect class="pj-ov-reason-box" x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${REASON_HEIGHT}" rx="9"/><text class="pj-ov-reason" x="${num(box.x + 7)}" y="${num(box.y + 12.5)}">${escapeXml(reason.text)}</text><title>${escapeXml(reason.title)}</title></g>`);
  }
  // A result about an older version of the file: drawn faded, so it is not read as current.
  const wrap = (parts: string[]): string => overlay.stale ? `<g class="pj-ov-stale">${parts.join('\n')}</g>` : parts.join('\n');
  return { under: wrap(under), over: wrap(over), placement };
}

function badgeIcon(kind: string, cx: number, cy: number): string {
  switch (kind) {
    case 'blocked':
    case 'behind':
      return `<g class="pj-ov-pause"><rect x="${num(cx - 3.5)}" y="${num(cy - 4)}" width="2.4" height="8" rx="0.8"/><rect x="${num(cx + 1.1)}" y="${num(cy - 4)}" width="2.4" height="8" rx="0.8"/></g>`;
    case 'done':
      return `<path class="pj-ov-icon pj-ov-icon-ok" d="M${num(cx - 4)},${num(cy)} L${num(cx - 1)},${num(cy + 3)} L${num(cx + 4.5)},${num(cy - 3.5)}"/>`;
    case 'error':
    case 'fail':
      return `<g><path class="pj-ov-icon pj-ov-icon-warn" d="M${num(cx)},${num(cy - 5)} L${num(cx + 5)},${num(cy + 4)} L${num(cx - 5)},${num(cy + 4)} Z"/><path class="pj-ov-icon pj-ov-icon-warn" d="M${num(cx)},${num(cy - 1.5)} V${num(cy + 1)}"/></g>`;
    case 'loop':
      return `<path class="pj-ov-icon pj-ov-icon-loop" d="M${num(cx + 3.5)},${num(cy - 2)} A4,4 0 1,0 ${num(cx + 4)},${num(cy + 1.5)} M${num(cx + 3.5)},${num(cy - 5)} V${num(cy - 2)} H${num(cx + 0.5)}"/>`;
    default:
      return `<circle class="pj-ov-icon-info" cx="${num(cx)}" cy="${num(cy)}" r="3"/>`;
  }
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

interface LegendItem {
  label: string;
  draw: (x: number) => string;
  width: number;
}

/** One legend key and its words, drawn from x = 0; `width` includes the gap after it. */
export interface LegendEntry {
  svg: string;
  width: number;
}

/** The keys for what this view (and result) actually draws. */
export function legendEntries(view: NetworkView, overlay?: OverlayModel, placement?: OverlayPlacement): LegendEntry[] {
  const has = (kind: NetNode['kind']): boolean => view.nodes.some((node) => node.kind === kind);
  const items: LegendItem[] = [
    { label: 'process', width: 26, draw: (x) => `<rect class="pj-box" x="${x}" y="4" width="22" height="14" rx="4"/>` },
    { label: 'par', width: 26, draw: (x) => `<g class="pj-group-par"><rect class="pj-group-box" x="${x}" y="3" width="22" height="16" rx="5"/></g>` },
  ];
  if (view.nodes.some((node) => node.replicated)) items.push({ label: 'par for (×N processes)', width: 30, draw: (x) => `<rect class="pj-stack" x="${x + 6}" y="6" width="22" height="13" rx="4"/><rect class="pj-box" x="${x}" y="2" width="22" height="13" rx="4"/>` });
  items.push(
    { label: 'channel (writer → reader)', width: 30, draw: (x) => `<path class="pj-legend-line" d="M${x},11 H${x + 22}"/><path class="pj-arrow" d="M${x + 20},7 L${x + 28},11 L${x + 20},15 Z"/>` },
    { label: 'conditional', width: 30, draw: (x) => `<path class="pj-legend-line" d="M${x},11 H${x + 28}" stroke-dasharray="7 4"/>` },
    { label: 'unknown', width: 30, draw: (x) => `<path class="pj-legend-line pj-legend-faint" d="M${x},11 H${x + 28}" stroke-dasharray="2 4"/>` },
  );
  if (has('junction')) items.push({ label: 'shared side', width: 14, draw: (x) => `<circle class="pj-junction" cx="${x + 6}" cy="11" r="5"/>` });
  if (has('barrier')) items.push({ label: 'barrier', width: 26, draw: (x) => `<rect class="pj-barrier-box" x="${x}" y="4" width="22" height="14" rx="7"/>` });
  if (view.edges.some((edge) => edge.tags.includes('not enrolled'))) items.push({ label: 'syncs, not enrolled', width: 30, draw: (x) => `<path class="pj-legend-unenrolled" d="M${x},11 H${x + 28}"/>` });
  if (has('port')) items.push({ label: 'parameter (the caller)', width: 26, draw: (x) => `<path class="pj-port-box" d="M${x + 3},4 H${x + 17} L${x + 23},11 L${x + 17},18 H${x + 3} Q${x},18 ${x},15 V7 Q${x},4 ${x + 3},4 Z"/>` });
  if (has('stub')) items.push({ label: 'no writer / no reader drawn', width: 26, draw: (x) => `<rect class="pj-stub-box" x="${x}" y="4" width="22" height="14" rx="7"/>` });
  if (overlay) {
    const tones = new Set(placement?.outlines.map((outline) => outline.tone) ?? ['root', 'done']);
    const blocked = overlay.processes.filter((process) => process.status === 'blocked');
    if (tones.has('root')) items.push({ label: 'stuck: can never continue', width: 26, draw: (x) => `<rect class="pj-box pj-legend-stuck" x="${x}" y="4" width="22" height="14" rx="4"/>` });
    // Amber is a wait behind another stuck process, or one that a run repeating forever never lets go on.
    if (tones.has('behind') && blocked.some((process) => process.cause === 'knock-on' && process.forGood !== false)) items.push({ label: 'stuck behind another process', width: 26, draw: (x) => `<rect class="pj-box pj-legend-behind" x="${x}" y="4" width="22" height="14" rx="4"/>` });
    if (tones.has('behind') && blocked.some((process) => process.forGood === false)) items.push({ label: 'left waiting: this run never lets it go on', width: 26, draw: (x) => `<rect class="pj-box pj-legend-behind" x="${x}" y="4" width="22" height="14" rx="4"/>` });
    if (tones.has('error') && overlay.severity === 'warning') items.push({ label: 'outside the modelled integers: where the model stops', width: 26, draw: (x) => `<rect class="pj-box pj-legend-behind" x="${x}" y="4" width="22" height="14" rx="4"/>` });
    else if (tones.has('error')) items.push({ label: 'stopped by a runtime error', width: 26, draw: (x) => `<rect class="pj-box pj-legend-stuck" x="${x}" y="4" width="22" height="14" rx="4"/>` });
    if (tones.has('running')) items.push({ label: 'still running', width: 26, draw: (x) => `<rect class="pj-box pj-legend-running" x="${x}" y="4" width="22" height="14" rx="4"/>` });
    if (!placement || placement.markers.length) items.push({ label: 'operation that never completes', width: 20, draw: (x) => `<circle class="pj-ov-marker" cx="${x + 8}" cy="11" r="7"/><rect class="pj-ov-marker-bar" x="${x + 4.5}" y="9.6" width="7" height="2.8" rx="1"/>` });
    if (tones.has('done')) items.push({ label: 'finished', width: 26, draw: (x) => `<rect class="pj-box" x="${x}" y="4" width="22" height="14" rx="4" opacity="0.4"/>` });
    if (overlay.cycles.length && (!placement || placement.curves.some((curve) => curve.tone === 'cycle'))) items.push({ label: 'circular wait', width: 30, draw: (x) => `<path class="pj-legend-cycle" d="M${x},11 H${x + 28}"/>` });
    if (placement?.cycleEdges.length) items.push({ label: 'circular wait along the arrows', width: 30, draw: (x) => `<path class="pj-ov-cycle-route" d="M${x + 4},11 H${x + 24}"/><path class="pj-ov-stuck-edge" d="M${x},11 H${x + 28}"/>` });
    if (placement?.curves.some((curve) => curve.tone !== 'cycle')) items.push({ label: 'waits for', width: 30, draw: (x) => `<path class="pj-ov-waits-for pj-ov-behind" d="M${x},11 H${x + 28}"/>` });
    if (placement?.callouts.some((callout) => callout.tone === 'loop')) items.push({ label: 'repeats forever', width: 30, draw: (x) => `<path class="pj-legend-loop" d="M${x},11 H${x + 28}"/>` });
  }
  return items.map((item) => ({ svg: `${item.draw(0)}<text class="pj-legend-text" x="${num(item.width + 6)}" y="15">${escapeXml(item.label)}</text>`, width: item.width + 6 + textWidth(item.label, 11) + 18 }));
}

/** Legend entries wrapped into rows that fit `width`. */
export function legendRows(entries: readonly LegendEntry[], width: number): string[] {
  const rows: string[] = [];
  let parts: string[] = [];
  let x = 0;
  for (const entry of entries) {
    if (x > 0 && x + entry.width - 18 > width) {
      rows.push(parts.join(''));
      parts = [];
      x = 0;
    }
    parts.push(`<g transform="translate(${num(x)} 0)">${entry.svg}</g>`);
    x += entry.width;
  }
  if (parts.length) rows.push(parts.join(''));
  return rows;
}
