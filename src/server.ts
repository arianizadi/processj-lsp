import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CodeAction,
  CodeActionKind,
  CodeLens,
  CompletionItem,
  CompletionItemKind,
  createConnection,
  Diagnostic,
  DiagnosticSeverity,
  DocumentSymbol,
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
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

import { analyze, type FixHint, type LintDiagnostic } from './analysis';
import { astSymbols } from './astsymbols';
import { compile } from './compiler';
import { format } from './format';
import type * as A from './parser/ast';
import { parse, type ParseResult } from './parser/parser';
import { findInstall, type Install } from './config';
import { parseCompilerOutput, type RawDiagnostic } from './diagnostics';
import { KEYWORD_DOCS, KEYWORDS, LITERALS, PRIMITIVE_TYPES } from './keywords';
import { indexLibrary, type LibrarySymbol } from './library';
import { build, formatReport, run } from './pipeline';
import { extractLocals, extractSymbols, wordAt, type PJSymbol } from './symbols';
import { tokenize } from './tokens';
import { WorkspaceIndex } from './workspace';

interface Settings {
  installDir?: string;
  javaBin?: string;
  /** Delay after the last keystroke before the compiler runs. */
  debounceMs: number;
  /** Kill the compiler after this long. */
  timeoutMs: number;
  /** Run the compiler on every change (true) or only on open/save (false). */
  checkOnChange: boolean;
  /** Kill a program started from the "Run" code lens after this long. */
  runTimeoutMs: number;
  /** Turn the built-in static analysis on or off. */
  lint: boolean;
}

const COMMAND_RUN = 'processj.run';
const COMMAND_SHOW_JAVA = 'processj.showGeneratedJava';
const COMMAND_BUILD = 'processj.build';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const workspace = new WorkspaceIndex();

let settings: Settings = { debounceMs: 400, timeoutMs: 20_000, checkOnChange: true, runTimeoutMs: 30_000, lint: true };
let install: Install | undefined;
let installError: string | undefined;
let library: LibrarySymbol[] = [];
let libraryNames = new Set<string>();
let clientSupportsShowDocument = false;

// Per-document state for debounced, cancellable compiles.
const pending = new Map<string, NodeJS.Timeout>();
const running = new Map<string, AbortController>();
// Last compiler diagnostics per document, so lints (which are instant) can be merged with them.
const compilerDiags = new Map<string, { version: number; diagnostics: Diagnostic[] }>();
// Cached parse and symbol extraction keyed by document version.
const parseCache = new Map<string, { version: number; parsed: ParseResult }>();
const symbolCache = new Map<string, { version: number; symbols: PJSymbol[]; locals: PJSymbol[] }>();
// Lint runs are coalesced so a burst of keystrokes in a large file costs one pass.
const lintPending = new Map<string, NodeJS.Timeout>();
const LINT_DELAY_MS = 40;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const init = (params.initializationOptions ?? {}) as Partial<Settings>;
  settings = { ...settings, ...init };
  clientSupportsShowDocument = !!params.capabilities.window?.showDocument?.support;

  const found = findInstall({ installDir: settings.installDir, javaBin: settings.javaBin });
  if ('error' in found) {
    installError = found.error;
  } else {
    install = found;
    library = indexLibrary(install.includeDir);
    libraryNames = new Set(library.filter((l) => l.kind === 'proc').map((l) => l.name));
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
      signatureHelpProvider: { triggerCharacters: ['(', ','], retriggerCharacters: [','] },
      codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
      codeLensProvider: { resolveProvider: false },
      executeCommandProvider: { commands: [COMMAND_RUN, COMMAND_SHOW_JAVA, COMMAND_BUILD] },
      documentFormattingProvider: true,
      foldingRangeProvider: true,
    },
    serverInfo: { name: 'processj-lsp', version: '0.3.0' },
  };
});

connection.onInitialized(() => {
  if (install) {
    connection.console.info(`ProcessJ install: ${install.installDir} (java: ${install.javaBin}); ${library.length} library symbols`);
  } else {
    connection.console.error(installError ?? 'ProcessJ install not found');
    connection.window.showWarningMessage(`processj-lsp: ${installError}. Compiler diagnostics and Run are disabled; lints, completion and navigation still work.`);
  }
});

