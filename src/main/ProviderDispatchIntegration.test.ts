import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RUN_MANAGER_PROVIDERS } from './index.constants'

const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
const coordinatorSource = readFileSync(
  new URL('./services/RunCoordinator.ts', import.meta.url),
  'utf8'
)

function sourceBetween(startMarker: string, endMarker: string): string {
  const start = indexSource.indexOf(startMarker)
  const end = indexSource.indexOf(endMarker, start + startMarker.length)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return indexSource.slice(start, end)
}

describe('provider dispatch integration', () => {
  it('registers one adapter descriptor for every provider lifecycle identity', () => {
    const registration = sourceBetween(
      '// Grok is a first-class provider',
      'async function readCliVersion('
    )

    for (const provider of RUN_MANAGER_PROVIDERS) {
      const marker = `defaultProviderDescriptor('${provider}')`
      expect(registration.split(marker)).toHaveLength(2)
    }
    expect(registration).toContain('...antigravityAdapters')
    expect(registration).toContain('...grokAdapters')
    expect(registration).toContain('...cursorAdapters')
    expect(registration).toContain('...piAdapters')
  })

  it('routes the legacy Gemini IPC surface through the shared dispatch facade', () => {
    const handler = sourceBetween(
      "ipcMain.handle(\n      'run-gemini'",
      "ipcMain.handle('cancel-gemini'"
    )
    expect(handler).toContain('await dispatchRunWithProviderPause(')
    expect(handler).not.toContain('await runGeminiProvider(')
    expect(handler).not.toContain('ensureProviderRunPreflight(')
  })

  it('keeps the unscoped legacy Gemini stdin channel inert', () => {
    const handler = sourceBetween(
      "ipcMain.handle('write-gemini-input'",
      "ipcMain.handle(\n      'start-gemini-session'"
    )

    expect(handler).toContain('assertMainRendererSender(event)')
    expect(handler).toContain('return false')
    expect(handler).not.toContain('geminiSessionProcess.write(')
    expect(handler).not.toContain('geminiProcess.stdin.write(')
  })

  it('treats a supplied cancellation run id as an exact provider-scoped target', () => {
    const cancelProvider = sourceBetween(
      'async function cancelProviderRun(',
      '// Phase M1 Step 2: bundle the module-local helpers GeminiApiProvider'
    )

    expect(cancelProvider).toContain('if (queuedJob.provider !== provider) return false')
    expect(cancelProvider).toContain(
      'if (runId && (!session || session.provider !== provider)) return false'
    )
    expect(cancelProvider).toContain(
      'if (!runId && wasScheduledOccurrenceRunIdObserved(session.runId)) return false'
    )
    expect(cancelProvider).toContain(
      'Provider-global process/controller handles cannot prove chat or occurrence'
    )
    expect(cancelProvider).not.toContain('cliProviderProcesses.get(provider)')
  })

  it('terminates an exact transport before clearing its RunManager handles', () => {
    const terminate = sourceBetween(
      'async function terminateExactProviderSession(',
      'async function cancelProviderRun('
    )
    expect(terminate.indexOf('session.abortController?.abort()')).toBeLessThan(
      terminate.indexOf('runManager.finish(runId, terminalStatus)')
    )
    expect(terminate.indexOf('session.process?.kill()')).toBeLessThan(
      terminate.indexOf('runManager.finish(runId, terminalStatus)')
    )
    for (const provider of ['gemini', 'pi', 'antigravity', 'claude', 'cursor', 'codex']) {
      expect(terminate).toContain(`provider === '${provider}'`)
    }
    expect(terminate).toContain('providerProcessTerminationBackstop.arm(runId, exactProcess)')
  })

  it('projects Pi and AntiGravity setup failures before no-transport settlement', () => {
    const setupFailure = sourceBetween(
      'function projectVisibleProviderSetupFailure(',
      'function runCliProviderProcess('
    )
    const pi = sourceBetween('async function runPiProvider(', '// 1.0.6-G4/G6 — Grok over ACP')
    const antigravity = sourceBetween(
      'async function runAntigravityAgyProvider(',
      '// Grok is a first-class provider'
    )

    expect(setupFailure.indexOf('sendAgentCompatError(')).toBeLessThan(
      setupFailure.indexOf('sendAgentCompatLine(')
    )
    expect(setupFailure.indexOf('sendAgentCompatLine(')).toBeLessThan(
      setupFailure.indexOf('sendAgentCompatExit(')
    )
    expect(setupFailure.indexOf('sendAgentCompatExit(')).toBeLessThan(
      setupFailure.indexOf('settleProviderRunWithoutTransport(')
    )
    expect(pi).toContain('settleVisibleProviderSetupFailure({')
    expect(antigravity).toContain('settleVisibleProviderSetupFailure({')
  })

  it('publishes the shared terminal exit when a Claude SDK budget abort blocks fallback', () => {
    const claudeProvider = sourceBetween(
      'async function runClaudeProvider(',
      'function geminiApiProviderDeps()'
    )
    const budgetGuard = sourceBetween(
      'if (route.appRunId && workflowBudgetRegistry.isKilled(route.appRunId)) {',
      '// Review fix: a `/compact` dispatch'
    )

    expect(claudeProvider).toContain(budgetGuard)
    expect(budgetGuard).toContain("sendAgentCompatExit(event.sender, 'claude', 130, route)")
    expect(budgetGuard).not.toContain('workflowBudgetRegistry.onExit(')
  })

  it('uses the private fs-free mandatory-gateway production composition for Kimi ACP', () => {
    const kimiAcpProvider = sourceBetween(
      'async function runKimiAcpProvider(',
      'async function runKimiProvider('
    )

    expect(kimiAcpProvider).toContain('prepareKimiPrivateRunCwd')
    expect(kimiAcpProvider).toContain('launchKimiProductionAcp')
    expect(kimiAcpProvider).toContain('assertRuntimeReadyForSpawn')
    expect(kimiAcpProvider).toContain('buildKimiContainedProcessEnv')
    expect(kimiAcpProvider).toContain('formatKimiProductionAcpDebugFrame')
    expect(kimiAcpProvider).toContain('finalizeKimiRunAfterCleanup')
    expect(kimiAcpProvider).toContain('const registeredSession = registerRunSession(')
    expect(kimiAcpProvider).toContain('if (!registeredSession)')
    expect(kimiAcpProvider.indexOf('if (!registeredSession)')).toBeLessThan(
      kimiAcpProvider.indexOf('launchKimiProductionAcp')
    )
    expect(kimiAcpProvider).toContain('cwd: production.cwd')
    expect(kimiAcpProvider).toContain('initializeParams: production.initializeParams')
    expect(kimiAcpProvider).toContain('mcpServers: production.mcpServers')
    expect(kimiAcpProvider).not.toContain('cwd: payload.workspace')
    expect(kimiAcpProvider).not.toContain('fsRoots')
    expect(kimiAcpProvider).not.toContain("continuing with Kimi's built-in tools only")
  })

  it('keeps host-summary subprocess compaction structurally Grok-only', () => {
    const hostSummary = sourceBetween(
      'async function runHostSeatSummaryProcess(',
      'function persistHostSeatCompactionCheckpoint('
    )
    const cliCompaction = sourceBetween(
      'async function compactCliSeatContext(',
      '/**\n * Unified entry for the `compact-provider-context` IPC.'
    )

    expect(hostSummary).toContain("provider: 'grok'")
    expect(hostSummary).not.toContain("provider: 'kimi'")
    expect(hostSummary).not.toContain('Kimi')
    expect(hostSummary).not.toContain('writeKimi')
    expect(cliCompaction).toContain("provider: 'grok'")
    expect(cliCompaction).not.toContain("provider: 'kimi'")
  })

  it('admits Kimi runtime before ensemble preflight reports the seat reachable', () => {
    const preflight = sourceBetween(
      'async function probeCliParticipant(',
      'function registerRunSession('
    )

    expect(preflight).toContain("participant.provider === 'kimi'")
    expect(preflight).toContain('admitKimiRuntime({')
    expect(preflight).toContain('isPackaged: app.isPackaged')
    expect(preflight.indexOf('admitKimiRuntime({')).toBeLessThan(
      preflight.indexOf('? { reachable: true }')
    )
  })

  it('retains coordinator-owned signed posture until a provider supplies state', () => {
    const registration = sourceBetween(
      'function registerRunSession(',
      'function getRuntimeSession('
    )

    expect(registration).toContain('const providerOwnsLifecycle = state !== undefined')
    expect(registration).toContain(
      "...(providerOwnsLifecycle ? { state, status: 'running' as const } : {})"
    )
    expect(registration).not.toContain(
      'providerSessionId || existing.providerSessionId,\\n      state'
    )
  })

  it('acquires one exact lifecycle owner after runtime-profile normalization and before preflight', () => {
    const coordinatorDispatch = coordinatorSource.slice(
      coordinatorSource.indexOf('  async dispatch(')
    )
    const lifecycleWiring = sourceBetween(
      'const providerRunLifecycleOwnershipDeps =',
      'runCoordinatorRef = runCoordinator'
    )

    expect(coordinatorDispatch.indexOf('this.deps.applyRuntimeProfileToPayload(')).toBeLessThan(
      coordinatorDispatch.indexOf('return this.deps.runWithLifecycleOwnership')
    )
    expect(coordinatorDispatch).toContain(
      'dispatchReservation,\n            dispatchWithLifecycleOwnership'
    )
    expect(
      lifecycleWiring.indexOf('authorizeProviderLifecycleStart(payload, reservation)')
    ).toBeLessThan(lifecycleWiring.indexOf('acquireProviderRunLifecycleOwnership('))
    expect(lifecycleWiring.indexOf('acquireProviderRunLifecycleOwnership(')).toBeLessThan(
      lifecycleWiring.indexOf('return await run()')
    )
    expect(lifecycleWiring).not.toContain('runWithProviderRunLifecycleOwnership(')
  })

  it('uses admitted runtime and OAuth-aware status when selecting Kimi for audit roles', () => {
    const auditSignals = sourceBetween(
      'const resolveAuditProviderSignals = async',
      'auditOrchestratorRef = new AuditOrchestrator'
    )

    expect(auditSignals).toContain("if (provider === 'kimi')")
    expect(auditSignals).toContain('await getKimiAdmittedStatusSnapshot()')
    expect(auditSignals).toContain('configured = status.available === true')
    expect(auditSignals).toContain("['api-key', 'oauth', 'authenticated'].includes(kimiAuthState)")
    expect(auditSignals).not.toContain('authenticated = Boolean(settings.kimiApiKey)')
  })
})
