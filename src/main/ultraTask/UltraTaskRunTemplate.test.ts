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
      claudeReasoningEffort: 'max'
    })
  })

  // Regression: the graph dispatch guard (src/main/index.ts, "Execution graph
  // queue request no longer matches its complete template") stable-stringifies
  // the persisted template against a reconstruction of the queue row. The queue
  // snapshot writes `externalPathGrants: undefined` when there are no grants
  // (RunQueueService.ts, `externalPathGrants.length ? … : undefined`) and JSON
  // drops the key, so a template that emits `[]` can never match its own queue
  // row. Both recorded UltraTask executions died here, 10s after dispatch, with
  // no provider session ever created.
  it('omits externalPathGrants entirely when the stage carries no grants', () => {
    const request = buildUltraTaskRunTemplateRequest({
      prompt: 'Scout the codebase.',
      effect: 'read_only',
      seat: { provider: 'antigravity', model: 'gemini-3.1-pro' },
      parentApprovalMode: 'default',
      parentPermissionPresetId: 'default',
      parentWorkflowMode: 'normal'
    })
    expect('externalPathGrants' in request).toBe(false)
    expect(JSON.parse(JSON.stringify(request))).toEqual(request)
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