documents.onDidOpen((e) => {
  schedulePublish(e.document);
  scheduleCheck(e.document, 0);
});
documents.onDidChangeContent((e) => {
  schedulePublish(e.document);
  if (settings.checkOnChange) scheduleCheck(e.document, settings.debounceMs);
});
documents.onDidSave((e) => scheduleCheck(e.document, 0));
documents.onDidClose((e) => {
  cancel(e.document.uri);
  const t = lintPending.get(e.document.uri);
  if (t) clearTimeout(t);
  lintPending.delete(e.document.uri);
  parseCache.delete(e.document.uri);
  symbolCache.delete(e.document.uri);
  compilerDiags.delete(e.document.uri);
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
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

function cancel(uri: string): void {
  const t = pending.get(uri);
  if (t) {
    clearTimeout(t);
    pending.delete(uri);
  }
  running.get(uri)?.abort();
  running.delete(uri);
}

function scheduleCheck(doc: TextDocument, delayMs: number): void {
  if (!install) return;
  const t = pending.get(doc.uri);
  if (t) clearTimeout(t);
  pending.set(
    doc.uri,
    setTimeout(() => {
      pending.delete(doc.uri);
      void runCheck(doc.uri);
    }, delayMs),
  );
}

function lintDiagnostics(doc: TextDocument): Diagnostic[] {
  const parsed = parsedFor(doc);
  const syntax: Diagnostic[] = parsed.errors.map((e) =>
    makeDiagnostic(doc, { line: e.line, startCol: e.col, endCol: e.endCol, message: e.message, severity: 'error', code: 'pj/syntax', source: 'parser' }),
  );
  if (!settings.lint) return syntax;
  const { symbols, locals } = symbolsFor(doc);
  const lints = analyze(doc.getText(), symbols, locals, { libraryNames }).map((d) => makeDiagnostic(doc, d));
  return [...syntax, ...lints];
}

/** Send the current lints plus the most recent compiler results (if still for this version). */
function publish(doc: TextDocument): void {
  const lints = lintDiagnostics(doc);
  const fromCompiler = compilerDiags.get(doc.uri);
  const compiler = fromCompiler && fromCompiler.version === doc.version ? fromCompiler.diagnostics : [];
  connection.sendDiagnostics({ uri: doc.uri, diagnostics: mergeDiagnostics(lints, compiler) });
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

async function runCheck(uri: string): Promise<void> {
  const doc = documents.get(uri);
  if (!doc || !install) return;

  running.get(uri)?.abort();
  const controller = new AbortController();
  running.set(uri, controller);

  const version = doc.version;
  const sourcePath = safeFileUri(uri) ?? 'buffer.pj';
  const result = await compile(install, sourcePath, doc.getText(), { timeoutMs: settings.timeoutMs, signal: controller.signal });

  if (running.get(uri) === controller) running.delete(uri);
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
    const quoted = /'([A-Za-z_]\w*)'/.exec(raw.message);
    if (quoted) {
      const idx = indexOfWord(text, quoted[1]);
      if (idx >= 0) {
        start = idx;
        end = idx + quoted[1].length;
      }
    }
  }
  if (end <= start) end = start + 1;

  const severity =
    raw.severity === 'error' ? DiagnosticSeverity.Error : raw.severity === 'warning' ? DiagnosticSeverity.Warning : raw.source === 'lsp' ? DiagnosticSeverity.Hint : DiagnosticSeverity.Information;
  const fix = (raw as LintDiagnostic).fix;
  return {
    range: Range.create(line, start, line, end),
    message,
    severity,
    code: raw.code,
    source: raw.source === 'lsp' ? 'processj-lint' : raw.source === 'parser' && raw.code === 'pj/syntax' ? 'processj-parser' : 'processj',
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
    if (s.kind !== 'proc') continue;
    const range = Range.create(s.line, s.startCol, s.line, s.endCol);
    if (s.name === 'main') {
      lenses.push({ range, command: { title: '▶ Run', command: COMMAND_RUN, arguments: [doc.uri] } });
      lenses.push({ range, command: { title: 'Build', command: COMMAND_BUILD, arguments: [doc.uri] } });
    }
    lenses.push({ range, command: { title: 'Generated Java', command: COMMAND_SHOW_JAVA, arguments: [doc.uri, s.name] } });
  }
  return lenses;
});

const runsDir = path.join(os.tmpdir(), 'processj-lsp-runs');

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
    if (params.command === COMMAND_SHOW_JAVA) {
      if (!built.javaSource) {
        await showReport(`${stem}.build.txt`, formatReport(fileName, built.stages));
        connection.window.showErrorMessage('ProcessJ: code generation failed; see the report');
        return null;
      }
      const target = await showReport(`${stem}.java`, built.javaSource);
      const procName = String(params.arguments?.[1] ?? '');
      if (procName && procName !== 'main') connection.window.showInformationMessage(`Look for _proc$${procName}… or _method$${procName}… in ${path.basename(target)}`);
      return target;
    }

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
  fs.mkdirSync(runsDir, { recursive: true });
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
  ['timeout(ms)', 'timeout($0)', 'Block for the given milliseconds, or use as an alt guard'],
  ['sync()', 'sync()', 'Wait on this barrier until every enrolled process has synced'],
  ['resign()', 'resign()', 'Resign from this barrier'],
  ['size', 'size', 'Length of an array'],
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
  const items: CompletionItem[] = [];

  // Member access: `c.` -> channel/timer/barrier operations.
  if (/[A-Za-z_]\w*\s*\.\s*\w*$/.test(before)) {
    for (const [label, insert, doc] of MEMBER_COMPLETIONS) {
      items.push({ label, kind: CompletionItemKind.Method, insertText: insert, insertTextFormat: InsertTextFormat.Snippet, detail: doc });
    }
    return items;
  }

  const { symbols, locals } = symbolsFor(doc);
  const seen = new Set<string>();
  const add = (item: CompletionItem) => {
    const key = `${item.label}|${item.detail ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };

  const enclosing = symbols.find((s) => s.kind === 'proc' && params.position.line >= s.line && params.position.line <= s.endLine);
  for (const v of locals) {
    if (!enclosing || v.container === enclosing.name) add({ label: v.name, kind: CompletionItemKind.Variable, detail: v.detail });
  }
  for (const s of symbols) {
    add({ label: s.name, kind: completionKind(s), detail: s.detail, documentation: s.doc });
    for (const c of s.children ?? []) add({ label: c.name, kind: completionKind(c), detail: c.detail });
  }
  const ownPath = safeFileUri(doc.uri);
  for (const { file, symbol } of workspace.all(ownPath)) {
    add({ label: symbol.name, kind: completionKind(symbol), detail: `${symbol.detail}  (${path.basename(file)})`, documentation: symbol.doc });
  }
  for (const lib of library) {
    add({ label: lib.name, kind: completionKind(lib), detail: `${lib.detail}  (${lib.pkg}.${lib.module})`, documentation: lib.doc });
  }
  for (const [label, insert, detail] of SNIPPETS) {
    add({ label, kind: CompletionItemKind.Snippet, insertText: insert, insertTextFormat: InsertTextFormat.Snippet, detail, sortText: `zz${label}` });
  }
  for (const k of KEYWORDS) add({ label: k, kind: CompletionItemKind.Keyword, documentation: KEYWORD_DOCS[k] ? { kind: MarkupKind.Markdown, value: KEYWORD_DOCS[k] } : undefined });
  for (const t of PRIMITIVE_TYPES) add({ label: t, kind: CompletionItemKind.TypeParameter });
  for (const l of LITERALS) add({ label: l, kind: CompletionItemKind.Constant });
  return items;
});

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

interface Resolved {
  symbol: PJSymbol;
  uri: string;
  origin: 'local' | 'document' | 'workspace' | 'library';
}

/** Find what an identifier at a position refers to: local, then this file, then workspace, then stdlib. */
function resolve(doc: TextDocument, position: Position): { word: string; hits: Resolved[] } | undefined {
  const w = wordAt(lineText(doc, position.line), position.character);
  if (!w) return undefined;
  const { symbols, locals } = symbolsFor(doc);
  const hits: Resolved[] = [];

  const enclosing = symbols.find((s) => s.kind === 'proc' && position.line >= s.line && position.line <= s.endLine);
  for (const v of locals) {
    if (v.name === w.word && (!enclosing || v.container === enclosing.name) && v.line <= position.line) {
      hits.push({ symbol: v, uri: doc.uri, origin: 'local' });
    }
  }
  if (hits.length) return { word: w.word, hits: [hits[hits.length - 1]] }; // nearest declaration wins

  for (const s of symbols) {
    if (s.name === w.word) hits.push({ symbol: s, uri: doc.uri, origin: 'document' });
    for (const c of s.children ?? []) if (c.name === w.word) hits.push({ symbol: c, uri: doc.uri, origin: 'document' });
  }
  if (hits.length) return { word: w.word, hits };

  for (const { file, symbol } of workspace.lookup(w.word, safeFileUri(doc.uri))) {
    hits.push({ symbol, uri: pathToFileURL(file).toString(), origin: 'workspace' });
  }
  if (hits.length) return { word: w.word, hits };

  for (const lib of library) {
    if (lib.name === w.word) hits.push({ symbol: lib, uri: pathToFileURL(lib.file).toString(), origin: 'library' });
  }
  return { word: w.word, hits };
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
    return null;
  }

  const parts = r.hits.slice(0, 6).map((h) => {
    const where = h.origin === 'library' ? `  — std library (${path.basename((h.symbol as LibrarySymbol).file)})` : h.origin === 'workspace' ? `  — ${path.basename(safeFileUri(h.uri) ?? '')}` : '';
    let s = `\`\`\`processj\n${h.symbol.detail}\n\`\`\`${where}`;
    if (h.symbol.doc) s += `\n\n${h.symbol.doc}`;
    return s;
  });
  return { contents: { kind: MarkupKind.Markdown, value: parts.join('\n\n---\n\n') } };
});

