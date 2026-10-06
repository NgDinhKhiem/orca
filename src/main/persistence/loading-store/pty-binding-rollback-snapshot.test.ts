import { describe, expect, it, vi } from 'vitest'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { retirePersistedStablePaneOwner } from '../../ipc/pty/pane/stable-owner'
import { TEST_LEAF_1, TEST_LEAF_2 } from '../../persistence-session-fixtures'
import { ProfileStateWriterError } from '../profile-state/profile-state-writer-errors'
import { fixture } from './profile-state-delayed-authority-fixture'
import { applyPtyBinding } from './pty-binding-session-update'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const worktreeId = 'repo-local::/fixture/local'
const LEAF_3 = '33333333-3333-4333-8333-333333333333'
const bulkyScrollback = 'x'.repeat(512 * 1024)

const bound = {
  worktreeId,
  tabId: 'bound-tab',
  leafId: TEST_LEAF_1,
  ptyId: 'bound-pty',
  incarnationId: 'bound-incarnation'
}
const neighbour = { ...bound, tabId: 'neighbour-tab', ptyId: 'neighbour-pty' }

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) {
      deepFreeze(child)
    }
  }
  return value
}

function isWorkspaceSessionShaped(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'tabsByWorktree' in value &&
    'terminalLayoutsByTabId' in value
  )
}

/** A session whose bulk (scrollback, hot-exit drafts) is unrelated to the binding under test. */
async function richFixture(connectionId: string | undefined) {
  const result = await fixture()
  const hostId = connectionId ? toSshExecutionHostId(connectionId) : undefined
  await result.store.persistPtyBinding(bound, hostId)
  await result.store.persistPtyBinding(neighbour, hostId)
  const session = result.store.getWorkspaceSession(hostId)
  session.terminalLayoutsByTabId[neighbour.tabId].buffersByLeafId = {
    [TEST_LEAF_1]: bulkyScrollback
  }
  session.terminalLayoutsByTabId[bound.tabId].buffersByLeafId = { [TEST_LEAF_1]: 'bound-output' }
  session.openFilesByWorktree = {
    [worktreeId]: [
      {
        filePath: '/fixture/local/draft.ts',
        relativePath: 'draft.ts',
        worktreeId,
        language: 'typescript',
        dirtyDraftContent: bulkyScrollback
      }
    ]
  }
  return { ...result, hostId, connectionId }
}

async function failNextWrite(
  authority: Awaited<ReturnType<typeof fixture>>['authority'],
  operation: () => Promise<unknown>,
  duringWrite: () => void = () => {}
): Promise<void> {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const gate = authority.pause()
  const rejected = expect(operation()).rejects.toThrow('disk refused')
  await gate.started.promise
  duringWrite()
  gate.finish.reject(
    new ProfileStateWriterError('test-disk-failure', 'disk refused', 'known-failure')
  )
  await rejected
}

