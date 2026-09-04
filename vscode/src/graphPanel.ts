import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';

interface SourceLocation {
  uri?: string;
  span: { start: { line: number; col: number }; end: { line: number; col: number } };
}

interface GraphNode {
  id: string;
  kind: string;
  label: string;
  source: SourceLocation;
  confidence: 'exact' | 'conditional' | 'unknown';
  detail?: string;
  replicated?: boolean;
}

interface GraphEdge {
  id: string;
  kind: string;
  from: string;
  to: string;
  confidence: 'exact' | 'conditional' | 'unknown';
  label?: string;
}

interface GraphResult {
  version: 1;
  view?: 'concurrency' | 'protocol';
  uri?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  deadlocks: Array<{ id: string; cause: string; waits: Array<{ branch: number; operation: string; channelNode: string; source: SourceLocation }> }>;
  procedureEffects: Record<string, Array<{ label: string; confidence: string }>>;
  notices?: Array<{ severity: string; title: string; detail: string }>;
}

interface ProtocolResult {
  protocols: Array<{ id: string; name: string; file?: string; span: SourceLocation['span']; nameSpan: SourceLocation['span']; local: boolean; caseSetComplete: boolean; parents: Array<{ name: string; targetId?: string; span: SourceLocation['span'] }>; cases: Array<{ id: string; name: string; file?: string; span: SourceLocation['span']; inherited: boolean; declaringProtocolName: string; effective: boolean; fields: Array<{ name: string; typeLabel: string }> }>; collisions: Array<{ caseName: string; origins: Array<{ declaringProtocolName: string }> }> }>;
  flows: Array<{ id: string; kind: string; file?: string; span: SourceLocation['span']; protocolId: string; caseId?: string; caseName?: string; procedureId?: string; procedureName?: string }>;
  issues: Array<{ severity: string; message: string }>;
}

export async function showConcurrencyGraph(client: LanguageClient): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'processj') {
    void vscode.window.showWarningMessage('ProcessJ: open a ProcessJ editor first.');
    return;
  }
  const graph = await client.sendRequest<GraphResult | null>('processj/concurrencyGraph', { textDocument: { uri: editor.document.uri.toString() } });
  if (!graph) {
    void vscode.window.showWarningMessage('ProcessJ: the concurrency model is not available for this editor.');
    return;
  }

  showGraphPanel(graph, path.basename(editor.document.fileName), 'Concurrency topology');
}

export async function showProtocolGraph(client: LanguageClient): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'processj') {
    void vscode.window.showWarningMessage('ProcessJ: open a ProcessJ editor first.');
    return;
  }
  const model = await client.sendRequest<ProtocolResult | null>('processj/protocolModel', { textDocument: { uri: editor.document.uri.toString() } });
  if (!model) {
    void vscode.window.showWarningMessage('ProcessJ: protocol intelligence is not available for this editor.');
    return;
  }
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  let edgeId = 0;
  const uriFor = (file: string | undefined): string => !file ? editor.document.uri.toString() : !/^[a-z]:[\\/]/i.test(file) && /^[a-z][a-z0-9+.-]*:/i.test(file) ? file : vscode.Uri.file(file).toString();
  for (const protocol of model.protocols) {
    nodes.set(protocol.id, { id: protocol.id, kind: 'protocol', label: protocol.name, source: { uri: uriFor(protocol.file), span: protocol.nameSpan }, confidence: protocol.caseSetComplete ? 'exact' : 'conditional', detail: `${protocol.cases.filter((entry) => entry.effective).length} declared cases${protocol.caseSetComplete ? '' : ' · partial inherited case set'}` });
    for (const parent of protocol.parents) if (parent.targetId) edges.push({ id: `protocol-edge-${edgeId++}`, kind: 'inherits', from: protocol.id, to: parent.targetId, confidence: 'exact', label: 'extends' });
    for (const protocolCase of protocol.cases.filter((entry) => entry.effective)) {
      nodes.set(protocolCase.id, { id: protocolCase.id, kind: 'case', label: protocolCase.name, source: { uri: uriFor(protocolCase.file), span: protocolCase.span }, confidence: 'exact', detail: protocolCase.fields.map((field) => `${field.typeLabel} ${field.name}`).join(', ') || 'no fields' });
      edges.push({ id: `protocol-edge-${edgeId++}`, kind: 'contains', from: protocol.id, to: protocolCase.id, confidence: 'exact', label: 'declares' });
    }
  }
  const observed: GraphResult['procedureEffects'] = {};
  for (const flow of model.flows) {
    if (!flow.procedureId || !flow.procedureName) continue;
    if (!nodes.has(flow.procedureId)) nodes.set(flow.procedureId, { id: flow.procedureId, kind: 'procedure', label: flow.procedureName, source: { uri: uriFor(flow.file), span: flow.span }, confidence: 'exact', detail: 'procedure observed in protocol flow' });
    const facts = observed[flow.procedureId] ??= [];
    facts.push({ label: `${flow.kind}${flow.caseName ? ` ${flow.caseName}` : ''}`, confidence: 'exact' });
    const caseOrProtocol = flow.caseId ?? flow.protocolId;
    if (!nodes.has(caseOrProtocol)) continue;
    const outbound = flow.kind === 'send' || flow.kind === 'construct';
    edges.push({ id: `protocol-edge-${edgeId++}`, kind: flow.kind, from: outbound ? flow.procedureId : caseOrProtocol, to: outbound ? caseOrProtocol : flow.procedureId, confidence: flow.caseId || flow.kind === 'receive' ? 'exact' : 'conditional', label: flow.kind });
  }
  const graph: GraphResult = {
    version: 1,
    view: 'protocol',
    uri: editor.document.uri.toString(),
    nodes: [...nodes.values()],
    edges,
    deadlocks: [],
    procedureEffects: observed,
    notices: model.issues.map((issue) => ({ severity: issue.severity, title: issue.severity === 'error' ? 'Protocol error' : 'Protocol warning', detail: issue.message })),
  };
  showGraphPanel(graph, path.basename(editor.document.fileName), 'Protocol structure and observed flow');
}

