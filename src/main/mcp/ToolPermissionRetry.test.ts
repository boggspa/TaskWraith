import { describe, expect, it, vi } from 'vitest'
import { createTaskWraithMcpToolDefinitions } from '../McpToolCatalog'
import { resolveGatewayInvocation, searchGatewayCapabilities } from './McpToolGateway'
import { validateMcpToolArgumentsBeforeApproval } from './McpPreApprovalArgumentValidation'
import { GATEWAY_V9_MCP_HIDDEN_TOOL_NAMES } from './McpToolProfiles'
import {
  buildToolPermissionRetryInstruction,
  buildToolPermissionRetryApprovalPrompt,
  createOneOffToolPermissionRetryMarker,
  approvedShellAuthorityAuthorizesUnscopedShell,
  executeOneOffToolPermissionRetry,
  isOneOffToolPermissionRetryForTarget,
  isPermissionBoundaryFailure,
  oneOffToolPermissionRetryGuardError,
  orchestrateToolPermissionRetry,
  prepareToolPermissionRetryTarget,
  toolPermissionRetryApprovalPayloadForDurableStorage,
  validateToolPermissionRetryRequest
} from './ToolPermissionRetry'

const definitions = createTaskWraithMcpToolDefinitions()
const isAutoAllowed = (toolName: string) =>
  ['read_file', 'ask_user_question', 'request_tool_permission'].includes(toolName)

describe('gateway discovery', () => {
  const hiddenDefinitions = definitions.filter((definition) =>
    (GATEWAY_V9_MCP_HIDDEN_TOOL_NAMES as readonly string[]).includes(definition.name)
  )

  it('lets a fresh v9 seat discover and resolve the permission retry capability', () => {
    const search = searchGatewayCapabilities({
      query: 'permission retry',
      definitions: hiddenDefinitions,
      eligibleToolNames: GATEWAY_V9_MCP_HIDDEN_TOOL_NAMES
    })
    expect(search.ok && search.matches.map((match) => match.name)).toContain(
      'request_tool_permission'
    )

    const resolution = resolveGatewayInvocation({
      name: 'request_tool_permission',
      arguments: {
        toolName: 'write_file',
        arguments: { path: 'notes.txt', content: 'hello' },
        failure: 'File changes denied by TaskWraith.'
      },
      definitions: hiddenDefinitions,
      eligibleToolNames: GATEWAY_V9_MCP_HIDDEN_TOOL_NAMES
    })
    expect(resolution).toMatchObject({ ok: true, name: 'request_tool_permission' })
  })
})

