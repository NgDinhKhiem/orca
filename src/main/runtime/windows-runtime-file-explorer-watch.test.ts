import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type * as Fs from 'node:fs'

const { watchMock } = vi.hoisted(() => ({ watchMock: vi.fn() }))

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof Fs>('fs')
  return { ...actual, watch: watchMock }
})

import { watchWindowsRuntimeFileExplorer } from './windows-runtime-file-explorer-watch'
import { WINDOWS_RUNTIME_FILE_WATCH_DEBOUNCE_MS } from './runtime-file-commands-mobile-file-list-limit'

type FakeWatcher = EventEmitter & {
  close: ReturnType<typeof vi.fn>
  listener: (eventType: string, filename: string | null) => void
}

const watchers: FakeWatcher[] = []

function installFakeWatch(): void {
  watchMock.mockImplementation(
    (_rootPath: string, _options: unknown, listener: FakeWatcher['listener']) => {
      const watcher = Object.assign(new EventEmitter(), {
        close: vi.fn(() => queueMicrotask(() => watcher.emit('close'))),
        listener
      })
      watchers.push(watcher)
      return watcher
    }
  )
}

async function flushDebounce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(WINDOWS_RUNTIME_FILE_WATCH_DEBOUNCE_MS)
}

describe('watchWindowsRuntimeFileExplorer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    watchMock.mockReset()
    watchers.length = 0
    installFakeWatch()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shares one fs.watch per root and closes it with the last subscriber', async () => {
    const first = vi.fn()
    const second = vi.fn()
    const closeFirst = watchWindowsRuntimeFileExplorer('C:\\repo', first, vi.fn())
    const closeSecond = watchWindowsRuntimeFileExplorer('C:\\repo', second, vi.fn())

    expect(watchMock).toHaveBeenCalledTimes(1)
    watchers[0].listener('change', 'src\\a.ts')
    await flushDebounce()
    expect(first).toHaveBeenCalledWith([{ kind: 'overflow', absolutePath: 'C:\\repo' }])
    expect(second).toHaveBeenCalledWith([{ kind: 'overflow', absolutePath: 'C:\\repo' }])

    await closeFirst()
    expect(watchers[0].close).not.toHaveBeenCalled()
    watchers[0].listener('change', 'src\\b.ts')
    await flushDebounce()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)

    await closeSecond()
    expect(watchers[0].close).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shares roots that differ only by Windows drive-path case', async () => {
    const lower = vi.fn()
    const closeUpper = watchWindowsRuntimeFileExplorer('C:\\Repo', vi.fn(), vi.fn())
    const closeLower = watchWindowsRuntimeFileExplorer('c:\\repo', lower, vi.fn())

    expect(watchMock).toHaveBeenCalledTimes(1)
    watchers[0].listener('change', 'a.ts')
    await flushDebounce()
    // Each subscriber keeps its own root spelling in the overflow event.
    expect(lower).toHaveBeenCalledWith([{ kind: 'overflow', absolutePath: 'c:\\repo' }])
    await closeUpper()
    await closeLower()
    expect(watchers[0].close).toHaveBeenCalledTimes(1)
  })

  it('creates a fresh watcher after every subscriber has closed', async () => {
    await watchWindowsRuntimeFileExplorer('C:\\repo', vi.fn(), vi.fn())()
    const close = watchWindowsRuntimeFileExplorer('C:\\repo', vi.fn(), vi.fn())

    expect(watchMock).toHaveBeenCalledTimes(2)
    await close()
    expect(watchers[1].close).toHaveBeenCalledTimes(1)
  })

  it.each([
    'node_modules\\foo\\bar.js',
    'node_modules/foo',
    'node_modules',
    '.git\\index',
    'packages\\app\\dist\\bundle.js',
    'target\\debug\\build.log'
  ])('drops an event inside an ignored directory: %s', async (filename) => {
    const onEvents = vi.fn()
    const close = watchWindowsRuntimeFileExplorer('C:\\repo', onEvents, vi.fn())

    watchers[0].listener('change', filename)
    await flushDebounce()

    expect(onEvents).not.toHaveBeenCalled()
    await close()
  })

  it.each([['src\\a.ts'], ['src/a.ts'], ['node_modules_backup\\x.js'], [null]])(
    'notifies for a non-ignored or unknown event filename: %s',
    async (filename) => {
      const onEvents = vi.fn()
      const close = watchWindowsRuntimeFileExplorer('C:\\repo', onEvents, vi.fn())

      watchers[0].listener('rename', filename)
      await flushDebounce()

      expect(onEvents).toHaveBeenCalledTimes(1)
      await close()
    }
  )

  it('delivers a shared watcher error to every subscriber and re-creates on next subscribe', async () => {
    const firstEvents = vi.fn()
    const secondEvents = vi.fn()
    const firstError = vi.fn()
    const secondError = vi.fn()
    const closeFirst = watchWindowsRuntimeFileExplorer('C:\\repo', firstEvents, firstError)
    const closeSecond = watchWindowsRuntimeFileExplorer('C:\\repo', secondEvents, secondError)
    const error = new Error('native directory handle closed')

    watchers[0].emit('error', error)

    for (const onEvents of [firstEvents, secondEvents]) {
      expect(onEvents).toHaveBeenCalledWith([{ kind: 'overflow', absolutePath: 'C:\\repo' }])
    }
    expect(firstError).toHaveBeenCalledWith(error)
    expect(secondError).toHaveBeenCalledWith(error)

    const closeThird = watchWindowsRuntimeFileExplorer('C:\\repo', vi.fn(), vi.fn())
    expect(watchMock).toHaveBeenCalledTimes(2)

    await expect(closeFirst()).resolves.toBeUndefined()
    await expect(closeSecond()).resolves.toBeUndefined()
    expect(watchers[0].close).toHaveBeenCalledTimes(1)
    await closeThird()
    expect(watchers[1].close).toHaveBeenCalledTimes(1)
  })
})
