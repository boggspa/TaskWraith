import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'
import {
  CANVAS_EVAL_PROVIDER_TEXT_REDACTED,
  CANVAS_EVAL_RESULT_REDACTED,
  assertCanvasEvalApprovalReceipt,
  canvasEvalApprovalPayloadForDurableStorage,
  canvasEvalMcpArgsForLog,
  createCanvasEvalCompatSanitizer,
  createCanvasEvalApprovalReceipt,
  createCanvasEvalApprovalReceiptFromCanonicalArgs,
  createCanvasEvalJsonLineSanitizer,
  isCanvasEvalToolName,
  sanitizeCanvasEvalCompatPayload,
  sanitizeCanvasEvalProviderText
} from './CanvasEvalAudit'

describe('CanvasEvalAudit', () => {
  it('creates a versioned approval-bound SHA-256 receipt with both length units', () => {
    const script = 'window.title = "☃"'
    expect(createCanvasEvalApprovalReceipt(script, 'approval-1')).toEqual({
      schemaVersion: 2,
      approvalId: 'approval-1',
      scriptHashAlgorithm: 'sha256-utf16le',
      scriptHash: createHash('sha256').update(Buffer.from(script, 'utf16le')).digest('hex'),
      scriptLength: script.length,
      scriptByteLength: Buffer.byteLength(script, 'utf8')
    })
  })

  it('binds receipts to exact UTF-16 code units, including unpaired surrogates', () => {
    const highSurrogate = createCanvasEvalApprovalReceipt('\ud800', 'approval-surrogate')
    const nextHighSurrogate = createCanvasEvalApprovalReceipt('\ud801', 'approval-surrogate')

    expect(highSurrogate).toMatchObject({
      schemaVersion: 2,
      scriptHashAlgorithm: 'sha256-utf16le',
      scriptLength: 1
    })
    expect(highSurrogate.scriptHash).toBe(
      createHash('sha256')
        .update(Buffer.from([0x00, 0xd8]))
        .digest('hex')
    )
    expect(nextHighSurrogate.scriptHash).toBe(
      createHash('sha256')
        .update(Buffer.from([0x01, 0xd8]))
        .digest('hex')
    )
    expect(highSurrogate.scriptHash).not.toBe(nextHighSurrogate.scriptHash)
    expect(() => assertCanvasEvalApprovalReceipt('\ud801', highSurrogate)).toThrow(
      'does not match the script'
    )
  })

  it('mints native receipts only from canonical args, ignoring enclosing decoy scripts', () => {
    const canonicalArgs = { canvasId: 'canvas-1', script: 'ACTUAL-CANONICAL-SCRIPT' }
    const providerEnvelope = {
      script: 'DECOY-OUTER-SCRIPT',
      payload: { arguments: canonicalArgs }
    }

    const receipt = createCanvasEvalApprovalReceiptFromCanonicalArgs(
      providerEnvelope.payload.arguments,
      'approval-native'
    )
    expect(receipt).toEqual(
      createCanvasEvalApprovalReceipt('ACTUAL-CANONICAL-SCRIPT', 'approval-native')
    )
    expect(receipt).not.toEqual(
      createCanvasEvalApprovalReceipt('DECOY-OUTER-SCRIPT', 'approval-native')
    )
    expect(
      createCanvasEvalApprovalReceiptFromCanonicalArgs(providerEnvelope, 'approval-native')
    ).toBeUndefined()
    expect(createCanvasEvalApprovalReceiptFromCanonicalArgs({}, 'approval-native')).toBeUndefined()
  })

  it('recognises provider namespace spellings of canvas_eval', () => {
    expect(isCanvasEvalToolName('canvas_eval')).toBe(true)
    expect(isCanvasEvalToolName('mcp__taskwraith__canvas_eval')).toBe(true)
    expect(isCanvasEvalToolName('mcp_taskwraith-broker_canvas_eval')).toBe(true)
    expect(isCanvasEvalToolName('canvas_snapshot')).toBe(false)
  })

  it('redacts direct and gateway canvas_eval arguments before bridge logging', () => {
    const script = 'globalThis.__BRIDGE_LOG_SECRET__ = "\u2603"'
    const expectedHash = createHash('sha256').update(Buffer.from(script, 'utf16le')).digest('hex')

    const direct = canvasEvalMcpArgsForLog('mcp__taskwraith__canvas_eval', {
      canvasId: 'canvas-1',
      script
    })
    const gateway = canvasEvalMcpArgsForLog('capability_invoke', {
      name: 'canvas_eval',
      arguments: { canvasId: 'canvas-2', script }
    })

    expect(JSON.stringify(direct)).not.toContain('__BRIDGE_LOG_SECRET__')
    expect(direct).toMatchObject({
      scriptRedacted: true,
      scriptHash: expectedHash,
      scriptLength: script.length,
      scriptByteLength: Buffer.byteLength(script, 'utf8')
    })
    expect(JSON.stringify(gateway)).not.toContain('__BRIDGE_LOG_SECRET__')
    expect(gateway).toMatchObject({
      name: 'canvas_eval',
      arguments: {
        scriptRedacted: true,
        scriptHash: expectedHash
      }
    })

    const ordinary = { path: 'README.md' }
    expect(canvasEvalMcpArgsForLog('read_file', ordinary)).toBe(ordinary)

    const malformed = JSON.stringify({ script, canvasId: 'canvas-3' })
    const malformedSafe = canvasEvalMcpArgsForLog('canvas_eval', malformed)
    expect(JSON.stringify(malformedSafe)).not.toContain('__BRIDGE_LOG_SECRET__')
    expect(malformedSafe).toMatchObject({
      scriptRedacted: true,
      scriptHash: expectedHash
    })
    expect(canvasEvalMcpArgsForLog('canvas_eval', `not-json ${script}`)).toEqual({
      scriptRedacted: true,
      scriptFingerprintUnavailable: true
    })
  })

  it('does not copy duplicated provider fields into direct, gateway, or stringified bridge logs', () => {
    const sentinel = '__DUPLICATED_BRIDGE_LOG_SENTINEL__'
    const providerFields = {
      id: sentinel,
      requestId: sentinel,
      canvasId: sentinel,
      status: sentinel,
      output: sentinel,
      result: sentinel,
      content: sentinel,
      metadata: { duplicate: sentinel },
      script: sentinel
    }
    const direct = canvasEvalMcpArgsForLog('canvas_eval', providerFields)
    const gateway = canvasEvalMcpArgsForLog('capability_invoke', {
      name: 'canvas_eval',
      id: sentinel,
      requestId: sentinel,
      canvasId: sentinel,
      status: sentinel,
      output: sentinel,
      result: sentinel,
      content: sentinel,
      arguments: providerFields
    })
    const stringifiedGateway = canvasEvalMcpArgsForLog(
      'capability_invoke',
      JSON.stringify({
        name: 'canvas_eval',
        id: sentinel,
        requestId: sentinel,
        canvasId: sentinel,
        status: sentinel,
        output: sentinel,
        result: sentinel,
        content: sentinel,
        arguments: JSON.stringify(providerFields)
      })
    )

    for (const projected of [direct, gateway, stringifiedGateway]) {
      expect(JSON.stringify(projected)).not.toContain(sentinel)
    }
    expect(Object.keys(direct as Record<string, unknown>).sort()).toEqual([
      'scriptByteLength',
      'scriptHash',
      'scriptHashAlgorithm',
      'scriptLength',
      'scriptRedacted'
    ])
    for (const projected of [gateway, stringifiedGateway]) {
      expect(projected).toEqual({
        name: 'canvas_eval',
        arguments: expect.objectContaining({
          scriptRedacted: true,
          scriptHashAlgorithm: 'sha256-utf16le'
        })
      })
      expect(
        Object.keys((projected as { arguments: Record<string, unknown> }).arguments).sort()
      ).toEqual([
        'scriptByteLength',
        'scriptHash',
        'scriptHashAlgorithm',
        'scriptLength',
        'scriptRedacted'
      ])
    }
  })

  it('correlates a result that identifies canvas_eval only by tool call id', () => {
    const sanitizer = createCanvasEvalCompatSanitizer()
    const script = 'globalThis.__CORRELATED_SCRIPT_SECRET__ = 1'
    const receipt = createCanvasEvalApprovalReceipt(script, 'approval-correlated')

    const use = sanitizer.sanitize(
      {
        type: 'tool_use',
        tool_id: 'call-1',
        tool_name: 'canvas_eval',
        parameters: { canvasId: 'canvas-1', script }
      },
      receipt
    )
    const result = sanitizer.sanitize({
      type: 'tool_result',
      tool_id: 'call-1',
      output: '__CORRELATED_RESULT_SECRET__'
    })

    expect(JSON.stringify(use)).not.toContain('__CORRELATED_SCRIPT_SECRET__')
    expect(use).toMatchObject({
      parameters: { scriptRedacted: true, canvasEvalReceipt: receipt }
    })
    expect(JSON.stringify(result)).not.toContain('__CORRELATED_RESULT_SECRET__')
    expect(result).toMatchObject({
      tool_name: 'canvas_eval',
      output: CANVAS_EVAL_RESULT_REDACTED,
      result: { redacted: true, canvasEvalReceipt: receipt }
    })
  })

  it('fails closed across conflicting identity aliases and every result id alias', () => {
    const sanitizer = createCanvasEvalCompatSanitizer()
    const receipt = createCanvasEvalApprovalReceipt('actual()', 'approval-aliases')

    for (const toolName of ['', 'read_file']) {
      const projected = sanitizer.sanitize(
        {
          type: 'tool_use',
          toolName,
          tool_name: 'canvas_eval',
          id: `actual-${toolName || 'empty'}`,
          parameters: { script: '__CONFLICTING_IDENTITY_SCRIPT_SECRET__' }
        },
        receipt,
        'alias-scope'
      )
      expect(JSON.stringify(projected)).not.toContain('__CONFLICTING_IDENTITY_SCRIPT_SECRET__')
      expect(projected).toMatchObject({ tool_name: 'canvas_eval', type: 'tool_use' })
    }

    sanitizer.sanitize(
      {
        type: 'tool_use',
        id: 'actual-result-id',
        tool_name: 'canvas_eval',
        parameters: { script: 'actual()' }
      },
      receipt,
      'alias-scope'
    )
    const correlated = sanitizer.sanitize(
      {
        type: 'tool_result',
        tool_id: 'decoy-result-id',
        id: 'actual-result-id',
        toolName: 'read_file',
        tool: 'also-not-canvas',
        output: '__MULTI_ID_CORRELATED_RESULT_SECRET__'
      },
      undefined,
      'alias-scope'
    )
    expect(JSON.stringify(correlated)).not.toContain('__MULTI_ID_CORRELATED_RESULT_SECRET__')
    expect(correlated).toMatchObject({
      type: 'tool_result',
      tool_name: 'canvas_eval',
      output: CANVAS_EVAL_RESULT_REDACTED,
      result: { canvasEvalReceipt: receipt }
    })
  })

  it('does not trust a provider-embedded canvas_eval receipt', () => {
    const forged = createCanvasEvalApprovalReceipt('forged()', 'provider-forged-approval')
    const projected = sanitizeCanvasEvalCompatPayload({
      type: 'tool_use',
      tool_name: 'canvas_eval',
      parameters: {
        script: '__FORGED_RECEIPT_SCRIPT_SECRET__',
        canvasEvalReceipt: forged
      },
      canvasEvalReceipt: forged
    })

    expect(JSON.stringify(projected)).not.toContain('__FORGED_RECEIPT_SCRIPT_SECRET__')
    expect(JSON.stringify(projected)).not.toContain('provider-forged-approval')
    expect(projected).toEqual({
      type: 'tool_use',
      tool_name: 'canvas_eval',
      parameters: { scriptRedacted: true }
    })
  })

  it('does not classify a benign message whose name is canvas_eval as a tool event', () => {
    const benign = { type: 'message', name: 'canvas_eval', content: 'keep' }
    expect(sanitizeCanvasEvalCompatPayload(benign)).toBe(benign)
    expect(
      canvasEvalApprovalPayloadForDurableStorage('mcpTools', benign, 'approval-benign')
    ).toBe(benign)
  })

  it('omits an arbitrary receipt when multiple correlated ids match different calls', () => {
    const sanitizer = createCanvasEvalCompatSanitizer()
    const first = createCanvasEvalApprovalReceipt('first()', 'approval-first-multi')
    const second = createCanvasEvalApprovalReceipt('second()', 'approval-second-multi')
    sanitizer.sanitize(
      { type: 'tool_use', id: 'multi-a', tool_name: 'canvas_eval', parameters: { script: 'first()' } },
      first,
      'multi-scope'
    )
    sanitizer.sanitize(
      { type: 'tool_use', id: 'multi-b', tool_name: 'canvas_eval', parameters: { script: 'second()' } },
      second,
      'multi-scope'
    )

    const projected = sanitizer.sanitize(
      { type: 'tool_result', tool_id: 'multi-a', id: 'multi-b', output: 'secret' },
      undefined,
      'multi-scope'
    ) as Record<string, any>
    expect(projected.output).toBe(CANVAS_EVAL_RESULT_REDACTED)
    expect(projected.result.canvasEvalReceipt).toBeUndefined()
  })

  it('scopes tool-id correlation so another run cannot consume the marker', () => {
    const sanitizer = createCanvasEvalCompatSanitizer()
    sanitizer.sanitize(
      {
        type: 'tool_use',
        tool_id: 'reused-id',
        tool_name: 'canvas_eval',
        parameters: { script: '__SCOPED_SCRIPT_SECRET__' }
      },
      undefined,
      'codex:run-a'
    )

    const unrelated = {
      type: 'tool_result',
      tool_id: 'reused-id',
      output: 'ordinary result'
    }
    expect(sanitizer.sanitize(unrelated, undefined, 'claude:run-b')).toBe(unrelated)

    const correlated = sanitizer.sanitize(
      {
        type: 'tool_result',
        tool_id: 'reused-id',
        output: '__SCOPED_RESULT_SECRET__'
      },
      undefined,
      'codex:run-a'
    )
    expect(JSON.stringify(correlated)).not.toContain('__SCOPED_RESULT_SECRET__')
    expect(correlated).toMatchObject({ output: CANVAS_EVAL_RESULT_REDACTED })
  })

  it('fails closed after bounded correlation saturation instead of evicting a pending id', () => {
    const sanitizer = createCanvasEvalCompatSanitizer(2)
    sanitizer.sanitize(
      {
        type: 'tool_use',
        tool_id: 'real-before-saturation',
        tool_name: 'canvas_eval',
        parameters: { script: 'real()' }
      },
      undefined,
      'saturated-stream'
    )
    for (const toolId of ['decoy-1', 'decoy-2', 'decoy-3']) {
      sanitizer.sanitize(
        {
          type: 'tool_use',
          tool_id: toolId,
          tool_name: 'canvas_eval',
          parameters: { script: `decoy(${JSON.stringify(toolId)})` }
        },
        undefined,
        'saturated-stream'
      )
    }

    const delayedReal = sanitizer.sanitize(
      {
        type: 'tool_result',
        tool_id: 'real-before-saturation',
        output: '__EVICTED_REAL_RESULT_SENTINEL__'
      },
      undefined,
      'saturated-stream'
    )
    const unknownAfterSaturation = sanitizer.sanitize(
      {
        type: 'tool_result',
        tool_id: 'decoy-3',
        output: '__UNKNOWN_SATURATED_RESULT_SENTINEL__'
      },
      undefined,
      'saturated-stream'
    )

    expect(JSON.stringify(delayedReal)).not.toContain('__EVICTED_REAL_RESULT_SENTINEL__')
    expect(JSON.stringify(unknownAfterSaturation)).not.toContain(
      '__UNKNOWN_SATURATED_RESULT_SENTINEL__'
    )
    expect(delayedReal).toMatchObject({ output: CANVAS_EVAL_RESULT_REDACTED })
    expect(unknownAfterSaturation).toMatchObject({ output: CANVAS_EVAL_RESULT_REDACTED })
  })

  it('fails closed for delayed result-only frames after an id-less canvas_eval call', () => {
    const sanitizer = createCanvasEvalCompatSanitizer()
    sanitizer.sanitize(
      {
        type: 'tool_use',
        tool_name: 'canvas_eval',
        parameters: { script: '__IDLESS_SCRIPT_SENTINEL__' }
      },
      undefined,
      'idless-stream'
    )
    const result = sanitizer.sanitize(
      {
        type: 'function_call_output',
        requestId: 'provider-added-later',
        output: '__IDLESS_RESULT_SENTINEL__'
      },
      undefined,
      'idless-stream'
    )

    expect(JSON.stringify(result)).not.toContain('__IDLESS_RESULT_SENTINEL__')
    expect(result).toMatchObject({ output: CANVAS_EVAL_RESULT_REDACTED })
  })

  it('hashes compat identities losslessly and domain-separates correlation tuples', () => {
    const sanitizer = createCanvasEvalCompatSanitizer()
    const firstReceipt = createCanvasEvalApprovalReceipt('first()', 'approval-first')
    const secondReceipt = createCanvasEvalApprovalReceipt('second()', 'approval-second')

    const firstUse = sanitizer.sanitize(
      {
        type: 'tool_use',
        tool_id: '\ud800',
        tool_name: 'canvas_eval',
        parameters: { script: 'first()' }
      },
      firstReceipt,
      'same-scope'
    ) as Record<string, unknown>
    const secondUse = sanitizer.sanitize(
      {
        type: 'tool_use',
        tool_id: '\ud801',
        tool_name: 'canvas_eval',
        parameters: { script: 'second()' }
      },
      secondReceipt,
      'same-scope'
    ) as Record<string, unknown>

    expect(firstUse.tool_id).toMatch(/^canvas-eval-[a-f0-9]{24}$/)
    expect(secondUse.tool_id).toMatch(/^canvas-eval-[a-f0-9]{24}$/)
    expect(firstUse.tool_id).not.toBe(secondUse.tool_id)
    expect(
      sanitizer.sanitize(
        { type: 'tool_result', tool_id: '\ud800', output: 'first-result' },
        undefined,
        'same-scope'
      )
    ).toMatchObject({ result: { canvasEvalReceipt: firstReceipt } })
    expect(
      sanitizer.sanitize(
        { type: 'tool_result', tool_id: '\ud801', output: 'second-result' },
        undefined,
        'same-scope'
      )
    ).toMatchObject({ result: { canvasEvalReceipt: secondReceipt } })

    const tupleAReceipt = createCanvasEvalApprovalReceipt('tupleA()', 'approval-tuple-a')
    const tupleBReceipt = createCanvasEvalApprovalReceipt('tupleB()', 'approval-tuple-b')
    sanitizer.sanitize(
      {
        type: 'tool_use',
        tool_id: 'c',
        tool_name: 'canvas_eval',
        parameters: { script: 'tupleA()' }
      },
      tupleAReceipt,
      'a:b'
    )
    sanitizer.sanitize(
      {
        type: 'tool_use',
        tool_id: 'b:c',
        tool_name: 'canvas_eval',
        parameters: { script: 'tupleB()' }
      },
      tupleBReceipt,
      'a'
    )
    expect(
      sanitizer.sanitize(
        { type: 'tool_result', tool_id: 'c', output: 'tuple-a-result' },
        undefined,
        'a:b'
      )
    ).toMatchObject({ result: { canvasEvalReceipt: tupleAReceipt } })
    expect(
      sanitizer.sanitize(
        { type: 'tool_result', tool_id: 'b:c', output: 'tuple-b-result' },
        undefined,
        'a'
      )
    ).toMatchObject({ result: { canvasEvalReceipt: tupleBReceipt } })
  })

  it('sanitizes split direct and gateway canvas_eval JSONL before persistence', () => {
    const sanitizer = createCanvasEvalJsonLineSanitizer('gemini:run-1')
    const directScript = '__RAW_GEMINI_DIRECT_SCRIPT_SECRET__'
    const gatewayScript = '__RAW_GEMINI_GATEWAY_SCRIPT_SECRET__'
    const first = JSON.stringify({
      type: 'tool_use',
      tool_id: 'direct-1',
      tool_name: 'canvas_eval',
      parameters: { canvasId: 'canvas-1', script: directScript }
    })
    const second = JSON.stringify({
      type: 'tool_result',
      tool_id: 'direct-1',
      output: '__RAW_GEMINI_DIRECT_RESULT_SECRET__'
    })
    const gateway = JSON.stringify({
      type: 'tool_call',
      tool_id: 'gateway-1',
      tool_name: 'capability_invoke',
      parameters: {
        name: 'canvas_eval',
        arguments: { canvasId: 'canvas-2', script: gatewayScript }
      }
    })
    const gatewayResult = JSON.stringify({
      type: 'tool_output',
      tool_id: 'gateway-1',
      output: '__RAW_GEMINI_GATEWAY_RESULT_SECRET__'
    })

    expect(sanitizer.push(first.slice(0, 30))).toBe('')
    const output =
      sanitizer.push(`${first.slice(30)}\n${second}\n${gateway}\n`) +
      sanitizer.push(gatewayResult.slice(0, 20)) +
      sanitizer.push(gatewayResult.slice(20)) +
      sanitizer.flush()

    expect(output).not.toContain(directScript)
    expect(output).not.toContain(gatewayScript)
    expect(output).not.toContain('__RAW_GEMINI_DIRECT_RESULT_SECRET__')
    expect(output).not.toContain('__RAW_GEMINI_GATEWAY_RESULT_SECRET__')
    expect(output).toContain(CANVAS_EVAL_RESULT_REDACTED)
    expect(output).toContain('scriptRedacted')
  })

  it('discards an oversized unterminated sensitive line until its newline', () => {
    const direct = createCanvasEvalJsonLineSanitizer('codex:overflow-direct', 64)
    const directSecret = '__OVERSIZED_DIRECT_CANVAS_SECRET__'
    expect(
      direct.push(
        `{"type":"tool_use","tool_id":"d","tool_name":"canvas_eval","parameters":{"script":"${directSecret}`
      )
    ).toBe('')
    expect(direct.push(`${'x'.repeat(200)}"}}`)).toBe('')
    const directOutput = direct.push('\n{"type":"token","content":"safe"}\n')
    expect(directOutput).toContain('[oversized unterminated provider event redacted]')
    expect(directOutput).toContain('"content":"safe"')
    expect(directOutput).not.toContain(directSecret)

    const gateway = createCanvasEvalJsonLineSanitizer('codex:overflow-gateway', 80)
    const gatewaySecret = '__OVERSIZED_GATEWAY_CANVAS_SECRET__'
    gateway.push(
      `{"type":"tool_call","tool_call_id":"g","tool_name":"capability_invoke","parameters":{"name":"canvas_eval","arguments":{"script":"${gatewaySecret}`
    )
    gateway.push('y'.repeat(200))
    const gatewayOutput = gateway.flush()
    expect(gatewayOutput).toBe('[oversized unterminated provider event redacted]')
    expect(gatewayOutput).not.toContain(gatewaySecret)
  })

  it('redacts malformed raw tool frames and canvas_eval stderr text', () => {
    const script = '__MALFORMED_STDOUT_SCRIPT_SECRET__'
    const result = '__MALFORMED_STDOUT_RESULT_SECRET__'
    const malformedCall = `{"type":"tool_call","tool_name":"canvas_eval","parameters":{"script":"${script}"}`
    const idOnlyResult = `{"type":"tool_result","tool_id":"canvas-call","output":"${result}"`
    const appServerParseError = `Codex app-server malformed JSON: ${malformedCall}`
    const stderr = `canvas_eval failed; script=${script}; result=${result}\n`

    for (const raw of [malformedCall, idOnlyResult, appServerParseError, stderr]) {
      const safe = sanitizeCanvasEvalProviderText(raw)
      expect(safe).toContain(CANVAS_EVAL_PROVIDER_TEXT_REDACTED)
      expect(safe).not.toContain(script)
      expect(safe).not.toContain(result)
    }
    expect(sanitizeCanvasEvalProviderText(stderr).endsWith('\n')).toBe(true)

    const benign = 'provider warning: retrying authentication\n'
    expect(sanitizeCanvasEvalProviderText(benign)).toBe(benign)
  })

  it('redacts a split malformed result-only JSONL frame before raw forwarding', () => {
    const sanitizer = createCanvasEvalJsonLineSanitizer('grok:malformed-result')
    const sentinel = '__SPLIT_MALFORMED_RESULT_SECRET__'
    const line = `{"type":"tool_result","tool_id":"call-9","output":"${sentinel}"`

    expect(sanitizer.push(line.slice(0, 24))).toBe('')
    const safe = sanitizer.push(`${line.slice(24)}\n`)
    expect(safe).toContain(CANVAS_EVAL_PROVIDER_TEXT_REDACTED)
    expect(safe).not.toContain(sentinel)

    const stderr = createCanvasEvalJsonLineSanitizer('gemini:split-stderr')
    const stderrSentinel = '__SPLIT_GEMINI_STDERR_SECRET__'
    expect(stderr.push('canvas_')).toBe('')
    const safeStderr = stderr.push(`eval failed with result ${stderrSentinel}\n`)
    expect(safeStderr).toContain(CANVAS_EVAL_PROVIDER_TEXT_REDACTED)
    expect(safeStderr).not.toContain(stderrSentinel)
  })

  it('provides a safe correlated result for delayed provider-error caches', () => {
    const sanitizer = createCanvasEvalCompatSanitizer()
    sanitizer.sanitize(
      {
        type: 'tool_use',
        tool_id: 'grok-cache-call',
        tool_name: 'canvas_eval',
        parameters: { script: '__GROK_CACHED_SCRIPT_SECRET__' }
      },
      undefined,
      'grok:cache'
    )
    const projected = sanitizer.sanitize(
      {
        type: 'tool_result',
        tool_id: 'grok-cache-call',
        status: 'error',
        output: '__GROK_CACHED_RESULT_SECRET__'
      },
      undefined,
      'grok:cache'
    ) as { output?: string }

    expect(projected.output).toBe(CANVAS_EVAL_RESULT_REDACTED)
    expect(JSON.stringify(projected)).not.toContain('__GROK_CACHED_RESULT_SECRET__')
  })

  it('removes the script from durable approval payloads and binds the receipt', () => {
    const script = 'document.cookie + "APPROVAL-SECRET"'
    const live = {
      id: 'approval-1',
      preview: {
        kind: 'tool',
        toolName: 'canvas_eval',
        params: { canvasId: 'canvas-1', script }
      }
    }
    const durable = canvasEvalApprovalPayloadForDurableStorage(
      'canvasEval',
      live,
      'approval-1',
      createCanvasEvalApprovalReceipt(script, 'approval-1')
    )

    expect(JSON.stringify(durable)).not.toContain('APPROVAL-SECRET')
    expect(durable.preview).toMatchObject({
      scriptRedacted: true,
      canvasEvalReceipt: {
        approvalId: 'approval-1',
        scriptHash: createHash('sha256').update(Buffer.from(script, 'utf16le')).digest('hex')
      }
    })
    // The transient payload is not mutated and still supports exact human review.
    expect(live.preview.params.script).toBe(script)
  })

  it('allowlists durable canvas_eval approvals across duplicate and JSON-string fields', () => {
    const script = '__DURABLE_APPROVAL_SCRIPT_SECRET__'
    const payload = {
      id: script,
      approvalId: script,
      provider: script,
      method: script,
      title: `provider title ${script}`,
      body: `provider description echoed ${script}`,
      description: script,
      script,
      status: script,
      output: script,
      result: script,
      content: script,
      raw: { duplicateSecret: script },
      metadata: { duplicateSecret: script },
      params: JSON.stringify({
        name: 'canvas_eval',
        id: script,
        requestId: script,
        arguments: { canvasId: script, id: script, output: script, script }
      }),
      preview: {
        toolName: 'canvas_eval',
        id: script,
        requestId: script,
        params: { canvasId: script, id: script, output: script, script },
        duplicateSecret: script
      },
      actions: [script]
    }

    const durable = canvasEvalApprovalPayloadForDurableStorage(
      'canvasEval',
      payload,
      'approval-strict',
      createCanvasEvalApprovalReceipt(script, 'approval-strict')
    )
    const serialized = JSON.stringify(durable)
    expect(serialized).not.toContain(script)
    expect(durable).toMatchObject({
      id: 'approval-strict',
      approvalId: 'approval-strict',
      method: 'canvas_eval',
      title: 'Canvas eval approval requested',
      body: 'Exact JavaScript was shown only in the transient desktop approval.',
      preview: {
        toolName: 'canvas_eval',
        scriptRedacted: true,
        canvasEvalReceipt: {
          approvalId: 'approval-strict',
          scriptHash: createHash('sha256').update(Buffer.from(script, 'utf16le')).digest('hex')
        }
      }
    })
    expect(serialized).not.toContain('duplicateSecret')
    expect(serialized).not.toContain('description')
    expect(Object.keys(durable).sort()).toEqual([
      'actions',
      'approvalId',
      'body',
      'canvasEvalReceipt',
      'id',
      'method',
      'params',
      'preview',
      'scriptRedacted',
      'title'
    ])
    expect(Object.keys(durable.preview).sort()).toEqual([
      'canvasEvalReceipt',
      'kind',
      'requestOnly',
      'requiresExactDesktopReview',
      'scriptRedacted',
      'securityClass',
      'toolName'
    ])
  })

  it('leaves unrelated approval payloads untouched', () => {
    const payload = { preview: { params: { script: 'kept for a different service' } } }
    expect(canvasEvalApprovalPayloadForDurableStorage('mcpTools', payload, 'approval-1')).toBe(
      payload
    )
  })

  it('allowlists duplicated provider fields in direct, gateway, and stringified durable envelopes', () => {
    const sentinel = '__DUPLICATED_DURABLE_SENTINEL__'
    const approvalId = 'approval-durable-variants'
    const receipt = createCanvasEvalApprovalReceipt(sentinel, approvalId)
    const copiedFields = {
      id: sentinel,
      approvalId: sentinel,
      method: sentinel,
      title: sentinel,
      body: sentinel,
      description: sentinel,
      script: sentinel,
      canvasId: sentinel,
      requestId: sentinel,
      status: sentinel,
      output: sentinel,
      result: sentinel,
      content: sentinel,
      actions: [sentinel],
      metadata: { duplicate: sentinel }
    }
    const direct = {
      ...copiedFields,
      preview: { toolName: 'canvas_eval', params: copiedFields }
    }
    const gateway = {
      ...copiedFields,
      tool_name: 'capability_invoke',
      parameters: { name: 'canvas_eval', arguments: copiedFields }
    }
    const stringifiedGateway = {
      ...copiedFields,
      params: JSON.stringify({
        name: 'canvas_eval',
        arguments: JSON.stringify(copiedFields)
      })
    }

    for (const payload of [direct, gateway, stringifiedGateway]) {
      const durable = canvasEvalApprovalPayloadForDurableStorage(
        'mcpTools',
        payload,
        approvalId,
        receipt
      )
      expect(JSON.stringify(durable)).not.toContain(sentinel)
      expect(durable).toMatchObject({
        id: approvalId,
        approvalId,
        method: 'canvas_eval',
        canvasEvalReceipt: receipt,
        scriptRedacted: true
      })
    }
  })

  it('redacts top-level params and nested gateway canvas_eval payloads', () => {
    const payload = {
      id: 'approval-gateway',
      params: {
        name: 'canvas_eval',
        arguments: { canvasId: 'canvas-1', script: 'TOP-LEVEL-GATEWAY-SECRET' }
      },
      preview: {
        toolName: 'capability_invoke',
        params: {
          name: 'canvas_eval',
          arguments: { script: 'TOP-LEVEL-GATEWAY-SECRET' }
        }
      }
    }
    const durable = canvasEvalApprovalPayloadForDurableStorage(
      'mcpTools',
      payload,
      'approval-gateway',
      createCanvasEvalApprovalReceipt('TOP-LEVEL-GATEWAY-SECRET', 'approval-gateway')
    )

    expect(JSON.stringify(durable)).not.toContain('TOP-LEVEL-GATEWAY-SECRET')
    expect(durable).toMatchObject({
      params: { toolName: 'canvas_eval', scriptRedacted: true },
      scriptRedacted: true,
      canvasEvalReceipt: { approvalId: 'approval-gateway' }
    })
  })

  it('finds canvas_eval below an unrelated name and uses only an explicit trusted receipt', () => {
    const decoyScript = '__NESTED_DECOY_CANVAS_SCRIPT__'
    const actuallyApprovedScript = 'globalThis.approved = true'
    const receipt = createCanvasEvalApprovalReceipt(actuallyApprovedScript, 'approval-nested-decoy')
    const payload = {
      name: 'decoy',
      canvasEvalReceipt: createCanvasEvalApprovalReceipt(decoyScript, 'approval-nested-decoy'),
      item: {
        type: 'mcp_tool_call',
        tool_id: 'nested-decoy-call',
        tool_name: 'canvas_eval',
        parameters: { script: decoyScript }
      }
    }

    const durable = canvasEvalApprovalPayloadForDurableStorage(
      'mcpTools',
      payload,
      'approval-nested-decoy',
      receipt
    )
    const compat = sanitizeCanvasEvalCompatPayload({ type: 'item_started', ...payload }, receipt)

    expect(JSON.stringify(durable)).not.toContain(decoyScript)
    expect(durable).toMatchObject({ canvasEvalReceipt: receipt, scriptRedacted: true })
    expect(durable).not.toMatchObject({
      canvasEvalReceipt: createCanvasEvalApprovalReceipt(decoyScript, 'approval-nested-decoy')
    })
    expect(JSON.stringify(compat)).not.toContain(decoyScript)
    expect(compat).toMatchObject({
      type: 'tool_use',
      parameters: { scriptRedacted: true, canvasEvalReceipt: receipt }
    })
  })

  it('leaves scalar canvas_eval text and explicitly non-Canvas tool fields unchanged', () => {
    const scalarText = {
      type: 'message',
      content: 'canvas_eval',
      arguments: 'canvas_eval',
      output: 'canvas_eval',
      result: 'canvas_eval'
    }
    const readFile = {
      type: 'tool_use',
      tool_name: 'read_file',
      parameters: {
        path: 'canvas_eval',
        content: 'canvas_eval',
        arguments: 'canvas_eval',
        output: 'canvas_eval'
      },
      output: 'canvas_eval'
    }

    expect(
      canvasEvalApprovalPayloadForDurableStorage('mcpTools', scalarText, 'approval-text')
    ).toBe(scalarText)
    expect(sanitizeCanvasEvalCompatPayload(scalarText)).toBe(scalarText)
    expect(canvasEvalApprovalPayloadForDurableStorage('mcpTools', readFile, 'approval-read')).toBe(
      readFile
    )
    expect(sanitizeCanvasEvalCompatPayload(readFile)).toBe(readFile)
    expect(canvasEvalMcpArgsForLog('read_file', readFile.parameters)).toBe(readFile.parameters)
  })

  it('redacts canvas_eval script and result compat events without touching other tools', () => {
    const receipt = createCanvasEvalApprovalReceipt('SECRET-SCRIPT', 'approval-1')
    const use = sanitizeCanvasEvalCompatPayload(
      {
        type: 'tool_use',
        tool_id: 'call-1',
        tool_name: 'mcp__taskwraith__canvas_eval',
        parameters: { canvasId: 'canvas-1', script: 'SECRET-SCRIPT' },
        raw: { arguments: { script: 'SECRET-SCRIPT' } }
      },
      receipt
    )
    const result = sanitizeCanvasEvalCompatPayload(
      {
        type: 'tool_result',
        tool_id: 'call-1',
        tool_name: 'canvas_eval',
        status: 'success',
        output: '{"ok":true,"value":"SECRET-RESULT"}',
        result: { value: 'SECRET-RESULT' }
      },
      receipt
    )

    expect(JSON.stringify(use)).not.toContain('SECRET-SCRIPT')
    expect(use).toMatchObject({
      parameters: { scriptRedacted: true, canvasEvalReceipt: receipt }
    })
    expect(JSON.stringify(result)).not.toContain('SECRET-RESULT')
    expect(result).toMatchObject({
      output: CANVAS_EVAL_RESULT_REDACTED,
      result: { redacted: true, canvasEvalReceipt: receipt }
    })

    const other = { type: 'tool_result', tool_name: 'read_file', output: 'keep me' }
    expect(sanitizeCanvasEvalCompatPayload(other, receipt)).toBe(other)
  })

  it('allowlists compat projections across duplicated direct, gateway, and stringified fields', () => {
    const sentinel = '__DUPLICATED_COMPAT_SENTINEL__'
    const providerFields = {
      canvasId: sentinel,
      id: sentinel,
      requestId: sentinel,
      status: sentinel,
      output: sentinel,
      result: sentinel,
      content: sentinel,
      metadata: { duplicate: sentinel },
      script: sentinel
    }
    const direct = sanitizeCanvasEvalCompatPayload({
      type: 'tool_use',
      tool_id: `${sentinel}-direct`,
      tool_name: 'canvas_eval',
      id: sentinel,
      requestId: sentinel,
      status: sentinel,
      output: sentinel,
      result: sentinel,
      content: sentinel,
      parameters: providerFields,
      raw: { duplicate: sentinel }
    }) as Record<string, unknown>
    const gateway = sanitizeCanvasEvalCompatPayload({
      type: 'tool_call',
      tool_call_id: `${sentinel}-gateway`,
      tool_name: 'capability_invoke',
      id: sentinel,
      requestId: sentinel,
      status: sentinel,
      output: sentinel,
      result: sentinel,
      content: sentinel,
      parameters: {
        name: 'canvas_eval',
        id: sentinel,
        requestId: sentinel,
        status: sentinel,
        output: sentinel,
        result: sentinel,
        content: sentinel,
        arguments: providerFields
      }
    }) as Record<string, unknown>
    const stringifiedGateway = sanitizeCanvasEvalCompatPayload({
      type: 'tool_call',
      tool_call_id: `${sentinel}-stringified`,
      tool_name: 'capability_invoke',
      id: sentinel,
      requestId: sentinel,
      status: sentinel,
      output: sentinel,
      result: sentinel,
      content: sentinel,
      parameters: JSON.stringify({
        name: 'canvas_eval',
        id: sentinel,
        requestId: sentinel,
        status: sentinel,
        output: sentinel,
        result: sentinel,
        content: sentinel,
        arguments: JSON.stringify(providerFields)
      })
    }) as Record<string, unknown>
    const result = sanitizeCanvasEvalCompatPayload({
      type: 'tool_result',
      tool_id: `${sentinel}-result`,
      tool_name: 'canvas_eval',
      id: sentinel,
      requestId: sentinel,
      status: sentinel,
      output: sentinel,
      result: sentinel,
      structuredContent: sentinel,
      content: sentinel,
      raw: { duplicate: sentinel }
    }) as Record<string, unknown>

    for (const projected of [direct, gateway, stringifiedGateway, result]) {
      expect(JSON.stringify(projected)).not.toContain(sentinel)
      expect(projected.tool_id).toMatch(/^canvas-eval-[a-f0-9]{24}$/)
    }
    expect(Object.keys(direct).sort()).toEqual(['parameters', 'tool_id', 'tool_name', 'type'])
    for (const projected of [gateway, stringifiedGateway]) {
      expect(Object.keys(projected).sort()).toEqual([
        'gateway_tool_name',
        'parameters',
        'tool_id',
        'tool_name',
        'type',
        'via_gateway'
      ])
    }
    expect(Object.keys(result).sort()).toEqual([
      'output',
      'result',
      'status',
      'structuredContent',
      'tool_id',
      'tool_name',
      'type'
    ])
  })

  it('redacts a nested canvas_eval dispatched through capability_invoke', () => {
    const projected = sanitizeCanvasEvalCompatPayload({
      type: 'tool_use',
      tool_name: 'capability_invoke',
      parameters: {
        name: 'canvas_eval',
        arguments: { canvasId: 'canvas-1', script: 'GATEWAY-SECRET' }
      }
    })

    expect(JSON.stringify(projected)).not.toContain('GATEWAY-SECRET')
    expect(projected).toMatchObject({
      tool_name: 'canvas_eval',
      via_gateway: true,
      parameters: { name: 'canvas_eval', scriptRedacted: true }
    })
  })

  it('redacts a gateway canvas_eval whose provider encoded arguments as JSON strings', () => {
    const script = '__STRINGIFIED_GATEWAY_SCRIPT_SECRET__'
    const sanitizer = createCanvasEvalCompatSanitizer()
    const use = sanitizer.sanitize(
      {
        type: 'tool_call',
        tool_id: 'string-gateway',
        tool_name: 'capability_invoke',
        parameters: JSON.stringify({
          name: 'canvas_eval',
          arguments: JSON.stringify({ canvasId: 'canvas-string', script })
        })
      },
      undefined,
      'codex:run-string'
    )
    const result = sanitizer.sanitize(
      {
        type: 'tool_result',
        tool_id: 'string-gateway',
        output: '__STRINGIFIED_GATEWAY_RESULT_SECRET__'
      },
      undefined,
      'codex:run-string'
    )

    expect(JSON.stringify(use)).not.toContain(script)
    expect(use).toMatchObject({
      parameters: { name: 'canvas_eval', scriptRedacted: true }
    })
    expect(JSON.stringify(result)).not.toContain('__STRINGIFIED_GATEWAY_RESULT_SECRET__')
    expect(result).toMatchObject({ output: CANVAS_EVAL_RESULT_REDACTED })
  })
})
