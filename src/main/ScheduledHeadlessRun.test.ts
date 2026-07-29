import { readFileSync } from 'fs'
import { describe, expect, it, vi } from 'vitest'
import {
  armScheduledLoopStepTimeout,
  scheduledHeadlessComposeFields
} from './ScheduledHeadlessRun'

describe('scheduledHeadlessComposeFields', () => {
  it('preserves the durable occurrence posture and provider controls', () => {
    const geminiWorktree = {
      enabled: true,
      name: 'scheduled-test-2',
      effectivePath: '/Users/chrisizatt/Documents/Test 2-worktree'
    } as const

    expect(
      scheduledHeadlessComposeFields({
        workflowMode: 'plan',
        permissionPresetId: 'read_only',
        geminiWorktree,
        kimiFastMode: true
      })
    ).toEqual({
      workflowMode: 'plan',
      permissionPresetId: 'read_only',
      geminiWorktree,
      kimiFastMode: true
    })
  })
})

describe('armScheduledLoopStepTimeout', () => {
  it('cancels a cross-provider verifier through its compose provider', async () => {
    vi.useFakeTimers()
    const cancelProviderRun = vi.fn(() => Promise.resolve())
    const handleExit = vi.fn()

    const clear = armScheduledLoopStepTimeout({
      composeProvider: 'claude',
      runId: 'loop-grok-verifier-1',
      timeoutMs: 500,
      cancelProviderRun,
      handleExit
    })

    await vi.advanceTimersByTimeAsync(500)
    expect(cancelProviderRun).toHaveBeenCalledWith('claude', 'loop-grok-verifier-1')
    expect(cancelProviderRun).not.toHaveBeenCalledWith('grok', expect.any(String))
    expect(handleExit).toHaveBeenCalledWith('loop-grok-verifier-1', -1)

    clear()
    vi.useRealTimers()
  })

  it('can be cleared after a completed step', async () => {
    vi.useFakeTimers()
    const cancelProviderRun = vi.fn()
    const handleExit = vi.fn()
    const clear = armScheduledLoopStepTimeout({
      composeProvider: 'grok',
      runId: 'loop-grok-maker-1',
      timeoutMs: 500,
      cancelProviderRun,
      handleExit
    })

    clear()
    await vi.advanceTimersByTimeAsync(500)
    expect(cancelProviderRun).not.toHaveBeenCalled()
    expect(handleExit).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})

describe('scheduled headless dispatch integration', () => {
  const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
  const sourceBetween = (startMarker: string, endMarker: string): string => {
    const start = indexSource.indexOf(startMarker)
    const end = indexSource.indexOf(endMarker, start + startMarker.length)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    return indexSource.slice(start, end)
  }

  it('uses the durable compose fields for both loop and solo headless runs', () => {
    expect(indexSource.match(/\.\.\.scheduledHeadlessComposeFields\(task\)/g)).toHaveLength(2)
  })

  it('arms loop timeouts with the provider that composed the current step', () => {
    expect(indexSource).toContain('armScheduledLoopStepTimeout({\n      composeProvider,')
    expect(indexSource).not.toContain('cancelProviderRun(task.provider, input.runId)')
  })

  it('verifies scheduled attachment ownership without minting it during dispatch', () => {
    expect(indexSource).toContain('function verifyScheduledTaskAttachmentOwnership(')
    expect(indexSource).toContain('scheduledAttachmentPersistence.resolve({')
    expect(indexSource).not.toContain('function grantScheduledTaskAttachmentOwnership(')
    expect(indexSource).not.toContain(
      'scheduled attachment ownership failed for ${task.id}: ${granted.reason}'
    )
  })

  it('keeps scheduled occurrences on the final MAIN-owned dispatch seam', () => {
    expect(indexSource).toContain('let dispatchMainOwnedScheduledOccurrenceRef:')
    expect(indexSource).toContain('const dispatch = dispatchMainOwnedScheduledOccurrenceRef')
    expect(indexSource).toContain('dispatchMainOwnedScheduledOccurrenceRef =')
    expect(indexSource).toContain('authorizeMainOwnedScheduledOccurrenceDispatch(payload)')
  })

  it('rejects renderer-authored orchestration identities', () => {
    expect(indexSource).toContain("if (payload.ensembleRun || payload.auditRun) {")
    expect(indexSource).toContain("throw new Error('Renderer orchestration identities are MAIN-owned.')")
  })

  it('fails closed when a scheduled identity outlives its live owner', () => {
    expect(indexSource).toContain('wasScheduledOccurrenceRunIdObserved(routedRunId)')
    expect(indexSource).toContain('wasDurableScheduledRunIdObserved(runId)')
    expect(indexSource).toContain(
      "throw new Error('Scheduled occurrence ownership ended before provider preflight.')"
    )
    expect(indexSource).toContain(
      'scheduledOccurrenceOwners.lookupByOwnerRunId(owner.ownerRunId) !== owner'
    )
  })

  it('requires a durable marker before dispatching a scheduled child', () => {
    const loopDispatch = sourceBetween(
      'const dispatchStep = async (input: WorkflowLoopStepInput)',
      'const engine = new WorkflowLoopEngine({'
    )
    const ensembleDispatch = sourceBetween(
      'ensembleOrchestratorRef = new EnsembleOrchestrator({',
      'shouldPersistProviderSessionForRun,'
    )

    expect(loopDispatch.indexOf('recordScheduledOccurrenceChildBinding({')).toBeLessThan(
      loopDispatch.indexOf('scheduledOccurrenceOwners.bindLoopChildRun(')
    )
    expect(loopDispatch.indexOf('scheduledOccurrenceOwners.bindLoopChildRun(')).toBeLessThan(
      loopDispatch.indexOf('void dispatch(composed, { sender })')
    )
    expect(ensembleDispatch.indexOf('recordScheduledOccurrenceChildBinding({')).toBeLessThan(
      ensembleDispatch.indexOf('scheduledOccurrenceOwners.bindEnsembleChildRun(')
    )
    expect(
      ensembleDispatch.indexOf('scheduledOccurrenceOwners.bindEnsembleChildRun(')
    ).toBeLessThan(ensembleDispatch.indexOf('dispatchMainOwnedScheduledOccurrence(payload, event)'))
  })

  it('keeps only active root or child transports live during stall reconciliation', () => {
    const liveness = sourceBetween(
      'function isScheduledRunLive(runId: string): boolean {',
      '/**\n * BACKSTOP sweep:'
    )
    expect(liveness).toContain('scheduledOccurrenceOwners.lookupByOwnerRunId(runId)')
    expect(liveness).toContain('scheduledOccurrenceOwners.lookupChildRunIdsForOwner(owner)')
    expect(liveness).toContain('runManager.get(transportRunId)')
    expect(liveness).toContain('isActiveRunSessionStatus(session.status)')
    expect(liveness).not.toContain(
      'if (scheduledOccurrenceOwners.lookupByOwnerRunId(runId)) return true'
    )
  })

  it('releases only exact owners returned by durable stall settlement', () => {
    const reconcile = sourceBetween(
      'function reconcileStalledScheduledTasks(): void {',
      'function scheduleNextTaskTimer() {'
    )
    expect(reconcile).toContain(
      'settled = AppStore.settleStalledScheduledTasks(isScheduledRunLive, Date.now())'
    )
    expect(reconcile).toContain('if (owner && owner.taskId === task.id) {')
    expect(reconcile).toContain('scheduledOccurrenceOwners.release(owner)')
    expect(reconcile.indexOf('scheduledOccurrenceOwners.release(owner)')).toBeLessThan(
      reconcile.indexOf('if (stalledOccurrenceEventKeys.has(key)) continue')
    )
  })

  it('settles terminal occurrences through one publication and timer-rearm seam', () => {
    const publisher = sourceBetween(
      'function publishScheduledOccurrenceSettlement(): void {',
      'const SCHEDULED_CHILD_BOUND_EVENT_TYPE'
    )
    expect(indexSource.match(/scheduledOccurrenceTransaction\.settle\(/g)).toHaveLength(1)
    expect(publisher).toContain("webContents.send('scheduled-tasks-changed'")
    expect(publisher).toContain("'workflow-definitions-changed'")
    expect(publisher).toContain('requestThrottledRemoteProjectionSnapshot()')
    expect(publisher).toContain('scheduleNextTaskTimer()')
  })

  it('retains exact loop authority on heartbeat rejection and suppresses stale terminals', () => {
    const loop = sourceBetween(
      'async function dispatchDueScheduledLoopHeadless(',
      'function seedScheduledSoloTranscript('
    )
    expect(loop).toContain('Scheduled workflow loop heartbeat could not be persisted.')
    expect(loop).not.toContain('scheduledOccurrenceOwners.release(owner)')
    expect(loop).toContain(
      'scheduledOccurrenceOwners.lookupByOwnerRunId(owner.ownerRunId) !== owner'
    )
    expect(loop.indexOf('if (\n    ownershipLost ||')).toBeLessThan(
      loop.indexOf("kind: 'loop_settled'")
    )
  })

  it('durably fails and aborts the exact scheduled ensemble round on heartbeat rejection', () => {
    const heartbeat = sourceBetween(
      'function saveEnsembleChatWithScheduledHeartbeat(',
      'function providerForTranscriptMessage('
    )
    const failure = sourceBetween(
      'function failScheduledEnsembleOccurrenceAndAbort(',
      'function publishScheduledOccurrenceSettlement('
    )
    expect(heartbeat).toContain('failScheduledEnsembleOccurrenceAndAbort(')
    expect(heartbeat).toContain('round.roundId,')
    expect(failure).toContain(
      'scheduledOccurrenceOwners.lookupEnsembleRoundIdForOwner(owner) !== expectedRoundId'
    )
    expect(failure.indexOf("settleScheduledOccurrence(owner, 'failed'")).toBeLessThan(
      failure.indexOf('cancelRound(owner.chatId, lastError, expectedRoundId)')
    )
  })

  it('finalizes a seeded solo transcript when provider launch throws', () => {
    const solo = sourceBetween(
      'function failScheduledSoloLaunchAfterTranscriptSeed(',
      'function emitDueScheduledTasks() {'
    )
    expect(solo).toContain(
      "await terminateExactProviderSession(owner.provider, owner.ownerRunId, 'failed')"
    )
    expect(solo).toContain('sendAgentCompatError(')
    expect(solo).toContain('sendAgentCompatExit(')
    expect(solo).toContain('workflowBudgetRegistry.onExit(owner.ownerRunId)')
    expect(solo).toContain('failScheduledSoloLaunchAfterTranscriptSeed(owner, error)')
  })

  it('terminates a partially started loop child before resolving dispatch failure', () => {
    const failure = sourceBetween(
      'const failDispatch = async (): Promise<void> => {',
      'const outcome = await completion'
    )
    expect(failure.indexOf('await terminateExactProviderSession(')).toBeLessThan(
      failure.indexOf('auditRunTracker.handleExit(input.runId, -1)')
    )
  })

  it('terminalizes an invalid ensemble-loop configuration before claiming it', () => {
    const scheduler = sourceBetween(
      'function emitDueScheduledTasks() {',
      'function isScheduledRunLive(runId: string): boolean {'
    )
    const invalid = scheduler.indexOf("if (dueTask.kind === 'ensemble' && configuredLoop) {")
    const claim = scheduler.indexOf('scheduledOccurrenceTransaction.claim(dueTask)')
    expect(invalid).toBeGreaterThanOrEqual(0)
    expect(invalid).toBeLessThan(claim)
    expect(scheduler).toContain("status: 'failed'")
    expect(scheduler).toContain('Ensemble scheduled occurrences cannot own workflow loops.')
  })

  it('releases and publishes every durably stalled occurrence even when audit append fails', () => {
    const reconcile = sourceBetween(
      'function reconcileStalledScheduledTasks(): void {',
      'function scheduleNextTaskTimer() {'
    )
    expect(reconcile).toContain(
      "console.error('[scheduled-occurrence] stalled settlement audit failed'"
    )
    expect(reconcile).toContain('} finally {\n    publishScheduledOccurrenceSettlement()')
  })

  it('blocks interactive Ensemble starts, queues, and steers while a scheduled owner is live', () => {
    const helper = sourceBetween(
      'const SCHEDULED_ENSEMBLE_INTERACTIVE_BLOCK',
      '// Stage 0b-dispatch (ensemble)'
    )
    expect(helper).toContain('scheduledOccurrenceOwners.lookupByChatId(chatId)')
    expect(indexSource.match(/assertScheduledEnsembleInteractiveAvailable\(chatId\)/g)).toHaveLength(2)
    expect(indexSource.match(/scheduledEnsembleInteractiveBlock\(action\.threadId\)/g)).toHaveLength(4)
    expect(indexSource).toContain(
      "requireNonEmptyString(payload.appChatId, 'Ensemble dispatch chat id')"
    )
  })

  it('mints and freshly verifies the solo seal before transcript seed or provider dispatch', () => {
    const solo = sourceBetween(
      'async function dispatchDueScheduledTaskHeadless(',
      'function emitDueScheduledTasks() {'
    )
    const compose = solo.indexOf('const composed = composer.composeRun({')
    const seal = solo.indexOf('const sealService = scheduledOccurrenceSealServiceRef')
    const seed = solo.indexOf('seedScheduledSoloTranscript(')
    const dispatch = solo.indexOf('const result = await dispatch(')

    expect(compose).toBeGreaterThanOrEqual(0)
    expect(seal).toBeGreaterThan(compose)
    expect(seed).toBeGreaterThan(seal)
    expect(dispatch).toBeGreaterThan(seed)
    expect(solo).toContain('sealService.sealSoloOccurrence({')
    expect(solo).toContain(
      'Scheduled occurrence seal verification failed: ${sealOutcome.reason}'
    )
  })

  it('continues to provider dispatch when solo sealing is explicitly skipped', () => {
    const solo = sourceBetween(
      'async function dispatchDueScheduledTaskHeadless(',
      'function emitDueScheduledTasks() {'
    )
    const skipped = solo.indexOf("if (sealOutcome.ok === 'skipped')")
    const transcriptSeed = solo.indexOf('transcriptSeeded = true', skipped)
    const dispatch = solo.indexOf('const result = await dispatch(', transcriptSeed)

    expect(skipped).toBeGreaterThanOrEqual(0)
    expect(transcriptSeed).toBeGreaterThan(skipped)
    expect(solo.slice(skipped, transcriptSeed)).not.toContain('return')
    expect(dispatch).toBeGreaterThan(transcriptSeed)
    expect(solo).toContain("title: 'Scheduled launch ran without an exact launch seal'")
    expect(solo).toContain('message: unsealedLaunchReason')
    expect(solo).toContain('could not publish unsealed-launch warning')
  })
})
