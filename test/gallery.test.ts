/**
 * The example gallery of the browser build (scripts/gallery.mjs, written to
 * dist/browser/gallery.json): every program in the repository is there, as a
 * project the web IDE can open and the runner accepts.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { WORKER_BUNDLE, workerBundle } from './browser-worker';

const ROOT = path.join(__dirname, '..', '..');

interface Entry {
  id: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  dir: string;
  files: string[];
  open: string;
  entry: string | null;
}

interface Gallery {
  format: number;
  version: string;
  categories: Array<{ id: string; title: string; description: string }>;
  tags: string[];
  featured: string[];
  entries: Entry[];
  sources: Record<string, string>;
}

type GalleryModule = { buildGallery(root: string, options?: { version?: string }): Gallery; galleryCandidates(root: string): string[] };
// The builder is an ES module of the build scripts; this test is compiled to CommonJS.
const loadModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<GalleryModule>;
const builder = (): Promise<GalleryModule> => loadModule(pathToFileURL(path.join(ROOT, 'scripts', 'gallery.mjs')).href);

function built(): Gallery {
  workerBundle();
  return JSON.parse(fs.readFileSync(path.join(path.dirname(WORKER_BUNDLE), 'gallery.json'), 'utf8')) as Gallery;
}

/** A project path the runner takes (docs/runner-protocol.md of the IDE). */
function runnerPath(p: string): boolean {
  const parts = p.split('/');
  return p.length <= 96 && parts.length <= 6 && parts.every((part) => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '..' && part !== '.') && /\.(pj|csp|inc|txt|md)$/.test(p);
}

test('the gallery holds every ProcessJ and CSPm program outside the standard library headers', async () => {
  const gallery = built();
  const { galleryCandidates } = await builder();
  const candidates = galleryCandidates(ROOT);
  assert.ok(candidates.length >= 160, `${candidates.length} files`);
  assert.ok(!candidates.some((file) => file.startsWith('test/fixtures/include/')));
  const covered = new Set(gallery.entries.flatMap((entry) => entry.files.map((file) => `${entry.dir}/${file}`)));
  assert.deepEqual(candidates.filter((file) => !covered.has(file)), []);
  // Every program is an entry of its own; the one library (examples/lib/geometry.pj) goes with the program that imports it.
  const ids = new Set(gallery.entries.map((entry) => entry.id));
  assert.deepEqual(candidates.filter((file) => !ids.has(file)), ['examples/lib/geometry.pj']);
  assert.equal(ids.size, gallery.entries.length, 'ids are unique');
  assert.equal(gallery.version, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
  const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(WORKER_BUNDLE), 'manifest.json'), 'utf8'));
  assert.ok(manifest.files.includes('gallery.json'));
});

