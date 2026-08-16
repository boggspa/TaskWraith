const MIN_AUTO_PARAGRAPH_CHARS = 420
const TARGET_PARAGRAPH_CHARS = 420

interface SentenceSpan {
  text: string
  separatorStart: number
  separatorEnd: number
}

function hasAuthoredMarkdownStructure(content: string): boolean {
  return (
    /[\r\n]/.test(content) ||
    /```|~~~|`|\*\*|__|\[[^\]]*\]\(|<\/?[A-Za-z]/.test(content) ||
    /(^|\s)#{1,6}\s/.test(content)
  )
}

function sentenceSpans(content: string): SentenceSpan[] {
  const spans: SentenceSpan[] = []
  const boundary = /[.!?]["'”’)]?([ \t]+)(?=["'“‘(]?[A-Z0-9])/g
  let sentenceStart = 0
  let match: RegExpExecArray | null
  while ((match = boundary.exec(content))) {
    const separator = match[1] || ''
    const separatorEnd = boundary.lastIndex
    const separatorStart = separatorEnd - separator.length
    spans.push({
      text: content.slice(sentenceStart, separatorStart),
      separatorStart,
      separatorEnd
    })
    sentenceStart = separatorEnd
  }
  spans.push({
    text: content.slice(sentenceStart),
    separatorStart: content.length,
    separatorEnd: content.length
  })
  return spans
}

function startsUppercaseSection(sentence: string): boolean {
  const unquoted = sentence.trim().replace(/^["'“‘(]+/, '')
  const lead = unquoted.match(/^(.{3,100}?)(?::|,\s|\s+[—–]\s+|[.!?]["'”’)]?$)/)?.[1]
  if (!lead) return false
  const letters = lead.replace(/[^A-Za-z]+/g, '')
  return (
    letters.length >= 6 &&
    letters === letters.toUpperCase() &&
    (/\s/.test(lead) || /^P\d+(?:[-.][A-Z0-9]+)*/.test(lead))
  )
}

/**
 * Add display-only paragraph breaks to long, unstructured yield prose.
 *
 * The persisted message is never changed. Existing Markdown/newlines pass
 * through byte-for-byte; eligible plain prose only has sentence-separating
 * horizontal whitespace replaced with blank lines. Copy, export, prompting,
 * and participant delivery therefore continue to use the exact raw content.
 */
export function formatEnsembleYieldContentForDisplay(content: string): string {
  if (content.length < MIN_AUTO_PARAGRAPH_CHARS || hasAuthoredMarkdownStructure(content)) {
    return content
  }

  const spans = sentenceSpans(content)
  if (spans.length < 2) return content

  const breakAfter = new Set<number>()
  let paragraphChars = spans[0].text.length
  let paragraphSentences = 1

  for (let index = 1; index < spans.length; index += 1) {
    const previous = spans[index - 1]
    const next = spans[index]
    const previousText = previous.text.trim()
    const nextText = next.text.trim()
    const splitYieldPrefix =
      index === 1 && previousText.length <= 100 && /\byielded[.!?]["'”’)]?$/i.test(previousText)
    const splitSection = startsUppercaseSection(nextText)
    const splitForLength =
      paragraphChars >= 180 && paragraphChars + 1 + nextText.length > TARGET_PARAGRAPH_CHARS
    const splitDenseParagraph = paragraphSentences >= 3 && paragraphChars >= 260

    if (splitYieldPrefix || splitSection || splitForLength || splitDenseParagraph) {
      breakAfter.add(index - 1)
      paragraphChars = nextText.length
      paragraphSentences = 1
    } else {
      paragraphChars += previous.separatorEnd - previous.separatorStart + nextText.length
      paragraphSentences += 1
    }
  }

  if (breakAfter.size === 0) return content

  let cursor = 0
  let display = ''
  for (let index = 0; index < spans.length - 1; index += 1) {
    if (!breakAfter.has(index)) continue
    const span = spans[index]
    display += `${content.slice(cursor, span.separatorStart)}\n\n`
    cursor = span.separatorEnd
  }
  return display + content.slice(cursor)
}
