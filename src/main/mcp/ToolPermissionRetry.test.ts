import { describe, expect, it, vi } from 'vitest'
import { createTaskWraithMcpToolDefinitions } from '../McpToolCatalog'
import { resolveGatewayInvocation, searchGatewayCapabilities } from './McpToolGateway'
import { GATEWAY_V8_MCP_HIDDEN_TOOL_NAMES } from './McpToolProfiles'
import {
  buildToolPermissionRetryInstruction,
  buildToolPermissionRetryApprovalPrompt,
  createOneOffToolPermissionRetryMarker,
  executeOneOffToolPermissionRetry,
  isOneOffToolPermissionRetryForTarget,
  isPermissionBoundaryFailure,
  oneOffToolPermissionRetryGuardError,
  orchestrateToolPermissionRetry,
  prepareToolPermissionRetryTarget,
  validateToolPermissionRetryRequest
} from './ToolPermissionRetry'

const definitions = createTaskWraithMcpToolDefinitions()
const isAutoAllowed = (toolName: string) =>
  ['read_file', 'ask_user_question', 'request_tool_permission'].includes(toolName)

describe('gateway discovery', () => {
  const hiddenDefinitions = definitions.filter((definition) =>
    (GATEWAY_V8_MCP_HIDDEN_TOOL_NAMES as readonly string[]).includes(definition.name)
  )

  it('lets a fresh v8 seat discover and resolve the permission retry capability', () => {
    const search = searchGatewayCapabilities({
      query: 'permission retry',
      definitions: hiddenDefinitions,
      eligibleToolNames: GATEWAY_V8_MCP_HIDDEN_TOOL_NAMES
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
      eligibleToolNames: GATEWAY_V8_MCP_HIDDEN_TOOL_NAMES
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
      targetResult
    })
    expect(outcome.targetResult).toBe(targetResult)
    expect(executeTarget).toHaveBeenCalledOnce()
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
  })
})

describe('isPermissionBoundaryFailure', () => {
  it.each([
    'permission denied',
    'operation not permitted',
    'EACCES: open failed',
    'blocked by the read-only posture',
    'approval timed out'
  ])('recognizes %s', (failure) => {
    expect(isPermissionBoundaryFailure(failure)).toBe(true)
  })
})
