/**
 * elkjs/lib/elk.bundled.js for the browser build. The layout engine is about
 * half of the language server's code, and only a view that is drawn needs
 * it, so the build writes it as a file of its own beside the worker script
 * (elk.<hash>.js, scripts/build-browser.mjs) and the worker loads it on the
 * first layout (layout.ts requires it then). The file sets `self.ELK`.
 */
declare const PROCESSJ_ELK_FILE: string;

const scope = self as unknown as { ELK?: unknown };
if (!scope.ELK) importScripts(new URL(PROCESSJ_ELK_FILE, location.href).href);

export = scope.ELK;
