import type { Element, Root, RootContent } from 'hast'

export type InlineMarkdownColorSegment =
  | { kind: 'text'; value: string }
  | { kind: 'color'; value: string; color: string }

const HEX_COLOR_BODY_SOURCE = String.raw`(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})`
const PROSE_HEX_COLOR_BODY_SOURCE = String.raw`(?:[0-9a-f]{8}|[0-9a-f]{6})`
const INLINE_HEX_COLOR_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\p{N}_#])#${PROSE_HEX_COLOR_BODY_SOURCE}(?![\p{L}\p{N}_])`,
  'giu'
)
const EXACT_HEX_COLOR_PATTERN = new RegExp(String.raw`^#(${HEX_COLOR_BODY_SOURCE})$`, 'iu')
const SKIPPED_MARKDOWN_TAGS = new Set(['a', 'code', 'pre'])

/** Convert a complete CSS hex token to an uppercase six/eight-digit colour. */
export function normalizeInlineMarkdownColor(value: string): string | undefined {
  const match = value.match(EXACT_HEX_COLOR_PATTERN)
  if (!match) return undefined
  const raw = match[1]
  const expanded =
    raw.length <= 4
      ? raw
          .split('')
          .map((part) => `${part}${part}`)
          .join('')
      : raw
  return `#${expanded.toUpperCase()}`
}

/** Find bounded six/eight-digit prose colours while preserving every source glyph. */
export function tokeniseInlineMarkdownColors(value: string): InlineMarkdownColorSegment[] {
  if (!value || !value.includes('#')) return [{ kind: 'text', value }]

  const segments: InlineMarkdownColorSegment[] = []
  let cursor = 0
  for (const match of value.matchAll(INLINE_HEX_COLOR_PATTERN)) {
    const start = match.index
    if (start === undefined) continue
    const color = normalizeInlineMarkdownColor(match[0])
    if (!color) continue

    if (start > cursor) segments.push({ kind: 'text', value: value.slice(cursor, start) })
    segments.push({ kind: 'color', value: match[0], color })
    cursor = start + match[0].length
  }

  if (cursor < value.length) segments.push({ kind: 'text', value: value.slice(cursor) })
  return segments.length > 0 ? segments : [{ kind: 'text', value }]
}

function colorTokenElement(value: string, color: string): Element {
  return {
    type: 'element',
    tagName: 'span',
    properties: { dataColorToken: color },
    children: [{ type: 'text', value }]
  }
}

function isAtomicMarkdownElement(element: Element): boolean {
  return (
    SKIPPED_MARKDOWN_TAGS.has(element.tagName) ||
    typeof element.properties.dataColorToken === 'string' ||
    typeof element.properties.dataCommitReference === 'string'
  )
}

function annotateColors(parent: Root | Element): void {
  const nextChildren: RootContent[] = []
  for (const child of parent.children as RootContent[]) {
    if (child.type === 'text') {
      const segments = tokeniseInlineMarkdownColors(child.value)
      if (segments.length === 1 && segments[0].kind === 'text') {
        nextChildren.push(child)
        continue
      }
      for (const segment of segments) {
        nextChildren.push(
          segment.kind === 'text'
            ? { type: 'text', value: segment.value }
            : colorTokenElement(segment.value, segment.color)
        )
      }
      continue
    }

    if (child.type === 'element' && !isAtomicMarkdownElement(child)) {
      annotateColors(child)
    }
    nextChildren.push(child)
  }
  parent.children = nextChildren as typeof parent.children
}

/** Annotate validated CSS hex colours after Markdown has become safe HAST. */
export function rehypeInlineMarkdownColorTokens(): (tree: Root) => void {
  return (tree) => annotateColors(tree)
}
