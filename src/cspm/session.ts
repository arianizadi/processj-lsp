/**
 * The graph of a CSPm document, as src/graph/session.ts is for ProcessJ: per
 * document version the views built so far and their layouts, FDR's report
 * from the verification store, and the same payload, page and export formats
 * the viewer and the renderers already produce. A CSPm document has no
 * static checker report: what is shown about it is FDR's.
 */
import type { VerificationReport } from '../verification';
import type { ViewLayout } from '../graph/layout';
import { verificationStore, type VerificationStore } from '../graph/live';
import type { NetworkView, NetworkViewStub } from '../graph/network';
import { buildOverlays, preferredView, type OverlayModel } from '../graph/overlay';
import { buildViewerPayload, buildViewerView, DEFAULT_BUDGET, layoutOrFallback, type ViewerFocus, type ViewerPayload, type ViewerView } from '../graph/payload';
import { renderExcalidraw } from '../graph/render-excalidraw';
import { renderViewerHtml } from '../graph/render-html';
import { formatConcurrencyMarkdown } from '../graph/render-markdown';
import { renderNetworkSvg } from '../graph/render-svg';
import type { GraphFormat } from '../graph/session';
import type { CspmDocument } from './document';

const FILE_BUDGET = Object.freeze({ views: 200, nodes: 15_000 });

/** A live page lays out at most this many views, and boxes, before it is first shown; the others when opened. */
const EAGER_VIEWS = 16;
const EAGER_NODES = 400;

export class CspmGraphSession {
  private readonly layouts = new Map<string, { version: number | undefined; text: string; byView: Map<string, ViewLayout> }>();

  constructor(private readonly store: VerificationStore = verificationStore) {}

  /** FDR's results for the document. */
  reports(doc: CspmDocument): VerificationReport[] {
    return this.store.get(doc.uri).filter((report) => report.producer === 'fdr');
  }

  stubs(doc: CspmDocument): NetworkViewStub[] {
    return doc.roots.map((root) => ({ id: root.id, kind: 'procedure', procedure: root.name, label: root.label, source: root.source, notes: [], section: root.section === 'asserted' ? 'Asserted' : 'Defined', language: 'cspm' }));
  }

  private cache(doc: CspmDocument): Map<string, ViewLayout> {
    const entry = this.layouts.get(doc.uri);
    if (entry && entry.version === doc.version && entry.text === doc.text) return entry.byView;
    const byView = new Map<string, ViewLayout>();
    this.layouts.set(doc.uri, { version: doc.version, text: doc.text, byView });
    return byView;
  }

  /** Views a result is about: those of the processes its checks target. */
  private resultViews(doc: CspmDocument, reports: readonly VerificationReport[]): string[] {
    const ids = new Set<string>();
    for (const report of reports) {
      for (const check of report.checks) {
        if (!check.counterexample) continue;
        const root = doc.roots.find((entry) => entry.name === check.target.name);
        if (root) ids.add(root.id);
      }
    }
    return [...ids];
  }

  async payload(doc: CspmDocument, budget: { views: number; nodes: number } = DEFAULT_BUDGET, focus?: ViewerFocus, related?: ViewerPayload['related']): Promise<ViewerPayload> {
    const reports = this.reports(doc);
    // The default view and the views results are about; then the others in order (the asserted processes first)
    // while they are small (a generated model defines hundreds): the rest are laid out when opened.
    const wanted = new Set([doc.defaultView(), ...this.resultViews(doc, reports)].filter(Boolean));
    let nodes = [...wanted].reduce((sum, id) => sum + (doc.view(id)?.view.nodes.length ?? 0), 0);
    let looked = 0;
    for (const root of doc.roots) {
      if (wanted.size >= Math.min(budget.views, EAGER_VIEWS) || nodes > EAGER_NODES || looked >= 2 * EAGER_VIEWS) break;
      if (wanted.has(root.id)) continue;
      looked++;
      const size = doc.view(root.id)?.view.nodes.length ?? 0;
      if (nodes + size > EAGER_NODES) continue;
      wanted.add(root.id);
      nodes += size;
    }
    const layouts = this.cache(doc);
    const model = doc.model([...wanted]);
    return buildViewerPayload({
      // Only these are laid out now; every other root is listed, and laid out when the page opens it.
      model: { ...model, views: model.views.filter((view) => wanted.has(view.id)) },
      stubs: this.stubs(doc),
      reports,
      source: { uri: doc.uri, text: doc.text },
      ...(doc.version !== undefined ? { documentVersion: doc.version } : {}),
      layouts,
      onLayout: (view, layout) => layouts.set(view.id, layout),
      budget,
      ...(focus ? { focus } : {}),
      ...(related ? { related } : {}),
    });
  }

