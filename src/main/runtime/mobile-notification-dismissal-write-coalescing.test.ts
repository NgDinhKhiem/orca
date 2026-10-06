import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import type * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../shared/app-environment'
import { MobileNotificationDismissalStore } from './mobile-notification-dismissal-store'
import { RuntimeMobileNotificationController } from './runtime-mobile-notification-controller'

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})

const dirs: string[] = []
afterEach(() => {
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
  vi.mocked(renameSync).mockClear()
})

const dismiss = (notificationSeq: number) => ({
  type: 'dismiss' as const,
  notificationId: `alert-${notificationSeq}`,
  notificationEpoch: 'epoch',
  notificationSeq
})

it('coalesces a burst of notification records into one compact write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-dismissal-burst-'))
  dirs.push(dir)
  const file = join(dir, 'mobile-notification-dismissals.json')
  const store = new MobileNotificationDismissalStore(dir)
  const writesToFile = () =>
    vi.mocked(renameSync).mock.calls.filter(([, target]) => String(target) === file).length
  for (let seq = 0; seq < 30; seq++) {
    store.record(dismiss(seq))
  }
  expect(writesToFile()).toBe(0)
  store.flush()
  expect(writesToFile()).toBe(1)
  const text = readFileSync(file, 'utf8')
  expect(text).not.toContain('\n')
  const restarted = new MobileNotificationDismissalStore(dir)
  expect(restarted.reconcile([{ ...dismiss(29) }])).toHaveLength(1)
})

it('writes nothing on flush when nothing changed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-dismissal-idle-'))
  dirs.push(dir)
  const store = new MobileNotificationDismissalStore(dir)
  store.flush()
  expect(vi.mocked(renameSync)).not.toHaveBeenCalled()
})

it('persists pending dismissals from the will-quit hook', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-dismissal-quit-'))
  dirs.push(dir)
  const quitHandlers: (() => void)[] = []
  setAppEnvironment({
    getPath: () => dir,
    getAppPath: () => dir,
    getVersion: () => '0.0.0',
    isPackaged: () => false,
    onWillQuit: (handler) => quitHandlers.push(handler),
    exit: () => {},
    getAppMetrics: () => []
  })
  const controller = new RuntimeMobileNotificationController()
  controller.configureDismissalStore(dir)
  controller.dispatch(dismiss(7))
  const file = join(dir, 'mobile-notification-dismissals.json')
  expect(existsSync(file)).toBe(false)
  quitHandlers.forEach((handler) => handler())
  // The controller stamps its own replay seq and epoch, so match the persisted record by id.
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([
    expect.objectContaining({ notificationId: 'alert-7' })
  ])
})
