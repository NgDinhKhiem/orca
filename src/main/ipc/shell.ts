import { validatePathExistenceBatch } from '../../shared/path-existence-batch'
import { ipcMain, shell, dialog } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, normalize, posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  ShellOpenExternalEditorRequest,
  ShellOpenExternalEditorResult,
  ShellOpenLocalPathResult
} from '../../shared/shell-open-types'
import { MAX_REPO_ICON_UPLOAD_BYTES } from '../../shared/repo-icon'
import type { Store } from '../persistence'
import {
  EXTERNAL_EDITOR_CLI_COMMAND,
  launchExternalEditor,
  resolveExternalEditorLaunchSpec,
  resolveVsCodeRemoteSshLaunchSpec
} from '../external-editor-launch'
import { resolveVsCodeSshAuthority } from '../ssh/vscode-ssh-authority'
import { isLaunchableOpenTargetPath } from './shell-launchable-open-target'

export { EXTERNAL_EDITOR_CLI_COMMAND }

const REPO_ICON_IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png'
}

async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await stat(pathValue)
    return true
  } catch {
    return false
  }
}

async function validateLocalPathTarget(
  pathValue: string
): Promise<{ ok: true; path: string } | { ok: false; reason: 'not-absolute' | 'not-found' }> {
  const normalizedPath = normalize(pathValue)
  if (!isAbsolute(normalizedPath)) {
    return { ok: false, reason: 'not-absolute' }
  }
  if (!(await pathExists(normalizedPath))) {
    return { ok: false, reason: 'not-found' }
  }
  return { ok: true, path: normalizedPath }
}

// Why: Settings → Keybindings offers these bare launchers without an Open In entry.
const BUILT_IN_EXTERNAL_EDITOR_COMMANDS = new Set([EXTERNAL_EDITOR_CLI_COMMAND, 'cursor'])

/**
 * Returns the editor command to run, or null when the renderer named one the
 * user never configured. Commands may run through a shell, so only persisted
 * settings are trusted to supply them.
 */
function resolveConfiguredEditorCommand(
  store: Store,
  requestedCommand: string | undefined
): string | undefined | null {
  const command = requestedCommand?.trim()
  if (!command) {
    return undefined
  }
  if (BUILT_IN_EXTERNAL_EDITOR_COMMANDS.has(command)) {
    return command
  }
  const configured = store
    .getSettings()
    .openInApplications?.find((application) => application.command.trim() === command)
  return configured ? configured.command.trim() : null
}

function hasActiveRuntime(store: Store): boolean {
  return Boolean(store.getSettings().activeRuntimeEnvironmentId?.trim())
}

async function openInFileManager(
  store: Store,
  pathValue: string
): Promise<ShellOpenLocalPathResult> {
  if (hasActiveRuntime(store)) {
    return { ok: false, reason: 'remote-runtime-unsupported' }
  }
  const target = await validateLocalPathTarget(pathValue)
  if (!target.ok) {
    return target
  }
  try {
    // Why: the file-manager action uses reveal semantics, matching the
    // previous sidebar behavior while still validating the path per click.
    shell.showItemInFolder(target.path)
    return { ok: true }
  } catch {
    return { ok: false, reason: 'launch-failed' }
  }
}

async function openInExternalEditor(
  store: Store,
  request: ShellOpenExternalEditorRequest
): Promise<ShellOpenExternalEditorResult> {
  if (hasActiveRuntime(store)) {
    return { ok: false, reason: 'remote-runtime-unsupported' }
  }
  const command = resolveConfiguredEditorCommand(store, request.command)
  if (command === null) {
    return { ok: false, reason: 'launch-failed' }
  }

  const connectionId = request.connectionId?.trim()
  if (connectionId) {
    const sshTarget = store.getSshTarget(connectionId)
    if (!sshTarget) {
      return { ok: false, reason: 'ssh-target-not-found' }
    }
    if (sshTarget.owner?.type === 'on-demand-runtime') {
      return { ok: false, reason: 'remote-runtime-unsupported' }
    }
    if (!posix.isAbsolute(request.path) && !win32.isAbsolute(request.path)) {
      return { ok: false, reason: 'not-absolute' }
    }
    const authority = resolveVsCodeSshAuthority(sshTarget)
    if (!authority.ok) {
      return authority
    }
    const launchSpec = resolveVsCodeRemoteSshLaunchSpec(command, request.path, authority.authority)
    if (!launchSpec) {
      return { ok: false, reason: 'remote-editor-unsupported' }
    }
    try {
      await launchExternalEditor(launchSpec)
      return { ok: true }
    } catch {
      return { ok: false, reason: 'launch-failed' }
    }
  }

  const target = await validateLocalPathTarget(request.path)
  if (!target.ok) {
    return target
  }
  try {
    await launchExternalEditor(resolveExternalEditorLaunchSpec(command, target.path))
    return { ok: true }
  } catch {
    return { ok: false, reason: 'launch-failed' }
  }
}