/** Every identifier token equal to `name` inside [fromLine, toLine], skipping member names after `.`. */
function occurrences(text: string, name: string, fromLine: number, toLine: number): Range[] {
  const { tokens } = tokenize(text);
  const out: Range[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'ident' || t.text !== name || t.line < fromLine || t.line > toLine) continue;
    if (i > 0 && tokens[i - 1].kind === 'punct' && tokens[i - 1].text === '.') continue;
    out.push(Range.create(t.line, t.col, t.line, t.end));
  }
  return out;
}

function referencesOf(doc: TextDocument, position: Position): { name: string; locations: Location[] } | undefined {
  const r = resolve(doc, position);
  if (!r || r.hits.length === 0) return undefined;
  const hit = r.hits[0];
  const text = doc.getText();
  const locations: Location[] = [];

  if (hit.origin === 'local') {
    const proc = symbolsFor(doc).symbols.find((s) => s.kind === 'proc' && s.name === hit.symbol.container);
    const from = proc ? proc.line : 0;
    const to = proc ? proc.endLine : doc.lineCount - 1;
    for (const range of occurrences(text, r.word, from, to)) locations.push(Location.create(doc.uri, range));
    return { name: r.word, locations };
  }

  // Top-level symbol: this document plus every workspace file and open document.
  for (const range of occurrences(text, r.word, 0, doc.lineCount - 1)) locations.push(Location.create(doc.uri, range));
  const ownPath = safeFileUri(doc.uri);
  const files = new Set<string>();
  for (const { file } of workspace.all(ownPath)) files.add(file);
  for (const d of documents.all()) {
    const p = safeFileUri(d.uri);
    if (p && p !== ownPath) files.add(p);
  }
  for (const file of files) {
    const open = documents.get(pathToFileURL(file).toString());
    let content: string;
    try {
      content = open ? open.getText() : fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const range of occurrences(content, r.word, 0, Number.MAX_SAFE_INTEGER)) locations.push(Location.create(pathToFileURL(file).toString(), range));
  }
  return { name: r.word, locations };
}

