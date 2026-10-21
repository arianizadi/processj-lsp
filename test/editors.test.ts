import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// scripts/editor-strings.js is plain JavaScript, shared with scripts/editors.js.
const strings = require('../../scripts/editor-strings.js') as {
  unsupportedPath(value: string): string | undefined;
  luaString(value: string): string;
  elispString(value: string): string;
};

/** A checkout directory named to break out of the string (security review F-08), and other awkward characters. */
const HOSTILE = [
  '/home/u/repo" t t) (shell-command "id") ;/editor/emacs/processj-mode.el',
  'C:\\Users\\u\\processj-lsp\\"]] os.execute("id") --',
  '/tmp/tab\there/esc\u001b[31m/del\u007f/bell\u0007/nul\u0000/plain',
];

function available(command: string, flag = '--version'): boolean {
  return spawnSync(command, [flag], { stdio: 'ignore' }).status === 0;
}

/** Character codes of `text`, as the interpreters print them. */
function codes(text: string): string {
  return [...text].map((ch) => ch.codePointAt(0)).join(',');
}

test('F-08: checkout paths with quotes and control characters stay one string literal', () => {
  for (const value of HOSTILE) {
    const lisp = strings.elispString(value);
    // Only the outer quotes are unescaped, and no raw control character is left.
    assert.equal(lisp.replace(/\\./g, '').split('"').length, 3, lisp);
    assert.ok(!/[\u0000-\u001f\u007f]/.test(lisp), lisp);
    const lua = strings.luaString(value);
    assert.equal(lua.replace(/\\./g, '').split('"').length, 3, lua);
    assert.ok(!/[\u0000-\u001f\u007f]/.test(lua), lua);
  }
  assert.equal(strings.elispString('/a/b"c\\d'), '"/a/b\\"c\\\\d"');
  assert.equal(strings.luaString('a\u0001b'), '"a\\001b"');
  assert.equal(strings.elispString('a\u0001b'), '"a\\001b"');
});

test('F-08: a checkout path with a line break is refused, others are written', () => {
  assert.match(strings.unsupportedPath('/home/u/repo\n(shell-command "id")') ?? '', /line break/);
  assert.match(strings.unsupportedPath('/home/u/repo\r') ?? '', /line break/);
  assert.equal(strings.unsupportedPath('/home/u/my "repo"/processj-lsp'), undefined);
});

test('F-08: Emacs reads the literal back as the very path', { skip: !available('emacs') && 'Emacs is not installed' }, () => {
  for (const value of HOSTILE) {
    const form = `(princ (mapconcat (lambda (c) (format "%d" c)) ${strings.elispString(value)} ","))`;
    const run = spawnSync('emacs', ['--batch', '-Q', '--eval', form], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, codes(value));
  }
});

test('F-08: Lua reads the literal back as the very path', { skip: !available('lua', '-v') && 'Lua is not installed' }, () => {
  for (const value of HOSTILE) {
    const chunk = `local s = ${strings.luaString(value)}; local t = {}; for i = 1, #s do t[#t + 1] = s:byte(i) end; io.write(table.concat(t, ","))`;
    const run = spawnSync('lua', ['-e', chunk], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, codes(value));
  }
});
