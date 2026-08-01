import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
const geminiApiSource = readFileSync(new URL('./GeminiApiProvider.ts', import.meta.url), 'utf8')

function between(start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

describe('one-shot provider transport history join', () => {
  it('keeps iOS bridge Pi prompts off generic MCP until the launch-time receipt', () => {
    const bridgeMcpResolution = between(
      'const bridgeClaudePinnedMcpReceipt =',
      'const bridgeTaskWraithMcpProfile ='
    )

    expect(bridgeMcpResolution).toContain("provider === 'pi'")
    expect(bridgeMcpResolution).toContain('? false')
    expect(bridgeMcpResolution).toContain("provider === 'grok'")
  })

  it('retains signed permission posture in Codex and Gemini run state', () => {
    const codexState = between(
      'function createCodexRunState(',
      '/** Register the exact Codex app-server turn completion'
    )
    const geminiState = between(
      'function installGeminiToolContextForRun(',
      'function resolveNativeVibrancy('
    )

    expect(codexState).toContain(
      'effectivePermissionsSignature: payload?.effectivePermissionsSignature'
    )
    expect(geminiState).toContain(
      'effectivePermissionsSignature: options.runPayload?.effectivePermissionsSignature'
    )
  })

  it('joins AntiGravity seat-summary cancellation to exact SDK terminal evidence', () => {
    const summary = between(
      'async function runAntigravityGeminiApiSeatSummary(',
      'async function runAntigravityProvider('
    )
    const began = summary.indexOf('maintenanceCompactionRegistry.beginNativeActivity(')
    const started = summary.indexOf('startAntigravityGeminiApiSeatSummary({', began)
    const result = summary.indexOf('return await operation.result', started)
    const terminal = summary.indexOf('await operation.terminal', result)
    const ended = summary.indexOf('maintenanceCompactionRegistry.endNativeActivity(', terminal)

    expect(began).toBeGreaterThanOrEqual(0)
    expect(began).toBeLessThan(started)
    expect(started).toBeLessThan(result)
    expect(result).toBeLessThan(terminal)
    expect(terminal).toBeLessThan(ended)
    expect(summary).toContain('cancellationSignal: input.reservation.signal')
    expect(summary).not.toContain('Promise.race(')
  })

  it('keeps Gemini CLI cancellation and history settlement behind exact child close', () => {
    const provider = between(
      'async function runGeminiProvider(',
      '/**\n * Combined-mode AntiGravity production dispatch.'
    )
    const authMaterialized = provider.indexOf('await ensureGeminiAuthProfileMaterialized(')
    const authorityRecheck = provider.indexOf(
      "providerTransportLaunchAuthorized('gemini', payload, route)",
      authMaterialized
    )
    const tracked = provider.indexOf('providerTransportOperations.track(')
    const spawned = provider.indexOf('child = spawn(', tracked)
    const exposed = provider.indexOf('runManager.attachProcess(', spawned)
    const projection = provider.indexOf('const projectGeminiCliClose =', exposed)
    const exitProjection = provider.indexOf("'gemini-exit'", projection)
    const close = provider.indexOf("child.on('close'", exitProjection)
    const projected = provider.indexOf('projectGeminiCliClose(code)', close)
    const finallyBlock = provider.indexOf('finally {', projected)
    const finished = provider.indexOf('runManager.finish(route.appRunId', finallyBlock)
    const confirmed = provider.indexOf('runManager.confirmTerminalStatus(', finallyBlock)
    const settled = provider.indexOf('transportClose.markTransportClosed()', finallyBlock)
    const error = provider.indexOf("child.on('error'", settled)
    const awaited = provider.lastIndexOf('await transportOperation')

    expect(authMaterialized).toBeGreaterThanOrEqual(0)
    expect(authMaterialized).toBeLessThan(authorityRecheck)
    expect(authorityRecheck).toBeLessThan(tracked)
    expect(tracked).toBeGreaterThanOrEqual(0)
    expect(tracked).toBeLessThan(spawned)
    expect(spawned).toBeLessThan(exposed)
    expect(exposed).toBeLessThan(projection)
    expect(projection).toBeLessThan(exitProjection)
    expect(exitProjection).toBeLessThan(close)
    expect(close).toBeLessThan(projected)
    expect(projected).toBeLessThan(finallyBlock)
    expect(finallyBlock).toBeLessThan(finished)
    expect(finished).toBeLessThan(confirmed)
    expect(confirmed).toBeLessThan(settled)
    expect(finallyBlock).toBeLessThan(settled)
    expect(settled).toBeLessThan(error)
    expect(error).toBeLessThan(awaited)
    expect(provider).toContain('providerProcessTerminationBackstop.clear(route.appRunId)')
    expect(provider.slice(error, awaited)).not.toContain('markTransportClosed()')
    expect(provider.slice(error, awaited)).not.toContain('runManager.finish(')
    expect(provider.slice(error, awaited)).not.toContain("'gemini-exit'")
    expect(provider.slice(error, awaited)).not.toContain('.flush()')
    expect(provider.slice(error, awaited)).not.toContain('clearInterval(')
    const synchronousSpawnFailure = provider.slice(
      provider.indexOf('} catch (error) {', spawned),
      exposed
    )
    expect(synchronousSpawnFailure).toContain('projectSynchronousGeminiSpawnFailure(error)')
    expect(
      synchronousSpawnFailure.indexOf('projectSynchronousGeminiSpawnFailure(error)')
    ).toBeLessThan(synchronousSpawnFailure.indexOf('transportClose.markTransportClosed()'))
    expect(provider).toContain("'gemini-output'")
    expect(provider).toContain("'gemini-error'")
    expect(provider).toContain("'gemini-exit'")
  })

  it('retains the shared starting owner until Gemini API SDK discovery succeeds', () => {
    const provider = geminiApiSource.slice(
      geminiApiSource.indexOf('export async function tryRunGeminiApi(')
    )
    const setupSignal = provider.indexOf('payload.providerSetupAbortSignal')
    const sdkDiscovery = provider.indexOf('const sdk = await')
    const sdkAvailable = provider.indexOf("typeof GoogleGenAI !== 'function'")
    const requestController = provider.indexOf(
      'const controller = new AbortController()',
      sdkAvailable
    )
    const attach = provider.indexOf('deps.runManager.attachAbortController(', requestController)

    expect(setupSignal).toBeGreaterThanOrEqual(0)
    expect(setupSignal).toBeLessThan(sdkDiscovery)
    expect(sdkDiscovery).toBeLessThan(sdkAvailable)
    expect(sdkAvailable).toBeLessThan(requestController)
    expect(requestController).toBeLessThan(attach)
    expect(provider.slice(setupSignal, sdkAvailable)).not.toContain(
      'deps.runManager.attachAbortController('
    )
    expect(geminiApiSource).toContain('function settleGeminiApiTerminal(')
    expect(geminiApiSource).toContain('input.deps.runManager.confirmTerminalStatus(')
  })

  it('keeps Codex exec fallback live through exact child close and terminal projection', () => {
    const provider = between(
      'async function runCodexExecFallback(',
      '/**\n * Other well-known codex install locations'
    )
    const resolved = provider.indexOf("resolveCliProviderBinary('codex'")
    const authorityRecheck = provider.indexOf(
      "providerTransportLaunchAuthorized('codex', payload, route)",
      resolved
    )
    const tracked = provider.indexOf('providerTransportOperations.track(')
    const registered = provider.indexOf('registerRunSession(', tracked)
    const spawned = provider.indexOf('child = spawn(', tracked)
    const exposed = provider.indexOf('runManager.attachProcess(', spawned)
    const close = provider.indexOf("child.on('close'", exposed)
    const settled = provider.indexOf('transportClose.markTransportClosed()', close)
    const error = provider.indexOf("child.on('error'", settled)
    const awaited = provider.indexOf('await transportOperation', error)

    expect(resolved).toBeGreaterThanOrEqual(0)
    expect(resolved).toBeLessThan(authorityRecheck)
    expect(authorityRecheck).toBeLessThan(tracked)
    expect(tracked).toBeLessThan(registered)
    expect(registered).toBeLessThan(spawned)
    expect(spawned).toBeLessThan(exposed)
    expect(exposed).toBeLessThan(close)
    expect(close).toBeLessThan(settled)
    expect(settled).toBeLessThan(error)
    expect(error).toBeLessThan(awaited)
    expect(provider.slice(error, awaited)).not.toContain('markTransportClosed()')
  })

  it('journals parsed Codex exec usage before projecting its terminal result', () => {
    const provider = between(
      'async function runCodexExecFallback(',
      '/**\n * Other well-known codex install locations'
    )
    const sanitizedUsage = provider.indexOf(
      'codexExecUsage = mergeCodexExecUsageJsonLines(codexExecUsage, text)'
    )
    const flushed = provider.indexOf('codexExecStdoutSanitizer.flush()')
    const persisted = provider.indexOf('recordCodexUsageOnCompletion({', flushed)
    const terminalResult = provider.indexOf("type: 'result'", persisted)

    expect(sanitizedUsage).toBeGreaterThanOrEqual(0)
    expect(flushed).toBeGreaterThan(sanitizedUsage)
    expect(persisted).toBeGreaterThan(flushed)
    expect(terminalResult).toBeGreaterThan(persisted)
    expect(provider).toContain('stats: terminalStats')
    expect(provider).toContain('if (!payload.ensembleRun)')
  })

  it('tracks Codex app-server before admission and awaits the exact terminal projection', () => {
    const provider = between(
      'async function runCodexAppServerWithClient(',
      'async function runCodexExecFallback('
    )
    const authorityRecheck = provider.indexOf(
      "providerTransportLaunchAuthorized('codex', payload, route)"
    )
    const tracked = provider.indexOf('trackCodexAppServerTurnOperation(codexState)')
    const exposed = provider.indexOf('registerRunSession(', tracked)
    const admitted = provider.indexOf("'turn/start'", exposed)
    const awaited = provider.lastIndexOf('await turnOperation')

    // A fresh run holds no admission reservation before thread/start, so the
    // last authority check must sit between the ensureStarted await and the
    // RPC that mints a provider-native thread (TW-SEC-2026-014).
    const ensureStarted = provider.indexOf('await client.ensureStarted(')
    const threadStartRpc = provider.indexOf('threadLaunchPlan.request.method')
    const preRpcAuthorityCheck = provider.indexOf(
      "providerTransportLaunchAuthorized('codex', payload, route)",
      ensureStarted
    )
    expect(ensureStarted).toBeGreaterThanOrEqual(0)
    expect(preRpcAuthorityCheck).toBeGreaterThan(ensureStarted)
    expect(preRpcAuthorityCheck).toBeLessThan(threadStartRpc)

    expect(authorityRecheck).toBeGreaterThanOrEqual(0)
    expect(authorityRecheck).toBeLessThan(tracked)
    expect(tracked).toBeLessThan(exposed)
    expect(exposed).toBeLessThan(admitted)
    expect(admitted).toBeLessThan(awaited)
    const timeout = provider.indexOf("isCodexAppServerRequestTimeout(error, 'turn/start')")
    const deferredInterrupt = provider.indexOf(
      'pendingCodexInterrupts.add(codexState.threadId)',
      timeout
    )
    const timeoutJoin = provider.indexOf('await turnOperation', deferredInterrupt)
    const rejectedStartSettlement = provider.indexOf(
      'completeCodexAppServerTurnProjection(codexState)',
      timeoutJoin
    )
    expect(timeout).toBeGreaterThan(admitted)
    expect(deferredInterrupt).toBeGreaterThan(timeout)
    expect(timeoutJoin).toBeGreaterThan(deferredInterrupt)
    expect(rejectedStartSettlement).toBeGreaterThan(timeoutJoin)

    const notifications = between(
      'function handleCodexNotification(message: any)',
      'function formatCodexApprovalRequest('
    )
    expect(notifications).toContain("message.method === 'turn/failed'")
    expect(notifications).toContain("message.method === 'review/failed'")
    const finished = notifications.indexOf('runManager.finish(state.appRunId')
    const projectionComplete = notifications.indexOf(
      'completeCodexAppServerTurnProjection(state)',
      finished
    )
    expect(finished).toBeGreaterThanOrEqual(0)
    expect(projectionComplete).toBeGreaterThan(finished)
  })

  it('journals and seals solo Codex usage on an unretried app-server error', () => {
    const notifications = between(
      'function handleCodexNotification(message: any)',
      'function formatCodexApprovalRequest('
    )
    const errorBranch = notifications.slice(
      notifications.lastIndexOf("if (message.method === 'error') {")
    )
    const usageRecord = errorBranch.indexOf('recordCodexUsageOnCompletion({')
    const sealed = errorBranch.indexOf('sealSoloCodexRunOnCompletion({')
    const terminalResult = errorBranch.indexOf("type: 'result'")
    const finished = errorBranch.indexOf("runManager.finish(state.appRunId, 'failed')")

    expect(errorBranch).toContain('if (params.willRetry === true) return')
    expect(errorBranch).toContain('if (state.completed)')
    expect(usageRecord).toBeGreaterThanOrEqual(0)
    expect(sealed).toBeGreaterThan(usageRecord)
    expect(terminalResult).toBeGreaterThan(sealed)
    expect(errorBranch).toContain('stats: terminalStats')
    expect(finished).toBeGreaterThan(terminalResult)
  })

  it('issues a fresh-run Codex continuation after host rerun', () => {
    const continuation = between(
      'function continueCodexAfterHostRerun(',
      'async function runApprovedHostCommand('
    )

    // R1 from HostRerunContinuation mint — never random fallback, never R0 reuse.
    expect(continuation).toContain('createHostRerunContinuationCorrelation({')
    expect(continuation).toContain('resolveHostRerunContinuationSession({')
    expect(continuation).toContain('buildHostRerunContinuationPrompt(')
    expect(continuation).toContain('providerSessionId: resumeProviderSessionId')
    expect(continuation).toContain('linkedProviderSessionId')
    expect(continuation).toContain('appRunId: continuationRunId')
    expect(continuation).toContain('handoffSourceRunId: approvalRunId')
    expect(continuation).toContain('host_rerun_continuation_dispatched')
    expect(continuation).toContain('runCoordinatorRef.dispatch')
    expect(continuation).toContain('dispatchResult.dispatched')
    expect(continuation).not.toContain("createFallbackRunId('codex')")
    expect(continuation).not.toContain('appRunId: approvalRunId')
  })

  it('tracks native Codex review before review admission', () => {
    const review = between(
      "'start-agent-review'",
      '// Single source for per-provider model catalogs'
    )
    const tracked = review.indexOf('trackCodexAppServerTurnOperation(reviewState)')
    const exposed = review.indexOf('registerRunSession(', tracked)
    const admitted = review.indexOf("'review/start'", exposed)

    expect(tracked).toBeGreaterThanOrEqual(0)
    expect(tracked).toBeLessThan(exposed)
    expect(exposed).toBeLessThan(admitted)
    expect(review).toContain('completeCodexAppServerTurnProjection(reviewState)')
    expect(review).toContain("isCodexAppServerRequestTimeout(error, 'review/start')")
    expect(review).toContain('pendingCodexInterrupts.add(reviewState.threadId)')
  })

  it('keeps the Claude CLI adapter live through exact child close and cleanup', () => {
    const launcher = between(
      'function runCliProviderProcess(',
      'async function loadOptionalClaudeSdk'
    )
    const tracked = launcher.indexOf('providerTransportOperations.track(')
    const warningProjection = launcher.indexOf('if (options.warning)')
    const initProjection = launcher.indexOf("type: 'init'", warningProjection)
    const spawn = launcher.indexOf('child = spawn(', tracked)
    const exposed = launcher.indexOf('runManager.attachProcess(', spawn)
    const close = launcher.indexOf("child.on('close'", exposed)
    const settled = launcher.indexOf('transportClose.markTransportClosed()', close)
    const returned = launcher.indexOf('return transportOperation', settled)

    expect(tracked).toBeGreaterThanOrEqual(0)
    expect(tracked).toBeLessThan(warningProjection)
    expect(warningProjection).toBeLessThan(initProjection)
    expect(tracked).toBeLessThan(spawn)
    expect(spawn).toBeLessThan(exposed)
    expect(exposed).toBeLessThan(close)
    expect(close).toBeLessThan(settled)
    expect(settled).toBeLessThan(returned)

    const errorListener = launcher.indexOf("child.on('error'", exposed)
    const closeListener = launcher.indexOf("child.on('close'", errorListener)
    const stdinWrite = launcher.indexOf('writeStdinPlan(stdinPlan.initialLines)', closeListener)
    const stdinEnd = launcher.indexOf('child.stdin?.end()', closeListener)
    expect(exposed).toBeLessThan(errorListener)
    expect(errorListener).toBeLessThan(closeListener)
    expect(closeListener).toBeLessThan(stdinWrite)
    expect(closeListener).toBeLessThan(stdinEnd)
    expect(launcher).toContain('runManager.confirmTerminalStatus(')
    expect(launcher).toContain('providerProcessTerminationBackstop.clear(route.appRunId)')
    const cleanupBeforeTerminal = launcher.indexOf(
      'await completeTransportCleanup()',
      closeListener
    )
    const terminalExit = launcher.indexOf(
      'sendAgentCompatExit(event.sender, provider, effectiveExitCode, state)',
      cleanupBeforeTerminal
    )
    const terminalFinish = launcher.indexOf(
      'runManager.finish(route.appRunId, terminalStatus)',
      cleanupBeforeTerminal
    )
    expect(cleanupBeforeTerminal).toBeGreaterThan(closeListener)
    expect(cleanupBeforeTerminal).toBeLessThan(terminalExit)
    expect(terminalExit).toBeLessThan(terminalFinish)
    expect(launcher).toContain('effectiveExitCode !== 0 || state.terminalResultFailed === true')
    expect(launcher).toContain("state.terminalResultStatus ?? 'completed'")

    const claudeProvider = between('async function runClaudeProvider(', '// Managed Grok runs')
    expect(claudeProvider).toContain(
      "await runCliProviderProcess(event, 'claude', environmentAuthority.binaryPath"
    )
  })

  it('keeps the Claude SDK adapter live through exact stream and terminal settlement', () => {
    const provider = between(
      'async function tryRunClaudeSdk(',
      'async function prepareClaudeRunEnvironmentAuthority('
    )
    const registered = provider.indexOf('const registeredSession = registerRunSession(')
    const tracked = provider.indexOf('providerTransportOperations.track(', registered)
    const broker = provider.indexOf('await startGeminiMcpBroker()', tracked)
    const postBrokerAuthority = provider.indexOf(
      "providerTransportLaunchAuthorized('claude', payload, route)",
      broker
    )
    const adopted = provider.indexOf('sdkTransportAdopted = true', postBrokerAuthority)
    const query = provider.indexOf('const stream = query(', postBrokerAuthority)
    const streamEnd = provider.indexOf('for await (const message of stream)', query)
    const cancellationFence = provider.indexOf('controller.signal.aborted', streamEnd)
    const terminalSettlement = provider.indexOf('settleClaudeSdkTerminal({', cancellationFence)
    const closed = provider.lastIndexOf('transportClose.markTransportClosed()')
    const awaited = provider.lastIndexOf('await transportOperation')

    expect(registered).toBeGreaterThanOrEqual(0)
    expect(registered).toBeLessThan(tracked)
    expect(tracked).toBeLessThan(broker)
    expect(broker).toBeLessThan(postBrokerAuthority)
    expect(postBrokerAuthority).toBeLessThan(adopted)
    expect(adopted).toBeLessThan(query)
    expect(query).toBeLessThan(streamEnd)
    expect(streamEnd).toBeLessThan(cancellationFence)
    expect(cancellationFence).toBeLessThan(terminalSettlement)
    expect(terminalSettlement).toBeLessThan(closed)
    expect(closed).toBeLessThan(awaited)
    expect(provider).toContain("state.terminalResultStatus ?? 'completed'")
    expect(provider).toContain('if (sdkTransportAdopted)')
    expect(provider).toContain('did not replay the turn through the CLI fallback')
    expect(provider).toContain("if (decision === 'terminal')")
    expect(provider).toContain('runManager.getClaimedTerminalStatus(route.appRunId)')
  })

  it('combines claim, persistence, history, and setup cancellation at launch fences', () => {
    const sharedFence = between(
      'function providerTransportLaunchAuthorized(',
      'function settleDeniedProviderTransportLaunch('
    )
    expect(sharedFence).toContain('runManager.canAdmitTransport(route.appRunId, true)')
    expect(sharedFence).toContain('providerRunPersistenceAuthorized(provider, route)')
    expect(sharedFence).toContain('historyClearAdmissionBlocked(')
    expect(sharedFence).toContain('setupSignal: payload.providerSetupAbortSignal')

    const claude = between('async function tryRunClaudeSdk(', '// Managed Grok runs')
    const cursor = between('async function runCursorProvider(', '// ── Pi coding agent')
    const grok = between('async function runGrokAcpProvider', '/**\n * Phase I3 (Claude initiator)')
    const kimi = between('async function runKimiAcpProvider(', 'async function runKimiProvider(')
    const codex = between(
      'async function runCodexAppServerWithClient(',
      '/**\n * Other well-known codex install locations'
    )

    expect(claude).toContain("providerTransportLaunchAuthorized('claude', payload, route)")
    expect(cursor).toContain("providerTransportLaunchAuthorized('cursor', payload, route)")
    expect(grok).toContain("providerTransportLaunchAuthorized('grok', payload, route)")
    expect(kimi).toContain("providerTransportLaunchAuthorized('kimi', payload, route)")
    expect(codex).toContain("providerTransportLaunchAuthorized('codex', payload, route)")
  })

  it('does not let the retired environment override reopen headless Grok', () => {
    const provider = between(
      'async function runGrokProvider',
      '// Cursor launch history lives in git'
    )

    expect(provider).toContain('if (!grokAcpEnabled())')
    expect(provider).toContain('GROK_ACP_REQUIRED_MESSAGE')
    expect(provider).toContain('securityUnavailable: true')
    expect(provider).toContain('await runGrokAcpProvider(event, payload)')
    expect(provider).not.toContain('runCliProviderProcess')
    expect(provider).not.toContain('buildGrokProviderCliArgs')
  })

  it('keeps the Grok adapter live through its provider-owned exact child close', () => {
    const provider = between(
      'async function runGrokAcpProvider',
      '/**\n * Phase I3 (Claude initiator)'
    )
    const tracked = provider.indexOf('providerTransportOperations.track(')
    const initProjection = provider.indexOf("type: 'init'")
    const brokerStart = provider.indexOf('await mcpBridgeRuntime.startGeminiMcpBroker()')
    const postBrokerAuthority = provider.indexOf(
      "providerTransportLaunchAuthorized('grok', payload, route)",
      brokerStart
    )
    const authorityCheck = provider.indexOf(
      "providerTransportLaunchAuthorized('grok', payload, route)",
      postBrokerAuthority + 1
    )
    const spawn = provider.indexOf('grokAcpHandle = runGrokAcpTurn({', authorityCheck)
    const abortAttached = provider.indexOf(
      'runManager.attachAbortController(route.appRunId!, createGrokTurnAbortController(grokAcpHandle))'
    )
    const awaited = provider.indexOf('await grokAcpHandle.closed', abortAttached)
    const settled = provider.indexOf('await grokTransportOperation', awaited)

    expect(tracked).toBeGreaterThanOrEqual(0)
    expect(tracked).toBeLessThan(initProjection)
    expect(brokerStart).toBeGreaterThan(initProjection)
    expect(postBrokerAuthority).toBeGreaterThan(brokerStart)
    expect(tracked).toBeLessThan(authorityCheck)
    expect(authorityCheck).toBeLessThan(spawn)
    expect(abortAttached).toBeGreaterThan(spawn)
    expect(awaited).toBeGreaterThan(abortAttached)
    expect(settled).toBeGreaterThan(awaited)
    expect(provider).toContain('const safelyProject = (projection: () => void): void =>')
    expect(provider).toContain('runManager.confirmTerminalStatus(')
    expect(provider).toContain('grokTransportClose.markTransportClosed()')
    expect(provider).toContain(
      "settleProviderRunWithoutTransport(runManager, route.appRunId!, 'failed')"
    )
  })

  it('pre-registers Kimi close authority and waits through async cleanup projection', () => {
    const provider = between(
      'async function runKimiAcpProvider(',
      'async function runKimiProvider('
    )
    const tracked = provider.indexOf('providerTransportOperations.track(')
    const homePreparation = provider.indexOf('await prepareKimiIsolatedHome({')
    const registered = provider.indexOf('const registeredSession = registerRunSession(')
    const initializationProjection = provider.indexOf(
      'emitContextCompactionCompatLine(',
      registered
    )
    const initializationSettlement = provider.indexOf(
      'Kimi initialization projection failed:',
      initializationProjection
    )
    const admitted = provider.indexOf('await launchKimiProductionAcp({', tracked)
    const gatewayStart = provider.indexOf('const bridge = await startKimiHttpMcpBridge({', admitted)
    const postGatewayAuthority = provider.indexOf(
      "providerTransportLaunchAuthorized('kimi', payload, route)",
      gatewayStart
    )
    const synchronousLaunch = provider.indexOf(
      'launch: (production, transportCleanup, admittedBinaryPath) => {',
      admitted
    )
    const finalAuthorityRecheck = provider.indexOf(
      "providerTransportLaunchAuthorized('kimi', payload, route)",
      synchronousLaunch
    )
    const turn = provider.indexOf('return runKimiAcpTurn({', finalAuthorityRecheck)
    const spawned = provider.indexOf('return spawn(admittedBinaryPath', admitted)
    const exposed = provider.indexOf('runManager.attachProcess(route.appRunId!', spawned)
    const asyncClose = provider.indexOf(
      'onClose: async (code, turnComplete, terminalStatus)',
      exposed
    )
    const finalized = provider.indexOf('await finalizeKimiRunAfterCleanup({', asyncClose)
    const abortAttached = provider.indexOf(
      'runManager.attachAbortController(route.appRunId!, createAcpTurnAbortController(handle))',
      finalized
    )
    const awaited = provider.indexOf('await handle.closed', abortAttached)
    const settled = provider.indexOf('kimiTransportClose.markTransportClosed()', awaited)

    expect(tracked).toBeGreaterThanOrEqual(0)
    expect(tracked).toBeLessThan(homePreparation)
    expect(homePreparation).toBeLessThan(registered)
    expect(registered).toBeLessThan(initializationProjection)
    expect(initializationProjection).toBeLessThan(initializationSettlement)
    expect(initializationSettlement).toBeLessThan(admitted)
    expect(tracked).toBeLessThan(admitted)
    expect(postGatewayAuthority).toBeGreaterThan(gatewayStart)
    expect(admitted).toBeLessThan(synchronousLaunch)
    expect(synchronousLaunch).toBeLessThan(finalAuthorityRecheck)
    expect(finalAuthorityRecheck).toBeLessThan(turn)
    expect(turn).toBeLessThan(spawned)
    expect(spawned).toBeLessThan(exposed)
    expect(exposed).toBeLessThan(asyncClose)
    expect(asyncClose).toBeLessThan(finalized)
    expect(finalized).toBeLessThan(abortAttached)
    expect(abortAttached).toBeLessThan(awaited)
    expect(awaited).toBeLessThan(settled)
    expect(provider).toContain('runManager.confirmTerminalStatus(route.appRunId, terminalStatus)')
    expect(provider).toContain(
      "projectVisibleProviderSetupFailure({\n        sender: event.sender,\n        provider: 'kimi'"
    )
  })

  it('routes detached Kimi compaction process admission through the joined ACP startup hook', () => {
    const compaction = between(
      'async function compactKimiProviderContext(',
      'function seatCompactionKey('
    )
    const turn = compaction.indexOf('handle = runKimiAcpTurn({')
    const startup = compaction.indexOf('beforeInitialize: async (providerChild)', turn)
    const lease = compaction.indexOf('await home.noteProviderProcess(proc.pid || 0)', startup)
    const close = compaction.indexOf('onClose: (_code, turnComplete, terminalStatus)', lease)

    expect(turn).toBeGreaterThanOrEqual(0)
    expect(turn).toBeLessThan(startup)
    expect(startup).toBeLessThan(lease)
    expect(lease).toBeLessThan(close)
  })

  it('requires exact adapter and callback-driven transport settlement before receipt', () => {
    const termination = between(
      'async function terminateProviderRunForHistory',
      'async function containExecutionGraphTerminalJoin'
    )

    expect(termination).toContain('providerAdapterRunsInFlight.get(runId)')
    expect(termination).toContain('providerTransportOperations.get(runId)')
    expect(termination).toContain("terminateExactProviderSession(provider, runId, 'cancelled')")
    expect(termination).toContain('waitForProviderOperationSettlement(operation, 5_000)')
    expect(termination).toContain("session.process?.kill('SIGKILL')")
    expect(termination).toContain('if (!settled.every(Boolean)) return false')
    expect(termination).toContain(
      '// A fresh process has lost the child PID/start-time identity needed to'
    )
  })

  it('leaves every tracked one-shot terminal status to its real close/projection handler', () => {
    const termination = between(
      'async function terminateExactProviderSession',
      'async function terminateProviderRunForHistory'
    )
    expect(termination).toContain('shouldDeferEagerProviderTerminalization({')
    expect(termination).toContain(
      'exactTransportOperationTracked: Boolean(providerTransportOperations.get(runId))'
    )
    expect(termination).toContain('if (!deferEagerTerminalization) {')

    const codexExec = between(
      'async function runCodexExecFallback(',
      '/**\n * Other well-known codex install locations'
    )
    expect(codexExec).toContain('providerTransportOperations.track(')
    expect(codexExec).toContain('runManager.finish(route.appRunId, terminalStatus)')
    expect(codexExec).toContain('runManager.confirmTerminalStatus(route.appRunId, terminalStatus)')

    const claudeCli = between(
      'function runCliProviderProcess(',
      'async function loadOptionalClaudeSdk'
    )
    expect(claudeCli).toContain('providerTransportOperations.track(')
    expect(claudeCli).toContain('const terminalStatus =')
    expect(claudeCli).toContain('runManager.finish(route.appRunId, terminalStatus)')
    expect(claudeCli).toContain('runManager.confirmTerminalStatus(')
    const claudeError = claudeCli.slice(
      claudeCli.indexOf("child.on('error'"),
      claudeCli.indexOf("child.on('close'")
    )
    expect(claudeError).not.toContain('runManager.finish(')

    const kimi = between('async function runKimiAcpProvider(', 'async function runKimiProvider(')
    expect(kimi).toContain('providerTransportOperations.track(')
    expect(kimi).toContain('runManager.finish(route.appRunId, terminalStatus)')
    expect(kimi).toContain('runManager.confirmTerminalStatus(route.appRunId, terminalStatus)')

    const grok = between('async function runGrokAcpProvider', '/**\n * Phase I3 (Claude initiator)')
    expect(grok).toContain('providerTransportOperations.track(')
    expect(grok).toContain(
      "runManager.finish(route.appRunId!, finalFailed ? 'failed' : 'completed')"
    )
  })
})