connection.onReferences((params: ReferenceParams) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  return referencesOf(doc, params.position)?.locations ?? null;
});

connection.onPrepareRename((params: PrepareRenameParams) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const r = resolve(doc, params.position);
  if (!r || r.hits.length === 0 || r.hits[0].origin === 'library') return null;
  const w = wordAt(lineText(doc, params.position.line), params.position.character)!;
  return { range: Range.create(params.position.line, w.start, params.position.line, w.end), placeholder: r.word };
});

connection.onRenameRequest((params: RenameParams): WorkspaceEdit | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  if (!/^[A-Za-z_]\w*$/.test(params.newName)) return null;
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

  const { symbols } = symbolsFor(doc);
  const candidates: PJSymbol[] = [
    ...symbols.filter((s) => s.kind === 'proc' && s.name === call.name),
    ...workspace.lookup(call.name, safeFileUri(doc.uri)).map((h) => h.symbol).filter((s) => s.kind === 'proc'),
    ...library.filter((l) => l.kind === 'proc' && l.name === call.name),
  ];
  if (candidates.length === 0) return null;

  const signatures: SignatureInformation[] = candidates.map((c) => ({
    label: c.detail,
    documentation: c.doc,
    parameters: (c.params ?? []).map((p): ParameterInformation => ({ label: p })),
  }));
  const active = Math.max(0, signatures.findIndex((s) => (s.parameters?.length ?? 0) > call.argIndex));
  return { signatures, activeSignature: active, activeParameter: call.argIndex };
});

/** Walk backwards from the cursor to the unmatched `(` and the identifier before it. */
function findCallContext(doc: TextDocument, position: Position): { name: string; argIndex: number } | undefined {
  const text = doc.getText(Range.create(Math.max(0, position.line - 20), 0, position.line, position.character));
  let depth = 0;
  let argIndex = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === ')' || ch === ']') depth++;
    else if (ch === '(' || ch === '[') {
      if (depth === 0) {
        if (ch !== '(') return undefined;
        const head = /([A-Za-z_]\w*)\s*$/.exec(text.slice(0, i));
        if (!head) return undefined;
        return { name: head[1], argIndex };
      }
      depth--;
    } else if (ch === ',' && depth === 0) argIndex++;
    else if ((ch === ';' || ch === '{' || ch === '}') && depth === 0) return undefined;
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
  const re = new RegExp(String.raw`\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\b`);
  const m = re.exec(text);
  return m ? m.index : -1;
}

function safeFileUri(uri: string): string | undefined {
  try {
    return uri.startsWith('file:') ? fileURLToPath(uri) : undefined;
  } catch {
    return undefined;
  }
}

documents.listen(connection);
connection.listen();
