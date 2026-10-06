// @ts-nocheck -- mechanically split declarations.
import type { Store } from '../persistence'
import type {
  ResolvedRuntimeFileTarget,
  ResolvedRuntimeFileWorktree
} from './runtime-file-command-target'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { RuntimeNativeChatFileContext } from '../../shared/runtime-types'
import type { RuntimeNavigationTarget } from '../../shared/runtime-navigation'
import { MOBILE_BINARY_EXTENSIONS } from './runtime-file-commands-mobile-file-list-limit'
import { basenameFromRelativePath } from './runtime-file-paths'

export type RuntimeFileCommandHost = {
  getRuntimeId(): string
  requireStore(): Store
  resolveWorktreeSelector(selector: string): Promise<ResolvedRuntimeFileWorktree>
  resolveRuntimeFileTarget(selector: string): Promise<ResolvedRuntimeFileTarget>
  resolveKnownWorkspaceFileTarget?(
    absolutePath: string,
    executionHostId: ExecutionHostId
  ): Promise<(ResolvedRuntimeFileTarget & { relativePath: string }) | null>
  resolveTerminalCwd?(terminalHandle: string): string | null | Promise<string | null>
  resolveTerminalContext?(
    terminalHandle: string
  ): { worktreeId: string; connectionId: string | null } | null
  resolveTerminalFileUriHostname?(terminalHandle: string): string | null | Promise<string | null>
  hasRecentTerminalOutputPath?(
    terminalHandle: string,
    pathText: string,
    absolutePath: string
  ): boolean | Promise<boolean>
  hasRecentNativeChatOutputPath?(
    worktreeId: string,
    context: RuntimeNativeChatFileContext,
    pathText: string,
    absolutePath: string
  ): boolean | Promise<boolean>
  // `executionHostId`, not `connectionId`, on both target contracts: a repo row's connection cannot
  // tell `runtime:` from `local`, and neither may re-introduce that spelling. See
  // runtime-git-command-target and runtime-file-command-target.
  resolveRuntimeGitTarget(
    selector: string
  ): Promise<{ worktree: ResolvedRuntimeFileWorktree; executionHostId: ExecutionHostId }>
  openFile(
    worktreeId: string,
    filePath: string,
    relativePath: string,
    runtimeEnvironmentId?: string | null,
    navigation?: RuntimeNavigationTarget
  ): void
  openDiff(
    worktreeId: string,
    filePath: string,
    relativePath: string,
    staged: boolean,
    runtimeEnvironmentId?: string | null,
    navigation?: RuntimeNavigationTarget
  ): void
}

export function isSafeMobileRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(relativePath)) {
    return false
  }
  const parts = relativePath.replace(/\\/g, '/').split('/')
  return parts.every((part) => part !== '' && part !== '.' && part !== '..')
}

export function isMobileMarkdownPath(relativePath: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(relativePath)
}

export function isMobileBinaryPath(relativePath: string): boolean {
  const basename = basenameFromRelativePath(relativePath)
  const dotIndex = basename.lastIndexOf('.')
  if (dotIndex <= 0) {
    return false
  }
  return MOBILE_BINARY_EXTENSIONS.has(basename.slice(dotIndex).toLowerCase())
}

export function isRuntimeDirectoryEntry(entry: {
  isDirectory(): boolean
  isSymbolicLink(): boolean
}): boolean {
  // Why: listings are passive UI reads; don't stat symlink targets here (explicit open/expand resolves them).
  if (entry.isSymbolicLink()) {
    return false
  }
  if (entry.isDirectory()) {
    return true
  }
  return false
}

export function isBinaryBuffer(buffer: Buffer): boolean {
  const len = Math.min(buffer.length, 8192)
  for (let i = 0; i < len; i += 1) {
    if (buffer[i] === 0) {
      return true
    }
  }
  return false
}
