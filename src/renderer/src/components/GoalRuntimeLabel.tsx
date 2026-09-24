import { memo, useMemo } from 'react'

import { useSharedNowTick } from '../hooks/useSharedNowTick'
import { formatGoalRuntimePopoverLabel } from '../lib/goalRuntimeFormat'

/**
 * Isolated goal runtime line inside the goal popover.
 *
 * The shared 1 Hz tick must live in this leaf. Subscribing from ComposerInner
 * reconciled the whole composer every second (see `ScheduledTaskCountdown` and
 * `ApprovalTimeoutCountdown` for the same extraction).
 *
 * THE ROOT ELEMENT MUST STAY THE BARE `<p>`, AND THIS MUST RETURN `null`
 * RATHER THAN AN EMPTY WRAPPER. `08-theme-picker-overrides.css` applies
 * `.composer-goal-popover > *` — a DIRECT-CHILD selector — to lift the
 * popover's children above its `::before`/`::after` glass layers. Wrapping the
 * `<p>` in anything drops it a level, it loses that z-lift, and it renders
 * UNDER the sheen. No test in this repo renders the real Composer, so that
 * regression is silent in CI and visible only in the running app.
 *
 * Mounting is already conditional on `goalPopoverOpen` (the popover is a
 * portal), so this leaf only has to gate on the ledger/status half of the old
 * `hasGoalRuntimeTicker` condition.
 */
export const GoalRuntimeLabel = memo(function GoalRuntimeLabel({
  goal,
  lastActivityAt
}: {
  /** Matches `formatGoalRuntimePopoverLabel`'s own parameter type. */
  goal: any
  lastActivityAt?: number | string
}) {
  const ticking = Boolean(goal?.runtimeLedger) && goal?.status !== 'completed'
  const tick = useSharedNowTick(ticking)
  const label = useMemo(
    () => formatGoalRuntimePopoverLabel(goal, Date.now(), lastActivityAt),
    [tick, goal, lastActivityAt]
  )

  if (!label) return null
  return <p className="composer-goal-runtime">{label}</p>
})
