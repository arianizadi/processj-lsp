// String literals for the editor configuration scripts/editors.js writes: the
// checkout's path goes into Lua (Neovim) and Emacs Lisp source, so it is
// encoded as a literal of that language, never pasted between quotes.
'use strict';

/** Why this checkout path cannot be written into editor configuration, or undefined when it can. */
function unsupportedPath(value) {
  if (/[\r\n]/.test(value)) return 'its path contains a line break; move the checkout to a directory whose path has none';
  return undefined;
}

/** `value` as a Lua string literal: backslashes, quotes and control characters escaped (`\ddd`, always three digits). */
function luaString(value) {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (ch === '\\' || ch === '"') out += `\\${ch}`;
    else if (code < 0x20 || code === 0x7f) out += `\\${String(code).padStart(3, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

/** `value` as an Emacs Lisp string literal: backslashes, quotes and control characters escaped (`\ooo` octal). */
function elispString(value) {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0);
    if (ch === '\\' || ch === '"') out += `\\${ch}`;
    else if (code < 0x20 || code === 0x7f) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += ch;
  }
  return `${out}"`;
}

module.exports = { unsupportedPath, luaString, elispString };
