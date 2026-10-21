/**
 * What the language server does for a CSPm document (`.csp`, language id
 * `cspm`, or Neovim's filetype `csp`): no ProcessJ analysis at all, only
 *
 * - the process-network graph (the viewer, exports, the live page);
 * - Check with FDR on the file's own assertions, with the results on the
 *   graph, as diagnostics, as code lenses on the assertions, and as a text
 *   report;
 * - diagnostics from the CSPm parser (syntax it cannot read) and FDR's own
 *   type check (on open and save, when FDR is installed or a runner offered);
 * - document symbols for the definitions, channels, types and assertions.
 *
 * The LSP connection stays in src/server.ts; this module reaches it through
 * a small host interface, so it is tested without one.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CodeLens, Diagnostic, DiagnosticSeverity, DocumentSymbol, MessageType, Range, SymbolKind } from 'vscode-languageserver';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { RefinesRunner } from '../csp/fdr';
import type { VerificationStore } from '../graph/live';
import type { ViewerFocus, ViewerPayload, ViewerView } from '../graph/payload';
import type { GraphFormat } from '../graph/session';
import type { CheckOutcome, VerificationReport } from '../verification';
import type { Span } from './ast';
import { checkCspmWithFdr, fdrErrors, typecheckCspm } from './check';
import { CspmDocument } from './document';
import { assertionId, cspmAssertions } from './explain';
import { cspmFdrDiagnostics, formatCspmReport } from './report';
import { CspmGraphSession } from './session';

/** Whether a document is CSPm: by its language id (`cspm`, Neovim's `csp`), else by its extension. */
export function isCspmDocument(doc: Pick<TextDocument, 'languageId' | 'uri'>): boolean {
  if (doc.languageId === 'cspm' || doc.languageId === 'csp') return true;
  return doc.languageId !== 'processj' && /\.csp$/i.test(doc.uri);
}

export interface CspmProgress {
  report(percentage: number, message: string): void;
  done(): void;
  onCancel(listener: () => void): void;
}

export interface CspmHost {
  showMessage(type: MessageType, message: string): void;
  sendDiagnostics(uri: string, version: number, diagnostics: Diagnostic[]): void;
  /** FDR's refines, if installed. */
  refines(): string | undefined;
  /** refines elsewhere (the browser IDE's runner), used instead of refines() when there is one. */
  runner?(): RefinesRunner | undefined;
  /** The workspace roots: a file's includes may name only files inside them (src/csp/includes.ts). */
  includeRoots(): readonly string[];
  refinesMissing(): string;
  fdr(): { timeoutMs: number; memoryMb: number; workers: number; showGraph: 'onFailure' | 'always' | 'never' };
  writeReport(name: string, content: string): string;
  scopedReportName(uri: string, name: string): string;
  openInEditor(file: string, content: string): Promise<void>;
  /** Show the graph on a result; where it was shown, or undefined (the text report opens instead). */
  showGraph(doc: TextDocument, focus: ViewerFocus): Promise<string | undefined>;
  progress(title: string): Promise<CspmProgress | undefined>;
  /** The open document at a URI (to know whether a generated model's .pj is open). */
  open(uri: string): TextDocument | undefined;
  /** The live graph page of an open ProcessJ document, when one can be served. */
  liveGraphUrl?(uri: string): Promise<string | undefined>;
  /** Code lenses changed (after a check). */
  refreshLenses(): void;
  log(message: string): void;
}

interface Outcome {
  version: number;
  report: VerificationReport;
  diagnostics: Diagnostic[];
}

export const COMMAND_SHOW_GRAPH = 'processj.showConcurrencyReport';
export const COMMAND_CHECK_FDR = 'processj.checkWithFdr';

export class CspmFeatures {
  readonly graphs: CspmGraphSession;
  private readonly docs = new Map<string, CspmDocument>();
  private readonly outcomes = new Map<string, Outcome>();
  private readonly typeErrors = new Map<string, { version: number; diagnostics: Diagnostic[] }>();
  private readonly runs = new Map<string, AbortController>();
  private readonly typechecks = new Map<string, AbortController>();
  private readonly told = new Set<string>();

