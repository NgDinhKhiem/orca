import Markdown from 'react-markdown'
import { renderToStaticMarkup } from 'react-dom/server'
import rehypeRaw from 'rehype-raw'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CommentMarkdown from './CommentMarkdown'

const rawRuns = vi.hoisted(() => ({ count: 0 }))
vi.mock('rehype-raw', async (importOriginal) => {
  const original = await importOriginal<{ default: typeof rehypeRaw }>()
  return {
    default: (...args: Parameters<typeof original.default>) => {
      const transform = original.default(...args)
      return (...input: Parameters<typeof transform>) => {
        rawRuns.count += 1
        return transform(...input)
      }
    }
  }
})

const PLAIN_MARKDOWN = [
  '## Heading\n\nSome **bold**, _emphasis_, `code` and ~~strike~~.',
  '- one\n- two\n  - nested\n\n1. first\n2. second',
  '- [x] done\n- [ ] todo',
  '| a | b |\n| :- | -: |\n| 1 | 2 |\n| 3 | 4 |',
  '> quoted\n> line two\n\nline\nbreak',
  '```ts\nconst x = 1 < 2 && 3 > 2\n```',
  'Autolink https://example.com and [link](https://example.com "title") and ![img](https://example.com/a.png)',
  'Escaped \\<b\\> text, a < b, and an &amp; entity'
]

beforeEach(() => {
  rawRuns.count = 0
})

describe('CommentMarkdown raw HTML parsing', () => {
  it('skips the raw HTML pass for markdown without HTML', () => {
    for (const content of PLAIN_MARKDOWN) {
      renderToStaticMarkup(<CommentMarkdown content={content} />)
    }
    expect(rawRuns.count).toBe(0)
  })

  it('renders plain markdown exactly as the raw HTML pass would', () => {
    for (const content of PLAIN_MARKDOWN) {
      const withRaw = renderToStaticMarkup(
        <Markdown remarkPlugins={[remarkGfm, remarkBreaks]} rehypePlugins={[rehypeRaw]}>
          {content}
        </Markdown>
      )
      const withoutRaw = renderToStaticMarkup(
        <Markdown remarkPlugins={[remarkGfm, remarkBreaks]}>{content}</Markdown>
      )
      // parse5 foster-parents a table's inter-row newlines in front of it; they collapse as
      // whitespace, so they are the one expected difference.
      expect(withoutRaw, content).toBe(withRaw.replace(/\n+(?=<table>)/g, ''))
    }
  })

  it('still parses and renders safe raw HTML', () => {
    const markup = renderToStaticMarkup(
      <CommentMarkdown content="Version <sub>2</sub> with <kbd>Ctrl</kbd>" />
    )
    expect(rawRuns.count).toBe(1)
    expect(markup).toContain('<sub>2</sub>')
    expect(markup).toContain('<kbd>Ctrl</kbd>')
  })

  it.each([
    ['inline script', 'Hi <script>alert(1)</script> there', ['<script', 'alert(1)']],
    ['block script', '<script>\nalert(1)\n</script>\n\ntext', ['<script', 'alert(1)']],
    ['image onerror', 'x <img src="x" onerror="alert(1)"> y', ['onerror', 'alert(1)']],
    ['javascript link', '<a href="javascript:alert(1)">go</a>', ['javascript:']],
    ['iframe', '<iframe src="https://evil.example"></iframe>', ['<iframe']],
    ['inline style handler', '<div onclick="steal()" style="x">t</div>', ['onclick', 'style=']]
  ])('sanitizes %s in raw HTML', (_name, content, forbidden) => {
    const markup = renderToStaticMarkup(<CommentMarkdown content={content} />)
    expect(rawRuns.count).toBe(1)
    for (const fragment of forbidden) {
      expect(markup).not.toContain(fragment)
    }
  })
})
