import { describe, expect, it } from 'vitest'
import {
  createNativeCanvasCompatSanitizer,
  nativeCanvasCompatToolIds,
  nativeCanvasCompatToolName
} from './NativeCanvasCompatSanitizer'
import { createCanvasEvalApprovalReceipt, createCanvasEvalCompatSanitizer } from './CanvasEvalAudit'
import { isCanvasMcpToolName } from '../mcp/CanvasToolExecutors'

describe('NativeCanvasCompatSanitizer', () => {
  it.each(['computer_use', 'mcp__TaskWraith__computer_use'])(
    'projects %s fill inputs and paired observations without changing the provider payload',
    (toolName) => {
      const sanitizer = createNativeCanvasCompatSanitizer()
      const scope = 'codex:computer-use'
      const use = {
        type: 'tool_use',
        tool_id: 'computer-fill-call',
        tool_name: toolName,
        parameters: {
          action: 'fill',
          canvasId: 'private-window',
          ref: 'private-field',
          text: 'FILL-SECRET',
          expectedObservationId: 'private-observation'
        },
        provider: 'codex'
      }
      const result = {
        type: 'tool_result',
        tool_call_id: 'computer-fill-call',
        output: 'DOM-SECRET',
        result: {
          observation: { url: 'https://example.test/?token=URL-SECRET', text: 'DOM-SECRET' },
          content: [{ type: 'image', mimeType: 'image/png', data: 'BASE64-SECRET' }]
        },
        provider: 'codex'
      }
      const originalPayload = JSON.stringify([use, result])
      const projectedUse = sanitizer.sanitize(use, scope) as Record<string, unknown>
      const projectedResult = sanitizer.sanitize(result, scope) as Record<string, unknown>

      expect(isCanvasMcpToolName('computer_use')).toBe(false)
      expect(projectedUse).toEqual({
        type: 'tool_use',
        tool_name: 'computer_use',
        tool_id: expect.stringMatching(/^canvas-tool-/),
        parameters: {
          redacted: true,
          argumentByteLength: Buffer.byteLength(JSON.stringify(use.parameters), 'utf8')
        },
        provider: 'codex'
      })
      expect(projectedResult).toEqual({
        type: 'tool_result',
        tool_name: 'computer_use',
        tool_id: projectedUse.tool_id,
        status: 'success',
        output: 'Canvas operation completed.',
        result: { redacted: true, tool: 'computer_use', ok: true },
        structuredContent: { redacted: true, tool: 'computer_use', ok: true },
        provider: 'codex'
      })
      expect(JSON.stringify([projectedUse, projectedResult])).not.toMatch(
        /SECRET|private-|computer-fill-call/
      )
      expect(JSON.stringify([use, result])).toBe(originalPayload)
    }
  )

  it.each([false, true])(
    'protects gateway-wrapped Computer Use and nameless native results (JSON arguments: %s)',
    (jsonArguments) => {
      const sanitizer = createNativeCanvasCompatSanitizer()
      const parameters = {
        name: 'mcp__TaskWraith__computer_use',
        arguments: { action: 'fill', canvasId: 'private-window', text: 'WRAPPED-FILL-SECRET' }
      }
      const use = {
        type: 'item_started',
        item: {
          type: 'mcp_tool_call',
          id: 'wrapped-native-call',
          name: 'mcp__TaskWraith__capability_invoke',
          arguments: jsonArguments ? JSON.stringify(parameters) : parameters
        }
      }
      const result = {
        type: 'item_completed',
        item: {
          type: 'mcp_tool_call',
          id: 'wrapped-native-call',
          content: [{ type: 'text', text: 'OBSERVATION-SECRET' }]
        }
      }
      expect(nativeCanvasCompatToolName(use)).toBe('computer_use')
      const projectedUse = sanitizer.sanitize(use, 'codex:wrapped') as Record<string, unknown>
      const projectedResult = sanitizer.sanitize(result, 'codex:wrapped') as Record<string, unknown>
      expect(projectedUse).toMatchObject({
        type: 'tool_use',
        tool_name: 'computer_use',
        parameters: { redacted: true }
      })
      expect(projectedResult).toMatchObject({
        type: 'tool_result',
        tool_name: 'computer_use',
        tool_id: projectedUse.tool_id,
        result: { redacted: true, tool: 'computer_use' }
      })
      expect(projectedUse.tool_id).toMatch(/^canvas-tool-/)
      expect(JSON.stringify([projectedUse, projectedResult])).not.toMatch(
        /SECRET|private-|wrapped-native-call/
      )
    }
  )

  it('protects Computer Use permission retries and primed result-only aliases', () => {
    const wrapper = {
      type: 'tool_use',
      tool_name: 'capability_invoke',
      parameters: {
        name: 'request_tool_permission',
        arguments: {
          toolName: 'computer_use',
          args: { action: 'fill', text: 'RETRY-FILL-SECRET' }
        }
      }
    }
    expect(nativeCanvasCompatToolName(wrapper)).toBe('computer_use')
    expect(
      JSON.stringify(createNativeCanvasCompatSanitizer().sanitize(wrapper, 'retry'))
    ).not.toContain('RETRY-FILL-SECRET')

    const sanitizer = createNativeCanvasCompatSanitizer()
    sanitizer.prime('kimi:computer-use', 'mcp__TaskWraith__computer_use', [
      'approval-call',
      'native-call-alias'
    ])
    const projectedId = sanitizer.projectedToolId('kimi:computer-use', ['approval-call'])
    const result = sanitizer.sanitize(
      {
        type: 'function_call_output',
        call_id: 'native-call-alias',
        output: 'OBSERVATION-SECRET',
        is_error: true
      },
      'kimi:computer-use'
    )
    expect(projectedId).toMatch(/^canvas-tool-/)
    expect(result).toMatchObject({
      type: 'tool_result',
      tool_name: 'computer_use',
      tool_id: projectedId,
      status: 'error',
      result: { redacted: true, tool: 'computer_use', ok: false }
    })
    expect(JSON.stringify(result)).not.toMatch(/SECRET|approval-call|native-call-alias/)
    const unrelated = { type: 'tool_result', tool_id: 'read-file-call', output: 'file contents' }
    expect(sanitizer.sanitize(unrelated, 'kimi:computer-use')).toBe(unrelated)
  })

  it('recognizes prefixed and gateway Canvas identities', () => {
    expect(
      nativeCanvasCompatToolName({
        type: 'tool_use',
        tool_name: 'mcp__TaskWraith__canvas_screenshot'
      })
    ).toBe('canvas_screenshot')
    expect(
      nativeCanvasCompatToolName({
        type: 'tool_use',
        tool_name: 'capability_invoke',
        parameters: { name: 'canvas_network', arguments: { canvasId: 'secret' } }
      })
    ).toBe('canvas_network')
  })

  it('projects a nested permission-retry Canvas wrapper without persisting fill values', () => {
    const secret = '__NATIVE_RETRY_FILL_SECRET__'
    const wrapper = {
      type: 'tool_use',
      tool_id: 'provider-retry-1',
      tool_name: 'capability_invoke',
      parameters: {
        name: 'request_tool_permission',
        arguments: {
          toolName: 'canvas_fill',
          arguments: { canvasId: 'canvas-1', ref: 'field-1', value: secret },
          failure: 'permission denied'
        }
      },
      provider: 'codex'
    }
    expect(nativeCanvasCompatToolName(wrapper)).toBe('canvas_fill')

    const projected = createNativeCanvasCompatSanitizer().sanitize(
      wrapper,
      'codex:run-retry'
    ) as Record<string, unknown>
    expect(projected).toMatchObject({
      type: 'tool_use',
      tool_name: 'canvas_fill',
      parameters: { redacted: true }
    })
    expect(JSON.stringify(projected)).not.toContain(secret)
    expect(JSON.stringify(projected)).not.toContain('provider-retry-1')

    const directWrapper = {
      type: 'tool_use',
      tool_id: 'legacy-full-retry-1',
      tool_name: 'request_tool_permission',
      parameters: wrapper.parameters.arguments,
      provider: 'claude'
    }
    expect(nativeCanvasCompatToolName(directWrapper)).toBe('canvas_fill')
    const directProjection = createNativeCanvasCompatSanitizer().sanitize(
      directWrapper,
      'claude:legacy-full-run'
    )
    expect(JSON.stringify(directProjection)).not.toContain(secret)
    expect(directProjection).toMatchObject({
      type: 'tool_use',
      tool_name: 'canvas_fill',
      parameters: { redacted: true }
    })
  })

  it('projects Canvas use/results to metadata only and keeps a stable opaque id', () => {
    const sanitizer = createNativeCanvasCompatSanitizer()
    const use = sanitizer.sanitize(
      {
        type: 'tool_use',
        tool_id: 'provider-call-1',
        tool_name: 'canvas_open',
        parameters: { url: 'https://example.test/?token=URL-SECRET' },
        provider: 'codex'
      },
      'codex:run-1'
    ) as Record<string, unknown>
    const result = sanitizer.sanitize(
      {
        type: 'tool_result',
        tool_id: 'provider-call-1',
        output: 'DOM-SECRET https://example.test/?token=RESULT-SECRET',
        result: { image: 'BASE64-SECRET' },
        provider: 'codex'
      },
      'codex:run-1'
    ) as Record<string, unknown>

    expect(use.tool_name).toBe('canvas_open')
    expect(result.tool_name).toBe('canvas_open')
    expect(result.tool_id).toBe(use.tool_id)
    expect(JSON.stringify([use, result])).not.toContain('URL-SECRET')
    expect(JSON.stringify([use, result])).not.toContain('RESULT-SECRET')
    expect(JSON.stringify([use, result])).not.toContain('DOM-SECRET')
    expect(JSON.stringify([use, result])).not.toContain('BASE64-SECRET')
  })

  it('primes result-only approval correlation without exposing raw ids', () => {
    const sanitizer = createNativeCanvasCompatSanitizer()
    sanitizer.prime('kimi:run-2', 'canvas_eval', ['approval-wire-id'])
    const result = sanitizer.sanitize(
      {
        type: 'tool_result',
        tool_call_id: 'approval-wire-id',
        output: 'EVAL-RESULT-SECRET'
      },
      'kimi:run-2'
    ) as Record<string, unknown>

    expect(result).toMatchObject({
      type: 'tool_result',
      tool_name: 'canvas_eval',
      output: 'Canvas operation completed.'
    })
    expect(JSON.stringify(result)).not.toContain('approval-wire-id')
    expect(JSON.stringify(result)).not.toContain('EVAL-RESULT-SECRET')
  })

  it('preserves the approval receipt on a result-only native canvas_eval echo', () => {
    const native = createNativeCanvasCompatSanitizer()
    const canvasEval = createCanvasEvalCompatSanitizer()
    const scope = 'kimi:run-result-only'
    const rawToolId = 'native-approval-wire-id'
    const alternateRawToolId = 'native-approval-wire-alias'
    const receipt = createCanvasEvalApprovalReceipt('document.title', 'approval-result-only')

    native.prime(scope, 'canvas_eval', [rawToolId, alternateRawToolId])
    const projectedToolId = native.projectedToolId(scope, [rawToolId])
    expect(projectedToolId).toMatch(/^canvas-tool-/)
    canvasEval.sanitize(
      {
        type: 'tool_use',
        tool_name: 'canvas_eval',
        tool_id: projectedToolId
      },
      receipt,
      scope
    )

    const nativeResult = native.sanitize(
      {
        type: 'tool_result',
        tool_call_id: alternateRawToolId,
        output: 'RESULT-ONLY-SECRET'
      },
      scope
    )
    const durableResult = canvasEval.sanitize(nativeResult, undefined, scope)

    expect(durableResult).toMatchObject({
      type: 'tool_result',
      tool_name: 'canvas_eval',
      result: { redacted: true, canvasEvalReceipt: receipt }
    })
    expect(JSON.stringify(durableResult)).not.toContain(rawToolId)
    expect(JSON.stringify(durableResult)).not.toContain(alternateRawToolId)
    expect(JSON.stringify(durableResult)).not.toContain('RESULT-ONLY-SECRET')
  })

  it('extracts nested provider result ids', () => {
    expect(
      nativeCanvasCompatToolIds({
        params: { payload: { return_value: {}, tool_call_id: 'call-1' } }
      })
    ).toContain('call-1')
  })

  it('fails closed for unknown result frames after correlation saturation', () => {
    const sanitizer = createNativeCanvasCompatSanitizer(1)
    sanitizer.prime('scope', 'canvas_open', ['one'])
    sanitizer.prime('scope', 'canvas_network', ['two'])
    const result = sanitizer.sanitize(
      { type: 'tool_result', tool_id: 'unknown', output: 'MUST-NOT-PERSIST' },
      'scope'
    )
    expect(JSON.stringify(result)).not.toContain('MUST-NOT-PERSIST')
  })
})
