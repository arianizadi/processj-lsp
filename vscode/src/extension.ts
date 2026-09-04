import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  LanguageClient,
  State,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from 'vscode-languageclient/node';
import { showConcurrencyGraph, showProtocolGraph } from './graphPanel';

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
const SERVER_SETTINGS = ['installDir', 'javaBin', 'debounceMs', 'timeoutMs', 'checkOnChange', 'runTimeoutMs', 'lint', 'codeLens'] as const;
/** Any of these changing needs a fresh initialize handshake. */
const RESTART_SETTINGS = [...SERVER_SETTINGS, 'serverPath'] as const;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  languageStatus = vscode.languages.createLanguageStatusItem('processj.serverStatus', DOCUMENT_SELECTOR);
  languageStatus.name = 'ProcessJ language server';
  languageStatus.command = {
    command: 'processj.showOutput',
    title: 'Show ProcessJ Language Server Output',
  };
  context.subscriptions.push(languageStatus);
  setStatus(State.Starting);

  context.subscriptions.push(
    vscode.commands.registerCommand('processj.runCurrentFile', () => executeForActiveEditor('processj.run')),
    vscode.commands.registerCommand('processj.buildCurrentFile', () => executeForActiveEditor('processj.build')),
    vscode.commands.registerCommand('processj.showConcurrencyGraph', async () => {
      if (!client?.isRunning()) {
        void vscode.window.showWarningMessage('ProcessJ: the language server is not ready.');
        return;
      }
      await showConcurrencyGraph(client);
    }),
    vscode.commands.registerCommand('processj.showProtocolFlow', async () => {
      if (!client?.isRunning()) {
        void vscode.window.showWarningMessage('ProcessJ: the language server is not ready.');
        return;
      }
      await showProtocolGraph(client);
    }),
    vscode.commands.registerCommand('processj.showProcedureEffects', () => executeForActiveEditor('processj.showEffectReport')),
    vscode.commands.registerCommand('processj.showOutput', () => {
      if (client) client.outputChannel.show(true);
      else void vscode.window.showWarningMessage('ProcessJ: the language server has not started.');
    }),
    vscode.commands.registerCommand('processj.restartServer', async () => {
      const started = await queueLifecycle(() => restartClient(context, false));
      if (started) void vscode.window.showInformationMessage('ProcessJ: language server restarted.');
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
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

/** Keep starts, restarts and shutdown ordered when settings change rapidly. */
function queueLifecycle<T>(task: () => Promise<T>): Promise<T> {
  const next = lifecycle.then(task, task);
  lifecycle = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function readOptions(): Record<(typeof SERVER_SETTINGS)[number], unknown> {
  const config = vscode.workspace.getConfiguration('processj');
  // Empty strings and unset values are left for the server's normalizeSettings to default.
  return Object.fromEntries(SERVER_SETTINGS.map((key) => [key, config.get(key)])) as Record<(typeof SERVER_SETTINGS)[number], unknown>;
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
  };

  const next = new LanguageClient('processj', 'ProcessJ Language Server', serverOptions, clientOptions);
  client = next;
  clientStateSubscription?.dispose();
  clientStateSubscription = next.onDidChangeState(({ newState }) => setStatus(newState));
  setStatus(State.Starting);
  try {
    await next.start();
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
  if (recreate || !client) {
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
