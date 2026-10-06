import { randomUUID } from 'node:crypto'
import { ipcMain, protocol } from 'electron'
import { PLUGIN_PANEL_CSP } from '../../shared/plugins/plugin-panel-shell'
import {
  PLUGIN_PANEL_DOCUMENT_SCHEME,
  buildPluginPanelDocumentUrl,
  parsePluginPanelDocumentId
} from '../../shared/plugins/plugin-panel-document-url'

const DEFAULT_MAX_DOCUMENTS_PER_OWNER = 32
// Why: a panel shell is plugin HTML plus a small prelude; this only bounds memory.
const DEFAULT_MAX_DOCUMENT_LENGTH = 16 * 1024 * 1024

type StoredPanelDocument = { ownerId: number; html: string }

export type PluginPanelDocumentStore = {
  publish(ownerId: number, html: unknown): string
  release(ownerId: number, url: unknown): void
  releaseOwner(ownerId: number): void
  read(url: string): string | null
}

export function createPluginPanelDocumentStore(
  options: { maxDocumentsPerOwner?: number; maxDocumentLength?: number } = {}
): PluginPanelDocumentStore {
  const maxDocumentsPerOwner = options.maxDocumentsPerOwner ?? DEFAULT_MAX_DOCUMENTS_PER_OWNER
  const maxDocumentLength = options.maxDocumentLength ?? DEFAULT_MAX_DOCUMENT_LENGTH
  // Map iteration order is insertion order, so the first owned entry is the oldest.
  const documents = new Map<string, StoredPanelDocument>()

  const ownedIds = (ownerId: number): string[] =>
    [...documents].filter(([, entry]) => entry.ownerId === ownerId).map(([id]) => id)

  return {
    publish(ownerId, html) {
      if (typeof html !== 'string' || html.length > maxDocumentLength) {
        throw new Error('Plugin panel document must be a string within the size limit')
      }
      const owned = ownedIds(ownerId)
      for (const staleId of owned.slice(0, Math.max(0, owned.length - maxDocumentsPerOwner + 1))) {
        documents.delete(staleId)
      }
      const documentId = randomUUID()
      documents.set(documentId, { ownerId, html })
      return buildPluginPanelDocumentUrl(documentId)
    },
    release(ownerId, url) {
      const documentId = typeof url === 'string' ? parsePluginPanelDocumentId(url) : null
      if (documentId && documents.get(documentId)?.ownerId === ownerId) {
        documents.delete(documentId)
      }
    },
    releaseOwner(ownerId) {
      for (const documentId of ownedIds(ownerId)) {
        documents.delete(documentId)
      }
    },
    read(url) {
      const documentId = parsePluginPanelDocumentId(url)
      return documentId ? (documents.get(documentId)?.html ?? null) : null
    }
  }
}

export function createPluginPanelDocumentResponse(html: string | null): Response {
  if (html === null) {
    return new Response('Not found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    })
  }
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Why: the shell's <meta> CSP stays; the header also binds content parsed before it.
      'Content-Security-Policy': PLUGIN_PANEL_CSP,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  })
}

/** Must run after app ready: serves renderer-published panel documents on the default session. */
export function registerPluginPanelDocumentHandlers(): void {
  const store = createPluginPanelDocumentStore()
  const trackedOwners = new Set<number>()

  if (!protocol.isProtocolHandled(PLUGIN_PANEL_DOCUMENT_SCHEME)) {
    protocol.handle(PLUGIN_PANEL_DOCUMENT_SCHEME, (request) =>
      createPluginPanelDocumentResponse(store.read(request.url))
    )
  }

  ipcMain.handle('plugins:publishPanelDocument', (event, html: unknown): string => {
    const owner = event.sender
    if (!trackedOwners.has(owner.id)) {
      trackedOwners.add(owner.id)
      owner.once('destroyed', () => {
        trackedOwners.delete(owner.id)
        store.releaseOwner(owner.id)
      })
    }
    return store.publish(owner.id, html)
  })
  ipcMain.handle('plugins:releasePanelDocument', (event, url: unknown): void => {
    store.release(event.sender.id, url)
  })
}
