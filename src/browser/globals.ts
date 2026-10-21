/**
 * Node's `process` and `Buffer` for the browser build: esbuild's `inject`
 * binds every free reference to them in the bundle to these. A Web Worker
 * has no process to signal or end (its page ends it), so those calls do
 * nothing; the environment is the server's own (PROCESSJ_HOME, set by the
 * worker's setup).
 */
export { Buffer } from './buffer';

type Listener = (...args: unknown[]) => void;

export const process = {
  env: {} as Record<string, string | undefined>,
  platform: 'browser',
  argv: [] as string[],
  versions: {} as Record<string, string>,
  cwd: (): string => '/',
  on: (_event: string, _listener: Listener): unknown => process,
  once: (_event: string, _listener: Listener): unknown => process,
  off: (_event: string, _listener: Listener): unknown => process,
  removeListener: (_event: string, _listener: Listener): unknown => process,
  emit: (): boolean => false,
  exit: (): void => undefined,
  kill: (): never => {
    throw new Error('there are no processes to signal in the browser');
  },
  nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]): void => queueMicrotask(() => callback(...args)),
};
