import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  ExecuteCommandRequest,
  LanguageClient,
  State,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from 'vscode-languageclient/node';
import { refreshConcurrencyGraph, showConcurrencyGraph, showProtocolGraph, type GraphFocus } from './graphPanel';

const DOCUMENT_SELECTOR = [
  { scheme: 'file', language: 'processj' },
  { scheme: 'untitled', language: 'processj' },
];

let client: LanguageClient | undefined;
let clientStateSubscription: vscode.Disposable | undefined;
let languageStatus: vscode.LanguageStatusItem | undefined;
let restartTimer: NodeJS.Timeout | undefined;
let recreateOnRestart = false;
let lifecycle: Promise<void> = Promise.resolve();

/** Settings forwarded to the server as initialization options; the server validates and defaults them. */
const SERVER_SETTINGS = ['installDir', 'javaBin', 'debounceMs', 'timeoutMs', 'checkOnChange', 'runTimeoutMs', 'lint', 'codeLens', 'liveViewer', 'fdrPath', 'fdrTimeoutMs', 'fdrMemoryMb', 'fdrWorkers', 'fdrShowGraph'] as const;
/**
 * Settings the server reads afresh for each FDR check: a change is sent to the
 * running server (workspace/didChangeConfiguration), which keeps its results.
 */
const LIVE_SETTINGS = ['fdrPath', 'fdrTimeoutMs', 'fdrMemoryMb', 'fdrWorkers', 'fdrShowGraph'] as const;
/**
 * Any of these changing needs a fresh initialize handshake. `liveViewer` only
 * affects the browser page other editors open (this extension shows the graph in
 * its own panel), so changing it waits for the next start.
 */
const RESTART_SETTINGS = [...SERVER_SETTINGS.filter((setting) => setting !== 'liveViewer' && !(LIVE_SETTINGS as readonly string[]).includes(setting)), 'serverPath'] as const;


