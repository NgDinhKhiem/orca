import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build as buildVite } from 'vite'

type FixtureResult = {
  step: string
  error?: string
  serverHits?: string[]
  // Why string: fetch probes report the bytes they read, others report loaded/blocked.
  probes?: Record<string, string>
}

const electronBinary = createRequire(import.meta.url)('electron') as string
const fixtureRoots: string[] = []

afterAll(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

// Why the real session gate: this is the one onBeforeRequest every browser profile installs, so the
// proof is that a file:// page in a profile session cannot reach the network or other local files.
function buildFixtureMain(bundlePath: string, resultPath: string, pagePath: string): string {
  return `
const { app, BrowserWindow, session } = require('electron')
const http = require('node:http')
const { writeFileSync } = require('node:fs')
const { pathToFileURL } = require('node:url')
const { BrowserCertificateRequestGuard } = require(${JSON.stringify(bundlePath)})
const resultPath = ${JSON.stringify(resultPath)}
let currentStep = 'starting'
const mark = (step) => {
  currentStep = step
  writeFileSync(resultPath, JSON.stringify({ step }))
}

async function run() {
  const timeout = setTimeout(() => {
    writeFileSync(resultPath, JSON.stringify({ step: 'timed out after ' + currentStep }))
    app.exit(1)
  }, 45000)
  await app.whenReady()
  const serverHits = []
  const server = http.createServer((req, res) => {
    serverHits.push(req.url)
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.end('network-bytes')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  const partition = 'persist:file-guest-containment-test'
  const guard = new BrowserCertificateRequestGuard({ onBlockedMainFrame: () => {} })
  guard.installSession(session.fromPartition(partition))
  const window = new BrowserWindow({ show: false, webPreferences: { partition, sandbox: true } })
  mark('window created')
  await window.loadURL(pathToFileURL(${JSON.stringify(pagePath)}).toString())
  mark('page loaded')
  const probes = await window.webContents.executeJavaScript(\`(async () => {
    const outcome = (promise) => promise.then(() => 'loaded', () => 'blocked')
    const text = (url) => fetch(url).then((r) => r.ok ? r.text() : Promise.reject(new Error(String(r.status))))
    const image = (url) => new Promise((resolve) => {
      const img = new Image()
      img.onload = () => resolve('loaded')
      img.onerror = () => resolve('blocked')
      img.src = url
    })
    const socket = (url) => new Promise((resolve) => {
      const ws = new WebSocket(url)
      ws.onopen = () => resolve('loaded')
      ws.onerror = () => resolve('blocked')
    })
    const srcdocFetch = () => new Promise((resolve) => {
      const frame = document.createElement('iframe')
      frame.srcdoc = '<script>fetch("\${origin}/srcdoc").then(() => parent.postMessage("loaded", "*"), () => parent.postMessage("blocked", "*"))<' + '/script>'
      window.addEventListener('message', (event) => resolve(String(event.data)), { once: true })
      document.body.appendChild(frame)
    })
    return {
      networkFetch: await outcome(text('\${origin}/fetch')),
      networkImage: await image('\${origin}/image.png'),
      networkSocket: await socket('\${origin.replace('http', 'ws')}/socket'),
      networkBeacon: navigator.sendBeacon('\${origin}/beacon', 'x') ? 'queued' : 'blocked',
      srcdocFetch: await srcdocFetch(),
      siblingAsset: await text('asset.txt').then((value) => value.trim(), () => 'blocked'),
      outsideFile: await text('../secret.txt').then((value) => value.trim(), () => 'blocked')
    }
  })()\`)
  // Why wait: sendBeacon is fire-and-forget, so give a leaked beacon time to land.
  await new Promise((resolve) => setTimeout(resolve, 1000))
  mark('probes finished')
  clearTimeout(timeout)
  writeFileSync(resultPath, JSON.stringify({ step: currentStep, serverHits, probes }))
  window.destroy()
  server.close()
  app.exit(0)
}

run().catch((error) => {
  writeFileSync(resultPath, JSON.stringify({ step: currentStep, error: String(error?.stack || error) }))
  app.exit(1)
})
`
}

async function runFixture(): Promise<FixtureResult> {
  const root = mkdtempSync(join(tmpdir(), 'orca-file-guest-'))
  fixtureRoots.push(root)
  const siteDirectory = join(root, 'site')
  mkdirSync(siteDirectory)
  const pagePath = join(siteDirectory, 'index.html')
  writeFileSync(pagePath, '<!doctype html><title>local preview</title><body></body>')
  writeFileSync(join(siteDirectory, 'asset.txt'), 'sibling-bytes')
  writeFileSync(join(root, 'secret.txt'), 'secret-bytes')
  const bundleEntryPath = join(root, 'guard-entry.ts')
  const bundlePath = join(root, 'guard.cjs')
  const resultPath = join(root, 'result.json')
  const fixturePath = join(root, 'main.cjs')
  writeFileSync(
    bundleEntryPath,
    `export { BrowserCertificateRequestGuard } from ${JSON.stringify(join(process.cwd(), 'src/main/browser/browser-certificate-request-guard.ts'))}`
  )
  await buildVite({
    configFile: false,
    logLevel: 'silent',
    build: {
      emptyOutDir: false,
      lib: { entry: bundleEntryPath, formats: ['cjs'], fileName: () => 'guard.cjs' },
      outDir: root,
      target: 'node20',
      rollupOptions: { external: ['electron', /^node:/] }
    }
  })
  writeFileSync(fixturePath, buildFixtureMain(bundlePath, resultPath, pagePath))
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...env } = process.env
  const electronArgs = [fixturePath, `--user-data-dir=${join(root, 'profile')}`]
  const executable = process.platform === 'linux' ? 'xvfb-run' : electronBinary
  const args =
    process.platform === 'linux'
      ? ['--auto-servernum', electronBinary, ...electronArgs, '--no-sandbox']
      : electronArgs
  const run = spawnSync(executable, args, {
    encoding: 'utf8',
    env: { ...env, ORCA_BACKGROUND_LAUNCH: '1' },
    timeout: 90_000
  })
  const fixtureResult = existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : 'no result'
  expect(run.error).toBeUndefined()
  expect(run.status, `${fixtureResult}\n${run.stdout}\n${run.stderr}`).toBe(0)
  return JSON.parse(fixtureResult)
}

describe('file:// browser guest containment', () => {
  let fixture: FixtureResult

  beforeAll(async () => {
    fixture = await runFixture()
  }, 120_000)

  it('ran every probe from the local page', () => {
    expect(fixture.step).toBe('probes finished')
  })

  it('keeps a previewed local page off the network', () => {
    expect(fixture.probes).toMatchObject({
      networkFetch: 'blocked',
      networkImage: 'blocked',
      networkSocket: 'blocked',
      srcdocFetch: 'blocked'
    })
    expect(fixture.serverHits).toEqual([])
  })

  it('still loads assets beside the document but not files outside its folder', () => {
    expect(fixture.probes?.siblingAsset).toBe('sibling-bytes')
    expect(fixture.probes?.outsideFile).toBe('blocked')
  })
})
