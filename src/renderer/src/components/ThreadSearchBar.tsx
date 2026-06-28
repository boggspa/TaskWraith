import { useEffect, useRef, type KeyboardEvent } from 'react'
import { XSymbolIcon } from './AppChromeSymbols'

function SearchGlyph(): React.JSX.Element {
  return (
    <span className="thread-search-glyph" aria-hidden>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7">
        <circle cx="7" cy="7" r="4.1" />
        <path d="m10.2 10.2 3 3" strokeLinecap="round" />
      </svg>
    </span>
  )
}

interface ThreadSearchBarProps {
  open: boolean
  query: string
  matchCount: number
  activeMatchNumber: number
  shortcutHint?: string
  focusRequestId?: number
  onQueryChange: (query: string) => void
  onNext: () => void
  onPrevious: () => void
  onClose: () => void
}

export function ThreadSearchBar({
  open,
  query,
  matchCount,
  activeMatchNumber,
  shortcutHint,
  focusRequestId,
  onQueryChange,
  onNext,
  onPrevious,
  onClose
}: ThreadSearchBarProps): React.JSX.Element | null {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const hasQuery = query.trim().length > 0
  const hasMatches = hasQuery && matchCount > 0
  const countLabel = hasQuery ? (hasMatches ? `${activeMatchNumber} / ${matchCount}` : 'No matches') : ''

  useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [focusRequestId, open])

  if (!open) return null

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (event.shiftKey) onPrevious()
      else onNext()
      return
    }
    if (event.key === 'ArrowDown' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      onNext()
      return
    }
    if (event.key === 'ArrowUp' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      onPrevious()
    }
  }

  return (
    <form
      className="thread-search-bar"
      role="search"
      aria-label="Search current chat"
      onSubmit={(event) => {
        event.preventDefault()
        onNext()
      }}
    >
      <SearchGlyph />
      <label className="sr-only" htmlFor="thread-search-input">
        Search current chat
      </label>
      <input
        id="thread-search-input"
        ref={inputRef}
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search current chat"
        spellCheck={false}
      />
      {!hasQuery && shortcutHint && <span className="thread-search-shortcut">{shortcutHint}</span>}
      {hasQuery && (
        <span className={`thread-search-count${hasMatches ? '' : ' is-empty'}`} aria-live="polite">
          {countLabel}
        </span>
      )}
      <div className="thread-search-actions">
        <button
          type="button"
          className="thread-search-icon-btn"
          onClick={onPrevious}
          disabled={!hasMatches}
          aria-label="Previous search result"
          title="Previous result"
        >
          <span aria-hidden>↑</span>
        </button>
        <button
          type="button"
          className="thread-search-icon-btn"
          onClick={onNext}
          disabled={!hasMatches}
          aria-label="Next search result"
          title="Next result"
        >
          <span aria-hidden>↓</span>
        </button>
        <button
          type="button"
          className="thread-search-icon-btn thread-search-close"
          onClick={onClose}
          aria-label="Close current chat search"
          title="Close search"
        >
          <XSymbolIcon />
        </button>
      </div>
    </form>
  )
}