export async function activate(context: vscode.ExtensionContext): Promise<void> {
  languageStatus = vscode.languages.createLanguageStatusItem('processj.serverStatus', DOCUMENT_SELECTOR);
  languageStatus.name = 'ProcessJ language server';
  languageStatus.command = {
    command: 'processj.showOutput',
    title: 'Show ProcessJ Language Server Output',
  };
  context.subscriptions.push(languageStatus);
  setStatus(State.Starting);

  // vscode-languageclient registers every command the server advertises under the server's own id:
  // a client command reusing one of those ids stops the client from starting (test/graph-lsp.test.ts checks).
  context.subscriptions.push(
    vscode.commands.registerCommand('processj.runCurrentFile', () => executeForActiveEditor('processj.run')),
    vscode.commands.registerCommand('processj.buildCurrentFile', () => executeForActiveEditor('processj.build')),
    vscode.commands.registerCommand('processj.showConcurrencyGraph', async (uri?: string | vscode.Uri, focus?: GraphFocus) => {
      if (!client?.isRunning()) {
        void vscode.window.showWarningMessage('ProcessJ: the language server is not ready.');
        return;
      }
      await showConcurrencyGraph(client, uri, focus && typeof focus === 'object' ? focus : undefined);
    }),
    vscode.commands.registerCommand('processj.exportConcurrencyGraphFiles', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'processj') {
        void vscode.window.showWarningMessage('ProcessJ: open a ProcessJ editor first.');
        return;
      }
      if (!client?.isRunning()) {
        void vscode.window.showWarningMessage('ProcessJ: the language server is not ready.');
        return;
      }
      const choice = await vscode.window.showQuickPick([
        { label: 'All formats', format: 'all', description: 'SVG, Excalidraw and the HTML viewer' },
        { label: 'SVG', format: 'svg', description: 'the network, with the end state of the first failure' },
        { label: 'Excalidraw', format: 'excalidraw', description: 'an editable scene with bound arrows' },
        { label: 'HTML viewer', format: 'html', description: 'a self-contained page with every view and result' },
        { label: 'JSON', format: 'json', description: 'model, layout and verification results' },
      ], { placeHolder: 'Export the concurrency graph next to the source file' });
      if (!choice) return;
      await client.sendRequest('workspace/executeCommand', { command: 'processj.exportConcurrencyGraph', arguments: [editor.document.uri.toString(), choice.format] });
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.languageId === 'processj' && client?.isRunning()) void refreshConcurrencyGraph(client, document.uri.toString());
    }),
    vscode.commands.registerCommand('processj.showProtocolFlow', async () => {
      if (!client?.isRunning()) {
        void vscode.window.showWarningMessage('ProcessJ: the language server is not ready.');
        return;
      }
      await showProtocolGraph(client);
    }),
    vscode.commands.registerCommand('processj.showProcedureEffects', () => executeForActiveEditor('processj.showEffectReport')),
    vscode.commands.registerCommand('processj.convertCurrentFileToCsp', () => executeOnTarget('processj.convertToCsp', 'Convert to CSP')),
    vscode.commands.registerCommand('processj.checkCurrentFileWithFdr', () => executeOnTarget('processj.checkWithFdr', 'Check with FDR')),
    vscode.commands.registerCommand('processj.cancelFdrCheck', () => {
      if (!client?.isRunning()) return undefined;
      const uri = vscode.window.activeTextEditor?.document.languageId === 'processj' ? vscode.window.activeTextEditor.document.uri.toString() : undefined;
      return client.sendRequest(ExecuteCommandRequest.type, { command: 'processj.cancelFdr', arguments: uri ? [uri] : [] });
    }),
    vscode.commands.registerCommand('processj.showOutput', () => {
      if (client) client.outputChannel.show(true);
      else void vscode.window.showWarningMessage('ProcessJ: the language server has not started.');
    }),
    vscode.commands.registerCommand('processj.restartServer', async () => {
      const started = await queueLifecycle(() => restartClient(context, false));
      if (started) void vscode.window.showInformationMessage('ProcessJ: language server restarted.');
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      // FDR's settings apply to the next check: told to the running server, nothing restarts (its results stay).
      const live = LIVE_SETTINGS.filter((setting) => event.affectsConfiguration(`processj.${setting}`));
      if (live.length && client?.isRunning()) {
        const config = vscode.workspace.getConfiguration('processj');
        void client.sendNotification('workspace/didChangeConfiguration', { settings: { processj: Object.fromEntries(live.map((setting) => [setting, config.get(setting)])) } });
      }
      if (!RESTART_SETTINGS.some((setting) => event.affectsConfiguration(`processj.${setting}`))) return;
      recreateOnRestart ||= event.affectsConfiguration('processj.serverPath');
      if (restartTimer) clearTimeout(restartTimer);
      // The settings UI can emit several events for one edit; restart once with the final values.
      restartTimer = setTimeout(() => {
        restartTimer = undefined;
        const serverPathChanged = recreateOnRestart;
        recreateOnRestart = false;
        void queueLifecycle(() => restartClient(context, serverPathChanged));
      }, 200);
    }),
    {
      dispose: () => {
        if (restartTimer) clearTimeout(restartTimer);
        restartTimer = undefined;
        recreateOnRestart = false;
        clientStateSubscription?.dispose();
        clientStateSubscription = undefined;
      },
    },
  );

  await queueLifecycle(() => startClient(context));
}

export function deactivate(): Thenable<void> | undefined {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = undefined;
  recreateOnRestart = false;
  return queueLifecycle(async () => {
    clientStateSubscription?.dispose();
    clientStateSubscription = undefined;
    const current = client;
    client = undefined;
    if (current) await current.dispose();
  });
}

async function executeForActiveEditor(command: 'processj.run' | 'processj.build' | 'processj.showEffectReport'): Promise<unknown> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'processj') {
    void vscode.window.showWarningMessage('ProcessJ: open a ProcessJ editor first.');
    return undefined;
  }
  if (!client?.isRunning()) {
    void vscode.window.showWarningMessage('ProcessJ: the language server is not ready. Run ProcessJ: Restart Language Server and check its output.');
    return undefined;
  }
  return client.sendRequest('workspace/executeCommand', {
    command,
    arguments: [editor.document.uri.toString()],
  });
}

/**
 * Convert to CSP / Check with FDR: the whole program or one procedure, picked
 * from the file's procedures (the server's document symbols).
 */
