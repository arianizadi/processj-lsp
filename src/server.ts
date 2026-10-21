import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CodeAction,
  CodeActionKind,
  CodeLensRefreshRequest,
  DidChangeWatchedFilesNotification,
  DidChangeWorkspaceFoldersNotification,
  type WorkspaceFoldersChangeEvent,
  FileChangeType,
  CodeLens,
  CompletionItem,
  CompletionItemKind,
  createConnection,
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticTag,
  DocumentHighlight,
  DocumentHighlightKind,
  DocumentSymbol,
  ErrorCodes,
  FoldingRange,
  FoldingRangeKind,
  Hover,
  InlayHint,
  InlayHintKind,
  InsertTextFormat,
  Location,
  MarkupKind,
  MessageType,
  ParameterInformation,
  Position,
  ProposedFeatures,
  Range,
  ResponseError,
  ShowMessageNotification,
  SignatureHelp,
  SignatureInformation,
  SymbolInformation,
  SymbolKind,
  TextDocuments,
  TextDocumentSyncKind,
  TextEdit,
  WorkspaceEdit,
  type CodeActionParams,
  type Command,
  type CodeLensParams,
  type CompletionParams,
  type DefinitionParams,
  type DocumentFormattingParams,
  type DocumentHighlightParams,
  type DocumentSymbolParams,
  type ExecuteCommandParams,
  type FoldingRangeParams,
  type HoverParams,
  type InlayHintParams,
  type InitializeParams,
  type InitializeResult,
  type PrepareRenameParams,
  type ReferenceParams,
  type RenameParams,
  type SignatureHelpParams,
  type WorkspaceSymbolParams,
  type TextDocumentChangeEvent,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { type FixHint, type LintDiagnostic } from './analysis';
import { astSymbols } from './astsymbols';
import { check, type CheckResult, type VarInfo } from './checker/checker';
import { analyzeProcedureEffects, type EffectAnalysis, type EffectUnit, type ProcedureEffectSummary } from './checker/effects';
import { DeclIndex, sameSignature, signatureStr, type ProcSig } from './checker/index';
import { analyzeProtocols, effectiveProtocolCases, type ProtocolAnalysis, type ProtocolIssue } from './checker/protocols';
import { analyzeReachableCalls, DEFAULT_MAX_IMPORTED_FILES, type ReachableUnit } from './checker/reachable';
import { YieldAnalysis, yieldAnnotationEdit, type YieldCallProvider, type YieldCallScope } from './checker/yields';
import { typeStr, type Type } from './checker/types';
import { compile, compilerDiagnosticTargetsBuffer, killAllChildren, makePrivateDir, remapCompilerDiagnostic, removeAllPrivateDirs, type ImportMirror } from './compiler';
import { format } from './format';
import { importDiagnostics, resolveImports, type ImportResolution } from './imports';
import type * as A from './parser/ast';
import { parse, type ParseResult } from './parser/parser';
import { semanticTokens, TOKEN_MODIFIERS, TOKEN_TYPES } from './semantic';
import { findInstall, type Install } from './config';
import { parseCompilerOutput, type RawDiagnostic } from './diagnostics';
import { KEYWORD_DOCS, KEYWORDS, LITERALS, PRIMITIVE_TYPES } from './keywords';
import { indexLibrary, type LibrarySymbol } from './library';
import { containsPosition, localRenameConflict, namedTypeSpans, variableAt, variableSpans, visibleVariables } from './navigation';
import { build, formatReport, run } from './pipeline';
import { buildConcurrencyGraph, type ConcurrencyGraph } from './concurrency';
import { LiveViewerServer, publishVerification, verificationStore } from './graph/live';
import { layoutSizeProblem } from './graph/layout';
import { pathKey, stuckForGood } from './graph/overlay';
import type { ViewerFocus } from './graph/payload';
import { renderViewerHtml } from './graph/render-html';
import { buildViewerMachine, layoutMachine, machineRequestKey, refOfMachine, type MachineLayout, type MachineRequest, type ViewerMachine, type ViewerMachineError } from './graph/render-machine';
import { ALL_FORMATS, FORMAT_EXTENSIONS, GENERATOR_MARKERS, GraphSession, isExportFormat, type ExportFormat, type GraphDocument } from './graph/session';
import type { NetworkUnit, ProcedureArguments } from './graph/network';
import { channelInlays } from './inlays';
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from './settings';
import { extractLocals, extractSymbols, wordAt, type PJSymbol } from './symbols';
import { WorkspaceIndex } from './workspace';
import { LatestTaskQueue } from './taskqueue';
import type { Token } from './tokens';
import { planChannelDiagnostic, planExtractProcedure, planRunInPar, type RefactorOptions, type RefactorPlan, type RefactorResult } from './refactors';
import { isGeneratedFile, writeGeneratedFile } from './safewrite';
import { setBrowserMode } from './mode';
import { checkWithFdr, drawnArguments, fdrDiagnostics, findRefines, formatFdrReport, isPartialDeadlock, lensVerdict, refinesNotFoundMessage, stateMachines, translateProcedure, translateProgram, type CspMachine, type CspModel, type CspUnit, type FdrDiagnostic, type TranslateInput } from './csp/index';
import type { CheckOutcome, ProcessSnapshot, SourceRef, VerificationReport } from './verification';
import { CspmFeatures, isCspmDocument } from './cspm/features';
import type { GraphFormat } from './graph/session';

const COMMAND_RUN = 'processj.run';
const COMMAND_BUILD = 'processj.build';
const COMMAND_SHOW_CONCURRENCY = 'processj.showConcurrencyReport';
const COMMAND_EXPORT_GRAPH = 'processj.exportConcurrencyGraph';
const COMMAND_SHOW_EFFECTS = 'processj.showEffectReport';
const COMMAND_SHOW_PROTOCOLS = 'processj.showProtocolReport';
const COMMAND_APPLY_EDIT = 'processj.applyWorkspaceEdit';
const COMMAND_CONVERT_CSP = 'processj.convertToCsp';
const COMMAND_CHECK_FDR = 'processj.checkWithFdr';
const COMMAND_CANCEL_FDR = 'processj.cancelFdr';
/** First line of every generated .csp file: a file without it is the user's and is never overwritten. */
const CSP_MARKER = '-- Generated by processj-lsp from ';
/** writeGeneratedFile's reason for a file the user wrote. */
const NOT_GENERATED = 'it was not written by processj-lsp';
const SERVER_VERSION = packageVersion();

const connection = createConnection(ProposedFeatures.all);
/** Every open document, ProcessJ and CSPm. */
const allDocuments = new TextDocuments(TextDocument);
/**
 * The ProcessJ documents. Every ProcessJ feature reads documents through this
 * view, so a CSPm document (src/cspm/features.ts) gets no ProcessJ
 * diagnostics, completion, formatting or analysis of any kind.
 */
const documents = processjDocuments(allDocuments);
const workspace = new WorkspaceIndex((changed, structureChanged) => {
  closedAnalysisCache.clear();
  if (structureChanged) republishAll(true);
  else for (const file of changed) republishDependents(file, undefined, true);
});

let settings: Settings = { ...DEFAULT_SETTINGS };
let clientWatchesFiles = false;
let clientSupportsWorkspaceFolders = false;
let clientSupportsRelatedInformation = false;
let clientSupportsDocumentChanges = false;
let clientSupportsApplyEdit = false;
let clientSupportsCodeActionLiterals = false;
let clientSupportsDisabledCodeActions = false;
let clientSupportsInlayHintRefresh = false;
let clientSupportsCodeLensRefresh = false;
let clientSupportsHierarchicalSymbols = false;
let clientSupportsSnippets = false;
let install: Install | undefined;
let installError: string | undefined;
let library: LibrarySymbol[] = [];
let clientSupportsShowDocument = false;
/** The client asked for `processj/verificationChanged` (VS Code's graph panel); other clients do not know it. */
let clientWantsVerificationChanged = false;
/** The client shows the graph in a panel of its own (VS Code): it gets `processj/showGraph` instead of a browser page. */
let clientShowsGraphPanel = false;
let clientSupportsWorkDoneProgress = false;
/** FDR's refines for the current settings (undefined: not installed, so no FDR lenses). */
let refinesPath: string | undefined;
/** Parsed standard-library headers, keyed by absolute path. */
const libraryPrograms = new Map<string, A.Program>();
const libraryFiles = new Set<string>();
/** Exact std AST declarations whose compiler implementation is known not to rendezvous. */
const trustedNonBlockingNativeDeclarations = new Set<A.ProcDecl>();
/** Declarations of `std` alone, for the "add import std.*" hint. */
let stdIndex = new DeclIndex();

// Real compiler runs start JVMs, so keep only the latest run per document and
// bound cross-document concurrency. Two workers nearly halve batch time without
// the latency and memory spike seen when every open document starts one at once.
const compilerQueue = new LatestTaskQueue<string>(2, (error) => connection.console.error(`compiler check failed: ${String(error)}`));
// Last compiler diagnostics per document, so lints (which are instant) can be merged with them.
const compilerDiags = new Map<string, { version: number; diagnostics: Diagnostic[] }>();
// Cached parse and symbol extraction keyed by document version.
const parseCache = new Map<string, { version: number; parsed: ParseResult }>();
interface Analysis {
  checked: CheckResult;
  /** Root and reachable-import call resolutions used when following yieldability through bodies. */
  yieldCalls: ReadonlyMap<A.Invocation, ProcSig>;
  yieldCallProvider: YieldCallProvider;
  index: DeclIndex;
  effects: EffectAnalysis;
  protocols: ProtocolAnalysis;
  importDiags: LintDiagnostic[];
  deps: Set<string>;
  /** Import facts the checker was run with, so refactor planners re-check under the same rules. */
  importsStd: boolean;
  unresolvedImports: boolean;
  /** Package roots the compiler sandbox must link in to see the same imports. */
  importMirrors: ImportMirror[];
  /** The document and the imported files reached by its calls, checked: what Convert to CSP translates. */
  reachableUnits: readonly EffectUnit[];
}

const checkCache = new Map<string, Analysis & { version: number }>();
/**
 * Bindings of closed workspace files, for references and rename. A changed file
 * is a miss because the workspace hands out a new program; the whole cache is
 * dropped whenever any buffer or disk file changes, since a closed file's
 * imports may be among them.
 */
const closedAnalysisCache = new Map<string, { program: A.Program; bindings: Bindings }>();
const symbolCache = new Map<string, { version: number; symbols: PJSymbol[]; locals: PJSymbol[] }>();
// Lint runs are coalesced so a burst of keystrokes in a large file costs one pass.
const lintPending = new Map<string, NodeJS.Timeout>();
// TextDocuments emits onDidChangeContent once as part of every didOpen. Track
// that synthetic event so it cannot cancel the required open-time compiler run.
const openingDocuments = new Set<string>();
const LINT_DELAY_MS = 40;
let analysisDecorationRefresh: NodeJS.Timeout | undefined;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

connection.onInitialize((params: InitializeParams): InitializeResult => {
  settings = normalizeSettings(params.initializationOptions);
  // The web IDE's worker: an in-memory project, compiler and FDR on a remote runner (src/mode.ts).
  setBrowserMode((params.initializationOptions as { browser?: unknown } | null | undefined)?.browser);
  clientSupportsShowDocument = !!params.capabilities.window?.showDocument?.support;
  clientWantsVerificationChanged = (params.initializationOptions as { verificationNotifications?: unknown } | null | undefined)?.verificationNotifications === true;
  clientShowsGraphPanel = (params.initializationOptions as { graphPanel?: unknown } | null | undefined)?.graphPanel === true;
  clientWatchesFiles = !!params.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration;
  clientSupportsWorkspaceFolders = !!params.capabilities.workspace?.workspaceFolders;
  clientSupportsRelatedInformation = !!params.capabilities.textDocument?.publishDiagnostics?.relatedInformation;
  clientSupportsDocumentChanges = !!params.capabilities.workspace?.workspaceEdit?.documentChanges;
  clientSupportsApplyEdit = !!params.capabilities.workspace?.applyEdit;
  clientSupportsCodeActionLiterals = !!params.capabilities.textDocument?.codeAction?.codeActionLiteralSupport;
  clientSupportsDisabledCodeActions = !!params.capabilities.textDocument?.codeAction?.disabledSupport;
  clientSupportsInlayHintRefresh = !!params.capabilities.workspace?.inlayHint?.refreshSupport;
  clientSupportsCodeLensRefresh = !!params.capabilities.workspace?.codeLens?.refreshSupport;
  clientSupportsHierarchicalSymbols = !!params.capabilities.textDocument?.documentSymbol?.hierarchicalDocumentSymbolSupport;
  clientSupportsSnippets = !!params.capabilities.textDocument?.completion?.completionItem?.snippetSupport;
  clientSupportsWorkDoneProgress = !!params.capabilities.window?.workDoneProgress;

  configureInstall();
  refinesPath = findRefines(settings.fdrPath);

  const roots = (params.workspaceFolders ?? [])
    .map((f) => safeFileUri(f.uri))
    .filter((p): p is string => !!p);
  if (roots.length === 0 && params.rootUri) {
    const r = safeFileUri(params.rootUri);
    if (r) roots.push(r);
  }
  workspace.setRoots(roots);

  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Incremental,
        save: { includeText: false },
      },
      completionProvider: { triggerCharacters: ['.'], resolveProvider: false },
      hoverProvider: true,
      inlayHintProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: { prepareProvider: true },
      documentSymbolProvider: true,
      documentHighlightProvider: true,
      workspaceSymbolProvider: true,
      signatureHelpProvider: { triggerCharacters: ['(', ','], retriggerCharacters: [','] },
      codeActionProvider: clientSupportsCodeActionLiterals
        ? { codeActionKinds: [CodeActionKind.QuickFix, CodeActionKind.Refactor, CodeActionKind.RefactorExtract, CodeActionKind.RefactorRewrite] }
        : true,
      codeLensProvider: settings.codeLens ? { resolveProvider: false } : undefined,
      executeCommandProvider: {
        commands: [COMMAND_RUN, COMMAND_BUILD, COMMAND_SHOW_CONCURRENCY, COMMAND_EXPORT_GRAPH, COMMAND_SHOW_EFFECTS, COMMAND_SHOW_PROTOCOLS, COMMAND_CONVERT_CSP, COMMAND_CHECK_FDR, COMMAND_CANCEL_FDR, ...(!clientSupportsCodeActionLiterals && clientSupportsApplyEdit ? [COMMAND_APPLY_EDIT] : [])],
      },
      documentFormattingProvider: true,
      foldingRangeProvider: true,
      semanticTokensProvider: { legend: { tokenTypes: [...TOKEN_TYPES], tokenModifiers: [...TOKEN_MODIFIERS] }, full: true },
      workspace: { workspaceFolders: { supported: true, changeNotifications: true } },
    },
    serverInfo: { name: 'processj-lsp', version: SERVER_VERSION },
  };
});

/** Locate the ProcessJ install for the current settings and (re)load its library headers. */
function configureInstall(): void {
  install = undefined;
  installError = undefined;
  library = [];
  libraryPrograms.clear();
  libraryFiles.clear();
  stdIndex = new DeclIndex();
  trustedNonBlockingNativeDeclarations.clear();
  const found = findInstall({ installDir: settings.installDir, javaBin: settings.javaBin });
  if ('error' in found) {
    installError = found.error;
    return;
  }
  install = found;
  library = indexLibrary(install.includeDir);
  loadLibrary(install.includeDir);
}

/**
 * Clients that push settings (Neovim's `settings`, any client with
 * `synchronize.configurationSection`) send them here rather than through
 * initializationOptions. Only known keys are read; the rest keep their value.
 */
connection.onDidChangeConfiguration((params) => {
  const raw = (params.settings as { processj?: unknown } | null | undefined)?.processj ?? params.settings;
  if (!raw || typeof raw !== 'object') return;
  const incoming = raw as Record<string, unknown>;
  const known = ['installDir', 'javaBin', 'debounceMs', 'timeoutMs', 'checkOnChange', 'runTimeoutMs', 'lint', 'codeLens', 'liveViewer', 'fdrPath', 'fdrTimeoutMs', 'fdrMemoryMb', 'fdrWorkers', 'fdrShowGraph'].filter((key) => key in incoming);
  if (known.length === 0) return;
  const previous = settings;
  settings = normalizeSettings({ ...previous, ...Object.fromEntries(known.map((key) => [key, incoming[key]])) });
  const installChanged = settings.installDir !== previous.installDir || settings.javaBin !== previous.javaBin;
  if (installChanged) {
    configureInstall();
    if (install) connection.console.info(`ProcessJ install: ${install.installDir} (java: ${install.javaBin}); ${library.length} library symbols`);
    else connection.console.error(installError ?? 'ProcessJ install not found');
  }
  if (installChanged || settings.lint !== previous.lint) {
    checkCache.clear();
    closedAnalysisCache.clear();
    republishAll(installChanged);
  } else if (settings.checkOnChange !== previous.checkOnChange || settings.timeoutMs !== previous.timeoutMs) {
    for (const doc of documents.all()) scheduleCheck(doc, 0);
  }
  if (settings.codeLens !== previous.codeLens) connection.console.warn('processj.codeLens is fixed at initialization; restart the server to apply it');
  // Off means no local HTTP listener at all, not only none for the next graph.
  if (previous.liveViewer && !settings.liveViewer) void liveViewer.close();
  if (settings.fdrPath !== previous.fdrPath) {
    refinesPath = findRefines(settings.fdrPath);
    if (!refinesPath) connection.console.warn(refinesNotFoundMessage(settings.fdrPath));
    scheduleAnalysisDecorationRefresh();
  }
});

/** Parse every header under the include directory once; `std/` headers also form the std index. */
function loadLibrary(includeDir: string): void {
  const stack = [includeDir];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.endsWith('.pj')) {
        try {
          const program = parse(fs.readFileSync(full, 'utf8')).program;
          libraryPrograms.set(full, program);
          libraryFiles.add(full);
          registerStdHeader(full, program);
        } catch {
          /* unreadable header: skip */
        }
      }
    }
  }
}

/** `std/` headers form the std index; its native print/println are known not to rendezvous. */
function registerStdHeader(file: string, program: A.Program): void {
  if (path.basename(path.dirname(file)) !== 'std') return;
  stdIndex.addProgram(program, file);
  for (const declaration of program.decls) {
    if (declaration.kind !== 'ProcDecl') continue;
    if (declaration.name.name !== 'print' && declaration.name.name !== 'println') continue;
    if (!declaration.modifiers.includes('native') || declaration.modifiers.includes('mobile') || declaration.body) continue;
    if (declaration.annotations.some((annotation) => annotation.name === 'yield' && annotation.value === 'true')) continue;
    trustedNonBlockingNativeDeclarations.add(declaration);
  }
}

connection.onInitialized(() => {
  if (clientWatchesFiles) {
    // The editor tells us when .pj files change on disk; no polling, no repeated directory walks.
    workspace.watched = true;
    void connection.client.register(DidChangeWatchedFilesNotification.type, { watchers: [{ globPattern: '**/*.pj' }] }).catch((error) => {
      workspace.watched = false;
      workspace.startPolling();
      connection.console.warn(`could not register ProcessJ file watcher; falling back to polling: ${String(error)}`);
    });
  } else {
    // Poll in the background so no hover or completion ever pays for a directory walk.
    workspace.startPolling();
  }
  // When the client advertises workspace folders, vscode-languageserver's own
  // WorkspaceFoldersFeature registers a handler for the same notification
  // during `initialize`, replacing the raw one below. Subscribe through the
  // feature in that case so folder changes still reach us.
  if (clientSupportsWorkspaceFolders) connection.workspace.onDidChangeWorkspaceFolders(applyWorkspaceFolderChange);
  if (install) {
    connection.console.info(`ProcessJ install: ${install.installDir} (java: ${install.javaBin}); ${library.length} library symbols`);
  } else {
    connection.console.error(installError ?? 'ProcessJ install not found');
    // Said when a ProcessJ file is first open: a session of .csp files has no use for it.
    installWarning = `processj-lsp: ${installError}. Compiler diagnostics and Run are disabled; lints, completion and navigation still work.`;
    if (documents.all().length) sayInstallWarning();
  }
});

/** The missing-install warning, until it has been said. */
let installWarning: string | undefined;

function sayInstallWarning(): void {
  if (!installWarning) return;
  showMessage(MessageType.Warning, installWarning);
  installWarning = undefined;
}

// Use the raw notification registration: the convenience `connection.workspace`
// getter throws during startup when a client does not advertise workspace-folder
// support, while accepting the protocol notification itself is harmless.
connection.onNotification(DidChangeWorkspaceFoldersNotification.type, (params) => applyWorkspaceFolderChange(params.event));

function applyWorkspaceFolderChange(event: WorkspaceFoldersChangeEvent): void {
  const removed = new Set(event.removed.map((folder) => safeFileUri(folder.uri)).filter((file): file is string => !!file).map((file) => path.resolve(file)));
  const roots = workspace.getRoots().filter((root) => !removed.has(path.resolve(root)));
  for (const folder of event.added) {
    const file = safeFileUri(folder.uri);
    if (file && !roots.some((root) => path.resolve(root) === path.resolve(file))) roots.push(file);
  }
  workspace.setRoots(roots);
  republishAll();
}

documents.onDidOpen((e) => {
  sayInstallWarning();
  openingDocuments.add(e.document.uri);
  closedAnalysisCache.clear();
  schedulePublish(e.document);
  scheduleCheck(e.document, 0);
  // Hot-exit/session restore can open an imported file already containing
  // unsaved text, without a subsequent didChange. Make existing importers swap
  // their disk snapshot for the newly authoritative editor buffer immediately.
  const p = safeFileUri(e.document.uri);
  if (p) {
    dropFdrOutcomesReading(p);
    republishDependents(p, e.document.uri);
  }
});
documents.onDidChangeContent((e) => {
  schedulePublish(e.document);
  dropStaleFdrOutcomes(e.document);
  // Results of the files that import this one are about its old text too.
  const changedPath = safeFileUri(e.document.uri);
  if (changedPath) dropFdrOutcomesReading(changedPath);
  closedAnalysisCache.clear();
  // An open graph page follows the buffer (debounced; it fetches the new network itself).
  liveViewer.notify(e.document.uri);
  const opening = openingDocuments.delete(e.document.uri);
  if (!opening) {
    if (settings.checkOnChange) scheduleCheck(e.document, settings.debounceMs);
    else compilerQueue.cancel(e.document.uri); // any active open-time result is now guaranteed to be stale
    // Other open files that import this one see the edited buffer, so re-check them too.
    const p = safeFileUri(e.document.uri);
    if (p) republishDependents(p, e.document.uri);
  }
});

connection.onDidChangeWatchedFiles((params) => {
  let created = false;
  let structural = false;
  let libraryChanged = false;
  const changed = new Set<string>();
  for (const change of params.changes) {
    const p = safeFileUri(change.uri);
    if (!p || !p.endsWith('.pj')) continue;
    workspace.invalidate(p);
    closedAnalysisCache.clear();
    if (libraryFiles.has(path.resolve(p))) {
      reloadLibraryFile(path.resolve(p));
      libraryChanged = true;
    }
    // Keep the saved disk snapshot current even while the document is open.
    // Lookups overlay the editor buffer until close. The glob also reports build
    // output and hidden directories, which a root walk would never index.
    if (change.type !== FileChangeType.Deleted && workspace.isIndexable(p)) workspace.add(p);
    if (change.type === FileChangeType.Created) created = true;
    if (change.type !== FileChangeType.Changed) structural = true;
    changed.add(p);
  }
  // A file an FDR model was translated from, changed on disk (an open buffer still wins).
  for (const p of changed) dropFdrOutcomesReading(p);
  // A newly created file can only matter to a document whose imports did not
  // all resolve or that imports a whole package. Everything else, including a
  // deletion, reaches exactly the documents that depend on the path. Refresh at
  // most once per notification: a branch switch delivers many changes at once.
  // A changed std header is rare and reaches documents through any import
  // chain, so every open document is re-checked rather than traced.
  if (libraryChanged || (created && documents.all().some((doc) => importsMayGainFiles(doc)))) {
    republishAll(true);
    return;
  }
  for (const p of changed) republishDependents(p, undefined, true);
  if (structural) {
    // A file appearing or disappearing can change where an import resolves
    // (a nearer `util.pj` shadows the workspace one; a deleted import now
    // resolves nowhere). A document without a cached analysis cannot be
    // checked against its old dependency set, so it is re-checked outright.
    for (const doc of documents.all()) {
      const cached = checkCache.get(doc.uri);
      if (cached && !importsResolveDifferently(doc, cached)) continue;
      invalidate(doc, true);
    }
  }
});

