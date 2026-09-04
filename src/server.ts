import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CodeAction,
  CodeActionKind,
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
  InsertTextFormat,
  Location,
  MarkupKind,
  ParameterInformation,
  Position,
  ProposedFeatures,
  Range,
  ResponseError,
  SignatureHelp,
  SignatureInformation,
  SymbolKind,
  TextDocuments,
  TextDocumentSyncKind,
  TextEdit,
  WorkspaceEdit,
  type CodeActionParams,
  type CodeLensParams,
  type CompletionParams,
  type DefinitionParams,
  type DocumentFormattingParams,
  type DocumentHighlightParams,
  type DocumentSymbolParams,
  type ExecuteCommandParams,
  type FoldingRangeParams,
  type HoverParams,
  type InitializeParams,
  type InitializeResult,
  type PrepareRenameParams,
  type ReferenceParams,
  type RenameParams,
  type SignatureHelpParams,
  type WorkspaceSymbolParams,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { type FixHint, type LintDiagnostic } from './analysis';
import { astSymbols } from './astsymbols';
import { check, type CheckResult, type VarInfo } from './checker/checker';
import { DeclIndex, sameSignature, signatureStr, type ProcSig } from './checker/index';
import { typeStr, type Type } from './checker/types';
import { compile } from './compiler';
import { format } from './format';
import { importDiagnostics, resolveImports } from './imports';
import type * as A from './parser/ast';
import { parse, type ParseResult } from './parser/parser';
import { semanticTokens, TOKEN_MODIFIERS, TOKEN_TYPES } from './semantic';
import { findInstall, type Install } from './config';
import { parseCompilerOutput, type RawDiagnostic } from './diagnostics';
import { KEYWORD_DOCS, KEYWORDS, LITERALS, PRIMITIVE_TYPES } from './keywords';
import { indexLibrary, type LibrarySymbol } from './library';
import { containsPosition, namedTypeSpans, variableAt, variableSpans, visibleVariables } from './navigation';
import { build, formatReport, run } from './pipeline';
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from './settings';
import { extractLocals, extractSymbols, wordAt, type PJSymbol } from './symbols';
import { WorkspaceIndex } from './workspace';
import { LatestTaskQueue } from './taskqueue';

const COMMAND_RUN = 'processj.run';
const COMMAND_BUILD = 'processj.build';
const SERVER_VERSION = packageVersion();

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const workspace = new WorkspaceIndex();

let settings: Settings = { ...DEFAULT_SETTINGS };
let clientWatchesFiles = false;
let clientSupportsWorkspaceFolders = false;
let install: Install | undefined;
let installError: string | undefined;
let library: LibrarySymbol[] = [];
let clientSupportsShowDocument = false;
/** Parsed standard-library headers, keyed by absolute path. */
const libraryPrograms = new Map<string, A.Program>();
const libraryFiles = new Set<string>();
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
  index: DeclIndex;
  importDiags: LintDiagnostic[];
  deps: Set<string>;
}

const checkCache = new Map<string, Analysis & { version: number }>();
const symbolCache = new Map<string, { version: number; symbols: PJSymbol[]; locals: PJSymbol[] }>();
// Lint runs are coalesced so a burst of keystrokes in a large file costs one pass.
const lintPending = new Map<string, NodeJS.Timeout>();
// TextDocuments emits onDidChangeContent once as part of every didOpen. Track
// that synthetic event so it cannot cancel the required open-time compiler run.
const openingDocuments = new Set<string>();
const LINT_DELAY_MS = 40;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

