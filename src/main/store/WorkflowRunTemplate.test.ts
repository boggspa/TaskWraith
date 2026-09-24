import { describe, expect, it } from 'vitest'
import { pickWorkflowRunTemplateFields } from './WorkflowRunTemplate'

/**
 * Regression guard for the antigravityReasoningEffort allowlist entry: the raw
 * AntiGravity reasoning tier (which carries UltraTask intent) must survive
 * template persistence instead of being silently stripped.
 */
describe('pickWorkflowRunTemplateFields', () => {
  it('keeps antigravityReasoningEffort alongside its sibling provider-effort fields', () => {
    const picked = pickWorkflowRunTemplateFields({
      provider: 'antigravity',
      prompt: 'do the thing',
      antigravityReasoningEffort: 'ultraTask',
      cursorFastMode: false,
      geminiAuthProfileId: null,
      runtimeProfileId: 'default'
    })

    expect(picked).toEqual({
      provider: 'antigravity',
      prompt: 'do the thing',
      antigravityReasoningEffort: 'ultraTask',
      cursorFastMode: false,
      geminiAuthProfileId: null,
      runtimeProfileId: 'default'
    })
  })

  it('still drops fields outside the allowlist', () => {
    const picked = pickWorkflowRunTemplateFields({
      provider: 'claude',
      notARealField: 'drop me'
    })

    expect(picked).not.toHaveProperty('notARealField')
    expect(picked.provider).toBe('claude')
  })
})
