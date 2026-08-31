import { describe, expect, it } from 'vitest'
import { isRedundantEnsembleTranscriptNotice } from './ensembleTranscriptNoise'

function notice(content: string) {
  return { role: 'system', content, metadata: { kind: 'ensembleRoundStatus' } }
}

describe('redundant Ensemble transcript notices', () => {
  it.each([
    'Routed next: Claude.',
    '@-mention: Codex / Boss is Boss and takes routing priority over advisory participant mentions.',
    '@-mention: Worker, Reviewer promoted to speak next.',
    'User Fan-Out complete · 2 lane(s) returned.',
    'Automatic read stage complete · returning to serial writer step.',
    'Locked writer fan-out: Orchestrator requested 2 lane(s). Boss dispatch: two disjoint write slices for transcript-hide task after scout recon converged',
    'Full fan-out: Advisor requested 2 reader lane(s) under their own permission postures.',
    'Locked writer fan-out requested but TASKWRAITH_CONCURRENT_WRITE_LANES=0; continuing with serial writers.',
    'Locked writer fan-out needs at least two writer-capable participants with no intervening serial participants after the read-only fan-out step; continuing serially.',
    'Locked writer fan-out requires the assigned Boss to call ensemble_fanout with explicit writeScopes; continuing with serial writers.',
    'Locked writer fan-out requires an assigned Boss for this policy; continuing with serial writers.',
    "Boss selection arrived after this pass's seats dispatched — queued to apply once when the next Continuous pass forms.",
    "Captain selection arrived after this pass's seats dispatched — queued to apply once when the next Continuous pass forms.",
    'Yield target "Orchestrator" was not routed: fanout_lane_ignored.',
    'Yield target "Missing" was not routed: invalid_target. Try a unique alias: Kimi, Pi.'
  ])('hides the routine success receipt %s', (content) => {
    expect(isRedundantEnsembleTranscriptNotice(notice(content))).toBe(true)
  })

  it('preserves exceptional and untrusted look-alike rows', () => {
    expect(
      isRedundantEnsembleTranscriptNotice(
        notice('User Fan-Out complete · 1 lane(s) returned, 1 failed (Reviewer — timeout).')
      )
    ).toBe(false)
    expect(
      isRedundantEnsembleTranscriptNotice(
        notice('Review wave complete · returning to serial writer step.')
      )
    ).toBe(false)
    expect(
      isRedundantEnsembleTranscriptNotice(
        notice('Scout fan-out complete · returning to serial writer step.')
      )
    ).toBe(false)
    expect(
      isRedundantEnsembleTranscriptNotice(
        notice('scout_brief: `confidence` must be one of...')
      )
    ).toBe(false)
    expect(
      isRedundantEnsembleTranscriptNotice(
        notice('Automatic read stage complete · 2 lane(s) returned.')
      )
    ).toBe(false)
    expect(
      isRedundantEnsembleTranscriptNotice(
        notice('Security fan-out: Orchestrator requested 2 lane(s).')
      )
    ).toBe(false)
    expect(
      isRedundantEnsembleTranscriptNotice({
        role: 'assistant',
        content: 'Routed next: Claude.',
        metadata: { kind: 'ensembleRoundStatus' }
      })
    ).toBe(false)
    expect(
      isRedundantEnsembleTranscriptNotice({ role: 'system', content: 'Routed next: Claude.' })
    ).toBe(false)
  })
})
