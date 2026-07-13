import { describe, expect, it } from 'vitest'
import {
  buildCodexThreadResumeRequest,
  buildCodexTurnStartRequest,
  resolveCodexOutboundReasoning,
  resolvePersistedCodexModelSelection
} from './CodexOutboundReasoning'

describe('resolvePersistedCodexModelSelection', () => {
  it('recovers the trimmed concrete model from a persisted custom chat', () => {
    expect(
      resolvePersistedCodexModelSelection({
        selectedModelType: 'custom',
        customModel: '  private-codex-model  ',
        lastRunActualModel: 'gpt-5.5'
      })
    ).toBe('private-codex-model')
  })

  it('falls back to the last concrete run when persisted custom text is blank', () => {
    expect(
      resolvePersistedCodexModelSelection({
        selectedModelType: 'custom',
        customModel: '   ',
        lastRunActualModel: '  gpt-5.6-terra  ',
        lastRunRequestedModel: 'gpt-5.5'
      })
    ).toBe('gpt-5.6-terra')
    expect(
      resolvePersistedCodexModelSelection({
        selectedModelType: 'custom',
        customModel: '',
        lastRunRequestedModel: '  gpt-5.4  '
      })
    ).toBe('gpt-5.4')
  })
})

describe('resolveCodexOutboundReasoning', () => {
  it('pins an unset GPT-5.5 run to medium on every outbound transport', () => {
    expect(resolveCodexOutboundReasoning('gpt-5.5', undefined)).toEqual({
      effort: 'medium',
      summary: 'auto',
      turnParams: { effort: 'medium', summary: 'auto' },
      threadConfig: {
        model_context_window: 1_050_000,
        model_auto_compact_token_limit: 850_000,
        model_reasoning_effort: 'medium'
      },
      execConfigArgs: ['-c', 'model_reasoning_effort="medium"']
    })
  })

  it('clamps an internal top tier before building app-server and exec forms', () => {
    expect(resolveCodexOutboundReasoning('gpt-5.6-sol', 'ultra')).toMatchObject({
      effort: 'xhigh',
      summary: 'auto',
      turnParams: { effort: 'xhigh', summary: 'auto' },
      threadConfig: { model_reasoning_effort: 'xhigh' },
      execConfigArgs: ['-c', 'model_reasoning_effort="xhigh"']
    })
  })

  it('uses a safe explicit default for unknown future models and tiers', () => {
    expect(resolveCodexOutboundReasoning('gpt-future', 'warp')).toEqual({
      effort: 'medium',
      summary: 'auto',
      turnParams: { effort: 'medium', summary: 'auto' },
      threadConfig: { model_reasoning_effort: 'medium' },
      execConfigArgs: ['-c', 'model_reasoning_effort="medium"']
    })
  })

  it('keeps an explicit reasoning-off request summary-free', () => {
    expect(resolveCodexOutboundReasoning('gpt-5.5', 'off')).toMatchObject({
      effort: 'none',
      summary: undefined,
      turnParams: { effort: 'none' },
      threadConfig: { model_reasoning_effort: 'none' },
      execConfigArgs: ['-c', 'model_reasoning_effort="none"']
    })
  })

  it('builds a cold-resume request with context and explicit reasoning config', () => {
    const reasoning = resolveCodexOutboundReasoning('gpt-5.5', undefined)
    expect(buildCodexThreadResumeRequest('thread-1', reasoning)).toEqual({
      threadId: 'thread-1',
      config: {
        model_context_window: 1_050_000,
        model_auto_compact_token_limit: 850_000,
        model_reasoning_effort: 'medium'
      },
      persistExtendedHistory: true
    })
  })

  it('adds the preserved normalized effort to continuation turn requests', () => {
    const reasoning = resolveCodexOutboundReasoning('gpt-5.6-sol', 'max')
    expect(
      buildCodexTurnStartRequest(
        { threadId: 'thread-1', model: 'gpt-5.6-sol', input: [] },
        reasoning
      )
    ).toEqual({
      threadId: 'thread-1',
      model: 'gpt-5.6-sol',
      input: [],
      effort: 'xhigh',
      summary: 'auto'
    })
  })
})