  constructor(private readonly host: CspmHost, private readonly store: VerificationStore) {
    this.graphs = new CspmGraphSession(store);
  }

  /** The parsed document for this version. */
  document(doc: TextDocument): CspmDocument {
    const cached = this.docs.get(doc.uri);
    if (cached && cached.version === doc.version && cached.text === doc.getText()) return cached;
    const parsed = new CspmDocument(doc.uri, doc.getText(), doc.version);
    this.docs.set(doc.uri, parsed);
    return parsed;
  }

  opened(doc: TextDocument): void {
    this.publish(doc);
    this.typecheck(doc);
  }

  changed(doc: TextDocument): void {
    // A result about an older version is no longer shown as current.
    const outcome = this.outcomes.get(doc.uri);
    if (outcome && outcome.version !== doc.version) {
      this.outcomes.delete(doc.uri);
      this.store.clear(doc.uri, 'fdr');
      this.host.refreshLenses();
    }
    this.publish(doc);
  }

  saved(doc: TextDocument): void {
    this.typecheck(doc);
  }

  closed(uri: string, version: number): void {
    this.docs.delete(uri);
    this.outcomes.delete(uri);
    this.typeErrors.delete(uri);
    this.graphs.forget(uri);
    this.store.clear(uri);
    this.runs.get(uri)?.abort();
    this.typechecks.get(uri)?.abort();
    this.host.sendDiagnostics(uri, version, []);
  }

  dispose(): void {
    for (const controller of [...this.runs.values(), ...this.typechecks.values()]) controller.abort();
  }

  /** Stop the FDR check of a document; how many were stopped. */
  cancel(uri?: string): number {
    let cancelled = 0;
    for (const [key, controller] of this.runs) {
      if (uri && key !== uri) continue;
      controller.abort();
      cancelled++;
    }
    return cancelled;
  }

  diagnostics(doc: TextDocument): Diagnostic[] {
    const parsed = this.document(doc);
    const out: Diagnostic[] = parsed.diagnostics.map((d) => ({
      range: rangeOf(d.span),
      severity: d.severity === 'error' ? DiagnosticSeverity.Error : d.severity === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information,
      source: 'processj-lsp (CSPm)',
      message: d.message,
    }));
    const types = this.typeErrors.get(doc.uri);
    if (types && types.version === doc.version) out.push(...types.diagnostics);
    const outcome = this.outcomes.get(doc.uri);
    if (outcome && outcome.version === doc.version) out.push(...outcome.diagnostics);
    return out;
  }

  publish(doc: TextDocument): void {
    try {
      this.host.sendDiagnostics(doc.uri, doc.version, this.diagnostics(doc));
    } catch (error) {
      this.host.log(`CSPm diagnostics failed for ${doc.uri}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    }
  }

  /** Where FDR runs: a runner elsewhere, else the local refines; undefined when there is neither. */
  private fdrBackend(): { runner: RefinesRunner } | { refines: string } | undefined {
    const runner = this.host.runner?.();
    if (runner) return { runner };
    const refines = this.host.refines();
    return refines ? { refines } : undefined;
  }

  /** FDR's type check, in the background (on open and save). */
  private typecheck(doc: TextDocument): void {
    const backend = this.fdrBackend();
    if (!backend) return;
    this.typechecks.get(doc.uri)?.abort();
    const controller = new AbortController();
    this.typechecks.set(doc.uri, controller);
    const version = doc.version;
    const parsed = this.document(doc);
    void typecheckCspm(parsed, 'runner' in backend ? backend.runner : backend.refines, { signal: controller.signal, includeRoots: this.host.includeRoots() })
      .then((errors) => {
        if (controller.signal.aborted) return;
        const current = this.host.open(doc.uri);
        if (!current || current.version !== version) return;
        this.typeErrors.set(doc.uri, { version, diagnostics: errorDiagnostics(parsed, errors) });
        this.publish(current);
      })
      .catch((error) => this.host.log(`FDR's type check failed for ${doc.uri}: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        if (this.typechecks.get(doc.uri) === controller) this.typechecks.delete(doc.uri);
      });
  }

