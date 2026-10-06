import type { KernelOutputType } from '../../../../shared/notebook-kernel-types'
import { isRecord } from './ipynb-parse'

/** An nbformat v4 output; while live it may also carry the kernel's `transient.display_id`. */
export type NotebookOutput = Record<string, unknown>

export type LiveOutputs = {
  outputs: NotebookOutput[]
  /** `clear_output(wait=True)`: clear when the next output arrives, so updates do not flicker. */
  clearOnNextOutput: boolean
}

/** Applies terminal-style `\r` rewrites (progress bars), keeping trailing `\r`s for the next chunk. */
export function collapseCarriageReturns(text: string): string {
  // Why: a trailing `\r\r` must survive whole, or a `\n` in the next chunk erases its line.
  return text.replace(/\r+\n/g, '\n').replace(/^[^\n]*\r(?=[^\n\r])/gm, '')
}

/** Collapsed stream text split at its last `\n`; only `tail` can still be rewritten by a `\r`. */
type StreamText = { finished: string; tail: string; tailEndsWithCr: boolean }

// Why: reading a concatenated string flattens (copies) it, so appends track the parts per
// output object instead of touching its whole `text`, keeping a long stream linear.
const streamTexts = new WeakMap<NotebookOutput, StreamText>()

function splitStreamText(collapsed: string): StreamText {
  const lineStart = collapsed.lastIndexOf('\n') + 1
  return {
    finished: collapsed.slice(0, lineStart),
    tail: collapsed.slice(lineStart),
    tailEndsWithCr: collapsed.endsWith('\r')
  }
}

function appendStreamChunk(parts: StreamText, chunk: string): StreamText {
  if (!parts.tailEndsWithCr && !chunk.includes('\r')) {
    const lineStart = chunk.lastIndexOf('\n') + 1
    return lineStart === 0
      ? { ...parts, tail: parts.tail + chunk }
      : {
          finished: parts.finished + parts.tail + chunk.slice(0, lineStart),
          tail: chunk.slice(lineStart),
          tailEndsWithCr: false
        }
  }
  // Collapsed text holds `\r` only in its last line, so finished lines never change.
  const rewritten = splitStreamText(collapseCarriageReturns(parts.tail + chunk))
  return { ...rewritten, finished: parts.finished + rewritten.finished }
}

function streamOutput(base: NotebookOutput, parts: StreamText): NotebookOutput {
  const output = { ...base, text: parts.finished + parts.tail }
  streamTexts.set(output, parts)
  return output
}

function displayId(value: unknown): unknown {
  return isRecord(value) && isRecord(value.transient) ? value.transient.display_id : undefined
}

function toOutput(type: KernelOutputType, content: Record<string, unknown>): NotebookOutput {
  if (type === 'error') {
    return {
      output_type: type,
      ename: content.ename ?? '',
      evalue: content.evalue ?? '',
      traceback: content.traceback ?? []
    }
  }
  const bundle = { data: content.data ?? {}, metadata: content.metadata ?? {} }
  if (type === 'execute_result') {
    return { output_type: type, execution_count: content.execution_count ?? null, ...bundle }
  }
  return displayId(content) === undefined
    ? { output_type: 'display_data', ...bundle }
    : { output_type: 'display_data', ...bundle, transient: content.transient }
}

export function applyKernelOutput<T extends LiveOutputs>(
  live: T,
  type: KernelOutputType,
  content: Record<string, unknown>
): T {
  if (type === 'clear_output') {
    return content.wait
      ? { ...live, clearOnNextOutput: true }
      : { ...live, outputs: [], clearOnNextOutput: false }
  }
  if (type === 'update_display_data') {
    const id = displayId(content)
    return {
      ...live,
      outputs: live.outputs.map((output) =>
        id !== undefined && displayId(output) === id
          ? { ...output, data: content.data ?? {}, metadata: content.metadata ?? {} }
          : output
      )
    }
  }
  const outputs = live.clearOnNextOutput ? [] : live.outputs
  const last = outputs.at(-1)
  if (type === 'stream' && last?.output_type === 'stream' && last.name === content.name) {
    const parts = streamTexts.get(last) ?? splitStreamText(String(last.text))
    const text = appendStreamChunk(parts, String(content.text ?? ''))
    return {
      ...live,
      outputs: [...outputs.slice(0, -1), streamOutput(last, text)],
      clearOnNextOutput: false
    }
  }
  const output =
    type === 'stream'
      ? streamOutput(
          { output_type: type, name: content.name ?? 'stdout' },
          splitStreamText(collapseCarriageReturns(String(content.text ?? '')))
        )
      : toOutput(type, content)
  return { ...live, outputs: [...outputs, output], clearOnNextOutput: false }
}

/** Drops live-only fields so the outputs are valid nbformat. */
export function toStoredOutputs(outputs: NotebookOutput[]): NotebookOutput[] {
  return outputs.map(({ transient: _transient, ...output }) => output)
}
