import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse } from '../src/parser/parser';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures', 'processj');
const KEYWORDS = new Set(['if', 'while', 'for', 'switch', 'alt', 'pri', 'claim', 'read', 'write', 'timeout', 'sync', 'return', 'new', 'par', 'do', 'fork', 'skip', 'stop', 'enroll', 'seq', 'suspend', 'mobile']);

/** Build a large program by concatenating the example corpus with renamed procedures. */
export function bigProgram(targetLines: number): string {
  const bodies: string[] = [];
  for (const f of fs.readdirSync(FIXTURES).filter((x) => x.endsWith('.pj')).sort()) {
    const src = fs.readFileSync(path.join(FIXTURES, f), 'utf8');
    if (parse(src).errors.length) continue;
    bodies.push(
      src
        .split('\n')
        .filter((l) => !/^\s*(import|package|#pragma)\b/.test(l))
        .join('\n'),
    );
  }
  const out = ['import std.*;', ''];
  let lines = 2;
  let copy = 0;
  while (lines < targetLines) {
    for (const b of bodies) {
      // Rename every declared procedure, record, protocol and constant so copies do not collide.
      const renamed = b
        .replace(/\b([A-Za-z_]\w*)(?=\s*\()/g, (m) => (KEYWORDS.has(m) || m === 'println' || m === 'print' ? m : `${m}_${copy}`))
        .replace(/\b(record|protocol)\s+(\w+)/g, `$1 $2_${copy}`);
      out.push(renamed, '');
      lines += renamed.split('\n').length + 1;
      if (lines >= targetLines) break;
    }
    copy++;
  }
  return out.join('\n');
}