/** Would resolving the document's imports now reach a file its last analysis did not? */
function importsResolveDifferently(doc: TextDocument, cached: Analysis): boolean {
  const resolution = resolveImports(parsedFor(doc).program, safeFileUri(doc.uri), workspace.getRoots(), install?.includeDir);
  if (resolution.imports.some((entry) => entry.files.length === 0) !== cached.unresolvedImports) return true;
  return resolution.files.some((file) => !cached.deps.has(path.resolve(file)));
}

/** Could a file appearing on disk change what this document imports, directly or through a file it reaches? */
function importsMayGainFiles(doc: TextDocument): boolean {
  const ownPath = safeFileUri(doc.uri);
  const cached = checkCache.get(doc.uri);
  const gains = (program: A.Program, file: string | undefined, unresolved?: boolean): boolean => {
    if (program.imports.some((entry) => entry.wildcard)) return true;
    if (unresolved !== undefined) return unresolved;
    return resolveImports(program, file, workspace.getRoots(), install?.includeDir).imports.some((entry) => entry.files.length === 0);
  };
  if (gains(parsedFor(doc).program, ownPath, cached?.unresolvedImports)) return true;
  // Imported files have imports of their own (`helper` importing `workers.*`).
  for (const dependency of cached?.deps ?? []) {
    if (libraryFiles.has(dependency)) continue;
    const source = analysisSourceForPath(dependency);
    if (source && gains(source.program, dependency)) return true;
  }
  return false;
}

/** A standard-library header changed on disk: re-read it so hover, completion and the std index follow. */
function reloadLibraryFile(file: string): void {
  try {
    libraryPrograms.set(file, parse(fs.readFileSync(file, 'utf8')).program);
  } catch {
    libraryPrograms.delete(file);
    libraryFiles.delete(file);
  }
  if (!install) return;
  library = indexLibrary(install.includeDir);
  stdIndex = new DeclIndex();
  trustedNonBlockingNativeDeclarations.clear();
  for (const [headerPath, program] of libraryPrograms) registerStdHeader(headerPath, program);
}

/** Re-lint every open document whose imports include `changedPath`. */
function republishDependents(changedPath: string, exceptUri?: string, recompile = false): void {
  const abs = path.resolve(changedPath);
  for (const doc of documents.all()) {
    const uri = doc.uri;
    if (uri === exceptUri) continue;
    // Even with lints disabled there may be compiler output to invalidate. If
    // no analysis exists, resolve only the imports instead of running a full
    // checker pass merely to answer this dependency question.
    const cached = checkCache.get(uri);
    const deps = cached?.deps ?? new Set(resolveImports(parsedFor(doc).program, safeFileUri(uri), workspace.getRoots(), install?.includeDir).files.map((file) => path.resolve(file)));
    if (!deps.has(abs)) continue;
    invalidate(doc, recompile);
  }
}

function republishAll(recompile = false): void {
  for (const doc of documents.all()) invalidate(doc, recompile);
}

/** Drop the cached analysis and re-lint; compiler output stays until a fresh run replaces it. */
function invalidate(doc: TextDocument, recompile: boolean): void {
  checkCache.delete(doc.uri);
  // The compiler reads imported files from disk, not from editor buffers, so
  // its last result stays accurate until a new run is scheduled. Then never
  // merge messages from the old dependency snapshot.
  if (recompile) {
    compilerDiags.delete(doc.uri);
    scheduleCheck(doc, 0);
  }
  schedulePublish(doc);
  scheduleAnalysisDecorationRefresh();
}

/** Coalesce global refresh requests when one dependency invalidates many importers. */
function scheduleAnalysisDecorationRefresh(): void {
  if ((!clientSupportsInlayHintRefresh && !clientSupportsCodeLensRefresh) || analysisDecorationRefresh) return;
  analysisDecorationRefresh = setTimeout(() => {
    analysisDecorationRefresh = undefined;
    const requests: Promise<void>[] = [];
    if (clientSupportsInlayHintRefresh) requests.push(connection.languages.inlayHint.refresh());
    if (clientSupportsCodeLensRefresh) requests.push(connection.sendRequest(CodeLensRefreshRequest.type));
    void Promise.all(requests).catch((error) => connection.console.warn(`could not refresh ProcessJ analysis decorations: ${String(error)}`));
  }, 0);
}
documents.onDidSave((e) => {
  scheduleCheck(e.document, 0);
  // Without file-watch notifications nothing else tells importers that the
  // file they compile against has changed on disk.
  if (!workspace.watched) {
    const p = safeFileUri(e.document.uri);
    if (p) republishDependents(p, e.document.uri, true);
  }
});
documents.onDidClose((e) => {
  openingDocuments.delete(e.document.uri);
  closedAnalysisCache.clear();
  compilerQueue.cancel(e.document.uri);
  const t = lintPending.get(e.document.uri);
  if (t) clearTimeout(t);
  lintPending.delete(e.document.uri);
  parseCache.delete(e.document.uri);
  checkCache.delete(e.document.uri);
  symbolCache.delete(e.document.uri);
  compilerDiags.delete(e.document.uri);
  graphs.forget(e.document.uri);
  // Results are about this buffer's versions; a reopened buffer starts its versions again.
  verificationStore.clear(e.document.uri);
  fdrOutcomes.delete(e.document.uri);
  machineModels.delete(e.document.uri);
  fdrRuns.get(e.document.uri)?.abort();
  connection.sendDiagnostics({ uri: e.document.uri, version: e.document.version, diagnostics: [] });
  const closedPath = safeFileUri(e.document.uri);
  // Importers may have been checked against unsaved contents. Once the overlay
  // disappears, immediately restore their view of the on-disk file.
  if (closedPath) {
    dropFdrOutcomesReading(closedPath);
    republishDependents(closedPath, e.document.uri);
  }
});

// CSPm documents: only the graph, FDR and their own diagnostics (src/cspm/features.ts).
allDocuments.onDidOpen((e) => {
  if (isCspmDocument(e.document)) cspm.opened(e.document);
});
allDocuments.onDidChangeContent((e) => {
  if (!isCspmDocument(e.document)) return;
  cspm.changed(e.document);
  liveViewer.notify(e.document.uri);
});
allDocuments.onDidSave((e) => {
  if (isCspmDocument(e.document)) cspm.saved(e.document);
});
allDocuments.onDidClose((e) => {
  if (isCspmDocument(e.document)) cspm.closed(e.document.uri, e.document.version);
});

/** The documents ProcessJ features may see: every open document that is not CSPm. */
function processjDocuments(all: TextDocuments<TextDocument>) {
  const keep = (doc: TextDocument | undefined): doc is TextDocument => !!doc && !isCspmDocument(doc);
  const only = (listener: (e: TextDocumentChangeEvent<TextDocument>) => void) => (e: TextDocumentChangeEvent<TextDocument>): void => {
    if (keep(e.document)) listener(e);
  };
  return {
    get: (uri: string): TextDocument | undefined => {
      const doc = all.get(uri);
      return keep(doc) ? doc : undefined;
    },
    all: (): TextDocument[] => all.all().filter(keep),
    onDidOpen: (listener: (e: TextDocumentChangeEvent<TextDocument>) => void) => all.onDidOpen(only(listener)),
    onDidChangeContent: (listener: (e: TextDocumentChangeEvent<TextDocument>) => void) => all.onDidChangeContent(only(listener)),
    onDidSave: (listener: (e: TextDocumentChangeEvent<TextDocument>) => void) => all.onDidSave(only(listener)),
    onDidClose: (listener: (e: TextDocumentChangeEvent<TextDocument>) => void) => all.onDidClose(only(listener)),
  };
}

function schedulePublish(doc: TextDocument): void {
  const t = lintPending.get(doc.uri);
  if (t) clearTimeout(t);
  lintPending.set(
    doc.uri,
    setTimeout(() => {
      lintPending.delete(doc.uri);
      const current = documents.get(doc.uri);
      if (current) publish(current);
    }, LINT_DELAY_MS),
  );
}

// ---------------------------------------------------------------------------
// Diagnostics: instant lints + debounced compiler runs, merged
// ---------------------------------------------------------------------------

function scheduleCheck(doc: TextDocument, delayMs: number): void {
  if (!install) return;
  compilerQueue.schedule(doc.uri, delayMs, (signal) => runCheck(doc.uri, signal));
}

function lintDiagnostics(doc: TextDocument): Diagnostic[] {
  const parsed = parsedFor(doc);
  const lexical: Diagnostic[] = parsed.lexIssues.map((issue) => makeDiagnostic(doc, {
    line: issue.line,
    startCol: issue.col,
    endCol: issue.end,
    message: issue.message,
    severity: 'error',
    code: issue.code,
    source: 'lsp',
  }));
  const syntax: Diagnostic[] = parsed.errors.map((e) => {
    const fix: FixHint | undefined = e.fix ? { kind: 'edit', title: e.fix.title, line: e.fix.line, col: e.fix.col, endCol: e.fix.endCol, text: e.fix.text } : undefined;
    const raw: LintDiagnostic = { line: e.line, startCol: e.col, endCol: e.endCol, message: e.message, severity: 'error', code: 'pj/syntax', source: 'parser', fix };
    return makeDiagnostic(doc, raw);
  });
  // Lexer issues and syntax errors are build blockers, not optional style
  // lints, so they remain visible when the richer checker is disabled.
  if (!settings.lint) return [...lexical, ...syntax];
  const { checked, importDiags, protocols } = checkFor(doc);
  return [
    ...lexical,
    ...syntax,
    ...importDiags.map((d) => makeDiagnostic(doc, d)),
    ...checked.diagnostics.map((d) => makeDiagnostic(doc, d)),
    ...protocols.issues.map((issue) => makeDiagnostic(doc, protocolIssueDiagnostic(doc, issue))),
  ];
}

function protocolIssueDiagnostic(doc: TextDocument, issue: ProtocolIssue): LintDiagnostic {
  let fix: FixHint | undefined;
  if (issue.kind === 'missing-cases') {
    const line = lineText(doc, issue.insertAt.line);
    const prefix = line.slice(0, issue.insertAt.col);
    const inline = !/^\s*$/.test(prefix);
    // A one-line switch has no indentation of its own on the closing line, so
    // take it from where the `switch` keyword actually starts.
    const closingIndent = inline ? ' '.repeat(issue.switchStart.col) : prefix;
    const caseIndent = inline ? `${closingIndent}    ` : closingIndent;
    const bodyIndent = `${caseIndent}    `;
    const cases = issue.missingCases.map((protocolCase) => `case ${protocolCase.name}:\n${bodyIndent}break;`).join(`\n${caseIndent}`);
    const generated = `${inline ? `\n${caseIndent}` : ''}${cases}\n${closingIndent}`;
    fix = {
      kind: 'edit',
      title: `Generate ${issue.missingCases.length} missing protocol case${issue.missingCases.length === 1 ? '' : 's'}`,
      line: issue.insertAt.line,
      col: issue.insertAt.col,
      endCol: issue.insertAt.col,
      text: generated,
    };
  }
  return {
    line: issue.span.start.line,
    startCol: issue.span.start.col,
    endCol: issue.span.end.line === issue.span.start.line ? issue.span.end.col : issue.span.start.col + 1,
    message: issue.message,
    severity: issue.severity,
    code: issue.code,
    source: 'lsp',
    fix,
  };
}

/** Type-check a document against its own declarations, its imports and the standard library. */
function checkFor(doc: TextDocument): Analysis {
  workspace.ensureIndexed();
  const cached = checkCache.get(doc.uri);
  if (cached && cached.version === doc.version) return cached;
  const parsed = parsedFor(doc);
  const ownPath = safeFileUri(doc.uri);
  const analysis = analyzeProgram(parsed.program, ownPath, doc.getText(), parsed.tokens);
  const entry = { version: doc.version, ...analysis };
  checkCache.set(doc.uri, entry);
  return entry;
}

/** What references and rename need from a closed file: name bindings and the exact overloads its calls select. */
interface Bindings {
  checked: CheckResult;
  index: DeclIndex;
}

/** Bind a closed workspace file without the effect, protocol and yield passes that only the editor view needs. */
function analyzeBindings(program: A.Program, ownPath: string | undefined): Bindings {
  const resolution = resolveImports(program, ownPath, workspace.getRoots(), install?.includeDir);
  const index = new DeclIndex();
  index.addProgram(program, ownPath);
  for (const file of resolution.files) {
    const imported = analysisSourceForPath(file)?.program;
    if (imported) index.addProgram(imported, file);
  }
  const checked = check(program, {
    index,
    stdIndex,
    importsStd: resolution.importsStd,
    unresolvedImports: resolution.imports.some((entry) => entry.files.length === 0),
    trustedNonBlockingNativeDeclarations,
  });
  return { checked, index };
}

function closedBindingsFor(file: string, program: A.Program): Bindings {
  const cached = closedAnalysisCache.get(file);
  if (cached && cached.program === program) return cached.bindings;
  const bindings = analyzeBindings(program, file);
  closedAnalysisCache.set(file, { program, bindings });
  return bindings;
}

/** Analyze an on-disk program for a rare cross-file reference request. */
function analyzeProgram(program: A.Program, ownPath: string | undefined, text?: string, tokens?: readonly Token[]): Analysis {
  const resolution = resolveImports(program, ownPath, workspace.getRoots(), install?.includeDir);
  const index = new DeclIndex();
  const rootDeclarations = new Set(program.decls.filter((declaration): declaration is A.ProcDecl => declaration.kind === 'ProcDecl'));
  const declarationFiles = new Map<A.ProcDecl, string>();
  const registerDeclarations = (imported: A.Program, file: string): void => {
    for (const declaration of imported.decls) if (declaration.kind === 'ProcDecl') declarationFiles.set(declaration, path.resolve(file));
  };
  index.addProgram(program, ownPath);
  for (const file of resolution.files) {
    const imported = analysisSourceForPath(file)?.program;
    if (imported) {
      index.addProgram(imported, file);
      registerDeclarations(imported, file);
    }
  }
  const importDiags: LintDiagnostic[] = importDiagnostics(resolution, !!install);
  const unresolved = resolution.imports.some((r) => r.files.length === 0);
  const importedUnitCache = new Map<string, ReachableUnit | undefined>();
  let importedFilesChecked = 0;
  const loadImportedUnit = (requestedFile: string): ReachableUnit | undefined => {
    const file = path.resolve(requestedFile);
    if (importedUnitCache.has(file)) return importedUnitCache.get(file);
    if (importedFilesChecked >= DEFAULT_MAX_IMPORTED_FILES) return undefined;
    const source = analysisSourceForPath(file);
    if (!source) {
      importedUnitCache.set(file, undefined);
      return undefined;
    }
    importedFilesChecked++;
    const importedResolution = resolveImports(source.program, file, workspace.getRoots(), install?.includeDir);
    const importedIndex = new DeclIndex();
    importedIndex.addProgram(source.program, file);
    registerDeclarations(source.program, file);
    for (const dependency of importedResolution.files) {
      const dependencyProgram = analysisSourceForPath(dependency)?.program;
      if (!dependencyProgram) continue;
      importedIndex.addProgram(dependencyProgram, dependency);
      registerDeclarations(dependencyProgram, dependency);
    }
    const importedChecked = check(source.program, {
      index: importedIndex,
      stdIndex,
      importsStd: importedResolution.importsStd,
      unresolvedImports: importedResolution.imports.some((entry) => entry.files.length === 0),
      text: source.text,
      trustedNonBlockingNativeDeclarations,
    });
    const unit: ReachableUnit = { program: source.program, checked: importedChecked, file, dependencies: importedResolution.files };
    importedUnitCache.set(file, unit);
    return unit;
  };
  const noCalls = new Map<A.Invocation, ProcSig>();
  const yieldCallProvider = (declaration: A.ProcDecl): YieldCallScope | undefined => {
    if (rootDeclarations.has(declaration)) return undefined;
    const file = declarationFiles.get(declaration);
    if (!file) return { calls: noCalls, complete: false };
    const unit = loadImportedUnit(file);
    return unit ? { calls: unit.checked.calls, complete: true } : { calls: noCalls, complete: false };
  };

  // One root checker pass. Yield analysis loads only imported files whose
  // bodies it actually follows; other effect-only paths are filled below by
  // the same bounded, cached loader.
  const checked = check(program, {
    index,
    stdIndex,
    importsStd: resolution.importsStd,
    unresolvedImports: unresolved,
    text,
    yieldCallProvider,
    trustedNonBlockingNativeDeclarations,
  });
  const reachable = analyzeReachableCalls({ program, checked, file: ownPath }, {
    rootDependencies: resolution.files,
    maxImportedFiles: DEFAULT_MAX_IMPORTED_FILES,
    load: loadImportedUnit,
    loadTruncated: () => importedFilesChecked >= DEFAULT_MAX_IMPORTED_FILES,
  });
  const yieldCalls = new Map(reachable.calls);
  for (const [invocation, selected] of checked.calls) yieldCalls.set(invocation, selected);
  const effects = analyzeProcedureEffects([{ program, checked, file: ownPath }, ...reachable.units.slice(1)], {
    trustedNonBlockingExternalDeclarations: trustedNonBlockingNativeDeclarations,
  });
  const protocols = analyzeProtocols(program, index, checked, { file: ownPath, sourceText: text, tokens });
  return { checked, yieldCalls, yieldCallProvider, index, effects, protocols, importDiags, deps: new Set(reachable.dependencies), importsStd: resolution.importsStd, unresolvedImports: unresolved, importMirrors: importMirrorsFor(resolution, ownPath), reachableUnits: reachable.units };
}

/** Package roots found under a workspace root: the compiler would not see them from the file's own directory. */
function importMirrorsFor(resolution: ImportResolution, ownPath: string | undefined): ImportMirror[] {
  const ownDir = ownPath ? path.resolve(path.dirname(ownPath)) : undefined;
  const includeDir = install ? path.resolve(install.includeDir) : undefined;
  const mirrors = new Map<string, string>();
  for (const resolved of resolution.imports) {
    const first = resolved.import.path[0]?.name;
    if (!first || !resolved.base || resolved.files.length === 0) continue;
    const base = path.resolve(resolved.base);
    if (base === ownDir || (includeDir && (base === includeDir || base.startsWith(includeDir + path.sep)))) continue;
    // `import util;` resolves to a file, not a package directory: link the file itself.
    const singleFile = !resolved.import.wildcard && resolved.import.path.length === 1 ? `${first}.pj` : first;
    if (!mirrors.has(singleFile)) mirrors.set(singleFile, path.join(base, singleFile));
  }
  return [...mirrors].map(([name, target]) => ({ name, target }));
}

/** Current editor text wins over both the standard-library and workspace disk caches. */
function analysisSourceForPath(file: string): { program: A.Program; text?: string } | undefined {
  const absolute = path.resolve(file);
  const open = documentForPath(absolute);
  if (open) return { program: parsedFor(open).program, text: open.getText() };
  const program = libraryPrograms.get(absolute) ?? libraryPrograms.get(file) ?? workspace.programFor(absolute);
  return program ? { program } : undefined;
}

connection.languages.semanticTokens.on((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return { data: [] };
  const parsed = parsedFor(doc);
  const { checked, index } = checkFor(doc);
  return { data: semanticTokens(parsed.program, checked, index, { libraryFiles }) };
});

/** Channel hints are computed for the whole file once per analysis; hover and every inlay range reuse them. */
const inlayCache = new WeakMap<CheckResult, ReturnType<typeof channelInlays>>();

function inlaysFor(doc: TextDocument): ReturnType<typeof channelInlays> {
  const analysis = checkFor(doc);
  let hints = inlayCache.get(analysis.checked);
  if (!hints) {
    hints = channelInlays(parsedFor(doc).program, analysis.checked, analysis.effects);
    inlayCache.set(analysis.checked, hints);
  }
  return hints;
}

connection.languages.inlayHint.on((params: InlayHintParams): InlayHint[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const range: A.Span = {
    start: { line: params.range.start.line, col: params.range.start.character },
    end: { line: params.range.end.line, col: params.range.end.character },
  };
  return inlaysFor(doc).filter((hint) => comparePosition(range.start, hint.position) <= 0 && comparePosition(hint.position, range.end) < 0).map((hint) => ({
    position: Position.create(hint.position.line, hint.position.col),
    label: hint.label,
    kind: InlayHintKind.Type,
    paddingLeft: true,
    tooltip: hint.tooltip,
  }));
});

connection.onRequest('processj/concurrencyGraph', (params: { textDocument?: { uri?: string }; uri?: string }): ConcurrencyGraph | null => {
  const uri = params.textDocument?.uri ?? params.uri;
  const doc = uri ? documents.get(uri) : undefined;
  if (!doc) return null;
  const parsed = parsedFor(doc);
  const analysis = checkFor(doc);
  return buildConcurrencyGraph(parsed.program, analysis.checked, analysis.index, { uri: doc.uri, effects: analysis.effects.summaries });
});

// ---------------------------------------------------------------------------
// Process network: the graph viewer, its live server, and exports
// ---------------------------------------------------------------------------

const graphs = new GraphSession(verificationStore, SERVER_VERSION, (document, request) => stateMachine(document.uri, request));
const liveViewer: LiveViewerServer = new LiveViewerServer({
  payload: async (uri) => {
    const csp = cspmDocument(uri);
    if (csp) return cspm.payload(csp);
    const doc = documents.get(uri);
    return doc ? graphs.payload(graphDocument(doc)) : undefined;
  },
  view: async (uri, id) => {
    const csp = cspmDocument(uri);
    if (csp) return cspm.view(csp, id);
    const doc = documents.get(uri);
    return doc ? graphs.view(graphDocument(doc), id) : undefined;
  },
  reveal: (uri, line, col) => revealInEditor(uri, line, col),
  machine: (uri, request) => stateMachine(uri, request),
}, { log: (message) => connection.console.warn(message) });

/** The open CSPm document at a URI, if it is one. */
function cspmDocument(uri: string): TextDocument | undefined {
  const doc = allDocuments.get(uri);
  return doc && isCspmDocument(doc) ? doc : undefined;
}

const cspm: CspmFeatures = new CspmFeatures({
  showMessage: (type, message) => showMessage(type, message),
  sendDiagnostics: (uri, version, diagnostics) => void connection.sendDiagnostics({ uri, version, diagnostics }),
  refines: () => {
    if (!refinesPath) refinesPath = findRefines(settings.fdrPath);
    return refinesPath;
  },
  refinesMissing: () => refinesNotFoundMessage(settings.fdrPath),
  fdr: () => ({ timeoutMs: settings.fdrTimeoutMs, memoryMb: settings.fdrMemoryMb, workers: settings.fdrWorkers, showGraph: settings.fdrShowGraph }),
  writeReport: (name, content) => writeReport(name, content),
  scopedReportName: (uri, name) => scopedReportName(uri, name),
  openInEditor: (file, content) => openInEditor(file, content),
  showGraph: (doc, focus) => showFdrGraph(doc, focus),
  progress: async (title) => {
    if (!clientSupportsWorkDoneProgress) return undefined;
    const progress = await connection.window.createWorkDoneProgress();
    progress.begin(title, 0, 'starting refines', true);
    return { report: (percentage, message) => progress.report(percentage, message), done: () => progress.done(), onCancel: (listener) => void progress.token.onCancellationRequested(listener) };
  },
  open: (uri) => {
    const doc = allDocuments.get(uri);
    if (doc) return doc;
    const file = safeFileUri(uri);
    return file ? documentForPath(file) : undefined;
  },
  liveGraphUrl: async (uri) => (settings.liveViewer && liveViewer.running ? liveViewer.urlFor(uri) : undefined),
  refreshLenses: () => scheduleAnalysisDecorationRefresh(),
  log: (message) => connection.console.warn(message),
}, verificationStore);

verificationStore.onDidChange((uri, producer) => {
  // The checker's report changes only with the document, whose edits already refresh open pages.
  if (producer === 'checker') return;
  liveViewer.notify(uri);
  // The VS Code panel refreshes on save by itself; a model checker's results can arrive at any time.
  if (clientWantsVerificationChanged) void connection.sendNotification('processj/verificationChanged', { uri });
});

/** The current version of a document, as the graph needs it. */
function graphDocument(doc: TextDocument): GraphDocument {
  const parsed = parsedFor(doc);
  const analysis = checkFor(doc);
  const sourcePath = safeFileUri(doc.uri);
  // Each imported file is read once per request, however many calls into it are expanded.
  const units = new Map<string, NetworkUnit | undefined>();
  return {
    uri: doc.uri,
    version: doc.version,
    title: sourcePath ? path.basename(sourcePath) : decodeURIComponent(doc.uri.split('/').pop() ?? 'buffer.pj'),
    text: doc.getText(),
    program: parsed.program,
    checked: analysis.checked,
    index: analysis.index,
    effects: analysis.effects.summaries,
    unitFor: (decl) => networkUnitFor(analysis, decl, units),
    procedureArguments: (decl) => procedureArguments(doc, decl),
  };
}