test('each entry is a project the IDE can open and the runner accepts', () => {
  const gallery = built();
  const categories = new Set(gallery.categories.map((category) => category.id));
  for (const entry of gallery.entries) {
    assert.ok(categories.has(entry.category), `${entry.id}: ${entry.category}`);
    assert.ok(entry.files.length >= 1 && entry.files.length <= 64, entry.id);
    assert.equal(entry.files[0], entry.open, `${entry.id} opens its own program`);
    assert.equal(`${entry.dir}/${entry.open}`, entry.id);
    for (const file of entry.files) {
      assert.ok(runnerPath(file), `${entry.id}: ${file}`);
      assert.equal(typeof gallery.sources[`${entry.dir}/${file}`], 'string', `${entry.id}: ${file}`);
    }
    assert.equal(entry.entry, entry.id.endsWith('.pj') && /\bvoid\s+main\s*\(/.test(gallery.sources[entry.id]) ? entry.open : null, entry.id);
    assert.ok(entry.title && entry.title.length <= 60, `${entry.id}: ${entry.title}`);
    assert.ok(entry.description && entry.description.length <= 400, `${entry.id}: ${entry.description}`);
    assert.doesNotMatch(entry.description, /\b(expect|outcome):/, entry.id);
    for (const tag of entry.tags) assert.ok(gallery.tags.includes(tag), `${entry.id}: ${tag}`);
  }
  // Each file once, as it is in the repository.
  for (const [file, text] of Object.entries(gallery.sources)) assert.equal(text, fs.readFileSync(path.join(ROOT, file), 'utf8'), file);
  assert.ok(JSON.stringify(gallery).length < 400_000, 'small enough to fetch when asked for');
});

test('categories by where a program lives; tags from its expect and outcome lines', () => {
  const gallery = built();
  const byId = new Map(gallery.entries.map((entry) => [entry.id, entry]));
  const count = (category: string): number => gallery.entries.filter((entry) => entry.category === category).length;
  assert.deepEqual(gallery.categories.map((category) => category.title), ['Start here', 'Classic programs', 'Language corner cases', 'Channel arrays and FIFOs', 'CSPm models', 'Other fixtures']);
  assert.equal(count('start'), fs.readdirSync(path.join(ROOT, 'examples')).filter((file) => file.endsWith('.pj')).length);
  assert.equal(count('classic'), fs.readdirSync(path.join(ROOT, 'test', 'fixtures', 'processj')).filter((file) => file.endsWith('.pj')).length);
  assert.equal(count('corners'), fs.readdirSync(path.join(ROOT, 'test', 'differential')).filter((file) => file.endsWith('.pj')).length);
  assert.equal(count('fifo'), 5);
  assert.ok(gallery.entries.filter((entry) => entry.id.endsWith('.csp')).every((entry) => entry.category === 'cspm' && entry.tags.includes('FDR') && entry.entry === null));
  assert.equal(count('cspm'), 11);

  // The import comes along, at the path the import names; the CSPm model of a program too.
  assert.deepEqual(byId.get('examples/use_import.pj')!.files, ['use_import.pj', 'lib/geometry.pj']);
  assert.ok(byId.get('examples/use_import.pj')!.tags.includes('imports'));
  assert.deepEqual(byId.get('examples/dining_philosophers.pj')!.files, ['dining_philosophers.pj', 'dining_philosophers.csp']);

  // Descriptions from the leading comment, without the expect line; titles from the name unless noted better.
  const yieldEntry = byId.get('examples/yield_through_calls.pj')!;
  assert.match(yieldEntry.description, /^`twice` never communicates itself/);
  assert.ok(yieldEntry.tags.includes('yield'));
  assert.equal(byId.get('examples/par_deadlock.pj')!.title, 'Par deadlock');
  assert.ok(byId.get('examples/par_deadlock.pj')!.tags.includes('deadlock'));
  assert.ok(byId.get('examples/typos.pj')!.tags.includes('type error'));
  assert.equal(byId.get('test/fixtures/processj/commstime.pj')!.title, 'CommsTime');
  assert.equal(byId.get('test/fixtures/processj/fullAdder.pj')!.title, 'Full adder');
  assert.equal(byId.get('test/fixtures/processj/Hello.pj')!.entry, 'Hello.pj');

  // Every differential program has its outcome as a tag and a sentence, but two whose outcome line is for
  // ProcessJ's alt_timer_update branch: the IDE's runner builds with its main branch, where javac rejects them.
  const outcomeTag: Record<string, string> = { runs: 'runs', 'runs-wrong': 'runs wrong', error: 'build error', 'compiler-limit': 'compiler limit', deadlocks: 'deadlock' };
  const onTheRunner: Record<string, string> = { 'test/differential/alt_timeout_guard.pj': 'compiler-limit', 'test/differential/two_alts_one_process.pj': 'compiler-limit' };
  for (const entry of gallery.entries.filter((e) => e.category === 'corners')) {
    const outcome = onTheRunner[entry.id] ?? /^\/\/ outcome:\s*(\S+)/.exec(gallery.sources[entry.id])![1];
    assert.ok(entry.tags.includes(outcomeTag[outcome]), `${entry.id}: ${outcome} in ${entry.tags.join(', ')}`);
  }
  for (const id of Object.keys(onTheRunner)) {
    const entry = byId.get(id)!;
    assert.ok(!entry.tags.includes('runs'), `${id}: ${entry.tags.join(', ')}`);
    assert.match(entry.description, /alt_timer_update branch builds and runs it.*main branch, which the IDE's runner builds with, javac rejects/);
    assert.doesNotMatch(entry.description, /the checker says so|builds and runs as written/);
  }
  assert.match(byId.get('test/differential/break_in_par.pj')!.description, /cannot build/);
  // A description that already says how it went is not followed by a sentence that says it again.
  assert.equal(byId.get('test/differential/alt_per_par_branch.pj')!.description, 'One alt per par branch is one alt per generated class, which builds and runs.');
  assert.match(byId.get('test/differential/shared_writers_locked.pj')!.description, /single reader process\. It builds and runs as written\.$/);
  for (const entry of gallery.entries) assert.doesNotMatch(entry.description, /\b(builds?|compiles?) and runs?\b.*It builds and runs as written\.$/, entry.id);

  // The featured set is the start of Start here.
  assert.ok(gallery.featured.length >= 4 && gallery.featured.length <= 8);
  assert.deepEqual(gallery.entries.slice(0, gallery.featured.length).map((entry) => entry.id), gallery.featured);
});

test('the gallery is the same for the same files', async () => {
  const { buildGallery } = await builder();
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  assert.equal(JSON.stringify(buildGallery(ROOT, { version })), JSON.stringify(built()));
});
