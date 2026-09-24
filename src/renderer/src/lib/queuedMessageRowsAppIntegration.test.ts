import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('queued message row App integration', () => {
  const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

  it('filters the combined durable and optimistic rows against the visible transcript', () => {
    const builder = source.indexOf('const buildQueuedMessagesAboveRowEntriesForChat')
    const appendLocal = source.indexOf('appendLocalQueuedRunEntries({', builder)
    const filter = source.indexOf('filterTranscriptBackedQueuedRunEntries(', appendLocal)
    const preserveFailed = source.indexOf('preserveRunIds: failedQueuedSteerRunIds', filter)

    expect(builder).toBeGreaterThan(0)
    expect(appendLocal).toBeGreaterThan(builder)
    expect(filter).toBeGreaterThan(appendLocal)
    expect(preserveFailed).toBeGreaterThan(filter)
  })

  it('keeps failed promoting handoffs in the row source instead of filtering them twice', () => {
    const builder = source.indexOf('const buildQueuedMessagesAboveRowEntriesForChat')
    const end = source.indexOf('const queuedMessagesAboveRowEntries', builder)
    const body = source.slice(builder, end)

    expect(body).toContain("job.status !== 'steer_promoting' ||")
    expect(body).toContain('failedQueuedSteerRunIds.has(job.runId || job.id)')
  })

  it('fails admission-pending startup barriers before the generic requeue fallback', () => {
    const rehydrate = source.indexOf('const rehydrateQueuedRuns = async')
    const end = source.indexOf('const buildRunRequest =', rehydrate)
    const body = source.slice(rehydrate, end)
    const admissionFence = body.indexOf(
      "job.steerDeliveryPhase !== undefined && job.steerDeliveryPhase !== 'prepared'"
    )
    const failedTransition = body.indexOf(
      ".transitionRunQueueJob(job.runId, 'failed'",
      admissionFence
    )
    const admissionBranchEnd = body.indexOf('continue', failedTransition)
    const genericFallback = body.indexOf('invokeFallbackPromotedSteerJob', admissionBranchEnd)

    expect(admissionFence).toBeGreaterThan(0)
    expect(failedTransition).toBeGreaterThan(admissionFence)
    expect(admissionBranchEnd).toBeGreaterThan(failedTransition)
    expect(genericFallback).toBeGreaterThan(admissionBranchEnd)
    expect(body.slice(admissionFence, admissionBranchEnd)).toContain(
      'did not replay this steering message'
    )
  })
})
