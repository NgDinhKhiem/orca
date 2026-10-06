import { isImeOwnedKeyboardEvent } from '@/lib/ime-composition-keyboard-event'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Save } from 'lucide-react'
import { computeEditorFontSize } from '@/lib/editor-font-zoom'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useShortcutKeyDetails } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { editorShortcutMatches } from './editor-shortcuts'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { getConnectionId } from '@/lib/connection-context'
import { IpynbToolbarButton } from './IpynbCellToolbar'
import { IpynbCellRow, type IpynbCellRowActions } from './IpynbCellRow'
import { IpynbKernelToolbar } from './IpynbKernelToolbar'
import { parseIpynbReusingKnown, type ParsedIpynb } from './ipynb-parse'
import {
  getIpynbCellKey,
  hasIpynbSourceDraft,
  useIpynbDocumentEditing
} from './useIpynbDocumentEditing'
import { useIpynbCellExecution } from './useIpynbCellExecution'
import { useIpynbScrollRestoration } from './useIpynbScrollRestoration'

type IpynbViewerProps = {
  content: string
  fileId: string
  filePath: string
  worktreeId: string
  scrollCacheKey: string
  onContentChange: (content: string) => void
  onDirtyStateHint: (dirty: boolean) => void
  onSave: (content: string) => Promise<boolean>
}