function showGraphPanel(graph: GraphResult, title: string, heading: string): void {
  const panel = vscode.window.createWebviewPanel(
    'processjConcurrencyGraph',
    `ProcessJ ${heading} — ${title}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.html = graphHtml(panel.webview, graph, title, heading);
  panel.webview.onDidReceiveMessage(async (message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const value = message as { type?: unknown; uri?: unknown; line?: unknown; col?: unknown; text?: unknown };
    if (value.type === 'copy' && typeof value.text === 'string') {
      await vscode.env.clipboard.writeText(value.text);
      void vscode.window.showInformationMessage('ProcessJ: graph JSON copied.');
      return;
    }
    if (value.type !== 'open' || typeof value.uri !== 'string' || typeof value.line !== 'number' || typeof value.col !== 'number') return;
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(value.uri));
    const target = await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
    const position = new vscode.Position(value.line, value.col);
    target.selection = new vscode.Selection(position, position);
    target.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  });
}

function graphHtml(webview: vscode.Webview, graph: GraphResult, title: string, heading: string): string {
  const nonce = crypto.randomBytes(16).toString('hex');
  const data = JSON.stringify(graph).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>${escapeHtml(`ProcessJ ${heading} — ${title}`)}</title>
  <style>
    :root { color-scheme: light dark; --muted: var(--vscode-descriptionForeground); --border: var(--vscode-panel-border); --surface: var(--vscode-editorWidget-background); --accent: var(--vscode-focusBorder); --danger: var(--vscode-errorForeground); }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: 13px/1.45 var(--vscode-font-family); }
    header { position: sticky; top: 0; z-index: 5; display: flex; gap: 12px; align-items: center; padding: 12px 16px; background: color-mix(in srgb, var(--vscode-editor-background) 94%, transparent); border-bottom: 1px solid var(--border); backdrop-filter: blur(10px); }
    h1 { margin: 0; font-size: 15px; flex: 1; }
    input, select, button { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--border)); border-radius: 4px; padding: 5px 8px; }
    button { cursor: pointer; }
    main { display: grid; grid-template-columns: minmax(620px, 1fr) 280px; min-height: calc(100vh - 51px); }
    #canvas { overflow: auto; border-right: 1px solid var(--border); }
    svg { min-width: 100%; height: auto; }
    .edge { fill: none; stroke: var(--vscode-editor-foreground); stroke-opacity: .28; stroke-width: 1.3; marker-end: url(#arrow); }
    .edge.uncertain { stroke-dasharray: 5 5; }
    .edge-label { fill: var(--muted); font-size: 10px; text-anchor: middle; }
    .node { cursor: pointer; }
    .node rect { fill: var(--surface); stroke: var(--border); stroke-width: 1.2; rx: 7; }
    .node:hover rect, .node:focus rect { stroke: var(--accent); stroke-width: 2; }
    .node.uncertain rect { stroke-dasharray: 5 4; }
    .node.deadlock rect { stroke: var(--danger); stroke-width: 2; }
    .node text { pointer-events: none; fill: var(--vscode-foreground); }
    .node .kind { fill: var(--muted); font-size: 9px; text-transform: uppercase; letter-spacing: .7px; }
    aside { padding: 14px; overflow: auto; }
    .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 16px; }
    .stat { padding: 9px; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; }
    .stat strong { display: block; font-size: 18px; }
    h2 { margin: 18px 0 7px; font-size: 12px; text-transform: uppercase; letter-spacing: .8px; color: var(--muted); }
    .card { padding: 9px; margin: 7px 0; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); }
    .card.danger { border-color: var(--danger); }
    .pill { display: inline-block; margin: 2px 3px 2px 0; padding: 1px 5px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 10px; }
    .empty { color: var(--muted); }
    @media (max-width: 850px) { main { grid-template-columns: 1fr; } #canvas { border-right: 0; border-bottom: 1px solid var(--border); } }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(heading)} · ${escapeHtml(title)}</h1>
    <input id="search" type="search" placeholder="Filter nodes" aria-label="Filter graph nodes">
    <select id="confidence" aria-label="Confidence filter"><option value="all">All facts</option><option value="exact">Exact only</option></select>
    <button id="copy">Copy JSON</button>
  </header>
  <main><div id="canvas"><svg id="graph" role="img" aria-label="${escapeHtml(`ProcessJ ${heading}`)}"></svg></div><aside id="details"></aside></main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const model = ${data};
    const svg = document.getElementById('graph');
    const details = document.getElementById('details');
    const NS = 'http://www.w3.org/2000/svg';
    const dead = new Set(model.deadlocks.flatMap(d => d.waits.map(w => w.channelNode)));
    const columns = [['procedure','mobile'], ['parallel','alternation','protocol'], ['branch','case'], ['channel','barrier','timer']];
    const grouped = columns.map(kinds => model.nodes.filter(n => kinds.includes(n.kind)));
    const unplaced = model.nodes.filter(n => !columns.some(kinds => kinds.includes(n.kind)));
    grouped[1].push(...unplaced);
    const pos = new Map();
    const width = 1160, row = 82, top = 42, nodeW = 205, nodeH = 48;
    grouped.forEach((items, column) => items.forEach((node, index) => pos.set(node.id, { x: 35 + column * 285, y: top + index * row })));
    const height = Math.max(420, ...grouped.map(items => top + items.length * row));
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    const defs = document.createElementNS(NS, 'defs');
    defs.innerHTML = '<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke"/></marker>';
    svg.appendChild(defs);
    const edgeLayer = document.createElementNS(NS, 'g');
    const nodeLayer = document.createElementNS(NS, 'g');
    svg.append(edgeLayer, nodeLayer);
    const edgeElements = [];
    for (const edge of model.edges) {
      const a = pos.get(edge.from), b = pos.get(edge.to); if (!a || !b) continue;
      const path = document.createElementNS(NS, 'path');
      const x1 = a.x + nodeW, y1 = a.y + nodeH / 2, x2 = b.x, y2 = b.y + nodeH / 2;
      const bend = Math.max(45, Math.abs(x2 - x1) * .45);
      path.setAttribute('d', 'M' + x1 + ',' + y1 + ' C' + (x1 + bend) + ',' + y1 + ' ' + (x2 - bend) + ',' + y2 + ' ' + x2 + ',' + y2);
      path.setAttribute('class', 'edge ' + (edge.confidence === 'exact' ? '' : 'uncertain'));
      path.dataset.from = edge.from; path.dataset.to = edge.to; path.dataset.confidence = edge.confidence;
      const title = document.createElementNS(NS, 'title'); title.textContent = (edge.label || edge.kind) + ' · ' + edge.confidence; path.appendChild(title);
      edgeLayer.appendChild(path); edgeElements.push(path);
    }
    const nodeElements = new Map();
    for (const node of model.nodes) {
      const p = pos.get(node.id); if (!p) continue;
      const group = document.createElementNS(NS, 'g');
      group.setAttribute('class', 'node ' + (node.confidence === 'exact' ? '' : 'uncertain') + (dead.has(node.id) ? ' deadlock' : ''));
      group.setAttribute('transform', 'translate(' + p.x + ',' + p.y + ')'); group.setAttribute('tabindex', '0'); group.setAttribute('role', 'button');
      group.dataset.search = (node.label + ' ' + node.kind + ' ' + (node.detail || '')).toLowerCase(); group.dataset.confidence = node.confidence;
      const rect = document.createElementNS(NS, 'rect'); rect.setAttribute('width', nodeW); rect.setAttribute('height', nodeH);
      const label = document.createElementNS(NS, 'text'); label.setAttribute('x', '10'); label.setAttribute('y', '21'); label.textContent = node.label + (node.replicated ? ' × N' : '');
      const kind = document.createElementNS(NS, 'text'); kind.setAttribute('class', 'kind'); kind.setAttribute('x', '10'); kind.setAttribute('y', '38'); kind.textContent = node.kind + ' · ' + node.confidence;
      const title = document.createElementNS(NS, 'title'); title.textContent = node.detail || node.label;
      group.append(rect, label, kind, title);
      const open = () => { if (node.source?.uri) vscode.postMessage({ type:'open', uri:node.source.uri, line:node.source.span.start.line, col:node.source.span.start.col }); };
      group.addEventListener('click', open); group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') open(); });
      nodeLayer.appendChild(group); nodeElements.set(node.id, group);
    }
    const stat = (label, value) => '<div class="stat"><strong>' + value + '</strong>' + label + '</div>';
    const cards = [];
    const protocolView = model.view === 'protocol';
    cards.push('<div class="stats">' + stat('nodes', model.nodes.length) + stat('edges', model.edges.length) + stat(protocolView ? 'cases' : 'channels', model.nodes.filter(n=>n.kind===(protocolView?'case':'channel')).length) + stat(protocolView ? 'issues' : 'deadlocks', protocolView ? (model.notices||[]).length : model.deadlocks.length) + '</div>');
    cards.push('<h2>' + (protocolView ? 'Coverage and collisions' : 'Confirmed deadlocks') + '</h2>');
    if (protocolView) { if (!(model.notices||[]).length) cards.push('<div class="empty">No protocol coverage or collision issues.</div>'); for (const notice of model.notices||[]) cards.push('<div class="card '+(notice.severity==='error'?'danger':'')+'"><strong>'+escapeText(notice.title)+'</strong><br>'+escapeText(notice.detail)+'</div>'); }
    else { if (!model.deadlocks.length) cards.push('<div class="empty">None in the exact straight-line model.</div>'); for (const finding of model.deadlocks) cards.push('<div class="card danger"><strong>' + (finding.cause === 'circular-wait' ? 'Circular wait' : 'Missing peer') + '</strong><br>' + finding.waits.map(w => 'branch ' + w.branch + ' waits to ' + w.operation).join(' · ') + '</div>'); }
    cards.push('<h2>' + (protocolView ? 'Observed flow' : 'Procedure effects') + '</h2>');
    for (const [id, facts] of Object.entries(model.procedureEffects)) { const node = model.nodes.find(n=>n.id===id); cards.push('<div class="card"><strong>' + escapeText(node?.label || id) + '</strong><br>' + facts.map(f=>'<span class="pill">'+escapeText(f.label)+(f.confidence==='exact'?'':' · partial')+'</span>').join('') + '</div>'); }
    details.innerHTML = cards.join('');
    function escapeText(value) { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    function filter() {
      const query = document.getElementById('search').value.trim().toLowerCase(); const confidence = document.getElementById('confidence').value; const visible = new Set();
      for (const [id, element] of nodeElements) { const show = (!query || element.dataset.search.includes(query)) && (confidence === 'all' || element.dataset.confidence === 'exact'); element.style.display = show ? '' : 'none'; if (show) visible.add(id); }
      for (const edge of edgeElements) edge.style.display = visible.has(edge.dataset.from) && visible.has(edge.dataset.to) && (confidence === 'all' || edge.dataset.confidence === 'exact') ? '' : 'none';
    }
    document.getElementById('search').addEventListener('input', filter); document.getElementById('confidence').addEventListener('change', filter);
    document.getElementById('copy').addEventListener('click', () => vscode.postMessage({ type:'copy', text:JSON.stringify(model, null, 2) }));
  </script>
</body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
