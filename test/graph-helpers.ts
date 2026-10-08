import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { check, type CheckResult } from '../src/checker/checker';
import { analyzeProcedureEffects, type EffectAnalysis } from '../src/checker/effects';
import { DeclIndex } from '../src/checker/index';
import { buildNetwork, type NetNode, type NetworkModel, type NetworkView } from '../src/graph/network';
import { resolveImports } from '../src/imports';
import type * as A from '../src/parser/ast';
import { parse } from '../src/parser/parser';

export const ROOT = path.join(__dirname, '..', '..');
export const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'processj');
export const INCLUDE = path.join(ROOT, 'test', 'fixtures', 'include');

export interface Analyzed {
  text: string;
  uri: string;
  program: A.Program;
  checked: CheckResult;
  index: DeclIndex;
  effects: EffectAnalysis;
  model: NetworkModel;
}

/** Check a program the way the server does (std headers from the test include directory) and build its network. */
export function analyzeSource(text: string, file: string, uri = pathToFileURL(file).toString()): Analyzed {
  const parsed = parse(text);
  if (parsed.errors.length) throw new Error(`syntax errors in ${file}: ${parsed.errors.map((error) => error.message).join('; ')}`);
  const resolution = resolveImports(parsed.program, file, [path.dirname(file)], INCLUDE);
  const index = new DeclIndex();
  index.addProgram(parsed.program, file);
  const trusted = new Set<A.ProcDecl>();
  for (const dependency of resolution.files) {
    const program = parse(fs.readFileSync(dependency, 'utf8')).program;
    index.addProgram(program, dependency);
    if (path.basename(path.dirname(dependency)) !== 'std') continue;
    for (const decl of program.decls) {
      if (decl.kind === 'ProcDecl' && !decl.body && (decl.name.name === 'print' || decl.name.name === 'println')) trusted.add(decl);
    }
  }
  const checked = check(parsed.program, {
    index,
    text,
    importsStd: resolution.importsStd,
    unresolvedImports: resolution.imports.some((entry) => entry.files.length === 0),
    trustedNonBlockingNativeDeclarations: trusted,
  });
  const effects = analyzeProcedureEffects([{ program: parsed.program, checked, file }], { trustedNonBlockingExternalDeclarations: trusted });
  const model = buildNetwork(parsed.program, checked, { uri, text, effects: effects.summaries, index, title: path.basename(file) });
  return { text, uri, program: parsed.program, checked, index, effects, model };
}

export function analyzeFile(file: string, uri?: string): Analyzed {
  return analyzeSource(fs.readFileSync(file, 'utf8'), file, uri);
}

export function programView(model: NetworkModel): NetworkView {
  const view = model.views.find((entry) => entry.kind === 'program');
  if (!view) throw new Error('no program view');
  return view;
}

export function viewOf(model: NetworkModel, procedure: string): NetworkView {
  const view = model.views.find((entry) => entry.procedure === procedure && entry.kind === 'procedure');
  if (!view) throw new Error(`no view for ${procedure}`);
  return view;
}

export function nodeNamed(view: NetworkView, name: string): NetNode {
  const node = view.nodes.find((entry) => entry.name === name || entry.label === name);
  if (!node) throw new Error(`no node '${name}' in ${view.label}: ${view.nodes.map((entry) => entry.name).join(', ')}`);
  return node;
}

/** `writer -> reader` pairs of a channel's drawn edges, by process name. */
export function channelEdges(view: NetworkView, name: string): string[] {
  const channel = view.channels.find((entry) => entry.name === name);
  if (!channel) throw new Error(`no channel '${name}'`);
  const label = (id: string): string => {
    const node = view.nodes.find((entry) => entry.id === id)!;
    return node.kind === 'junction' ? '*' : node.kind === 'port' ? `port ${node.label}` : node.kind === 'stub' ? node.label : node.name;
  };
  return channel.edges.map((id) => view.edges.find((edge) => edge.id === id)!).map((edge) => `${label(edge.from)} -> ${label(edge.to)}`);
}

/** Line (1-based) and column of a span start, for compact assertions. */
export function at(span: A.Span): string {
  return `${span.start.line + 1}:${span.start.col + 1}`;
}