describe('validateToolPermissionRetryRequest', () => {
  it('accepts an exact gated invocation after a permission-like failure', () => {
    const result = validateToolPermissionRetryRequest({
      value: {
        toolName: 'write_file',
        arguments: { path: 'notes.txt', content: 'hello' },
        failure: 'File changes denied by TaskWraith.',
        rationale: 'The requested note cannot be created otherwise.'
      },
      definitions,
      isAutoAllowed
    })

    expect(result).toEqual({
      ok: true,
      request: {
        toolName: 'write_file',
        arguments: { path: 'notes.txt', content: 'hello' },
        failure: 'File changes denied by TaskWraith.',
        rationale: 'The requested note cannot be created otherwise.'
      }
    })
  })

  it('rejects an explicit user decline instead of prompting again', () => {
    const result = validateToolPermissionRetryRequest({
      value: {
        toolName: 'write_file',
        arguments: { path: 'notes.txt', content: 'hello' },
        failure: 'The user declined this file change.'
      },
      definitions,
      isAutoAllowed
    })

    expect(result).toMatchObject({ ok: false, code: 'explicit_user_decline' })
  })

  it('rejects ordinary execution failures and already-auto-allowed targets', () => {
    expect(
      validateToolPermissionRetryRequest({
        value: {
          toolName: 'write_file',
          arguments: { path: 'notes.txt', content: 'hello' },
          failure: 'Disk is full.'
        },
        definitions,
        isAutoAllowed
      })
    ).toMatchObject({ ok: false, code: 'not_permission_failure' })

    expect(
      validateToolPermissionRetryRequest({
        value: {
          toolName: 'read_file',
          arguments: { path: 'notes.txt' },
          failure: 'permission denied'
        },
        definitions,
        isAutoAllowed
      })
    ).toMatchObject({ ok: false, code: 'target_does_not_need_permission' })
  })

  it.each([
    'Lane lane-kimi-1 is not approved to write .wip-work3-slice3.',
    'The participant is outside the approved lane scope.',
    'Lane lane-codex-3 has no approved write scope.',
    'This Ensemble participant run is no longer active and cannot mutate workspace state.'
  ])('rejects a non-grantable Ensemble lane boundary: %s', (failure) => {
    const value = {
      toolName: 'write_file' as const,
      arguments: { path: '.WORK-IN-PROGRESS-codex-work1.md', content: 'marker' },
      failure
    }

    expect(validateToolPermissionRetryRequest({ value, definitions, isAutoAllowed })).toMatchObject(
      { ok: false, code: 'non_retriable_failure' }
    )
    expect(
      buildToolPermissionRetryInstruction({
        available: true,
        ...value,
        definitions,
        isAutoAllowed
      })
    ).toBeNull()
  })

  it('rejects special approval paths and invalid target arguments', () => {
    expect(
      validateToolPermissionRetryRequest({
        value: {
          toolName: 'canvas_eval',
          arguments: { canvasId: 'canvas-1', script: 'document.title' },
          failure: 'sandbox permission denied'
        },
        definitions,
        isAutoAllowed
      })
    ).toMatchObject({ ok: false, code: 'non_retriable_target' })

    expect(
      validateToolPermissionRetryRequest({
        value: {
          toolName: 'write_file',
          arguments: { path: 'notes.txt' },
          failure: 'permission denied'
        },
        definitions,
        isAutoAllowed
      })
    ).toMatchObject({ ok: false, code: 'invalid_target_arguments' })
  })

  it('rejects a canonical target absent from the supplied immutable profile snapshot', () => {
    expect(
      validateToolPermissionRetryRequest({
        value: {
          toolName: 'ensemble_bossman_control',
          arguments: {},
          failure: 'permission denied'
        },
        definitions: definitions.filter(
          (definition) => definition.name !== 'ensemble_bossman_control'
        ),
        isAutoAllowed
      })
    ).toMatchObject({ ok: false, code: 'invalid_target' })
  })

  it('accepts the portable Ensemble alias against the immutable profile schema', () => {
    expect(
      validateToolPermissionRetryRequest({
        value: {
          toolName: 'ensemble_control',
          arguments: { action: 'status' },
          failure: 'permission denied'
        },
        definitions,
        isAutoAllowed
      })
    ).toMatchObject({ ok: true, request: { toolName: 'ensemble_control' } })
  })
})

describe('retry guidance and preserved hard guards', () => {
  it('emits an exact capability invocation for policy denial but never for a user decline', () => {
    const instruction = buildToolPermissionRetryInstruction({
      available: true,
      toolName: 'write_file',
      arguments: { path: 'notes.txt', content: 'hello' },
      failure: 'File changes denied by TaskWraith.',
      definitions,
      isAutoAllowed
    })
    expect(instruction).toMatchObject({
      available: true,
      targetArgumentsSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      tool: 'capability_invoke',
      arguments: {
        name: 'request_tool_permission',
        arguments: { toolName: 'write_file' }
      }
    })
    expect(
      buildToolPermissionRetryInstruction({
        available: true,
        toolName: 'write_file',
        arguments: { path: 'notes.txt', content: 'hello' },
        failure: 'The user declined the write_file approval.',
        definitions,
        isAutoAllowed
      })
    ).toBeNull()
  })

  it('does not advertise an impossible mutation-scope retry for non-shell tools', () => {
    const failure =
      'start_background_process cannot prove an exact file/hunk mutation scope; use exact TaskWraith file tools or a read-only command.'

    expect(
      buildToolPermissionRetryInstruction({
        available: true,
        toolName: 'start_background_process',
        arguments: { command: "printf 'hello' > notes.txt" },
        failure,
        definitions,
        isAutoAllowed
      })
    ).toBeNull()
    expect(
      validateToolPermissionRetryRequest({
        value: {
          toolName: 'start_background_process',
          arguments: { command: "printf 'hello' > notes.txt" },
          failure
        },
        definitions,
        isAutoAllowed
      })
    ).toMatchObject({ ok: false, code: 'non_retriable_failure' })

    expect(
      buildToolPermissionRetryInstruction({
        available: true,
        toolName: 'run_shell_command',
        arguments: { command: "printf 'hello' > notes.txt" },
        failure: 'run_shell_command cannot prove an exact file/hunk mutation scope',
        definitions,
        isAutoAllowed
      })
    ).toMatchObject({
      available: true,
      arguments: {
        arguments: { toolName: 'run_shell_command' }
      }
    })
  })

  it('uses the portable Ensemble name when the immutable profile omits the legacy name', () => {
    const instruction = buildToolPermissionRetryInstruction({
      available: true,
      toolName: 'ensemble_bossman_control',
      arguments: {
        action: 'summon_participant',
        targetParticipantId: 'participant-2',
        reason: 'Need a reviewer.'
      },
      failure: 'permission denied',
      definitions: definitions.filter(
        (definition) => definition.name !== 'ensemble_bossman_control'
      ),
      isAutoAllowed
    })

    expect(instruction?.arguments.arguments).toMatchObject({
      toolName: 'ensemble_control',
      arguments: {
        action: 'summon_participant',
        targetParticipantId: 'participant-2'
      }
    })
  })

  it('keeps network, external-path, and dedicated approval guards ahead of preview creation', () => {
    expect(
      oneOffToolPermissionRetryGuardError({
        toolName: 'web_search',
        networkError: 'network disabled',
        externalPathDetected: true,
        alwaysPrompts: true
      })
    ).toBe('network disabled')

    const buildTargetPreview = vi.fn(() => ({ toolName: 'write_file' }))
    expect(
      prepareToolPermissionRetryTarget({
        toolName: 'write_file',
        routeError: 'route mismatch',
        buildTargetPreview
      })
    ).toEqual({ ok: false, error: 'route mismatch' })
    expect(buildTargetPreview).not.toHaveBeenCalled()

    expect(
      prepareToolPermissionRetryTarget({
        toolName: 'write_file',
        providerPolicyError: 'Ollama cannot modify package.json',
        buildTargetPreview
      })
    ).toEqual({ ok: false, error: 'Ollama cannot modify package.json' })
    expect(buildTargetPreview).not.toHaveBeenCalled()
  })
})