/** Per document version and procedure: what its own view is drawn with (the arguments FDR checks it with). */
const drawnArgumentCache = new Map<string, { version: number; byLine: Map<number, ProcedureArguments | undefined> }>();

/**
 * The arguments a procedure's own view is drawn with: the ones its FDR check
 * uses (src/csp/translate.ts drawnArguments), from the latest check of this
 * version, else from a translation of it. Only a procedure whose data
 * parameters can decide its network (it runs a par, or takes an array of
 * channels) is translated for this.
 */
function procedureArguments(doc: TextDocument, decl: A.ProcDecl): ProcedureArguments | undefined {
  const line = decl.name.span.start.line;
  let cached = drawnArgumentCache.get(doc.uri);
  if (!cached || cached.version !== doc.version) {
    cached = { version: doc.version, byLine: new Map() };
    drawnArgumentCache.set(doc.uri, cached);
  }
  if (cached.byLine.has(line)) return cached.byLine.get(line);
  const analysis = checkFor(doc);
  const types = new Map(analysis.checked.vars.map((v) => [v.decl, v.type]));
  const isChanArray = (t: Type | undefined): boolean => t?.k === 'array' && t.elem.k === 'chan';
  const data = decl.params.some((p) => {
    const t = types.get(p.name);
    return t?.k === 'prim' && t.name !== 'string' && t.name !== 'barrier' && t.name !== 'timer' && t.name !== 'float' && t.name !== 'double';
  });
  const arrays = decl.params.some((p) => isChanArray(types.get(p.name)));
  let args: ProcedureArguments | undefined;
  if (arrays || (data && analysis.effects.get(decl)?.transitive.par)) {
    const outcome = fdrOutcomes.get(doc.uri)?.get(`proc:${decl.name.name}:${line}`);
    try {
      const model = outcome && outcome.version === doc.version ? outcome.model : translateProcedure(cspInput(doc), decl.name.name, decl.name.span.start);
      args = drawnArguments(model);
    } catch (error) {
      connection.console.error(`processj-lsp: could not work out the arguments '${decl.name.name}' is drawn with: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  cached.byLine.set(line, args);
  return args;
}

/** An imported file's checked unit, addressed the way results address it (open buffer URI, else file URL). */
function networkUnitFor(analysis: Analysis, decl: A.ProcDecl, cache: Map<string, NetworkUnit | undefined>): NetworkUnit | undefined {
  for (const unit of analysis.reachableUnits.slice(1)) {
    if (!unit.file || !unit.program.decls.includes(decl)) continue;
    if (cache.has(unit.file)) return cache.get(unit.file);
    const open = documentForPath(unit.file);
    let text = open?.getText();
    if (text === undefined) {
      try {
        text = fs.readFileSync(unit.file, 'utf8');
      } catch {
        text = undefined;
      }
    }
    const result: NetworkUnit = { checked: unit.checked, uri: open?.uri ?? pathToFileURL(unit.file).toString(), text };
    cache.set(unit.file, result);
    return result;
  }
  return undefined;
}

/** Ask the editor to show a location (the live viewer's source links). */
async function revealInEditor(uri: string, line: number, col: number): Promise<boolean> {
  if (!clientSupportsShowDocument) return false;
  try {
    const position = Position.create(line, col);
    const shown = await connection.window.showDocument({ uri, takeFocus: true, selection: Range.create(position, position) });
    return shown.success;
  } catch {
    return false;
  }
}

/**
 * The viewer's data (and, unless `html` is false, the page) for the VS Code
 * panel; `view` asks for one view, `machine` for one state machine, `focus`
 * opens the page on a check (and a process of it).
 */
connection.onRequest('processj/processNetwork', async (params: { textDocument?: { uri?: string }; uri?: string; nonce?: unknown; cspSource?: unknown; html?: unknown; view?: unknown; machine?: unknown; focus?: unknown }) => {
  const uri = params.textDocument?.uri ?? params.uri;
  const csp = uri ? cspmDocument(uri) : undefined;
  const doc = uri ? documents.get(uri) : undefined;
  if (!doc && !csp) return null;
  // One view the page has not laid out yet.
  if (typeof params.view === 'string') return { view: (csp ? await cspm.view(csp, params.view) : await graphs.view(graphDocument(doc!), params.view)) ?? null };
  const machine = machineRequestOf(params.machine);
  if (machine) return { machine: csp ? undefined : await stateMachine(doc!.uri, machine) };
  const payload = csp ? await cspm.payload(csp, focusOf(params.focus)) : await graphs.payload(graphDocument(doc!), undefined, focusOf(params.focus));
  if (params.html === false) return { payload };
  // Both values end up in the page's Content-Security-Policy: accept plain tokens only.
  const nonce = typeof params.nonce === 'string' && /^[A-Za-z0-9+/=_-]{16,128}$/.test(params.nonce) ? params.nonce : undefined;
  const cspSource = typeof params.cspSource === 'string' && isCspSource(params.cspSource) ? params.cspSource : undefined;
  return { payload, html: renderViewerHtml(payload, { mode: 'webview', nonce, cspSource }) };
});

/**
 * `webview.cspSource`: VS Code sends `'self' https://*.vscode-cdn.net`. Only
 * source expressions of that kind pass: `'self'`, an https host (with a leading
 * wildcard), or a vscode resource scheme.
 */
function isCspSource(value: string): boolean {
  const tokens = value.split(' ');
  return value.length <= 200 && tokens.length <= 6 && tokens.every((token) => /^(?:'self'|https:\/\/(?:\*\.)?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?::\d{1,5})?|vscode-(?:webview-)?resource:)$/.test(token));
}

connection.onRequest('processj/protocolModel', (params: { textDocument?: { uri?: string }; uri?: string }): ProtocolAnalysis | null => {
  const uri = params.textDocument?.uri ?? params.uri;
  const doc = uri ? documents.get(uri) : undefined;
  return doc ? checkFor(doc).protocols : null;
});

/** Send the current lints plus the most recent compiler results (if still for this version). */
function publish(doc: TextDocument): void {
  let lints: Diagnostic[];
  try {
    lints = lintDiagnostics(doc);
  } catch (error) {
    // The publisher runs from a timer, where an uncaught exception would exit
    // the whole server. Report the failure as a diagnostic instead.
    const detail = error instanceof Error ? error.message : String(error);
    connection.console.error(`analysis failed for ${doc.uri}: ${error instanceof Error ? error.stack ?? detail : detail}`);
    lints = [makeDiagnostic(doc, { line: 0, message: `processj-lsp could not analyze this file (${detail}); details are in the server log`, severity: 'warning', code: 'pj/internal', source: 'lsp' })];
  }
  const fromCompiler = compilerDiags.get(doc.uri);
  const compiler = fromCompiler && fromCompiler.version === doc.version ? fromCompiler.diagnostics : [];
  connection.sendDiagnostics({ uri: doc.uri, version: doc.version, diagnostics: [...mergeDiagnostics(lints, compiler), ...fdrDiagnosticsFor(doc)] });
}

/** Drop compiler messages that a lint already explains on the same line. */
function mergeDiagnostics(lints: Diagnostic[], compiler: Diagnostic[]): Diagnostic[] {
  const lintLines = new Set(lints.filter((l) => l.severity === DiagnosticSeverity.Error).map((l) => l.range.start.line));
  const haveSyntax = lints.some((l) => l.code === 'pj/syntax');
  const kept = compiler.filter((c) => {
    if (haveSyntax && c.code === 'syntax') return false; // ours says what is wrong; the compiler's only says "Syntax error"
    return !(lintLines.has(c.range.start.line) && /Symbol .* not found|Unknown name expression|No suitable procedure/.test(String(c.message)));
  });
  return [...lints, ...kept];
}

async function runCheck(uri: string, signal: AbortSignal): Promise<void> {
  const doc = documents.get(uri);
  if (!doc || !install) return;

  const version = doc.version;
  const sourcePath = safeFileUri(uri) ?? 'buffer.pj';
  const analysis = checkFor(doc);
  const result = await compile(install, sourcePath, doc.getText(), {
    timeoutMs: settings.timeoutMs,
    signal,
    yieldContext: { program: parsedFor(doc).program, index: analysis.index, calls: analysis.checked.calls, callProvider: analysis.yieldCallProvider, syntaxErrors: parsedFor(doc).errors.length },
    mirrors: analysis.importMirrors,
  });

  if (result.aborted) return;
  const current = documents.get(uri);
  if (!current || current.version !== version) return; // a newer check is on its way

  let diagnostics: Diagnostic[];
  if (result.timedOut) {
    diagnostics = [makeDiagnostic(current, { line: 0, message: `ProcessJ compiler timed out after ${settings.timeoutMs} ms`, severity: 'warning', code: 'timeout', source: 'lsp' })];
  } else {
    const parsed = parseCompilerOutput(result.stdout, result.stderr);
    diagnostics = parsed.diagnostics.map((d) => makeDiagnostic(current, remapCompilerDiagnostic(result, d), result.sourcePath));
    if (parsed.crash) connection.console.error(`compiler crash on ${sourcePath}: ${parsed.crash}\n${result.stderr}`);
  }
  connection.console.log(`checked ${path.basename(sourcePath)} in ${result.durationMs} ms: ${diagnostics.length} compiler diagnostic(s)`);
  compilerDiags.set(uri, { version, diagnostics });
  publish(current);
}

function makeDiagnostic(doc: TextDocument, raw: RawDiagnostic | LintDiagnostic, compilerBufferPath?: string): Diagnostic {
  const lineCount = Math.max(doc.lineCount, 1);
  let message = raw.message;

  // Errors reported against an imported file: pin them to the top of this document.
  const ownName = path.basename(safeFileUri(doc.uri) ?? '');
  let line = raw.line < 0 ? lineCount - 1 : raw.line;
  const importedCompilerFile = raw.file && compilerBufferPath
    ? !compilerDiagnosticTargetsBuffer({ sourcePath: compilerBufferPath }, raw)
    : false;
  if (raw.file && (importedCompilerFile || (!compilerBufferPath && path.basename(raw.file) !== ownName && path.basename(raw.file) !== 'buffer.pj'))) {
    message = `In ${path.basename(raw.file)}:${raw.line + 1}: ${message}`;
    line = 0;
  }
  line = Math.min(Math.max(line, 0), lineCount - 1);

  const text = lineText(doc, line);
  let start = raw.startCol ?? firstNonSpace(text);
  let end = raw.endCol ?? text.length;

  // The type checker gives only a line; if the message quotes an identifier, narrow to it.
  if (raw.startCol === undefined) {
    const quoted = /'([A-Za-z_$][A-Za-z0-9_$]*)'/.exec(raw.message);
    if (quoted) {
      const idx = indexOfWord(text, quoted[1]);
      if (idx >= 0) {
        start = idx;
        end = idx + quoted[1].length;
      }
    }
  }
  // Compiler columns occasionally point one character past a shortened editor
  // buffer. Keep every published position valid for strict LSP clients.
  start = Math.min(Math.max(start, 0), text.length);
  end = Math.min(Math.max(end, start), text.length);
  if (end === start && start < text.length) end++;

  const severity =
    // Notes go out as Information, not Hint: VS Code draws hints as faint dots and keeps them out of the Problems panel.
    raw.severity === 'error' ? DiagnosticSeverity.Error : raw.severity === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information;
  const fix = (raw as LintDiagnostic).fix;
  const related = (raw as LintDiagnostic).related;
  return {
    range: Range.create(line, start, line, end),
    message,
    severity,
    code: raw.code,
    source: raw.source === 'lsp' ? 'processj-lint' : raw.source === 'parser' && raw.code === 'pj/syntax' ? 'processj-parser' : 'processj',
    tags: raw.code === 'pj/unused' || raw.code === 'pj/unreachable' ? [DiagnosticTag.Unnecessary] : undefined,
    // Code-action coordinates are valid only for this document snapshot.
    data: { version: doc.version, ...(fix ? { fix } : {}) },
    relatedInformation: clientSupportsRelatedInformation ? related?.map((item) => {
      const relatedLine = Math.min(Math.max(item.line, 0), lineCount - 1);
      const relatedText = lineText(doc, relatedLine);
      const relatedStart = Math.min(Math.max(item.startCol, 0), relatedText.length);
      const relatedEnd = Math.min(Math.max(item.endCol, relatedStart), relatedText.length);
      return {
        location: { uri: doc.uri, range: Range.create(relatedLine, relatedStart, relatedLine, relatedEnd) },
        message: item.message,
      };
    }) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Code actions (quick fixes attached to lints)
// ---------------------------------------------------------------------------

connection.onCodeAction((params: CodeActionParams): Array<CodeAction | Command> => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const actions: CodeAction[] = [];
  let plannerOptions: RefactorOptions | undefined;
  const currentPlannerOptions = (): RefactorOptions => {
    if (plannerOptions) return plannerOptions;
    const analysis = checkFor(doc);
    return plannerOptions = {
      file: safeFileUri(doc.uri),
      index: analysis.index,
      importsStd: analysis.importsStd,
      unresolvedImports: analysis.unresolvedImports,
      stdIndex,
      yieldCalls: analysis.yieldCalls,
      trustedNonBlockingNativeDeclarations,
      // The planners re-check candidates, not the current text: reuse the editor's analysis for that.
      current: { source: doc.getText(), parsed: parsedFor(doc), checked: analysis.checked, index: analysis.index },
    };
  };
  const newline = documentNewline(doc);
  const currentDiagnostics = params.context.diagnostics.filter((diagnostic) => {
    const data = diagnostic.data as { version?: number } | undefined;
    return data?.version === undefined || data.version === doc.version;
  });
  for (const d of currentDiagnostics) {
    const diagnosticData = d.data as { version?: number; fix?: FixHint } | undefined;
    if (diagnosticData?.version !== undefined && diagnosticData.version !== doc.version) continue;
    if (d.code === 'pj/channel-direction' || d.code === 'pj/shared-channel-end' || d.code === 'pj/parallel-usage') {
      const kind = d.code === 'pj/parallel-usage' ? CodeActionKind.RefactorRewrite : CodeActionKind.QuickFix;
      if (allowsCodeAction(params.context.only, kind)) {
        const result = planChannelDiagnostic(doc.getText(), {
          code: d.code,
          range: spanForRange(d.range),
        }, currentPlannerOptions());
        if (result.ok) actions.push(refactorCodeAction(doc, result.plan, [d], kind));
        else if (clientSupportsDisabledCodeActions) {
          actions.push({
            title: diagnosticData?.fix?.title ?? channelRefactorFallbackTitle(d.code),
            kind,
            diagnostics: [d],
            disabled: { reason: result.reasons.join(' ') },
          });
        }
      }
    }

    // An FDR result: open the graph on it, at the process it is about.
    const fdr = focusOf((d.data as { fdr?: unknown } | undefined)?.fdr);
    if (d.source === 'fdr' && fdr?.check && allowsCodeAction(params.context.only, CodeActionKind.QuickFix)) {
      actions.push({ title: 'Show in graph', kind: CodeActionKind.QuickFix, diagnostics: [d], command: { title: 'Show in graph', command: COMMAND_SHOW_CONCURRENCY, arguments: [doc.uri, 'viewer', fdr] } });
    }

    const fix = diagnosticData?.fix;
    if (!fix || !allowsCodeAction(params.context.only, CodeActionKind.QuickFix)) continue;
    // The checker hint is only a token insertion. Let the binding-aware planner
    // own this repair so multi-declarators and escaping endpoints cannot be
    // silently widened when the conservative rewrite refuses them.
    if (d.code === 'pj/shared-channel-end' && fix.kind === 'make-shared') continue;
    let edit: TextEdit | undefined;
    if (fix.kind === 'add-import') {
      const line = Math.min(fix.line, doc.lineCount);
      const prefix = fix.line > 0 && lineText(doc, fix.line - 1).trim() !== '' ? newline : '';
      edit = TextEdit.insert(Position.create(line, 0), `${prefix}import std.*;${newline}`);
    } else if (fix.kind === 'make-shared') {
      edit = TextEdit.insert(Position.create(fix.line, fix.col), 'shared ');
    } else if (fix.kind === 'edit') {
      edit = TextEdit.replace(Range.create(fix.line, fix.col, fix.line, fix.endCol ?? fix.col), normalizeNewlines(fix.text ?? '', newline));
    }
    if (!edit) continue;
    actions.push({
      title: fix.title,
      kind: CodeActionKind.QuickFix,
      diagnostics: [d],
      isPreferred: fix.kind !== 'make-shared',
      edit: oneDocumentEdit(doc, [edit]),
    });
  }

  const yieldDiagnostics = currentDiagnostics.filter((diagnostic) => diagnostic.code === 'pj/needs-yield-annotation');
  if (allowsCodeAction(params.context.only, CodeActionKind.RefactorRewrite) && yieldDiagnostics.length > 0) {
    const program = parsedFor(doc).program;
    const analysis = checkFor(doc);
    const pending = new YieldAnalysis(analysis.index, analysis.checked.calls, undefined, analysis.yieldCallProvider, { unresolvedRootCallsYield: false }).needingAnnotation(program);
    if (pending.length > 1) {
      const edits = pending.map((decl) => {
        const insertion = yieldAnnotationEdit(decl);
        return TextEdit.replace(Range.create(insertion.line, insertion.col, insertion.line, insertion.endCol), insertion.text);
      });
      actions.push({
        title: `Add [yield=true] throughout the ${pending.length}-procedure call chain`,
        kind: CodeActionKind.RefactorRewrite,
        diagnostics: yieldDiagnostics,
        edit: oneDocumentEdit(doc, edits),
      });
    }
  }


  const selection = spanForRange(params.range);
  if (comparePosition(selection.start, selection.end) < 0) {
    if (allowsCodeAction(params.context.only, CodeActionKind.RefactorExtract)) {
      addPlannedRefactor(actions, doc, planExtractProcedure(doc.getText(), selection, currentPlannerOptions()), 'Extract selected statements to a procedure', CodeActionKind.RefactorExtract);
    }
    if (allowsCodeAction(params.context.only, CodeActionKind.RefactorRewrite)) {
      addPlannedRefactor(actions, doc, planRunInPar(doc.getText(), selection, currentPlannerOptions()), 'Run selected statements concurrently', CodeActionKind.RefactorRewrite);
    }
  }
  return codeActionsForClient(filterCodeActions(actions, params.context.only));
});

function channelRefactorFallbackTitle(code: 'pj/channel-direction' | 'pj/shared-channel-end' | 'pj/parallel-usage'): string {
  switch (code) {
    case 'pj/channel-direction': return 'Correct channel endpoint direction';
    case 'pj/shared-channel-end': return 'Make channel side shared';
    case 'pj/parallel-usage': return 'Communicate the raced value through a channel';
  }
}

function allowsCodeAction(only: string[] | undefined, kind: string): boolean {
  return !only?.length || only.some((requested) => kind === requested || kind.startsWith(`${requested}.`));
}

function filterCodeActions(actions: CodeAction[], only: string[] | undefined): CodeAction[] {
  if (!only?.length) return actions;
  return actions.filter((action) => {
    const kind = action.kind;
    return !!kind && only.some((requested) => kind === requested || kind.startsWith(`${requested}.`));
  });
}

/** LSP 3.16 clients accept rich CodeAction literals; older clients receive executable Commands. */
function codeActionsForClient(actions: CodeAction[]): Array<CodeAction | Command> {
  if (clientSupportsCodeActionLiterals) return actions;
  if (!clientSupportsApplyEdit) return [];
  const commands: Command[] = [];
  for (const action of actions) {
    if (action.disabled) continue;
    if (action.edit) commands.push({ title: action.title, command: COMMAND_APPLY_EDIT, arguments: [action.edit] });
    else if (action.command) commands.push(action.command);
  }
  return commands;
}

function documentNewline(doc: TextDocument): '\n' | '\r\n' | '\r' {
  const match = /\r\n|\r|\n/.exec(doc.getText());
  return (match?.[0] as '\n' | '\r\n' | '\r' | undefined) ?? '\n';
}

function normalizeNewlines(text: string, newline: '\n' | '\r\n' | '\r'): string {
  return text.replace(/\r\n|\r|\n/g, newline);
}

function addPlannedRefactor(actions: CodeAction[], doc: TextDocument, result: RefactorResult, fallbackTitle: string, kind: string): void {
  if (result.ok) {
    actions.push(refactorCodeAction(doc, result.plan, undefined, kind));
    return;
  }
  if (clientSupportsDisabledCodeActions) actions.push({ title: fallbackTitle, kind, disabled: { reason: result.reasons.join(' ') } });
}

function refactorCodeAction(doc: TextDocument, plan: RefactorPlan, diagnostics: Diagnostic[] | undefined, kind: string): CodeAction {
  return {
    title: plan.title,
    kind,
    diagnostics,
    isPreferred: !!diagnostics,
    edit: oneDocumentEdit(doc, plan.edits.map((edit) => TextEdit.replace(rangeFor(edit.range), edit.newText))),
  };
}

/** Use versioned edits when the client supports them, with the LSP 3.0 fallback otherwise. */
function oneDocumentEdit(doc: TextDocument, edits: TextEdit[]): WorkspaceEdit {
  if (clientSupportsDocumentChanges) {
    return { documentChanges: [{ textDocument: { uri: doc.uri, version: doc.version }, edits }] };
  }
  return { changes: { [doc.uri]: edits } };
}

function spanForRange(range: Range): A.Span {
  return {
    start: { line: range.start.line, col: range.start.character },
    end: { line: range.end.line, col: range.end.character },
  };
}

function comparePosition(a: A.Pos, b: A.Pos): number {
  return a.line - b.line || a.col - b.col;
}

// ---------------------------------------------------------------------------
// Code lenses + commands: build, run, and open analysis reports
// ---------------------------------------------------------------------------

connection.onCodeLens((params: CodeLensParams): CodeLens[] => {
  const csp = cspmDocument(params.textDocument.uri);
  if (csp) return cspm.codeLenses(csp);
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const lenses: CodeLens[] = [];
  const program = parsedFor(doc).program;
  const analysis = checkFor(doc);
  const procedures = program.decls.filter((decl): decl is A.ProcDecl => decl.kind === 'ProcDecl' && !!decl.body);
  for (const [index, decl] of procedures.entries()) {
    const range = rangeFor(decl.name.span);
    const effect = analysis.effects.get(decl);
    if (effect) lenses.push({ range, command: { title: shortEffectLabel(effect), command: COMMAND_SHOW_EFFECTS, arguments: [doc.uri, decl.name.name, decl.name.span.start.line] } });
    if (index === 0) lenses.push({ range, command: { title: 'Concurrency graph', command: COMMAND_SHOW_CONCURRENCY, arguments: [doc.uri] } });
    // FDR: only when refines is installed; above main and other void procedures. After a check the lens shows its verdict.
    if (refinesPath) {
      const outcomes = fdrOutcomes.get(doc.uri);
      const isMain = decl.name.name === 'main';
      const isVoid = decl.returnType.kind === 'PrimitiveType' && decl.returnType.name === 'void';
      const key = isMain ? 'program' : `proc:${decl.name.name}:${decl.name.span.start.line}`;
      const outcome = outcomes?.get(key);
      const fresh = outcome && outcome.version === doc.version ? outcome : undefined;
      // After a check, its verdict opens the graph on that result; before, the lens runs the check. A
      // verdict with nothing to show (a timeout, an error, nothing modelled) runs the check again.
      const focus = fresh ? focusCheck(fresh.report) : undefined;
      // The one button above a procedure: check it with FDR and show the result on the graph (fdrShowGraph).
      const check: Command = isMain ? { title: 'FDR: check program & show graph', command: COMMAND_CHECK_FDR, arguments: [doc.uri] } : { title: 'FDR: check & show graph', command: COMMAND_CHECK_FDR, arguments: [doc.uri, decl.name.name, decl.name.span.start.line] };
      const shown: Command | undefined = !fresh ? undefined
        : focus && hasResult(fresh.report) ? { title: `${fresh.verdict} · show graph`, command: COMMAND_SHOW_CONCURRENCY, arguments: [doc.uri, 'viewer', { check: `${key}/${focus.id}` }] }
          : { ...check, title: `${fresh.verdict} · check again` };
      if (isMain || isVoid) lenses.push({ range, command: shown ?? check });
    }
    if (decl.name.name !== 'main' || !install) continue;
    lenses.push({ range, command: { title: '▶ Run', command: COMMAND_RUN, arguments: [doc.uri] } });
    lenses.push({ range, command: { title: 'Build', command: COMMAND_BUILD, arguments: [doc.uri] } });
  }
  for (const decl of program.decls) {
    if (decl.kind !== 'ProtocolDecl') continue;
    const structure = analysis.protocols.protocols.find((protocol) => protocol.local && protocol.nameSpan.start.line === decl.name.span.start.line && protocol.name === decl.name.name);
    if (!structure) continue;
    const flows = analysis.protocols.flows.filter((flow) => flow.protocolId === structure.id);
    const producers = new Set(flows.filter((flow) => flow.kind === 'send' || flow.kind === 'construct').map((flow) => flow.procedureId).filter(Boolean)).size;
    const consumers = new Set(flows.filter((flow) => flow.kind === 'receive' || flow.kind === 'match' || flow.kind === 'test').map((flow) => flow.procedureId).filter(Boolean)).size;
    const declaredCases = structure.cases.filter((protocolCase) => protocolCase.effective).length;
    const title = `${declaredCases} declared ${declaredCases === 1 ? 'case' : 'cases'} · ${producers} ${producers === 1 ? 'producer' : 'producers'} · ${consumers} ${consumers === 1 ? 'consumer' : 'consumers'}`;
    lenses.push({ range: rangeFor(decl.name.span), command: { title, command: COMMAND_SHOW_PROTOCOLS, arguments: [doc.uri, structure.id] } });
  }
  return lenses;
});

function shortEffectLabel(summary: ProcedureEffectSummary): string {
  const labels = effectLabels(summary).slice(0, 3);
  const rest = effectLabels(summary).length - labels.length;
  return `effects: ${labels.length ? labels.join(' · ') : 'local computation'}${rest > 0 ? ` · +${rest}` : ''}${summary.transitive.unknown ? ' (partial)' : ''}`;
}

function effectLabels(summary: ProcedureEffectSummary): string[] {
  const facts = summary.transitive;
  const labels: string[] = [];
  if (facts.channelRead) labels.push('reads');
  if (facts.channelWrite) labels.push('writes');
  if (facts.par) labels.push('par');
  if (facts.alt) labels.push('alt');
  if (facts.barrier) labels.push('barrier');
  if (facts.timer) labels.push('timer');
  if (facts.mobile) labels.push('mobile');
  if (facts.blocking && !facts.channelRead && !facts.channelWrite && !facts.barrier && !facts.timer && !facts.par && !facts.alt) labels.push('may block');
  if (facts.unknown) labels.push('opaque call');
  return labels;
}

function formatEffectMarkdown(fileName: string, analysis: EffectAnalysis, selectedName?: string, selectedLine?: number): string {
  const selected = analysis.ordered.filter((summary) =>
    (!selectedName || summary.decl.name.name === selectedName) && (selectedLine === undefined || summary.decl.name.span.start.line === selectedLine));
  const summaries = selected.length ? selected : analysis.ordered;
  const lines = [`# Procedure effects — ${fileName}`, '', 'Effects are conservative “may” effects. `partial` means an unresolved, native, or unavailable call was encountered.', ''];
  for (const summary of summaries) {
    lines.push(`## ${summary.decl.name.name}`, '', `- Confidence: **${summary.transitive.confidence}${summary.transitive.unknown ? ' (partial)' : ''}**`);
    const direct = effectFactText(summary.direct);
    const transitive = effectFactText(summary.transitive);
    lines.push(`- Direct: ${direct}`, `- Through calls: ${transitive}`);
    if (summary.transitive.channelReads.size) lines.push(`- Reads channel parameter${summary.transitive.channelReads.size === 1 ? '' : 's'}: ${[...summary.transitive.channelReads].map((index) => `\`${summary.decl.params[index]?.name.name ?? `#${index + 1}`}\``).join(', ')}`);
    if (summary.transitive.channelWrites.size) lines.push(`- Writes channel parameter${summary.transitive.channelWrites.size === 1 ? '' : 's'}: ${[...summary.transitive.channelWrites].map((index) => `\`${summary.decl.params[index]?.name.name ?? `#${index + 1}`}\``).join(', ')}`);
    if (summary.recursive) lines.push(`- Recursive call component: ${summary.scc}`);
    if (summary.calls.length) {
      lines.push('- Calls:');
      for (const call of summary.calls) lines.push(`  - ${call.call.name.name}: ${call.resolution}${call.targetFile ? ` — ${path.basename(call.targetFile)}` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function effectFactText(facts: ProcedureEffectSummary['transitive']): string {
  const labels: string[] = [];
  if (facts.channelRead) labels.push('channel read');
  if (facts.channelWrite) labels.push('channel write');
  if (facts.par) labels.push('parallel spawn/join');
  if (facts.alt) labels.push('alternation');
  if (facts.barrier) labels.push('barrier');
  if (facts.timer) labels.push('timer');
  if (facts.mobile) labels.push('mobile-process semantics');
  if (facts.blocking) labels.push('may suspend');
  if (facts.unknown) labels.push('unknown effects');
  return labels.length ? labels.join(', ') : 'local non-blocking computation';
}

function formatProtocolMarkdown(fileName: string, analysis: ProtocolAnalysis, selectedId?: string): string {
  const selected = selectedId ? analysis.protocols.filter((protocol) => protocol.id === selectedId) : analysis.protocols.filter((protocol) => protocol.local);
  const protocols = selected.length ? selected : analysis.protocols;
  const lines = [`# Protocol intelligence — ${fileName}`, '', '_ProcessJ protocols are tagged unions. Message transitions below are observations from this source, not declared session-type guarantees._', ''];
  for (const protocol of protocols) {
    lines.push(`## ${protocol.name}`, '');
    if (protocol.parents.length) lines.push(`Extends: ${protocol.parents.map((parent) => `\`${parent.name}\`${parent.resolved ? '' : ' (unresolved)'}`).join(', ')}`, '');
    const reportedCases = selectedId ? effectiveProtocolCases(analysis.protocols, protocol) : protocol.cases.filter((entry) => entry.effective);
    if (!selectedId && protocol.parents.length) lines.push('_Declared cases (follow parent links for inherited cases):_', '');
    for (const protocolCase of reportedCases) {
      const fields = protocolCase.fields.map((field) => `${field.typeLabel} ${field.name}`).join(', ');
      lines.push(`- **${protocolCase.name}**${protocolCase.inherited ? ` — inherited from ${protocolCase.declaringProtocolName}` : ''}${fields ? `: ${fields}` : ''}`);
    }
    if (!protocol.caseSetComplete) lines.push('- Case universe is partial because a parent or declaration is unavailable.');
    for (const collision of protocol.collisions.filter((entry) => entry.introduced)) lines.push(`- ⚠ Case **${collision.caseName}** collides across ${collision.origins.map((origin) => origin.declaringProtocolName).join(', ')}.`);

    const switches = analysis.switches.filter((protocolSwitch) => protocolSwitch.protocolId === protocol.id);
    if (switches.length) {
      lines.push('', '### Coverage', '');
      for (const protocolSwitch of switches) {
        const handled = protocolSwitch.labels.filter((label) => label.kind === 'case' && label.valid).map((label) => label.name).join(', ') || 'none';
        const missing = protocolSwitch.missingCases.map((entry) => entry.name).join(', ');
        lines.push(`- ${protocolSwitch.procedureName ?? 'top level'}, line ${protocolSwitch.span.start.line + 1}: **${protocolSwitch.coverage}**; handles ${handled}${missing ? `; missing ${missing}` : ''}${protocolSwitch.defaultLabels.length ? '; has default' : ''}.`);
      }
    }

    const flows = analysis.flows.filter((flow) => flow.protocolId === protocol.id);
    if (flows.length) {
      lines.push('', '### Observed message flow', '');
      for (const flow of flows) lines.push(`- ${flow.procedureName ?? 'top level'}: ${flow.kind}${flow.caseName ? ` \`${flow.caseName}\`` : ''} at line ${flow.span.start.line + 1}`);
      const transitions = inferredProtocolTransitions(flows);
      if (transitions.length) {
        lines.push('', '### Inferred transitions', '');
        for (const transition of transitions) lines.push(`- \`${transition.from}\` → \`${transition.to}\` in ${transition.procedure} *(observed inference)*`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

function inferredProtocolTransitions(flows: ProtocolAnalysis['flows']): Array<{ from: string; to: string; procedure: string }> {
  const byProcedure = new Map<string, { name: string; flows: typeof flows }>();
  for (const flow of flows) {
    if (!flow.procedureId || !flow.procedureName) continue;
    const group = byProcedure.get(flow.procedureId);
    if (group) group.flows.push(flow);
    else byProcedure.set(flow.procedureId, { name: flow.procedureName, flows: [flow] });
  }
  const out: Array<{ from: string; to: string; procedure: string }> = [];
  const seen = new Set<string>();
  for (const [procedureId, group] of byProcedure) {
    const incoming = new Set(group.flows.filter((flow) => flow.kind === 'match' || flow.kind === 'test').map((flow) => flow.caseName).filter((name): name is string => !!name));
    const outgoing = new Set(group.flows.filter((flow) => flow.kind === 'send' || flow.kind === 'construct').map((flow) => flow.caseName).filter((name): name is string => !!name));
    for (const from of incoming) for (const to of outgoing) {
      const key = `${procedureId}\0${from}\0${to}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ from, to, procedure: group.name });
      }
    }
  }
  return out;
}

// One private directory per server process: reports keep a stable name so the
// editor reuses the tab, without writing to a path another user could pre-create.
let runsDir: string | undefined;
/** One Run or Build at a time per document: a newer command (or the client cancelling) stops the older JVMs. */
const runControllers = new Map<string, AbortController>();

connection.onExecuteCommand(async (params: ExecuteCommandParams, token) => {
  if (params.command === COMMAND_APPLY_EDIT) {
    if (!clientSupportsApplyEdit) throw new ResponseError(ErrorCodes.InvalidRequest, 'Client does not support workspace/applyEdit');
    const edit = params.arguments?.[0];
    if (!edit || typeof edit !== 'object') throw new ResponseError(ErrorCodes.InvalidParams, 'ProcessJ legacy edit command requires a workspace edit');
    return connection.workspace.applyEdit(edit as WorkspaceEdit);
  }
  if (params.command === COMMAND_CANCEL_FDR) return cancelFdr(params.arguments?.[0]);
  const csp = cspmDocument(String(params.arguments?.[0] ?? ''));
  if (csp) return cspmCommand(params, csp, token);
  if (params.command === COMMAND_CONVERT_CSP || params.command === COMMAND_CHECK_FDR) return fdrCommand(params, token);
  const known = params.command === COMMAND_RUN
    || params.command === COMMAND_BUILD
    || params.command === COMMAND_SHOW_CONCURRENCY
    || params.command === COMMAND_EXPORT_GRAPH
    || params.command === COMMAND_SHOW_EFFECTS
    || params.command === COMMAND_SHOW_PROTOCOLS;
  if (!known) throw new ResponseError(ErrorCodes.InvalidParams, `Unknown ProcessJ command '${params.command}'`);

  const uri = String(params.arguments?.[0] ?? '');
  const doc = documents.get(uri);
  if (!doc) {
    showMessage(MessageType.Error, 'processj-lsp: open the .pj file first');
    return null;
  }
  const sourcePath = safeFileUri(uri) ?? 'buffer.pj';
  const fileName = path.basename(sourcePath);
  const stem = path.basename(fileName, '.pj');
  const reportName = (suffix: string): string => scopedReportName(uri, `${stem}.${suffix}`);
  if (params.command === COMMAND_SHOW_CONCURRENCY) {
    const mode = params.arguments?.[1] === undefined || params.arguments[1] === null ? 'viewer' : String(params.arguments[1]);
    return showGraph(doc, mode, reportName, focusOf(params.arguments?.[2]));
  }
  if (params.command === COMMAND_EXPORT_GRAPH) {
    const format = params.arguments?.[1] === undefined ? 'all' : String(params.arguments[1]);
    const directory = typeof params.arguments?.[2] === 'string' && params.arguments[2] ? params.arguments[2] : undefined;
    return exportGraph(doc, format, directory);
  }
  if (params.command === COMMAND_SHOW_EFFECTS) {
    const name = typeof params.arguments?.[1] === 'string' ? params.arguments[1] : undefined;
    const line = typeof params.arguments?.[2] === 'number' ? params.arguments[2] : undefined;
    return showReport(reportName('effects.pjreport'), formatEffectMarkdown(fileName, checkFor(doc).effects, name, line));
  }
  if (params.command === COMMAND_SHOW_PROTOCOLS) {
    const selectedId = typeof params.arguments?.[1] === 'string' ? params.arguments[1] : undefined;
    return showReport(reportName('protocols.pjreport'), formatProtocolMarkdown(fileName, checkFor(doc).protocols, selectedId));
  }
  // Every report command returned above and the `known` guard rejected anything
  // else, so only Run and Build reach the compiler from here.
  if (!install) {
    showMessage(MessageType.Error, `processj-lsp: ${installError}`);
    return null;
  }

  runControllers.get(uri)?.abort();
  const controller = new AbortController();
  runControllers.set(uri, controller);
  const cancellation = token.onCancellationRequested(() => controller.abort());
  try {
    showMessage(MessageType.Info, `ProcessJ: building ${fileName}…`);
    const analysis = checkFor(doc);
    const built = await build(install, sourcePath, doc.getText(), {
      timeoutMs: settings.timeoutMs * 3,
      signal: controller.signal,
      yieldContext: { program: parsedFor(doc).program, index: analysis.index, calls: analysis.checked.calls, callProvider: analysis.yieldCallProvider, syntaxErrors: parsedFor(doc).errors.length },
      mirrors: analysis.importMirrors,
    });
    try {
      if (built.aborted) return null;
      if (!built.ok) {
        const target = await showReport(reportName('build.txt'), formatReport(fileName, built.stages));
        const failed = built.stages.find((s) => !s.ok);
        showMessage(MessageType.Error, `ProcessJ: ${failed?.name ?? 'build'} failed`);
        return target;
      }

      if (params.command === COMMAND_BUILD) {
        const target = await showReport(reportName('build.txt'), formatReport(fileName, built.stages));
        showMessage(MessageType.Info, `ProcessJ: ${fileName} built successfully`);
        return target;
      }

      const result = await run(install, built, { timeoutMs: settings.runTimeoutMs, signal: controller.signal });
      if (result.aborted) return null;
      const target = await showReport(reportName('run.txt'), formatReport(fileName, result.stages, { output: result.output, exitCode: result.exitCode, timedOut: result.timedOut }));
      if (result.timedOut) showMessage(MessageType.Warning, `ProcessJ: ${fileName} did not finish within ${settings.runTimeoutMs} ms (deadlock?)`);
      else showMessage(MessageType.Info, `ProcessJ: ${fileName} finished (exit ${result.exitCode}) in ${result.durationMs} ms`);
      return target;
    } finally {
      built.sandbox.cleanup();
    }
  } finally {
    cancellation.dispose();
    if (runControllers.get(uri) === controller) runControllers.delete(uri);
  }
});


/** A command on a CSPm document: the graph, its export, and FDR on the file's own assertions. */
async function cspmCommand(params: ExecuteCommandParams, doc: TextDocument, token: { onCancellationRequested(listener: () => void): { dispose(): void } }): Promise<unknown> {
  const stem = path.basename(safeFileUri(doc.uri) ?? 'buffer.csp');
  switch (params.command) {
    case COMMAND_CHECK_FDR:
      try {
        return await cspm.check(doc, token);
      } catch (error) {
        connection.console.error(`${params.command} failed for ${doc.uri}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        showMessage(MessageType.Error, `processj-lsp: the FDR check failed (${error instanceof Error ? error.message : String(error)}); details are in the server log`);
        return null;
      }
    case COMMAND_SHOW_CONCURRENCY: {
      const mode = params.arguments?.[1] === undefined || params.arguments[1] === null ? 'viewer' : String(params.arguments[1]);
      cspm.mentionSource(doc);
      return showGraph(doc, mode, (suffix) => scopedReportName(doc.uri, `${stem}.${suffix}`), focusOf(params.arguments?.[2]));
    }
    case COMMAND_EXPORT_GRAPH: {
      const format = params.arguments?.[1] === undefined ? 'all' : String(params.arguments[1]);
      const directory = typeof params.arguments?.[2] === 'string' && params.arguments[2] ? params.arguments[2] : undefined;
      return exportGraph(doc, format, directory);
    }
    case COMMAND_CONVERT_CSP:
      showMessage(MessageType.Info, `processj-lsp: ${stem} is already CSPm; Check with FDR runs its assertions.`);
      return null;
    case COMMAND_RUN:
    case COMMAND_BUILD:
    case COMMAND_SHOW_EFFECTS:
    case COMMAND_SHOW_PROTOCOLS:
      showMessage(MessageType.Info, `processj-lsp: that command is for ProcessJ files. For a CSPm file there are the process graph and Check with FDR.`);
      return null;
    default:
      throw new ResponseError(ErrorCodes.InvalidParams, `Unknown ProcessJ command '${params.command}'`);
  }
}

// ---------------------------------------------------------------------------
// Convert to CSP and Check with FDR
// ---------------------------------------------------------------------------

/** What one FDR check found, for one document version: its report, diagnostics and code-lens verdict. */
interface FdrOutcome {
  version: number;
  report: VerificationReport;
  model: CspModel;
  verdict: string;
  diagnostics: Diagnostic[];
  /** The imported files the model was translated from, with a hash of the text read from each (its buffer, or the file). */
  imports: Array<{ file: string; hash: string }>;
}

/** Latest FDR outcome per document and target (`program`, or `proc:<name>:<line>`). */
const fdrOutcomes = new Map<string, Map<string, FdrOutcome>>();
/** One FDR check per document at a time: a newer one (or the client cancelling) stops the older refines. */
const fdrRuns = new Map<string, AbortController>();

interface CspTarget {
  /** Key of the outcome map. */
  key: string;
  /** Undefined for the whole program. */
  procedure?: A.ProcDecl;
  /** `the program`, `procedure delta`. */
  label: string;
}

/** `processj.convertToCsp` and `processj.checkWithFdr`: [uri, procedure name?, line of its name?]. */
async function fdrCommand(params: ExecuteCommandParams, token: { onCancellationRequested(listener: () => void): { dispose(): void } }): Promise<unknown> {
  const uri = String(params.arguments?.[0] ?? '');
  const doc = documents.get(uri);
  if (!doc) {
    showMessage(MessageType.Error, 'processj-lsp: open the .pj file first');
    return null;
  }
  const parsed = parsedFor(doc);
  if (parsed.errors.length) {
    showMessage(MessageType.Error, `ProcessJ: fix the syntax error${parsed.errors.length === 1 ? '' : 's'} first (line ${parsed.errors[0].line + 1}: ${parsed.errors[0].message})`);
    return null;
  }
  const name = typeof params.arguments?.[1] === 'string' && params.arguments[1].trim() ? params.arguments[1].trim() : undefined;
  const line = typeof params.arguments?.[2] === 'number' ? params.arguments[2] : undefined;
  const target = cspTarget(doc, name, line);
  if (typeof target === 'string') {
    showMessage(MessageType.Error, `ProcessJ: ${target}`);
    return null;
  }
  try {
    if (params.command === COMMAND_CONVERT_CSP) return await convertToCsp(doc, target);
    return await checkDocumentWithFdr(doc, target, token);
  } catch (error) {
    // A translator bug must not look like a verdict: say so, and leave the details in the log.
    connection.console.error(`${params.command} failed for ${uri}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    showMessage(MessageType.Error, `ProcessJ: ${params.command === COMMAND_CONVERT_CSP ? 'the translation to CSP' : 'the FDR check'} failed (${error instanceof Error ? error.message : String(error)}); details are in the server log`);
    return null;
  }
}

/**
 * `processj.cancelFdr [uri?]`: stop the running FDR check of a document (of
 * every document without one). Editors whose progress has no cancel button
 * (Neovim, Emacs) offer this as a command.
 */
function cancelFdr(arg: unknown): { cancelled: number } {
  const uri = typeof arg === 'string' && arg ? arg : undefined;
  let cancelled = cspm.cancel(uri);
  for (const [key, controller] of fdrRuns) {
    if (uri && key !== uri) continue;
    controller.abort();
    cancelled++;
  }
  if (!cancelled) showMessage(MessageType.Info, `FDR: no check is running${uri ? ` for ${path.basename(safeFileUri(uri) ?? uri)}` : ''}`);
  return { cancelled };
}

function cspTarget(doc: TextDocument, name: string | undefined, line: number | undefined): CspTarget | string {
  const procedures = parsedFor(doc).program.decls.filter((d): d is A.ProcDecl => d.kind === 'ProcDecl' && !!d.body);
  // `main` checked by name is the whole program: one target, one lens, one report.
  if (name === 'main' && procedures.some((d) => d.name.name === 'main')) name = undefined;
  if (!name) {
    const main = procedures.find((d) => d.name.name === 'main');
    if (!main) return `${path.basename(safeFileUri(doc.uri) ?? 'this file')} has no main: name the procedure to translate (${procedures.map((d) => d.name.name).slice(0, 6).join(', ') || 'none has a body'})`;
    return { key: 'program', label: 'the program' };
  }
  const candidates = procedures.filter((d) => d.name.name === name);
  const procedure = (line !== undefined ? candidates.find((d) => d.name.span.start.line === line) : undefined) ?? candidates[0];
  if (!procedure) return `there is no procedure '${name}' with a body in this file`;
  return { key: `proc:${name}:${procedure.name.span.start.line}`, procedure, label: `procedure ${name}` };
}

/** The document and the imported files its calls reach, as the translator wants them. */
function cspInput(doc: TextDocument): TranslateInput {
  const parsed = parsedFor(doc);
  const analysis = checkFor(doc);
  const units: CspUnit[] = [{ program: parsed.program, checked: analysis.checked, file: safeFileUri(doc.uri), uri: doc.uri, text: doc.getText(), comments: parsed.comments }];
  for (const unit of analysis.reachableUnits.slice(1)) {
    if (!unit.file) continue;
    const open = documentForPath(unit.file);
    let text = open?.getText();
    if (text === undefined) {
      try {
        text = fs.readFileSync(unit.file, 'utf8');
      } catch {
        /* statement texts in comments are optional */
      }
    }
    units.push({ program: unit.program, checked: unit.checked, file: unit.file, uri: open?.uri ?? pathToFileURL(unit.file).toString(), text });
  }
  return { units, index: analysis.index };
}

function translateTarget(doc: TextDocument, target: CspTarget): { model: CspModel; input: TranslateInput } {
  const input = cspInput(doc);
  const model = target.procedure
    ? translateProcedure(input, target.procedure.name.name, target.procedure.name.span.start)
    : translateProgram(input);
  return { model, input };
}

/**
 * Write the model next to the source (`commstime.csp`, `commstime.delta.csp`)
 * so it can be opened in FDR's GUI or handed in. A file of that name that
 * processj-lsp did not generate is never overwritten: the model then goes to
 * the private report directory, and the note says so.
 */
function writeGeneratedCsp(doc: TextDocument, model: CspModel): { file: string; note?: string } {
  const source = safeFileUri(doc.uri);
  const stem = path.basename(source ?? 'buffer.pj', '.pj');
  const name = `${stem}${model.target.kind === 'procedure' ? `.${model.target.name}` : ''}.csp`;
  let note: string | undefined;
  if (source) {
    const preferred = path.join(path.dirname(source), name);
    // Never through a symbolic link: a workspace's `demo.csp` could point anywhere.
    const outcome = writeGeneratedFile(preferred, model.text, (head) => head.startsWith(CSP_MARKER));
    if (outcome.written) return { file: preferred };
    note = outcome.reason === NOT_GENERATED ? `${preferred} exists and was not generated by processj-lsp, so it was left alone` : `could not write ${preferred} (${outcome.reason})`;
  }
  return { file: writeReport(scopedReportName(doc.uri, name), model.text), note };
}

async function convertToCsp(doc: TextDocument, target: CspTarget): Promise<unknown> {
  const { model } = translateTarget(doc, target);
  const written = writeGeneratedCsp(doc, model);
  await openInEditor(written.file, model.text);
  const notes = [
    ...(written.note ? [`${written.note}; the model is at ${written.file}`] : []),
    ...(model.unsupported.length ? [`not modelled: ${model.unsupported[0].message}${model.unsupported.length > 1 ? ` (and ${model.unsupported.length - 1} more, listed at the top of the file)` : ''}`] : []),
    ...(model.warnings.length ? [`${model.warnings.length} warning${model.warnings.length === 1 ? '' : 's'}, listed at the top of the file`] : []),
  ];
  const message = `ProcessJ: wrote ${path.basename(written.file)} (${target.label})${notes.length ? `: ${notes.join('; ')}` : ''}`;
  if (model.unsupported.length || written.note) showMessage(MessageType.Warning, message);
  else showMessage(MessageType.Info, message);
  return { cspFile: written.file, unsupported: model.unsupported.length, warnings: model.warnings.length };
}

async function checkDocumentWithFdr(doc: TextDocument, target: CspTarget, token: { onCancellationRequested(listener: () => void): { dispose(): void } }): Promise<unknown> {
  if (!refinesPath) refinesPath = findRefines(settings.fdrPath);
  if (!refinesPath) {
    showMessage(MessageType.Error, `ProcessJ: ${refinesNotFoundMessage(settings.fdrPath)}`);
    return null;
  }
  const uri = doc.uri;
  const version = doc.version;
  fdrRuns.get(uri)?.abort();
  const controller = new AbortController();
  fdrRuns.set(uri, controller);
  const cancellation = token.onCancellationRequested(() => controller.abort());
  const source = safeFileUri(uri);
  const fileName = path.basename(source ?? 'buffer.pj');
  const progress = clientSupportsWorkDoneProgress ? await connection.window.createWorkDoneProgress() : undefined;
  const progressCancel = progress?.token.onCancellationRequested(() => controller.abort());
  try {
    // Two files checked at once have a progress line each: the title names the file.
    progress?.begin(`FDR: checking ${target.label} of ${fileName}`, 0, `translating ${fileName}`, true);
    if (!progress) showMessage(MessageType.Info, `FDR: checking ${target.label} in ${fileName}…`);
    const { model, input } = translateTarget(doc, target);
    const written = writeGeneratedCsp(doc, model);
    const runName = scopedReportName(uri, `fdr/${path.basename(written.file)}`);
    progress?.report(0, model.unsupported.length ? 'the model is incomplete: nothing to run' : `running FDR on ${path.basename(written.file)}`);
    const started = Date.now();
    const result = await checkWithFdr({
      ...input,
      model,
      uri,
      documentVersion: version,
      refines: refinesPath,
      timeoutMs: settings.fdrTimeoutMs,
      memoryLimit: settings.fdrMemoryMb ? settings.fdrMemoryMb * 1024 * 1024 : undefined,
      workers: settings.fdrWorkers || undefined,
      signal: controller.signal,
      // FDR runs a private copy; a block's `include "spec.csp"` still finds the file next to the source.
      cspFile: writeReport(runName, model.text),
      includeBase: source ? path.dirname(source) : undefined,
      onProgress: (done, total, label, raw) => progress?.report(Math.round((done / total) * 100), `${label}: ${raw.passed === true ? 'holds' : raw.passed === false ? 'fails' : 'no verdict'} (${done}/${total})`),
    });
    if (result.rawResults?.aborted) {
      showMessage(MessageType.Info, `FDR: the check of ${target.label} was cancelled`);
      return null;
    }
    const { report } = result;
    const verdict = lensVerdict(report);
    const current = documents.get(uri);
    const imports = input.units.slice(1).filter((unit) => !!unit.file).map((unit) => ({ file: unit.file!, hash: textHash(unit.text ?? '') }));
    // The file (or a file it imports) changed while FDR ran: the result is about text that is gone.
    const fresh = !!current && current.version === version && imports.every((entry) => entry.hash === textHash(currentText(entry.file) ?? ''));
    if (current && fresh) {
      const diagnostics = fdrDiagnostics(report, model, result.rawResults).map((d) => fdrToDiagnostic(current, d, model, target, report));
      const perTarget = fdrOutcomes.get(uri) ?? new Map<string, FdrOutcome>();
      perTarget.set(target.key, { version, report, model, verdict, diagnostics, imports });
      fdrOutcomes.set(uri, perTarget);
      publish(current);
      scheduleAnalysisDecorationRefresh();
      fdrReportChanged(uri, target);
      publishFdr(current);
    }
    const stale = fresh ? undefined : 'The file changed while FDR ran: this report is about the text before that edit. Run the check again for the current text.';
    const stem = path.basename(written.file, '.csp');
    const jsonFile = writeReport(scopedReportName(uri, `${stem}.fdr.json`), `${JSON.stringify(report, null, 2)}\n`);
    const text = formatFdrReport(report, { fileName, cspFile: written.file, model, durationMs: Date.now() - started, jsonFile, stale });
    const reportFile = writeReport(scopedReportName(uri, `${stem}.fdr.pjreport`), text);
    const note = written.note ? ` (${written.note}; the model is at ${written.file})` : '';
    if (!fresh) {
      // Nothing is shown as current (no lens, diagnostics or graph), and nothing opens over the editing.
      showMessage(MessageType.Warning, `FDR, ${target.label}: the file changed while FDR ran, so this result is about the text before that edit (${fdrSummary(report, target, verdict, '')[1].replace(/^FDR, [^:]*: /, '')}). Run the check again; the report is in ${reportFile}${note}`);
      return { reportFile, jsonFile, cspFile: written.file, report, stale: true };
    }
    showMessage(...fdrSummary(report, target, verdict, note));
    // The graph shows where it gets stuck (fdrShowGraph); the text report opens when it does not.
    const focus = focusCheck(report);
    const graph = current && focus && wantsGraph(report) ? await showFdrGraph(current, { check: `${target.key}/${focus.id}` }) : false;
    if (!graph) await openInEditor(reportFile, text);
    return { reportFile, jsonFile, cspFile: written.file, report };
  } finally {
    progress?.done();
    progressCancel?.dispose();
    cancellation.dispose();
    if (fdrRuns.get(uri) === controller) fdrRuns.delete(uri);
  }
}

/**
 * The one-line outcome of a check for the editor's message area: what failed,
 * why nothing was checked, or what held and what that does not cover.
 */
function fdrSummary(report: VerificationReport, target: CspTarget, verdict: string, note: string): [MessageType, string] {
  const failed = report.checks.find((c) => c.status === 'failed' && c.severity !== 'info');
  const partial = !failed ? report.checks.find((c) => c.status === 'failed' && c.counterexample && isPartialDeadlock(c.counterexample)) : undefined;
  const broken = report.checks.find((c) => c.status === 'error' || c.status === 'timeout' || c.status === 'skipped');
  // A proof about the model that the compiled program may not share is worth a look, like a failure.
  const limited = report.checks.some((c) => c.status === 'passed' && c.limits?.length);
  const what = (failed ?? partial)?.counterexample?.summary ?? (broken?.message ? `${verdict.replace(/^FDR: /, '')}: ${broken.message.length > 240 ? `${broken.message.slice(0, 237)}...` : broken.message}` : verdict.replace(/^FDR: /, ''));
  // A run the real program may not take says so where the verdict is read first.
  const caveats = (failed ?? partial)?.counterexample?.caveats?.length ?? 0;
  const relies = caveats ? ` (the real program may not do this: the run relies on ${caveats === 1 ? 'something' : `${caveats} things`} the model abstracts, listed in the report and the graph)` : '';
  // Checked with the arguments its calls give: said once, after the target (the verdict ends with them too).
  const args = report.checks[0]?.target.arguments;
  const said = args && what.endsWith(` · ${args}`) ? what.slice(0, -` · ${args}`.length) : what;
  return [failed || partial || broken || limited || !report.checks.length ? MessageType.Warning : MessageType.Info, `FDR, ${target.label}${args ? ` (${args})` : ''}: ${said}${relies}${note}`];
}

/** Tell the editor (and the graph viewer) that the stored report of a document changed: `processj/fdrReportChanged`. */
function fdrReportChanged(uri: string, target?: CspTarget): void {
  void connection.sendNotification('processj/fdrReportChanged', { uri, ...(target ? { target: target.procedure ? { kind: 'procedure', name: target.procedure.name.name, line: target.procedure.name.span.start.line } : { kind: 'program' } } : {}) });
}

function fdrToDiagnostic(doc: TextDocument, d: FdrDiagnostic, model: CspModel, target: CspTarget, report: VerificationReport): Diagnostic {
  const severity = d.severity === 'error' ? DiagnosticSeverity.Error : d.severity === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information;
  let range = Range.create(d.span.start.line, d.span.start.col, d.span.end.line, d.span.end.col);
  // A procedure checked on its own says so: the same statement can also get the program's verdict.
  // Checked with the arguments its calls give, it says which (`FDR (altFIFO on its own, size = 6): ...`).
  const args = report.checks[0]?.target.arguments;
  let message = target.procedure ? d.message.replace(/^FDR: /, `FDR (${target.procedure.name.name} on its own${args ? `, ${args}` : ''}): `) : d.message;
  let related = d.related;
  if (d.uri !== doc.uri) {
    // A statement in an imported file: shown at the branch or call of this document that leads there
    // (the last spawn site in the stuck process's path), else on the checked procedure.
    const anchor = importAnchor(doc.uri, d, report) ?? model.target.at?.span ?? { start: { line: 0, col: 0 }, end: { line: 0, col: 1 } };
    let where = d.uri;
    try {
      where = path.basename(fileURLToPath(d.uri));
    } catch {
      /* not a file URI */
    }
    message = `In ${where}:${d.span.start.line + 1}: ${message}`;
    related = [{ uri: d.uri, span: d.span, message: `the statement in ${where}` }, ...related];
    range = Range.create(anchor.start.line, anchor.start.col, anchor.end.line, anchor.end.col);
  }
  return {
    range: clampRange(doc, range),
    message,
    severity,
    code: d.code,
    source: 'fdr',
    // What "Show in graph" opens: the check in the published report, and the process it is about.
    data: { version: doc.version, ...(d.check ? { fdr: { check: `${target.key}/${d.check}`, ...(d.process ? { process: pathKey(d.process.path) } : {}) } } : {}) },
    relatedInformation: clientSupportsRelatedInformation && related.length
      ? related.map((r) => ({ location: { uri: r.uri, range: Range.create(r.span.start.line, r.span.start.col, r.span.end.line, r.span.end.col) }, message: r.message }))
      : undefined,
  };
}

/**
 * For a diagnostic on a statement of an imported file: the last spawn site
 * (a par branch, a par for, a call on the way to a par) in this document on
 * the path of a process stuck there.
 */
function importAnchor(uri: string, d: FdrDiagnostic, report: VerificationReport): A.Span | undefined {
  for (const check of report.checks) {
    for (const snap of check.counterexample?.final ?? []) {
      const here = snap.at && snap.at.uri === d.uri && snap.at.span.start.line === d.span.start.line;
      const waiting = snap.waits?.some((w) => w.at && w.at.uri === d.uri && w.at.span.start.line === d.span.start.line);
      if (!here && !waiting) continue;
      const site = [...snap.process.path].reverse().find((s) => s.site.uri === uri);
      if (site) return site.site.span;
    }
  }
  return undefined;
}

/** Keep a range inside the document (the report may be a little older than the buffer). */
function clampRange(doc: TextDocument, range: Range): Range {
  const last = Math.max(doc.lineCount - 1, 0);
  const clamp = (p: Position): Position => {
    const line = Math.min(Math.max(p.line, 0), last);
    return Position.create(line, Math.min(Math.max(p.character, 0), lineText(doc, line).length));
  };
  return Range.create(clamp(range.start), clamp(range.end));
}

/** FDR diagnostics still valid for the document: every target's latest check of this exact version, each said once. */
function fdrDiagnosticsFor(doc: TextDocument): Diagnostic[] {
  const perTarget = fdrOutcomes.get(doc.uri);
  if (!perTarget) return [];
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const outcome of perTarget.values()) {
    if (outcome.version !== doc.version) continue;
    for (const d of outcome.diagnostics) {
      const key = `${d.range.start.line}:${d.range.start.character}:${d.code}:${d.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(d);
    }
  }
  return out;
}

/** A short hash of a text, to tell whether a file the model was translated from has changed since. */
function textHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** What the translator would read for a file now: its open buffer, else the file on disk. */
function currentText(file: string): string | undefined {
  const open = documentForPath(file);
  if (open) return open.getText();
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Forget FDR results whose model was translated from `file` (an imported
 * file) when what the translator would read there now differs: the importer's
 * own text is unchanged, but its model is not.
 */
function dropFdrOutcomesReading(file: string): void {
  const wanted = path.resolve(file);
  let now: string | undefined;
  let read = false;
  for (const [uri, perTarget] of fdrOutcomes) {
    let dropped = false;
    for (const [key, outcome] of perTarget) {
      const entry = outcome.imports.find((candidate) => path.resolve(candidate.file) === wanted);
      if (!entry) continue;
      if (!read) {
        now = currentText(wanted);
        read = true;
      }
      if (entry.hash === textHash(now ?? '')) continue;
      perTarget.delete(key);
      dropped = true;
    }
    if (!perTarget.size) fdrOutcomes.delete(uri);
    if (!dropped) continue;
    fdrReportChanged(uri);
    scheduleAnalysisDecorationRefresh();
    const doc = documents.get(uri);
    if (doc) {
      publishFdr(doc);
      schedulePublish(doc);
    }
  }
}

/** Forget FDR results once the buffer changes: they describe text that is gone. */
function dropStaleFdrOutcomes(doc: TextDocument): void {
  const perTarget = fdrOutcomes.get(doc.uri);
  if (!perTarget) return;
  let dropped = false;
  for (const [key, outcome] of perTarget) {
    if (outcome.version === doc.version) continue;
    perTarget.delete(key);
    dropped = true;
  }
  if (!perTarget.size) fdrOutcomes.delete(doc.uri);
  scheduleAnalysisDecorationRefresh();
  if (!dropped) return;
  fdrReportChanged(doc.uri);
  publishFdr(doc);
}

/**
 * The latest report of a document for its current text: the program's, or a
 * procedure's (`line`, the 0-based line of its name, picks an overload).
 */
connection.onRequest('processj/fdrReport', (params: { textDocument?: { uri?: string }; uri?: string; procedure?: string; line?: number }): VerificationReport | null => {
  const uri = params.textDocument?.uri ?? params.uri;
  const csp = uri ? cspmDocument(uri) : undefined;
  if (csp) return cspm.report(csp.uri, csp.version) ?? null;
  const doc = uri ? documents.get(uri) : undefined;
  const perTarget = uri ? fdrOutcomes.get(uri) : undefined;
  if (!doc || !perTarget) return null;
  const procedure = params.procedure === 'main' ? undefined : params.procedure;
  const wanted = (key: string): boolean => {
    if (!procedure) return key === 'program';
    if (typeof params.line === 'number') return key === `proc:${procedure}:${params.line}`;
    return key.startsWith(`proc:${procedure}:`);
  };
  const outcomes = [...perTarget.entries()].filter(([key, o]) => o.version === doc.version && wanted(key));
  return outcomes[0]?.[1].report ?? null;
});

// ---------------------------------------------------------------------------
// FDR on the graph: one report per version, the viewer on a result, state machines
// ---------------------------------------------------------------------------

/** The program first, then each procedure checked on its own, in source order. */
function targetOrder(key: string): number {
  return key === 'program' ? -1 : Number(key.slice(key.lastIndexOf(':') + 1)) || 0;
}

/** `the whole program`, `succ on its own`: what a target's checks are about. */
function targetText(key: string): string {
  const m = /^proc:(.+):\d+$/.exec(key);
  return m ? `${m[1]} on its own` : 'the whole program';
}

/**
 * What the graph shows of FDR's results for the document's current text:
 * every target's latest check of this version in one report, each check's id
 * prefixed with its target (`program/deadlock-free`, `proc:succ:11/terminates`),
 * so checking a procedure never hides the program's result, or the other way
 * round. Assumptions every target shares are said once; the others say whose.
 */
function combinedFdrReport(doc: TextDocument): VerificationReport | undefined {
  const outcomes = [...(fdrOutcomes.get(doc.uri) ?? [])].filter(([, outcome]) => outcome.version === doc.version).sort(([a], [b]) => targetOrder(a) - targetOrder(b));
  if (!outcomes.length) return undefined;
  const lists = outcomes.map(([, outcome]) => outcome.report.assumptions);
  const shared = lists[0].filter((assumption) => lists.every((list) => list.includes(assumption)));
  const assumptions = [...shared];
  for (const [key, outcome] of outcomes) {
    for (const assumption of outcome.report.assumptions) if (!shared.includes(assumption)) assumptions.push(`${targetText(key)}: ${assumption}`);
  }
  return {
    version: 1,
    producer: 'fdr',
    uri: doc.uri,
    documentVersion: doc.version,
    tool: outcomes[0][1].report.tool,
    assumptions,
    checks: outcomes.flatMap(([key, outcome]) => outcome.report.checks.map((check) => ({ ...check, id: `${key}/${check.id}` }))),
  };
}

/** Publish FDR's results for the document's current text to the graph, or take them back when none apply. */
function publishFdr(doc: TextDocument): void {
  const report = combinedFdrReport(doc);
  if (report) publishVerification(doc.uri, report);
  else verificationStore.clear(doc.uri, 'fdr');
}

/**
 * The check of a report to show first, the one its lens verdict is about: the
 * worst failure (an error, a warning, a partial deadlock), else deadlock
 * freedom. A failure that only informs (a server does not terminate) is not
 * shown first; its chip shows it on a click.
 */
function focusCheck(report: VerificationReport): CheckOutcome | undefined {
  const rank = (check: CheckOutcome): number => {
    if (check.status === 'failed' && check.severity === 'error') return 0;
    if (check.status === 'failed' && check.severity === 'warning') return 1;
    if (check.status === 'failed' && check.counterexample && isPartialDeadlock(check.counterexample)) return 2;
    return check.property === 'deadlock-free' ? 3 : 4;
  };
  return [...report.checks].sort((a, b) => rank(a) - rank(b))[0];
}

/** Whether a check left something for the graph to show (a result, not a timeout, an error or a skip). */
function hasResult(report: VerificationReport): boolean {
  return report.checks.some((check) => check.status === 'passed' || check.status === 'failed');
}

/** Whether a finished check opens the graph (fdrShowGraph; `onFailure`: a defect, a partial deadlock, a runtime error). */
function wantsGraph(report: VerificationReport): boolean {
  if (!report.checks.length || settings.fdrShowGraph === 'never') return false;
  if (settings.fdrShowGraph === 'always') return true;
  return report.checks.some((check) => check.status === 'failed' && !!check.counterexample && (check.severity !== 'info' || isPartialDeadlock(check.counterexample)));
}

/**
 * Show the graph on a result: in VS Code's own panel; in the page of this
 * document already open in a browser (it shows the result, or, in a
 * background tab, shows it when it is next looked at; no second tab opens);
 * else in a new page, live or a file. Where it is shown, or undefined when
 * nothing could be shown (the caller then opens the text report).
 */
async function showFdrGraph(doc: TextDocument, focus: ViewerFocus): Promise<string | undefined> {
  if (clientShowsGraphPanel) {
    void connection.sendNotification('processj/showGraph', { uri: doc.uri, focus });
    return 'panel';
  }
  const told = settings.liveViewer ? liveViewer.notify(doc.uri, focus) : false;
  if (told) {
    showMessage(MessageType.Info, told === 'shown' ? 'ProcessJ: the graph page open for this file now shows the result' : 'ProcessJ: the graph page open for this file (in a background tab or window) shows the result when you switch to it');
    return liveViewer.urlFor(doc.uri, focus);
  }
  const shown = await openViewer(doc, focus);
  return shown.opened ? shown.target : undefined;
}

/** A focus from a client (a command argument, a request): a check id and a process key, both plain strings. */
function focusOf(value: unknown): ViewerFocus | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { check, process } = value as { check?: unknown; process?: unknown };
  const focus: ViewerFocus = {};
  if (typeof check === 'string' && check.length <= 400) focus.check = check;
  if (typeof process === 'string' && process.length <= 4000) focus.process = process;
  return focus.check !== undefined || focus.process !== undefined ? focus : undefined;
}

/** A state machine request from a client: its target, machine and (optionally) check and process, as strings. */
function machineRequestOf(value: unknown): MachineRequest | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { target, ref, check, process } = value as Record<string, unknown>;
  if (typeof target !== 'string' || typeof ref !== 'string' || target.length > 400 || ref.length > 4000) return undefined;
  return { target, ref, ...(typeof check === 'string' && check.length <= 400 ? { check } : {}), ...(typeof process === 'string' && process.length <= 4000 ? { process } : {}) };
}

/** Translations made for state machines (when no FDR check of the version and target can lend its model), per document. */
const machineModels = new Map<string, { version: number; models: Map<string, CspModel | string> }>();
const machinesOfModel = new WeakMap<CspModel, CspMachine[]>();
const machineLayouts = new WeakMap<CspModel, Map<string, MachineLayout>>();

/**
 * The model a state machine comes from: the one FDR checked for this version
 * and target, so a counterexample's states are exactly its states, else a
 * translation of the target, kept for the version. A string says why there is none.
 */
function machineModel(doc: TextDocument, target: string): { model: CspModel; checked: boolean } | string {
  const outcome = fdrOutcomes.get(doc.uri)?.get(target);
  if (outcome && outcome.version === doc.version) return { model: outcome.model, checked: true };
  let cache = machineModels.get(doc.uri);
  if (!cache || cache.version !== doc.version) machineModels.set(doc.uri, (cache = { version: doc.version, models: new Map() }));
  let model = cache.models.get(target);
  if (model === undefined) {
    model = translateForMachines(doc, target);
    cache.models.set(target, model);
  }
  return typeof model === 'string' ? model : { model, checked: false };
}

/**
 * Above this many processes the whole program is not translated just to draw
 * a state machine (it runs on the server's thread, and grows quickly with the
 * network): a procedure's own machine then comes from its model on its own.
 */
const MACHINE_PROCESS_BUDGET = 400;

function translateForMachines(doc: TextDocument, target: string): CspModel | string {
  const parsed = parsedFor(doc);
  if (parsed.errors.length) return `the file has a syntax error (line ${parsed.errors[0].line + 1}: ${parsed.errors[0].message})`;
  const procedure = /^proc:(.+):(\d+)$/.exec(target);
  const chosen = target === 'program' ? cspTarget(doc, undefined, undefined) : procedure ? cspTarget(doc, procedure[1], Number(procedure[2])) : `there is no model called ${target}`;
  if (typeof chosen === 'string') return chosen;
  if (target === 'program') {
    const processes = graphs.programProcesses(graphDocument(doc))?.count ?? 0;
    if (processes > MACHINE_PROCESS_BUDGET) return `the program has ${processes.toLocaleString('en-US')} processes, more than the ${MACHINE_PROCESS_BUDGET} it is translated with just to draw a state machine (Check with FDR translates it, and then shows every process's machine)`;
  }
  try {
    return translateTarget(doc, chosen).model;
  } catch (error) {
    connection.console.error(`translation for the state machines of ${doc.uri} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    return `the translation to CSP failed (${error instanceof Error ? error.message : String(error)})`;
  }
}

/**
 * One state machine for the viewer: the machine of `request.ref` in the model
 * of `request.target`, laid out, and with a check and a process of the
 * published FDR report, that process's states along the counterexample.
 */
async function stateMachine(uri: string, request: MachineRequest): Promise<ViewerMachine | ViewerMachineError | undefined> {
  const doc = documents.get(uri);
  if (!doc) return undefined;
  const key = machineRequestKey(request);
  let found = machineModel(doc, request.target);
  let target = request.target;
  const notes: string[] = [];
  // A procedure's own thread runs the same code in a model of that procedure on its own (machineRef: no region).
  const own = /^([^@|]+)@[^|]*#(\d+):\d+$/.exec(request.ref);
  if (typeof found === 'string' && request.target === 'program' && own) {
    const alone = machineModel(doc, `proc:${own[1]}:${own[2]}`);
    if (typeof alone !== 'string') {
      notes.push(`This is ${own[1]}'s machine in a model of ${own[1]} on its own: ${found}.`);
      found = alone;
      target = `proc:${own[1]}:${own[2]}`;
    }
  }
  if (typeof found === 'string') return { key, error: `No state machine: ${found}.` };
  const { model, checked } = found;
  let machines = machinesOfModel.get(model);
  if (!machines) machinesOfModel.set(model, (machines = stateMachines(model)));
  const machine = machines.find((entry) => refOfMachine(entry) === request.ref);
  const incomplete = model.unsupported.length ? `the model is incomplete (${model.unsupported[0].message}${model.unsupported.length > 1 ? `, and ${model.unsupported.length - 1} more` : ''})` : undefined;
  if (!machine) return { key, error: `No state machine for this process${incomplete ? `: ${incomplete}` : ': the model does not run it'}.` };
  const tooLarge = layoutSizeProblem(machine.states.length + 1, machine.transitions.length + 1);
  if (tooLarge) return { key, error: `This state machine is too large to draw: ${tooLarge}.` };
  let layouts = machineLayouts.get(model);
  if (!layouts) machineLayouts.set(model, (layouts = new Map()));
  let layout = layouts.get(machine.key);
  if (!layout) layouts.set(machine.key, (layout = await layoutMachine(machine)));
  // The process's run: its snapshot in the published report, about this very model.
  const report = checked && request.check !== undefined && request.process !== undefined ? verificationStore.get(uri).find((entry) => entry.producer === 'fdr' && entry.documentVersion === doc.version) : undefined;
  // A run is in the model it was found in: none for a machine from another model.
  const check = target === request.target ? report?.checks.find((entry) => entry.id === request.check && entry.id.startsWith(`${request.target}/`)) : undefined;
  const snapshot = check?.counterexample?.final.find((entry) => pathKey(entry.process.path) === request.process);
  const what = targetText(target);
  return buildViewerMachine({
    request,
    machine,
    machines,
    layout,
    model: checked ? `the model FDR checked (${what})` : `the CSP model of ${what}`,
    trail: snapshot?.trail,
    process: snapshot ? { label: snapshot.process.name ?? snapshot.process.label, status: snapshot.status, description: snapshot.description, waits: (snapshot.waits ?? []).map((wait) => wait.detail) } : undefined,
    notes: [...notes, ...(incomplete ? [`Not checked by FDR: ${incomplete}.`] : [])],
  });
}

/**
 * Hover on a statement FDR found stuck (or failing): what happens there, in a
 * sentence or two, and the steps of the counterexample that led to it.
 */
function fdrHover(doc: TextDocument, position: Position): string | undefined {
  const report = verificationStore.get(doc.uri).find((entry) => entry.producer === 'fdr' && entry.documentVersion === doc.version);
  if (!report) return undefined;
  const here = (ref: SourceRef | undefined): boolean => !!ref && ref.uri === doc.uri && containsPosition(ref.span, position);
  const size = (ref: SourceRef): number => (ref.span.end.line - ref.span.start.line) * 10_000 + ref.span.end.col - ref.span.start.col;
  /**
   * Where a stuck process is under the cursor, the smallest such place. A
   * process waiting at its par is at the whole par statement: it is told on
   * the par's first line, not on every statement of its branches.
   */
  const placeOf = (snap: ProcessSnapshot): SourceRef | undefined => {
    const waits = snap.waits ?? [];
    const atPar = waits.length > 0 && waits.every((wait) => wait.operation === 'other');
    const places = [snap.at, ...waits.map((wait) => wait.at)].filter((ref): ref is SourceRef => !!ref && (atPar ? ref.uri === doc.uri && ref.span.start.line === position.line : here(ref)));
    return places.sort((a, b) => size(a) - size(b))[0];
  };
  const parts: string[] = [];
  // Defects first; a run that never ends is told only where it leaves something waiting for good.
  const checks = report.checks.filter((check) => check.status === 'failed' && check.counterexample && (check.severity !== 'info' || isPartialDeadlock(check.counterexample)));
  for (const check of checks) {
    const cx = check.counterexample!;
    // The process whose own statement is under the cursor first; one whose place merely contains it is not told.
    const placed = cx.final.filter((snap) => snap.status === 'blocked' || snap.status === 'error').map((snap) => ({ snap, at: placeOf(snap) })).filter((entry): entry is { snap: ProcessSnapshot; at: SourceRef } => !!entry.at).sort((a, b) => size(a.at) - size(b.at));
    const stuck = placed.filter((entry) => size(entry.at) === size(placed[0].at) && entry.at.span.start.line === placed[0].at.span.start.line).map((entry) => entry.snap);
    const error = cx.error && here(cx.error.at) ? cx.error : undefined;
    if (!stuck.length && !error) continue;
    const target = targetText(check.id.slice(0, check.id.lastIndexOf('/')));
    const lines = [`**FDR · ${check.label}** (${target}): ${cx.summary.split(': ')[0]}`, ''];
    if (error) lines.push(`${error.message}.`);
    // One process told in full; others stuck at the same statement (a procedure several processes run) named after it.
    const [first, ...others] = stuck;
    if (first) {
      const wait = (first.waits ?? []).find((entry) => here(entry.at)) ?? first.waits?.[0];
      const why = wait?.partner ? `: ${wait.partner.detail}` : '';
      const circle = cx.cycles?.find((cycle) => cycle.length > 1 && cycle.some((member) => samePathKey(member.process.path, first.process.path)));
      // In a run that repeats forever, one the run only leaves waiting is not stuck for good.
      const how = others.every((snap) => snap.status !== 'blocked' || stuckForGood(snap, cx)) ? 'stuck' : 'left waiting';
      const too = others.length ? ` ${listNames(others.map((snap) => snap.process.name ?? snap.process.label))} ${others.length === 1 ? 'is' : 'are'} ${how} here too.` : '';
      lines.push(`${first.description}${why}.${circle ? ` It is one of the ${circle.length} processes of a circular wait.` : ''}${too}`);
    }
    // What the run relies on that the real program may not do.
    for (const caveat of cx.caveats ?? []) lines.push('', `**Caveat:** ${caveat}.`);
    // The steps the process took itself, the last few; else the last steps of the run.
    const mine = cx.steps.filter((step) => step.kind !== 'internal' && step.participants.some((part) => stuck.some((snap) => samePathKey(snap.process.path, part.process.path))));
    const shown = (mine.length ? mine : cx.steps).slice(-4);
    if (shown.length) {
      lines.push('', `How it gets here (${cx.steps.length} step${cx.steps.length === 1 ? '' : 's'} in all):`, '');
      for (const step of shown) lines.push(`${step.index + 1}. ${step.description}`);
    }
    lines.push('', '_The code action Show in graph opens the process network at this process._');
    parts.push(lines.join('\n'));
    if (parts.length >= 2) break;
  }
  return parts.length ? parts.join('\n\n---\n\n') : undefined;
}

function samePathKey(a: Parameters<typeof pathKey>[0], b: Parameters<typeof pathKey>[0]): boolean {
  return pathKey(a) === pathKey(b);
}

function listNames(names: string[]): string {
  return names.length > 3 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} more` : names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] ?? '';
}

connection.onShutdown(async () => {
  cspm.dispose();
  await liveViewer.close();
  compilerQueue.dispose();
  for (const controller of fdrRuns.values()) controller.abort();
  fdrRuns.clear();
  for (const controller of runControllers.values()) controller.abort();
  runControllers.clear();
  killAllChildren();
  // The compiler runs just stopped would remove their sandboxes in the background; a client may
  // kill the server right after this reply, so they go now, with the report directory.
  removeAllPrivateDirs();
  runsDir = undefined;
  workspace.stopPolling();
  for (const timer of lintPending.values()) clearTimeout(timer);
  lintPending.clear();
  if (analysisDecorationRefresh) {
    clearTimeout(analysisDecorationRefresh);
    analysisDecorationRefresh = undefined;
  }
});

/**
 * Tell the user something that needs no answer, as a `window/showMessage`
 * notification. `connection.window.show*Message` sends `window/showMessageRequest`
 * instead: eglot prompts for that, and Emacs 31.1's eglot cannot send its reply
 * to one without actions, which leaves every later synchronous request (the
 * graph and run commands) waiting forever.
 */
function showMessage(type: MessageType, message: string): void {
  void connection.sendNotification(ShowMessageNotification.type, { type, message });
}

/** Write text to a stable per-file path under the temp dir and ask the editor to open it. */
async function showReport(name: string, content: string): Promise<string> {
  const target = writeReport(name, content);
  await openInEditor(target, content);
  return target;
}

/** Write text to a stable per-file path under the private report directory and return its path. */
function writeReport(name: string, content: string): string {
  // Removed at shutdown, or when the server exits without one (makePrivateDir).
  if (!runsDir || !fs.existsSync(runsDir)) runsDir = makePrivateDir('processj-lsp-runs-');
  const target = path.join(runsDir, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

async function openInEditor(file: string, content: string): Promise<void> {
  if (clientSupportsShowDocument) {
    await connection.window.showDocument({ uri: pathToFileURL(file).toString(), external: false, takeFocus: true });
  } else {
    connection.console.log(content);
  }
}

/**
 * The concurrency graph in the form asked for. The viewer is served live (it
 * follows edits and new results) when the client can open a URL, and written to
 * the report directory otherwise. With a focus (an FDR result: its code lens,
 * its diagnostics' Show in graph), the viewer opens on that result, in a page
 * already open for the document when there is one.
 */
/** What the graph commands draw for a document: its ProcessJ network, or a CSPm file's (src/cspm). */
interface GraphTarget {
  drawable(): boolean;
  render(format: GraphFormat, options?: { nonce?: string; focus?: ViewerFocus }): Promise<string>;
  /** File name stem of exports: `commstime` for commstime.pj, `dining.csp` for dining.csp. */
  stem: string;
  /** Why there is nothing to draw. */
  empty: string;
}

function graphTarget(doc: TextDocument): GraphTarget {
  if (isCspmDocument(doc)) {
    return { drawable: () => cspm.drawable(doc), render: (format, options) => cspm.render(doc, format, options), stem: path.basename(safeFileUri(doc.uri) ?? 'buffer.csp'), empty: 'this file defines no process yet, so there is no network to draw' };
  }
  const graph = graphDocument(doc);
  return { drawable: () => graphs.drawable(graph), render: (format, options) => graphs.render(graph, format, options), stem: path.basename(safeFileUri(doc.uri) ?? 'buffer.pj', '.pj'), empty: 'this file has no procedure with a body yet, so there is no network to draw' };
}

async function showGraph(doc: TextDocument, mode: string, reportName: (suffix: string) => string, focus?: ViewerFocus): Promise<string | null> {
  const graph = graphTarget(doc);
  if (mode !== 'viewer' && mode !== 'markdown' && mode !== 'svg' && mode !== 'excalidraw') throw new ResponseError(ErrorCodes.InvalidParams, `Unknown graph mode '${mode}': use viewer, markdown, svg or excalidraw`);
  if ((mode === 'svg' || mode === 'excalidraw') && !graph.drawable()) {
    showMessage(MessageType.Info, `ProcessJ: ${graph.empty}.`);
    return null;
  }
  switch (mode) {
    case 'markdown':
      return showReport(reportName('concurrency.pjreport'), await graph.render('markdown'));
    case 'svg': {
      const target = writeReport(reportName('graph.svg'), await graph.render('svg'));
      await openFile(target, 'the SVG');
      return target;
    }
    case 'excalidraw': {
      // A scene is for editing in Excalidraw: it goes next to the source, not into the temporary report directory.
      if (safeFileUri(doc.uri)) {
        const { written, refused } = await exportGraph(doc, 'excalidraw', undefined, false);
        if (written.length) showMessage(MessageType.Info, `ProcessJ: Excalidraw scene written to ${written[0]}. Open it in Excalidraw (File > Open, or drop it on excalidraw.com) to edit the drawing.`);
        return written[0] ?? refused[0] ?? null;
      }
      const target = writeReport(reportName('graph.excalidraw'), await graph.render('excalidraw'));
      showMessage(MessageType.Info, `ProcessJ: this buffer has no file, so the Excalidraw scene is in a temporary folder that is removed when the server stops: ${target}. Save the file, or use the export command with a directory, to keep it.`);
      return target;
    }
    case 'viewer':
      break;
  }
  if (focus) return (await showFdrGraph(doc, focus)) ?? null;
  return (await openViewer(doc, undefined, reportName)).target;
}

/** Open the viewer page on `focus`: live when it can be, else a file. Whether the client opened it, and where it is. */
async function openViewer(doc: TextDocument, focus?: ViewerFocus, reportName = (suffix: string): string => scopedReportName(doc.uri, `${graphTarget(doc).stem}.${suffix}`)): Promise<{ target: string; opened: boolean }> {
  if (settings.liveViewer && clientSupportsShowDocument) {
    try {
      const url = await liveViewer.urlFor(doc.uri, focus);
      const shown = await connection.window.showDocument({ uri: url, external: true });
      if (shown.success) return { target: url, opened: true };
      connection.console.warn('The client did not open the live graph viewer; writing it to a file instead.');
    } catch (error) {
      connection.console.warn(`The live graph viewer is unavailable (${error instanceof Error ? error.message : String(error)}); writing it to a file instead.`);
    }
  }
  const target = writeReport(reportName('graph.html'), await graphTarget(doc).render('html', { focus }));
  connection.console.info(`Graph viewer written to ${target}`);
  return { target, opened: await openFile(target, 'the graph viewer') };
}

/** Open a generated file with the system's default application, or say where it is. Whether it was opened. */
async function openFile(target: string, what: string): Promise<boolean> {
  if (clientSupportsShowDocument) {
    try {
      const shown = await connection.window.showDocument({ uri: pathToFileURL(target).toString(), external: true });
      if (shown.success) return true;
    } catch {
      /* say where it is instead */
    }
  }
  showMessage(MessageType.Info, `ProcessJ: open ${target} to see ${what}.`);
  return false;
}

/**
 * Write the graph next to the source (or into `directory`): `<stem>.graph.svg`,
 * `.excalidraw`, `.html`, `.json`. A file that exists but was not written by
 * this server is never overwritten.
 */
async function exportGraph(doc: TextDocument, format: string, directory: string | undefined, announce = true): Promise<{ written: string[]; refused: string[]; skipped: string[] }> {
  // Own keys only: `toString` or `__proto__` are not formats.
  const formats: ExportFormat[] = format === 'all' ? [...ALL_FORMATS] : isExportFormat(format) ? [format] : [];
  if (!formats.length) throw new ResponseError(ErrorCodes.InvalidParams, `Unknown export format '${format}': use all (svg, excalidraw and html), svg, excalidraw, html or json`);
  const sourcePath = safeFileUri(doc.uri);
  const base = sourcePath ? path.dirname(sourcePath) : undefined;
  if (directory && !base && !path.isAbsolute(directory)) throw new ResponseError(ErrorCodes.InvalidParams, 'This buffer has no file: give an absolute directory to export into');
  // A relative directory is relative to the source file's folder.
  const target = directory ? path.resolve(base!, directory) : base;
  if (!target) throw new ResponseError(ErrorCodes.InvalidParams, 'Save the file first, or give a directory to export into');
  const graph = graphTarget(doc);
  const stem = graph.stem;
  const written: string[] = [];
  const refused: string[] = [];
  const skipped: string[] = [];
  fs.mkdirSync(target, { recursive: true });
  for (const entry of formats) {
    // Nothing to draw (no procedure with a body yet): the pictures are skipped, the page and data still written.
    if ((entry === 'svg' || entry === 'excalidraw') && !graph.drawable()) {
      skipped.push(entry);
      continue;
    }
    const file = path.join(target, `${stem}${FORMAT_EXTENSIONS[entry]}`);
    if (fs.existsSync(file) && !generatedByUs(file, entry)) {
      refused.push(file);
      continue;
    }
    // Checked again as it is written, without following a link put there meanwhile.
    const outcome = writeGeneratedFile(file, await graph.render(entry), (head) => GENERATOR_MARKERS[entry].test(head));
    if (outcome.written) written.push(file);
    else refused.push(file);
  }
  if (written.length && announce) showMessage(MessageType.Info, `ProcessJ: wrote ${written.join(', ')}`);
  if (skipped.length) showMessage(MessageType.Info, `ProcessJ: no ${skipped.join(' or ')} written: ${graph.empty}.`);
  if (refused.length) showMessage(MessageType.Warning, `ProcessJ: did not overwrite ${refused.join(', ')}: ${refused.length === 1 ? 'it was' : 'they were'} not written by processj-lsp. Move ${refused.length === 1 ? 'it' : 'them'} away or export into another directory.`);
  return { written, refused, skipped };
}

/** Whether an existing export is a regular file (not a link) carrying the marker this server writes. */
function generatedByUs(file: string, format: ExportFormat): boolean {
  return isGeneratedFile(file, (head) => GENERATOR_MARKERS[format].test(head));
}

/** Same-basename files keep readable report names without sharing a report tab. */
function scopedReportName(uri: string, name: string): string {
  const documentKey = createHash('sha256').update(uri).digest('hex').slice(0, 16);
  return path.join(documentKey, name);
}

// ---------------------------------------------------------------------------
// Symbols, completion, hover, definition, references, rename, signature help
// ---------------------------------------------------------------------------

function parsedFor(doc: TextDocument): ParseResult {
  const cached = parseCache.get(doc.uri);
  if (cached && cached.version === doc.version) return cached.parsed;
  const parsed = parse(doc.getText());
  parseCache.set(doc.uri, { version: doc.version, parsed });
  return parsed;
}

function symbolsFor(doc: TextDocument): { symbols: PJSymbol[]; locals: PJSymbol[] } {
  const cached = symbolCache.get(doc.uri);
  if (cached && cached.version === doc.version) return cached;
  const parsed = parsedFor(doc);
  const { symbols, locals } = astSymbols(parsed);
  if (parsed.errors.length > 0) {
    // While the file is mid-edit the tree may be missing pieces; top up from the tolerant regex scan.
    const text = doc.getText();
    const have = new Set([...symbols, ...locals].map((s) => `${s.kind}|${s.name}|${s.line}`));
    for (const s of extractSymbols(text)) if (!have.has(`${s.kind}|${s.name}|${s.line}`)) symbols.push(s);
    for (const l of extractLocals(text, symbols)) if (!have.has(`${l.kind}|${l.name}|${l.line}`)) locals.push(l);
  }
  const entry = { version: doc.version, symbols, locals };
  symbolCache.set(doc.uri, entry);
  return entry;
}

// ---------------------------------------------------------------------------
// Formatting and folding (AST based)
// ---------------------------------------------------------------------------

connection.onDocumentFormatting((params: DocumentFormattingParams): TextEdit[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const indent = params.options.insertSpaces === false ? '\t' : ' '.repeat(params.options.tabSize || 4);
  const result = format(doc.getText(), { indent });
  if (!result.text) {
    const n = result.errors.length;
    showMessage(MessageType.Warning, `ProcessJ: not formatted, fix ${n} syntax error${n === 1 ? '' : 's'} first (line ${result.errors[0].line + 1}: ${result.errors[0].message})`);
    return [];
  }
  if (result.text === doc.getText()) return [];
  const end = doc.positionAt(doc.getText().length);
  return [TextEdit.replace(Range.create(Position.create(0, 0), end), result.text)];
});

connection.onFoldingRanges((params: FoldingRangeParams): FoldingRange[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const parsed = parsedFor(doc);
  const out: FoldingRange[] = [];
  const add = (span: A.Span, kind?: FoldingRangeKind) => {
    if (span.end.line > span.start.line) out.push({ startLine: span.start.line, endLine: span.end.line - 1 >= span.start.line ? span.end.line - 1 : span.end.line, kind });
  };
  for (const c of parsed.comments) if (c.kind === 'block') add({ start: { line: c.line, col: c.col }, end: { line: c.endLine + 1, col: 0 } }, FoldingRangeKind.Comment);
  const stmt = (s: A.Stmt): void => {
    switch (s.kind) {
      case 'Block':
        add(s.span);
        s.stmts.forEach(stmt);
        return;
      case 'ParBlock':
      case 'SeqBlock':
        add(s.span);
        s.body.stmts.forEach(stmt);
        return;
      case 'IfStmt':
        stmt(s.then);
        if (s.else) stmt(s.else);
        return;
      case 'WhileStmt':
      case 'DoStmt':
      case 'ForStmt':
      case 'ClaimStmt':
        stmt(s.body);
        return;
      case 'SwitchStmt':
        add(s.span);
        for (const g of s.groups) g.stmts.forEach(stmt);
        return;
      case 'AltStmt':
        add(s.span);
        for (const c of s.cases) {
          if (c.nested) stmt(c.nested);
          if (c.body) stmt(c.body);
        }
        return;
      case 'LabeledStmt':
        stmt(s.stmt);
        return;
      default:
        return;
    }
  };
  for (const d of parsed.program.decls) {
    add(d.span);
    if (d.kind === 'ProcDecl' && d.body) d.body.stmts.forEach(stmt);
  }
  if (parsed.program.imports.length > 1) {
    const first = parsed.program.imports[0].span;
    const last = parsed.program.imports[parsed.program.imports.length - 1].span;
    add({ start: first.start, end: { line: last.end.line + 1, col: 0 } }, FoldingRangeKind.Imports);
  }
  return out;
});

connection.onDocumentSymbol((params: DocumentSymbolParams): DocumentSymbol[] | SymbolInformation[] => {
  const csp = cspmDocument(params.textDocument.uri);
  if (csp) {
    const symbols = cspm.symbols(csp);
    return clientSupportsHierarchicalSymbols ? symbols : symbols.map((symbol) => ({ name: symbol.name, kind: symbol.kind, location: Location.create(csp.uri, symbol.selectionRange) }));
  }
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const { symbols } = symbolsFor(doc);
  if (clientSupportsHierarchicalSymbols) return symbols.map((s) => toDocumentSymbol(doc, s));
  // A client without hierarchical support would show nothing for a DocumentSymbol tree.
  const flat: SymbolInformation[] = [];
  const add = (s: PJSymbol, container?: string) => {
    flat.push({ name: s.name, kind: symbolKind(s), location: Location.create(doc.uri, Range.create(s.line, s.startCol, s.line, s.endCol)), containerName: container ?? s.container });
    for (const child of s.children ?? []) add(child, s.name);
  };
  for (const s of symbols) add(s);
  return flat;
});

/** Binding-aware highlights in the active document. */
connection.onDocumentHighlight((params: DocumentHighlightParams): DocumentHighlight[] | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const resolved = resolve(doc, params.position);
  if (!resolved || resolved.hits.length === 0 || !resolved.hits[0].exact) return null;
  const hit = resolved.hits[0];
  if (hit.variable) {
    return variableSpans(checkFor(doc).checked, hit.variable).map((span, index) => ({
      range: rangeFor(span),
      kind: index === 0 ? DocumentHighlightKind.Write : DocumentHighlightKind.Text,
    }));
  }

  // Top-level highlighting follows the same exact overload/type/constant
  // identity as references and rename, but stays document-local and therefore
  // never pays for a workspace scan on cursor movement.
  if (hit.symbol.kind === 'field' || hit.symbol.kind === 'case' || hit.symbol.detail.startsWith('extern ')) return null;
  const analysis = checkFor(doc);
  const program = parsedFor(doc).program;
  const targetFile = safeFileUri(hit.uri);
  let spans: A.Span[] = [];
  if (hit.symbol.kind === 'proc') {
    if (!hit.procedure) return null;
    if (hit.uri === doc.uri) spans.push(hit.procedure.decl.name.span);
    spans.push(...procedureReferenceSpans(program, analysis, resolved.word, targetFile, hit.uri, doc.uri, hit.procedure));
  } else if (hit.symbol.kind === 'record' || hit.symbol.kind === 'protocol') {
    const boundFile = indexedBindingFile(analysis, hit.symbol.kind, resolved.word);
    if (!(hit.uri === doc.uri || (targetFile && sameFile(boundFile, targetFile)))) return null;
    if (hit.uri === doc.uri) spans.push(...declarationSpans(program, resolved.word, hit.symbol.kind));
    spans.push(...namedTypeSpans(program, resolved.word));
  } else if (hit.symbol.kind === 'const') {
    const boundFile = indexedBindingFile(analysis, hit.symbol.kind, resolved.word);
    if (!(hit.uri === doc.uri || (targetFile && sameFile(boundFile, targetFile)))) return null;
    if (hit.uri === doc.uri) spans.push(...declarationSpans(program, resolved.word, hit.symbol.kind));
    spans.push(...constantReferenceSpans(analysis, resolved.word));
  } else {
    return null;
  }
  const seen = new Set<string>();
  return spans
    .sort((a, b) => a.start.line - b.start.line || a.start.col - b.start.col)
    .filter((span) => {
      const key = `${span.start.line}:${span.start.col}:${span.end.line}:${span.end.col}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((span) => ({ range: rangeFor(span), kind: DocumentHighlightKind.Text }));
});

connection.onWorkspaceSymbol((params: WorkspaceSymbolParams) => {
  const query = params.query.trim().toLowerCase();
  const candidates: Array<{ score: number; symbol: PJSymbol; uri: string }> = [];
  const openPaths = new Set(documents.all().map((doc) => safeFileUri(doc.uri)).filter((file): file is string => !!file).map((file) => path.resolve(file)));
  const add = (symbol: PJSymbol, uri: string) => {
    const score = symbolMatchScore(query, symbol.name, symbol.detail);
    if (score >= 0) candidates.push({ score, symbol, uri });
    for (const child of symbol.children ?? []) add(child, uri);
  };
  for (const { file, symbol } of workspace.all()) {
    if (!openPaths.has(path.resolve(file))) add(symbol, pathToFileURL(file).toString());
  }
  for (const doc of documents.all()) for (const symbol of symbolsFor(doc).symbols) add(symbol, doc.uri);
  candidates.sort((a, b) => b.score - a.score || a.symbol.name.localeCompare(b.symbol.name) || a.uri.localeCompare(b.uri));
  return candidates.slice(0, 200).map(({ symbol, uri }) => ({
    name: symbol.name,
    kind: symbolKind(symbol),
    location: Location.create(uri, Range.create(symbol.line, symbol.startCol, symbol.line, symbol.endCol)),
    containerName: symbol.container,
  }));
});

/** Prefixes rank first, then word fragments, then ordered fuzzy matches. */
function symbolMatchScore(query: string, name: string, detail: string): number {
  if (!query) return 0;
  const candidate = name.toLowerCase();
  if (candidate === query) return 1000;
  if (candidate.startsWith(query)) return 800 - (candidate.length - query.length);
  const at = candidate.indexOf(query);
  if (at >= 0) return 600 - at;
  if (detail.toLowerCase().includes(query)) return 300;
  let qi = 0;
  let gap = 0;
  for (let i = 0; i < candidate.length && qi < query.length; i++) {
    if (candidate[i] === query[qi]) qi++;
    else if (qi > 0) gap++;
  }
  return qi === query.length ? 400 - gap : -1;
}

function toDocumentSymbol(doc: TextDocument, s: PJSymbol): DocumentSymbol {
  const endLine = Math.min(s.endLine, doc.lineCount - 1);
  return {
    name: s.name,
    detail: s.detail,
    kind: symbolKind(s),
    range: Range.create(s.line, 0, endLine, lineText(doc, endLine).length),
    selectionRange: Range.create(s.line, s.startCol, s.line, s.endCol),
    children: (s.children ?? []).map((c) => toDocumentSymbol(doc, c)),
  };
}

function symbolKind(s: PJSymbol): SymbolKind {
  switch (s.kind) {
    case 'proc': return SymbolKind.Function;
    case 'record': return SymbolKind.Struct;
    case 'protocol': return SymbolKind.Enum;
    case 'case': return SymbolKind.EnumMember;
    case 'const': return SymbolKind.Constant;
    case 'field': return SymbolKind.Field;
    default: return SymbolKind.Variable;
  }
}

const MEMBER_COMPLETIONS: Array<[string, string, string]> = [
  ['read()', 'read()', 'Read a value from the channel (blocks until a writer arrives)'],
  ['write(...)', 'write($0)', 'Write a value to the channel (blocks until a reader arrives)'],
  ['read', 'read', 'The reading end of this channel'],
  ['write', 'write', 'The writing end of this channel'],
  ['sync()', 'sync()', 'Wait on this barrier until every enrolled process has synced'],
  ['resign()', 'resign()', 'Resign from this barrier'],
];

const SNIPPETS: Array<[string, string, string]> = [
  ['par', 'par {\n\t$0\n}', 'Run statements in parallel'],
  ['par enroll', 'par enroll(${1:barrier}) {\n\t$0\n}', 'Parallel block enrolled on a barrier'],
  ['par for', 'par for (int ${1:i} = 0; $1 < ${2:n}; $1++) {\n\t$0\n}', 'Replicated parallel loop'],
  ['alt', 'alt {\n\t${1:v} = ${2:in}.read() : { $0 }\n}', 'Wait on several guards'],
  ['pri alt', 'pri alt {\n\t${1:v} = ${2:in}.read() : { $0 }\n\tskip : { }\n}', 'Prioritised alt'],
  ['chan', 'chan<${1:int}> ${2:c};', 'Declare a channel'],
  ['proc', 'public void ${1:name}(${2}) {\n\t$0\n}', 'Declare a procedure'],
  ['main', 'public void main(string[] args) {\n\t$0\n}', 'Program entry point'],
  ['record', 'record ${1:Name} {\n\t${2:int} ${3:field};\n}', 'Declare a record'],
  ['protocol', 'protocol ${1:Name} {\n\t${2:tag} : { ${3:int} ${4:field}; }\n}', 'Declare a protocol'],
  ['timer', 'timer ${1:t};\n$1.timeout($1.read() + ${2:1000});', 'Declare a timer and wait (the argument is an absolute deadline)'],
  ['while', 'while (${1:cond}) {\n\t$0\n}', 'While loop'],
  ['for', 'for (int ${1:i} = 0; $1 < ${2:n}; $1++) {\n\t$0\n}', 'For loop'],
  ['if', 'if (${1:cond}) {\n\t$0\n}', 'If statement'],
  ['switch', 'switch (${1:value}) {\n\tcase ${2:x}: {\n\t\t$0\n\t}\n}', 'Switch statement'],
  ['import std', 'import std.*;', 'Import the standard library'],
];

connection.onCompletion((params: CompletionParams) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const line = lineText(doc, params.position.line);
  const before = line.slice(0, params.position.character);
  const prefix = /[A-Za-z0-9_$]*$/.exec(before)?.[0].toLowerCase() ?? '';
  const items: CompletionItem[] = [];

  // Member access: `c.` -> fields of a record, cases' fields of a protocol, or channel/timer/barrier operations.
  const dot = /\.\s*[A-Za-z0-9_$]*$/.exec(before);
  const receiverText = dot ? before.slice(0, dot.index).trimEnd() : '';
  if (dot && /[A-Za-z0-9_$)\]]$/.test(receiverText)) {
    const { checked, index } = checkFor(doc);
    // The checker has typed every expression, including `a[i]` and `f(x)`, so
    // the widest expression ending at the dot is the receiver.
    let t = receiverTypeAt(checked, params.position.line, receiverText.length);
    const chain = /([A-Za-z_$][A-Za-z0-9_$]*(?:\s*\.\s*[A-Za-z_$][A-Za-z0-9_$]*)*)$/.exec(receiverText);
    if (!t && chain) {
      // Mid-edit the tree may lack the receiver: fall back to the spelled chain.
      const [head, ...fields] = chain[1].split('.').map((part) => part.trim());
      const v = variableAt(checked, { line: params.position.line, character: chain.index })
        ?? visibleVariables(parsedFor(doc).program, checked, params.position).find((candidate) => candidate.name === head);
      t = v?.type ?? index.consts.get(head)?.type;
      for (const field of fields) {
        if (t?.k === 'record') t = index.recordFields(t.name).get(field);
        else if (t?.k === 'protocol') t = [...index.protocolCases(t.name).values()].map((caseFields) => caseFields.get(field)).find((ft) => ft);
        else t = undefined;
        if (!t) break;
      }
    }
    if (t?.k === 'record') {
      for (const [name, ft] of index.recordFields(t.name)) items.push({ label: name, kind: CompletionItemKind.Field, detail: `${typeStr(ft)} ${name}` });
      return items;
    }
    if (t?.k === 'protocol') {
      for (const [tag, fields] of index.protocolCases(t.name)) for (const [name, ft] of fields) items.push({ label: name, kind: CompletionItemKind.Field, detail: `${typeStr(ft)} ${name}  (case ${tag})` });
      return items;
    }
    if (t?.k === 'array') return [{ label: 'size', kind: CompletionItemKind.Property, detail: 'int: number of elements' }];
    if (t?.k === 'prim' && t.name === 'string') return [{ label: 'length', kind: CompletionItemKind.Property, detail: 'int: number of characters' }];
    if (t?.k === 'prim' && t.name === 'timer') {
      return [
        { label: 'read()', kind: CompletionItemKind.Method, insertText: 'read()', detail: 'long: read the timer clock in milliseconds' },
        { label: 'timeout(when)', kind: CompletionItemKind.Method, insertText: 'timeout($0)', insertTextFormat: InsertTextFormat.Snippet, detail: 'Wait until this absolute millisecond; for a delay write t.read() + ms' },
      ].map((item) => (clientSupportsSnippets ? item : plainTextItem(item)));
    }
    const wanted = t?.k === 'chan' ? (t.end === 'read' ? ['read()'] : t.end === 'write' ? ['write(...)'] : ['read()', 'write(...)', 'read', 'write']) : t?.k === 'prim' && t.name === 'barrier' ? ['sync()', 'resign()'] : undefined;
    if (!wanted) return [];
    for (const [label, insert, doc] of MEMBER_COMPLETIONS) {
      if (!wanted.includes(label)) continue;
      items.push({ label, kind: CompletionItemKind.Method, insertText: insert, insertTextFormat: InsertTextFormat.Snippet, detail: doc });
    }
    return clientSupportsSnippets ? items : items.map(plainTextItem);
  }

  const { symbols } = symbolsFor(doc);
  const seen = new Set<string>();
  const add = (item: CompletionItem): boolean => {
    const key = `${item.label}|${item.detail ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    items.push(item);
    return true;
  };

  const parsed = parsedFor(doc);
  const checked = checkFor(doc).checked;
  for (const v of visibleVariables(parsed.program, checked, params.position)) {
    const detail = `${v.isConst ? 'const ' : ''}${typeStr(v.type)} ${v.name}${v.isParam ? ' (parameter)' : ''}`;
    add({ label: v.name, kind: v.isConst ? CompletionItemKind.Constant : CompletionItemKind.Variable, detail });
  }
  for (const s of symbols) {
    add({ label: s.name, kind: completionKind(s), detail: s.detail, documentation: s.doc });
    for (const c of s.children ?? []) add({ label: c.name, kind: completionKind(c), detail: c.detail });
  }
  // Imported declarations (typed, from the checker's index), then the rest of the workspace for navigation-style completion.
  const { index, deps } = checkFor(doc);
  const ownNames = new Set(symbols.map((s) => s.name));
  for (const [name, sigs] of index.procs) {
    if (ownNames.has(name)) continue;
    for (const sig of sigs) add({ label: name, kind: CompletionItemKind.Function, detail: signatureStr(sig) + (sig.file ? `  (${path.basename(sig.file, '.pj')})` : '') });
  }
  for (const [name, r] of index.records) if (!ownNames.has(name)) add({ label: name, kind: CompletionItemKind.Struct, detail: `record ${name}` + (r.file ? `  (${path.basename(r.file, '.pj')})` : '') });
  for (const [name, pr] of index.protocols) if (!ownNames.has(name)) add({ label: name, kind: CompletionItemKind.Enum, detail: `protocol ${name}` + (pr.file ? `  (${path.basename(pr.file, '.pj')})` : '') });
  for (const [name, c] of index.consts) if (!ownNames.has(name)) add({ label: name, kind: CompletionItemKind.Constant, detail: `const ${typeStr(c.type)} ${name}` });
  const ownPath = safeFileUri(doc.uri);
  const openPaths = new Set<string>();
  const MAX_AUTO_IMPORTS = 200;
  let autoImports = 0;
  let isIncomplete = false;
  const offerWorkspaceSymbol = (file: string, symbol: PJSymbol) => {
    if (symbol.kind === 'proc' && symbol.name === 'main') return; // every program has one; never useful to complete
    if (prefix && !symbol.name.toLowerCase().startsWith(prefix)) return;
    if (deps.has(path.resolve(file))) return; // already offered above with its typed imported declaration
    if (autoImports >= MAX_AUTO_IMPORTS) {
      isIncomplete = true;
      return;
    }
    const importName = importNameFor(file);
    if (!importName) return;
    if (add({
      label: symbol.name,
      kind: completionKind(symbol),
      detail: `${symbol.detail}  (${importName})`,
      documentation: symbol.doc,
      additionalTextEdits: importName ? [addImportEdit(doc, parsed.program, importName)] : undefined,
      sortText: `y${symbol.name}`,
    })) autoImports++;
  };
  // Unsaved buffers overlay the workspace's on-disk cache.
  for (const open of documents.all()) {
    const file = safeFileUri(open.uri);
    if (!file || file === ownPath) continue;
    openPaths.add(path.resolve(file));
    for (const symbol of symbolsFor(open).symbols) offerWorkspaceSymbol(file, symbol);
  }
  const excludedFiles = new Set<string>([...openPaths, ...deps]);
  const workspaceMatches = workspace.completions(prefix, Math.max(0, MAX_AUTO_IMPORTS - autoImports), excludedFiles, ownPath);
  if (workspaceMatches.isIncomplete) isIncomplete = true;
  for (const { file, symbol } of workspaceMatches.items) offerWorkspaceSymbol(file, symbol);
  // Standard-library declarations are useful even before `std` is imported.
  // Selecting one inserts the narrow module import automatically.
  for (const symbol of library) {
    if (deps.has(path.resolve(symbol.file))) continue;
    if (prefix && !symbol.name.toLowerCase().startsWith(prefix)) continue;
    const importName = symbol.pkg ? `${symbol.pkg}.${symbol.module}` : symbol.module;
    add({
      label: symbol.name,
      kind: completionKind(symbol),
      detail: `${symbol.detail}  (${importName})`,
      documentation: symbol.doc,
      additionalTextEdits: [addImportEdit(doc, parsed.program, importName)],
      sortText: `x${symbol.name}`,
    });
  }
  for (const [label, insert, detail] of SNIPPETS) {
    add({ label, kind: CompletionItemKind.Snippet, insertText: insert, insertTextFormat: InsertTextFormat.Snippet, detail, sortText: `zz${label}` });
  }
  for (const k of KEYWORDS) add({ label: k, kind: CompletionItemKind.Keyword, documentation: KEYWORD_DOCS[k] ? { kind: MarkupKind.Markdown, value: KEYWORD_DOCS[k] } : undefined });
  for (const t of PRIMITIVE_TYPES) add({ label: t, kind: CompletionItemKind.TypeParameter });
  for (const l of LITERALS) add({ label: l, kind: CompletionItemKind.Constant });
  return { isIncomplete, items: clientSupportsSnippets ? items : items.map(plainTextItem) };
});

/** A client without snippet support would insert `$0` and `${1:name}` literally. */
function plainTextItem(item: CompletionItem): CompletionItem {
  if (item.insertTextFormat !== InsertTextFormat.Snippet) return item;
  const text = (item.insertText ?? item.label).replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\d+/g, '');
  return { ...item, insertText: text, insertTextFormat: InsertTextFormat.PlainText };
}

/** Type of the widest checked expression that ends exactly at `endCol` on `line`. */
function receiverTypeAt(checked: CheckResult, line: number, endCol: number): Type | undefined {
  let best: { start: number; type: Type } | undefined;
  for (const [expr, type] of typePositionIndex(checked).byLine.get(line) ?? []) {
    const span = expr.span;
    if (span.end.col !== endCol) continue;
    if (type.k === 'error' || type.k === 'unknown') continue;
    if (!best || span.start.col < best.start) best = { start: span.start.col, type };
  }
  return best?.type;
}

function completionKind(s: PJSymbol): CompletionItemKind {
  switch (s.kind) {
    case 'proc': return CompletionItemKind.Function;
    case 'record': return CompletionItemKind.Struct;
    case 'protocol': return CompletionItemKind.Enum;
    case 'case': return CompletionItemKind.EnumMember;
    case 'const': return CompletionItemKind.Constant;
    case 'field': return CompletionItemKind.Field;
    default: return CompletionItemKind.Variable;
  }
}

/** Import spelling for a workspace file, relative to its nearest workspace root. */
function importNameFor(file: string): string | undefined {
  const abs = path.resolve(file);
  const roots = workspace.getRoots()
    .filter((root) => abs === root || abs.startsWith(root + path.sep))
    .sort((a, b) => b.length - a.length);
  if (workspace.getRoots().length > 0 && roots.length === 0) return undefined;
  const relative = roots.length > 0 ? path.relative(roots[0], abs) : path.basename(abs);
  if (!relative || relative.startsWith('..')) return undefined;
  return relative.slice(0, relative.toLowerCase().endsWith('.pj') ? -3 : undefined).split(path.sep).join('.');
}

/** Insert an auto-import after the existing header without disturbing declarations. */
function addImportEdit(doc: TextDocument, program: A.Program, importName: string): TextEdit {
  let line = 0;
  let text = `import ${importName};\n\n`;
  if (program.imports.length > 0) {
    line = program.imports[program.imports.length - 1].span.end.line + 1;
    text = `import ${importName};\n`;
  } else if (program.pkg && program.pkg.length > 0) {
    line = program.pkg[program.pkg.length - 1].span.end.line + 1;
    text = `\nimport ${importName};\n`;
  } else if (program.pragmas.length > 0) {
    line = program.pragmas[program.pragmas.length - 1].span.end.line + 1;
    text = `\nimport ${importName};\n`;
  }
  // A header ending on the last line without a trailing newline leaves no line
  // to insert before; clients clamp such a position onto the last line.
  if (line >= doc.lineCount) return TextEdit.insert(doc.positionAt(doc.getText().length), `\n${text}`);
  return TextEdit.insert(Position.create(line, 0), text);
}

interface Resolved {
  symbol: PJSymbol;
  uri: string;
  origin: 'local' | 'document' | 'workspace' | 'library';
  /** Exact checker identity for locals/parameters; absent only during parser recovery. */
  variable?: VarInfo;
  /** Exact overload selected by the checker or declaration position. */
  procedure?: ProcSig;
  /** The cursor itself was proven to denote this declaration. */
  exact: boolean;
}

function symbolForVariable(variable: VarInfo): PJSymbol {
  return {
    name: variable.name,
    kind: 'var',
    line: variable.decl.span.start.line,
    startCol: variable.decl.span.start.col,
    endCol: variable.decl.span.end.col,
    endLine: variable.decl.span.end.line,
    detail: `${variable.isConst ? 'const ' : ''}${typeStr(variable.type)} ${variable.name}${variable.isParam ? ' (parameter)' : ''}`,
    container: variable.proc,
  };
}

function resolvedProcedure(doc: TextDocument, sig: ProcSig): Resolved {
  const ownPath = safeFileUri(doc.uri);
  const file = sig.file ? path.resolve(sig.file) : undefined;
  const uri = !file || (ownPath && file === path.resolve(ownPath)) ? doc.uri : pathToFileURL(file).toString();
  const origin: Resolved['origin'] = uri === doc.uri ? 'document' : file && libraryFiles.has(file) ? 'library' : 'workspace';
  const start = sig.decl.name.span.start;
  const end = sig.decl.name.span.end;
  const symbol: PJSymbol = {
    name: sig.name,
    kind: 'proc',
    line: start.line,
    startCol: start.col,
    endCol: end.col,
    endLine: sig.decl.span.end.line,
    detail: signatureStr(sig),
  };
  return {
    uri,
    origin,
    procedure: sig,
    exact: true,
    symbol: sourceSymbol(doc, file, uri, symbol),
  };
}

function resolvedIndexedSymbol(doc: TextDocument, file: string | undefined, symbol: PJSymbol): Resolved {
  const ownPath = safeFileUri(doc.uri);
  const absolute = file ? path.resolve(file) : undefined;
  const uri = !absolute || (ownPath && absolute === path.resolve(ownPath)) ? doc.uri : pathToFileURL(absolute).toString();
  const origin: Resolved['origin'] = uri === doc.uri ? 'document' : absolute && libraryFiles.has(absolute) ? 'library' : 'workspace';
  return { uri, origin, symbol: sourceSymbol(doc, absolute, uri, symbol), exact: true };
}

/** Recover docs and the modifier-rich display text from the source extractor.
 * Checker signatures intentionally carry only semantic data. */
function sourceSymbol(doc: TextDocument, file: string | undefined, uri: string, fallback: PJSymbol): PJSymbol {
  let candidates: PJSymbol[] = [];
  if (uri === doc.uri) candidates = symbolsFor(doc).symbols;
  else {
    const open = documents.get(uri);
    if (open) candidates = symbolsFor(open).symbols;
    else if (file && libraryFiles.has(file)) candidates = library.filter((symbol) => path.resolve(symbol.file) === file);
    else if (file) {
      const exact = workspace.symbolAt(file, fallback.kind, fallback.name, fallback.line, fallback.startCol);
      if (exact) candidates = [exact];
    }
  }
  const exact = candidates.find((symbol) => symbol.kind === fallback.kind && symbol.name === fallback.name && symbol.line === fallback.line && symbol.startCol === fallback.startCol);
  return exact ? { ...fallback, detail: exact.detail, doc: exact.doc, params: exact.params } : fallback;
}

function indexedTypeResolution(doc: TextDocument, analysis: Analysis, name: string): Resolved | undefined {
  const record = analysis.index.records.get(name);
  if (record) {
    const id = record.decl.name;
    return resolvedIndexedSymbol(doc, record.file, {
      name,
      kind: 'record',
      line: id.span.start.line,
      startCol: id.span.start.col,
      endCol: id.span.end.col,
      endLine: record.decl.span.end.line,
      detail: `record ${name}${record.extends.length ? ` extends ${record.extends.join(', ')}` : ''}`,
    });
  }
  const protocol = analysis.index.protocols.get(name);
  if (protocol) {
    const id = protocol.decl.name;
    return resolvedIndexedSymbol(doc, protocol.file, {
      name,
      kind: 'protocol',
      line: id.span.start.line,
      startCol: id.span.start.col,
      endCol: id.span.end.col,
      endLine: protocol.decl.span.end.line,
      detail: `protocol ${name}${protocol.extends.length ? ` extends ${protocol.extends.join(', ')}` : ''}`,
    });
  }
  return undefined;
}

function indexedConstantResolution(doc: TextDocument, analysis: Analysis, name: string): Resolved | undefined {
  const constant = analysis.index.consts.get(name);
  if (!constant) return undefined;
  const declarator = constant.decl.declarators.find((entry) => entry.name.name === name);
  if (!declarator) return undefined;
  const id = declarator.name;
  return resolvedIndexedSymbol(doc, constant.file, {
    name,
    kind: 'const',
    line: id.span.start.line,
    startCol: id.span.start.col,
    endCol: id.span.end.col,
    endLine: constant.decl.span.end.line,
    detail: `const ${typeStr(constant.type)} ${name}`,
  });
}

function sameFile(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return a === b;
  return path.resolve(a) === path.resolve(b);
}

/** Find what an identifier at a position refers to: local, then this file, then workspace, then stdlib. */
function resolve(doc: TextDocument, position: Position): { word: string; hits: Resolved[] } | undefined {
  const w = wordAt(lineText(doc, position.line), position.character);
  if (!w) return undefined;
  const parsed = parsedFor(doc);
  const cursorToken = parsed.tokens.find((token) => token.line === position.line && token.col === w.start && token.end === w.end);
  if (!cursorToken) return undefined; // inside a comment or string, not a language identifier
  if (cursorToken.kind === 'keyword') return { word: w.word, hits: [] };
  if (cursorToken.kind !== 'ident') return undefined;
  const { symbols, locals } = symbolsFor(doc);
  const analysis = checkFor(doc);
  const hits: Resolved[] = [];

  // Prefer the checker's declaration identity over textual proximity. This is
  // exact even when nested scopes shadow a name or procedures are overloaded.
  const variable = variableAt(analysis.checked, position);
  if (variable) return { word: w.word, hits: [{ symbol: symbolForVariable(variable), uri: doc.uri, origin: 'local', variable, exact: true }] };

  // A resolved call identifies the exact overload and source file. In
  // particular, do not let an unrelated file with a same-named procedure win
  // just because that editor happens to be open.
  for (const [call, sig] of analysis.checked.calls) {
    if (containsPosition(call.name.span, position)) return { word: w.word, hits: [resolvedProcedure(doc, sig)] };
  }
  const ownPath = safeFileUri(doc.uri);
  for (const sig of analysis.index.procs.get(w.word) ?? []) {
    if (sameFile(sig.file, ownPath) && containsPosition(sig.decl.name.span, position)) {
      return { word: w.word, hits: [resolvedProcedure(doc, sig)] };
    }
  }

  const program = parsed.program;
  if (namedTypeSpans(program, w.word).some((span) => containsPosition(span, position))) {
    const type = indexedTypeResolution(doc, analysis, w.word);
    if (type) return { word: w.word, hits: [type] };
  }
  for (const [expr] of analysis.checked.types) {
    if (expr.kind !== 'NameExpr' || expr.qualifier?.length || analysis.checked.resolutions.has(expr) || !containsPosition(expr.name.span, position)) continue;
    const constant = indexedConstantResolution(doc, analysis, w.word);
    if (constant) return { word: w.word, hits: [constant] };
  }

  // Tolerant fallback for a half-typed tree. It remains useful for hover and go
  // to definition, but rename refuses it because the binding is not provable.
  const enclosing = symbols.find((s) => s.kind === 'proc' && position.line >= s.line && position.line <= s.endLine);
  for (const v of locals) {
    if (v.name === w.word && (!enclosing || v.container === enclosing.name) && v.line <= position.line) {
      hits.push({ symbol: v, uri: doc.uri, origin: 'local', exact: false });
    }
  }
  if (hits.length) return { word: w.word, hits: [hits[hits.length - 1]] }; // nearest declaration wins

  const declarationHits: Resolved[] = [];
  const addOwn = (symbol: PJSymbol) => {
    if (symbol.name !== w.word) return;
    const exact = symbol.line === position.line && symbol.startCol === w.start && symbol.endCol === w.end;
    (exact ? declarationHits : hits).push({ symbol, uri: doc.uri, origin: 'document', exact });
  };
  for (const s of symbols) {
    addOwn(s);
    for (const c of s.children ?? []) addOwn(c);
  }
  if (declarationHits.length) return { word: w.word, hits: declarationHits };
  if (hits.length) return { word: w.word, hits };

  const openPaths = new Set<string>();
  const visible: Resolved[] = [];
  const fallback: Resolved[] = [];
  const addExternal = (resolved: Resolved, file: string | undefined) => {
    (file && analysis.deps.has(path.resolve(file)) ? visible : fallback).push(resolved);
  };
  for (const open of documents.all()) {
    if (open.uri === doc.uri) continue;
    const file = safeFileUri(open.uri);
    if (file) openPaths.add(path.resolve(file));
    for (const s of symbolsFor(open).symbols) {
      if (s.name === w.word) addExternal({ symbol: s, uri: open.uri, origin: 'workspace', exact: false }, file);
      for (const child of s.children ?? []) if (child.name === w.word) addExternal({ symbol: child, uri: open.uri, origin: 'workspace', exact: false }, file);
    }
  }

  for (const { file, symbol } of workspace.lookup(w.word, safeFileUri(doc.uri))) {
    if (openPaths.has(path.resolve(file))) continue;
    addExternal({ symbol, uri: pathToFileURL(file).toString(), origin: 'workspace', exact: false }, file);
  }

  for (const lib of library) {
    if (lib.name === w.word) addExternal({ symbol: lib, uri: pathToFileURL(lib.file).toString(), origin: 'library', exact: false }, lib.file);
  }
  return { word: w.word, hits: visible.length > 0 ? visible : fallback };
}

connection.onDefinition((params: DefinitionParams) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const r = resolve(doc, params.position);
  if (!r || r.hits.length === 0) return null;
  return r.hits.map((h) => Location.create(h.uri, Range.create(h.symbol.line, h.symbol.startCol, h.symbol.line, h.symbol.endCol)));
});

connection.onHover((params: HoverParams): Hover | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  // On a statement FDR found stuck, what it found comes first.
  const fdr = fdrHover(doc, params.position);
  const value = symbolHover(doc, params.position);
  const parts = [fdr, value].filter((part): part is string => !!part);
  return parts.length ? { contents: { kind: MarkupKind.Markdown, value: parts.join('\n\n---\n\n') } } : null;
});

/** The hover of the symbol or expression at a position: its declaration, type, effects and channel topology. */
function symbolHover(doc: TextDocument, position: Position): string | undefined {
  const r = resolve(doc, position);
  if (!r) return undefined;

  if (r.hits.length === 0) {
    const kw = KEYWORD_DOCS[r.word];
    if (kw) return `**${r.word}**\n\n${kw}`;
    const t = typeAtPosition(doc, position);
    if (t) return `\`\`\`processj\n${t}\n\`\`\``;
    return undefined;
  }

  const exprType = typeAtPosition(doc, position);
  const parts = r.hits.slice(0, 6).map((h) => {
    // Exact checker resolutions synthesize an ordinary PJSymbol, including for
    // stdlib declarations, so the URI is the reliable source of the filename.
    const sourceName = path.basename(safeFileUri(h.uri) ?? '');
    const where = h.origin === 'library' ? `  — std library (${sourceName})` : h.origin === 'workspace' ? `  — ${sourceName}` : '';
    let s = `\`\`\`processj\n${h.symbol.detail}\n\`\`\`${where}`;
    if (h.symbol.doc) s += `\n\n${h.symbol.doc}`;
    return s;
  });
  if (exprType && !r.hits.some((h) => h.symbol.detail.startsWith(exprType))) parts.unshift(`type: \`${exprType}\``);
  const analysis = checkFor(doc);
  const procedure = r.hits.find((hit) => hit.procedure)?.procedure;
  const effects = procedure ? analysis.effects.get(procedure.decl) : undefined;
  if (effects) {
    parts.push(`**Concurrency effects**\n\n${effectFactText(effects.transitive)}${effects.transitive.unknown ? '\n\n_This summary is partial because some call or channel-resource binding is opaque._' : ''}`);
  }
  const channel = r.hits.find((hit) => hit.variable?.type.k === 'chan')?.variable;
  if (channel) {
    const hint = inlaysFor(doc).find((entry) => entry.variable === channel);
    if (hint) parts.push(`**Channel topology**\n\n${hint.label.replace(/^\s*⇢\s*/, '')}\n\n${hint.tooltip}`);
  }
  return parts.join('\n\n---\n\n');
}

/** Type of the smallest expression containing the position, from the checker. */
const typePositionCache = new WeakMap<CheckResult, { byLine: Map<number, Array<[A.Expr, Type]>>; multiline: Array<[A.Expr, Type]> }>();

/** Single-line typed expressions by line, plus the few multi-line ones, built once per analysis. */
function typePositionIndex(checked: CheckResult): { byLine: Map<number, Array<[A.Expr, Type]>>; multiline: Array<[A.Expr, Type]> } {
  let positionIndex = typePositionCache.get(checked);
  if (positionIndex) return positionIndex;
  positionIndex = { byLine: new Map(), multiline: [] };
  for (const entry of checked.types) {
    const [expr] = entry;
    if (expr.span.start.line !== expr.span.end.line) {
      positionIndex.multiline.push(entry);
      continue;
    }
    const line = positionIndex.byLine.get(expr.span.start.line);
    if (line) line.push(entry);
    else positionIndex.byLine.set(expr.span.start.line, [entry]);
  }
  typePositionCache.set(checked, positionIndex);
  return positionIndex;
}

function typeAtPosition(doc: TextDocument, pos: Position): string | undefined {
  const { checked } = checkFor(doc);
  const positionIndex = typePositionIndex(checked);
  let best: { size: number; type: string } | undefined;
  const consider = ([e, t]: [A.Expr, Type]): void => {
    const s = e.span;
    if (!containsPosition(s, pos)) return;
    if (t.k === 'error' || t.k === 'unknown') return;
    const size = (s.end.line - s.start.line) * 10_000 + (s.end.col - s.start.col);
    if (!best || size < best.size) best = { size, type: typeStr(t) };
  };
  for (const entry of positionIndex.byLine.get(pos.line) ?? []) consider(entry);
  for (const entry of positionIndex.multiline) consider(entry);
  return best?.type;
}

function declarationSpans(program: A.Program, name: string, kind: PJSymbol['kind']): A.Span[] {
  const spans: A.Span[] = [];
  for (const decl of program.decls) {
    if (kind === 'proc' && decl.kind === 'ProcDecl' && decl.name.name === name) spans.push(decl.name.span);
    else if (kind === 'record' && decl.kind === 'RecordDecl' && decl.name.name === name) spans.push(decl.name.span);
    else if (kind === 'protocol' && decl.kind === 'ProtocolDecl' && decl.name.name === name) spans.push(decl.name.span);
    else if (kind === 'const' && decl.kind === 'ConstDecl') {
      for (const variable of decl.declarators) if (variable.name.name === name) spans.push(variable.name.span);
    }
  }
  return spans;
}

function indexedBindingFile(analysis: Bindings, kind: PJSymbol['kind'], name: string): string | undefined {
  if (kind === 'record') return analysis.index.records.get(name)?.file;
  if (kind === 'protocol') return analysis.index.protocols.get(name)?.file;
  if (kind === 'const') return analysis.index.consts.get(name)?.file;
  return undefined;
}

function callTargets(sig: ProcSig, targetFile: string | undefined, targetUri: string, sourceUri: string, target?: ProcSig): boolean {
  const fileMatches = targetFile ? sameFile(sig.file, targetFile) : !sig.file && targetUri === sourceUri;
  return fileMatches && (!target || sameSignature(sig, target));
}

function procedureReferenceSpans(program: A.Program, analysis: Bindings, name: string, targetFile: string | undefined, targetUri: string, sourceUri: string, target: ProcSig): A.Span[] {
  const spans: A.Span[] = [];
  for (const [call, sig] of analysis.checked.calls) {
    if (call.name.name === name && callTargets(sig, targetFile, targetUri, sourceUri, target)) spans.push(call.name.span);
  }

  const candidates = analysis.index.procs.get(name) ?? [];
  const matching = candidates.filter((sig) => callTargets(sig, targetFile, targetUri, sourceUri, target));
  const otherTargets = candidates.some((sig) => !callTargets(sig, targetFile, targetUri, sourceUri, target));
  if (matching.length > 0 && !otherTargets) {
    // Calls the checker rejected (wrong arity or argument types) have no
    // `calls` entry, yet a rename that skipped them would leave dangling names.
    for (const [expr] of analysis.checked.types) {
      if (expr.kind === 'Invocation' && !expr.target && !expr.qualifier?.length && expr.name.name === name && !analysis.checked.calls.has(expr)) spans.push(expr.name.span);
    }
    for (const decl of program.decls) {
      if (decl.kind !== 'ProcDecl') continue;
      for (const implemented of decl.implements) if (!implemented.qualifier?.length && implemented.name === name) spans.push(implemented.span);
    }
  }

  // `new mobile(Worker)` names a procedure rather than a type. The checker only
  // accepts it when exactly one mobile declaration is available, which gives us
  // the same stable identity needed for rename.
  const mobile = candidates.filter((sig) => sig.decl.modifiers.includes('mobile'));
  if (mobile.length === 1 && callTargets(mobile[0], targetFile, targetUri, sourceUri, target)) {
    for (const [expr] of analysis.checked.types) {
      if (expr.kind === 'NewMobile' && !expr.typeName.qualifier?.length && expr.typeName.name === name) spans.push(expr.typeName.span);
    }
  }
  return spans;
}

function constantReferenceSpans(analysis: Bindings, name: string): A.Span[] {
  const spans: A.Span[] = [];
  for (const [expr] of analysis.checked.types) {
    if (expr.kind === 'NameExpr' && !expr.qualifier?.length && expr.name.name === name && !analysis.checked.resolutions.has(expr)) spans.push(expr.name.span);
  }
  return spans;
}

function rangeFor(span: A.Span): Range {
  return Range.create(span.start.line, span.start.col, span.end.line, span.end.col);
}

function rangeKey(uri: string, range: Range): string {
  return `${uri}\0${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
}

function referencesOf(doc: TextDocument, position: Position, includeDeclaration = true): { name: string; locations: Location[] } | undefined {
  const r = resolve(doc, position);
  if (!r || r.hits.length === 0 || !r.hits[0].exact) return undefined;
  const hit = r.hits[0];
  const locations: Location[] = [];

  if (hit.origin === 'local') {
    if (!hit.variable) return undefined;
    for (const span of variableSpans(checkFor(doc).checked, hit.variable, includeDeclaration)) {
      locations.push(Location.create(doc.uri, rangeFor(span)));
    }
    return { name: r.word, locations };
  }

  // Member names need receiver-type resolution, which the checker does not yet
  // expose as a stable declaration identity. Returning no references is safer
  // than a workspace-wide textual rename of unrelated fields or protocol cases.
  if (hit.symbol.kind === 'field' || hit.symbol.kind === 'case' || hit.symbol.detail.startsWith('extern ')) return undefined;

  const targetFile = safeFileUri(hit.uri);
  const targetKind = hit.symbol.kind;
  const targetProcedure = hit.procedure;
  if (targetKind === 'proc' && !targetProcedure) return undefined;
  const ownPath = safeFileUri(doc.uri);
  const openPaths = new Set<string>();
  const seen = new Set<string>();
  const add = (uri: string, range: Range) => {
    const key = rangeKey(uri, range);
    if (seen.has(key)) return;
    seen.add(key);
    locations.push(Location.create(uri, range));
  };
  if (includeDeclaration) {
    for (const resolved of r.hits) {
      if (resolved.symbol.kind !== targetKind || resolved.uri !== hit.uri) continue;
      add(resolved.uri, Range.create(resolved.symbol.line, resolved.symbol.startCol, resolved.symbol.line, resolved.symbol.endCol));
    }
  }

  const addOpenDocument = (source: TextDocument): void => {
    const sourcePath = safeFileUri(source.uri);
    const analysis = checkFor(source);
    const program = parsedFor(source).program;
    const declarations = targetKind === 'proc' && targetProcedure ? [targetProcedure.decl.name.span] : declarationSpans(program, r.word, targetKind);
    const isTargetFile = source.uri === hit.uri || (!!sourcePath && !!targetFile && sameFile(sourcePath, targetFile));

    if (targetKind === 'proc') {
      if (includeDeclaration && isTargetFile) for (const span of declarations) add(source.uri, rangeFor(span));
      for (const span of procedureReferenceSpans(program, analysis, r.word, targetFile, hit.uri, source.uri, targetProcedure!)) add(source.uri, rangeFor(span));
      return;
    }

    const boundFile = indexedBindingFile(analysis, targetKind, r.word);
    if (!(isTargetFile || (targetFile && sameFile(boundFile, targetFile)))) return;
    if (includeDeclaration && isTargetFile) for (const span of declarations) add(source.uri, rangeFor(span));
    const uses = targetKind === 'const' ? constantReferenceSpans(analysis, r.word) : namedTypeSpans(program, r.word);
    for (const span of uses) add(source.uri, rangeFor(span));
  };

  addOpenDocument(doc);
  for (const d of documents.all()) {
    const p = safeFileUri(d.uri);
    if (d.uri === doc.uri) continue;
    if (p) openPaths.add(path.resolve(p));
    addOpenDocument(d);
  }

  // Use the compact token index only to identify candidate closed files. Each
  // candidate is then checked against its imports, and procedure calls use the
  // exact overload/file selected by the checker.
  const byFile = new Map<string, Range[]>();
  for (const occurrence of workspace.occurrences(r.word, ownPath, true)) {
    const file = path.resolve(occurrence.file);
    if (openPaths.has(file)) continue;
    const range = Range.create(occurrence.line, occurrence.startCol, occurrence.line, occurrence.endCol);
    const ranges = byFile.get(file);
    if (ranges) ranges.push(range);
    else byFile.set(file, [range]);
  }
  for (const [file] of byFile) {
    const program = workspace.programFor(file);
    if (!program) continue;
    const uri = pathToFileURL(file).toString();
    const analysis = closedBindingsFor(file, program);
    const declarations = targetKind === 'proc' && targetProcedure ? [targetProcedure.decl.name.span] : declarationSpans(program, r.word, targetKind);
    const isTargetFile = !!targetFile && sameFile(file, targetFile);
    if (targetKind === 'proc') {
      if (includeDeclaration && isTargetFile) for (const span of declarations) add(uri, rangeFor(span));
      for (const span of procedureReferenceSpans(program, analysis, r.word, targetFile, hit.uri, uri, targetProcedure!)) add(uri, rangeFor(span));
      continue;
    }
    const boundFile = indexedBindingFile(analysis, targetKind, r.word);
    if (!(isTargetFile || (targetFile && sameFile(boundFile, targetFile)))) continue;
    if (includeDeclaration && isTargetFile) for (const span of declarations) add(uri, rangeFor(span));
    const uses = targetKind === 'const' ? constantReferenceSpans(analysis, r.word) : namedTypeSpans(program, r.word);
    for (const span of uses) add(uri, rangeFor(span));
  }
  return { name: r.word, locations };
}

connection.onReferences((params: ReferenceParams) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  return referencesOf(doc, params.position, params.context.includeDeclaration)?.locations ?? null;
});

connection.onPrepareRename((params: PrepareRenameParams) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const r = resolve(doc, params.position);
  if (!r || r.hits.length === 0 || r.hits[0].origin === 'library' || (r.hits[0].origin === 'local' && !r.hits[0].variable)) return null;
  if (r.hits.some((hit) => !hit.exact)) return null;
  if (r.hits.some((hit) => hit.symbol.kind === 'field' || hit.symbol.kind === 'case' || hit.symbol.detail.startsWith('extern '))) return null;
  if (r.hits.some((hit) => hit.symbol.kind === 'proc' && !hit.procedure)) return null;
  // Multiple files with the same unresolved name are ambiguous. Exact calls
  // are reduced to one hit by the checker above and remain safely renameable.
  if (new Set(r.hits.map((hit) => hit.uri)).size > 1) return null;
  const w = wordAt(lineText(doc, params.position.line), params.position.character)!;
  return { range: Range.create(params.position.line, w.start, params.position.line, w.end), placeholder: r.word };
});

connection.onRenameRequest((params: RenameParams): WorkspaceEdit | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  // A refused rename must say why: a null result shows nothing in most editors.
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(params.newName)) throw new ResponseError(ErrorCodes.InvalidParams, `'${params.newName}' is not a valid ProcessJ identifier`);
  if (KEYWORDS.includes(params.newName) || PRIMITIVE_TYPES.includes(params.newName) || LITERALS.includes(params.newName)) throw new ResponseError(ErrorCodes.InvalidParams, `'${params.newName}' is a reserved word`);
  const prepared = resolve(doc, params.position);
  if (!prepared || prepared.hits.length === 0 || prepared.hits[0].origin === 'library') return null;
  if (prepared.hits.some((hit) => !hit.exact)) return null;
  if (prepared.hits.some((hit) => hit.symbol.kind === 'field' || hit.symbol.kind === 'case' || hit.symbol.detail.startsWith('extern '))) return null;
  if (prepared.hits.some((hit) => hit.symbol.kind === 'proc' && !hit.procedure)) return null;
  if (new Set(prepared.hits.map((hit) => hit.uri)).size > 1) return null;
  const variable = prepared.hits[0].variable;
  if (variable && localRenameConflict(parsedFor(doc).program, checkFor(doc).checked, variable, params.newName)) {
    throw new ResponseError(ErrorCodes.InvalidParams, `Cannot rename '${variable.name}' to '${params.newName}': it would conflict with another declaration or change a reference's binding`);
  }
  const refs = referencesOf(doc, params.position);
  if (!refs) return null;
  if (!variable) {
    const conflict = topLevelRenameConflict(refs.locations, params.newName);
    if (conflict) throw new ResponseError(ErrorCodes.InvalidParams, `Cannot rename '${refs.name}' to '${params.newName}': ${conflict}`);
  }
  const byUri = new Map<string, TextEdit[]>();
  for (const loc of refs.locations) {
    let edits = byUri.get(loc.uri);
    if (!edits) byUri.set(loc.uri, (edits = []));
    edits.push(TextEdit.replace(loc.range, params.newName));
  }
  if (clientSupportsDocumentChanges) {
    // Versioned where the file is open, so an edit typed meanwhile cannot be clobbered.
    return { documentChanges: [...byUri].map(([uri, edits]) => ({ textDocument: { uri, version: documents.get(uri)?.version ?? null }, edits })) };
  }
  return { changes: Object.fromEntries(byUri) };
});

/**
 * Renaming a procedure, record, protocol or constant must not collide with
 * another top-level declaration visible to an affected file, nor be captured
 * by a local or parameter of the same name in a procedure that refers to it.
 */
function topLevelRenameConflict(locations: Location[], newName: string): string | undefined {
  const uris = new Set(locations.map((location) => location.uri));
  for (const uri of uris) {
    const open = documents.get(uri);
    let bindings: Bindings | undefined;
    let program: A.Program | undefined;
    if (open) {
      bindings = checkFor(open);
      program = parsedFor(open).program;
    } else {
      const file = safeFileUri(uri);
      program = file ? workspace.programFor(file) : undefined;
      if (file && program) bindings = closedBindingsFor(file, program);
    }
    if (!bindings || !program) continue;
    const { index, checked } = bindings;
    if (index.procs.has(newName) || index.records.has(newName) || index.protocols.has(newName) || index.consts.has(newName)) {
      return `'${newName}' is already declared (or imported) in ${path.basename(safeFileUri(uri) ?? uri)}`;
    }
    // Only a variable in scope at a reference captures it; the same name in
    // another block or procedure is harmless.
    for (const location of locations) {
      if (location.uri !== uri) continue;
      const capturing = visibleVariables(program, checked, location.range.start).find((v) => v.name === newName);
      if (capturing) return `'${capturing.proc}' in ${path.basename(safeFileUri(uri) ?? uri)} declares a variable named '${newName}' that would capture the reference on line ${location.range.start.line + 1}`;
    }
  }
  return undefined;
}

connection.onSignatureHelp((params: SignatureHelpParams): SignatureHelp | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const call = findCallContext(doc, params.position);
  if (!call) return null;

  // Candidates come from what this file can actually call: its own procs, its imports, the std library.
  const { index } = checkFor(doc);
  const sigs = index.procs.get(call.name) ?? [];
  if (sigs.length === 0) return null;
  const seen = new Set<string>();
  const signatures: SignatureInformation[] = [];
  for (const sig of sigs) {
    const label = signatureStr(sig);
    if (seen.has(label)) continue;
    seen.add(label);
    signatures.push({
      label,
      parameters: sig.params.map((p, i): ParameterInformation => ({ label: `${typeStr(p)} ${sig.paramNames[i]}` })),
    });
  }
  // Show the overloads that can still take the argument being typed first.
  const fits = (s: SignatureInformation) => (s.parameters?.length ?? 0) > call.argIndex;
  signatures.sort((a, b) => Number(fits(b)) - Number(fits(a)));
  return { signatures, activeSignature: 0, activeParameter: call.argIndex };
});

/** Find the innermost unclosed call using lexer tokens, so commas in strings or
 * comments and arbitrarily long multiline calls do not corrupt argument index. */
function findCallContext(doc: TextDocument, position: Position): { name: string; argIndex: number } | undefined {
  const tokens = parsedFor(doc).tokens;
  const stack: Array<{ token: '(' | '[' | '{'; index: number; commas: number }> = [];
  const closes: Record<string, '(' | '[' | '{'> = { ')': '(', ']': '[', '}': '{' };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.line > position.line || (token.line === position.line && token.col >= position.character)) break;
    if (token.text === '(' || token.text === '[' || token.text === '{') {
      stack.push({ token: token.text, index: i, commas: 0 });
      continue;
    }
    const opening = closes[token.text];
    if (opening) {
      for (let j = stack.length - 1; j >= 0; j--) {
        if (stack[j].token !== opening) continue;
        stack.length = j;
        break;
      }
      continue;
    }
    if (token.text === ',' && stack.at(-1)?.token === '(') stack[stack.length - 1].commas++;
    // A `;` cannot appear inside an argument list, so every bracket still open
    // in the current block belongs to an unfinished earlier statement.
    if (token.text === ';') while (stack.length && stack[stack.length - 1].token !== '{') stack.pop();
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    const open = stack[i];
    if (open.token === '{') break;
    if (open.token !== '(') continue;
    const head = tokens[open.index - 1];
    if (head?.kind === 'ident') return { name: head.text, argIndex: open.commas };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lineText(doc: TextDocument, line: number): string {
  return doc.getText(Range.create(line, 0, line + 1, 0)).replace(/\r?\n$/, '');
}

function firstNonSpace(s: string): number {
  const m = /\S/.exec(s);
  return m ? m.index : 0;
}

function indexOfWord(text: string, word: string): number {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[^A-Za-z0-9_$])(${escaped})(?![A-Za-z0-9_$])`);
  const m = re.exec(text);
  return m ? m.index + m[0].length - m[1].length : -1;
}

/** The open editor buffer for a file on disk, matched by path rather than by URI spelling (clients encode URIs differently). */
function documentForPath(file: string): TextDocument | undefined {
  const wanted = path.resolve(file);
  for (const doc of documents.all()) {
    const p = safeFileUri(doc.uri);
    if (p && path.resolve(p) === wanted) return doc;
  }
  return undefined;
}

function safeFileUri(uri: string): string | undefined {
  try {
    return uri.startsWith('file:') ? fileURLToPath(uri) : undefined;
  } catch {
    return undefined;
  }
}

/** The installed package is the version source of truth for every editor. */
function packageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

allDocuments.listen(connection);
connection.listen();
