import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isLaunchableFileName,
  isLaunchableOpenTarget,
  isLaunchableOpenTargetPath
} from './shell-launchable-open-target'

const WINDOWS_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL'

describe('isLaunchableFileName', () => {
  it.each([
    'setup.exe',
    'run.bat',
    'run.cmd',
    'old.com',
    'shortcut.lnk',
    'link.url',
    'explorer.scf',
    'app.hta',
    'script.js',
    'script.jse',
    'script.vbs',
    'script.vbe',
    'script.wsf',
    'script.wsh',
    'install.msi',
    'console.msc',
    'script.ps1',
    'module.psm1',
    'keys.reg',
    'panel.cpl',
    'tool.jar',
    'clickonce.appref-ms',
    'deploy.application',
    'settings.settingcontent-ms',
    'saver.scr',
    'legacy.pif',
    'run.sh',
    'script.py',
    'script.pyw'
  ])('treats %s as launchable on Windows', (name) => {
    expect(isLaunchableFileName(name, 'win32', WINDOWS_PATHEXT)).toBe(true)
  })

  it('compares Windows extensions case-insensitively', () => {
    expect(isLaunchableFileName('SETUP.EXE', 'win32', WINDOWS_PATHEXT)).toBe(true)
    expect(isLaunchableFileName('Payload.Ps1', 'win32', WINDOWS_PATHEXT)).toBe(true)
  })

  it('ignores trailing dots and spaces that Windows strips before launching', () => {
    expect(isLaunchableFileName('setup.exe.', 'win32', WINDOWS_PATHEXT)).toBe(true)
    expect(isLaunchableFileName('setup.exe . .', 'win32', WINDOWS_PATHEXT)).toBe(true)
    expect(isLaunchableFileName('setup.exe   ', 'win32', WINDOWS_PATHEXT)).toBe(true)
  })

  it('treats NTFS alternate data stream names as launchable', () => {
    expect(isLaunchableFileName('file.txt:stream', 'win32', WINDOWS_PATHEXT)).toBe(true)
    expect(isLaunchableFileName('setup.exe::$DATA', 'win32', WINDOWS_PATHEXT)).toBe(true)
  })

  it('adds custom PATHEXT entries', () => {
    expect(isLaunchableFileName('script.rb', 'win32', '.COM;.EXE;.RB')).toBe(true)
    expect(isLaunchableFileName('script.tcl', 'win32', WINDOWS_PATHEXT)).toBe(false)
    expect(isLaunchableFileName('script.tcl', 'win32', `${WINDOWS_PATHEXT};.TCL`)).toBe(true)
  })

  it.each(['notes.md', 'report.pdf', 'image.png', 'data.json', 'README', 'archive.tar.gz'])(
    'keeps %s openable on Windows',
    (name) => {
      expect(isLaunchableFileName(name, 'win32', WINDOWS_PATHEXT)).toBe(false)
    }
  )

  it.each([
    'Calculator.app',
    'run.command',
    'shell.terminal',
    'thing.tool',
    'automation.workflow',
    'installer.pkg',
    'installer.mpkg',
    'tool.jar',
    'redirect.fileloc',
    'redirect.inetloc',
    'RUN.COMMAND'
  ])('treats %s as launchable on macOS', (name) => {
    expect(isLaunchableFileName(name, 'darwin')).toBe(true)
  })

  it.each(['launcher.desktop', 'install.sh', 'Tool.AppImage', 'tool.appimage', 'setup.run'])(
    'treats %s as launchable on Linux',
    (name) => {
      expect(isLaunchableFileName(name, 'linux')).toBe(true)
    }
  )

  it('treats Windows binaries as launchable on POSIX hosts that may run them through Wine', () => {
    expect(isLaunchableFileName('setup.exe', 'linux')).toBe(true)
    expect(isLaunchableFileName('setup.msi', 'darwin')).toBe(true)
  })

  it.each(['notes.md', 'photo.jpg', 'index.html', 'Makefile'])(
    'keeps %s openable on POSIX',
    (name) => {
      expect(isLaunchableFileName(name, 'darwin')).toBe(false)
      expect(isLaunchableFileName(name, 'linux')).toBe(false)
    }
  )

  it('does not treat colons as streams outside Windows', () => {
    expect(isLaunchableFileName('notes:draft.md', 'linux')).toBe(false)
  })
})

