import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  TASKWRAITH_CORE_MCP_PROFILE_NOTE,
  sanitizeTaskWraithMcpPromptClaims
} from './PromptComposition'
import { MainSourceProbe } from './mainSourceProbe.testutil'

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
const probe = new MainSourceProbe('src/main/index.ts', new URL('./index.ts', import.meta.url))

function between(start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex)
  expect(startIndex).toBeGreaterThanOrEqual(0)
  expect(endIndex).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

/** The single call to `name` inside `scope`; a missing or duplicated call reds. */
function onlyCall(scope: ts.Node, name: string): ts.CallExpression {
  const calls = probe.callsTo(scope, name)
  expect(
    calls.map((call) => probe.text(call).slice(0, 80)),
    `calls to ${name}`
  ).toHaveLength(1)
  return calls[0]
}

/** Nearest ancestor of `node` that `test` accepts; throws when there is none. */
function enclosing<T extends ts.Node>(
  node: ts.Node,
  test: (candidate: ts.Node) => candidate is T
): T {
  for (let current = node.parent; current; current = current.parent) {
    if (test(current)) return current
  }
  throw new Error(`${probe.text(node).slice(0, 80)} has no enclosing ${test.name}`)
}

/** A dependency's initializer on a `new X({ ... })` or `f({ ... })`, whitespace removed. */
function dep(call: ts.CallExpression | ts.NewExpression, name: string): string | undefined {
  return probe.propText(call, 0, name)?.replace(/\s+/g, '')
}

