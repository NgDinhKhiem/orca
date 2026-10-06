import { basename } from 'node:path'
import type { Plugin } from 'vite'
import { PLUGIN_PANEL_DOCUMENT_SCHEME } from '../../src/shared/plugins/plugin-panel-document-url'

export const RENDERER_CSP_PLUGIN_NAME = 'orca-renderer-content-security-policy'
export const ZOD_JITLESS_SCRIPT_FILE = 'zod-jitless.js'

/**
 * Production policy for the desktop app documents. Dev skips it: Vite HMR needs
 * inline React-refresh and a websocket to the dev server.
 * `'self'` under file:// matches the bundled out/renderer files.
 */
export const RENDERER_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  // Why: oniguruma, the xterm image addon and pdf.js compile WebAssembly; no JS eval is allowed.
  "script-src 'self' 'wasm-unsafe-eval'",
  // Why: pdf.js starts its worker from a blob: URL under file://.
  "worker-src 'self' blob:",
  // Why: React style attributes and editor/terminal/diagram libraries inject inline styles.
  "style-src 'self' 'unsafe-inline'",
  // Why: markdown and PR bodies show remote images; the emulator streams MJPEG from 127.0.0.1.
  "img-src 'self' data: blob: https: http:",
  "media-src 'self' blob: https:",
  "font-src 'self' data:",
  // Why: the emulator control stream is a loopback websocket.
  "connect-src 'self' data: blob: ws://127.0.0.1:* ws://localhost:*",
  // Why: plugin panels load from their own scheme so they do not inherit this script-src.
  // http(s) stays allowed so the main-process panel navigation guard, not a CSP error page,
  // answers a panel's attempt to navigate itself; the frame is sandboxed either way.
  `frame-src 'self' ${PLUGIN_PANEL_DOCUMENT_SCHEME}: http: https:`,
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

// Why: zod probes `new Function('')`, which this policy reports on every load; jitless skips the
// probe. A classic script runs before any module, so it beats module-scope schema construction.
const ZOD_JITLESS_SOURCE =
  'globalThis.__zod_globalConfig = { ...(globalThis.__zod_globalConfig ?? {}), jitless: true }\n'

const CSP_DOCUMENTS = new Set(['index.html', 'popout.html'])

export function createRendererContentSecurityPolicyPlugin(): Plugin {
  return {
    name: RENDERER_CSP_PLUGIN_NAME,
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: ZOD_JITLESS_SCRIPT_FILE,
        source: ZOD_JITLESS_SOURCE
      })
    },
    transformIndexHtml: {
      // Why: post order keeps Vite from trying to bundle the classic jitless script.
      order: 'post',
      handler(_html, context) {
        if (!CSP_DOCUMENTS.has(basename(context.filename))) {
          return undefined
        }
        return [
          {
            tag: 'meta',
            attrs: {
              'http-equiv': 'Content-Security-Policy',
              content: RENDERER_CONTENT_SECURITY_POLICY
            },
            injectTo: 'head-prepend'
          },
          {
            tag: 'script',
            attrs: { src: `./${ZOD_JITLESS_SCRIPT_FILE}` },
            injectTo: 'head-prepend'
          }
        ]
      }
    }
  }
}
