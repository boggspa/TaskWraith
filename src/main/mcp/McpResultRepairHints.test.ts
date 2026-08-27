import { describe, expect, it } from 'vitest'
import {
  deriveWorkspaceMutationClaims,
  WorkspaceMutationClaimDerivationError
} from '../WorkspaceMutationClaims'
import {
  attachMcpResultRepairHints,
  buildApplyPatchFailureHint,
  buildCapabilityInvokeUnknownTargetHint
} from './McpResultRepairHints'

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

describe('S5 capability_invoke unknown_target repair', () => {
  it('redirects a DIRECT tool name to a direct call carrying the caller arguments', () => {
    const hint = buildCapabilityInvokeUnknownTargetHint({
      toolName: 'capability_invoke',
      receivedArguments: {
        name: 'read_file',
        arguments: { path: 'src/main/index.ts', limit: 20 }
      },
      result: {
        ok: false,
        tool: 'capability_invoke',
        code: 'unknown_target',
        error: 'Unknown TaskWraith capability: read_file'
      }
    })

    expect(hint?.why).toContain('read_file')
    expect(hint?.why).toContain('directly')
    expect(hint).toMatchObject({
      receivedKeys: ['arguments', 'name'],
      retryTemplate: { tool: 'read_file', arguments: { path: 'src/main/index.ts', limit: 20 } }
    })
  })

  it('routes a genuinely unknown name to capability_search instead of inventing a call', () => {
    const hint = buildCapabilityInvokeUnknownTargetHint({
      toolName: 'capability_invoke',
      receivedArguments: { name: 'definitely_not_a_tool', arguments: {} },
      result: {
        ok: false,
        tool: 'capability_invoke',
        code: 'unknown_target',
        error: 'Unknown TaskWraith capability: definitely_not_a_tool'
      }
    })

    expect(hint?.why).toContain('capability_search')
    expect(hint?.retryTemplate).toEqual({
      tool: 'capability_search',
      arguments: { query: 'definitely_not_a_tool' }
    })
  })

  it('ignores successes and unrelated gateway rejections', () => {
    expect(
      buildCapabilityInvokeUnknownTargetHint({
        toolName: 'capability_invoke',
        receivedArguments: { name: 'read_file' },
        result: { ok: true }
      })
    ).toBeUndefined()
    expect(
      buildCapabilityInvokeUnknownTargetHint({
        toolName: 'capability_invoke',
        receivedArguments: { name: 'read_file' },
        result: {
          ok: false,
          code: 'audit_only_target',
          error: "Audit-only capability 'read_file' cannot be invoked through the gateway."
        }
      })
    ).toBeUndefined()
  })
})

describe('S5 apply_patch failure repair', () => {
  it('echoes the caller patch and names the hunk-count and context-line rules', () => {
    const hint = buildApplyPatchFailureHint({
      toolName: 'apply_patch',
      receivedArguments: {
        patch: 'diff --git a/a.ts b/a.ts\n@@ -1,3 +1,2 @@\n context\n-removed\n'
      },
      result: {
        ok: false,
        message: 'Patch hunk body does not match its declared line counts.'
      }
    })

    expect(hint?.why).toContain('hunk')
    expect(hint?.why).toContain('leading space')
    expect(hint?.receivedKeys).toEqual(['patch'])
    expect(hint?.retryTemplate.patch).toContain('@@ -1,3 +1,2 @@')
  })

  it('teaches the unified-diff conversion for Codex *** Begin Patch envelopes', () => {
    const hint = buildApplyPatchFailureHint({
      toolName: 'apply_patch',
      receivedArguments: { patch: '*** Begin Patch\n*** Update File: a.ts\n@@\n*** End Patch\n' },
      result: {
        ok: false,
        message:
          'Patch does not apply cleanly. apply_patch expects a real git unified diff ' +
          '(diff --git / --- a/ +++ b/ with @@ -old,count +new,count @@ hunk headers). ' +
          'Codex-style "*** Begin Patch" envelopes are not accepted — convert to unified diff first. ' +
          'No partial write was performed.'
      }
    })

    expect(hint?.why).toContain('unified diff')
    expect(hint?.why).toContain('Begin Patch')
  })

  it('ignores successes and non-patch failures', () => {
    expect(
      buildApplyPatchFailureHint({
        toolName: 'apply_patch',
        receivedArguments: {},
        result: { ok: true, message: 'Patch applied.' }
      })
    ).toBeUndefined()
    expect(
      buildApplyPatchFailureHint({
        toolName: 'apply_patch',
        receivedArguments: { patch: 'diff --git a/a.ts b/a.ts' },
        result: { ok: false, message: 'Workspace lock is held by another writer.' }
      })
    ).toBeUndefined()
  })
})

describe('S5 run_task claim rejection names the working route', () => {
  async function claimError(action: string, args: Record<string, unknown>): Promise<unknown> {
    return deriveWorkspaceMutationClaims({
      action,
      args,
      workspacePath: '/tmp/workspace'
    }).then(
      () => {
        throw new Error(`expected ${action} claim derivation to fail`)
      },
      (caught) => caught
    )
  }

  it('echoes the received task and names run_shell_command as the working route', async () => {
    const error = await claimError('run_task', { task: 'test' })

    expect(error).toBeInstanceOf(WorkspaceMutationClaimDerivationError)
    expect((error as WorkspaceMutationClaimDerivationError).code).toBe('invalid-call')
    expect((error as Error).message).toContain('"test"')
    expect((error as Error).message).toContain('run_shell_command')
  })

  it('keeps the generic claim failure for other workspace-runtime tools', async () => {
    const error = await claimError('start_background_process', { command: 'npm test' })

    expect((error as Error).message).toContain('cannot prove an exact file/hunk mutation scope')
    expect((error as Error).message).not.toContain('run_shell_command with the equivalent command')
  })
})
