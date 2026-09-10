import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Mirrors `approvalOverlayIsolation.test.ts` for the scheduled-task countdown
 * and the goal runtime line.
 *
 * Both used to read a `scheduledNowMs` derived from the shared 1 Hz tick
 * INSIDE ComposerInner, so the whole composer — textarea, pickers, overlay,
 * preview — reconciled once a second. Worse than the approval case it copies:
 * the gate was `hasVisibleScheduledCountdown`, true whenever ANY scheduled task
 * is pending or due, so a single queued task pinned the composer at 1 Hz
 * indefinitely whether or not the strip was on screen.
 *
 * Note the approvals guard's negative is scoped to one variable name
 * (`agentApprovalNowTick`), which is exactly why it stayed green while this
 * second clock sat in the same component. The assertions here are therefore
 * about the FILE having no clock at all, not about one identifier.
 */
function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf-8').replace(/\r\n/g, '\n')
}

const composer = source('src/renderer/src/components/Composer.tsx')
const scheduled = source('src/renderer/src/components/ScheduledTaskCountdown.tsx')
const goal = source('src/renderer/src/components/GoalRuntimeLabel.tsx')

describe('keeps the scheduled/goal countdown ticks out of ComposerInner', () => {
  it('Composer owns no clock of any kind', () => {
    expect(composer).not.toMatch(/useSharedNowTick\s*\(/)
    expect(composer).not.toContain('scheduledNowMs')
    expect(composer).not.toContain('formatScheduledTaskCountdown(')
    expect(composer).not.toContain('formatGoalRuntimePopoverLabel(')
    // Cheap, strong invariant: after this extraction the composer reads the
    // clock nowhere at all, so any new in-component ticker trips this.
    expect(composer).not.toContain('Date.now()')
  })

  it('Composer mounts the leaves instead', () => {
    expect(composer).toContain('<ScheduledTaskCountdown')
    expect(composer).toContain('<GoalRuntimeLabel')
  })

  it('the scheduled countdown leaf owns the tick and stays a bare span', () => {
    expect(scheduled).toMatch(/useSharedNowTick\s*\(/)
    expect(scheduled).toContain('formatScheduledTaskCountdown(')
    expect(scheduled).toContain('className="scheduled-task-countdown"')
    // `.scheduled-task-pill` is an inline-flex row with a 6px gap; a wrapper
    // would add a flex item and shift the icon/copy/status/cancel rhythm.
    expect(scheduled).toMatch(/return <span className="scheduled-task-countdown">/)
    // Only `pending` counts down — `running`/`due` are constant strings, so
    // they must not hold the shared interval open.
    expect(scheduled).toContain("useSharedNowTick(status === 'pending')")
  })

  it('the goal runtime leaf owns the tick and stays a bare <p> that can vanish', () => {
    expect(goal).toMatch(/useSharedNowTick\s*\(/)
    expect(goal).toContain('formatGoalRuntimePopoverLabel(')
    expect(goal).toContain('className="composer-goal-runtime"')
    /**
     * LOAD-BEARING. `08-theme-picker-overrides.css` uses the direct-child
     * selector `.composer-goal-popover > *` to lift the popover's children
     * above its ::before/::after glass layers. A wrapper element would drop the
     * <p> a level and it would render UNDER the sheen — and since no test in
     * this repo renders the real Composer, that regression is invisible in CI.
     */
    expect(goal).toContain('if (!label) return null')
    expect(goal).toMatch(/return <p className="composer-goal-runtime">/)
  })

  it('is anchored to files that exist and are non-trivial', () => {
    expect(composer.length).toBeGreaterThan(10_000)
    expect(scheduled.length).toBeGreaterThan(500)
    expect(goal.length).toBeGreaterThan(500)
  })
})
