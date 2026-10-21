/**
 * node:child_process, node:http and node:net for the browser build: nothing
 * can be started or served from a Web Worker. The server only reaches these
 * on paths the browser build does not take (a local compiler or FDR, the live
 * graph page), and each says so if it is reached anyway.
 */
function unavailable(what: string): never {
  const error = new Error(`${what} is not available in the browser`) as Error & { code: string };
  error.code = 'ENOSYS';
  throw error;
}

export function spawn(command: string): never {
  return unavailable(`starting ${command}`);
}

export function execFile(command: string): never {
  return unavailable(`starting ${command}`);
}

export function createServer(): never {
  return unavailable('a local web server');
}
