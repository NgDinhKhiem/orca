import { realpath, stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'

// Why: "open with the default app" runs these instead of displaying them, so a
// clicked link must never hand them to shell.openPath.
const WINDOWS_LAUNCHABLE_EXTENSIONS = [
  '.exe',
  '.com',
  '.bat',
  '.cmd',
  '.pif',
  '.scr',
  '.cpl',
  '.msc',
  '.msi',
  '.msp',
  '.mst',
  '.lnk',
  '.url',
  '.website',
  '.scf',
  '.hta',
  '.js',
  '.jse',
  '.vb',
  '.vbs',
  '.vbe',
  '.wsf',
  '.wsh',
  '.ws',
  '.wsc',
  '.sct',
  '.ps1',
  '.ps1xml',
  '.ps2',
  '.ps2xml',
  '.psc1',
  '.psc2',
  '.psd1',
  '.psm1',
  '.msh',
  '.msh1',
  '.msh2',
  '.mshxml',
  '.reg',
  '.inf',
  '.jar',
  '.appref-ms',
  '.application',
  '.xbap',
  '.gadget',
  '.settingcontent-ms',
  '.diagcab',
  '.appx',
  '.appxbundle',
  '.msix',
  '.msixbundle',
  '.library-ms',
  '.search-ms',
  '.searchconnector-ms',
  '.shb',
  '.shs',
  '.chm',
  // Git for Windows and the py launcher register these as runnable.
  '.sh',
  '.bash',
  '.py',
  '.pyw',
  '.pyz',
  '.pyzw'
]

// Why: Wine/CrossOver register Windows binaries with xdg-open and LaunchServices.
const WINE_LAUNCHABLE_EXTENSIONS = ['.exe', '.com', '.bat', '.cmd', '.msi', '.lnk', '.scr']

const MACOS_BUNDLE_EXTENSIONS = [
  '.app',
  '.workflow',
  '.action',
  '.pkg',
  '.mpkg',
  '.prefpane',
  '.saver',
  '.qlgenerator'
]

const MACOS_LAUNCHABLE_EXTENSIONS = [
  ...MACOS_BUNDLE_EXTENSIONS,
  '.command',
  '.terminal',
  '.tool',
  '.jar',
  '.fileloc',
  '.inetloc',
  '.sh',
  ...WINE_LAUNCHABLE_EXTENSIONS
]

const LINUX_LAUNCHABLE_EXTENSIONS = [
  '.desktop',
  '.sh',
  '.bash',
  '.appimage',
  '.run',
  '.jar',
  ...WINE_LAUNCHABLE_EXTENSIONS
]

const LAUNCHABLE_EXTENSIONS_BY_PLATFORM: Partial<Record<NodeJS.Platform, ReadonlySet<string>>> = {
  win32: new Set(WINDOWS_LAUNCHABLE_EXTENSIONS),
  darwin: new Set(MACOS_LAUNCHABLE_EXTENSIONS)
}
const POSIX_LAUNCHABLE_EXTENSIONS: ReadonlySet<string> = new Set(LINUX_LAUNCHABLE_EXTENSIONS)
const MACOS_BUNDLE_EXTENSION_SET: ReadonlySet<string> = new Set(MACOS_BUNDLE_EXTENSIONS)
const POSIX_ANY_EXECUTE_BIT = 0o111

function pathApiFor(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix
}

function lowerExtension(fileName: string, platform: NodeJS.Platform): string {
  return pathApiFor(platform).extname(fileName).toLowerCase()
}

function parsePathExt(pathExt: string | undefined): string[] {
  return (pathExt ?? '')
    .split(';')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.startsWith('.') && entry.length > 1)
}

/** True when the OS default-app handler would run this file name rather than show it. */
export function isLaunchableFileName(
  fileName: string,
  platform: NodeJS.Platform,
  pathExt?: string
): boolean {
  if (platform === 'win32') {
    // Why: any colon in a Windows file name addresses an NTFS alternate stream.
    if (fileName.includes(':')) {
      return true
    }
    // Why: Win32 path normalization drops trailing dots and spaces, so
    // `setup.exe. ` launches setup.exe.
    const launchedName = fileName.replace(/[. ]+$/, '')
    const extension = lowerExtension(launchedName, platform)
    return (
      WINDOWS_LAUNCHABLE_EXTENSIONS.includes(extension) || parsePathExt(pathExt).includes(extension)
    )
  }
  const extensions = LAUNCHABLE_EXTENSIONS_BY_PLATFORM[platform] ?? POSIX_LAUNCHABLE_EXTENSIONS
  return extensions.has(lowerExtension(fileName, platform))
}

export type LaunchableOpenTargetFacts = {
  requestedPath: string
  /** The path after resolving symlinks; the OS launches what this names. */
  resolvedPath: string
  stats: { isDirectory: boolean; mode: number }
  platform: NodeJS.Platform
  pathExt?: string
}

export function isLaunchableOpenTarget(facts: LaunchableOpenTargetFacts): boolean {
  const { platform, stats } = facts
  const pathApi = pathApiFor(platform)
  const names = [pathApi.basename(facts.requestedPath), pathApi.basename(facts.resolvedPath)]

  if (stats.isDirectory) {
    // Why: macOS launches bundle directories (Foo.app) instead of browsing them.
    return (
      platform === 'darwin' &&
      names.some((name) => MACOS_BUNDLE_EXTENSION_SET.has(lowerExtension(name, platform)))
    )
  }
  if (names.some((name) => isLaunchableFileName(name, platform, facts.pathExt))) {
    return true
  }
  // Why: Windows mode bits never encode executability; POSIX launchers honor them.
  return platform !== 'win32' && (stats.mode & POSIX_ANY_EXECUTE_BIT) !== 0
}

/** Inspects a local path; anything that cannot be inspected counts as launchable. */
export async function isLaunchableOpenTargetPath(
  targetPath: string,
  platform: NodeJS.Platform = process.platform,
  pathExt: string | undefined = process.env.PATHEXT
): Promise<boolean> {
  try {
    const [resolvedPath, targetStats] = await Promise.all([realpath(targetPath), stat(targetPath)])
    return isLaunchableOpenTarget({
      requestedPath: targetPath,
      resolvedPath,
      stats: { isDirectory: targetStats.isDirectory(), mode: targetStats.mode },
      platform,
      pathExt
    })
  } catch {
    return true
  }
}
