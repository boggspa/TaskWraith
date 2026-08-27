import { describe, expect, it } from 'vitest'
import { attachMcpResultRepairHints } from './McpResultRepairHints'

describe('attachMcpResultRepairHints', () => {
  it('preserves caller plan text and the envelope shape in a set_round_plan repair', () => {
    const result = attachMcpResultRepairHints({
      toolName: 'ensemble_control',
      receivedArguments: { action: 'set_round_plan', params: { planSummary: 'Ship the fix.' } },
      normalizedArguments: { action: 'set_round_plan', planSummary: 'Ship the fix.' },
      result: {
        ok: false,
        tool: 'ensemble_bossman_control',
        action: 'set_round_plan',
        error: 'missing_required_field'
      }
    })

    expect(result).toMatchObject({
      ok: false,
      repair: {
        receivedKeys: ['action', 'params', 'params.planSummary'],
        retryTemplate: {
          action: 'set_round_plan',
          params: { planSummary: 'Ship the fix.' }
        }
      }
    })
  })

  it('keeps fan-out targets and prompt while supplying an explicit writer-scope shape', () => {
    const result = attachMcpResultRepairHints({
      toolName: 'ensemble_fanout',
      receivedArguments: {
        targets: ['Worker', 'Reviewer'],
        prompt: 'Implement only the worker slice.',
        mode: 'locked_writers'
      },
      result: { ok: false, tool: 'ensemble_fanout', error: 'missing_write_scope' }
    })

    expect(result).toMatchObject({
      repair: {
        retryTemplate: {
          targets: ['Worker', 'Reviewer'],
          prompt: 'Implement only the worker slice.',
          mode: 'locked_writers',
          writeScopes: { Worker: ['<workspace-relative-path>'] }
        }
      }
    })
  })

  it('repairs invalid writer scopes with caller targets intact', () => {
    const result = attachMcpResultRepairHints({
      toolName: 'ensemble_fanout',
      receivedArguments: {
        targets: ['Worker'],
        prompt: 'Edit the worker slice.',
        mode: 'locked_writers',
        writeScopes: { Typo: ['src/worker/**'] }
      },
      result: { ok: false, tool: 'ensemble_fanout', error: 'invalid_write_scope' }
    })

    expect(result).toMatchObject({
      repair: {
        retryTemplate: {
          targets: ['Worker'],
          prompt: 'Edit the worker slice.',
          writeScopes: { Worker: ['<workspace-relative-path>'] }
        }
      }
    })
  })

  it('repairs a prose-suffixed scout confidence enum without losing the findings', () => {
    const result = attachMcpResultRepairHints({
      toolName: 'scout_brief',
      receivedArguments: {
        findings: 'Every cited file was read.',
        confidence: 'high — all claims verified against source code line numbers.'
      },
      result: { ok: false, tool: 'scout_brief', error: 'invalid_confidence' }
    })

    expect(result).toMatchObject({
      repair: {
        retryTemplate: {
          findings: 'Every cited file was read.',
          confidence: 'high'
        }
      }
    })
  })

  it('uses a valid neutral confidence when no enum prefix can be recovered', () => {
    const result = attachMcpResultRepairHints({
      toolName: 'scout_brief',
      receivedArguments: {
        findings: 'Every cited file was read.',
        confidence: 'certain'
      },
      result: { ok: false, tool: 'scout_brief', error: 'invalid_confidence' }
    })

    expect(result).toMatchObject({
      repair: {
        retryTemplate: {
          findings: 'Every cited file was read.',
          confidence: 'medium'
        }
      }
    })
  })

  it('leaves successful and unrelated errors untouched', () => {
    const success = { ok: true, tool: 'ensemble_fanout' }
    const unrelated = { ok: false, tool: 'ensemble_fanout', error: 'not_authorized' }

    expect(
      attachMcpResultRepairHints({
        toolName: 'ensemble_fanout',
        receivedArguments: {},
        result: success
      })
    ).toBe(success)
    expect(
      attachMcpResultRepairHints({
        toolName: 'ensemble_fanout',
        receivedArguments: {},
        result: unrelated
      })
    ).toBe(unrelated)
  })
})
