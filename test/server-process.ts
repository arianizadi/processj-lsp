/**
 * Ending a language server a test started, the way an editor does. A server
 * removes its compiler sandboxes and reports when it shuts down and when it
 * exits; one killed outright (SIGKILL) cannot, and leaves them in the
 * temporary directory.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/** A test's LSP client, as far as ending its server goes. */
export interface ServerClient {
  readonly child: ChildProcessWithoutNullStreams;
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
  /** The lifecycle messages the test itself already sent (`shutdown`, `exit`), so none is sent twice. */
  readonly sent: Set<string>;
}

/** Whether a child process has ended. */
export function ended(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * `shutdown`, `exit` (whichever the test did not send), then wait for the
 * process to end. A server still running after `timeoutMs` is killed.
 */
export async function stopServer(client: ServerClient, timeoutMs = 5_000): Promise<void> {
  const { child } = client;
  // The server may be gone before a last message reaches it.
  child.stdin.on('error', () => undefined);
  if (!ended(child)) {
    const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    if (!client.sent.has('shutdown') && !client.sent.has('exit')) await Promise.race([client.request('shutdown', null).catch(() => undefined), gone, late]);
    if (!client.sent.has('exit') && !ended(child)) client.notify('exit', null);
    await Promise.race([gone, late]);
    clearTimeout(timer);
  }
  if (!ended(child)) child.kill('SIGKILL');
}
