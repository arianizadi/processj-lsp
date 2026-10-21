/**
 * The language server's connection to its editor, and what the server may do
 * where it runs. Here: Node, talking over stdio, IPC, a socket or a pipe (as
 * vscode-languageserver/node chooses from the command line), on the disk the
 * editor shares. The browser build (scripts/build-browser.mjs) puts
 * connection.browser.ts in place of this module.
 */
import { createConnection, ProposedFeatures } from 'vscode-languageserver/node';

export interface Platform {
  /** The server can start processes: the compiler, a program, FDR's refines. */
  processes: boolean;
  /**
   * Files live in this process's memory rather than on a disk the editor
   * shares: the client writes and reads them with processj/writeFiles,
   * processj/deleteFiles and processj/readFile, and hears of every file the
   * server writes (processj/fileWritten).
   */
  memoryFiles: boolean;
}

export const connection = createConnection(ProposedFeatures.all);

export const platform: Platform = { processes: true, memoryFiles: false };