describe('applyPtyBinding', () => {
  function frozenFields(session: WorkspaceSessionState): WorkspaceSessionState {
    // Only the top-level object is writable: every nested value may be shared with a rollback snapshot.
    for (const value of Object.values(session)) {
      deepFreeze(value)
    }
    return session
  }

  function baseSession(): WorkspaceSessionState {
    return {
      activeRepoId: null,
      activeWorktreeId: worktreeId,
      activeTabId: bound.tabId,
      tabsByWorktree: {
        [worktreeId]: [
          {
            id: bound.tabId,
            ptyId: 'old-pty',
            worktreeId,
            title: 'Terminal 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        [bound.tabId]: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'old-pty' },
          buffersByLeafId: { [TEST_LEAF_1]: bulkyScrollback }
        }
      },
      terminalPtyIncarnationsByPaneKey: { [`${bound.tabId}:${TEST_LEAF_1}`]: 'old-incarnation' },
      activeWorktreeIdsOnShutdown: []
    }
  }

  it.each([
    ['rebinds an existing leaf', { ...bound }],
    ['inserts a split leaf', { ...bound, leafId: TEST_LEAF_2 }],
    ['creates a new tab', { ...bound, tabId: 'created-tab' }],
    ['binds a legacy pane id', { ...bound, leafId: 'legacy-pane-1' }]
  ])('%s without mutating shared nested state', (_name, args) => {
    const session = frozenFields(baseSession())
    const before = structuredClone(session)
    applyPtyBinding(args, session, worktreeId, `${args.tabId}:${args.leafId}`)
    expect(session).not.toEqual(before)
  })

  it('roots an empty layout without mutating shared nested state', () => {
    const unrooted = baseSession()
    unrooted.terminalLayoutsByTabId[bound.tabId] = {
      root: null,
      activeLeafId: null,
      expandedLeafId: null
    }
    const session = frozenFields(unrooted)
    applyPtyBinding(bound, session, worktreeId, `${bound.tabId}:${bound.leafId}`)
    expect(session.terminalLayoutsByTabId[bound.tabId].root).toEqual({
      type: 'leaf',
      leafId: TEST_LEAF_1
    })
  })
})

describe.each([undefined, 'rollback-ssh'])('PTY binding rollback snapshots on host %s', (conn) => {
  it('does not clone the whole workspace session to stage a binding', async () => {
    const { store, hostId } = await richFixture(conn)
    const clone = vi.spyOn(globalThis, 'structuredClone')
    await store.persistPtyBinding({ ...bound, leafId: TEST_LEAF_2, ptyId: 'split-pty' }, hostId)
    await store.retirePtyBinding({ ...bound, leafId: TEST_LEAF_2, ptyId: 'split-pty' }, hostId)
    await retirePersistedStablePaneOwner(
      store,
      { ...neighbour, persistedIncarnationId: neighbour.incarnationId },
      worktreeId,
      conn
    )
    expect(clone.mock.calls.filter(([value]) => isWorkspaceSessionShaped(value)).length).toBe(0)
  })

  it('stages every operation without mutating the prior nested state in place', async () => {
    const { store, hostId } = await richFixture(conn)
    const freezeNested = () => {
      for (const value of Object.values(store.getWorkspaceSession(hostId))) {
        deepFreeze(value)
      }
    }
    freezeNested()
    await store.persistPtyBinding({ ...bound, leafId: TEST_LEAF_2, ptyId: 'split-pty' }, hostId)
    freezeNested()
    await store.persistPtyBinding({ ...bound, tabId: 'created-tab', ptyId: 'created-pty' }, hostId)
    freezeNested()
    expect(
      await store.retirePtyBinding({ ...bound, leafId: TEST_LEAF_2, ptyId: 'split-pty' }, hostId)
    ).toBe(true)
    // Pane-owner retirement also runs session admission (replay, normalization) over shared rows.
    deepFreeze(store.getWorkspaceSession(hostId))
    await expect(
      retirePersistedStablePaneOwner(
        store,
        { ...bound, persistedIncarnationId: bound.incarnationId },
        worktreeId,
        conn
      )
    ).resolves.toBe(true)
  })

  it.each([
    ['a new tab', { ...bound, tabId: 'failed-tab', ptyId: 'failed-pty' }],
    ['a new split leaf', { ...bound, leafId: LEAF_3, ptyId: 'failed-pty' }],
    ['a rebound leaf', { ...bound, ptyId: 'failed-pty', incarnationId: 'failed-incarnation' }]
  ])('restores the exact session after a failed write of %s', async (_name, args) => {
    const { store, authority, hostId } = await richFixture(conn)
    const original = structuredClone(store.getWorkspaceSession(hostId))
    await failNextWrite(authority, () =>
      store.persistPtyBinding({ ...args, expectedBinding: undefined }, hostId)
    )
    expect(store.getWorkspaceSession(hostId)).toEqual(original)
  })

  it('restores the exact session after a failed restart retirement', async () => {
    const { store, authority, hostId } = await richFixture(conn)
    const original = structuredClone(store.getWorkspaceSession(hostId))
    await failNextWrite(authority, () => store.retirePtyBinding(bound, hostId))
    expect(store.getWorkspaceSession(hostId)).toEqual(original)
  })

  it('restores the exact session after a failed pane-owner retirement', async () => {
    const { store, authority, hostId } = await richFixture(conn)
    const original = structuredClone(store.getWorkspaceSession(hostId))
    await failNextWrite(authority, () =>
      retirePersistedStablePaneOwner(
        store,
        { ...bound, persistedIncarnationId: bound.incarnationId },
        worktreeId,
        conn
      )
    )
    expect(store.getWorkspaceSession(hostId)).toEqual(original)
  })

  it('keeps edits made in place during a failed write while undoing the binding', async () => {
    const { store, authority, hostId } = await richFixture(conn)
    const original = structuredClone(store.getWorkspaceSession(hostId))
    await failNextWrite(
      authority,
      () =>
        store.persistPtyBinding(
          { ...bound, ptyId: 'failed-pty', incarnationId: 'failed-incarnation' },
          hostId
        ),
      () => {
        const live = store.getWorkspaceSession(hostId)
        live.terminalLayoutsByTabId[bound.tabId].buffersByLeafId = { [TEST_LEAF_1]: 'newer' }
        live.terminalLayoutsByTabId[neighbour.tabId].titlesByLeafId = { [TEST_LEAF_1]: 'renamed' }
        const draft = live.openFilesByWorktree?.[worktreeId]?.[0]
        if (draft) {
          draft.dirtyDraftContent = 'newer draft'
        }
      }
    )
    const expected = structuredClone(original)
    expected.terminalLayoutsByTabId[bound.tabId].buffersByLeafId = { [TEST_LEAF_1]: 'newer' }
    expected.terminalLayoutsByTabId[neighbour.tabId].titlesByLeafId = { [TEST_LEAF_1]: 'renamed' }
    const expectedDraft = expected.openFilesByWorktree?.[worktreeId]?.[0]
    if (expectedDraft) {
      expectedDraft.dirtyDraftContent = 'newer draft'
    }
    expect(store.getWorkspaceSession(hostId)).toEqual(expected)
  })

  it('keeps a newer edit to a retired pane layout while restoring its binding', async () => {
    const { store, authority, hostId } = await richFixture(conn)
    const original = structuredClone(store.getWorkspaceSession(hostId))
    await failNextWrite(
      authority,
      () => store.retirePtyBinding(bound, hostId),
      () => {
        const live = store.getWorkspaceSession(hostId)
        live.terminalLayoutsByTabId[bound.tabId].titlesByLeafId = { [TEST_LEAF_1]: 'renamed' }
      }
    )
    const expected = structuredClone(original)
    expected.terminalLayoutsByTabId[bound.tabId].titlesByLeafId = { [TEST_LEAF_1]: 'renamed' }
    expect(store.getWorkspaceSession(hostId)).toEqual(expected)
  })
})