  symbols(doc: TextDocument): DocumentSymbol[] {
    const kinds = { process: SymbolKind.Class, function: SymbolKind.Function, value: SymbolKind.Constant, channel: SymbolKind.Event, datatype: SymbolKind.Enum, assertion: SymbolKind.Boolean } as const;
    return this.document(doc).symbols().map((symbol) => DocumentSymbol.create(symbol.name, symbol.detail, kinds[symbol.kind], rangeOf(symbol.span), rangeOf(symbol.selection)));
  }

  /** A lens on each assertion (check it, or its verdict after a check), and the graph above the default process. */
  codeLenses(doc: TextDocument): CodeLens[] {
    const parsed = this.document(doc);
    const lenses: CodeLens[] = [];
    const root = parsed.lensRoot();
    if (root) lenses.push({ range: rangeOf(root.source.span), command: { title: 'Process network', command: COMMAND_SHOW_GRAPH, arguments: [doc.uri] } });
    if (!this.fdrBackend()) return lenses;
    const outcome = this.outcomes.get(doc.uri);
    const fresh = outcome && outcome.version === doc.version ? outcome : undefined;
    for (const assertion of cspmAssertions(parsed.file)) {
      const range = rangeOf(assertion.span);
      const check = fresh?.report.checks.find((entry) => entry.id === assertionId(assertion));
      if (!check) {
        lenses.push({ range, command: { title: 'FDR: check & show graph', command: COMMAND_CHECK_FDR, arguments: [doc.uri] } });
        continue;
      }
      const verdict = `FDR: ${verdictOf(check)}`;
      // Passed or failed, the verdict reopens the graph on that assertion; only a check without a result runs again.
      const shows = check.status === 'passed' || check.status === 'failed';
      lenses.push({ range, command: shows ? { title: `${verdict} · show graph`, command: COMMAND_SHOW_GRAPH, arguments: [doc.uri, 'viewer', { check: check.id }] } : { title: `${verdict} · check again`, command: COMMAND_CHECK_FDR, arguments: [doc.uri] } });
    }
    return lenses;
  }

  /** The ProcessJ file a generated model came from, for the viewer's link back (and its live graph when it is open). */
  async related(doc: CspmDocument): Promise<ViewerPayload['related']> {
    const file = doc.generatedFrom();
    if (!file || !fs.existsSync(file)) return undefined;
    const uri = pathToFileURL(file).toString();
    const open = this.host.open(uri);
    const graph = open && this.host.liveGraphUrl ? await this.host.liveGraphUrl(open.uri).catch(() => undefined) : undefined;
    return {
      label: path.basename(file),
      uri: open?.uri ?? uri,
      note: `This model was generated by Convert to CSP from ${path.basename(file)}. The graph of that file (the graph command in its buffer) draws the ProcessJ processes and channels; this one draws the CSP processes of the model, the translator's own plumbing included.`,
      ...(graph ? { graph } : {}),
    };
  }

  async payload(doc: TextDocument, focus?: ViewerFocus): Promise<ViewerPayload> {
    const parsed = this.document(doc);
    return this.graphs.payload(parsed, undefined, focus, await this.related(parsed));
  }

  async view(doc: TextDocument, id: string): Promise<ViewerView | undefined> {
    return this.graphs.view(this.document(doc), id);
  }

  drawable(doc: TextDocument): boolean {
    return this.graphs.drawable(this.document(doc));
  }

  async render(doc: TextDocument, format: GraphFormat, options: { nonce?: string; focus?: ViewerFocus } = {}): Promise<string> {
    const parsed = this.document(doc);
    return this.graphs.render(parsed, format, { ...options, related: await this.related(parsed) });
  }

  /** Said once per document: the model was generated from a .pj file, whose own graph is the ProcessJ one. */
  mentionSource(doc: TextDocument): void {
    const file = this.document(doc).generatedFrom();
    if (!file || this.told.has(doc.uri) || !fs.existsSync(file)) return;
    this.told.add(doc.uri);
    this.host.showMessage(MessageType.Info, `processj-lsp: ${path.basename(doc.uri)} was generated from ${path.basename(file)}; the graph command in that file shows its ProcessJ network.`);
  }

