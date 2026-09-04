import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { findInstall, parseRcFile } from '../src/config';

function fakeInstall(root: string): void {
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'resources', 'jars'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'ProcessJc.class'), '');
  for (const jar of ['java_cup_runtime.jar', 'ST-4.0.7.jar', 'asm-all-5.2.jar']) {
    fs.writeFileSync(path.join(root, 'resources', 'jars', jar), '');
  }
}

test('processjrc parsing ignores comments and preserves values containing equals', () => {
  assert.deepEqual(parseRcFile('# comment\ninstalldir = /tmp/ProcessJ\nflag=a=b\nbad-line\n'), {
    installdir: '/tmp/ProcessJ',
    flag: 'a=b',
  });
});

test('explicit install and Java paths expand the configured home directory', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'processj-config-'));
  try {
    const root = path.join(home, 'ProcessJ');
    fakeInstall(root);
    const result = findInstall({ installDir: '~/ProcessJ', javaBin: '~/jdk/bin/java', home, env: {} });
    assert.ok(!('error' in result));
    assert.equal(result.installDir, root);
    assert.equal(result.javaBin, path.join(home, 'jdk', 'bin', 'java'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
