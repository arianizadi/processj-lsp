import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editDistance, suggest } from '../src/parser/parser';

function referenceDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

function words(alphabet: string, maxLength: number): string[] {
  const out = [''];
  for (let length = 1; length <= maxLength; length++) {
    const prior = out.filter((word) => word.length === length - 1);
    for (const word of prior) for (const letter of alphabet) out.push(word + letter);
  }
  return out;
}

test('space-efficient edit distance preserves optimal-string-alignment results', () => {
  const samples = words('abc', 4);
  for (const a of samples) {
    for (const b of samples) assert.equal(editDistance(a, b), referenceDistance(a, b), `${a} -> ${b}`);
  }
});

test('bounded suggestion search preserves nearest-candidate selection', () => {
  const samples = words('abc', 4);
  for (const word of samples) {
    let expected: string | undefined;
    let best = Infinity;
    if (word.length >= 2) {
      const limit = word.length <= 4 ? 1 : 2;
      for (const candidate of samples) {
        if (candidate === word) continue;
        const distance = referenceDistance(word, candidate);
        if (distance <= limit && distance < best) {
          expected = candidate;
          best = distance;
        }
      }
    }
    assert.equal(suggest(word, samples), expected, word);
  }
});
