/**
 * One version of a CSPm document as the language server sees it: parsed once,
 * its roots listed, and each root's view built when something asks for it
 * (the viewer, an export, the FDR explainer). Also its document symbols, its
 * parse diagnostics, and the ProcessJ file a generated model came from.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NetworkModel } from '../graph/network';
import type { Assertion, CspmDiagnostic, CspmFile, Decl, Span } from './ast';
import { Globals, isProcessExpr } from './eval';
import { buildCspmView, cspmModel, cspmRoots, type CspmRoot, type CspmView } from './network';
import { parseCspm, spanText } from './parser';

export interface CspmSymbol {
  name: string;
  kind: 'process' | 'function' | 'value' | 'channel' | 'datatype' | 'assertion';
  /** The whole declaration. */
  span: Span;
  /** Its name. */
  selection: Span;
  detail?: string;
}

export class CspmDocument {
  readonly file: CspmFile;
  readonly globals: Globals;
  readonly roots: CspmRoot[];
  private readonly views = new Map<string, CspmView>();
  private defaultId?: string;

  constructor(readonly uri: string, readonly text: string, readonly version?: number, readonly title = titleOf(uri)) {
    this.file = parseCspm(text);
    this.globals = new Globals(this.file.decls, text);
    this.roots = cspmRoots(this.file, this.globals, uri, text);
  }

  get diagnostics(): CspmDiagnostic[] {
    return this.file.diagnostics;
  }

  /** The view of one root, built on first use. */
  view(id: string): CspmView | undefined {
    const cached = this.views.get(id);
    if (cached) return cached;
    const root = this.roots.find((entry) => entry.id === id);
    if (!root) return undefined;
    const view = buildCspmView(root, this.globals, { uri: this.uri, text: this.text, title: this.title, generated: !!this.file.generatedFrom });
    this.views.set(id, view);
    return view;
  }

  /** The view an assertion's result is placed in: the one of the process it is about. */
  viewForAssertion(assertion: Assertion): CspmView | undefined {
    const impl = assertion.impl;
    const name = impl.k === 'name' && this.globals.definitions.get(impl.name)?.some((def) => def.params.length === 0) ? impl.name : spanText(this.text, impl.span);
    const root = this.roots.find((entry) => entry.name === name);
    return root ? this.view(root.id) : undefined;
  }

  /** MAIN, SYSTEM or main; else the first asserted root that is a network; else the first network; else the first root. */
  defaultView(): string {
    if (this.defaultId !== undefined) return this.defaultId;
    const isNetwork = (root: CspmRoot): boolean => this.view(root.id)?.tree.kind === 'comp';
    const named = this.roots.find((root) => root.definition && ['MAIN', 'SYSTEM', 'main', 'System'].includes(root.definition) && isNetwork(root));
    const chosen = named
      ?? this.roots.find((root) => root.section === 'asserted' && isNetwork(root))
      ?? this.roots.slice(0, 40).find(isNetwork)
      ?? this.roots[0];
    this.defaultId = chosen?.id ?? '';
    return this.defaultId;
  }

  /**
   * Where the graph lens goes, from the parse alone (no view is built, so a
   * lens refresh after an edit stays cheap): MAIN, SYSTEM or main, else the
   * first asserted process, else the first process.
   */
  lensRoot(): CspmRoot | undefined {
    return this.roots.find((root) => root.definition && ['MAIN', 'SYSTEM', 'main', 'System'].includes(root.definition))
      ?? this.roots.find((root) => root.section === 'asserted')
      ?? this.roots[0];
  }

  /** The model with the views built so far, and these. */
  model(ids: readonly string[] = []): NetworkModel {
    for (const id of ids) this.view(id);
    const defaultView = this.defaultView();
    const built = this.roots.map((root) => this.views.get(root.id)).filter((view): view is CspmView => !!view);
    return { ...cspmModel(built, { uri: this.uri, title: this.title }), defaultView };
  }

  /** The ProcessJ source of a model Convert to CSP generated (its header names the file), when it exists next to this one. */
  generatedFrom(): string | undefined {
    const name = this.file.generatedFrom;
    if (!name) return undefined;
    let own: string;
    try {
      own = fileURLToPath(this.uri);
    } catch {
      return undefined;
    }
    return path.join(path.dirname(own), path.basename(name));
  }

  symbols(): CspmSymbol[] {
    const out: CspmSymbol[] = [];
    const seen = new Set<string>();
    for (const decl of this.file.decls) out.push(...symbolsOf(decl, this, seen));
    return out;
  }
}

function symbolsOf(decl: Decl, doc: CspmDocument, seen: Set<string>): CspmSymbol[] {
  switch (decl.kind) {
    case 'def': {
      // Definitions by several clauses are one symbol.
      if (seen.has(decl.name.name)) return [];
      seen.add(decl.name.name);
      const kind = isProcessExpr(decl.body, doc.globals) ? 'process' : decl.params.length ? 'function' : 'value';
      const params = decl.params.map((group) => `(${group.map((param) => spanText(doc.text, param.span)).join(', ')})`).join('');
      return [{ name: `${decl.name.name}${params}`, kind, span: decl.span, selection: decl.name.span, ...(decl.comment ? { detail: decl.comment } : {}) }];
    }
    case 'channel':
      return decl.names.map((name) => ({ name: name.name, kind: 'channel' as const, span: decl.span, selection: name.span, ...(decl.type ? { detail: spanText(doc.text, decl.type.span) } : {}) }));
    case 'datatype':
      return [{ name: decl.name.name, kind: 'datatype', span: decl.span, selection: decl.name.span, detail: decl.constructors.map((ctor) => ctor.name.name).join(' | ') }];
    case 'nametype':
      return [{ name: decl.name.name, kind: 'datatype', span: decl.span, selection: decl.name.span }];
    case 'assert':
      return [{ name: `assert ${decl.text}`, kind: 'assertion', span: decl.span, selection: decl.span }];
    default:
      return [];
  }
}

function titleOf(uri: string): string {
  try {
    return path.basename(fileURLToPath(uri));
  } catch {
    return decodeURIComponent(uri.split('/').pop() ?? 'model.csp');
  }
}
