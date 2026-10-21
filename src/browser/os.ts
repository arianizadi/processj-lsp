/** node:os for the browser build: a home and a temporary folder in the in-memory file system. */
export const EOL = '\n';

export function homedir(): string {
  return '/home/web';
}

export function tmpdir(): string {
  return '/tmp';
}

export function platform(): string {
  return 'browser';
}

/** What FDR's default memory limit is worked out from; FDR does not run here. */
export function totalmem(): number {
  return 4 * 1024 ** 3;
}