describe('one-off permission retry execution', () => {
  it('executes exactly once after approval and preserves the target result', async () => {
    const targetResult = {
      text: 'created',
      content: [{ type: 'image' as const, mimeType: 'image/png', data: 'abc' }]
    }
    const executeTarget = vi.fn(async () => targetResult)
    const outcome = await executeOneOffToolPermissionRetry({
      requestApproval: vi.fn(async () => true),
      executeTarget
    })

    expect(executeTarget).toHaveBeenCalledOnce()
    expect(outcome).toEqual({ kind: 'executed', result: targetResult })
    if (outcome.kind === 'executed') expect(outcome.result).toBe(targetResult)
  })

  it('does not execute when the approval is declined', async () => {
    const executeTarget = vi.fn(async () => ({ text: 'unexpected' }))
    const outcome = await executeOneOffToolPermissionRetry({
      requestApproval: vi.fn(async () => false),
      executeTarget
    })

    expect(outcome).toEqual({ kind: 'not_approved' })
    expect(executeTarget).not.toHaveBeenCalled()
  })

  it('orchestrates approval and returns the exact rich target result', async () => {
    const targetResult = {
      text: 'created',
      structuredContent: { ok: true, path: 'notes.txt' },
      content: [{ type: 'image' as const, mimeType: 'image/png', data: 'abc' }]
    }
    const executeTarget = vi.fn(async () => targetResult)
    const outcome = await orchestrateToolPermissionRetry({
      value: {
        toolName: 'write_file',
        arguments: { path: 'notes.txt', content: 'hello' },
        failure: 'File changes denied by TaskWraith.'
      },
      definitions,
      isAutoAllowed,
      providerLabel: 'Codex',
      prepareTarget: () => ({ ok: true, targetPreview: { toolName: 'write_file' } }),
      requestApproval: async (_prompt, onDecision) => {
        onDecision({ action: 'accept', decisionSource: 'user' })
        return true
      },
      executeTarget
    })

    expect(outcome).toMatchObject({
      isError: false,
      targetToolName: 'write_file',
      targetResult,
      targetExecuted: true
    })
    expect(outcome.targetResult).toBe(targetResult)
    expect(executeTarget).toHaveBeenCalledOnce()
  })

  it('canonicalizes portable Ensemble arguments before preview, approval, and execution', async () => {
    const prepareTarget = vi.fn(() => ({
      ok: true as const,
      targetPreview: { toolName: 'ensemble_bossman_control' }
    }))
    const requestApproval = vi.fn(
      async (_prompt: ReturnType<typeof buildToolPermissionRetryApprovalPrompt>) => true
    )
    const executeTarget = vi.fn(async () => ({ text: 'summoned' }))

    const outcome = await orchestrateToolPermissionRetry({
      value: {
        toolName: 'ensemble_control',
        arguments: {
          action: 'summon_participant',
          params: { targetParticipantId: 'participant-2', reason: 'Review.' }
        },
        failure: 'permission denied'
      },
      definitions,
      isAutoAllowed,
      providerLabel: 'Codex',
      prepareTarget,
      requestApproval,
      executeTarget
    })

    const canonicalRequest = {
      toolName: 'ensemble_bossman_control',
      arguments: {
        action: 'summon_participant',
        targetParticipantId: 'participant-2',
        reason: 'Review.'
      },
      failure: 'permission denied'
    }
    expect(prepareTarget).toHaveBeenCalledWith(canonicalRequest)
    expect(requestApproval.mock.calls[0]?.[0]?.preview.permissionRetry).toMatchObject({
      targetToolName: 'ensemble_bossman_control',
      exactArguments: canonicalRequest.arguments
    })
    expect(executeTarget).toHaveBeenCalledWith(
      canonicalRequest,
      expect.objectContaining({ targetToolName: 'ensemble_bossman_control' })
    )
    expect(outcome).toMatchObject({
      isError: false,
      targetToolName: 'ensemble_bossman_control',
      targetExecuted: true
    })
  })

  it('rejects an invalid portable Ensemble action before opening approval', async () => {
    const requestApproval = vi.fn(async () => true)
    const executeTarget = vi.fn(async () => ({ text: 'unexpected' }))
    const outcome = await orchestrateToolPermissionRetry({
      value: {
        toolName: 'ensemble_control',
        arguments: { action: 'not_a_real_action' },
        failure: 'permission denied'
      },
      definitions,
      isAutoAllowed,
      providerLabel: 'Codex',
      prepareTarget: (request) => {
        const preflight = validateMcpToolArgumentsBeforeApproval(
          request.toolName,
          request.arguments,
          definitions
        )
        return preflight.ok
          ? { ok: true, targetPreview: {} }
          : { ok: false, error: preflight.message }
      },
      requestApproval,
      executeTarget
    })

    expect(outcome).toMatchObject({ isError: true })
    expect(requestApproval).not.toHaveBeenCalled()
    expect(executeTarget).not.toHaveBeenCalled()
  })

  it('does not label a pre-approval target rejection as an executed retry', async () => {
    const requestApproval = vi.fn(async () => true)
    const executeTarget = vi.fn(async () => ({ text: 'unexpected' }))
    const targetResult = { text: 'unsupported target', isError: true }
    const outcome = await orchestrateToolPermissionRetry({
      value: {
        toolName: 'write_file',
        arguments: { path: 'notes.txt', content: 'hello' },
        failure: 'File changes denied by TaskWraith.'
      },
      definitions,
      isAutoAllowed,
      providerLabel: 'Codex',
      prepareTarget: () => ({ ok: false, result: targetResult }),
      requestApproval,
      executeTarget
    })

    expect(outcome).toMatchObject({
      isError: true,
      targetToolName: 'write_file',
      targetResult
    })
    expect(outcome.targetExecuted).not.toBe(true)
    expect(requestApproval).not.toHaveBeenCalled()
    expect(executeTarget).not.toHaveBeenCalled()
  })

  it('reports an explicit user decline and never invokes the target', async () => {
    const executeTarget = vi.fn(async () => ({ text: 'unexpected' }))
    const outcome = await orchestrateToolPermissionRetry({
      value: {
        toolName: 'write_file',
        arguments: { path: 'notes.txt', content: 'hello' },
        failure: 'File changes denied by TaskWraith.'
      },
      definitions,
      isAutoAllowed,
      providerLabel: 'Codex',
      prepareTarget: () => ({ ok: true, targetPreview: { toolName: 'write_file' } }),
      requestApproval: async (_prompt, onDecision) => {
        onDecision({ action: 'decline', decisionSource: 'user' })
        return false
      },
      executeTarget
    })

    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain('Do not ask again')
    expect(executeTarget).not.toHaveBeenCalled()
  })
})

