import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

describe('native Canvas approval integration contracts', () => {
  it('Kimi ACP uses the canonical MCP broker and projects native Canvas echoes safely', () => {
    const start = indexSource.indexOf('async function runKimiAcpProvider(')
    const end = indexSource.indexOf('\nasync function runKimiProvider(', start)
    const source = indexSource.slice(start, end)
    const compatStart = indexSource.indexOf('function sendAgentCompatLine(')
    const compatEnd = indexSource.indexOf('\nfunction sendAgentCompatError(', compatStart)
    const compatSource = indexSource.slice(compatStart, compatEnd)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(source).toContain('createKimiMcpDispatch({')
    expect(source).toContain('mcpBridgeRuntime.handleGeminiMcpBrokerRequest(request)')
    expect(source).toContain('onEvent: (evt) => applyKimiAcpRunEvent(state')
    expect(compatSource).toContain('nativeCanvasCompatSanitizer.sanitize(')
    expect(compatSource.indexOf('nativeCanvasCompatSanitizer.sanitize(')).toBeLessThan(
      compatSource.indexOf('appendDurableRunEventForRoute(')
    )
  })

  it('Codex derives its receipt and durable payload from canonical arguments and rejects late frames', () => {
    const start = indexSource.indexOf('function handleCodexServerRequest(message: any)')
    const end = indexSource.indexOf('\nasync function runApprovedHostCommand(', start)
    const source = indexSource.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(source).toContain(
      'createCanvasEvalApprovalReceiptFromCanonicalArgs(codexToolArgs, approvalId)'
    )
    expect(source).toContain(
      "params: gateService === 'canvasEval' ? codexToolArgs : params"
    )
    expect(source).toContain('historyClearAdmissionBlocked(state.appRunId, state.workspacePath)')
    expect(source).toContain('runManager.getClaimedTerminalStatus(state.appRunId)')
    expect(source.indexOf('historyClearAdmissionBlocked(')).toBeLessThan(
      source.indexOf('const approvalId =')
    )
  })

  it('primes result-only native eval correlation only with a host receipt and projected id', () => {
    const start = indexSource.indexOf('function primeNativeCanvasCompatCorrelation(')
    const end = indexSource.indexOf('\nconst runEventChatMetadataCache', start)
    const source = indexSource.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(source).toContain('nativeCanvasCompatSanitizer.projectedToolId(scope, ids)')
    expect(source).toContain(
      "canonical === 'canvas_eval' && projectedToolId && input.canvasEvalApproval"
    )
    expect(source).toContain('tool_id: projectedToolId')
  })

  it('ordinary run cancellation claims terminal authority before revoking approvals or awaiting transport', () => {
    const start = indexSource.indexOf('async function cancelProviderRun(')
    const end = indexSource.indexOf('\n// Phase M1 Step 2:', start)
    const cancelSource = indexSource.slice(start, end)
    const sessionBranch = cancelSource.indexOf('if (session) {')
    const source = cancelSource.slice(sessionBranch)
    const claim = source.indexOf("runManager.claimTerminalStatus(session.runId, 'cancelled')")
    const cancelApprovals = source.indexOf('approvalService?.cancelForRun(')
    const terminate = source.indexOf('return terminateExactProviderSession(')

    expect(sessionBranch).toBeGreaterThanOrEqual(0)
    expect(claim).toBeGreaterThanOrEqual(0)
    expect(cancelApprovals).toBeGreaterThan(claim)
    expect(terminate).toBeGreaterThan(cancelApprovals)
  })
})
