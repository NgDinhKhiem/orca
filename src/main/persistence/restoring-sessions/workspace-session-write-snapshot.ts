import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { rollbackWorkspaceSessionAfterFailedAsyncWrite } from './workspace-session-write-rollback'

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Deep copy that shares strings, which are immutable and hold the bulk (scrollback, hot-exit drafts). */
function copySessionValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(copySessionValue)
  }
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, copySessionValue(child)])
    )
  }
  return typeof value === 'object' && value !== null ? structuredClone(value) : value
}

function snapshotSlotPair(before: unknown, after: unknown): [unknown, unknown] {
  // Why: a slot the write left identical needs no copy; rollback reads it as unchanged on both sides.
  if (before === after) {
    return [before, after]
  }
  if (isPlainRecord(before) && isPlainRecord(after)) {
    const beforeEntries: [string, unknown][] = []
    const afterByKey = new Map<string, unknown>()
    for (const [key, value] of Object.entries(before)) {
      if (Object.hasOwn(after, key)) {
        const [beforeSlot, afterSlot] = snapshotSlotPair(value, after[key])
        beforeEntries.push([key, beforeSlot])
        afterByKey.set(key, afterSlot)
      } else {
        beforeEntries.push([key, copySessionValue(value)])
      }
    }
    const afterEntries = Object.entries(after).map(([key, value]): [string, unknown] => [
      key,
      afterByKey.has(key) ? afterByKey.get(key) : copySessionValue(value)
    ])
    return [Object.fromEntries(beforeEntries), Object.fromEntries(afterEntries)]
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    // Index pairing only: a shared row must sit at the same path on both sides.
    return [
      before.map((value, index) => (value === after[index] ? value : copySessionValue(value))),
      after.map((value, index) => (value === before[index] ? value : copySessionValue(value)))
    ]
  }
  return [copySessionValue(before), copySessionValue(after)]
}

/**
 * Captures the before/after pair a failed async write rolls back between, copying only the slots
 * the write replaced instead of the whole session.
 *
 * Contract: the write is copy-on-write — it never mutated in place an object reachable from
 * `before`. Every object left at the same path in both is then unchanged by the write, so sharing
 * it reads the same to `rollbackWorkspaceSessionAfterFailedAsyncWrite` as two frozen copies would.
 */
export function snapshotWorkspaceSessionWrite(
  before: WorkspaceSessionState,
  after: WorkspaceSessionState
): { original: WorkspaceSessionState; staged: WorkspaceSessionState } {
  const [original, staged] = snapshotSlotPair(before, after)
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Each slot is either the input's own value or a structural copy of it.
    original: original as WorkspaceSessionState,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Each slot is either the input's own value or a structural copy of it.
    staged: staged as WorkspaceSessionState
  }
}

/** The fieldwise rollback of a copy-on-write session write, staged without a whole-session clone. */
export function stageWorkspaceSessionRollback(
  before: WorkspaceSessionState,
  after: WorkspaceSessionState
): (current: WorkspaceSessionState) => WorkspaceSessionState {
  const { original, staged } = snapshotWorkspaceSessionWrite(before, after)
  return (current) => rollbackWorkspaceSessionAfterFailedAsyncWrite(original, staged, current)
}
