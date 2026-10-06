import { homedir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { RelayDispatcher } from './dispatcher'
import { publishWorkspaceSnapshotChange } from './workspace-snapshot-publication'
import {
  SNAPSHOT_SCHEMA_VERSION,
  WorkspaceSessionSnapshotStore,
  type RemoteWorkspaceSnapshot
} from './workspace-session-snapshot-store'

type ConnectedClient = {
  clientId: string
  name: string
  lastSeenAt: number
}

type PatchResult =
  | { ok: true; snapshot: RemoteWorkspaceSnapshot }
  | {
      ok: false
      reason: 'stale-revision' | 'unavailable'
      snapshot?: RemoteWorkspaceSnapshot
      message?: string
    }

const PRESENCE_TTL_MS = 45_000

function sanitizeNamespace(namespace: unknown): string {
  const raw = typeof namespace === 'string' && namespace.trim() ? namespace.trim() : 'default'
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160) || 'default'
}

function sanitizeClientName(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 80)
}

function sanitizeClientId(value: string): string {
  return value.trim().slice(0, 200)
}

export class WorkspaceSessionHandler {
  private readonly clientsByNamespace = new Map<string, Map<string, ConnectedClient>>()
  private readonly snapshots: WorkspaceSessionSnapshotStore

  constructor(
    private dispatcher: RelayDispatcher,
    baseDir = join(homedir(), '.orca', 'sessions')
  ) {
    this.snapshots = new WorkspaceSessionSnapshotStore(baseDir)
    this.dispatcher.onRequest('workspace.get', (params) => this.get(params))
    this.dispatcher.onRequest('workspace.patch', (params) => this.patch(params))
    this.dispatcher.onRequest('workspace.presence', (params) => this.presence(params))
  }

  /** Waits for in-flight snapshot writes; the relay awaits this before it exits. */
  flush(): Promise<void> {
    return this.snapshots.flush()
  }

  private async get(params: Record<string, unknown>): Promise<RemoteWorkspaceSnapshot> {
    const namespace = sanitizeNamespace(params.namespace)
    return this.snapshots.runSerialized(namespace, () => this.snapshots.read(namespace))
  }

  private async patch(params: Record<string, unknown>): Promise<PatchResult> {
    const namespace = sanitizeNamespace(params.namespace)
    return this.snapshots.runSerialized(namespace, () => this.applyPatch(namespace, params))
  }

  private async applyPatch(
    namespace: string,
    params: Record<string, unknown>
  ): Promise<PatchResult> {
    const current = await this.snapshots.read(namespace)
    const baseRevision = Number(params.baseRevision)
    if (Number.isFinite(baseRevision) && baseRevision !== current.revision) {
      return { ok: false, reason: 'stale-revision', snapshot: current }
    }

    const patch = params.patch as { kind?: unknown; session?: unknown } | undefined
    if (
      !patch ||
      patch.kind !== 'replace-session' ||
      !patch.session ||
      typeof patch.session !== 'object' ||
      Array.isArray(patch.session)
    ) {
      return { ok: false, reason: 'unavailable', message: 'Invalid workspace patch' }
    }
    if (isDeepStrictEqual(patch.session, current.session)) {
      // Why: a new revision for identical content makes every other client re-apply it.
      return { ok: true, snapshot: current }
    }

    const snapshot: RemoteWorkspaceSnapshot = {
      namespace,
      revision: current.revision + 1,
      updatedAt: Date.now(),
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      session: patch.session as Record<string, unknown>
    }
    await this.snapshots.write(snapshot)
    publishWorkspaceSnapshotChange(
      this.dispatcher,
      {
        namespace,
        snapshot,
        sourceClientId: typeof params.clientId === 'string' ? params.clientId : undefined
      },
      namespace
    )
    return { ok: true, snapshot }
  }

  private async presence(params: Record<string, unknown>): Promise<{ clients: ConnectedClient[] }> {
    const namespace = sanitizeNamespace(params.namespace)
    const clientId = typeof params.clientId === 'string' ? sanitizeClientId(params.clientId) : ''
    const name = typeof params.clientName === 'string' ? sanitizeClientName(params.clientName) : ''
    const clients = this.clientsByNamespace.get(namespace) ?? new Map<string, ConnectedClient>()
    this.clientsByNamespace.set(namespace, clients)

    const now = Date.now()
    for (const [id, client] of clients) {
      if (now - client.lastSeenAt > PRESENCE_TTL_MS) {
        clients.delete(id)
      }
    }
    if (clientId) {
      clients.set(clientId, {
        clientId,
        name: name || 'Unknown device',
        lastSeenAt: now
      })
    }

    return {
      clients: Array.from(clients.values()).sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    }
  }
}