async function executeOnTarget(command: 'processj.convertToCsp' | 'processj.checkWithFdr', title: string): Promise<unknown> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'processj') {
    void vscode.window.showWarningMessage('ProcessJ: open a ProcessJ editor first.');
    return undefined;
  }
  if (!client?.isRunning()) {
    void vscode.window.showWarningMessage('ProcessJ: the language server is not ready. Run ProcessJ: Restart Language Server and check its output.');
    return undefined;
  }
  const uri = editor.document.uri;
  const symbols = (await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>('vscode.executeDocumentSymbolProvider', uri)) ?? [];
  const procedures = symbols
    .filter((s) => s.kind === vscode.SymbolKind.Function)
    .map((s) => ({ name: s.name, line: 'selectionRange' in s ? s.selectionRange.start.line : s.location.range.start.line }));
  type Pick = vscode.QuickPickItem & { procedure?: { name: string; line: number } };
  // main is the whole program: checking it by name would be the same check.
  const items: Pick[] = [
    ...(procedures.some((p) => p.name === 'main') ? [{ label: 'Whole program', description: 'from main' }] : []),
    ...procedures.filter((p) => p.name !== 'main').map((p) => ({ label: p.name, description: `procedure, line ${p.line + 1}`, procedure: p })),
  ];
  if (!items.length) {
    void vscode.window.showWarningMessage('ProcessJ: this file has no procedures to translate.');
    return undefined;
  }
  const picked = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { title: `ProcessJ: ${title}`, placeHolder: 'The whole program, or one procedure checked on its own' });
  if (!picked) return undefined;
  const args: unknown[] = [uri.toString()];
  if (picked.procedure) args.push(picked.procedure.name, picked.procedure.line);
  if (command === 'processj.checkWithFdr') return checkWithProgress(client, args);
  return client.sendRequest(ExecuteCommandRequest.type, { command, arguments: args });
}

/**
 * An FDR check with a notification that can be cancelled: cancelling sends
 * $/cancelRequest, and the server stops refines. (The server's own progress
 * is shown in the status bar, which has no cancel button.)
 */
function checkWithProgress(languageClient: LanguageClient, args: unknown[]): Thenable<unknown> {
  const target = typeof args[1] === 'string' ? `procedure ${args[1]}` : 'the program';
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `ProcessJ: checking ${target} with FDR`, cancellable: true },
    (_progress, token) => languageClient.sendRequest(ExecuteCommandRequest.type, { command: 'processj.checkWithFdr', arguments: args }, token),
  );
}

