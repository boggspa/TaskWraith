import type { ReactElement } from 'react'

/** Standing chalkboard glyph (easel legs + two chalk lines). Shared by the
 * composer control and transcript mutation row so Blackboard has one visual
 * identity everywhere it appears. */
export function BlackboardGlyph({
  className = 'blackboard-glyph'
}: {
  className?: string
}): ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="2.3" y="2.5" width="11.4" height="8" rx="1.4" />
      <path d="M4.9 5.4h6.2" />
      <path d="M4.9 7.7h4.1" />
      <path d="M4.2 10.5 3.3 13.3" />
      <path d="m11.8 10.5.9 2.8" />
    </svg>
  )
}
