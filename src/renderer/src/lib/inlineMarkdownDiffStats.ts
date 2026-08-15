import type { Element, Root, RootContent } from 'hast'

export type InlineMarkdownDiffStatKind = 'text' | 'addition' | 'deletion'

export interface InlineMarkdownDiffStatSegment {
  kind: InlineMarkdownDiffStatKind
  value: string
}

const COUNT_SOURCE = String.raw`(?:[1-9]\d{0,2}(?:,\d{3})+|0|[1-9]\d*)`
const NON_DIFF_SUFFIX_SOURCE = String.raw`(?:[%°$£€¥]|(?:USD|EUR|GBP|JPY|CNY|CAD|AUD)(?![\p{L}\p{N}_]))`
const INLINE_DIFF_STAT_PATTERN = new RegExp(
  String.raw`(?:(?<![\p{L}\p{N}_.+$£€¥%°])(?<signedAddition>\+${COUNT_SOURCE})(?<signedSeparator>(?:[ \t]*\/[ \t]*|[ \t]+))(?<signedDeletion>[−-]${COUNT_SOURCE})(?![\p{L}\p{N}_%°$£€¥]|[.,]\d|[ \t]+${NON_DIFF_SUFFIX_SOURCE})|(?<![\p{L}\p{N}_.,$£€¥%°])(?<wordedCount>${COUNT_SOURCE})(?<wordedSpace>[ \t]+)(?<wordedLabel>insertions?|additions?|deletions?|removals?)(?![\p{L}\p{N}_]))`,
  'giu'
)

function textSegment(value: string): InlineMarkdownDiffStatSegment {
  return { kind: 'text', value }
}

/**
 * Recognise only integer diff-count idioms whose signs or labels preserve the
 * meaning without colour. The original glyphs and spacing are returned intact
 * so copying or screen-reading the rendered Markdown yields the source text.
 */
export function tokeniseInlineMarkdownDiffStats(value: string): InlineMarkdownDiffStatSegment[] {
  if (!value) return [textSegment(value)]

  const segments: InlineMarkdownDiffStatSegment[] = []
  let cursor = 0
  for (const match of value.matchAll(INLINE_DIFF_STAT_PATTERN)) {
    const start = match.index
    const groups = match.groups
    if (start === undefined || !groups) continue

    if (start > cursor) segments.push(textSegment(value.slice(cursor, start)))

    if (groups.signedAddition && groups.signedSeparator && groups.signedDeletion) {
      segments.push({ kind: 'addition', value: groups.signedAddition })
      segments.push(textSegment(groups.signedSeparator))
      segments.push({ kind: 'deletion', value: groups.signedDeletion })
      cursor = start + match[0].length
      continue
    }

    if (groups.wordedCount && groups.wordedSpace && groups.wordedLabel) {
      const kind = /^(?:insertions?|additions?)$/i.test(groups.wordedLabel)
        ? 'addition'
        : 'deletion'
      segments.push({ kind, value: groups.wordedCount })
      cursor = start + groups.wordedCount.length
    }
  }

  if (cursor < value.length) segments.push(textSegment(value.slice(cursor)))
  return segments.length > 0 ? segments : [textSegment(value)]
}

const SKIPPED_MARKDOWN_TAGS = new Set(['a', 'code', 'pre'])

function diffStatElement(
  kind: Exclude<InlineMarkdownDiffStatKind, 'text'>,
  value: string
): Element {
  return {
    type: 'element',
    tagName: 'span',
    properties: {
      className: ['markdown-inline-diff-stat', `is-${kind}`]
    },
    children: [{ type: 'text', value }]
  }
}

function annotateDiffStats(parent: Root | Element): void {
  const nextChildren: RootContent[] = []
  for (const child of parent.children as RootContent[]) {
    if (child.type === 'text') {
      const segments = tokeniseInlineMarkdownDiffStats(child.value)
      if (segments.length === 1 && segments[0].kind === 'text') {
        nextChildren.push(child)
        continue
      }
      for (const segment of segments) {
        nextChildren.push(
          segment.kind === 'text'
            ? { type: 'text', value: segment.value }
            : diffStatElement(segment.kind, segment.value)
        )
      }
      continue
    }

    if (child.type === 'element' && !SKIPPED_MARKDOWN_TAGS.has(child.tagName)) {
      annotateDiffStats(child)
    }
    nextChildren.push(child)
  }
  parent.children = nextChildren as typeof parent.children
}

/** Annotate semantic inline diff counts after Markdown has become safe HAST. */
export function rehypeInlineMarkdownDiffStats(): (tree: Root) => void {
  return (tree) => annotateDiffStats(tree)
}
