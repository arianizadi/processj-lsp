/**
 * The portable text form of the process network: who runs in parallel, which
 * channel goes from which writer to which reader, barriers and their members,
 * procedure effects, and every verification result in words, with a Mermaid
 * flowchart of the network for viewers that render one.
 *
 * Names and messages come from the program (file, procedure and channel
 * names, CSPm text) and from FDR: they are escaped (md, code, cell) so a
 * renderer shows them as text, never as HTML, links, images or code fences.
 */
import type { CheckOutcome, VerificationReport } from '../verification';
import { countText, viewProcesses, type NetChannel, type NetNode, type NetworkModel, type NetworkView } from './network';
import { story } from './overlay';

/** Markdown for a model's default view (and a summary of the others). */
export function formatConcurrencyMarkdown(title: string, model: NetworkModel, reports: readonly VerificationReport[] = []): string {
  const view = model.views.find((entry) => entry.id === model.defaultView) ?? model.views[0];
  const lines: string[] = [`# Process network — ${md(title)}`, ''];
  if (!view) {
    lines.push('_This file declares no procedure with a body._', '');
    return lines.join('\n');
  }
  lines.push(viewSummary(view), '');
  const findings = reports.flatMap((report) => report.checks.map((check) => ({ report, check })));
  if (findings.length) {
    lines.push('## Verification', '');
    for (const { report, check } of findings) lines.push(...checkLines(report, check));
    lines.push('');
  }
  lines.push('## Processes', '', ...processLines(view), '');
  const channels = view.channels.filter((channel) => channel.kind === 'channel' && (channel.writers.length || channel.readers.length || channel.port));
  if (channels.length) {
    lines.push('## Channels', '', '| channel | carries | written by | read by |', '| --- | --- | --- | --- |');
    for (const channel of channels) lines.push(`| ${cell(code(channel.name))} | ${cell(md(channel.type))}${sharedText(channel)} | ${ends(view, channel, 'writers')} | ${ends(view, channel, 'readers')} |`);
    lines.push('');
  }
  const barriers = view.channels.filter((channel) => channel.kind === 'barrier');
  if (barriers.length) {
    lines.push('## Barriers', '');
    for (const barrier of barriers) {
      const members = barrier.members.map((member) => `${md(nodeName(view, member.node))}${member.tags.includes('not enrolled') ? ' (syncs, **not enrolled**)' : ''}`);
      lines.push(`- ${code(barrier.name)}: ${members.join(', ') || 'no process drawn'}`);
    }
    lines.push('');
  }
  if (view.notes.length) lines.push('## Notes', '', ...view.notes.map((note) => `- ${md(note)}`), '');
  lines.push('## Diagram', '', '```mermaid', ...mermaid(view), '```', '');
  const others = model.views.filter((entry) => entry !== view);
  if (others.length) {
    lines.push('## Procedure effects', '');
    for (const other of others) {
      const root = other.nodes.find((node) => !node.parent && node.path?.length === 0);
      const facts = root?.facts.length ? md(root.facts.join(', ')) : 'local computation only';
      lines.push(`- **${md(other.label)}**: ${facts}`);
    }
    lines.push('');
  }
  lines.push('_Arrows go from the writing process to the reading one. Dashed arrows are conditional: used only under an if, a loop that may not run, a switch or an alt. Dotted ones pass through code that cannot be followed. The open graph viewer (the default of this command) adds pan, zoom, search and the counterexample timeline._', '');
  return lines.join('\n');
}

function viewSummary(view: NetworkView): string {
  const processes = viewProcesses(view);
  const channels = view.channels.filter((channel) => channel.kind === 'channel' && channel.edges.length).length;
  const root = view.nodes.find((node) => node.path?.length === 0);
  if (!processes.count && !processes.unsized) return `**${md(view.label)}** runs as one sequential process${root?.operations.length ? ` and uses ${channels === 1 ? 'one channel' : `${channels} channels`}` : ''}.`;
  return `**${md(view.label)}** runs ${countText(processes)} connected by ${channels} channel${channels === 1 ? '' : 's'}.`;
}

