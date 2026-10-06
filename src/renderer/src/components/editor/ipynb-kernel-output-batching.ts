import type { KernelFrame, KernelOutputType } from '../../../../shared/notebook-kernel-types'
import { applyKernelOutput } from './ipynb-kernel-outputs'
import { getSession, runningCellKey, store, updateSession } from './ipynb-kernel-store'

type KernelOutputFrame = Extract<KernelFrame, { type: KernelOutputType }>

// Why: a chatty cell emits thousands of frames a second; one store update per frame
// re-renders its outputs each time, so frames are buffered and written in batches.
const OUTPUT_FLUSH_MS = 50
const pendingOutputs = new Map<string, { key: string; frames: KernelOutputFrame[] }>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

/** Writes a notebook's buffered output frames into their run in one store update. */
export function flushKernelOutputs(filePath: string): void {
  const pending = pendingOutputs.get(filePath)
  if (!pending) {
    return
  }
  pendingOutputs.delete(filePath)
  if (pendingOutputs.size === 0 && flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  // A notebook whose tab closed meanwhile has no session left to write into.
  if (!(filePath in store.getState().sessions)) {
    return
  }
  updateSession(filePath, ({ runs }) => {
    const run = runs[pending.key]
    if (!run) {
      return {}
    }
    const next = pending.frames.reduce(
      (live, { type, content }) => applyKernelOutput(live, type, content),
      run
    )
    return { runs: { ...runs, [pending.key]: next } }
  })
}

function flushAllKernelOutputs(): void {
  flushTimer = null
  for (const filePath of pendingOutputs.keys()) {
    flushKernelOutputs(filePath)
  }
}

/** Buffers an output frame for the executing cell; it reaches the store within one flush interval. */
export function queueKernelOutput(filePath: string, frame: KernelOutputFrame): void {
  const key = runningCellKey(getSession(filePath))
  if (key === null) {
    return
  }
  const pending = pendingOutputs.get(filePath)
  if (pending && pending.key !== key) {
    flushKernelOutputs(filePath)
  }
  const frames = pendingOutputs.get(filePath)?.frames ?? []
  frames.push(frame)
  pendingOutputs.set(filePath, { key, frames })
  flushTimer ??= setTimeout(flushAllKernelOutputs, OUTPUT_FLUSH_MS)
}