describe('one-off marker and approval receipt', () => {
  it('reuses direct and audited automatic authority for an opaque shell invocation', () => {
    const base = {
      toolName: 'run_shell_command' as const,
      arguments: { command: 'npm test', cwd: '/repo' },
      allowed: true
    }

    expect(
      approvedShellAuthorityAuthorizesUnscopedShell({
        ...base,
        decision: { action: 'accept', decisionSource: 'user' }
      })
    ).toBe(true)
    expect(
      approvedShellAuthorityAuthorizesUnscopedShell({
        ...base,
        automaticApproval: true,
        decision: { action: 'acceptForSession', decisionSource: 'system' }
      })
    ).toBe(true)
    expect(
      approvedShellAuthorityAuthorizesUnscopedShell({
        ...base,
        arguments: { command: 'ls -la', cwd: '/repo' },
        automaticApproval: true,
        decision: { action: 'accept', decisionSource: 'user' }
      })
    ).toBe(false)
    expect(
      approvedShellAuthorityAuthorizesUnscopedShell({
        ...base,
        decision: { action: 'decline', decisionSource: 'user' }
      })
    ).toBe(false)
    expect(
      approvedShellAuthorityAuthorizesUnscopedShell({
        ...base,
        decision: { action: 'acceptForSession', decisionSource: 'system' }
      })
    ).toBe(false)
  })

  const request = {
    toolName: 'write_file' as const,
    arguments: { path: 'notes.txt', content: 'hello' },
    failure: 'File changes denied by TaskWraith.'
  }

  it('binds the internal gate bypass to the exact target and arguments', () => {
    const marker = createOneOffToolPermissionRetryMarker(request)
    expect(isOneOffToolPermissionRetryForTarget(marker, 'write_file', request.arguments)).toBe(true)
    expect(
      isOneOffToolPermissionRetryForTarget(marker, 'write_file', {
        path: 'notes.txt',
        content: 'changed'
      })
    ).toBe(false)
    expect(isOneOffToolPermissionRetryForTarget(marker, 'delete_path', request.arguments)).toBe(
      false
    )
  })

  it('builds a one-shot approval preview with an exact-argument fingerprint', () => {
    const prompt = buildToolPermissionRetryApprovalPrompt({
      providerLabel: 'Codex',
      request,
      targetPreview: { toolName: 'write_file', path: 'notes.txt' }
    })

    expect(prompt.title).toBe('Allow Codex to retry write_file once?')
    expect(prompt.preview).toMatchObject({
      toolName: 'write_file',
      path: 'notes.txt',
      permissionRetry: {
        kind: 'tool_permission_retry',
        targetToolName: 'write_file'
      }
    })
    expect(
      (prompt.preview.permissionRetry as Record<string, unknown>).targetArgumentsSha256
    ).toMatch(/^[a-f0-9]{64}$/)
    expect((prompt.preview.permissionRetry as Record<string, unknown>).exactArguments).toEqual(
      request.arguments
    )
  })

  it('labels an unscoped shell retry as one auditable host execution', () => {
    const prompt = buildToolPermissionRetryApprovalPrompt({
      providerLabel: 'Pi',
      request: {
        toolName: 'run_shell_command',
        arguments: { command: 'npm test', cwd: '/repo' },
        failure: 'run_shell_command cannot prove an exact mutation scope.'
      },
      targetPreview: { kind: 'command', command: 'npm test', cwd: '/repo' }
    })

    expect(prompt.body).toContain('outside a workspace sandbox')
    expect(prompt.body).toContain('may race active writers')
    expect(prompt.preview.permissionRetry).toMatchObject({
      executionBoundary: 'host-unsandboxed-one-shot',
      workspaceMutationContainment: 'none-explicit-user-one-shot',
      exactCommand: 'npm test',
      exactCwd: '/repo'
    })
  })

  it('keeps exact arguments out of durable approval records while preserving shape and hash', () => {
    const secret = '__WRITE_CONTENT_BEYOND_NORMAL_PREVIEW__'
    const narrativeSecret = '__AGENT_NARRATIVE_SECRET__'
    const prompt = buildToolPermissionRetryApprovalPrompt({
      providerLabel: 'Codex',
      request: {
        ...request,
        arguments: { path: 'notes.txt', content: secret },
        failure: `permission denied: ${narrativeSecret}`,
        rationale: narrativeSecret
      },
      targetPreview: { toolName: 'write_file', contentPreview: 'truncated' }
    })
    const durable = toolPermissionRetryApprovalPayloadForDurableStorage({
      method: prompt.method,
      preview: prompt.preview
    })
    expect(JSON.stringify(durable)).not.toContain(secret)
    expect(JSON.stringify(durable)).not.toContain(narrativeSecret)
    expect(durable.preview.permissionRetry).toMatchObject({
      targetArgumentsSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      exactArgumentsRedacted: true,
      agentNarrativeRedacted: true,
      exactArgumentKeys: ['content', 'path'],
      exactArgumentByteLength: expect.any(Number)
    })
  })
})

describe('isPermissionBoundaryFailure', () => {
  it.each([
    'permission denied',
    'operation not permitted',
    'EACCES: open failed',
    'blocked by the read-only posture',
    'approval timed out',
    'run_shell_command cannot prove an exact file/hunk mutation scope',
    'writer lane did not provide exact edit scope',
    'resource is outside the approved lane scope',
    'participant is not approved to write this file'
  ])('recognizes %s', (failure) => {
    expect(isPermissionBoundaryFailure(failure)).toBe(true)
  })
})