describe('isLaunchableOpenTarget', () => {
  const file = { isDirectory: false, mode: 0o100644 }
  const directory = { isDirectory: true, mode: 0o040755 }

  it('allows plain directories on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(
        isLaunchableOpenTarget({
          requestedPath: '/work/docs',
          resolvedPath: '/work/docs',
          stats: directory,
          platform,
          pathExt: WINDOWS_PATHEXT
        })
      ).toBe(false)
    }
  })

  it('blocks macOS app bundles even though they are directories', () => {
    expect(
      isLaunchableOpenTarget({
        requestedPath: '/Applications/Calculator.app',
        resolvedPath: '/Applications/Calculator.app',
        stats: directory,
        platform: 'darwin'
      })
    ).toBe(true)
  })

  it('allows a directory named like a bundle outside macOS', () => {
    expect(
      isLaunchableOpenTarget({
        requestedPath: '/work/site.app',
        resolvedPath: '/work/site.app',
        stats: directory,
        platform: 'linux'
      })
    ).toBe(false)
  })

  it('blocks POSIX files with any executable bit', () => {
    for (const mode of [0o100755, 0o100744, 0o100654, 0o100645]) {
      expect(
        isLaunchableOpenTarget({
          requestedPath: '/work/notes',
          resolvedPath: '/work/notes',
          stats: { isDirectory: false, mode },
          platform: 'linux'
        })
      ).toBe(true)
    }
    expect(
      isLaunchableOpenTarget({
        requestedPath: '/work/notes',
        resolvedPath: '/work/notes',
        stats: { isDirectory: false, mode: 0o100755 },
        platform: 'darwin'
      })
    ).toBe(true)
  })

  it('ignores mode bits on Windows, where they do not mean executable', () => {
    expect(
      isLaunchableOpenTarget({
        requestedPath: 'C:\\work\\notes.md',
        resolvedPath: 'C:\\work\\notes.md',
        stats: { isDirectory: false, mode: 0o100777 },
        platform: 'win32',
        pathExt: WINDOWS_PATHEXT
      })
    ).toBe(false)
  })

  it('blocks a harmless-looking link whose real target is launchable', () => {
    expect(
      isLaunchableOpenTarget({
        requestedPath: 'C:\\work\\notes.md',
        resolvedPath: 'C:\\tools\\payload.exe',
        stats: file,
        platform: 'win32',
        pathExt: WINDOWS_PATHEXT
      })
    ).toBe(true)
  })

  it('uses the Windows basename even for drive-qualified ADS paths', () => {
    expect(
      isLaunchableOpenTarget({
        requestedPath: 'C:\\work\\notes.txt:payload.exe',
        resolvedPath: 'C:\\work\\notes.txt:payload.exe',
        stats: file,
        platform: 'win32',
        pathExt: WINDOWS_PATHEXT
      })
    ).toBe(true)
    expect(
      isLaunchableOpenTarget({
        requestedPath: 'C:\\work\\notes.md',
        resolvedPath: 'C:\\work\\notes.md',
        stats: file,
        platform: 'win32',
        pathExt: WINDOWS_PATHEXT
      })
    ).toBe(false)
  })
})

describe('isLaunchableOpenTargetPath', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-launchable-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('allows real documents and directories', async () => {
    const note = join(root, 'note.md')
    await writeFile(note, '# hi')
    const folder = join(root, 'docs')
    await mkdir(folder)

    await expect(isLaunchableOpenTargetPath(note)).resolves.toBe(false)
    await expect(isLaunchableOpenTargetPath(folder)).resolves.toBe(false)
  })

  it('blocks real launchable files by extension', async () => {
    const script = join(root, 'payload.jar')
    await writeFile(script, 'x')

    await expect(isLaunchableOpenTargetPath(script)).resolves.toBe(true)
  })

  it.runIf(process.platform !== 'win32')('blocks a real file with the executable bit', async () => {
    const script = join(root, 'notes')
    await writeFile(script, '#!/bin/sh\necho hi\n')
    await chmod(script, 0o755)

    await expect(isLaunchableOpenTargetPath(script)).resolves.toBe(true)
  })

  it.runIf(process.platform !== 'win32')(
    'blocks a document-named symlink to a launchable file',
    async () => {
      const payload = join(root, 'payload.desktop')
      await writeFile(payload, '[Desktop Entry]')
      const link = join(root, 'notes.md')
      await symlink(payload, link)

      await expect(isLaunchableOpenTargetPath(link)).resolves.toBe(true)
    }
  )

  it('fails closed when the target cannot be inspected', async () => {
    await expect(isLaunchableOpenTargetPath(join(root, 'missing.md'))).resolves.toBe(true)
  })
})