connection.onInitialize((params: InitializeParams): InitializeResult => {
  settings = normalizeSettings(params.initializationOptions);
  clientSupportsShowDocument = !!params.capabilities.window?.showDocument?.support;
  clientWatchesFiles = !!params.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration;
  clientSupportsWorkspaceFolders = !!params.capabilities.workspace?.workspaceFolders;

  const found = findInstall({ installDir: settings.installDir, javaBin: settings.javaBin });
  if ('error' in found) {
    installError = found.error;
  } else {
    install = found;
    library = indexLibrary(install.includeDir);
    loadLibrary(install.includeDir);
  }

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
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: { prepareProvider: true },
      documentSymbolProvider: true,
      documentHighlightProvider: true,
      workspaceSymbolProvider: true,
      signatureHelpProvider: { triggerCharacters: ['(', ','], retriggerCharacters: [','] },
      codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
      codeLensProvider: settings.codeLens ? { resolveProvider: false } : undefined,
      executeCommandProvider: { commands: [COMMAND_RUN, COMMAND_BUILD] },
      documentFormattingProvider: true,
      foldingRangeProvider: true,
      semanticTokensProvider: { legend: { tokenTypes: [...TOKEN_TYPES], tokenModifiers: [...TOKEN_MODIFIERS] }, full: true },
      workspace: { workspaceFolders: { supported: true, changeNotifications: true } },
    },
    serverInfo: { name: 'processj-lsp', version: SERVER_VERSION },
  };
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
          if (path.basename(path.dirname(full)) === 'std') stdIndex.addProgram(program, full);
        } catch {
          /* unreadable header: skip */
        }
      }
    }
  }
}

connection.onInitialized(() => {
  if (clientWatchesFiles) {
    // The editor tells us when .pj files change on disk; no polling, no repeated directory walks.
    workspace.watched = true;
    void connection.client.register(DidChangeWatchedFilesNotification.type, { watchers: [{ globPattern: '**/*.pj' }] }).catch((error) => {
      workspace.watched = false;
      connection.console.warn(`could not register ProcessJ file watcher; falling back to polling: ${String(error)}`);
    });
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
    connection.window.showWarningMessage(`processj-lsp: ${installError}. Compiler diagnostics and Run are disabled; lints, completion and navigation still work.`);
  }
});

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
  openingDocuments.add(e.document.uri);
  schedulePublish(e.document);
  scheduleCheck(e.document, 0);
  // Hot-exit/session restore can open an imported file already containing
  // unsaved text, without a subsequent didChange. Make existing importers swap
  // their disk snapshot for the newly authoritative editor buffer immediately.
  const p = safeFileUri(e.document.uri);
  if (p) republishDependents(p, e.document.uri);
});
documents.onDidChangeContent((e) => {
  schedulePublish(e.document);
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
  let refreshAll = false;
  const changed = new Set<string>();
  for (const change of params.changes) {
    const p = safeFileUri(change.uri);
    if (!p || !p.endsWith('.pj')) continue;
    workspace.invalidate(p);
    // Keep the saved disk snapshot current even while the document is open.
    // Lookups overlay the editor buffer until close.
    if (change.type !== FileChangeType.Deleted) workspace.add(p);
    // A newly created file may satisfy a wildcard import, while a deleted file
    // can disappear before a lint-disabled document ever cached its old deps.
    // Both events are rare, so conservatively refresh/recompile every open file.
    if (change.type === FileChangeType.Created || change.type === FileChangeType.Deleted) refreshAll = true;
    else changed.add(p);
  }
  // Refresh at most once per notification: a branch switch delivers many
  // changes at once, and every extra schedule would abort the compiler run the
  // previous one had just started.
  if (refreshAll) republishAll(true);
  else for (const p of changed) republishDependents(p, undefined, true);
});

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
  compilerQueue.cancel(e.document.uri);
  const t = lintPending.get(e.document.uri);
  if (t) clearTimeout(t);
  lintPending.delete(e.document.uri);
  parseCache.delete(e.document.uri);
  checkCache.delete(e.document.uri);
  symbolCache.delete(e.document.uri);
  compilerDiags.delete(e.document.uri);
  connection.sendDiagnostics({ uri: e.document.uri, version: e.document.version, diagnostics: [] });
  const closedPath = safeFileUri(e.document.uri);
  // Importers may have been checked against unsaved contents. Once the overlay
  // disappears, immediately restore their view of the on-disk file.
  if (closedPath) republishDependents(closedPath, e.document.uri);
});

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
  const { checked, importDiags } = checkFor(doc);
  return [...lexical, ...syntax, ...importDiags.map((d) => makeDiagnostic(doc, d)), ...checked.diagnostics.map((d) => makeDiagnostic(doc, d))];
}

/** Type-check a document against its own declarations, its imports and the standard library. */
function checkFor(doc: TextDocument): Analysis {
  const cached = checkCache.get(doc.uri);
  if (cached && cached.version === doc.version) return cached;
  const parsed = parsedFor(doc);
  const ownPath = safeFileUri(doc.uri);
  const analysis = analyzeProgram(parsed.program, ownPath, doc.getText());
  const entry = { version: doc.version, ...analysis };
  checkCache.set(doc.uri, entry);
  return entry;
}