function checkLines(report: VerificationReport, check: CheckOutcome): string[] {
  const by = report.producer === 'fdr' ? `FDR${report.tool?.version ? ` ${report.tool.version}` : ''}` : 'static analysis';
  const stats = [check.stats?.states !== undefined ? `${check.stats.states} states` : '', check.stats?.ms !== undefined ? `${check.stats.ms} ms` : ''].filter(Boolean).join(', ');
  const mark = check.status === 'passed' ? '✓' : check.status === 'failed' ? (check.severity === 'info' ? 'ℹ' : '✕') : '•';
  const summary = check.status === 'failed' && check.counterexample ? check.counterexample.summary : check.status;
  // An FDR failure's message is its summary: said once.
  const head = `- ${mark} **${md(check.label)}** (${md(by)}${stats ? `, ${stats}` : ''}): ${md(summary)}${check.message && check.message !== summary ? `. ${md(check.message)}` : ''}`;
  const out = [head];
  if (check.counterexample) {
    for (const sentence of story(check.counterexample, check)) out.push(`  - ${md(sentence)}`);
    for (const caveat of check.counterexample.caveats ?? []) out.push(`  - Caveat: ${md(caveat)}.`);
  }
  return out;
}

function processLines(view: NetworkView): string[] {
  const out: string[] = [];
  const children = new Map<string, NetNode[]>();
  for (const node of view.nodes) {
    const list = children.get(node.parent ?? '');
    if (list) list.push(node);
    else children.set(node.parent ?? '', [node]);
  }
  const describe = (node: NetNode, depth: number): void => {
    if (node.kind === 'process' || node.kind === 'group') {
      const roles = operationsText(view, node);
      const where = node.source ? ` (line ${node.source.span.start.line + 1})` : '';
      const label = node.label === node.name ? `**${md(node.name)}**` : `**${md(node.name)}** ${code(node.label)}`;
      const replicated = node.replicated ? ` ${md(node.replicated.text)}` : '';
      const kind = node.kind === 'group' ? node.path ? (node.path.length === 0 ? '' : ' runs:') : ' (container):' : '';
      out.push(`${'  '.repeat(depth)}- ${label}${replicated}${where}${roles ? ` — ${roles}` : ''}${kind}`);
    }
    for (const child of children.get(node.id) ?? []) describe(child, node.kind === 'group' ? depth + 1 : depth);
  };
  for (const node of children.get('') ?? []) describe(node, 0);
  return out;
}

function operationsText(view: NetworkView, node: NetNode): string {
  const parts: string[] = [];
  const byChannel = new Map<string, Set<string>>();
  for (const operation of node.operations) {
    let kinds = byChannel.get(operation.channel);
    if (!kinds) byChannel.set(operation.channel, (kinds = new Set()));
    kinds.add(operation.kind === 'alt-guard' ? 'reads (in an alt)' : operation.kind === 'extended-read' ? 'reads (extended)' : operation.kind === 'write' ? 'writes' : operation.kind === 'sync' ? 'syncs on' : operation.kind === 'pass' ? 'passes' : 'reads');
  }
  for (const [channelId, kinds] of byChannel) {
    const channel = view.channels.find((entry) => entry.id === channelId);
    const conditional = node.operations.filter((operation) => operation.channel === channelId).every((operation) => operation.confidence !== 'exact');
    parts.push(`${[...kinds].join(', ')} ${code(channel?.name ?? channelId)}${conditional ? ' (conditional)' : ''}`);
  }
  return parts.join('; ');
}

function ends(view: NetworkView, channel: NetChannel, side: 'writers' | 'readers'): string {
  const list = channel[side];
  const port = channel.port ? view.nodes.find((node) => node.id === channel.port) : undefined;
  const environment = port && ((side === 'writers' && port.port?.direction === 'in') || (side === 'readers' && port.port?.direction === 'out')) ? ['the caller (parameter)'] : [];
  const names = [...environment, ...list.map((end) => `${md(nodeName(view, end.node))}${end.confidence === 'exact' ? '' : ` (${end.confidence})`}`)];
  if (!names.length) return channel.hazard === (side === 'writers' ? 'no-writer' : 'no-reader') ? '**none (proven)**' : '_none here_';
  return cell(names.join(', '));
}

function sharedText(channel: NetChannel): string {
  if (channel.shared.read && channel.shared.write) return ', shared';
  if (channel.shared.write) return ', shared writers';
  if (channel.shared.read) return ', shared readers';
  return '';
}