/** Keep starts, restarts and shutdown ordered when settings change rapidly. */
function queueLifecycle<T>(task: () => Promise<T>): Promise<T> {
  const next = lifecycle.then(task, task);
  lifecycle = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function readOptions(): Record<(typeof SERVER_SETTINGS)[number] | 'verificationNotifications' | 'graphPanel', unknown> {
  const config = vscode.workspace.getConfiguration('processj');
  // Empty strings and unset values are left for the server's normalizeSettings to default.
  return {
    ...Object.fromEntries(SERVER_SETTINGS.map((key) => [key, config.get(key)])) as Record<(typeof SERVER_SETTINGS)[number], unknown>,
    // The graph panel refreshes when a model checker publishes results: ask for processj/verificationChanged.
    verificationNotifications: true,
    // The graph is shown in this extension's panel: the server sends processj/showGraph instead of opening a browser page.
    graphPanel: true,
  };
}

function configuredServer(context: vscode.ExtensionContext): string {
  const configured = vscode.workspace.getConfiguration('processj').get<string>('serverPath', '').trim();
  if (!configured) return path.join(context.extensionPath, 'server', 'bin', 'processj-lsp.js');
  if (configured === '~') return os.homedir();
  if (configured.startsWith('~/') || configured.startsWith('~\\')) return path.join(os.homedir(), configured.slice(2));
  return configured;
}

async function startClient(context: vscode.ExtensionContext): Promise<boolean> {
  const serverModule = configuredServer(context);
  if (!isFile(serverModule)) {
    setStatusError(`Language server not found at ${serverModule}`, true);
    void vscode.window.showErrorMessage(
      `ProcessJ: language server not found at ${serverModule}. Build the extension with "npm run build" in the vscode/ folder, or set processj.serverPath.`,
    );
    return false;
  }

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.stdio },
    debug: { module: serverModule, transport: TransportKind.stdio, options: { execArgv: ['--inspect=6009'] } },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: DOCUMENT_SELECTOR,
    // The server dynamically registers its own **/*.pj watcher. Adding a static
    // synchronize.fileEvents watcher here would deliver every disk change twice.
    // A function is intentional: LanguageClient calls it again after a restart, so settings apply live.
    initializationOptions: readOptions,
    outputChannelName: 'ProcessJ',
    middleware: {
      // The server's graph lenses ("Concurrency graph", an FDR verdict) open a browser page in other
      // editors; here they open the panel (an FDR verdict on its result).
      provideCodeLenses: async (document, token, next) => {
        const lenses = await next(document, token);
        for (const lens of lenses ?? []) {
          if (lens.command?.command === 'processj.showConcurrencyReport') lens.command = { ...lens.command, command: 'processj.showConcurrencyGraph', arguments: [document.uri.toString(), lens.command.arguments?.[2]] };
        }
        return lenses;
      },
      // The FDR lens runs the server command directly; give it the cancellable notification too.
      executeCommand: (command, args, next) => (command === 'processj.checkWithFdr' && client ? checkWithProgress(client, args) : next(command, args)),
    },
  };

  const next = new LanguageClient('processj', 'ProcessJ Language Server', serverOptions, clientOptions);
  client = next;
  clientStateSubscription?.dispose();
  clientStateSubscription = next.onDidChangeState(({ newState }) => setStatus(newState));
  setStatus(State.Starting);
  try {
    await next.start();
    // Results from a model checker can arrive while the panel is open.
    next.onNotification('processj/verificationChanged', (params: { uri?: string }) => {
      if (typeof params?.uri === 'string') void refreshConcurrencyGraph(next, params.uri);
    });
    // A check that failed, an FDR lens, a diagnostic's Show in graph: the panel opens on that result.
    next.onNotification('processj/showGraph', (params: { uri?: string; focus?: GraphFocus }) => {
      if (typeof params?.uri === 'string') void showConcurrencyGraph(next, params.uri, params.focus && typeof params.focus === 'object' ? params.focus : undefined);
    });
    setStatus(State.Running);
    return true;
  } catch (error) {
    setStatusError(error instanceof Error ? error.message : String(error));
    void vscode.window.showErrorMessage(`ProcessJ: language server failed to start. ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

async function restartClient(context: vscode.ExtensionContext, recreate: boolean): Promise<boolean> {
  // LanguageClient.restart() only works from the Running state: after a failed
  // start it rethrows the cached failure forever, so start a fresh client instead.
  if (recreate || !client || client.state !== State.Running) {
    clientStateSubscription?.dispose();
    clientStateSubscription = undefined;
    const current = client;
    client = undefined;
    if (current) await current.dispose();
    return startClient(context);
  }

  setStatus(State.Starting);
  try {
    await client.restart();
    setStatus(State.Running);
    return true;
  } catch (error) {
    setStatusError(error instanceof Error ? error.message : String(error));
    void vscode.window.showErrorMessage(`ProcessJ: language server failed to restart. ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function setStatus(state: State): void {
  if (!languageStatus) return;
  const config = vscode.workspace.getConfiguration('processj');
  languageStatus.command = {
    command: 'processj.showOutput',
    title: 'Show ProcessJ Language Server Output',
  };
  languageStatus.accessibilityInformation = {
    label: state === State.Running ? 'ProcessJ language server ready' : state === State.Starting ? 'ProcessJ language server starting' : 'ProcessJ language server stopped',
  };

  if (state === State.Running) {
    const version = client?.initializeResult?.serverInfo?.version;
    const compilerPolicy = config.get<boolean>('checkOnChange', false) ? 'compiler policy: while typing' : 'compiler policy: open and save';
    languageStatus.text = '$(check) ProcessJ ready';
    languageStatus.detail = `${version ? `Server ${version}; ` : ''}${config.get<boolean>('lint', true) ? 'lint on' : 'lint off'}; ${compilerPolicy}`;
    languageStatus.severity = vscode.LanguageStatusSeverity.Information;
    languageStatus.busy = false;
  } else if (state === State.Starting) {
    languageStatus.text = '$(sync~spin) ProcessJ starting';
    languageStatus.detail = 'Starting the ProcessJ language server';
    languageStatus.severity = vscode.LanguageStatusSeverity.Information;
    languageStatus.busy = true;
  } else {
    languageStatus.text = '$(error) ProcessJ stopped';
    languageStatus.detail = 'Open the language server output for details, then run ProcessJ: Restart Language Server';
    languageStatus.severity = vscode.LanguageStatusSeverity.Error;
    languageStatus.busy = false;
  }
}

function setStatusError(detail: string, openSettings = false): void {
  if (!languageStatus) return;
  languageStatus.text = '$(error) ProcessJ unavailable';
  languageStatus.detail = detail;
  languageStatus.severity = vscode.LanguageStatusSeverity.Error;
  languageStatus.busy = false;
  languageStatus.accessibilityInformation = { label: `ProcessJ language server unavailable: ${detail}` };
  languageStatus.command = openSettings
    ? {
        command: 'workbench.action.openSettings',
        title: 'Open ProcessJ Settings',
        arguments: ['@ext:arianizadi.processj-lsp-vscode'],
      }
    : {
        command: 'processj.showOutput',
        title: 'Show ProcessJ Language Server Output',
      };
}