/** Analyze an on-disk program for a rare cross-file reference request. */
function analyzeProgram(program: A.Program, ownPath: string | undefined, text?: string): Analysis {
  const resolution = resolveImports(program, ownPath, workspace.getRoots(), install?.includeDir);
  const index = new DeclIndex();
  index.addProgram(program, ownPath);
  for (const file of resolution.files) {
    const open = documentForPath(file);
    const imported = open ? parsedFor(open).program : (libraryPrograms.get(file) ?? workspace.programFor(file));
    if (imported) index.addProgram(imported, file);
  }
  const importDiags: LintDiagnostic[] = importDiagnostics(resolution, !!install);
  const unresolved = resolution.imports.some((r) => r.files.length === 0);
  const checked = check(program, { index, stdIndex, importsStd: resolution.importsStd, unresolvedImports: unresolved, text });
  return { checked, index, importDiags, deps: new Set(resolution.files.map((f) => path.resolve(f))) };
}

connection.languages.semanticTokens.on((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return { data: [] };
  const parsed = parsedFor(doc);
  const { checked, index } = checkFor(doc);
  return { data: semanticTokens(parsed.program, checked, index, { libraryFiles }) };
});

/** Send the current lints plus the most recent compiler results (if still for this version). */
function publish(doc: TextDocument): void {
  const lints = lintDiagnostics(doc);
  const fromCompiler = compilerDiags.get(doc.uri);
  const compiler = fromCompiler && fromCompiler.version === doc.version ? fromCompiler.diagnostics : [];
  connection.sendDiagnostics({ uri: doc.uri, version: doc.version, diagnostics: mergeDiagnostics(lints, compiler) });
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
  const result = await compile(install, sourcePath, doc.getText(), { timeoutMs: settings.timeoutMs, signal });

  if (result.aborted) return;
  const current = documents.get(uri);
  if (!current || current.version !== version) return; // a newer check is on its way

  let diagnostics: Diagnostic[];
  if (result.timedOut) {
    diagnostics = [makeDiagnostic(current, { line: 0, message: `ProcessJ compiler timed out after ${settings.timeoutMs} ms`, severity: 'warning', code: 'timeout', source: 'lsp' })];
  } else {
    const parsed = parseCompilerOutput(result.stdout, result.stderr);
    diagnostics = parsed.diagnostics.map((d) => makeDiagnostic(current, d));
    if (parsed.crash) connection.console.error(`compiler crash on ${sourcePath}: ${parsed.crash}\n${result.stderr}`);
  }
  connection.console.log(`checked ${path.basename(sourcePath)} in ${result.durationMs} ms: ${diagnostics.length} compiler diagnostic(s)`);
  compilerDiags.set(uri, { version, diagnostics });
  publish(current);
}

