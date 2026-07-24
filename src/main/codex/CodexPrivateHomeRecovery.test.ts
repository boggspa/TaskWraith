import { describe, expect, it } from 'vitest'
import {
  codexPrivateHomeColdStartPrompt,
  prepareCodexPrivateHomeLink
} from './CodexPrivateHomeRecovery'

const NATIVE_ID = '7b057c8b-33fa-4eca-9efe-3313a83669f4'

describe('Codex private-home recovery', () => {
  it('preserves a native app-server UUID for exact rollout migration/resume', () => {
    expect(
      prepareCodexPrivateHomeLink({
        providerSessionId: NATIVE_ID,
        prompt: 'slim prompt',
        resumeFallbackPrompt: 'full prompt'
      })
    ).toEqual({
      prompt: 'slim prompt',
      providerSessionId: NATIVE_ID,
      resumableThreadId: NATIVE_ID
    })
  })

  it('clears a non-native exec id and uses the full-context fallback', () => {
    expect(
      prepareCodexPrivateHomeLink({
        providerSessionId: 'codex-exec-1780439561126',
        prompt: 'current turn only',
        resumeFallbackPrompt: 'complete transcript'
      })
    ).toEqual({
      prompt: 'complete transcript',
      providerSessionId: undefined,
      resumableThreadId: null,
      discardedSessionId: 'codex-exec-1780439561126'
    })
  })

  it('accepts an Ensemble full prompt as its own cold-start recovery context', () => {
    expect(
      codexPrivateHomeColdStartPrompt({
        prompt: 'full participant briefing',
        ensemblePromptMode: 'full'
      })
    ).toBe('full participant briefing')
  })

  it('requires a signed fallback for a slim/native-resume cold start', () => {
    expect(
      codexPrivateHomeColdStartPrompt({
        prompt: 'current turn only',
        ensemblePromptMode: 'slim'
      })
    ).toBeNull()
    expect(
      codexPrivateHomeColdStartPrompt({
        prompt: 'current turn only',
        resumeFallbackPrompt: 'complete transcript',
        ensemblePromptMode: 'slim'
      })
    ).toBe('complete transcript')
  })
})