describe('execution graph main integration', () => {
  it('routes solo UltraTask through the durable unanchored graph owner', () => {
    const dispatcher = between(
      "} else if (toolName === 'ultra_task') {",
      "} else if (toolName === 'delegate_wave') {"
    )
    const initialization = between(
      'executionGraphRepositoryRef = executionGraphRepository',
      '// Phase C5 scaffold: APNs wake-on-approval.'
    )

    expect(dispatcher).toContain("markDispatchHandled('subthread-control')")
    expect(dispatcher).toContain('resolveUltraTaskToolRequest(')
    expect(dispatcher).toContain('listUltraTaskModelsRef')
    expect(dispatcher).toContain('buildUltraTaskModelCapabilityCatalog({')
    expect(dispatcher).toContain('resolveUltraTaskCapability({')
    expect(dispatcher).toContain("id: 'ultratask-graph-v1'")
    expect(dispatcher).toContain('resolved.model === context.model')
    expect(dispatcher).toContain("toolName: 'ultra_task'")
    expect(dispatcher).toContain('startUltraTaskGraphRef')
    expect(dispatcher).toContain("status: 'running'")
    expect(dispatcher).toContain('Every join is automatic')
    // The graph is unanchored (it dispatches its own work rather than waiting
    // on the initiating run) but it is NOT unowned: the handler stamps the
    // accountable thread/seat, and the result payload sends the seat to
    // ensemble_await instead of releasing it to report completion early.
    expect(dispatcher).toContain('owner: {')
    expect(dispatcher).toContain('threadId: parentChat.appChatId')
    expect(dispatcher).toContain('ensemble_await({ executionIds:')
    expect(dispatcher).toContain('Do not report completion before then.')
    expect(dispatcher).not.toContain('executeDelegateWaveTool(')
    expect(initialization).toContain('startUltraTaskGraphRef = (input) =>')
    expect(initialization).toContain('startPreparedUltraTaskGraph(input, {')
    expect(initialization).toContain('executionGraphCoordinator.startExecutionGraph(request)')
  })

  it('owns queue lease, composition, and adapter dispatch without a renderer pump', () => {
    const dispatcher = between(
      'const dispatchMainOwnedExecutionGraphAttempt =',
      'executionGraphAttemptDispatcher = dispatchMainOwnedExecutionGraphAttempt'
    )

    expect(dispatcher).toContain('resolveExecutionGraphQueueAuthority(appRunId)')
    expect(dispatcher).toContain('reserveConcurrentGraphChatDispatch')
    expect(dispatcher.indexOf('reserveConcurrentGraphChatDispatch')).toBeLessThan(
      dispatcher.indexOf('runQueueService.leaseJob')
    )
    expect(dispatcher.indexOf('resolveExecutionGraphQueueAuthority(appRunId)')).toBeLessThan(
      dispatcher.indexOf('runQueueService.leaseJob')
    )
    expect(dispatcher).toContain('composeMainOwnedExecutionGraphAttempt(appRunId)')
    const adapterDispatch = dispatcher.indexOf('const result = await runCoordinator.dispatch(')
    expect(adapterDispatch).toBeGreaterThanOrEqual(0)
    expect(dispatcher.indexOf('registerExecutionGraphRunTranscript')).toBeLessThan(adapterDispatch)
    expect(dispatcher).toMatch(/const result = await runCoordinator\.dispatch\(\s*entry\.payload,/)
    expect(dispatcher).toContain('recordPreSessionDispatchFailure')
    expect(dispatcher).toContain('releaseConcurrentGraphChatDispatch(graphReservation)')
  })

  it('keeps graph lanes independent from ordinary parent occupancy through adapter adoption', () => {
    const graphLeaseBypass = source.indexOf(
      'if (executionGraphBypassesOrdinaryChatOccupancy(job)) return true'
    )
    const ordinaryLeaseGuard = source.indexOf('const queueLeaseAlreadyHeld', graphLeaseBypass)
    expect(graphLeaseBypass).toBeGreaterThanOrEqual(0)
    expect(ordinaryLeaseGuard).toBeGreaterThan(graphLeaseBypass)

    const prelaunch = between(
      'const authorizeProviderAdapterLaunch =',
      'const runCoordinator = new RunCoordinator'
    )
    expect(prelaunch).toContain('executionGraphPrelaunchJobIsStarting(job.status)')
    expect(source).toContain('executionGraphLifecyclePairMatches({')
  })

  it('wires execution progress and durable results into the parent await', () => {
    const awaitBranch = between(
      "} else if (toolName === 'ensemble_await') {",
      "} else if (toolName === 'ensemble_lane_result') {"
    )
    expect(awaitBranch).toContain('getExecutionResultMailbox')
    expect(awaitBranch).toContain('projection.updatedAt')
    expect(awaitBranch).toContain('topology: projection.topology')
    expect(awaitBranch).toContain('activations: projection.activations')
  })

  it('excludes graph rows from owner-busy checks and cascades explicit parent stop', () => {
    const delivery = between(
      'const deliverSettledExecutionResult =',
      'const executionGraphCoordinator = new ExecutionGraphCoordinator'
    )
    expect(delivery.match(/hasNonGraphThreadTurn/g)).toHaveLength(2)
    expect(source).toContain('stopParentRunAndOwnedExecutions(')
    expect(source).toContain('return cancelExplicitParentRun(normalizedProvider, runIdString)')
  })

  it('commits the exact transcript result before graph settlement and queue projection', () => {
    const listener = between(
      'runManager.onChange((event) => {',
      'function recoverSubThreadWorkerQueues'
    )
    const graphReconciliationStart = listener.indexOf('const graphJobCandidate =')
    expect(graphReconciliationStart).toBeGreaterThanOrEqual(0)
    const graphReconciliation = listener.slice(graphReconciliationStart)

    expect(graphReconciliation).toContain('sealExecutionGraphRunTranscript(')
    expect(graphReconciliation).toContain('onRunSessionChange(')
    expect(graphReconciliation.indexOf('sealExecutionGraphRunTranscript(')).toBeLessThan(
      graphReconciliation.indexOf('onRunSessionChange(')
    )
    expect(graphReconciliation.indexOf('onRunSessionChange(')).toBeLessThan(
      graphReconciliation.indexOf('persistRunSessionQueueState(event.session)')
    )
  })

  it('does not punish an ordinary anchor run when Stack evidence is rejected', () => {
    const listener = between(
      'runManager.onChange((event) => {',
      'function recoverSubThreadWorkerQueues'
    )
    const graphReconciliationStart = listener.indexOf('const graphJobCandidate =')
    expect(graphReconciliationStart).toBeGreaterThanOrEqual(0)
    const graphReconciliation = listener.slice(graphReconciliationStart)
    const attemptRejection = graphReconciliation.indexOf(
      "if (graphOwnedRun && graphDisposition !== 'accepted')"
    )
    const anchorWarning = graphReconciliation.indexOf("if (graphDisposition === 'rejected')")
    const ordinaryPersistence = graphReconciliation.indexOf(
      'persistRunSessionQueueState(event.session)'
    )

    expect(attemptRejection).toBeGreaterThanOrEqual(0)
    expect(anchorWarning).toBeGreaterThan(attemptRejection)
    expect(ordinaryPersistence).toBeGreaterThan(anchorWarning)
  })

  it('lets unrelated chat deletion bypass unavailable graph authority', () => {
    const deletion = between(
      'const clearExecutionGraphForHistoryPreparation =',
      'const broadHistoryDeletionCoordinator ='
    )
    const presenceCheck = deletion.indexOf(
      'ExecutionGraphRepository.storageRootMentionsRootChat(storageRoot, target.chatId)'
    )
    const unavailableError = deletion.indexOf(
      'Execution-graph chat history could not be quiesced during recovery.'
    )

    expect(presenceCheck).toBeGreaterThanOrEqual(0)
    expect(unavailableError).toBeGreaterThan(presenceCheck)
    expect(deletion).toContain('ExecutionGraphRepository.storageRootMentionsWorkspace(')
  })

  it('keeps graph diagnostics available across initialization and recovery failures', () => {
    // Initialization: the diagnostics query, and the retry/archive commands
    // beside it, register before the repository is constructed, so a throw
    // there leaves them answering with the reason instead of no handler.
    const [repository] = probe.construction('ExecutionGraphRepository')
    const diagnosticsQuery = onlyCall(probe.source, 'registerExecutionGraphDiagnosticsHandler')
    const recoveryCommands = onlyCall(probe.source, 'registerExecutionGraphRecoveryHandlers')
    expect(diagnosticsQuery.getStart()).toBeLessThan(repository.getStart())
    expect(recoveryCommands.getStart()).toBeLessThan(repository.getStart())
    expect(dep(diagnosticsQuery, 'getSnapshot')).toBe('getExecutionGraphDiagnosticsSnapshot')
    expect(dep(recoveryCommands, 'getSnapshot')).toBe('getExecutionGraphDiagnosticsSnapshot')

    // The snapshot reads the repository through its nullable ref, and the
    // recovery and service lists from the two `let`s everything else writes.
    const [snapshot] = probe.objectLiterals(probe.fn('getExecutionGraphDiagnosticsSnapshot'))
    expect(probe.propOf(snapshot, 'repositoryDiagnostics')?.replace(/\s+/g, '')).toBe(
      'executionGraphRepositoryRef?.listRepositoryDiagnostics()??[]'
    )
    expect(probe.propOf(snapshot, 'recoveryDiagnostics')).toBe('executionGraphRecoveryDiagnostics')
    expect(probe.propOf(snapshot, 'serviceDiagnostics')).toBe('executionGraphServiceDiagnostics')

    // An initialization failure nulls the coordinator ref (which the recovery
    // controller reads, so the launch pass falls back to nothing paused) and
    // records the reason on the service list.
    const initializationFailure = enclosing(repository, ts.isTryStatement).catchClause
    expect(initializationFailure).toBeDefined()
    expect(probe.assignmentsTo(initializationFailure!, 'executionGraphCoordinatorRef')).toEqual([
      'null'
    ])
    expect(
      probe.assignmentsTo(initializationFailure!, 'executionGraphServiceDiagnostics').join(' ')
    ).toContain("code: 'initialization_failed'")

    // Recovery runs from the owner-metadata starter's timer, out of reach of
    // the try/catch around the starter (which covers only a synchronous
    // throw). Each startup pass is the recover callback; the controller picks
    // the owners it preloads, keeps the paused set in the snapshot's recovery
    // list, and hears every failed pass, reporting one that keeps failing on
    // the service list. ExecutionGraphStartupRecovery.test.ts proves that
    // through the real starter.
    const starter = onlyCall(probe.source, 'startCatalogueExecutionRecovery')
    expect(dep(starter, 'recover')).toBe(
      '()=>{executionGraphRecoveryController.runStartupRecovery()}'
    )
    expect(dep(starter, 'ownerIds')).toBe('()=>executionGraphRecoveryController.startupOwnerIds()')
    expect(dep(starter, 'onError')).toBe(
      '(error,retrying)=>executionGraphRecoveryController.startupPassFailed(error,retrying)'
    )
    expect(
      probe
        .assignmentsTo(
          enclosing(starter, ts.isTryStatement).catchClause!,
          'executionGraphServiceDiagnostics'
        )
        .join(' ')
    ).toContain("code: 'startup_recovery_failed'")
    const [controller] = probe.construction('ExecutionGraphRecoveryController')
    expect(dep(controller, 'coordinator')).toBe('()=>executionGraphCoordinatorRef')
    expect(dep(controller, 'readDiagnostics')).toBe('()=>executionGraphRecoveryDiagnostics')
    expect(dep(controller, 'writeDiagnostics')).toBe(
      '(next)=>{executionGraphRecoveryDiagnostics=next}'
    )
    expect(dep(controller, 'readServiceDiagnostics')).toBe('()=>executionGraphServiceDiagnostics')
    expect(dep(controller, 'writeServiceDiagnostics')).toBe(
      '(next)=>{executionGraphServiceDiagnostics=next}'
    )
  })

  it('recovers the ordinary queue before the graph coordinator at startup', () => {
    const recovery = probe.fn('runDeferredWorkspaceLockRecovery')
    const queueRecovery = onlyCall(recovery, 'recoverRunQueueAfterStartup')
    const starter = onlyCall(recovery, 'startCatalogueExecutionRecovery')

    // Queue recovery is synchronous and has settled before the starter is
    // even called; the starter only schedules the graph's launch pass.
    expect(queueRecovery.getStart()).toBeLessThan(starter.getStart())

    // One gate for both, so no launch runs graph recovery after skipping the
    // queue recovery it depends on. The gate may gain `&& !<reason>`
    // conjuncts; each only narrows when recovery runs.
    const gate = enclosing(queueRecovery, ts.isIfStatement)
    expect(enclosing(starter, ts.isIfStatement).getStart()).toBe(gate.getStart())
    expect(probe.text(gate.expression)).toContain('!historyDeletionStartupRecoveryBlockedReason')

    // And that starter is the only way in: the launch pass is called from its
    // recover callback and nowhere else, and nothing here drives the graph
    // coordinator's recovery around the controller. (Other services have
    // their own `recover` methods, so the receiver is what is checked.)
    expect(probe.callsTo(starter, 'runStartupRecovery')).toHaveLength(1)
    expect(probe.callsTo(probe.source, 'runStartupRecovery')).toHaveLength(1)
    const direct = [
      ...probe.callsTo(probe.source, 'recover'),
      ...probe.callsTo(probe.source, 'recoverExecutions')
    ]
      .map((call) => probe.text(call))
      .filter((call) => call.includes('executionGraphCoordinator'))
    expect(direct).toEqual([])
  })

  it('tells recovery about a graph lease before anything can run between them', () => {
    // Startup recovery parks a claimed attempt whose queue row is past
    // `queued` unless this process leased it, and the boot sweep leases
    // queued attempts before the deferred launch pass runs. With no await
    // between the lease and the note, no recovery pass can land between them.
    const dispatcher = probe.fn('dispatchMainOwnedExecutionGraphAttempt')
    const lease = onlyCall(dispatcher, 'leaseJob')
    const note = onlyCall(dispatcher, 'noteDispatchLease')
    const compose = onlyCall(dispatcher, 'composeMainOwnedExecutionGraphAttempt')
    expect(probe.text(note).replace(/\s+/g, '')).toBe(
      'executionGraphCoordinatorRef?.noteDispatchLease(appRunId)'
    )
    expect(lease.getEnd()).toBeLessThan(note.getStart())
    expect(note.getEnd()).toBeLessThan(compose.getStart())

    const awaits: ts.AwaitExpression[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isAwaitExpression(node)) awaits.push(node)
      ts.forEachChild(node, visit)
    }
    visit(dispatcher)
    expect(awaits.length).toBeGreaterThan(0)
    expect(
      awaits
        .filter((node) => node.getStart() > lease.getEnd() && node.getStart() < note.getStart())
        .map((node) => probe.text(node))
    ).toEqual([])

    // The dispatcher is the only way a graph row is leased, so no other lease is noted.
    expect(probe.callsTo(probe.source, 'noteDispatchLease')).toHaveLength(1)
  })

  it('delivers committed predecessor results as exact named data inputs before composition', () => {
    const composer = between(
      'const graphOwnedComposerInput =',
      'const composeMainOwnedExecutionGraphAttempt ='
    )

    expect(composer).toContain("predecessorAttempt.state !== 'succeeded'")
    expect(composer).toContain('!predecessorAttempt.result')
    expect(composer).toContain('verifyExecutionGraphAttemptReceiptOnChat')
    expect(composer).toContain("edge.kind === 'data'")
    expect(composer).toContain('bindExecutionGraphInputsToRequest(')
    expect(composer).toContain('Execution graph bound input prompt changed before composition.')
    // Pre-data-edge linear Stacks retain their one-predecessor compatibility envelope.
    expect(composer).toContain('formatExecutionGraphPredecessorResults(')
    expect(composer).toContain("contextIsolation: 'execution_graph'")
  })

  it('signs and persists the bound prompt while retaining the reusable template proof', () => {
    const initialization = between(
      'materializePausedQueueJob: (input) => {',
      'getQueueJob: (runId) => {'
    )
    const authority = between(
      'const resolveExecutionGraphQueueAuthority =',
      'const graphOwnedComposerInput ='
    )

    expect(initialization).toContain(
      'const request = bindExecutionGraphInputsToRequest(templateRequest, input.inputs)'
    )
    expect(initialization).toContain('request: templateRequest')
    expect(initialization).toContain('attemptRequest: request')
    expect(initialization).toContain('request: { ...request, sessionTrust: false }')
    expect(authority).toContain('request: { ...job.request, prompt: templateRequest.prompt }')
  })

  it('persists the exact adapter prompt and rechecks predecessor receipts before launch', () => {
    const transcript = between(
      'function registerExecutionGraphRunTranscript',
      'function boundedExecutionGraphTranscriptError'
    )
    const dispatcher = between(
      'const dispatchMainOwnedExecutionGraphAttempt =',
      'executionGraphAttemptDispatcher = dispatchMainOwnedExecutionGraphAttempt'
    )

    expect(transcript).toContain('prompt: args.entry.payload.prompt')
    const adapterDispatch = dispatcher.indexOf('const result = await runCoordinator.dispatch(')
    expect(adapterDispatch).toBeGreaterThanOrEqual(0)
    expect(dispatcher.indexOf('graphOwnedComposerInput(appRunId)')).toBeLessThan(adapterDispatch)
  })

  it('defers eager terminal projection for graph attempts and every tracked exact transport', () => {
    const cancellation = between(
      'async function terminateExactProviderSession',
      'async function cancelProviderRun'
    )

    expect(cancellation).toContain(
      'const graphOwnedAttempt = executionGraphOwnsAttemptRunId(runId)'
    )
    expect(cancellation).toContain('const deferEagerTerminalization =')
    expect(cancellation).toContain('shouldDeferEagerProviderTerminalization({')
    expect(cancellation).toContain(
      'exactTransportOperationTracked: Boolean(providerTransportOperations.get(runId))'
    )
    expect(cancellation).toContain('if (!deferEagerTerminalization) {')
    expect(cancellation).toContain('runManager.finish(runId, terminalStatus)')
    expect(cancellation).toContain('hasCommittedExecutionGraphTerminalReceipt')
    expect(cancellation).toContain('runManager.onChange')
    expect(cancellation).toContain('setTimeout(() => finish(false), 15_000)')
  })

  it('bounds unresolved two-sided terminal joins without timing ordinary provider work', () => {
    const watchdog = between(
      'function armExecutionGraphTerminalJoinWatchdog',
      'function isExecutionGraphIsolatedPayload'
    )
    const containment = between(
      'async function containExecutionGraphTerminalJoin',
      'function hasCommittedExecutionGraphTerminalReceipt'
    )
    const registration = between('function registerRunSession(', 'function getRuntimeSession(')

    expect(watchdog).toContain('decideExecutionGraphTerminalJoinWatchdog')
    expect(watchdog).toContain('runManager.getTerminalJoinState(runId)')
    expect(registration).toContain('armExecutionGraphTerminalJoinWatchdog')
    expect(containment).toContain('terminateExactProviderSession')
    expect(containment).toContain("runManager.containTerminalJoin(runId, 'failed')")
  })

  it('contains adapter rejection after an exact provider session was registered', () => {
    const dispatcher = between(
      'const dispatchMainOwnedExecutionGraphAttempt =',
      'executionGraphAttemptDispatcher = dispatchMainOwnedExecutionGraphAttempt'
    )

    expect(dispatcher).toContain('const registeredSession = runManager.get(appRunId)')
    expect(dispatcher).toContain('terminateExactProviderSession')
    expect(dispatcher).toContain("runManager.finish(appRunId, 'failed')")
    expect(dispatcher).toContain('armExecutionGraphTerminalJoinWatchdog(appRunId)')
  })

  it('rejects renderer composition, dispatch, and queue leases for graph attempts', () => {
    expect(source).toContain(
      "throw new Error('Execution graph attempts are composed and dispatched by MAIN only.')"
    )
    expect(source).toContain(
      "throw new Error('Execution graph attempts are dispatched by MAIN, not the renderer.')"
    )
    expect(source).toContain(
      "throw new Error('Execution graph queue leases are acquired by MAIN only.')"
    )
  })

  it('reserves terminal Stack anchors and canonical queue aliases centrally', () => {
    const ownership = between(
      'function executionGraphOwnsOrAnchorsRunId',
      'function getActiveTaskWraithThreadCount'
    )
    const registration = between('function registerRunSession(', 'function getRuntimeSession(')

    expect(ownership).toContain('isExecutionGraphReservedRunIdentity')
    expect(ownership).toContain('listExecutions({ includeTerminal: true })')
    expect(registration).toContain('listExecutions({ includeTerminal: true })')
    expect(registration).toContain('cannot use an alias of a graph-owned identity')
  })

  it('rechecks current permission policy at the final queue authority boundary', () => {
    const resolver = between(
      'const resolveExecutionGraphQueueAuthority =',
      'const graphOwnedComposerInput ='
    )

    expect(resolver).toContain('buildExecutionGraphPermissionPosture')
    expect(resolver).toContain('assertExecutionGraphPermissionPostureStillCurrent')
  })

  it('freezes and revalidates the immutable built-in runtime profile', () => {
    const initialization = between(
      'const resolveStackRuntimeProfile =',
      '// Phase C5 scaffold: APNs wake-on-approval.'
    )
    const resolver = between(
      'const resolveExecutionGraphQueueAuthority =',
      'const graphOwnedComposerInput ='
    )

    expect(initialization).toContain('profile.builtin !== true')
    expect(initialization).toContain("profile.scope !== 'workspace'")
    expect(initialization).toContain("profile.workspaceMode !== 'local'")
    expect(initialization).toContain('buildRuntimeProfileAuthority(profile)')
    expect(initialization).toContain('resolveFrozenStackRuntimeProfile(')
    expect(initialization).toContain('runtimeSettings(AppStore.getSettings(), runtimeProfile)')
    expect(initialization).not.toContain(
      'V1 Stack execution does not support mutable runtime profiles.'
    )
    expect(resolver).toContain('resolveFrozenStackRuntimeProfile(')
    expect(resolver).toContain('runtimeSettings(AppStore.getSettings(), runtimeProfile)')
  })

  it('admits the exact main-owned MCP profile prompt normalization', () => {
    // Anchored on the declared name, not on the shape of its call site. The
    // previous version sliced from the literal
    // `authorizeBeforeAdapterRun: (payload, reservation) => {`; extracting that
    // inline arrow to a named function broke the test without changing any
    // behaviour it claimed to protect.
    const authorize = probe.fn('authorizeProviderAdapterLaunch')

    const sanitizeCalls = probe.callsTo(authorize, 'sanitizeTaskWraithMcpPromptClaims')
    expect(sanitizeCalls).toHaveLength(1)
    expect(probe.argText(sanitizeCalls[0], 0)).toBe('admission.payload.prompt')

    // The admitted prompt is re-derived through the sanitizer and the payload
    // is compared against THAT. Comparing against the raw admitted prompt is
    // the regression this guards — see the behavioural test below for why.
    expect(probe.comparesStrictly(authorize, 'payload.prompt', 'admittedPrompt')).toBe(true)
    expect(probe.comparesStrictly(authorize, 'payload.prompt', 'admission.payload.prompt')).toBe(
      false
    )
  })

  it('re-derives the admitted prompt because the raw one no longer matches', () => {
    // The wiring assertion above is only worth having if the sanitizer actually
    // changes the prompt — otherwise raw and sanitized compare equal and the
    // "wrong" comparison would be harmless. This runs the real function on a
    // real composed prompt, so the structural claim rests on measured behaviour
    // rather than on the assumption that the call matters.
    const composed = `${TASKWRAITH_CORE_MCP_PROFILE_NOTE}\n\nSummarize the diff.`
    const sanitizeOptions = {
      advertised: true,
      coreProfile: false,
      gatewayProfile: false,
      injectCoreNote: false,
      injectGatewayNote: false,
      targetProvider: 'codex' as const
    }

    const admitted = sanitizeTaskWraithMcpPromptClaims(composed, sanitizeOptions)

    expect(admitted).not.toBe(composed)
    // So a raw `payload.prompt !== admission.payload.prompt` would reject a
    // legitimate dispatch with "identity changed before launch".
    expect(admitted).toBe(sanitizeTaskWraithMcpPromptClaims(admitted, sanitizeOptions))
  })
})
