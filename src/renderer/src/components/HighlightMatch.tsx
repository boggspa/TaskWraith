import type { ReactNode } from 'react'

export function HighlightMatch({ text, query }: { text: string; query: string }): ReactNode {
  if (!query) return text
  const lowerText = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const parts: ReactNode[] = []
  let cursor = 0
  let matchIndex = lowerText.indexOf(lowerQuery, cursor)

  while (matchIndex >= 0) {
    if (matchIndex > cursor) {
      parts.push(text.slice(cursor, matchIndex))
    }
    const matchEnd = matchIndex + lowerQuery.length
    parts.push(
      <mark key={`${matchIndex}-${matchEnd}`} className="sidebar-search-highlight">
        {text.slice(matchIndex, matchEnd)}
      </mark>
    )
    cursor = matchEnd
    matchIndex = lowerText.indexOf(lowerQuery, cursor)
  }

  if (cursor < text.length) {
    parts.push(text.slice(cursor))
  }

  return parts.length > 0 ? parts : text
}
