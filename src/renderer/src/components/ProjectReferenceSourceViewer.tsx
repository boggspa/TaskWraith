import { useMemo, useState, type JSX } from 'react'

import type { ProjectReferenceExtractPageSpan } from '../../../shared/projectReferenceExtract'

export interface ProjectReferenceSourceViewerProps {
  title: string
  text: string
  pages?: ReadonlyArray<ProjectReferenceExtractPageSpan>
  onClose: () => void
}

/**
 * Lightweight text viewer for consentful Project-reference extracts.
 * When a PDF page map is present, page chips jump to the matching offset.
 */
export function ProjectReferenceSourceViewer({
  title,
  text,
  pages,
  onClose
}: ProjectReferenceSourceViewerProps): JSX.Element {
  const [activePage, setActivePage] = useState<number | null>(pages?.[0]?.pageNumber ?? null)

  const visibleText = useMemo(() => {
    if (!pages || pages.length === 0 || activePage === null) return text
    const span = pages.find((page) => page.pageNumber === activePage)
    if (!span) return text
    return text.slice(span.startOffset, span.endOffset)
  }, [activePage, pages, text])

  return (
    <div
      className="project-reference-source-viewer"
      role="dialog"
      aria-label="Extract source viewer"
    >
      <header className="project-reference-source-viewer-header">
        <div>
          <span className="project-references-dock-eyebrow">Extract</span>
          <h4>{title}</h4>
        </div>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>
      {pages && pages.length > 0 ? (
        <div
          className="project-reference-source-viewer-pages"
          role="toolbar"
          aria-label="PDF pages"
        >
          {pages.map((page) => (
            <button
              key={`${page.pageNumber}:${page.startOffset}`}
              type="button"
              aria-pressed={activePage === page.pageNumber}
              onClick={() => setActivePage(page.pageNumber)}
            >
              Page {page.pageNumber}
            </button>
          ))}
        </div>
      ) : null}
      <pre className="project-reference-source-viewer-text">{visibleText}</pre>
    </div>
  )
}
