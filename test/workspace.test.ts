import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { WorkspaceIndex } from '../src/workspace';

test('workspace incrementally indexes symbol names and identifier occurrences', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-workspace-'));
  try {
    const a = path.join(root, 'a.pj');
    const b = path.join(root, 'b.pj');
    fs.writeFileSync(a, 'public int target(int x) { return x; }\n');
    fs.writeFileSync(b, 'public int use(int target) { rec.target = target; return target; }\n');

    const workspace = new WorkspaceIndex();
    workspace.setRoots([root]);

    assert.deepEqual(workspace.lookup('target').map((x) => path.basename(x.file)), ['a.pj']);
    assert.equal(workspace.symbolAt(a, 'proc', 'target', 0, 11)?.detail, 'public int target(int x)');
    assert.deepEqual(
      workspace.occurrences('target').map((x) => [path.basename(x.file), x.line, x.startCol]),
      [
        ['a.pj', 0, 11],
        ['b.pj', 0, 19],
        ['b.pj', 0, 42],
        ['b.pj', 0, 57],
      ],
    );
    assert.deepEqual(workspace.occurrences('target', b).map((x) => path.basename(x.file)), ['a.pj']);
    assert.deepEqual(
      workspace.occurrences('target', undefined, true).map((x) => path.basename(x.file)),
      ['a.pj'],
      'top-level searches exclude parameter declarations and uses with the same spelling',
    );

    workspace.invalidate(a);
    assert.deepEqual(workspace.lookup('target'), []);
    assert.deepEqual(workspace.occurrences('target').map((x) => path.basename(x.file)), ['b.pj', 'b.pj', 'b.pj']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace refresh notices a same-mtime replacement when its size changed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-workspace-'));
  try {
    const file = path.join(root, 'api.pj');
    fs.writeFileSync(file, 'public void oldName() { }\n');
    const original = fs.statSync(file);
    const workspace = new WorkspaceIndex();
    workspace.setRoots([root]);
    assert.equal(workspace.lookup('oldName').length, 1);

    fs.writeFileSync(file, 'public void replacementName() { }\n');
    fs.utimesSync(file, original.atime, original.mtime);
    workspace.add(file);

    assert.equal(workspace.lookup('oldName').length, 0);
    assert.equal(workspace.lookup('replacementName').length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('changing workspace roots drops symbols from the previous project', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-workspace-roots-'));
  try {
    const first = path.join(parent, 'first');
    const second = path.join(parent, 'second');
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    fs.writeFileSync(path.join(first, 'one.pj'), 'public void onlyFirst() { }\n');
    fs.writeFileSync(path.join(second, 'two.pj'), 'public void onlySecond() { }\n');

    const workspace = new WorkspaceIndex();
    workspace.setRoots([first]);
    assert.equal(workspace.lookup('onlyFirst').length, 1);
    workspace.setRoots([second]);
    assert.equal(workspace.lookup('onlyFirst').length, 0);
    assert.equal(workspace.lookup('onlySecond').length, 1);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('workspace completion is prefix-filtered, bounded, and never spends its budget on main', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-workspace-completion-'));
  try {
    fs.writeFileSync(path.join(root, 'a.pj'), 'public void main(string[] args) { }\npublic void alpha() { }\n');
    fs.writeFileSync(path.join(root, 'b.pj'), 'public void main(string[] args) { }\npublic void alpine() { }\n');
    fs.writeFileSync(path.join(root, 'c.pj'), 'public void beta() { }\n');
    fs.writeFileSync(path.join(root, 'd.pj'), `${Array.from({ length: 205 }, (_, i) => `public void a${i}() { }`).join('\n')}\npublic void a() { }\n`);

    const workspace = new WorkspaceIndex();
    workspace.setRoots([root]);

    const prefixed = workspace.completions('al', 1);
    assert.equal(prefixed.items.length, 1);
    assert.match(prefixed.items[0].symbol.name, /^al/);
    assert.equal(prefixed.isIncomplete, true);

    const exact = workspace.completions('a', 1);
    assert.equal(exact.items[0].symbol.name, 'a', 'an exact name is never hidden behind the broad-prefix budget');
    assert.equal(exact.isIncomplete, true);

    const all = workspace.completions('', 500);
    assert.deepEqual(all.items.slice(0, 3).map((item) => item.symbol.name), ['alpha', 'alpine', 'beta']);
    assert.ok(!all.items.some((item) => item.symbol.name === 'main'));
    assert.equal(all.isIncomplete, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('polling reports changed dependencies, additions and deletions once per refresh', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-workspace-poll-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const events: Array<{ files: string[]; structure: boolean }> = [];
  const workspace = new WorkspaceIndex((changed, structure) => events.push({ files: [...changed], structure }));
  workspace.setRoots([root]);
  const file = path.join(root, 'lib.pj');
  fs.writeFileSync(file, 'public int helper() { return 1; }');
  workspace.refresh();
  assert.deepEqual(events, [], 'initial discovery establishes the baseline');
  fs.writeFileSync(file, 'public string helper() { return "changed"; }');
  workspace.refresh();
  assert.deepEqual(events, [], 'polls are throttled');
  now += WorkspaceIndex.POLL_INTERVAL_MS;
  workspace.refresh();
  assert.deepEqual(events.splice(0), [{ files: [file], structure: false }]);
  now += WorkspaceIndex.POLL_INTERVAL_MS;
  workspace.refresh();
  assert.deepEqual(events, [], 'unchanged files do not trigger analysis or compiler work');
  fs.unlinkSync(file);
  now += WorkspaceIndex.POLL_INTERVAL_MS;
  workspace.refresh();
  assert.deepEqual(events.splice(0), [{ files: [file], structure: true }]);
  fs.writeFileSync(file, 'public void created() { }');
  now += WorkspaceIndex.POLL_INTERVAL_MS;
  workspace.refresh();
  assert.deepEqual(events.splice(0), [{ files: [file], structure: true }]);
});
