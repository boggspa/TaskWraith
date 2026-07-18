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

describe('execution graph main integration', () => {
  it('owns queue lease, composition, and adapter dispatch without a renderer pump', () => {
    const dispatcher = between(
      'const dispatchMainOwnedExecutionGraphAttempt =',
      'executionGraphAttemptDispatcher = dispatchMainOwnedExecutionGraphAttempt'
    )

    expect(dispatcher).toContain('resolveExecutionGraphQueueAuthority(appRunId)')
    expect(dispatcher).toContain('reserveExclusiveChatDispatch')
    expect(dispatcher.indexOf('reserveExclusiveChatDispatch')).toBeLessThan(
      dispatcher.indexOf('runQueueService.leaseJob')
    )
    expect(dispatcher.indexOf('resolveExecutionGraphQueueAuthority(appRunId)')).toBeLessThan(
      dispatcher.indexOf('runQueueService.leaseJob')
    )
    expect(dispatcher).toContain('composeMainOwnedExecutionGraphAttempt(appRunId)')
    expect(dispatcher.indexOf('registerExecutionGraphRunTranscript')).toBeLessThan(
      dispatcher.indexOf('runCoordinator.dispatch(entry.payload')
    )
    expect(dispatcher).toContain('runCoordinator.dispatch(entry.payload')
    expect(dispatcher).toContain('recordPreSessionDispatchFailure')
    expect(dispatcher).toContain('releaseExclusiveChatDispatch(exclusiveReservation)')
  })

  it('commits the exact transcript result before graph settlement and queue projection', () => {
    const listener = between('runManager.onChange((event) => {', 'function recoverSubThreadWorkerQueues')

    expect(listener).toContain('sealExecutionGraphRunTranscript(')
    expect(listener).toContain('onRunSessionChange(')
    expect(listener.indexOf('sealExecutionGraphRunTranscript(')).toBeLessThan(
      listener.indexOf('onRunSessionChange(')
    )
    expect(listener.indexOf('onRunSessionChange(')).toBeLessThan(
      listener.indexOf('persistRunSessionQueueState(event.session)')
    )
  })

  it('delivers committed predecessor results as untrusted data before composition', () => {
    const composer = between(
      'const graphOwnedComposerInput =',
      'const composeMainOwnedExecutionGraphAttempt ='
    )

    expect(composer).toContain("predecessorAttempt.state !== 'succeeded'")
    expect(composer).toContain('!predecessorAttempt.result')
    expect(composer).toContain('verifyExecutionGraphAttemptReceiptOnChat')
    expect(composer).toContain('formatExecutionGraphPredecessorResults(')
    expect(composer).toContain("contextIsolation: 'execution_graph'")
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
    expect(dispatcher.indexOf('graphOwnedComposerInput(appRunId)')).toBeLessThan(
      dispatcher.indexOf('runCoordinator.dispatch(entry.payload')
    )
  })

  it('waits for provider exit and a committed receipt before confirming graph cancellation', () => {
    const cancellation = between(
      'async function terminateExactProviderSession',
      'async function cancelProviderRun'
    )

    expect(cancellation).toContain('if (!graphOwnedAttempt) runManager.finish')
    expect(cancellation).toContain('hasCommittedExecutionGraphTerminalReceipt')
    expect(cancellation).toContain('runManager.onChange')
    expect(cancellation).toContain('setTimeout(() => finish(false), 15_000)')
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
})