  /** One view the page asked for. */
  async view(doc: CspmDocument, id: string): Promise<ViewerView | undefined> {
    const built = doc.view(id);
    if (!built) return undefined;
    const known = new Set<string>([doc.uri]);
    return { ...buildViewerView(doc.model([id]), built.view, await this.layout(doc, built.view), known), knownUris: [...known].sort() };
  }

  async layout(doc: CspmDocument, view: NetworkView): Promise<ViewLayout> {
    const layouts = this.cache(doc);
    let layout = layouts.get(view.id);
    if (!layout) {
      layout = await layoutOrFallback(view);
      layouts.set(view.id, layout);
    }
    return layout;
  }

  /** Whether the document defines a process to draw. */
  drawable(doc: CspmDocument): boolean {
    return doc.roots.length > 0;
  }

  /** The picture worth exporting: the view of the first failed check, with its end state; else the default view. */
  focus(doc: CspmDocument): { view: NetworkView; overlay?: OverlayModel } | undefined {
    const reports = this.reports(doc);
    const model = doc.model([doc.defaultView(), ...this.resultViews(doc, reports)]);
    const overlays = buildOverlays(model, reports, doc.version !== undefined ? { documentVersion: doc.version } : {});
    for (const [index, report] of reports.entries()) {
      for (const check of report.checks) {
        if (check.status !== 'failed' || !check.counterexample) continue;
        const viewId = preferredView(model, check, overlays, index);
        const overlay = overlays.find((entry) => entry.view === viewId && entry.report === index && entry.check === check.id);
        const view = model.views.find((candidate) => candidate.id === viewId);
        if (view && overlay) return { view, overlay };
      }
    }
    const view = model.views.find((candidate) => candidate.id === model.defaultView) ?? model.views[0];
    return view ? { view } : undefined;
  }

  async render(doc: CspmDocument, format: GraphFormat, options: { nonce?: string; focus?: ViewerFocus; related?: ViewerPayload['related'] } = {}): Promise<string> {
    if (format === 'markdown') return formatConcurrencyMarkdown(doc.title, doc.model(doc.roots.map((root) => root.id)), this.reports(doc));
    if (format === 'html') return renderViewerHtml(await this.payload(doc, FILE_BUDGET, options.focus, options.related), { mode: 'file', ...(options.nonce ? { nonce: options.nonce } : {}) });
    if (format === 'json') {
      const model = doc.model(doc.roots.map((root) => root.id));
      return `${JSON.stringify({ generator: 'processj-lsp', version: 1, title: doc.title, uri: doc.uri, documentVersion: doc.version, model, layouts: Object.fromEntries(this.cache(doc)), reports: this.reports(doc) })}\n`;
    }
    const focus = this.focus(doc);
    if (!focus) throw new Error('this file defines no process to draw');
    const layout = await this.layout(doc, focus.view);
    return format === 'svg'
      ? renderNetworkSvg(focus.view, layout, { title: doc.title, ...(focus.overlay ? { overlay: focus.overlay } : {}) })
      : renderExcalidraw(focus.view, layout, { title: doc.title, ...(focus.overlay ? { overlay: focus.overlay } : {}) });
  }

  forget(uri: string): void {
    this.layouts.delete(uri);
  }
}
