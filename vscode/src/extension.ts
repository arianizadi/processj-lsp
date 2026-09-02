import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { LanguageClient, TransportKind, type LanguageClientOptions, type ServerOptions } from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('processj');
  const configured = config.get<string>('serverPath', '');
  const bundled = path.join(context.extensionPath, 'server', 'bin', 'processj-lsp.js');
  const serverModule = configured || bundled;
  if (!fs.existsSync(serverModule)) {
    void vscode.window.showErrorMessage(`ProcessJ: language server not found at ${serverModule}. Build the extension with "npm run build" in the vscode/ folder, or set processj.serverPath.`);
    return;
  }

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.stdio },
    debug: { module: serverModule, transport: TransportKind.stdio, options: { execArgv: ['--inspect=6009'] } },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'processj' }],
    synchronize: { fileEvents: vscode.workspace.createFileSystemWatcher('**/*.pj') },
    initializationOptions: {
      installDir: config.get<string>('installDir') || undefined,
      checkOnChange: config.get<boolean>('checkOnChange', false),
      lint: config.get<boolean>('lint', true),
    },
  };
  client = new LanguageClient('processj', 'ProcessJ Language Server', serverOptions, clientOptions);
  await client.start();
  context.subscriptions.push({ dispose: () => void client?.stop() });
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