  /** Check with FDR: every assertion of the file, explained on the graph. */
  async check(doc: TextDocument, token?: { onCancellationRequested(listener: () => void): { dispose(): void } }): Promise<unknown> {
    const backend = this.fdrBackend();
    if (!backend) {
      this.host.showMessage(MessageType.Error, `processj-lsp: ${this.host.refinesMissing()}`);
      return null;
    }
    const parsed = this.document(doc);
    const assertions = cspmAssertions(parsed.file);
    const fileName = parsed.title;
    if (!assertions.length) {
      this.host.showMessage(MessageType.Info, `FDR: ${fileName} has no assert lines, so there is nothing to check. Add one, such as assert SYSTEM :[deadlock free].`);
      return null;
    }
    const uri = doc.uri;
    const version = doc.version;
    this.runs.get(uri)?.abort();
    const controller = new AbortController();
    this.runs.set(uri, controller);
    const cancellation = token?.onCancellationRequested(() => controller.abort());
    const progress = await this.host.progress(`FDR: checking ${fileName}`);
    progress?.onCancel(() => controller.abort());
    if (!progress) this.host.showMessage(MessageType.Info, `FDR: checking the ${assertions.length} assertion${assertions.length === 1 ? '' : 's'} of ${fileName}…`);
    const started = Date.now();
    try {
      const settings = this.host.fdr();
      const result = await checkCspmWithFdr({
        document: parsed,
        ...backend,
        timeoutMs: settings.timeoutMs,
        signal: controller.signal,
        ...(settings.memoryMb ? { memoryLimit: settings.memoryMb * 1024 * 1024 } : {}),
        ...(settings.workers ? { workers: settings.workers } : {}),
        // The copy FDR runs; a local run rewrites it with its includes made absolute.
        cspFile: this.host.writeReport(this.host.scopedReportName(uri, `fdr/${fileName.replace(/[^A-Za-z0-9_.-]/g, '_')}`), parsed.text),
        includeRoots: this.host.includeRoots(),
        onProgress: (done, total, label, raw) => progress?.report(Math.round((done / total) * 100), `${label}: ${raw.passed === true ? 'holds' : raw.passed === false ? 'fails' : 'no verdict'} (${done}/${total})`),
      });
      if (result.run?.aborted) {
        this.host.showMessage(MessageType.Info, `FDR: the check of ${fileName} was cancelled`);
        return null;
      }
      const { report } = result;
      const current = this.host.open(uri);
      const fresh = !!current && current.version === version;
      // FDR could not load the file (a type error): its errors are diagnostics, as from the type check.
      if (fresh && result.run?.errors.length && result.cspFile) this.typeErrors.set(uri, { version, diagnostics: errorDiagnostics(parsed, fdrErrors(result.run.errors, path.basename(result.cspFile))) });
      const stem = fileName.replace(/\.csp$/i, '');
      const jsonFile = this.host.writeReport(this.host.scopedReportName(uri, `${stem}.fdr.json`), `${JSON.stringify(report, null, 2)}\n`);
      const stale = fresh ? undefined : 'The file changed while FDR ran: this report is about the text before that edit. Run the check again for the current text.';
      const text = formatCspmReport(report, { fileName, durationMs: Date.now() - started, jsonFile, ...(stale ? { stale } : {}) });
      const reportFile = this.host.writeReport(this.host.scopedReportName(uri, `${stem}.fdr.pjreport`), text);
      if (!fresh || !current) {
        this.host.showMessage(MessageType.Warning, `FDR: ${fileName} changed while FDR ran, so the result is about the text before that edit. Run the check again; the report is in ${reportFile}`);
        return { reportFile, jsonFile, report, stale: true };
      }
      const spans = new Map(assertions.map((assertion) => [assertionId(assertion), assertion.span] as const));
      const diagnostics = cspmFdrDiagnostics(report, spans).map((d): Diagnostic => ({
        range: rangeOf(d.span),
        severity: d.severity === 'error' ? DiagnosticSeverity.Error : d.severity === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information,
        source: 'FDR',
        message: d.message,
      }));
      this.outcomes.set(uri, { version, report, diagnostics });
      this.store.publish(uri, report);
      this.publish(current);
      this.host.refreshLenses();
      const [type, message] = summaryOf(report, fileName);
      this.host.showMessage(type, message);
      const focus = focusCheck(report);
      const wantsGraph = !!focus && settings.showGraph !== 'never' && (settings.showGraph === 'always' || report.checks.some((check) => check.status === 'failed' && !!check.counterexample));
      const shown = wantsGraph ? await this.host.showGraph(current, { check: focus!.id }) : undefined;
      if (!shown) await this.host.openInEditor(reportFile, text);
      return { reportFile, jsonFile, report };
    } finally {
      progress?.done();
      cancellation?.dispose();
      if (this.runs.get(uri) === controller) this.runs.delete(uri);
    }
  }

