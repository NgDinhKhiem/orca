import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { build as buildVite } from 'vite'
import { resolveElectronProbeLaunch } from '../browser/electron-probe-display-launch'

const electronModule: unknown = createRequire(import.meta.url)('electron')
if (typeof electronModule !== 'string') {
  throw new Error('electron did not resolve to its binary path')
}
const electronBinary = electronModule
const fixtureRoots: string[] = []

type ProbeResults = Record<string, unknown>

afterAll(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

const PRELOAD_SOURCE = `
const { contextBridge, ipcRenderer } = require('electron')
const describe = (error) => 'error:' + String(error && error.message ? error.message : error)
contextBridge.exposeInMainWorld('probe', {
  invoke: (channel, value) => ipcRenderer.invoke(channel, value).catch(describe),
  sendSync: (channel) => {
    try { return ipcRenderer.sendSync(channel) } catch (error) { return describe(error) }
  },
  send: (channel, value) => ipcRenderer.send(channel, value)
})
`

function fixtureMain(options: {
  gatePath: string
  rendererDirectory: string
  preloadPath: string
  otherHtmlPath: string
  resultPath: string
}): string {
  return `
const { app, BrowserWindow, ipcMain } = require('electron')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { writeFileSync } = require('node:fs')
const { installAppIpcSenderGate, registerTrustedAppWebContents } = require(${JSON.stringify(options.gatePath)})

const rendererDirectory = ${JSON.stringify(options.rendererDirectory)}
const preloadPath = ${JSON.stringify(options.preloadPath)}
installAppIpcSenderGate(ipcMain, { rendererDirectory, devServerUrl: null })

ipcMain.handle('probe:invoke', (_event, value) => 'ok:' + value)
ipcMain.handleOnce('probe:once', () => 'once-ok')
ipcMain.on('probe:sync', (event) => { event.returnValue = 'sync-ok' })
const asyncMessages = []
const asyncListener = (_event, value) => asyncMessages.push(value)
ipcMain.on('probe:async', asyncListener)
const linkClicks = []
ipcMain.on('docPreview:linkClick', (_event, url) => linkClicks.push(url))

const settle = () => new Promise((resolve) => setTimeout(resolve, 300))
const probe = (target, expression) => target.executeJavaScript(expression)

function createWindow(extra) {
  return new BrowserWindow({
    show: false,
    webPreferences: { preload: preloadPath, sandbox: true, contextIsolation: true, ...extra }
  })
}

async function run() {
  const timeout = setTimeout(() => {
    writeFileSync(${JSON.stringify(options.resultPath)}, JSON.stringify({ error: 'fixture timeout' }))
    app.exit(1)
  }, 45000)
  await app.whenReady()
  const results = {}

  const trusted = createWindow({ nodeIntegrationInSubFrames: true, webviewTag: true })
  registerTrustedAppWebContents(trusted.webContents)
  let guest = null
  trusted.webContents.on('did-attach-webview', (_event, contents) => { guest = contents })
  await trusted.loadFile(join(rendererDirectory, 'index.html'))
  const deadline = Date.now() + 10000
  while ((!guest || guest.isLoading() || trusted.webContents.mainFrame.frames.length === 0) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (!guest) throw new Error('webview guest never attached')

  results.trustedInvoke = await probe(trusted.webContents, "window.probe.invoke('probe:invoke', 1)")
  results.trustedOnce = await probe(trusted.webContents, "window.probe.invoke('probe:once')")
  results.trustedSync = await probe(trusted.webContents, "window.probe.sendSync('probe:sync')")
  await probe(trusted.webContents, "window.probe.send('probe:async', 'trusted')")

  const subframe = trusted.webContents.mainFrame.frames[0]
  results.subframeInvoke = await probe(subframe, "window.probe.invoke('probe:invoke', 2)")
  results.subframeSync = await probe(subframe, "window.probe.sendSync('probe:sync')")
  await probe(subframe, "window.probe.send('probe:async', 'subframe')")

  results.guestInvoke = await probe(guest, "window.probe.invoke('probe:invoke', 3)")
  results.guestSync = await probe(guest, "window.probe.sendSync('probe:sync')")
  await probe(guest, "window.probe.send('probe:async', 'guest')")
  await probe(guest, "window.probe.send('docPreview:linkClick', 'https://example.com/')")

  const unregistered = createWindow({})
  await unregistered.loadFile(join(rendererDirectory, 'index.html'))
  results.unregisteredInvoke = await probe(unregistered.webContents, "window.probe.invoke('probe:invoke', 4)")

  const wrongDocument = createWindow({})
  registerTrustedAppWebContents(wrongDocument.webContents)
  await wrongDocument.loadFile(${JSON.stringify(options.otherHtmlPath)})
  results.wrongDocumentInvoke = await probe(wrongDocument.webContents, "window.probe.invoke('probe:invoke', 5)")

  await settle()
  ipcMain.removeListener('probe:async', asyncListener)
  await probe(trusted.webContents, "window.probe.send('probe:async', 'after-remove')")
  await settle()
  results.asyncMessages = asyncMessages
  results.linkClicks = linkClicks
  results.asyncListenerCount = ipcMain.listenerCount('probe:async')

  clearTimeout(timeout)
  writeFileSync(${JSON.stringify(options.resultPath)}, JSON.stringify(results))
  app.exit(0)
}

run().catch((error) => {
  writeFileSync(${JSON.stringify(options.resultPath)}, JSON.stringify({ error: String(error && error.stack ? error.stack : error) }))
  app.exit(1)
})
`
}

async function runFixture(): Promise<ProbeResults> {
  const root = mkdtempSync(join(tmpdir(), 'orca-ipc-sender-gate-'))
  fixtureRoots.push(root)
  const rendererDirectory = join(root, 'renderer')
  mkdirSync(rendererDirectory)
  const preloadPath = join(root, 'preload.cjs')
  const guestHtmlPath = join(root, 'guest.html')
  const otherHtmlPath = join(root, 'other.html')
  const resultPath = join(root, 'result.json')
  const mainPath = join(root, 'main.cjs')

  writeFileSync(preloadPath, PRELOAD_SOURCE)
  writeFileSync(guestHtmlPath, '<!doctype html><body>guest</body>')
  writeFileSync(otherHtmlPath, '<!doctype html><body>other</body>')
  writeFileSync(join(rendererDirectory, 'frame.html'), '<!doctype html><body>frame</body>')
  writeFileSync(
    join(rendererDirectory, 'index.html'),
    `<!doctype html><body><iframe src="./frame.html"></iframe><webview src="${pathToFileURL(guestHtmlPath).toString()}" preload="${pathToFileURL(preloadPath).toString()}"></webview></body>`
  )
  await buildVite({
    configFile: false,
    logLevel: 'silent',
    build: {
      emptyOutDir: false,
      lib: {
        entry: join(process.cwd(), 'src/main/ipc/trusted-ipc-sender-gate.ts'),
        formats: ['cjs'],
        fileName: () => 'gate.cjs'
      },
      outDir: root,
      target: 'node20',
      rollupOptions: { external: ['electron', 'node:path', 'node:url'] }
    }
  })
  writeFileSync(
    mainPath,
    fixtureMain({
      gatePath: join(root, 'gate.cjs'),
      rendererDirectory,
      preloadPath,
      otherHtmlPath,
      resultPath
    })
  )

  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...env } = process.env
  const { executable, args } = resolveElectronProbeLaunch({
    electronBinary,
    electronArgs: [mainPath, `--user-data-dir=${join(root, 'profile')}`],
    platform: process.platform,
    display: env.DISPLAY
  })
  const run = spawnSync(executable, args, { encoding: 'utf8', env, timeout: 75_000 })
  const rawResult = existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : 'no result'
  expect(run.error).toBeUndefined()
  expect(run.status, `${rawResult}\n${run.stdout}\n${run.stderr}`).toBe(0)
  const parsed: unknown = JSON.parse(rawResult)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`unexpected fixture result: ${rawResult}`)
  }
  return Object.fromEntries(Object.entries(parsed))
}

describe('trusted IPC sender gate under Electron', () => {
  it('serves the app window main frame and refuses subframes, guests and other documents', async () => {
    const results = await runFixture()

    expect(results.trustedInvoke).toBe('ok:1')
    expect(results.trustedOnce).toBe('once-ok')
    expect(results.trustedSync).toBe('sync-ok')

    expect(results.subframeInvoke).toMatch(/untrusted sender/)
    expect(results.subframeSync).toBeNull()
    expect(results.guestInvoke).toMatch(/untrusted sender/)
    expect(results.guestSync).toBeNull()
    expect(results.unregisteredInvoke).toMatch(/untrusted sender/)
    expect(results.wrongDocumentInvoke).toMatch(/untrusted sender/)

    // Only the trusted window's message lands, and removal by original reference works.
    expect(results.asyncMessages).toEqual(['trusted'])
    expect(results.asyncListenerCount).toBe(0)
    // The doc-preview guest channel stays reachable for its own guest check.
    expect(results.linkClicks).toEqual(['https://example.com/'])
  }, 120_000)
})
