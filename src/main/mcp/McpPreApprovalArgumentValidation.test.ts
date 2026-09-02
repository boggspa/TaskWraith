import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createTaskWraithMcpToolDefinitions } from '../McpToolCatalog'
import { validateMcpToolArgumentsBeforeApproval } from './McpPreApprovalArgumentValidation'

const definitions = createTaskWraithMcpToolDefinitions()

describe('validateMcpToolArgumentsBeforeApproval', () => {
  it('rejects an empty Boss control call with an actionable example', () => {
    const result = validateMcpToolArgumentsBeforeApproval(
      'ensemble_bossman_control',
      {},
      definitions
    )

    expect(result).toMatchObject({
      ok: false,
      code: 'invalid_arguments',
      issues: [{ path: '#/action', keyword: 'required' }]
    })
    if (result.ok) return
    expect(result.message).toContain('before approval')
    expect(result.message).toContain('"action":"set_round_plan","planSummary":"Review."')
    expect(result.message).toContain('Do not retry the same invalid invocation')
  })

  it('rejects an empty portable Boss control call with the same actionable example', () => {
    const result = validateMcpToolArgumentsBeforeApproval('ensemble_control', {}, definitions)

    expect(result).toMatchObject({
      ok: false,
      code: 'invalid_arguments',
      issues: [{ path: '#/action', keyword: 'required' }]
    })
    if (result.ok) return
    expect(result.message).toContain('before approval')
    expect(result.message).toContain('"action":"set_round_plan","planSummary":"Review."')
    expect(result.message).toContain('Do not retry the same invalid invocation')
  })

  it('rejects an unknown Boss action before approval', () => {
    expect(
      validateMcpToolArgumentsBeforeApproval(
        'ensemble_bossman_control',
        { action: 'not_a_real_action' },
        definitions
      )
    ).toMatchObject({
      ok: false,
      code: 'invalid_arguments',
      issues: [{ path: '#/action', keyword: 'enum' }]
    })
  })

  it('accepts a valid populated Boss round-plan call', () => {
    expect(
      validateMcpToolArgumentsBeforeApproval(
        'ensemble_bossman_control',
        { action: 'set_round_plan', planSummary: 'Review the current task.' },
        definitions
      )
    ).toEqual({ ok: true })
  })

  it('accepts a valid populated portable Boss round-plan call', () => {
    expect(
      validateMcpToolArgumentsBeforeApproval(
        'ensemble_control',
        { action: 'set_round_plan', params: { planSummary: 'Review the current task.' } },
        definitions
      )
    ).toEqual({ ok: true })
  })

  it('rejects malformed emulator stepping before approval and accepts the bounded shared shape', () => {
    const malformed = validateMcpToolArgumentsBeforeApproval(
      'emulator_step',
      {
        canvasId: 'canvas-1',
        expectedObservationId: 'eobs:canvas-1:1',
        segments: [{ buttons: ['left', 'right'], frames: 1 }]
      },
      definitions
    )
    expect(malformed).toMatchObject({ ok: false, code: 'invalid_arguments' })
    if (!malformed.ok) expect(malformed.message).toContain('before approval')

    expect(
      validateMcpToolArgumentsBeforeApproval(
        'emulator_step',
        {
          canvasId: 'canvas-1',
          expectedObservationId: 'eobs:canvas-1:1',
          segments: [{ buttons: ['right'], frames: 2 }],
          requireIndependentVerifier: true
        },
        definitions
      )
    ).toEqual({ ok: true })
  })

  it('rejects emulator open overrides and malformed observation requests before prompting', () => {
    expect(
      validateMcpToolArgumentsBeforeApproval(
        'emulator_open',
        { url: 'https://example.test' },
        definitions
      )
    ).toMatchObject({ ok: false, code: 'invalid_arguments' })
    expect(
      validateMcpToolArgumentsBeforeApproval('emulator_open', { gameId: 'other' }, definitions)
    ).toMatchObject({ ok: false, code: 'invalid_arguments' })
    expect(
      validateMcpToolArgumentsBeforeApproval('emulator_observe', {}, definitions)
    ).toMatchObject({ ok: false, code: 'invalid_arguments' })
    expect(
      validateMcpToolArgumentsBeforeApproval(
        'emulator_observe',
        { canvasId: 'canvas-1', includeRawRam: true },
        definitions
      )
    ).toMatchObject({ ok: false, code: 'invalid_arguments' })
    expect(
      validateMcpToolArgumentsBeforeApproval(
        'emulator_observe',
        { canvasId: 'canvas\n1' },
        definitions
      )
    ).toMatchObject({ ok: false, code: 'invalid_arguments' })
  })

  it('does not impose new schema enforcement on compatibility-heavy direct tools', () => {
    expect(validateMcpToolArgumentsBeforeApproval('read_file', {}, definitions)).toEqual({
      ok: true
    })
  })
})

