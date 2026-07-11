import { describe, expect, it } from 'vitest'
import {
  isCodexAppServerThreadId,
  isSameCodexAppServerThreadId,
  shouldBlockCodexExecFallbackForSlimEnsemblePrompt
} from './CodexSessionIdentity'

describe('CodexSessionIdentity', () => {
  it('recognizes resumable UUIDs and compares urn/plain forms canonically', () => {
    const id = '7b057c8b-33fa-4eca-9efe-3313a83669f4'
    expect(isCodexAppServerThreadId(id)).toBe(true)
    expect(isSameCodexAppServerThreadId(`urn:uuid:${id}`, id)).toBe(true)
    expect(isSameCodexAppServerThreadId(id, 'codex-exec-123')).toBe(false)
  })

  it('blocks one-shot exec fallback only for an explicitly slim ensemble prompt', () => {
    expect(
      shouldBlockCodexExecFallbackForSlimEnsemblePrompt({
        ensembleRun: { promptMode: 'slim' }
      })
    ).toBe(true)
    expect(
      shouldBlockCodexExecFallbackForSlimEnsemblePrompt({
        ensembleRun: { promptMode: 'full' }
      })
    ).toBe(false)
    expect(shouldBlockCodexExecFallbackForSlimEnsemblePrompt({})).toBe(false)
  })
})
