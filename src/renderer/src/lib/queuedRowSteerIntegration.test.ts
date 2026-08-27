import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('queued-row Steer integration', () => {
  const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')

  it('uses the same live injection seam instead of polling for the whole turn', () => {
    const handler = source.indexOf('const handleSteerToQueuedMessage')
    const end = source.indexOf('const handleReorderQueuedMessages', handler)
    const body = source.slice(handler, end)

    expect(body).toContain('queueMessageId: midRunQueuedMessageId(runId)')
    expect(body).toContain('await attemptLiveSteering(window.api')
    expect(body).toContain("liveOutcome.kind === 'accepted'")
    expect(body).toContain("liveOutcome.kind === 'boundary'")
    expect(body).toContain('reserveQueuedRunAtFront(prev, dispatchRequest, queuedRunFallbackId)')
    expect(body).toContain('setFailedQueuedSteerRunIds((previous) => {')
    expect(body).not.toContain('while (isChatBusy')
    expect(body).not.toContain('DEFAULT_STEER_POLL_INTERVAL_MS')
  })

  it('persists the transcript immediately and reveals failed durable handoffs', () => {
    const handler = source.indexOf('const handleSteerToQueuedMessage')
    const end = source.indexOf('const handleReorderQueuedMessages', handler)
    const body = source.slice(handler, end)

    expect(body).toContain('{ persistImmediately: true }')
    expect(body).toContain('next.add(runId)')
    expect(body).toContain('includeTerminal: true')
    expect(body).toContain('no duplicate draft was created')
  })

  it('puts a brand-new composer Steer fallback ahead of older queued jobs', () => {
    const handler = source.indexOf('const handleSteer = async')
    const end = source.indexOf('const handleSteerRef', handler)
    const body = source.slice(handler, end)

    expect(body).toContain(
      'reserveQueuedRunAtFront(prev, reservedSteerRequest, queuedRunFallbackId)'
    )
  })
})
