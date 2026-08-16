import type { Element, Root, RootContent } from 'hast'

export type InlineMarkdownCommitReferenceSegment =
  | { kind: 'text'; value: string }
  | { kind: 'candidate'; value: string }

const COMMIT_HASH_SOURCE = String.raw`(?<![0-9A-Fa-f])([0-9A-Fa-f]{7,40})(?![0-9A-Fa-f])`
const COMMIT_HASH_PATTERN = new RegExp(COMMIT_HASH_SOURCE, 'giu')
const EXACT_COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/iu
const SKIPPED_MARKDOWN_TAGS = new Set(['a', 'code', 'pre'])

export function isInlineMarkdownCommitHash(value: string): boolean {
  return EXACT_COMMIT_HASH_PATTERN.test(value)
}

export function tokeniseInlineMarkdownCommitReferences(
  value: string
): InlineMarkdownCommitReferenceSegment[] {
  if (!value) return [{ kind: 'text', value }]
  const segments: InlineMarkdownCommitReferenceSegment[] = []
  let cursor = 0
  for (const match of value.matchAll(COMMIT_HASH_PATTERN)) {
    const start = match.index
    if (start === undefined) continue
    // Seven/eight-letter all-hex English words (for example "defaced") are
    // common enough that treating them as Git candidates would wake the
    // catalogue for ordinary prose. Nine chars matches TaskWraith's displayed
    // hashes; shorter prose still qualifies when it contains a digit. Exact
    // inline-code hashes retain the full 7–40 character range.
    if (match[0].length < 9 && !/\d/u.test(match[0])) continue
    if (start > cursor) segments.push({ kind: 'text', value: value.slice(cursor, start) })
    segments.push({ kind: 'candidate', value: match[0] })
    cursor = start + match[0].length
  }
  if (cursor < value.length) segments.push({ kind: 'text', value: value.slice(cursor) })
  return segments.length > 0 ? segments : [{ kind: 'text', value }]
}

function commitReferenceElement(value: string): Element {
  return {
    type: 'element',
    tagName: 'span',
    properties: { dataCommitReference: value },
    children: [{ type: 'text', value }]
  }
}

function annotateCommitReferences(parent: Root | Element): void {
  const nextChildren: RootContent[] = []
  for (const child of parent.children as RootContent[]) {
    if (child.type === 'text') {
      const segments = tokeniseInlineMarkdownCommitReferences(child.value)
      if (segments.length === 1 && segments[0].kind === 'text') {
        nextChildren.push(child)
        continue
      }
      for (const segment of segments) {
        nextChildren.push(
          segment.kind === 'text'
            ? { type: 'text', value: segment.value }
            : commitReferenceElement(segment.value)
        )
      }
      continue
    }

    if (child.type === 'element' && !SKIPPED_MARKDOWN_TAGS.has(child.tagName)) {
      annotateCommitReferences(child)
    }
    nextChildren.push(child)
  }
  parent.children = nextChildren as typeof parent.children
}

/** Mark hash-shaped prose after Markdown parsing; traceability is resolved later. */
export function rehypeInlineMarkdownCommitReferences(): (tree: Root) => void {
  return (tree) => annotateCommitReferences(tree)
}