async function openWithSystemDefault(pathValue: string): Promise<boolean> {
  const target = await validateLocalPathTarget(pathValue)
  if (!target.ok) {
    return false
  }
  try {
    if (await isLaunchableOpenTargetPath(target.path)) {
      // Why: a clicked link must never run a program; revealing it leaves the
      // decision to the user in their file manager.
      shell.showItemInFolder(target.path)
      return true
    }
    const errorMessage = await shell.openPath(target.path)
    return errorMessage.length === 0
  } catch {
    return false
  }
}

export function registerShellHandlers(store: Store): void {
  ipcMain.handle('shell:openPath', async (_event, path: string): Promise<void> => {
    // Why: keep the legacy fire-and-forget renderer contract while reusing the
    // same absolute/existing path validation as the explicit file-manager API.
    void (await openInFileManager(store, path))
  })

  ipcMain.handle(
    'shell:openInFileManager',
    (_event, path: string): Promise<ShellOpenLocalPathResult> => openInFileManager(store, path)
  )

  ipcMain.handle(
    'shell:openInExternalEditor',
    (_event, request: ShellOpenExternalEditorRequest): Promise<ShellOpenExternalEditorResult> =>
      openInExternalEditor(store, request)
  )

  ipcMain.handle('shell:openUrl', (_event, rawUrl: string) => {
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      return
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return
    }

    return shell.openExternal(parsed.toString())
  })

  ipcMain.handle('shell:openFilePath', async (_event, filePath: string): Promise<boolean> => {
    return openWithSystemDefault(filePath)
  })

  ipcMain.handle('shell:openFileUri', async (_event, rawUri: string) => {
    let parsed: URL
    try {
      parsed = new URL(rawUri)
    } catch {
      return
    }

    if (parsed.protocol !== 'file:') {
      return
    }

    // Only local files are supported. Remote hosts are intentionally rejected.
    if (parsed.hostname && parsed.hostname !== 'localhost') {
      return
    }

    let filePath: string
    try {
      filePath = fileURLToPath(parsed)
    } catch {
      return
    }

    const target = await validateLocalPathTarget(filePath)
    if (!target.ok) {
      return
    }

    await openWithSystemDefault(target.path)
  })

  ipcMain.handle('shell:pathsExist', async (_event, paths: string[]): Promise<boolean[]> => {
    validatePathExistenceBatch(paths)
    return Promise.all(paths.map(pathExists))
  })

  ipcMain.handle('shell:pathExists', async (_event, filePath: string): Promise<boolean> => {
    return pathExists(filePath)
  })

  ipcMain.handle(
    'shell:pickDirectory',
    async (_event, args: { defaultPath?: string }): Promise<string | null> => {
      const result = await dialog.showOpenDialog({
        defaultPath: args.defaultPath,
        // Why: callers only need an existing folder grant; enabling native
        // creation can leave typed prefix directories behind on macOS.
        properties: ['openDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) {
        return null
      }
      return result.filePaths[0]
    }
  )

  // Why: window.prompt() and <input type="file"> are unreliable in Electron,
  // so we use the native OS dialog to let the user pick any attachment file.
  ipcMain.handle('shell:pickAttachment', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  // Why: window.prompt() and <input type="file"> are unreliable in Electron,
  // so we use the native OS dialog to let the user pick an image file.
  ipcMain.handle('shell:pickImage', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  ipcMain.handle(
    'shell:pickRepoIconImage',
    async (): Promise<{ dataUrl: string; fileName: string } | null> => {
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Repo icon images', extensions: ['png'] }]
      })
      if (result.canceled || result.filePaths.length === 0) {
        return null
      }

      const filePath = result.filePaths[0]
      const extension = extname(filePath).toLowerCase()
      const mimeType = REPO_ICON_IMAGE_MIME_TYPES[extension]
      if (!mimeType) {
        throw new Error('Repo icons must be PNG files.')
      }

      const stats = await stat(filePath)
      if (stats.size > MAX_REPO_ICON_UPLOAD_BYTES) {
        throw new Error('Repo icon image must be 256KB or smaller.')
      }

      const buffer = await readFile(filePath)
      return {
        dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
        fileName: basename(filePath)
      }
    }
  )

  ipcMain.handle('shell:pickAudio', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['ogg', 'mp3', 'wav', 'm4a', 'aac', 'flac'] }]
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })
}