function makeDiagnostic(doc: TextDocument, raw: RawDiagnostic | LintDiagnostic): Diagnostic {
  const lineCount = Math.max(doc.lineCount, 1);
  let message = raw.message;

  // Errors reported against an imported file: pin them to the top of this document.
  const ownName = path.basename(safeFileUri(doc.uri) ?? '');
  let line = raw.line < 0 ? lineCount - 1 : raw.line;
  if (raw.file && path.basename(raw.file) !== ownName && path.basename(raw.file) !== 'buffer.pj') {
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
  return {
    range: Range.create(line, start, line, end),
    message,
    severity,
    code: raw.code,
    source: raw.source === 'lsp' ? 'processj-lint' : raw.source === 'parser' && raw.code === 'pj/syntax' ? 'processj-parser' : 'processj',
    tags: raw.code === 'pj/unused' || raw.code === 'pj/unreachable' ? [DiagnosticTag.Unnecessary] : undefined,
    data: fix ? { fix } : undefined,
  };
}

// ---------------------------------------------------------------------------
// Code actions (quick fixes attached to lints)
// ---------------------------------------------------------------------------

connection.onCodeAction((params: CodeActionParams): CodeAction[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const actions: CodeAction[] = [];
  for (const d of params.context.diagnostics) {
    const fix = (d.data as { fix?: FixHint } | undefined)?.fix;
    if (!fix) continue;
    let edit: TextEdit | undefined;
    if (fix.kind === 'add-import') {
      const line = Math.min(fix.line, doc.lineCount);
      const prefix = fix.line > 0 && lineText(doc, fix.line - 1).trim() !== '' ? '\n' : '';
      edit = TextEdit.insert(Position.create(line, 0), `${prefix}import std.*;\n`);
    } else if (fix.kind === 'make-shared') {
      edit = TextEdit.insert(Position.create(fix.line, fix.col), 'shared ');
    } else if (fix.kind === 'edit') {
      edit = TextEdit.replace(Range.create(fix.line, fix.col, fix.line, fix.endCol ?? fix.col), fix.text ?? '');
    }
    if (!edit) continue;
    actions.push({
      title: fix.title,
      kind: CodeActionKind.QuickFix,
      diagnostics: [d],
      isPreferred: true,
      edit: { changes: { [doc.uri]: [edit] } },
    });
  }
  return actions;
});

// ---------------------------------------------------------------------------
// Code lenses + commands: build, run, show generated Java
// ---------------------------------------------------------------------------

connection.onCodeLens((params: CodeLensParams): CodeLens[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc || !install) return [];
  const lenses: CodeLens[] = [];
  for (const s of symbolsFor(doc).symbols) {
    if (s.kind !== 'proc' || s.name !== 'main') continue;
    const range = Range.create(s.line, s.startCol, s.line, s.endCol);
    lenses.push({ range, command: { title: '▶ Run', command: COMMAND_RUN, arguments: [doc.uri] } });
    lenses.push({ range, command: { title: 'Build', command: COMMAND_BUILD, arguments: [doc.uri] } });
  }
  return lenses;
});

// One private directory per server process: reports keep a stable name so the
// editor reuses the tab, without writing to a path another user could pre-create.
let runsDir: string | undefined;

connection.onExecuteCommand(async (params: ExecuteCommandParams) => {
  const uri = String(params.arguments?.[0] ?? '');
  const doc = documents.get(uri);
  if (!doc) {
    connection.window.showErrorMessage('processj-lsp: open the .pj file first');
    return null;
  }
  if (!install) {
    connection.window.showErrorMessage(`processj-lsp: ${installError}`);
    return null;
  }
  const sourcePath = safeFileUri(uri) ?? 'buffer.pj';
  const fileName = path.basename(sourcePath);
  const stem = path.basename(fileName, '.pj');

  connection.window.showInformationMessage(`ProcessJ: building ${fileName}…`);
  const built = await build(install, sourcePath, doc.getText(), { timeoutMs: settings.timeoutMs * 3 });
  try {
    if (!built.ok) {
      const target = await showReport(`${stem}.build.txt`, formatReport(fileName, built.stages));
      const failed = built.stages.find((s) => !s.ok);
      connection.window.showErrorMessage(`ProcessJ: ${failed?.name ?? 'build'} failed`);
      return target;
    }

    if (params.command === COMMAND_BUILD) {
      const target = await showReport(`${stem}.build.txt`, formatReport(fileName, built.stages));
      connection.window.showInformationMessage(`ProcessJ: ${fileName} built successfully`);
      return target;
    }

    const result = await run(install, built, { timeoutMs: settings.runTimeoutMs });
    const target = await showReport(`${stem}.run.txt`, formatReport(fileName, result.stages, { output: result.output, exitCode: result.exitCode, timedOut: result.timedOut }));
    if (result.timedOut) connection.window.showWarningMessage(`ProcessJ: ${fileName} did not finish within ${settings.runTimeoutMs} ms (deadlock?)`);
    else connection.window.showInformationMessage(`ProcessJ: ${fileName} finished (exit ${result.exitCode}) in ${result.durationMs} ms`);
    return target;
  } finally {
    built.sandbox.cleanup();
  }
});

/** Write text to a stable per-file path under the temp dir and ask the editor to open it. */
async function showReport(name: string, content: string): Promise<string> {
  if (!runsDir || !fs.existsSync(runsDir)) runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'processj-lsp-runs-'));
  const target = path.join(runsDir, name);
  fs.writeFileSync(target, content);
  if (clientSupportsShowDocument) {
    await connection.window.showDocument({ uri: pathToFileURL(target).toString(), external: false, takeFocus: true });
  } else {
    connection.console.log(content);
  }
  return target;
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
    connection.window.showWarningMessage(`ProcessJ: not formatted, fix ${n} syntax error${n === 1 ? '' : 's'} first (line ${result.errors[0].line + 1}: ${result.errors[0].message})`);
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

