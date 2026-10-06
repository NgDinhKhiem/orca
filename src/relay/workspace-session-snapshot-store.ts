import { randomBytes } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type RemoteWorkspaceSnapshot = {
  namespace: string
  revision: number
  updatedAt: number
  schemaVersion: number
  session: Record<string, unknown>
}

export const SNAPSHOT_SCHEMA_VERSION = 1

/** Identity of the file a snapshot was parsed from; every writer replaces it by rename. */
type SnapshotFileSignature = { ino: bigint; size: bigint; mtimeNs: bigint }

type CachedSnapshot = {
  snapshot: RemoteWorkspaceSnapshot
  /** null: absent or unreadable when cached; 'unverified': our write was replaced before we saw it. */
  signature: SnapshotFileSignature | null | 'unverified'
}

function emptySession(): Record<string, unknown> {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {}
  }
}

function emptySnapshot(namespace: string): RemoteWorkspaceSnapshot {
  return {
    namespace,
    revision: 0,
    updatedAt: 0,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    session: emptySession()
  }
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseSnapshot(namespace: string, text: string): RemoteWorkspaceSnapshot {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return emptySnapshot(namespace)
  }
  if (!isRecord(parsed)) {
    return emptySnapshot(namespace)
  }
  return {
    namespace,
    revision: finiteNumber(parsed.revision, 0),
    updatedAt: finiteNumber(parsed.updatedAt, 0),
    schemaVersion: finiteNumber(parsed.schemaVersion, SNAPSHOT_SCHEMA_VERSION),
    session: isRecord(parsed.session) ? parsed.session : emptySession()
  }
}

function fileSignature(stats: BigIntStats): SnapshotFileSignature {
  return { ino: stats.ino, size: stats.size, mtimeNs: stats.mtimeNs }
}

function sameSignature(
  cached: CachedSnapshot['signature'],
  current: SnapshotFileSignature | null
): boolean {
  if (cached === 'unverified') {
    return false
  }
  if (cached === null || current === null) {
    return cached === current
  }
  return (
    cached.ino === current.ino && cached.size === current.size && cached.mtimeNs === current.mtimeNs
  )
}

async function readFileSignature(path: string): Promise<SnapshotFileSignature | null> {
  try {
    return fileSignature(await stat(path, { bigint: true }))
  } catch {
    // Matches the old existsSync gate: an unreadable path serves the empty snapshot.
    return null
  }
}

/**
 * Snapshot files under one base dir, cached in memory after the first parse.
 *
 * Other relay daemons for this host user (another target id or relay version) read and write the
 * same files, and the file's revision is their only concurrency check. So a cached parse is
 * reused only while a stat still matches the file it came from, and a write is durable before the
 * patch that made it is acknowledged; deferring it would let another daemon accept a patch
 * against the older revision on disk and both would publish the same revision.
 */
export class WorkspaceSessionSnapshotStore {
  private readonly snapshotsByNamespace = new Map<string, CachedSnapshot>()
  private readonly operationTailsByNamespace = new Map<string, Promise<void>>()

  constructor(private readonly baseDir: string) {}

  /** Serializes reads and read-check-write sequences per namespace now that file I/O awaits. */
  runSerialized<T>(namespace: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTailsByNamespace.get(namespace) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.operationTailsByNamespace.set(namespace, tail)
    void tail.then(() => {
      if (this.operationTailsByNamespace.get(namespace) === tail) {
        this.operationTailsByNamespace.delete(namespace)
      }
    })
    return result
  }

  /** Resolves once every queued read and write has settled; the relay awaits it before exiting. */
  async flush(): Promise<void> {
    while (this.operationTailsByNamespace.size > 0) {
      await Promise.all(this.operationTailsByNamespace.values())
    }
  }

  async read(namespace: string): Promise<RemoteWorkspaceSnapshot> {
    const path = this.snapshotPath(namespace)
    const signature = await readFileSignature(path)
    const cached = this.snapshotsByNamespace.get(namespace)
    if (cached && sameSignature(cached.signature, signature)) {
      return cached.snapshot
    }
    let snapshot = emptySnapshot(namespace)
    if (signature) {
      try {
        snapshot = parseSnapshot(namespace, await readFile(path, 'utf-8'))
      } catch {
        // Replaced or removed between stat and read: serve empty, as the synchronous reader did.
      }
    }
    // A replacement between stat and read costs one extra parse on the next request, never staleness.
    this.snapshotsByNamespace.set(namespace, { snapshot, signature })
    return snapshot
  }

  async write(snapshot: RemoteWorkspaceSnapshot): Promise<void> {
    const path = this.snapshotPath(snapshot.namespace)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    // Unique per write: daemons sharing this file must not truncate each other's temp file.
    const tmpPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    let writtenIno: bigint
    try {
      const handle = await open(tmpPath, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify(snapshot))
        writtenIno = (await handle.stat({ bigint: true })).ino
      } finally {
        await handle.close()
      }
      await rename(tmpPath, path)
    } catch (error) {
      await unlink(tmpPath).catch(() => {})
      throw error
    }
    // Some filesystems settle mtime at close, so sign the renamed file; the inode proves it is ours.
    const renamed = await readFileSignature(path)
    this.snapshotsByNamespace.set(snapshot.namespace, {
      snapshot,
      signature: renamed !== null && renamed.ino === writtenIno ? renamed : 'unverified'
    })
  }

  private snapshotPath(namespace: string): string {
    return join(this.baseDir, `${namespace}.json`)
  }
}
