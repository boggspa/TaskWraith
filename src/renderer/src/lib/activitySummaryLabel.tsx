import type { ReactNode } from 'react'
import { Fragment } from 'react'

/**
 * Leading / mid-phrase verbs on folded activity summaries (compact groups +
 * collapsed stacks). Highlighted in the youngest-child ActivityRow accent
 * voice so "Edited", "Read", "Thought", … scan like the file target does on
 * a single tool row.
 */
export const ACTIVITY_SUMMARY_VERB_PATTERN =
  /\b(Thought|Read|Edited|Ran|Searched|searched|Completed|Used|System|Created|Wrote|Deleted|Moved|Renamed)\b/g

/** Wrap known summary verbs in `.activity-summary-verb` spans. */
export function renderActivitySummaryLabel(label: string): ReactNode {
  const nodes: ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  const pattern = new RegExp(ACTIVITY_SUMMARY_VERB_PATTERN.source, 'g')
  while ((match = pattern.exec(label)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(label.slice(lastIndex, match.index))
    }
    nodes.push(
      <span key={`${match.index}-${match[1]}`} className="activity-summary-verb">
        {match[1]}
      </span>
    )
    lastIndex = match.index + match[1].length
  }
  if (lastIndex < label.length) nodes.push(label.slice(lastIndex))
  if (nodes.length === 0) return label
  return <Fragment>{nodes}</Fragment>
}

/** Structured collapsed-stack parts: always accent the verb; failed stays red. */
export function renderCollapsedStackLabelPart(part: {
  text: string
  verb: string
  failed?: boolean
}): ReactNode {
  if (part.failed) {
    const accent = part.verb && part.text.startsWith(part.verb) ? part.verb : part.text
    return (
      <>
        <span className="activity-summary-verb collapsed-activity-stack-verb is-failed">
          {accent}
        </span>
        {part.text.slice(accent.length)}
      </>
    )
  }
  if (part.verb && part.text.startsWith(part.verb)) {
    return (
      <>
        <span className="activity-summary-verb collapsed-activity-stack-verb">{part.verb}</span>
        {part.text.slice(part.verb.length)}
      </>
    )
  }
  return part.text
}