export default function IpynbViewer({
  content,
  fileId,
  filePath,
  worktreeId,
  scrollCacheKey,
  onContentChange,
  onDirtyStateHint,
  onSave
}: IpynbViewerProps): React.JSX.Element {
  const editorFontZoomLevel = useAppStore((s) => s.editorFontZoomLevel)
  const rootPath = useAppStore((s) => findWorktreeById(s.worktreesByRepo, worktreeId)?.path ?? null)
  const [editingCellKey, setEditingCellKey] = useState<string | null>(null)
  const parsed = useMemo((): { notebook: ParsedIpynb | null; error: string | null } => {
    try {
      return { notebook: parseIpynbReusingKnown(content), error: null }
    } catch (error) {
      return {
        notebook: null,
        error: error instanceof Error ? error.message : 'Invalid notebook'
      }
    }
  }, [content])
  const deactivateEditor = useCallback((): void => setEditingCellKey(null), [])
  const {
    rootRef,
    setRootRef,
    sourceDrafts,
    flushSourceDrafts,
    applyContent,
    updateCellSource,
    updateCellKind,
    insertCell,
    moveCell,
    deleteCell
  } = useIpynbDocumentEditing({
    content,
    fileId,
    notebook: parsed.notebook,
    onContentChange,
    onDirtyStateHint,
    onDeactivateEditor: deactivateEditor
  })
  const execution = useIpynbCellExecution({
    filePath,
    worktreeId,
    rootPath,
    flushSourceDrafts,
    applyContent
  })
  useIpynbScrollRestoration(rootRef, scrollCacheKey, content)
  const saveShortcut = useShortcutKeyDetails('editor.save')
  const fontSize = computeEditorFontSize(13, editorFontZoomLevel)

  const saveNotebook = useCallback(async (): Promise<void> => {
    const latestContent = flushSourceDrafts()
    await onSave(latestContent)
  }, [flushSourceDrafts, onSave])

  const handleNotebookKeyDownCapture = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (event.repeat || !editorShortcutMatches('editor.save', event)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      void saveNotebook()
    },
    [saveNotebook]
  )

  // Why: runCell is rebuilt every render; rows reach it through a ref so their props stay stable.
  const runCellRef = useRef(execution.runCell)
  useLayoutEffect(() => {
    runCellRef.current = execution.runCell
  })
  const cellRowActions = useMemo((): IpynbCellRowActions => {
    const run = (index: number): void => runCellRef.current(index)
    return {
      activate: (cellKey) => setEditingCellKey(cellKey),
      deactivate: (cellKey) =>
        setEditingCellKey((current) => (current === cellKey ? null : current)),
      changeSource: updateCellSource,
      run,
      // Shift+Enter runs a cell and moves to the next; Cmd/Ctrl+Enter runs it in place.
      keyDownCapture: (event, index) => {
        const mod = getShortcutPlatform() === 'darwin' ? event.metaKey : event.ctrlKey
        // Exactly one of Shift or Cmd/Ctrl.
        if (
          isImeOwnedKeyboardEvent(event) ||
          event.key !== 'Enter' ||
          event.altKey ||
          event.shiftKey === mod
        ) {
          return
        }
        event.preventDefault()
        event.stopPropagation()
        run(index)
        if (event.shiftKey) {
          // Focusing the next cell's preview also ends editing here, so repeated presses walk the notebook.
          event.currentTarget.nextElementSibling
            ?.querySelector<HTMLElement>('[tabindex="0"]')
            ?.focus()
        }
      },
      changeKind: updateCellKind,
      insert: insertCell,
      move: moveCell,
      remove: deleteCell
    }
  }, [updateCellSource, updateCellKind, insertCell, moveCell, deleteCell])

  if (parsed.error || !parsed.notebook) {
    return (
      <div className="flex h-full items-center justify-center bg-editor-surface p-6 text-sm text-muted-foreground">
        <div className="flex max-w-md items-start gap-3 rounded-md border border-border bg-background p-4">
          <AlertCircle className="mt-0.5 size-4 text-destructive" />
          <div>
            <div className="font-medium text-foreground">
              {translate(
                'auto.components.editor.IpynbViewer.c1601b23b2',
                'Unable to render notebook'
              )}
            </div>
            <div className="mt-1">{parsed.error}</div>
          </div>
        </div>
      </div>
    )
  }

  const { notebook } = parsed
  // Kernels are local Python only; other notebooks still render and edit.
  const canRun = notebook.language === 'python' && !getConnectionId(worktreeId)
  return (
    <div
      ref={setRootRef}
      className="h-full min-h-0 overflow-auto bg-editor-surface scrollbar-editor"
      style={{ fontSize }}
      onKeyDownCapture={handleNotebookKeyDownCapture}
    >
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-border/60 bg-background/95 px-4 py-2 text-xs text-muted-foreground backdrop-blur">
        <span className="font-medium text-foreground">{filePath.split(/[/\\]/).pop()}</span>
        <span>
          {notebook.cells.length}{' '}
          {translate('auto.components.editor.IpynbViewer.07e7d96612', 'cells')}
        </span>
        <span>{notebook.language}</span>
        <div className="ml-auto flex items-center gap-2">
          {canRun ? (
            <IpynbKernelToolbar
              filePath={filePath}
              rootPath={rootPath}
              onRunAll={() => execution.runAll(notebook.cells.length)}
              onClearAll={execution.clearAllOutputs}
            />
          ) : null}
          <IpynbToolbarButton
            label={translate('auto.components.editor.IpynbViewer.15ec40a735', 'Save notebook')}
            shortcut={saveShortcut}
            onClick={() => void saveNotebook()}
          >
            <Save className="size-3.5" />
          </IpynbToolbarButton>
        </div>
      </div>
      <div className="mx-auto flex max-w-[980px] flex-col gap-2 py-5 pr-5 pl-2">
        {notebook.cells.length === 0 ? (
          <div className="flex items-center justify-center rounded-md border border-border bg-background p-8 text-sm text-muted-foreground">
            {translate('auto.components.editor.IpynbViewer.d6f37a640b', 'Empty notebook')}
          </div>
        ) : (
          notebook.cells.map((cell, index) => {
            const cellKey = getIpynbCellKey(cell, index)
            const source = hasIpynbSourceDraft(sourceDrafts, cellKey)
              ? (sourceDrafts[cellKey] ?? '')
              : cell.source
            return (
              <IpynbCellRow
                key={cellKey}
                filePath={filePath}
                cell={cell}
                cellKey={cellKey}
                index={index}
                isLast={index === notebook.cells.length - 1}
                source={source}
                active={editingCellKey === cellKey}
                actions={cellRowActions}
              />
            )
          })
        )}
      </div>
      <Dialog
        open={execution.pendingRun !== null}
        onOpenChange={(open) => {
          if (!open) {
            execution.cancelPendingRun()
          }
        }}
      >
        <DialogContent className="max-w-md sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-sm">
              {translate('auto.components.editor.IpynbViewer.9e06ae5d36', 'Run Notebook Code?')}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {translate(
                'auto.components.editor.IpynbViewer.10ed04a685',
                'Notebook cells execute local Python on this machine from the notebook folder. Only run cells from files you trust.'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" size="sm" onClick={execution.cancelPendingRun}>
              {translate('auto.components.editor.IpynbViewer.7f0d7077c6', 'Cancel')}
            </Button>
            <Button type="button" size="sm" autoFocus onClick={execution.confirmPendingRun}>
              {translate('auto.components.editor.IpynbViewer.859bf9fc21', 'Run cell')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
