/**
 * The little of Node's Buffer that runs in the browser build: bytes that
 * print as UTF-8, hex or base64 (a random token, the head of a file read
 * back to find a generator marker).
 */
export class Buffer extends Uint8Array {
  static override from(value: string | ArrayLike<number> | Iterable<number>): Buffer {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : Uint8Array.from(value as ArrayLike<number>);
    return new Buffer(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.length);
  }

  static alloc(size: number): Buffer {
    return new Buffer(size);
  }

  static byteLength(value: string): number {
    return new TextEncoder().encode(value).length;
  }

  static concat(parts: readonly Uint8Array[]): Buffer {
    const out = Buffer.alloc(parts.reduce((total, part) => total + part.length, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  static isBuffer(value: unknown): value is Buffer {
    return value instanceof Buffer;
  }

  override subarray(start?: number, end?: number): Buffer {
    const part = Uint8Array.prototype.subarray.call(this, start, end);
    return new Buffer(part.buffer as ArrayBuffer, part.byteOffset, part.length);
  }

  override toString(encoding: string = 'utf8'): string {
    if (encoding === 'hex') return Array.from(this, (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (encoding === 'base64' || encoding === 'base64url') {
      let binary = '';
      for (const byte of this) binary += String.fromCharCode(byte);
      const base64 = btoa(binary);
      return encoding === 'base64' ? base64 : base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    return new TextDecoder().decode(this);
  }
}
