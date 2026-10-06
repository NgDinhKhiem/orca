import { describe, expect, it } from 'vitest'
import { PLUGIN_PANEL_FRAME_NAME_PREFIX } from '../../shared/plugins/plugin-panel-bridge'
import { buildPluginPanelDocumentUrl } from '../../shared/plugins/plugin-panel-document-url'
import { PluginPanelNavigationRegistry } from './plugin-panel-navigation-guard'

function frame(input: { id: number; name?: string; url?: string }) {
  let destroyed = false
  return {
    frameTreeNodeId: input.id,
    name: input.name ?? '',
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true
    }
  }
}

describe('PluginPanelNavigationRegistry', () => {
  it('blocks only host-marked plugin srcdoc frames', () => {
    const registry = new PluginPanelNavigationRegistry()
    const plugin = frame({ id: 1, name: `${PLUGIN_PANEL_FRAME_NAME_PREFIX}demo` })
    const notebook = frame({ id: 2 })
    registry.register(plugin)
    registry.register(notebook)

    expect(registry.shouldBlock(plugin, null, 'about:srcdoc')).toBe(false)
    expect(registry.shouldBlock(plugin, plugin, 'https://example.com')).toBe(true)
    expect(registry.shouldBlock(notebook, notebook, 'https://example.com')).toBe(false)
  })

  it('allows exactly one initial load of a published panel document URL', () => {
    const registry = new PluginPanelNavigationRegistry()
    const plugin = frame({ id: 1, name: `${PLUGIN_PANEL_FRAME_NAME_PREFIX}demo` })
    registry.register(plugin)
    const documentUrl = buildPluginPanelDocumentUrl('0b8f3c2e-4d5a-4e6f-8a9b-0c1d2e3f4a5b')

    expect(registry.shouldBlock(plugin, null, documentUrl)).toBe(false)
    expect(registry.shouldBlock(plugin, plugin, documentUrl)).toBe(true)
    expect(registry.shouldBlock(plugin, null, 'about:srcdoc')).toBe(true)
  })

  it('does not treat malformed panel URLs as the initial document', () => {
    const registry = new PluginPanelNavigationRegistry()
    const plugin = frame({ id: 1, name: `${PLUGIN_PANEL_FRAME_NAME_PREFIX}demo` })
    registry.register(plugin)

    expect(registry.shouldBlock(plugin, null, 'orca-plugin-panel://document/../x')).toBe(true)
  })

  it('keeps pre-parse identity after name mutation and prunes destroyed frames', () => {
    const registry = new PluginPanelNavigationRegistry()
    const plugin = frame({ id: 1, name: `${PLUGIN_PANEL_FRAME_NAME_PREFIX}demo` })
    registry.register(plugin)
    plugin.name = ''
    expect(registry.shouldBlock(plugin, null, 'about:srcdoc')).toBe(false)
    expect(registry.shouldBlock(plugin, plugin, 'https://example.com')).toBe(true)

    plugin.destroy()
    expect(registry.shouldBlock(plugin, plugin, 'https://example.com')).toBe(false)
  })
})
