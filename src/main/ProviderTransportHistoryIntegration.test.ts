import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

function between(start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

describe('one-shot provider transport history join', () => {
  it('keeps Codex exec fallback live through exact child close and terminal projection', () => {
    const provider = between(
      'async function runCodexExecFallback(',
      '/**\n * Other well-known codex install locations'
    )
    const resolved = provider.indexOf("resolveCliProviderBinary('codex'")
    const authorityRecheck = provider.indexOf(
      'providerTransportAdmissionStillAuthorized({',
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

  it('tracks Codex app-server before admission and awaits the exact terminal projection', () => {
    const provider = between(
      'async function runCodexAppServerWithClient(',
      'async function runCodexExecFallback('
    )
    const authorityRecheck = provider.indexOf('providerTransportAdmissionStillAuthorized({')
    const tracked = provider.indexOf('trackCodexAppServerTurnOperation(codexState)')
    const exposed = provider.indexOf('registerRunSession(', tracked)
    const admitted = provider.indexOf("'turn/start'", exposed)
    const awaited = provider.lastIndexOf('await turnOperation')

    expect(authorityRecheck).toBeGreaterThanOrEqual(0)
    expect(authorityRecheck).toBeLessThan(tracked)
    expect(tracked).toBeLessThan(exposed)
    expect(exposed).toBeLessThan(admitted)
    expect(admitted).toBeLessThan(awaited)
    const timeout = provider.indexOf("isCodexAppServerRequestTimeout(error, 'turn/start')")
    const deferredInterrupt = provider.indexOf('pendingCodexInterrupts.add(codexState.threadId)', timeout)
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

  it('issues a fresh-run Codex continuation after host rerun', () => {
    const continuation = between(
      'function continueCodexAfterHostRerun(',
      'async function runApprovedHostCommand('
    )

    expect(continuation).toContain('createFallbackRunId(\'codex\')')
    expect(continuation).toContain('appRunId: continuationRunId')
    expect(continuation).toContain('providerSessionId: resumeProviderSessionId')
    expect(continuation).toContain("runCoordinatorRef.dispatch")
    expect(continuation).toContain('result.dispatched')
  })

  it('tracks native Codex review before review admission', () => {
    const review = between("'start-agent-review'", '// Single source for per-provider model catalogs')
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
    const spawn = launcher.indexOf('child = spawn(', tracked)
    const exposed = launcher.indexOf('runManager.attachProcess(', spawn)
    const close = launcher.indexOf("child.on('close'", exposed)
    const settled = launcher.indexOf('transportClose.markTransportClosed()', close)
    const returned = launcher.indexOf('return transportOperation', settled)

    expect(tracked).toBeGreaterThanOrEqual(0)
    expect(tracked).toBeLessThan(spawn)
    expect(spawn).toBeLessThan(exposed)
    expect(exposed).toBeLessThan(close)
    expect(close).toBeLessThan(settled)
    expect(settled).toBeLessThan(returned)

    const claudeProvider = between('async function runClaudeProvider(', '// Managed Grok runs')
    expect(claudeProvider).toContain(
      "await runCliProviderProcess(event, 'claude', environmentAuthority.binaryPath"
    )
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
    const authorityCheck = provider.indexOf("providerRunPersistenceAuthorized('grok', state)")
    const spawn = provider.indexOf('const grokAcpHandle = runGrokAcpTurn({')
    const abortAttached = provider.indexOf(
      'runManager.attachAbortController(route.appRunId!, createGrokTurnAbortController(grokAcpHandle))'
    )
    const tracked = provider.indexOf(
      'providerTransportOperations.track(route.appRunId!, grokAcpHandle.closed)',
      abortAttached
    )
    const awaited = provider.indexOf('await grokAcpHandle.closed', tracked)

    expect(authorityCheck).toBeGreaterThanOrEqual(0)
    expect(authorityCheck).toBeLessThan(spawn)
    expect(abortAttached).toBeGreaterThan(spawn)
    expect(tracked).toBeGreaterThan(abortAttached)
    expect(awaited).toBeGreaterThan(tracked)
  })

  it('pre-registers Kimi close authority and waits through async cleanup projection', () => {
    const provider = between(
      'async function runKimiAcpProvider(',
      'async function runKimiProvider('
    )
    const tracked = provider.indexOf('providerTransportOperations.track(')
    const admitted = provider.indexOf('await launchKimiProductionAcp({', tracked)
    const synchronousLaunch = provider.indexOf(
      'launch: (production, transportCleanup, admittedBinaryPath) => {',
      admitted
    )
    const finalAuthorityRecheck = provider.indexOf(
      "assertKimiSpawnAuthority(() => providerRunPersistenceAuthorized('kimi', state))",
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
    expect(tracked).toBeLessThan(admitted)
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
    expect(codexExec).toContain(
      "runManager.finish(route.appRunId, exitCode === 0 ? 'completed' : 'failed')"
    )

    const claudeCli = between(
      'function runCliProviderProcess(',
      'async function loadOptionalClaudeSdk'
    )
    expect(claudeCli).toContain('providerTransportOperations.track(')
    expect(claudeCli).toContain(
      "runManager.finish(route.appRunId, effectiveExitCode === 0 ? 'completed' : 'failed')"
    )
    const claudeError = claudeCli.slice(
      claudeCli.indexOf("child.on('error'"),
      claudeCli.indexOf("child.on('close'")
    )
    expect(claudeError).not.toContain('runManager.finish(')

    const kimi = between('async function runKimiAcpProvider(', 'async function runKimiProvider(')
    expect(kimi).toContain('providerTransportOperations.track(')
    expect(kimi).toContain('finish: () => runManager.finish(route.appRunId, finishStatus)')

    const grok = between('async function runGrokAcpProvider', '/**\n * Phase I3 (Claude initiator)')
    expect(grok).toContain('providerTransportOperations.track(')
    expect(grok).toContain(
      "runManager.finish(route.appRunId!, finalFailed ? 'failed' : 'completed')"
    )
  })
})