function nodeName(view: NetworkView, id: string): string {
  const node = view.nodes.find((entry) => entry.id === id);
  return node ? node.name : id;
}

/** Line breaks and other control characters, which would end a list item, a table row or a code span. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/**
 * Text as Markdown text, on one line: backslash escapes for the characters
 * that start raw HTML (`<`), links and images (`[`, `]`), code spans and
 * emphasis. Rendered, it reads exactly as given.
 */
function md(text: string): string {
  return text.replace(CONTROL, ' ').replace(/[\\`*[\]<>]/g, (character) => `\\${character}`);
}

/** A code span holding `text` as written: its fence is longer than any run of backticks inside. */
function code(text: string): string {
  const flat = text.replace(CONTROL, ' ');
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  return longest ? `${fence} ${flat} ${fence}` : `${fence}${flat}${fence}`;
}

/** A table cell: a pipe would end it, even inside a code span. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/** A Mermaid flowchart of the view: groups as subgraphs, channels as labelled edges. */
function mermaid(view: NetworkView): string[] {
  const lines = ['flowchart LR'];
  const ids = new Map(view.nodes.map((node, index) => [node.id, `n${index}`]));
  const children = new Map<string, NetNode[]>();
  for (const node of view.nodes) {
    const list = children.get(node.parent ?? '');
    if (list) list.push(node);
    else children.set(node.parent ?? '', [node]);
  }
  const emit = (node: NetNode, indent: string): void => {
    const id = ids.get(node.id)!;
    const kids = children.get(node.id) ?? [];
    if (node.kind === 'group' && kids.length) {
      lines.push(`${indent}subgraph ${id}["${escapeMermaid(`${node.badge ? `${node.badge} · ` : ''}${node.label}${node.replicated ? ` ${node.replicated.text}` : ''}`)}"]`);
      for (const kid of kids) emit(kid, `${indent}  `);
      lines.push(`${indent}end`);
      return;
    }
    const label = escapeMermaid(`${node.label}${node.replicated ? ` ${node.replicated.text}` : ''}`);
    switch (node.kind) {
      case 'junction': lines.push(`${indent}${id}(("${escapeMermaid(node.label)}"))`); break;
      case 'barrier': lines.push(`${indent}${id}{{"barrier ${label}"}}`); break;
      case 'port': lines.push(`${indent}${id}>"${label}"]`); break;
      case 'stub': lines.push(`${indent}${id}["${label}"]`, `${indent}class ${id} missing`); break;
      default: lines.push(`${indent}${id}["${label}"]`); if (node.confidence !== 'exact') lines.push(`${indent}class ${id} uncertain`);
    }
  };
  for (const node of children.get('') ?? []) emit(node, '  ');
  // Mermaid numbers links in order; an unknown one gets a dotted, faint style of its own.
  let link = 0;
  const unknown: number[] = [];
  for (const edge of view.edges) {
    const from = ids.get(edge.from);
    const to = ids.get(edge.to);
    if (!from || !to) continue;
    if (edge.kind === 'barrier') {
      lines.push(edge.label ? `  ${from} -.-|"${escapeMermaid(edge.label)}"| ${to}` : `  ${from} -.- ${to}`);
      link++;
      continue;
    }
    if (edge.confidence === 'unknown') unknown.push(link);
    const arrow = edge.confidence === 'exact' ? '-->' : '-.->';
    lines.push(edge.label ? `  ${from} ${arrow}|"${escapeMermaid(edge.label)}"| ${to}` : `  ${from} ${arrow} ${to}`);
    link++;
  }
  if (unknown.length) lines.push(`  linkStyle ${unknown.join(',')} stroke-dasharray: 2 4,stroke:#94a3b8`);
  lines.push('  classDef uncertain stroke-dasharray: 5 5', '  classDef missing stroke-dasharray: 3 3,color:#dc2626');
  return lines;
}

function escapeMermaid(value: string): string {
  // One line, and no backticks: a line of them would close the fenced block the chart is in.
  return value.replace(CONTROL, ' ').replace(/["<>`]/g, (character) => character === '"' || character === '`' ? "'" : character === '<' ? '‹' : '›').replace(/\|/g, '¦');
}
