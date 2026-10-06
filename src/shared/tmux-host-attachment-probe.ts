import { stat } from 'node:fs/promises'
import { readAgentProcess } from './agent-process-presence-probe'
import { runProcess } from './child-process/run-process'
import { readLinuxProcProcessRow } from './linux-proc-process-row'
import {
  PS_ARGS,
  parseStrictProcessTableRows,
  type ProcessTableRow
} from './process-table-snapshot'
import { parseTmuxAttachedClients, type TmuxAttachedClient } from './tmux-client-attachment'

const MAX_PROCESS_ROWS = 256
// Bounds how long a reparented intermediate process can go unnoticed.
const ANCESTOR_CACHE_TTL_MS = 30_000
const MAX_CACHED_SOCKETS = 64

export type TmuxHostAttachmentProof = { clients: TmuxAttachedClient[]; rows: ProcessTableRow[] }

async function readPsRow(pid: number): Promise<ProcessTableRow[]> {
  // Why one pid per spawn: macOS `ps -p a,b` walks the whole process table.
  const result = await runProcess({
    program: '/bin/ps',
    args: ['-p', String(pid), '-o', PS_ARGS[1]],
    env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC0' },
    timeoutMs: 1000,
    maxOutputBytes: 65536
  })
  if (result.timedOut || result.code !== 0 || result.stdout.length >= 65536) {
    throw new Error('tmux_process_capture_unverifiable')
  }
  const rows = parseStrictProcessTableRows(result.stdout)
  if (process.platform === 'linux') {
    return Promise.all(
      rows.map(async (row) => {
        const observed = await readAgentProcess(row.pid)
        return { ...row, startTime: observed.verdict === 'live' ? observed.startTime : undefined }
      })
    )
  }
  return rows
}

async function readSelectedRow(pid: number): Promise<ProcessTableRow[]> {
  if (process.platform !== 'linux') {
    return readPsRow(pid)
  }
  // Why: procfs answers the same columns without a spawn per pid per tick.
  const row = await readLinuxProcProcessRow(pid).catch(() => undefined)
  if (row === null) {
    // Same verdict as `ps -p` exiting non-zero for a vanished pid.
    throw new Error('tmux_process_capture_unverifiable')
  }
  return row ? [row] : readPsRow(pid)
}

async function readSelectedRows(pids: readonly number[]): Promise<ProcessTableRow[]> {
  const rows: ProcessTableRow[] = []
  for (let index = 0; index < pids.length; index += 16) {
    const batch = await Promise.all(pids.slice(index, index + 16).map(readSelectedRow))
    rows.push(...batch.flat())
  }
  return rows
}

type AncestorChainCache = {
  key: string
  rows: Map<number, ProcessTableRow>
  expiresAt: number
}

/**
 * A bounded capture of tmux clients and their parent paths; never a whole-host scan.
 * Roots and clients are re-read every probe because their job-control state is the
 * attachment proof; the intermediate parents between them are cached per socket
 * until the root/client set changes, a probe of the socket fails, or the TTL lapses.
 */
export function createTmuxHostAttachmentProbe(
  options: { now?: () => number } = {}
): (socket: string, rootPids: readonly number[]) => Promise<TmuxHostAttachmentProof | null> {
  const now = options.now ?? Date.now
  const ancestorsBySocket = new Map<string, AncestorChainCache>()

  function ancestorCache(socket: string, key: string): AncestorChainCache {
    const cached = ancestorsBySocket.get(socket)
    if (cached && cached.key === key && cached.expiresAt > now()) {
      return cached
    }
    // Sockets whose panes closed stop probing; drop their chains once they age out.
    for (const [cachedSocket, entry] of ancestorsBySocket) {
      if (cachedSocket === socket || entry.expiresAt <= now()) {
        ancestorsBySocket.delete(cachedSocket)
      }
    }
    if (ancestorsBySocket.size >= MAX_CACHED_SOCKETS) {
      const oldest = ancestorsBySocket.keys().next()
      if (!oldest.done) {
        ancestorsBySocket.delete(oldest.value)
      }
    }
    const fresh = {
      key,
      rows: new Map<number, ProcessTableRow>(),
      expiresAt: now() + ANCESTOR_CACHE_TTL_MS
    }
    ancestorsBySocket.set(socket, fresh)
    return fresh
  }

  async function probe(
    socket: string,
    rootPids: readonly number[]
  ): Promise<TmuxHostAttachmentProof | null> {
    if (process.platform === 'win32' || rootPids.length === 0 || rootPids.length > 64) {
      return null
    }
    try {
      const socketStat = await stat(socket)
      if (!socketStat.isSocket() || (process.getuid && socketStat.uid !== process.getuid())) {
        return null
      }
      const result = await runProcess({
        program: 'tmux',
        args: ['-S', socket, 'list-clients', '-F', '#{client_pid}:#{pane_id}'],
        timeoutMs: 1000,
        maxOutputBytes: 65536
      })
      const clients =
        !result.timedOut && result.code === 0 ? parseTmuxAttachedClients(result.stdout) : null
      if (!clients) {
        ancestorsBySocket.delete(socket)
        return null
      }
      const leafPids = new Set([...rootPids, ...clients.map((client) => client.pid)])
      const cache = ancestorCache(socket, [...leafPids].sort((a, b) => a - b).join(','))
      const byPid = new Map<number, ProcessTableRow>()
      let pids = [...leafPids]
      for (let depth = 0; depth < 8 && pids.length > 0; depth++) {
        if (byPid.size + pids.length > MAX_PROCESS_ROWS) {
          ancestorsBySocket.delete(socket)
          return null
        }
        const uncached: number[] = []
        for (const pid of pids) {
          const cached = leafPids.has(pid) ? undefined : cache.rows.get(pid)
          if (cached) {
            byPid.set(pid, cached)
          } else {
            uncached.push(pid)
          }
        }
        for (const row of await readSelectedRows(uncached)) {
          byPid.set(row.pid, row)
          if (!leafPids.has(row.pid)) {
            cache.rows.set(row.pid, row)
          }
        }
        const missingParents = new Set<number>()
        for (const client of clients) {
          const visited = new Set<number>()
          let row = byPid.get(client.pid)
          while (row && !rootPids.includes(row.pid) && !visited.has(row.pid)) {
            visited.add(row.pid)
            if (row.ppid <= 1) {
              break
            }
            if (!byPid.has(row.ppid)) {
              missingParents.add(row.ppid)
              break
            }
            row = byPid.get(row.ppid)
          }
        }
        pids = [...missingParents]
      }
      return { clients, rows: [...byPid.values()] }
    } catch {
      ancestorsBySocket.delete(socket)
      return null
    }
  }

  return probe
}

/** Process-wide probe: main and the relay each run one tmux hook owner. */
export const probeTmuxHostAttachments = createTmuxHostAttachmentProbe()
