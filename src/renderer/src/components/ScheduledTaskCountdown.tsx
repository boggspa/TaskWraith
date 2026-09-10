import { memo, useMemo } from 'react'

import type { ScheduledTask } from '../../../main/store/types'
import { useSharedNowTick } from '../hooks/useSharedNowTick'
import { formatScheduledTaskCountdown } from '../lib/scheduledCountdown'

/**
 * Isolated countdown for one scheduled-task pill.
 *
 * The shared 1 Hz tick must live in this leaf. Subscribing from ComposerInner
 * reconciled the whole composer (textarea, pickers, overlay, preview) every
 * second — and the gate there was `hasVisibleScheduledCountdown`, which is true
 * whenever ANY scheduled task is pending or due. So a single pending task
 * pinned the entire composer at a 1 Hz reconcile indefinitely, whether or not
 * the user was looking at the strip. Same pathology, and same fix, as
 * `ApprovalTimeoutCountdown`.
 *
 * Props are scalars, not the task object: the parent's `visibleScheduledTasks`
 * is a fresh `.slice()` on every App render, so passing the object would leave
 * `memo` inert.
 *
 * The root element IS the `<span>`. `.scheduled-task-pill` is an inline-flex
 * row with a 6px gap, so any wrapper here would add a flex item and shift the
 * rhythm of the icon / copy / status / cancel-button siblings.
 */
export const ScheduledTaskCountdown = memo(function ScheduledTaskCountdown({
  runAt,
  status
}: {
  runAt: ScheduledTask['runAt']
  status: ScheduledTask['status']
}) {
  // Only `pending` genuinely counts down — formatScheduledTaskCountdown
  // short-circuits `running` and `due` to constant strings, so those states
  // need no clock at all and must not hold the shared interval open.
  const tick = useSharedNowTick(status === 'pending')
  const label = useMemo(
    () => formatScheduledTaskCountdown({ runAt, status }, Date.now()),
    [tick, runAt, status]
  )

  return <span className="scheduled-task-countdown">{label}</span>
})
