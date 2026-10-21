/**
 * connection.ts for the browser build: the server runs in a Web Worker and
 * talks LSP over the worker's own postMessage port. Nothing can be started
 * here, and the project's files are an in-memory file system (src/browser/fs.ts)
 * that the page fills.
 */
import { BrowserMessageReader, BrowserMessageWriter, createConnection, ProposedFeatures } from 'vscode-languageserver/browser';
import type { Platform } from './connection';

export type { Platform } from './connection';

export const connection = createConnection(ProposedFeatures.all, new BrowserMessageReader(self), new BrowserMessageWriter(self));

export const platform: Platform = { processes: false, memoryFiles: true };
