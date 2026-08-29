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
    'User Fan-Out complete · 2 lane(s) returned.'
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
