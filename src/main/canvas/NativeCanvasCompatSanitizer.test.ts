import { describe, expect, it } from 'vitest'
import {
  createNativeCanvasCompatSanitizer,
  nativeCanvasCompatToolIds,
  nativeCanvasCompatToolName
} from './NativeCanvasCompatSanitizer'
import { createCanvasEvalApprovalReceipt, createCanvasEvalCompatSanitizer } from './CanvasEvalAudit'

describe('NativeCanvasCompatSanitizer', () => {
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