  /** The current report of a document, if FDR checked this version. */
  report(uri: string, version: number): VerificationReport | undefined {
    const outcome = this.outcomes.get(uri);
    return outcome && outcome.version === version ? outcome.report : undefined;
  }
}

/** The check to show first: the first failure with a counterexample, else the first failure, else the first check. */
function focusCheck(report: VerificationReport): CheckOutcome | undefined {
  return report.checks.find((check) => check.status === 'failed' && check.counterexample) ?? report.checks.find((check) => check.status === 'failed') ?? report.checks[0];
}

function verdictOf(check: CheckOutcome): string {
  if (check.status === 'passed') return 'holds';
  if (check.status === 'failed') {
    const cx = check.counterexample;
    if (!cx) return 'fails';
    const n = cx.steps.length;
    const after = n ? ` after ${n} step${n === 1 ? '' : 's'}` : ' at the start';
    return cx.kind === 'deadlock' ? `deadlock${after}` : cx.kind === 'divergence' ? `diverges${after}` : cx.kind === 'nondeterminism' ? 'nondeterministic' : `fails${after}`;
  }
  return check.status === 'timeout' ? 'did not finish' : check.status === 'error' ? 'error' : check.status;
}

function summaryOf(report: VerificationReport, fileName: string): [MessageType, string] {
  const failed = report.checks.filter((check) => check.status === 'failed');
  const broken = report.checks.filter((check) => check.status !== 'failed' && check.status !== 'passed');
  const passed = report.checks.length - failed.length - broken.length;
  const total = report.checks.length;
  const plural = total === 1 ? '' : 's';
  // An assertion FDR did not decide (a timeout, a file it could not load) is neither holding nor failing.
  const counts = !broken.length
    ? `${passed} of ${total} assertion${plural} ${total === 1 ? 'holds' : 'hold'}`
    : passed + failed.length === 0
      ? `${total === 1 ? 'the assertion was' : `none of the ${total} assertions was`} decided`
      : `${passed + failed.length} of ${total} assertion${plural} decided, ${passed} ${passed === 1 ? 'holds' : 'hold'}`;
  if (failed.length) return [MessageType.Warning, `FDR, ${fileName}: ${counts}; ${failed[0].label}: ${failed[0].counterexample?.summary ?? failed[0].message ?? 'fails'}`];
  if (broken.length) return [MessageType.Warning, `FDR, ${fileName}: ${counts}; ${broken[0].label}: ${broken[0].message ?? broken[0].status}`];
  return [MessageType.Info, `FDR, ${fileName}: ${report.checks.length === 1 ? 'the assertion holds' : `all ${report.checks.length} assertions hold`}`];
}

/** FDR's errors as diagnostics: at their span, or, for an error in an included file, at the include. */
function errorDiagnostics(parsed: CspmDocument, errors: ReturnType<typeof fdrErrors>): Diagnostic[] {
  const start: Span = { start: { line: 0, col: 0 }, end: { line: 0, col: 1 } };
  const includeAt = (file: string): Span | undefined => parsed.file.decls.find((decl) => decl.kind === 'include' && path.basename(decl.file) === path.basename(file))?.span;
  return errors.map((error) => ({
    range: rangeOf(error.file ? includeAt(error.file) ?? start : error.span ?? start),
    severity: DiagnosticSeverity.Error,
    source: 'FDR',
    message: error.file ? `${error.file}: ${error.message}` : error.message,
  }));
}

function rangeOf(span: Span): Range {
  return Range.create(span.start.line, span.start.col, span.end.line, span.end.col);
}
