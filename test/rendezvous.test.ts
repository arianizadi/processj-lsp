import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchRendezvousHeads } from '../src/checker/rendezvous';

interface Operation {
  channel: string;
  direction: 'read' | 'write';
}

const write = (channel: string): Operation => ({ channel, direction: 'write' });
const read = (channel: string): Operation => ({ channel, direction: 'read' });
const pair = (left: Operation, right: Operation): boolean => left.channel === right.channel && left.direction !== right.direction;

test('bounded rendezvous search finds a completing non-greedy schedule in either branch order', () => {
  const branches: Operation[][] = [
    [write('c'), write('d')],
    [read('c'), read('e')],
    [read('c'), read('d'), write('c'), write('e')],
  ];
  assert.equal(searchRendezvousHeads(branches, pair).kind, 'complete');
  assert.equal(searchRendezvousHeads([branches[2], branches[0], branches[1]], pair).kind, 'complete');
});

test('bounded rendezvous search distinguishes unavoidable deadlock from proof-budget exhaustion', () => {
  const deadlock = searchRendezvousHeads([
    [write('a'), read('b')],
    [write('b'), read('a')],
  ], pair);
  assert.equal(deadlock.kind, 'deadlock');
  if (deadlock.kind === 'deadlock') assert.deepEqual(deadlock.heads, [0, 0]);

  const budget = searchRendezvousHeads([
    [write('c')],
    [read('c')],
    [read('c')],
  ], pair, 1);
  assert.deepEqual(budget, { kind: 'budget', states: 1 });

  // A directly observed completing transition remains a proof even with a
  // one-state worklist budget; no sibling state needs to be explored.
  assert.equal(searchRendezvousHeads([[write('c')], [read('c')]], pair, 1).kind, 'complete');
});
