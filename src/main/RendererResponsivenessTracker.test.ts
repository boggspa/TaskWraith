import { describe, expect, it } from 'vitest'
import { RendererResponsivenessTracker } from './RendererResponsivenessTracker'

describe('RendererResponsivenessTracker', () => {
  it('opens one incident per unresponsive interval and pairs its recovery', () => {
    let now = 1_000
    let sequence = 0
    const tracker = new RendererResponsivenessTracker({
      now: () => now,
      createIncidentId: () => `incident-${++sequence}`
    })

    expect(tracker.begin(42)).toEqual({
      incidentId: 'incident-1',
      webContentsId: 42,
      startedAtMs: 1_000
    })
    expect(tracker.begin(42)).toBeNull()
    expect(tracker.activeCount()).toBe(1)

    now = 3_750
    expect(tracker.recover(42)).toEqual({
      incident: {
        incidentId: 'incident-1',
        webContentsId: 42,
        startedAtMs: 1_000
      },
      recoveredAtMs: 3_750,
      durationMs: 2_750
    })
    expect(tracker.recover(42)).toBeNull()
    expect(tracker.activeCount()).toBe(0)
  })

  it('tracks renderers independently and clears destroyed targets', () => {
    const tracker = new RendererResponsivenessTracker({
      now: () => 10,
      createIncidentId: () => 'incident'
    })

    tracker.begin(1)
    tracker.begin(2)
    tracker.clear(1)

    expect(tracker.recover(1)).toBeNull()
    expect(tracker.recover(2)?.durationMs).toBe(0)
    expect(tracker.begin(-1)).toBeNull()
  })
})
