import { describe, expect, it } from 'vitest'
import { actualMainDurabilityPerf } from './ActualMainDurabilityPerf'
import { createMainDurabilityRuntime } from '../store/MainDurabilityRuntime'

describe('actual main durability performance evidence', () => {
  it('reads the installed runtime snapshot without deriving worker counters from legacy mode', async () => {
    const runtime = createMainDurabilityRuntime({
      runEventsDir: '/unused-events',
      runArtifactsDir: '/unused-artifacts',
      env: {}
    })
    const evidence = actualMainDurabilityPerf(runtime, {})
    expect(evidence.sharedPool).toEqual(runtime.snapshot())
    expect(evidence.sharedPool?.mode).toBe('legacy')
    expect(evidence.sharedPool?.counters).toBeNull()
    expect(evidence.flags.TASKWRAITH_RUN_EVENT_FLUSHER).toEqual({ token: null, enabled: false })
    await runtime.shutdown()
  })
  it('reports absent instrumentation as null and reads exact child flag tokens', () => {
    const result = actualMainDurabilityPerf(null, {
      TASKWRAITH_RUN_EVENT_FLUSHER: 'true',
      TASKWRAITH_JOURNAL_FLUSHER: '1'
    })
    expect(result.flags).toEqual({
      TASKWRAITH_RUN_EVENT_FLUSHER: { token: 'true', enabled: false },
      TASKWRAITH_JOURNAL_FLUSHER: { token: '1', enabled: true }
    })
    expect(result.sharedPool).toBeNull()
    expect(result.mainFsyncsByOwner).toBeNull()
    expect(result.unmeasured).toContain('complete_x3_fallback_counters')
  })
})
