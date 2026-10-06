import type { ITheme } from '@xterm/xterm'
import { memo, useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import {
  DEFAULT_TERMINAL_THEME_DARK,
  DEFAULT_TERMINAL_THEME_LIGHT,
  getBuiltinTheme
} from '@/lib/terminal-theme'
import { IpynbMarkdownCell } from './IpynbCellEditor'
import { IpynbHtmlOutput } from './IpynbHtmlOutput'
import { parseAnsiSegments, type AnsiColor } from './ipynb-ansi'
import type { IpynbCell, IpynbOutput, IpynbOutputItem } from './ipynb-parse'
import { useDocumentDarkTheme } from '@/hooks/use-document-dark-theme'

const ANSI_PALETTE_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
] as const satisfies readonly (keyof ITheme)[]

// Why: the default terminal themes already carry ANSI palettes tuned for Orca's dark and light surfaces.
const ANSI_PALETTES = {
  dark: ANSI_PALETTE_KEYS.map((key) => getBuiltinTheme(DEFAULT_TERMINAL_THEME_DARK)?.[key]),
  light: ANSI_PALETTE_KEYS.map((key) => getBuiltinTheme(DEFAULT_TERMINAL_THEME_LIGHT)?.[key])
}

function valueToText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? '')).join('')
  }
  if (typeof value === 'string') {
    return value
  }
  if (value === undefined || value === null) {
    return ''
  }
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)
}

function dataUriForImage(item: IpynbOutputItem): string | null {
  const value = valueToText(item.value).replace(/\s/g, '')
  if (!value) {
    return null
  }
  if (item.mime === 'image/svg+xml') {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(valueToText(item.value))}`
  }
  return `data:${item.mime};base64,${value}`
}

function isRenderableMime(mime: string): boolean {
  return (
    mime.startsWith('image/') ||
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime.endsWith('+json')
  )
}

// Why: like Jupyter, a runaway stream shows only its tail so each streamed frame stays cheap to render.
const MAX_RENDERED_OUTPUT_LINES = 5_000

/** Keeps the last `maxLines` lines of `text`, reporting how many earlier lines were dropped. */
function capOutputLines(text: string): { shown: string; hiddenLineCount: number } {
  // A trailing newline ends the last line rather than starting an empty one.
  let cut = text.endsWith('\n') ? text.length - 1 : text.length
  for (let kept = 0; kept < MAX_RENDERED_OUTPUT_LINES; kept += 1) {
    cut = cut > 0 ? text.lastIndexOf('\n', cut - 1) : -1
    if (cut === -1) {
      return { shown: text, hiddenLineCount: 0 }
    }
  }
  let hiddenLineCount = 0
  for (let index = text.indexOf('\n'); index !== -1 && index <= cut;) {
    hiddenLineCount += 1
    index = text.indexOf('\n', index + 1)
  }
  return { shown: text.slice(cut + 1), hiddenLineCount }
}

function AnsiText({ text }: { text: string }): React.JSX.Element {
  const palette = ANSI_PALETTES[useDocumentDarkTheme() ? 'dark' : 'light']
  const segments = useMemo(() => parseAnsiSegments(text), [text])
  const resolve = (color: AnsiColor | undefined): string | undefined =>
    typeof color === 'number' ? palette[color] : color
  return (
    <>
      {segments.map((segment, index) => (
        <span
          key={index}
          style={{
            color: resolve(segment.fg),
            backgroundColor: resolve(segment.bg),
            fontWeight: segment.bold ? 600 : undefined,
            fontStyle: segment.italic ? 'italic' : undefined,
            textDecoration: segment.underline ? 'underline' : undefined
          }}
        >
          {segment.text}
        </span>
      ))}
    </>
  )
}

function TextOutput({ text, error = false }: { text: string; error?: boolean }) {
  const { shown, hiddenLineCount } = useMemo(() => capOutputLines(text), [text])
  return (
    <>
      {hiddenLineCount > 0 ? (
        <div className="px-3 text-xs text-muted-foreground">
          {translate(
            'auto.components.editor.IpynbViewer.outputLinesTruncated',
            '{{lines}} earlier lines truncated',
            { lines: hiddenLineCount }
          )}
        </div>
      ) : null}
      <pre
        className={cn(
          'max-h-[420px] overflow-auto whitespace-pre-wrap rounded-md px-3 py-2 font-mono text-xs leading-5 text-foreground scrollbar-editor',
          error && 'bg-destructive/10'
        )}
      >
        <AnsiText text={shown} />
      </pre>
    </>
  )
}

function DisplayItem({ item }: { item: IpynbOutputItem }): React.JSX.Element | null {
  if (item.mime === 'text/html') {
    return <IpynbHtmlOutput html={valueToText(item.value)} />
  }
  if (item.mime.startsWith('image/')) {
    const uri = dataUriForImage(item)
    return uri ? (
      <img
        src={uri}
        alt={item.mime}
        className="mx-3 max-h-[520px] max-w-full self-start object-contain"
      />
    ) : null
  }
  if (item.mime === 'text/markdown') {
    return <IpynbMarkdownCell source={valueToText(item.value)} />
  }
  return <TextOutput text={valueToText(item.value)} />
}

// Why: streaming re-renders a cell's outputs per batch; earlier, unchanged outputs keep their identity.
const Output = memo(function Output({ output }: { output: IpynbOutput }): React.JSX.Element | null {
  if (output.kind === 'stream') {
    return <TextOutput text={output.text} error={output.name === 'stderr'} />
  }
  if (output.kind === 'error') {
    // Jupyter tracebacks already end with "ename: evalue".
    return <TextOutput error text={output.traceback || `${output.name}: ${output.message}`} />
  }
  // Items arrive richest-first; like Jupyter, show only the best representation.
  const item = output.items.find((candidate) => isRenderableMime(candidate.mime))
  return item ? <DisplayItem item={item} /> : null
})

export function IpynbCellOutputs({ cell }: { cell: IpynbCell }): React.JSX.Element | null {
  if (cell.outputs.length === 0) {
    return null
  }
  return (
    <div className="flex min-w-0 flex-col gap-1 pt-2">
      {cell.outputs.map((output, index) => (
        // Scoping by run means a re-execution remounts outputs instead of reusing stale frames.
        <Output key={`${cell.executionCount}:${index}`} output={output} />
      ))}
    </div>
  )
}