connection.onDocumentSymbol((params: DocumentSymbolParams) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  return symbolsFor(doc).symbols.map((s) => toDocumentSymbol(doc, s));
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
  ['timer', 'timer ${1:t};\n$1.timeout(${2:1000});', 'Declare a timer and wait'],
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
        { label: 'timeout(ms)', kind: CompletionItemKind.Method, insertText: 'timeout($0)', insertTextFormat: InsertTextFormat.Snippet, detail: 'Block for the given milliseconds, or use as an alt guard' },
      ];
    }
    const wanted = t?.k === 'chan' ? (t.end === 'read' ? ['read()'] : t.end === 'write' ? ['write(...)'] : ['read()', 'write(...)', 'read', 'write']) : t?.k === 'prim' && t.name === 'barrier' ? ['sync()', 'resign()'] : undefined;
    if (!wanted) return [];
    for (const [label, insert, doc] of MEMBER_COMPLETIONS) {
      if (!wanted.includes(label)) continue;
      items.push({ label, kind: CompletionItemKind.Method, insertText: insert, insertTextFormat: InsertTextFormat.Snippet, detail: doc });
    }
    return items;
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
  return { isIncomplete, items };
});

/** Type of the widest checked expression that ends exactly at `endCol` on `line`. */
function receiverTypeAt(checked: CheckResult, line: number, endCol: number): Type | undefined {
  let best: { start: number; type: Type } | undefined;
  for (const [expr, type] of checked.types) {
    const span = expr.span;
    if (span.end.line !== line || span.end.col !== endCol || span.start.line !== line) continue;
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
  const r = resolve(doc, params.position);
  if (!r) return null;

  if (r.hits.length === 0) {
    const kw = KEYWORD_DOCS[r.word];
    if (kw) return { contents: { kind: MarkupKind.Markdown, value: `**${r.word}**\n\n${kw}` } };
    const t = typeAtPosition(doc, params.position);
    if (t) return { contents: { kind: MarkupKind.Markdown, value: `\`\`\`processj\n${t}\n\`\`\`` } };
    return null;
  }

  const exprType = typeAtPosition(doc, params.position);
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
  return { contents: { kind: MarkupKind.Markdown, value: parts.join('\n\n---\n\n') } };
});

/** Type of the smallest expression containing the position, from the checker. */
const typePositionCache = new WeakMap<CheckResult, { byLine: Map<number, Array<[A.Expr, Type]>>; multiline: Array<[A.Expr, Type]> }>();

function typeAtPosition(doc: TextDocument, pos: Position): string | undefined {
  const { checked } = checkFor(doc);
  let positionIndex = typePositionCache.get(checked);
  if (!positionIndex) {
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
  }
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

function indexedBindingFile(analysis: Analysis, kind: PJSymbol['kind'], name: string): string | undefined {
  if (kind === 'record') return analysis.index.records.get(name)?.file;
  if (kind === 'protocol') return analysis.index.protocols.get(name)?.file;
  if (kind === 'const') return analysis.index.consts.get(name)?.file;
  return undefined;
}

function callTargets(sig: ProcSig, targetFile: string | undefined, targetUri: string, sourceUri: string, target?: ProcSig): boolean {
  const fileMatches = targetFile ? sameFile(sig.file, targetFile) : !sig.file && targetUri === sourceUri;
  return fileMatches && (!target || sameSignature(sig, target));
}

function procedureReferenceSpans(program: A.Program, analysis: Analysis, name: string, targetFile: string | undefined, targetUri: string, sourceUri: string, target: ProcSig): A.Span[] {
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

function constantReferenceSpans(analysis: Analysis, name: string): A.Span[] {
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
    const analysis = analyzeProgram(program, file);
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
  const refs = referencesOf(doc, params.position);
  if (!refs) return null;
  const changes: Record<string, TextEdit[]> = {};
  for (const loc of refs.locations) (changes[loc.uri] ??= []).push(TextEdit.replace(loc.range, params.newName));
  return { changes };
});

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

documents.listen(connection);
connection.listen();
