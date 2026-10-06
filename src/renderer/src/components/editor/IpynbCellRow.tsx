import { memo } from 'react'
import { IpynbCellToolbar } from './IpynbCellToolbar'
import { IpynbCellSource } from './IpynbCellEditor'
import { IpynbCellRunOutputs, IpynbCellRunPrompt } from './IpynbCellRun'
import type { IpynbCell, IpynbCellKind } from './ipynb-parse'

/** Notebook-level handlers, keyed by cell index or key so one stable object serves every row. */
export type IpynbCellRowActions = {
  activate: (cellKey: string) => void
  deactivate: (cellKey: string) => void
  changeSource: (index: number, source: string) => void
  run: (index: number) => void
  keyDownCapture: (event: React.KeyboardEvent<HTMLElement>, index: number) => void
  changeKind: (index: number, kind: IpynbCellKind) => void
  insert: (index: number, kind: IpynbCellKind) => void
  move: (index: number, direction: -1 | 1) => void
  remove: (index: number) => void
}

type IpynbCellRowProps = {
  filePath: string
  cell: IpynbCell
  cellKey: string
  index: number
  isLast: boolean
  source: string
  active: boolean
  actions: IpynbCellRowActions
}

// Why: memoized so a keystroke or streamed output re-renders only the cell it belongs to.
export const IpynbCellRow = memo(function IpynbCellRow({
  filePath,
  cell,
  cellKey,
  index,
  isLast,
  source,
  active,
  actions
}: IpynbCellRowProps): React.JSX.Element {
  return (
    <section
      className="group relative flex gap-2 py-1.5"
      onKeyDownCapture={(event) => actions.keyDownCapture(event, index)}
    >
      {/* Mirrors the code surface's border and padding so the count shares the first line's box. */}
      <div className="flex w-12 shrink-0 justify-center border-y border-transparent py-1">
        {cell.kind === 'code' ? (
          <IpynbCellRunPrompt
            filePath={filePath}
            cellKey={cellKey}
            executionCount={cell.executionCount}
            onRun={() => actions.run(index)}
          />
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <IpynbCellSource
          cell={cell}
          source={source}
          active={active}
          onActivate={() => actions.activate(cellKey)}
          onDeactivate={() => actions.deactivate(cellKey)}
          onChange={(nextSource) => actions.changeSource(index, nextSource)}
        />
        <IpynbCellRunOutputs filePath={filePath} cellKey={cellKey} cell={cell} />
      </div>
      <IpynbCellToolbar
        kind={cell.kind}
        canMoveUp={index > 0}
        canMoveDown={!isLast}
        onKindChange={(kind) => actions.changeKind(index, kind)}
        onInsert={(offset, kind) => actions.insert(index + offset, kind)}
        onMove={(direction) => actions.move(index, direction)}
        onDelete={() => actions.remove(index)}
      />
    </section>
  )
})
