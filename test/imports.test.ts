import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { check } from '../src/checker/checker';
import { DeclIndex } from '../src/checker/index';
import { resolveImports } from '../src/imports';
import { parse } from '../src/parser/parser';

const INCLUDE = path.join(__dirname, '..', '..', 'test', 'fixtures', 'include');

test('imports resolve relative to the file, the workspace roots, and the include directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-imports-'));
  fs.mkdirSync(path.join(root, 'geom'));
  fs.writeFileSync(path.join(root, 'geom', 'shapes.pj'), 'package geom;\nrecord Circle { double r; }\npublic double area(Circle c) { return 3.14 * c.r * c.r; }\n');
  fs.writeFileSync(path.join(root, 'geom', 'lines.pj'), 'package geom;\nrecord Line { double len; }\n');
  fs.writeFileSync(path.join(root, 'util.pj'), 'public int twice(int x) { return x * 2; }\n');
  const main = path.join(root, 'app', 'main.pj');
  fs.mkdirSync(path.dirname(main));
  const src = 'import std.*;\nimport geom.*;\nimport util;\nimport nothing.here;\n\npublic void main(string[] args) {\n    Circle c = new Circle { r = 2.0 };\n    Line l = new Line { len = 1.0 };\n    println(area(c) + twice(3) + l.len);\n}\n';
  fs.writeFileSync(main, src);

  const parsed = parse(src);
  // The include dir here stands in for <install>/include; its fixtures live directly under std/.
  const res = resolveImports(parsed.program, main, [root], INCLUDE);
  assert.equal(res.importsStd, true);
  assert.deepEqual(res.imports.map((i) => i.files.map((f) => path.basename(f))), [
    ['io.pj', 'math.pj', 'random.pj', 'strings.pj'],
    ['lines.pj', 'shapes.pj'],
    ['util.pj'],
    [],
  ]);
  assert.deepEqual(res.imports[3].searched.map((d) => path.basename(d)), ['app', path.basename(root), 'JVM', 'include']);

  const index = new DeclIndex();
  index.addProgram(parsed.program, main);
  for (const f of res.files) index.addProgram(parse(fs.readFileSync(f, 'utf8')).program, f);
  const r = check(parsed.program, { index, importsStd: true, unresolvedImports: true });
  assert.deepEqual(r.diagnostics.filter((d) => d.severity === 'error'), []);
  assert.ok(index.records.has('Circle') && index.records.has('Line') && index.procs.has('twice') && index.procs.has('println'));
  fs.rmSync(root, { recursive: true, force: true });
});
