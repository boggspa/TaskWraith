import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

function section(start: string, end: string): string {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  expect(startIndex, `missing section start: ${start}`).toBeGreaterThanOrEqual(0)
  expect(endIndex, `missing section end: ${end}`).toBeGreaterThan(startIndex)
  return source.slice(startIndex, endIndex)
}

// Line breaks inside a wired-up callback are formatting, not meaning.
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ')
}

describe('Codex production workspace-lock lifecycle wiring', () => {
  it('shares only a compatible client cohort and tears it down after its last run', () => {
    const provider = section(
      'async function runCodexAppServer(',
      'async function runCodexAppServerWithClient('
    )
    const cohort = section(
      'async function acquireCodexProviderClientRunLease(',
      '/**\n * 1.0.4-AD — pre-flight reachability probe'
    )

    expect(provider).toContain('workspaceLockRunLifecycle.run(runId, async () => {')
    expect(provider).toContain('createCodexWorkspaceLockStartupBinding(payload)')
    expect(provider).toContain('acquireCodexProviderClientRunLease(')
    expect(provider).toContain('bindCodexRunClient(runId, client, runClientLease.lifecycleLease)')
    expect(provider).toContain('await runClientLease.cohortLease.release()')
    expect(cohort).toContain('codexProviderClientCohorts.tryJoin(runId, compatibilityKey)')
    expect(cohort).toContain(
      "workspaceLockOwnerId ? `${workspaceLockOwnerId}\\0${runId}` : 'unowned'"
    )
    expect(cohort).toContain('await disposeCodexClientForOwnerTransition(lifecycleLease)')
    expect(cohort).toContain('client.setWorkspaceLockOwnerId(workspaceLockOwnerId)')
    expect(cohort).toContain('async () => finishCodexClientLifecycle(client!, lifecycleLease)')
    expect(cohort).toContain('() => lifecycleLease.release()')
    expect(provider).not.toContain('createDedicatedWorkspaceLockClient')
  })

  it('transfers before initialize and scopes unproven tree death to the retained lease', () => {
    const binding = section(
      'function createCodexWorkspaceLockStartupBinding(',
      'async function runCodexAppServer('
    )
    const provider = section(
      'async function runCodexAppServerWithClient(',
      'async function runCodexExecFallback('
    )

    expect(binding).toContain('workspaceLockProviderCoordinator.get(key)')
    expect(binding).toContain('ownerId: admission.owner.lockOwnerId')
    expect(binding).toContain('workspaceLockProviderCoordinator.transferToChild(key, process.pid)')
    expect(binding).toContain('void process.closed.then(() => {')
    expect(binding).toContain('retaining workspace-lock acquisition')
    expect(binding).toContain('retainAsScopedQuarantine(')
    expect(binding).toContain('retainAfterIntegrityFailure(')
    expect(binding).toContain('.quarantineChildForRecovery(key, childReceipt)')
    expect(binding).not.toContain('const unprovenTreeHold')
    expect(binding).not.toContain('releaseChild(')
    expect(binding).toContain(
      'workspaceLockProviderCoordinator.releaseSetupFailure(key, admission)'
    )
    const closeHandler = binding.slice(
      binding.indexOf('void process.closed.then(() => {'),
      binding.indexOf('settleAfterClientClosed: async (clientDeathProven) => {')
    )
    expect(closeHandler).toContain('quarantineTransferredChild(')
    expect(closeHandler).not.toContain('retainAfterIntegrityFailure(')

    const bindIndex = provider.indexOf('...(bindSpawnedProcess ? { bindSpawnedProcess } : {})')
    const initializeIndex = provider.indexOf('buildCodexAppServerThreadLaunchPlan({')
    expect(bindIndex).toBeGreaterThanOrEqual(0)
    expect(initializeIndex).toBeGreaterThan(bindIndex)
  })

  it('routes callbacks, interrupts, goals, and approvals through the originating run client', () => {
    const provider = section(
      'async function runCodexAppServerWithClient(',
      'async function runCodexExecFallback('
    )
    const dispatch = section('function dispatchCodexMessageFromClient(', 'function getCodexClient(')
    const notifications = section(
      'function handleCodexNotification(',
      'function formatCodexApprovalRequest('
    )
    const approvals = section(
      'function handleCodexServerRequest(',
      'function maybeRequestCodexHostRerun('
    )

    // Each run wires its OWN client into both callbacks, so the frame carries
    // the identity of the connection that delivered it.
    expect(collapse(provider)).toContain(
      'client.setNotificationHandler((message) => handleCodexNotificationFromClient(message, client)'
    )
    expect(collapse(provider)).toContain(
      'client.setRequestHandler((message) => handleCodexServerRequestFromClient(message, client)'
    )
    // A bare handler reference would erase that identity and re-open the
    // ambient-client route these guards exist to close.
    expect(provider).not.toContain('setNotificationHandler(handleCodexNotification)')
    expect(provider).not.toContain('setRequestHandler(handleCodexServerRequest)')

    // The origin stamp lives only for the duration of the dispatch, and a frame
    // two client lifecycles both claim poisons instead of picking one.
    expect(dispatch).toContain('codexMessageOriginClients.get(message)')
    expect(dispatch).toContain('poisonWorkspaceLockMutationAdmission(')
    expect(dispatch).toContain('codexMessageOriginClients.set(message, client)')
    expect(dispatch).toContain('codexMessageOriginClients.delete(message)')

    // Callbacks, interrupts and goals read the originating client off the frame
    // and refuse any run state bound to a different one.
    expect(collapse(notifications)).toMatch(
      /^function handleCodexNotification\(message: any\) \{ const originatingClient = [^{}]*codexMessageOriginClients\.get\(message\)[^{}]*if \(!originatingClient\) return\b/
    )
    expect(notifications).toContain('codexClientForRunState(state) !== originatingClient')
    expect(notifications).toContain(
      'syncCodexNativeGoalNotification(state, message, originatingClient)'
    )
    // EVERY interrupt this handler fires — not merely one of them — is aimed at
    // the connection the notification arrived on.
    const notificationInterrupts =
      notifications.replace(/\s+/g, '').match(/issueCodexTurnInterrupt\([^,)]*/g) ?? []
    expect(notificationInterrupts.length).toBeGreaterThan(0)
    for (const interrupt of notificationInterrupts) {
      expect(interrupt).toBe('issueCodexTurnInterrupt(originatingClient')
    }

    // Approvals are answered on the client that asked for them.
    expect(collapse(approvals)).toMatch(
      /^function handleCodexServerRequest\(message: any\) \{ const respondingClient = [^{}]*codexMessageOriginClients\.get\(message\)[^{}]*if \(!respondingClient\) return\b/
    )
    expect(approvals).toContain('codexClientForRunState(state) !== respondingClient')
    const approvalReplies =
      approvals.replace(/\s+/g, '').match(/[A-Za-z0-9_.!]*\.(?:respond|reject)\(/g) ?? []
    expect(approvalReplies.length).toBeGreaterThan(0)
    for (const reply of approvalReplies) {
      expect(reply).toMatch(/^respondingClient\.(?:respond|reject)\($/)
    }
    expect(source).toContain('getCodexClient: onlyBoundCodexRunClient')
    const stderr = section(
      'function handleCodexStderrFromClient(',
      'interface CodexClientStartupConfiguration'
    )
    expect(stderr).toContain('if (states.length !== 1)')
    expect(stderr).toContain(
      "console.warn('[codex] shared app-server stderr lacked exact turn attribution', chunk)"
    )
    expect(stderr).toContain("sendAgentCompatError(states[0].sender!, 'codex', chunk, states[0])")
  })

  it('puts maintenance and native review users of the same client on the lifecycle queue', () => {
    const compaction = section(
      'async function compactCodexProviderContext(',
      'async function compactCodexProviderContextWithClient('
    )
    const review = section(
      "'start-agent-review'",
      '// Single source for per-provider model catalogs'
    )

    expect(compaction).toContain('acquireCodexClientLifecycleLease(')
    expect(compaction).toContain('disposeCodexClientForOwnerTransition(lifecycleLease)')
    expect(compaction).toContain('finishCodexClientLifecycle(client, lifecycleLease)')
    expect(review).toContain('acquireCodexClientLifecycleLease(')
    expect(review).toContain('disposeCodexClientForOwnerTransition(reviewClientLifecycleLease)')
    expect(review).toContain('await reviewTurnOperation')
    expect(review).toContain(
      'await finishCodexClientLifecycle(reviewClient, reviewClientLifecycleLease)'
    )
  })

  it('borrows the active cohort for automatic thread listing without fencing later runs', () => {
    const helper = section(
      'async function withUnownedCodexClientLifecycle<T>(',
      'function createSerializedCodexThreadClientFacade()'
    )
    const registration = section(
      'registerCodexThreadHandlers({',
      "ipcMain.handle(\n      'start-agent-review'"
    )

    expect(helper).toContain('codexProviderClientCohorts.tryBorrow(')
    expect(helper).toContain('acquireCodexClientLifecycleLease(label, options.signal)')
    expect(helper).not.toContain('codexProviderClientCohorts.stopAccepting()')
    expect(collapse(registration)).toContain(
      "listCodexThreads: (params, timeoutMs) => withUnownedCodexClientLifecycle( 'thread-list'"
    )
    expect(registration).toContain('borrowActiveProviderClient: true')
    expect(registration).toContain('signal: AbortSignal.timeout(timeoutMs)')
    expect(registration).toContain("return client.request('thread/list', params, timeoutMs)")
  })

  it('keeps ensemble reachability probing outside the client lifecycle queue', () => {
    const probe = section(
      'async function probeCodexParticipant(',
      'async function probeCliParticipant('
    )

    expect(probe).toContain("resolveCliProviderBinary('codex', runtimeProfile ?? null)")
    expect(probe).not.toContain('withUnownedCodexClientLifecycle(')
    expect(probe).not.toContain('ensureStarted(')
  })
})
