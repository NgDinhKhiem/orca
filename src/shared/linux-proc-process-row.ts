import { readFile } from 'node:fs/promises'
import type { ProcessTableRow } from './process-table-snapshot'

/** Unix98 pty slaves use majors 136-143 (see Documentation/admin-guide/devices.txt). */
const PTY_SLAVE_MAJOR_FIRST = 136
const PTY_SLAVE_MAJOR_LAST = 143
// The boot id is fixed for the life of the host, so read it once per process.
let bootIdRead: Promise<string> | undefined

function isMissingProcess(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ESRCH')
  )
}

/**
 * Name a `tty_nr` the way procps does for ptys (`pts/N`); other devices get a
 * stable `major:minor` name. Only ever compared with names from this reader.
 */
function linuxTtyName(ttyNr: number): string {
  if (ttyNr === 0) {
    return '?'
  }
  const major = (ttyNr >> 8) & 0xfff
  const minor = (ttyNr & 0xff) | ((ttyNr >> 12) & 0xfff00)
  if (major >= PTY_SLAVE_MAJOR_FIRST && major <= PTY_SLAVE_MAJOR_LAST) {
    return `pts/${(major - PTY_SLAVE_MAJOR_FIRST) * 256 + minor}`
  }
  return `tty:${major}:${minor}`
}

/** Parse `/proc/<pid>/stat` + `cmdline` into the job-control columns of a `ps` row. */
export function parseLinuxProcProcessRow(
  pid: number,
  stat: string,
  cmdline: string,
  bootId: string
): ProcessTableRow | null {
  const openParen = stat.indexOf('(')
  const closeParen = stat.lastIndexOf(')')
  if (openParen === -1 || closeParen < openParen) {
    return null
  }
  const comm = stat.slice(openParen + 1, closeParen)
  // Fields after comm: state ppid pgrp session tty_nr tpgid ... starttime is the 20th.
  const fields = stat
    .slice(closeParen + 1)
    .trim()
    .split(/\s+/)
  const [state, ppidText, pgrpText, , ttyNrText, tpgidText] = fields
  const startTicks = fields[19]
  const ppid = Number(ppidText)
  const pgid = Number(pgrpText)
  const ttyNr = Number(ttyNrText)
  const tpgid = Number(tpgidText)
  if (
    !state ||
    !Number.isSafeInteger(ppid) ||
    !Number.isSafeInteger(pgid) ||
    !Number.isSafeInteger(ttyNr) ||
    !Number.isSafeInteger(tpgid) ||
    !/^\d+$/.test(startTicks ?? '') ||
    !bootId
  ) {
    return null
  }
  const argv = cmdline.split('\0')
  while (argv.length > 0 && argv.at(-1) === '') {
    argv.pop()
  }
  return {
    pid,
    ppid,
    pgid,
    tpgid,
    tty: linuxTtyName(ttyNr),
    // Same marker `readAgentProcess` produces, so hook identities still compare equal.
    startTime: `${bootId}:${startTicks}`,
    // `ps` appends `+` for a member of the terminal's foreground group.
    stat: pgid === tpgid && tpgid > 0 ? `${state}+` : state,
    command: argv.length > 0 ? argv.join(' ') : `[${comm}]`
  }
}

/**
 * Read one process's `ps`-equivalent row from procfs without spawning `ps`.
 * Resolves null when the process does not exist; rejects when it cannot be read.
 */
export async function readLinuxProcProcessRow(pid: number): Promise<ProcessTableRow | null> {
  let stat: string
  let cmdline: string
  try {
    ;[stat, cmdline] = await Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf8'),
      readFile(`/proc/${pid}/cmdline`, 'utf8')
    ])
  } catch (error) {
    if (isMissingProcess(error)) {
      return null
    }
    throw error
  }
  bootIdRead ??= readFile('/proc/sys/kernel/random/boot_id', 'utf8').then((text) => text.trim())
  const bootId = await bootIdRead.catch((error: unknown) => {
    bootIdRead = undefined
    throw error
  })
  const row = parseLinuxProcProcessRow(pid, stat, cmdline, bootId)
  if (!row) {
    throw new Error('linux_proc_row_unreadable')
  }
  return row
}
