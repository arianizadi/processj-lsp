/**
 * What a process may still do from each point of its code: the channel and
 * barrier operations (and the pars) reachable from a node, through the
 * procedures it calls. It over-approximates (every branch of an `if` counts,
 * whatever the values), so an operation that is not reachable can never
 * happen again. The explanation uses it to tell a partner that has passed its
 * last use of a channel from one that is merely busy elsewhere, so it never
 * draws a wait (or a circle of waits) on a process that cannot answer.
 */
import type * as A from '../parser/ast';
import { nodeSuccessors, type Node, type ProcIR } from './lower';

export interface Reach {
  /** Site keys reachable from each node, the node's own operation included. */
  keys: Array<Set<string>>;
  /** Whether the end of the node's region (for the thread: the procedure returns) is reachable. */
  exits: boolean[];
}

/** The key of a program point: what CspUse.site and CspDefinitionInfo.reach hold. */
export function siteKey(proc: ProcIR, nodeId: number): string {
  return `${proc.name}#${nodeId}`;
}

/** A node that is an operation another process may take part in, or a par (whose branches it starts). */
function isSite(n: Node): boolean {
  return n.k === 'write' || n.k === 'read' || n.k === 'ack' || n.k === 'sync' || n.k === 'alt' || n.k === 'par';
}

/** Reachable operations from every node of every procedure: a fixed point over the call graph (recursion included). */
export function reachability(procs: Iterable<ProcIR>, procOf: (decl: A.ProcDecl) => ProcIR | undefined): Map<ProcIR, Reach> {
  const out = new Map<ProcIR, Reach>();
  const list = [...procs];
  for (const p of list) out.set(p, { keys: p.nodes.map(() => new Set<string>()), exits: p.nodes.map(() => false) });
  const summary = (p: ProcIR | undefined): { keys: Set<string>; exits: boolean } | undefined => {
    const r = p ? out.get(p) : undefined;
    return r && p ? { keys: r.keys[p.thread.entry] ?? new Set(), exits: r.exits[p.thread.entry] ?? false } : undefined;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of list) {
      const r = out.get(p)!;
      let local = true;
      while (local) {
        local = false;
        for (let i = p.nodes.length - 1; i >= 0; i--) {
          const n = p.nodes[i];
          const keys = new Set<string>();
          let exits = n.k === 'end' || n.k === 'return';
          let next = nodeSuccessors(n);
          if (isSite(n)) keys.add(siteKey(p, n.id));
          if (n.k === 'call') {
            const callee = summary(procOf(n.call.callee));
            if (callee) {
              for (const k of callee.keys) keys.add(k);
              // The caller goes on only if the callee can return.
              if (!callee.exits) next = [];
            }
          }
          for (const s of next) {
            if (s < 0) continue;
            for (const k of r.keys[s]) keys.add(k);
            if (r.exits[s]) exits = true;
          }
          if (keys.size !== r.keys[i].size || exits !== r.exits[i]) {
            r.keys[i] = keys;
            r.exits[i] = exits;
            local = true;
            changed = true;
          }
        }
      }
    }
  }
  return out;
}
