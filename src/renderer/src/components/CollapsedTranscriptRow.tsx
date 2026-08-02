import { Fragment, useMemo, type ReactElement, type ReactNode } from 'react'
import type { ToolActivity } from '../../../main/store/types'
import {
  summarizeCollapsedActivityStack,
  type CollapsedStackLabelPart
} from '../lib/collapsedActivityStack'
import { ToolFamilyIcon, type ToolFamily } from './icons/ToolFamilyIcon'

/**
 * Settled-row collapse chrome shared by activity stacks and plain system
 * notices: a one-line summary with a chevron; clicking toggles back to the
 * untouched full rendering, which renders as `children` below the
 * (now-open) summary line so the collapse affordance stays visible.
 *
 * This lives outside TranscriptPanel so nested transcript surfaces, such as
 * fan-out lane viewports, use the exact same summary voice and controls.
 */
export function CollapsedTranscriptRow({
  header,
  metaLabel,
  label,
  labelParts,
  icons,
  errored,
  compact,
  expanded,
  onToggle,
  ariaTargetLabel,
  children
}: {
  header: ReactElement | null
  /** Optional muted inline prefix (e.g. "System") when no block header. */
  metaLabel?: string
  label: string
  /** Segmented form of `label` (activity summaries). When present, failed
   * segments paint their leading verb — "Ran" when a command exited
   * non-zero — in the user's diff-deletion red instead of tinting the whole
   * line; `label` stays the a11y/tooltip string. */
  labelParts?: readonly CollapsedStackLabelPart[]
  /** Optional leading icon strip (tool-family monoline SVGs). */
  icons?: ReactNode
  errored?: boolean
  /** Caption-sized summary line (system notices) instead of body text —
   * these rows are noise being tidied away, not messages. */
  compact?: boolean
  expanded: boolean
  onToggle: (expanded: boolean) => void
  ariaTargetLabel: string
  children?: ReactNode
}): ReactElement {
  return (
    <div
      className={`collapsed-activity-stack ${expanded ? 'is-expanded' : 'is-collapsed'}${
        errored ? ' has-errors' : ''
      }${compact ? ' is-compact' : ''}`}
    >
      {header}
      <button
        type="button"
        className="collapsed-activity-stack-summary"
        onClick={() => onToggle(!expanded)}
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${ariaTargetLabel}: ${label}`}
        title={expanded ? `Collapse ${ariaTargetLabel}` : `Expand ${ariaTargetLabel}`}
      >
        <span className="collapsed-activity-stack-chevron" aria-hidden="true">
          ▸
        </span>
        {icons}
        {metaLabel ? <span className="collapsed-activity-stack-meta">{metaLabel}</span> : null}
        <span className="collapsed-activity-stack-label">
          {labelParts
            ? labelParts.map((part, index) => {
                const prefix = index > 0 ? ' · ' : ''
                if (!part.failed) {
                  return <Fragment key={index}>{`${prefix}${part.text}`}</Fragment>
                }
                // Accent the leading verb ("Ran"); parts without one (the
                // error tally) accent whole.
                const accent = part.verb && part.text.startsWith(part.verb) ? part.verb : part.text
                return (
                  <Fragment key={index}>
                    {prefix}
                    <span className="collapsed-activity-stack-verb is-failed">{accent}</span>
                    {part.text.slice(accent.length)}
                  </Fragment>
                )
              })
            : label}
        </span>
      </button>
      {expanded ? children : null}
    </div>
  )
}

/** Map summary families onto the tool monoline icon set. */
const COLLAPSED_STACK_FAMILY_ICON: Record<string, ToolFamily> = {
  thinking: 'reasoning',
  read: 'file',
  write: 'edit',
  search: 'search',
  shell: 'shell',
  task: 'task'
}

export function CollapsedStackIconStrip({
  families
}: {
  families: readonly string[]
}): ReactElement | null {
  if (families.length === 0) return null
  return (
    <span className="collapsed-activity-stack-icons" aria-hidden>
      {families.map((family) => (
        <ToolFamilyIcon
          key={family}
          family={COLLAPSED_STACK_FAMILY_ICON[family] ?? 'task'}
          size={22}
          className="collapsed-activity-stack-icon"
        />
      ))}
    </span>
  )
}

/**
 * Settled-stack collapse row. Once the conversation has moved past an
 * activity stack, the whole run of thinking + tool viewports folds into a
 * one-line summary ("Thought for 12s · Searched ×8 · Read 5 files …").
 */
export function CollapsedActivityStackRow({
  header,
  activities,
  expanded,
  onToggle,
  children
}: {
  header: ReactElement | null
  activities: ToolActivity[]
  expanded: boolean
  onToggle: (expanded: boolean) => void
  children?: ReactNode
}): ReactElement {
  const summary = useMemo(() => summarizeCollapsedActivityStack(activities), [activities])
  return (
    <CollapsedTranscriptRow
      header={header}
      label={summary.label}
      labelParts={summary.parts}
      icons={<CollapsedStackIconStrip families={summary.families} />}
      errored={summary.errorCount > 0}
      expanded={expanded}
      onToggle={onToggle}
      ariaTargetLabel={`${summary.activityCount} activity ${
        summary.activityCount === 1 ? 'step' : 'steps'
      }`}
    >
      {children}
    </CollapsedTranscriptRow>
  )
}
