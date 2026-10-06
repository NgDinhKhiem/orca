import { describe, expect, it } from 'vitest'
import { appendRecentPtyPathCandidates } from './terminal-output-path-candidates'

const PATH_OUTPUT = [
  'Wrote /tmp/orca/report.md and /tmp/orca/out.json',
  'error at /home/u/app/src/main.rs:42:7 in fn',
  'see /repo/docs/guide.md#L12C3 for details',
  'open file:///C:/Users/me/a.txt now',
  'skip file://server/share/remote.txt here',
  '"/quoted/path/file.tsx" <tag>',
  '  /var/log/app.log: permission denied',
  '\u001b[32m/usr/local/bin/node.exe\u001b[0m',
  'C:\\Users\\me\\proj\\file.cs(12,3): error',
  '/a.tar.gz, done.',
  '/path/with spaces/and.dots in/the.name end',
  'diff --git a/src/x.ts b/src/x.ts'
].join('\r\n')

describe('appendRecentPtyPathCandidates', () => {
  it('extracts the same candidates as before the linear scanners', () => {
    expect(appendRecentPtyPathCandidates(undefined, PATH_OUTPUT)).toMatchInlineSnapshot(`
      [
        "/tmp/orca/report.md",
        "/tmp/orca/report.md",
        "/home/u/app/src/main.rs",
        "/repo/docs/guide.md",
        "/C:/Users/me/a.txt",
        "C:/Users/me/a.txt",
        "e:///C:/Users/me/a.txt",
        "///C:/Users/me/a.txt",
        "//server/share/remote.txt",
        "e://server/share/remote.txt",
        "//server/share/remote.txt",
        "/quoted/path/file.tsx",
        "/var/log/app.log: permission denied",
        "/usr/local/bin/node.exe",
        "C:\\Users\\me\\proj\\file.cs(12,3): error",
        "/a.tar.gz",
        "/path/with spaces/and.dots in/the.name",
        "/src/x.ts b/src/x.ts",
      ]
    `)
  })

  it('scans a 64 KiB chunk of extensionless slash runs in linear time', () => {
    const line = `${'/'.repeat(4000)}\n`
    const chunk = line.repeat(16)
    const startedAt = performance.now()
    expect(appendRecentPtyPathCandidates(undefined, chunk)).toEqual([])
    expect(performance.now() - startedAt).toBeLessThan(40)
  })

  it('trims a candidate with many extension tokens without rescanning each prefix', () => {
    const line = `/a.b ${'c.d '.repeat(1000)}\n`
    const chunk = line.repeat(16)
    const startedAt = performance.now()
    expect(appendRecentPtyPathCandidates(undefined, chunk)).toEqual(
      Array(16).fill(`/a.b ${'c.d '.repeat(998)}c.d`)
    )
    expect(performance.now() - startedAt).toBeLessThan(20)
  })

  it('trims a candidate with a long extensionless tail in linear time', () => {
    const line = `/a.b ${'x'.repeat(4000)}\n`
    const chunk = line.repeat(16)
    const startedAt = performance.now()
    appendRecentPtyPathCandidates(undefined, chunk)
    expect(performance.now() - startedAt).toBeLessThan(40)
  })
})
