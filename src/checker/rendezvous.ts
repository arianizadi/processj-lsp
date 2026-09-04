/** Shared bounded state-space search for straight-line rendezvous queues. */

export const RENDEZVOUS_STATE_BUDGET = 4096;

export type RendezvousSearchResult =
  | { kind: 'complete'; states: number }
  | { kind: 'deadlock'; heads: number[]; states: number }
  | { kind: 'budget'; states: number };

/**
 * Explore every distinct vector of queue heads until one legal schedule
 * completes, every reachable schedule is stuck, or the state budget is hit.
 * Callers deliberately decide what "fail closed" means for their operation:
 * diagnostics make no deadlock claim on `budget`, while a refactor is refused.
 */
export function searchRendezvousHeads<T>(
  queues: readonly (readonly T[])[],
  canPair: (left: T, right: T) => boolean,
  stateBudget = RENDEZVOUS_STATE_BUDGET,
): RendezvousSearchResult {
  if (!Number.isSafeInteger(stateBudget) || stateBudget < 1) return { kind: 'budget', states: 0 };
  const initial = queues.map(() => 0);
  const pending: number[][] = [initial];
  const discovered = new Set<string>([initial.join(',')]);
  let firstDeadlock: number[] | undefined;

  while (pending.length > 0) {
    const heads = pending.pop()!;
    if (heads.every((head, branch) => head >= queues[branch].length)) {
      return { kind: 'complete', states: discovered.size };
    }

    let moveCount = 0;
    for (let left = 0; left < queues.length; left++) {
      const a = queues[left][heads[left]];
      if (a === undefined) continue;
      for (let right = left + 1; right < queues.length; right++) {
        const b = queues[right][heads[right]];
        if (b === undefined || !canPair(a, b)) continue;
        const next = [...heads];
        next[left]++;
        next[right]++;
        // The transition itself is a constructive schedule proof; do not lose
        // it merely because another sibling state would overflow the budget
        // before this state can be popped from the worklist.
        if (next.every((head, branch) => head >= queues[branch].length)) {
          return { kind: 'complete', states: discovered.size };
        }
        const key = next.join(',');
        if (!discovered.has(key)) {
          if (discovered.size >= stateBudget) return { kind: 'budget', states: discovered.size };
          discovered.add(key);
          pending.push(next);
        }
        moveCount++;
      }
    }
    if (moveCount === 0) firstDeadlock ??= heads;
  }

  return { kind: 'deadlock', heads: firstDeadlock ?? initial, states: discovered.size };
}
