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
  it('serializes the one shared client and private home around the whole provider run', () => {
    const provider = section(
      'async function runCodexAppServer(',
      'async function runCodexAppServerWithClient('
    )

    expect(provider).toContain('acquireCodexClientLifecycleLease(`provider-run:${runId}`)')
    expect(provider).toContain('workspaceLockRunLifecycle.run(runId, async () => {')
    expect(provider).toContain('await disposeCodexClientForOwnerTransition(lifecycleLease)')
    expect(provider).toContain('createCodexWorkspaceLockStartupBinding(payload)')
    expect(provider).toContain('client.setWorkspaceLockOwnerId(lockBinding.ownerId)')
    expect(provider).toContain('bindCodexRunClient(runId, client, lifecycleLease)')
    expect(provider).toContain('await finishCodexClientLifecycle(client, lifecycleLease)')
    expect(provider).toContain('lifecycleLease.release()')
    expect(provider).not.toContain('createDedicatedWorkspaceLockClient')
  })

  it('transfers the exact admission before initialize and retains it without tree-death proof', () => {
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
    expect(binding).toContain(
      'workspaceLockProviderCoordinator.transferToChild(key, process.pid)'
    )
    expect(binding).toContain('void process.closed.then(() => {')
    expect(binding).toContain('retaining workspace-lock acquisition')
    expect(binding).not.toContain('releaseChild(')
    expect(binding).toContain(
      'workspaceLockProviderCoordinator.releaseSetupFailure(key, admission)'
    )

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
    const dispatch = section(
      'function dispatchCodexMessageFromClient(',
      'function getCodexClient('
    )
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
})
