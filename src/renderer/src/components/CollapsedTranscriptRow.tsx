import { Fragment, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import type { ToolActivity } from '../../../main/store/types'
import {
  collapsedStackDiffAriaLabel,
  summarizeCollapsedActivityStack,
  type CollapsedStackDiffTotals,
  type CollapsedStackLabelPart
} from '../lib/collapsedActivityStack'
import { renderCollapsedStackLabelPart } from '../lib/activitySummaryLabel'
import { providerAccentVar } from '../lib/ollamaDisplayBrand'
import { ToolFamilyIcon, type ToolFamily } from './icons/ToolFamilyIcon'
import { ToolActivityDetailHydrationBoundary } from '../lib/toolActivityDetailHydration'

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
  labelContent,
  labelParts,
  icons,
  diffStats,
  errored,
  compact,
  providerHueClass,
  expanded,
  onToggle,
  ariaTargetLabel,
  children
}: {
  header: ReactElement | null
  /** Optional muted inline prefix (e.g. "System") when no block header. */
  metaLabel?: string
  label: string
  /** Optional rich visual label. `label` remains the accessible/tooltip text. */
  labelContent?: ReactNode
  /** Segmented form of `label` (activity summaries). When present, failed
   * segments paint their leading verb — "Ran" when a command exited
   * non-zero — in the user's diff-deletion red instead of tinting the whole
   * line; `label` stays the a11y/tooltip string. */
  labelParts?: readonly CollapsedStackLabelPart[]
  /** Optional leading icon strip (tool-family monoline SVGs). */
  icons?: ReactNode
  /** Summed `+N −M` for the file writes this row folded away, painted at the
   * end of the line in the user's Settings → Appearance diff accents. Opt-in:
   * the main transcript passes it, fan-out lane summaries do not. */
  diffStats?: CollapsedStackDiffTotals | null
  errored?: boolean
  /** Caption-sized summary line (system notices) instead of body text —
   * these rows are noise being tidied away, not messages. */
  compact?: boolean
  /** Resolved provider/model branding hue for this collapsed row and body. */
  providerHueClass?: string
  expanded: boolean
  onToggle: (expanded: boolean) => void
  ariaTargetLabel: string
  children?: ReactNode
}): ReactElement {
  const accent = providerAccentVar(providerHueClass)
  return (
    <div
      className={`collapsed-activity-stack ${expanded ? 'is-expanded' : 'is-collapsed'}${
        errored ? ' has-errors' : ''
      }${compact ? ' is-compact' : ''}`}
      style={accent ? ({ '--accent': accent } as CSSProperties) : undefined}
    >
      {header}
      <button
        type="button"
        className="collapsed-activity-stack-summary"
        onClick={() => onToggle(!expanded)}
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${ariaTargetLabel}: ${label}${
          // The whole row is one button, so an aria-label on the counters
          // themselves would never be announced — append instead.
          diffStats ? ` — ${collapsedStackDiffAriaLabel(diffStats)}` : ''
        }`}
        title={expanded ? `Collapse ${ariaTargetLabel}` : `Expand ${ariaTargetLabel}`}
      >
        <span className="collapsed-activity-stack-chevron" aria-hidden="true">
          ▸
        </span>
        {icons}
        {metaLabel ? <span className="collapsed-activity-stack-meta">{metaLabel}</span> : null}
        <span className="collapsed-activity-stack-label">
          {labelContent ??
            (labelParts
              ? labelParts.map((part, index) => {
                  const prefix = index > 0 ? ' · ' : ''
                  return (
                    <Fragment key={index}>
                      {prefix}
                      {renderCollapsedStackLabelPart(part)}
                    </Fragment>
                  )
                })
              : label)}
        </span>
        <CollapsedDiffStats totals={diffStats} />
      </button>
      {expanded ? children : null}
    </div>
  )
}

/**
 * Summed `+N −M` for the writes a one-liner folded away, in the user's
 * Settings → Appearance diff accents. Sits immediately after the summary
 * text so the numbers read as part of the line rather than as a far-right
 * stat column. Shared with the in-stack compact group so both one-liners
 * paint the same thing the same way.
 */
export function CollapsedDiffStats({
  totals
}: {
  totals?: CollapsedStackDiffTotals | null
}): ReactElement | null {
  if (!totals) return null
  return (
    <span className="collapsed-activity-stack-diff" aria-hidden>
      <span className="collapsed-activity-stack-diff-stat is-add">+{totals.additions}</span>
      <span className="collapsed-activity-stack-diff-stat is-del">-{totals.deletions}</span>
      {totals.estimated ? <span className="collapsed-activity-stack-diff-estimated">~</span> : null}
    </span>
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
          size={25}
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
  showDiffStats,
  providerHueClass,
  expanded,
  onToggle,
  children
}: {
  header: ReactElement | null
  activities: ToolActivity[]
  /** Paint the summed `+N −M` of the folded file writes at the end of the
   * line. Main-transcript stacks opt in; fan-out lane and sub-agent viewport
   * summaries stay bare — their rows already carry their own diff chrome. */
  showDiffStats?: boolean
  /** Resolved provider/model branding hue for the summary and expanded stack. */
  providerHueClass?: string
  expanded: boolean
  onToggle: (expanded: boolean) => void
  children?: ReactNode
}): ReactElement {
  return (
    <ToolActivityDetailHydrationBoundary activities={activities}>
      {(hydratedActivities) => {
        const summary = summarizeCollapsedActivityStack(hydratedActivities)
        // Callers normally gate this component through
        // shouldAutoCollapseActivityStack, but keep the rendered control
        // defensive too: an all-infrastructure stack has nothing visible to
        // expand and must never announce itself as "0 activity steps".
        if (summary.activityCount === 0) return null
        return (
          <CollapsedTranscriptRow
            header={header}
            label={summary.label}
            labelParts={summary.parts}
            icons={<CollapsedStackIconStrip families={summary.families} />}
            diffStats={showDiffStats ? summary.diff : null}
            errored={summary.errorCount > 0}
            providerHueClass={providerHueClass}
            expanded={expanded}
            onToggle={onToggle}
            ariaTargetLabel={`${summary.activityCount} activity ${
              summary.activityCount === 1 ? 'step' : 'steps'
            }`}
          >
            {children}
          </CollapsedTranscriptRow>
        )
      }}
    </ToolActivityDetailHydrationBoundary>
  )
}
