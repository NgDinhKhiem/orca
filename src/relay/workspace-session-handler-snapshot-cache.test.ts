import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayDispatcher } from './dispatcher'
import { encodeJsonRpcFrame, MessageType, type JsonRpcRequest } from './protocol'
import { WorkspaceSessionHandler } from './workspace-session-handler'

type Frame = {
  id?: number
  method?: string
  result?: {
    ok?: boolean
    reason?: string
    snapshot?: { revision: number; updatedAt: number; session: Record<string, unknown> }
    revision?: number
  }
  error?: { message?: string }
}

const namespace = 'cache-namespace'
const session = {
  activeWorktreePath: '/repo',
  activeTabId: 'tab-1',
  tabsByWorktreePath: { '/repo': [{ id: 'tab-1', title: 'Terminal', worktreePath: '/repo' }] },
  terminalLayoutsByTabId: {}
}

describe('WorkspaceSessionHandler snapshot persistence', () => {
  let baseDir: string
  let dispatcher: RelayDispatcher
  let handler: WorkspaceSessionHandler
  let written: Buffer[]
  let nextId = 1

  const frames = (): Frame[] =>
    written
      .filter((buf) => buf[0] === MessageType.Regular)
      .map((buf) => {
        const len = buf.readUInt32BE(9)
        return JSON.parse(buf.subarray(13, 13 + len).toString('utf-8')) as Frame
      })

  function send(method: string, params: Record<string, unknown>): number {
    const id = nextId++
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
    dispatcher.feed(encodeJsonRpcFrame(req, id, 0))
    return id
  }

  async function response(id: number): Promise<Frame> {
    for (let attempt = 0; attempt < 400; attempt++) {
      const frame = frames().find((candidate) => candidate.id === id)
      if (frame) {
        return frame
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(`no response for request ${id}`)
  }

  const request = async (method: string, params: Record<string, unknown>) =>
    response(send(method, params))

  const patch = (baseRevision: number, next: Record<string, unknown>) =>
    request('workspace.patch', {
      namespace,
      baseRevision,
      clientId: 'client-a',
      patch: { kind: 'replace-session', session: next }
    })

  const snapshotPath = () => join(baseDir, `${namespace}.json`)

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'orca-workspace-session-cache-'))
    written = []
    dispatcher = new RelayDispatcher((data) => {
      written.push(Buffer.from(data))
    })
    handler = new WorkspaceSessionHandler(dispatcher, baseDir)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    dispatcher.dispose()
    rmSync(baseDir, { recursive: true, force: true })
  })

  it('parses the snapshot file once across repeated reads of an unchanged file', async () => {
    await patch(0, session)
    const parse = vi.spyOn(JSON, 'parse')
    const snapshotParses = () =>
      parse.mock.calls.filter(
        ([text]) =>
          typeof text === 'string' && text.includes('schemaVersion') && !text.includes('"jsonrpc"')
      )
    for (let read = 0; read < 3; read++) {
      const frame = await request('workspace.get', { namespace })
      expect(frame.result?.revision).toBe(1)
    }
    expect(snapshotParses().length).toBeLessThanOrEqual(1)
  })

  it('observes a snapshot another relay process wrote to the shared file', async () => {
    await patch(0, session)
    await request('workspace.get', { namespace })
    // Two relay daemons (another target id or relay version) share this file for one host user.
    writeFileSync(
      snapshotPath(),
      JSON.stringify({
        namespace,
        revision: 5,
        updatedAt: 1,
        schemaVersion: 1,
        session: { ...session, activeTabId: 'other-device' }
      })
    )
    const read = await request('workspace.get', { namespace })
    expect(read.result?.revision).toBe(5)
    const stale = await patch(1, session)
    expect(stale.result).toMatchObject({ ok: false, reason: 'stale-revision' })
    expect(stale.result?.snapshot?.revision).toBe(5)
  })

  it('does not bump the revision, write, or publish for a no-op patch', async () => {
    const first = await patch(0, session)
    const before = statSync(snapshotPath(), { bigint: true })
    written = []
    const repeated = await patch(1, structuredClone(session))
    expect(repeated.result?.ok).toBe(true)
    expect(repeated.result?.snapshot).toEqual(first.result?.snapshot)
    expect(frames().some((frame) => frame.method === 'workspace.changed')).toBe(false)
    const after = statSync(snapshotPath(), { bigint: true })
    expect([after.ino, after.mtimeNs, after.size]).toEqual([
      before.ino,
      before.mtimeNs,
      before.size
    ])
  })

  it('still rejects a no-op patch from a stale base revision', async () => {
    await patch(0, session)
    await patch(1, { ...session, activeTabId: 'tab-2' })
    const stale = await patch(1, { ...session, activeTabId: 'tab-2' })
    expect(stale.result).toMatchObject({ ok: false, reason: 'stale-revision' })
  })

  it('writes compact JSON atomically without leaving temp files', async () => {
    await patch(0, session)
    await patch(1, { ...session, activeTabId: 'tab-2' })
    const text = readFileSync(snapshotPath(), 'utf-8')
    expect(text).not.toContain('\n')
    expect(JSON.parse(text)).toMatchObject({ revision: 2, session: { activeTabId: 'tab-2' } })
    expect(readdirSync(baseDir)).toEqual([`${namespace}.json`])
  })

  it('serializes concurrent patches from one base revision', async () => {
    const ids = [
      send('workspace.patch', {
        namespace,
        baseRevision: 0,
        clientId: 'client-a',
        patch: { kind: 'replace-session', session }
      }),
      send('workspace.patch', {
        namespace,
        baseRevision: 0,
        clientId: 'client-b',
        patch: { kind: 'replace-session', session: { ...session, activeTabId: 'tab-b' } }
      })
    ]
    const results = await Promise.all(ids.map(response))
    expect(results.map((frame) => frame.result?.ok)).toEqual([true, false])
    expect(results[1].result?.reason).toBe('stale-revision')
    expect(JSON.parse(readFileSync(snapshotPath(), 'utf-8')).session.activeTabId).toBe('tab-1')
  })

  it('flushes an in-flight write before shutdown', async () => {
    send('workspace.patch', {
      namespace,
      baseRevision: 0,
      clientId: 'client-a',
      patch: { kind: 'replace-session', session }
    })
    await handler.flush()
    expect(JSON.parse(readFileSync(snapshotPath(), 'utf-8')).revision).toBe(1)
  })

  it('keeps serving the durable snapshot when a write fails', async () => {
    await patch(0, session)
    const blocked = join(baseDir, 'blocked')
    writeFileSync(blocked, 'not a directory')
    const original = dispatcher
    dispatcher = new RelayDispatcher((data) => {
      written.push(Buffer.from(data))
    })
    try {
      new WorkspaceSessionHandler(dispatcher, join(blocked, 'sessions'))
      const failed = await patch(0, session)
      expect(failed.error).toBeDefined()
      const read = await request('workspace.get', { namespace })
      expect(read.result?.revision).toBe(0)
    } finally {
      dispatcher.dispose()
      dispatcher = original
    }
  })
})
