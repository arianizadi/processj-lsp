/** node:url for the browser build: file URLs as Node spells them on POSIX. */
import * as path from 'node:path';

export function fileURLToPath(value: string | URL): string {
  const url = typeof value === 'string' ? new URL(value) : value;
  if (url.protocol !== 'file:') throw new TypeError('The URL must be of scheme file');
  if (url.hostname !== '') throw new TypeError('File URL host must be "localhost" or empty on this platform');
  if (/%2f/i.test(url.pathname)) throw new TypeError('File URL path must not include encoded / characters');
  return decodeURIComponent(url.pathname);
}

export function pathToFileURL(file: string): URL {
  let resolved = path.resolve(file);
  // A trailing slash says "directory": resolve drops it.
  if (file.endsWith('/') && !resolved.endsWith('/')) resolved += '/';
  const url = new URL('file://');
  // What the pathname setter would not encode, or would read as something else.
  url.pathname = resolved.replace(/%/g, '%25').replace(/\\/g, '%5C').replace(/\n/g, '%0A').replace(/\r/g, '%0D').replace(/\t/g, '%09');
  return url;
}
