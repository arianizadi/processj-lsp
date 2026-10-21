/**
 * processj-lsp in a Web Worker: the entry of the browser build
 * (scripts/build-browser.mjs, dist/browser/processj-lsp.worker.js). It is
 * the same server as the editors run. The build swaps connection.ts for
 * connection.browser.ts (LSP over the worker's postMessage port) and Node's
 * built-in modules for the ones in this folder: files in memory, which the
 * page writes with processj/writeFiles. The compiler and FDR run on the
 * page's runner when it offers one (initializationOptions.browser, see
 * src/remote.ts). Setup comes first: the server finds its install as it
 * starts.
 */
import './setup';
import '../server';
