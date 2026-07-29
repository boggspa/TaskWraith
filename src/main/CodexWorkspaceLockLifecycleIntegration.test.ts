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
    const notifications = section(
      'function handleCodexNotification(',
      'function formatCodexApprovalRequest('
    )
    const approvals = section(
      'function handleCodexServerRequest(',
      'function maybeRequestCodexHostRerun('
    )

    expect(provider).toContain(
      'client.setNotificationHandler((message) => handleCodexNotification(message, client))'
    )
    expect(provider).toContain(
      'client.setRequestHandler((message) => handleCodexServerRequest(message, client))'
    )
    expect(notifications).toContain('codexClientForRunState(state) !== originatingClient')
    expect(notifications).toContain(
      'syncCodexNativeGoalNotification(state, message, originatingClient)'
    )
    expect(approvals).toContain('codexClientForRunState(state) !== respondingClient')
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
