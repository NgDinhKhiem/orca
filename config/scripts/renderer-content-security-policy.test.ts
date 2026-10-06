import { describe, expect, it } from 'vitest'
import type { HtmlTagDescriptor, IndexHtmlTransformContext, Plugin } from 'vite'
import {
  RENDERER_CONTENT_SECURITY_POLICY,
  RENDERER_CSP_PLUGIN_NAME,
  ZOD_JITLESS_SCRIPT_FILE,
  createRendererContentSecurityPolicyPlugin
} from '../build-plugins/renderer-content-security-policy'
import { electronViteConfig } from '../../electron.vite.config'
import { PLUGIN_PANEL_DOCUMENT_SCHEME } from '../../src/shared/plugins/plugin-panel-document-url'

function directive(name: string): string[] {
  const entry = RENDERER_CONTENT_SECURITY_POLICY.split(';')
    .map((part) => part.trim().split(/\s+/))
    .find(([directiveName]) => directiveName === name)
  if (!entry) {
    throw new Error(`missing ${name}`)
  }
  return entry.slice(1)
}

function transform(plugin: Plugin, filename: string): unknown {
  const hook = plugin.transformIndexHtml
  const handler = typeof hook === 'function' ? hook : hook?.handler
  if (!handler) {
    throw new Error('plugin has no transformIndexHtml handler')
  }
  const context: IndexHtmlTransformContext = { path: `/${filename}`, filename }
  return Reflect.apply(handler, undefined, ['<html><head></head><body></body></html>', context])
}

function isTagList(value: unknown): value is HtmlTagDescriptor[] {
  return Array.isArray(value)
}

describe('renderer content security policy', () => {
  it('keeps scripts to bundled files with no inline or eval escape hatch', () => {
    expect(directive('script-src')).toEqual(["'self'", "'wasm-unsafe-eval'"])
    expect(RENDERER_CONTENT_SECURITY_POLICY).not.toContain("'unsafe-eval'")
    expect(directive('object-src')).toEqual(["'none'"])
    expect(directive('base-uri')).toEqual(["'none'"])
    expect(directive('form-action')).toEqual(["'none'"])
    expect(directive('default-src')).toEqual(["'self'"])
  })

  it('frames plugin panels from their own CSP-bearing scheme', () => {
    expect(directive('frame-src')).toContain(`${PLUGIN_PANEL_DOCUMENT_SCHEME}:`)
  })

  it('injects the policy and the zod jitless script into the desktop documents only', () => {
    const plugin = createRendererContentSecurityPolicyPlugin()
    expect(plugin.apply).toBe('build')

    for (const filename of ['/repo/src/renderer/index.html', '/repo/src/renderer/popout.html']) {
      const tags = transform(plugin, filename)
      if (!isTagList(tags)) {
        throw new Error(`no tags for ${filename}`)
      }
      expect(tags[0]).toMatchObject({
        tag: 'meta',
        attrs: {
          'http-equiv': 'Content-Security-Policy',
          content: RENDERER_CONTENT_SECURITY_POLICY
        },
        injectTo: 'head-prepend'
      })
      expect(tags[1]).toMatchObject({
        tag: 'script',
        attrs: { src: `./${ZOD_JITLESS_SCRIPT_FILE}` },
        injectTo: 'head-prepend'
      })
    }
    expect(transform(plugin, '/repo/src/renderer/web-index.html')).toBeUndefined()
  })

  it('is part of the electron-vite renderer build', () => {
    const plugins = (electronViteConfig.renderer?.plugins ?? []).flat()
    const names = plugins.map((plugin) =>
      plugin && typeof plugin === 'object' && 'name' in plugin ? plugin.name : null
    )
    expect(names).toContain(RENDERER_CSP_PLUGIN_NAME)
  })
})
