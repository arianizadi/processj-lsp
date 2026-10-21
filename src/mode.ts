/**
 * Where the server runs. In a browser (the web IDE's worker, started with
 * `initializationOptions.browser`) the file system is an in-memory copy of
 * the submitted project: no symbolic links, nothing outside the workspace,
 * and the compiler and FDR run on a remote runner. Code that reads or
 * writes files around the project asks this before it relies on the host's
 * file system, and is stricter about paths in this mode.
 */

let browser = false;

/** Set from `initializationOptions.browser` when the server starts (any object or `true` turns it on). */
export function setBrowserMode(option: unknown): void {
  browser = option === true || (typeof option === 'object' && option !== null);
}

/** Whether the server runs in a browser worker over an in-memory project. */
export function isBrowserMode(): boolean {
  return browser;
}
