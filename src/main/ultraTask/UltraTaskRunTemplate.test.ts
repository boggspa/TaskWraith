import { describe, expect, it } from 'vitest'
import { buildUltraTaskRunTemplateRequest } from './UltraTaskRunTemplate'

describe('buildUltraTaskRunTemplateRequest', () => {
  it('builds a concrete write-stage request without inheriting ephemeral parent authority', () => {
    expect(
      buildUltraTaskRunTemplateRequest({
        prompt: 'Implement the worker stage.',
        effect: 'workspace_write',
        seat: {
          provider: 'codex',
          model: 'gpt-5.6-sol',
          reasoningEffort: 'ultracode',
          runtimeProfileId: 'builtin:codex:local'
        },
        parentApprovalMode: 'auto_edit',
        parentPermissionPresetId: 'full_access',
        parentWorkflowMode: 'normal'
      })
    ).toEqual({
      scope: 'workspace',
      prompt: 'Implement the worker stage.',
      selectedModelType: 'gpt-5.6-sol',
      customModel: '',
      approvalMode: 'auto_edit',
      permissionPresetId: 'workspace_write',
      workflowMode: 'normal',
      sessionTrust: false,
      imageAttachments: [],
      externalPathGrants: [],
      runtimeProfileId: 'builtin:codex:local',
      codexReasoningEffort: 'ultracode'
    })
  })

  it('forces every auxiliary stage to a durable read-only Plan posture', () => {
    const request = buildUltraTaskRunTemplateRequest({
      prompt: 'Review the artifact.',
      effect: 'read_only',
      seat: { provider: 'claude', model: 'claude-sonnet-5', reasoningEffort: 'max' },
      parentApprovalMode: 'auto_edit',
      parentPermissionPresetId: 'workspace_write',
      parentWorkflowMode: 'normal'
    })
    expect(request).toMatchObject({
      approvalMode: 'plan',
      permissionPresetId: 'read_only',
      workflowMode: 'plan',
      sessionTrust: false,
      externalPathGrants: [],
      claudeReasoningEffort: 'max'
    })
  })

  it.each([
    ['codex', 'codexReasoningEffort'],
    ['claude', 'claudeReasoningEffort'],
    ['kimi', 'kimiReasoningEffort'],
    ['grok', 'grokReasoningEffort'],
    ['muse', 'museReasoningEffort'],
    ['mistral', 'mistralReasoningEffort'],
    ['pi', 'piReasoningEffort'],
    ['ollama', 'ollamaReasoningEffort'],
    ['cursor', 'cursorReasoningEffort'],
    ['antigravity', 'antigravityReasoningEffort']
  ] as const)('maps %s reasoning into its exact queue field', (provider, field) => {
    const request = buildUltraTaskRunTemplateRequest({
      prompt: 'Run the stage.',
      effect: 'read_only',
      seat: { provider, model: `${provider}-concrete-model`, reasoningEffort: 'high' },
      parentApprovalMode: 'default',
      parentPermissionPresetId: 'default'
    })
    expect(request[field]).toBe('high')
    if (provider === 'kimi') expect(request.kimiThinkingEnabled).toBe(true)
  })

  it('keeps fixed Kimi thinking enabled when no effort axis is supplied', () => {
    expect(
      buildUltraTaskRunTemplateRequest({
        prompt: 'Run Kimi.',
        effect: 'read_only',
        seat: { provider: 'kimi', model: 'kimi-k2.7-code' },
        parentApprovalMode: 'default',
        parentPermissionPresetId: 'default'
      }).kimiThinkingEnabled
    ).toBe(true)
  })

  it.each(['', ' ', 'cli-default', 'default', 'custom'])(
    'rejects the model sentinel %j before template persistence',
    (model) => {
      expect(() =>
        buildUltraTaskRunTemplateRequest({
          prompt: 'Run the stage.',
          effect: 'read_only',
          seat: { provider: 'codex', model },
          parentApprovalMode: 'default',
          parentPermissionPresetId: 'default'
        })
      ).toThrow(/exact concrete model/i)
    }
  )
})
