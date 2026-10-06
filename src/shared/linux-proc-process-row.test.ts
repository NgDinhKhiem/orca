import { describe, expect, it } from 'vitest'
import { parseLinuxProcProcessRow } from './linux-proc-process-row'

// state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt cmajflt utime stime
// cutime cstime priority nice num_threads itrealvalue starttime ...
function stat(pid: number, comm: string, fields: string): string {
  return `${pid} (${comm}) ${fields} 4194304 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 200\n`
}

describe('parseLinuxProcProcessRow', () => {
  it('produces the ps columns the tmux attachment proof reads', () => {
    expect(
      parseLinuxProcProcessRow(
        101,
        stat(101, 'tmux: client', 'S 100 101 100 34817 101'),
        'tmux\0attach\0-t\0main\0',
        'boot-1'
      )
    ).toEqual({
      pid: 101,
      ppid: 100,
      pgid: 101,
      tpgid: 101,
      tty: 'pts/1',
      startTime: 'boot-1:987654',
      stat: 'S+',
      command: 'tmux attach -t main'
    })
  })

  it('names high pty numbers and detached processes like ps', () => {
    // major 137 minor 4 -> pts/260
    const pty = parseLinuxProcProcessRow(7, stat(7, 'bash', 'S 1 7 7 35076 9'), 'bash\0', 'b')
    expect(pty?.tty).toBe('pts/260')
    expect(pty?.stat).toBe('S')
    const daemon = parseLinuxProcProcessRow(8, stat(8, 'kworker/0:1', 'I 2 0 0 0 -1'), '', 'b')
    expect(daemon).toMatchObject({ tty: '?', tpgid: -1, command: '[kworker/0:1]' })
  })

  it('keeps a comm containing parentheses and spaces intact', () => {
    const row = parseLinuxProcProcessRow(9, stat(9, 'a) (b', 'T 1 9 9 34816 9'), 'x\0', 'b')
    expect(row).toMatchObject({ ppid: 1, stat: 'T+', tty: 'pts/0' })
  })

  it('rejects a truncated stat line', () => {
    expect(parseLinuxProcProcessRow(9, '9 (bash) S 1', '', 'b')).toBeNull()
  })
})
