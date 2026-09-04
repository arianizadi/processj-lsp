import type * as A from '../parser/ast';

/**
 * Visit the executable prefix of an ordinary sequential statement list.
 *
 * ProcessJ has no goto: once a direct return/break/continue/stop is reached,
 * later siblings in the same block cannot execute.  Parallel-block children
 * are separate processes rather than a sequential list and must be visited by
 * their caller one at a time.
 */
export function forEachReachableStatement(statements: readonly A.Stmt[], visit: (statement: A.Stmt) => void): void {
  for (const statement of statements) {
    visit(statement);
    if (directlyTransfersControl(statement)) return;
  }
}

/** Whether this statement directly prevents its following block sibling from running. */
export function directlyTransfersControl(statement: A.Stmt): boolean {
  return statement.kind === 'ReturnStmt'
    || statement.kind === 'BreakStmt'
    || statement.kind === 'ContinueStmt'
    || statement.kind === 'StopStmt';
}