describe('pre-approval validation integration contracts', () => {
  const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

  it('rejects malformed Claude MCP arguments before either native approval decision', () => {
    const start = indexSource.indexOf('async function canUseClaudeSdkTool(')
    const end = indexSource.indexOf('\nasync function tryRunClaudeSdk(', start)
    const source = indexSource.slice(start, end)

    // Anchor inside the TaskWraith-MCP identity region rather than at the top of the
    // function. The WS-B provider-native branch sits above this and raises its own
    // approval card, which is correct: a BARE native tool (Read/Write/Bash) carries
    // no MCP schema to validate against, and that branch returns without ever
    // reaching the MCP path. Anchoring on the first approval anywhere in the
    // function fails on that legitimate ordering while proving nothing extra — what
    // this test exists to guarantee is that no TASKWRAITH MCP call reaches an
    // approval decision before its arguments have been validated.
    const mcpRegion = source.indexOf("approvalIdentity.kind === 'taskwraith-mcp'")
    const mcpSource = source.slice(mcpRegion)
    const preflight = mcpSource.indexOf('validateMcpToolArgumentsBeforeApproval(')

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(mcpRegion).toBeGreaterThanOrEqual(0)
    expect(preflight).toBeGreaterThanOrEqual(0)
    expect(preflight).toBeLessThan(mcpSource.indexOf('nativeProviderApprovalPriority('))
    expect(preflight).toBeLessThan(mcpSource.indexOf('requestAgenticServiceApproval('))
  })

  it('proves Claude raw identity conflicts and undeclared native tools deny before auto-allow', () => {
    const start = indexSource.indexOf('async function canUseClaudeSdkTool(')
    const end = indexSource.indexOf('\nasync function tryRunClaudeSdk(', start)
    const source = indexSource.slice(start, end)
    const normalize = source.indexOf('normalizeClaudeCanUseToolArgs(')
    const identity = source.indexOf('resolveClaudeToolApprovalIdentity(')
    const invalidReservedDeny = source.indexOf(
      "approvalIdentity.kind === 'invalid-taskwraith-mcp'"
    )
    const providerNativeDeny = source.indexOf("approvalIdentity.kind === 'provider-native'")
    const autoAllow = source.indexOf('isMcpAutoAllowedForRun(')

    expect(normalize).toBeGreaterThanOrEqual(0)
    expect(identity).toBeGreaterThan(normalize)
    expect(invalidReservedDeny).toBeGreaterThan(identity)
    expect(providerNativeDeny).toBeGreaterThan(invalidReservedDeny)
    expect(providerNativeDeny).toBeLessThan(autoAllow)
    expect(source).toContain('claudeAgenticServiceForTool(toolName, normalizedInput)')
    expect(source).not.toContain('canonicalTaskWraithToolName(unprefixedToolName)')
  })

  it('binds Claude canvas_eval approval to the canonical exact script and rechecks lifecycle after review', () => {
    const start = indexSource.indexOf('async function canUseClaudeSdkTool(')
    const end = indexSource.indexOf('\nasync function tryRunClaudeSdk(', start)
    const source = indexSource.slice(start, end)
    const canonicalPreview = source.indexOf(
      'const approvalPreview = claudeToolApprovalPreview(toolName, normalizedInput, service)'
    )
    const canonicalScript = source.indexOf(
      "typeof approvalPreview.params.script === 'string'"
    )
    const receipt = source.indexOf(
      'claudeCanvasEvalApproval = createCanvasEvalApprovalReceipt('
    )
    const receiptScript = source.indexOf('exactCanvasEvalScript,', receipt)
    const receiptApprovalId = source.indexOf('approvalId', receiptScript)
    const correlation = source.indexOf('primeNativeCanvasCompatCorrelation({', receipt)
    const request = source.indexOf('const allowed = await requestAgenticServiceApproval(')
    const postReviewRecheck = source.indexOf('if (!claudeRunAcceptsTools())', request)

    expect(canonicalPreview).toBeGreaterThanOrEqual(0)
    expect(canonicalScript).toBeGreaterThan(canonicalPreview)
    expect(receipt).toBeGreaterThan(canonicalScript)
    expect(receipt).toBeGreaterThan(request)
    expect(receiptScript).toBeGreaterThan(receipt)
    expect(receiptApprovalId).toBeGreaterThan(receiptScript)
    expect(correlation).toBeGreaterThan(receiptApprovalId)
    expect(postReviewRecheck).toBeGreaterThan(correlation)
    expect(source).toContain('runManager.getClaimedTerminalStatus(route.appRunId)')
    expect(source).toContain(
      'historyClearAdmissionBlocked(route.appRunId, payload.workspace, route.appChatId)'
    )
  })
})
