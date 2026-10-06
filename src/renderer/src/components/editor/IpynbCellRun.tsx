import { useMemo } from 'react'
import { formatToolDuration } from '../../../../shared/native-chat-tool-identity'
import { IpynbCellOutputs } from './IpynbCellOutputs'
import { IpynbRunPrompt } from './IpynbCellToolbar'
import type { NotebookOutput } from './ipynb-kernel-outputs'
import { useCellRun } from './ipynb-kernel-store'
import { parseIpynbOutput, type IpynbCell, type IpynbOutput } from './ipynb-parse'

type CellRunProps = { filePath: string; cellKey: string }

// Why: each streamed batch replaces only the last live output, so earlier outputs reuse their
// parse and keep their identity, letting their rendered views skip the update.
const parsedLiveOutputs = new WeakMap<NotebookOutput, IpynbOutput | null>()

function parseLiveOutput(output: NotebookOutput): IpynbOutput | null {
  if (!parsedLiveOutputs.has(output)) {
    parsedLiveOutputs.set(output, parseIpynbOutput(output))
  }
  return parsedLiveOutputs.get(output) ?? null
}

/** The gutter for a code cell, reflecting its run in the notebook's kernel session. */
export function IpynbCellRunPrompt({
  filePath,
  cellKey,
  executionCount,
  onRun
}: CellRunProps & { executionCount: number | null; onRun: () => void }): React.JSX.Element {
  const { run, queued } = useCellRun(filePath, cellKey)
  return (
    <IpynbRunPrompt
      executionCount={run && !run.committed ? run.executionCount : executionCount}
      state={run?.finishedAt === null ? 'running' : queued ? 'queued' : 'idle'}
      // Only a kernel execution has a duration worth showing, not an Orca notice.
      duration={
        run?.finishedAt && run.executionCount !== null
          ? formatToolDuration(run.finishedAt - run.startedAt)
          : null
      }
      onRun={onRun}
    />
  )
}

/** A cell's outputs: live from its run until the document takes them in, then from the document. */
export function IpynbCellRunOutputs({
  filePath,
  cellKey,
  cell
}: CellRunProps & { cell: IpynbCell }): React.JSX.Element | null {
  const { run } = useCellRun(filePath, cellKey)
  const live = useMemo(
    () =>
      run && !run.committed
        ? {
            ...cell,
            executionCount: run.executionCount,
            outputs: run.outputs
              .map(parseLiveOutput)
              .filter((output): output is IpynbOutput => output !== null)
          }
        : null,
    [cell, run]
  )
  return <IpynbCellOutputs cell={live ?? cell} />
}
