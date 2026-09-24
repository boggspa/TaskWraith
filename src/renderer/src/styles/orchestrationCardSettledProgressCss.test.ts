import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  join(process.cwd(), 'src/renderer/src/assets/css/07-composer-shells.css'),
  'utf8'
)

function statusesFor(pattern: RegExp): string[] {
  return Array.from(new Set(Array.from(css.matchAll(pattern), (match) => match[1]))).sort()
}

/** Statuses the shared orchestration chassis gives card-level chrome to. */
const cardStatuses = statusesFor(/\.claude-workflow-card\.status-([a-z0-9-]+)/g)
/** The same statuses, projected onto the progress bar's fill. */
const progressStatuses = statusesFor(/\.claude-workflow-card-progress\.status-([a-z0-9-]+)/g)

/**
 * Statuses whose progress bar is DELIBERATELY left on the base rule, because
 * that rule — an animated `var(--accent)` gradient — is exactly what work in
 * flight should look like. Everything else has stopped, and a stopped card
 * wearing the in-flight gradient tells the reader the graph is still moving.
 */
const IN_FLIGHT = new Set(['running'])

describe('orchestration card settled progress fill', () => {
  // `NativeOrchestrationCard` types `status` as a bare `string`, so nothing
  // compiles these two enumerations against each other and nothing compiles
  // either against the card's own statuses. This test is the only thing that
  // stops a settled status from inheriting the in-flight gradient — which is
  // how `status-attention` and `status-cancelled` shipped with an accent-blue
  // bar identical to a running card's, on cards whose whole purpose is to say
  // the work has stopped.
  it('gives every settled card status its own progress fill', () => {
    expect(cardStatuses.length).toBeGreaterThan(0)
    const settled = cardStatuses.filter((status) => !IN_FLIGHT.has(status))
    const inheritingTheRunningGradient = settled.filter(
      (status) => !progressStatuses.includes(status)
    )
    expect(inheritingTheRunningGradient).toEqual([])
  })

  // A graph that stopped for a person has not failed; it is waiting on a
  // decision, and colouring it as a failure tells the reader the work is lost.
  it('tones attention as a warning and never as a failure', () => {
    expect(css).toContain('.claude-workflow-card-progress.status-attention span {')
    const attentionBlock = css.slice(
      css.indexOf('.claude-workflow-card-progress.status-attention span {')
    )
    const rule = attentionBlock.slice(0, attentionBlock.indexOf('}'))
    expect(rule).toContain('var(--warning)')
    expect(rule).not.toContain('var(--danger)')
  })
})
