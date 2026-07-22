import { resolve as resolvePath } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  HostCommandOperationRegistry,
  type HostCommandChildHandle,
  type HostCommandOperationController,
  type HostCommandOperationIdentityInput
} from './HostCommandOperationRegistry'

class FakeHostCommandChild implements HostCommandChildHandle {
  readonly events: string[] = []
  readonly signals: Array<'SIGTERM' | 'SIGKILL'> = []
  private closeListener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined

  once(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this {
    this.events.push(`listen:${event}`)
    this.closeListener = listener
    return this
  }

  kill(signal: 'SIGTERM' | 'SIGKILL'): boolean {
    this.events.push(`kill:${signal}`)
    this.signals.push(signal)
    return true
  }

  close(code: number | null = null, signal: NodeJS.Signals | null = null): void {
    const listener = this.closeListener
    this.closeListener = undefined
    listener?.(code, signal)
  }
}

function identity(
  operationId: string,
  overrides: Partial<HostCommandOperationIdentityInput> = {}
): HostCommandOperationIdentityInput {
  return {
    operationId,
    appRunId: 'run-a',
    appChatId: 'chat-a',
    workspaceId: 'workspace-a',
    workspacePath: '/workspace/a',
    ...overrides
  }
}

async function expectPending(operation: Promise<void>): Promise<void> {
  let settled = false
  void operation.then(() => {
    settled = true
  })
  await Promise.resolve()
  expect(settled).toBe(false)
}

function finishWithoutChild(controller: HostCommandOperationController): void {
  controller.markNoChild()
  controller.markTerminalProjectionComplete()
}

describe('HostCommandOperationRegistry', () => {
  it('registers exact ownership before spawn and rejects concurrent identity reuse', async () => {
    const registry = new HostCommandOperationRegistry()
    const controller = registry.register(identity('host-op-a'))

    expect(registry.get('host-op-a')).toBe(controller)
    expect(registry.hasRun('run-a')).toBe(true)
    expect(controller.identity).toEqual({
      operationId: 'host-op-a',
      appRunId: 'run-a',
      appChatId: 'chat-a',
      workspaceId: 'workspace-a',
      workspacePath: resolvePath('/workspace/a')
    })
    expect(() => registry.register(identity('host-op-a'))).toThrow('already active')

    finishWithoutChild(controller)
    await controller.completion
    await Promise.resolve()
    expect(registry.get('host-op-a')).toBeUndefined()
    expect(registry.hasRun('run-a')).toBe(false)
    const nextGeneration = registry.register(identity('host-op-a'))
    finishWithoutChild(nextGeneration)
    await nextGeneration.completion
  })

  it('requires actual close and terminal projection in either ordering', async () => {
    const registry = new HostCommandOperationRegistry()
    const closeFirst = registry.register(identity('close-first'))
    const closeFirstChild = new FakeHostCommandChild()
    expect(closeFirst.attachChild(closeFirstChild)).toBe(true)
    closeFirstChild.close(0)
    expect(closeFirst.transportState).toBe('closed')
    await expectPending(closeFirst.completion)
    closeFirst.markTerminalProjectionComplete()
    await closeFirst.completion

    const projectionFirst = registry.register(identity('projection-first'))
    const projectionFirstChild = new FakeHostCommandChild()
    projectionFirst.attachChild(projectionFirstChild)
    projectionFirst.markTerminalProjectionComplete()
    await expectPending(projectionFirst.completion)
    projectionFirstChild.close(0)
    await projectionFirst.completion
  })

  it('allows explicit no-child proof but forbids contradictory transport evidence', async () => {
    const registry = new HostCommandOperationRegistry()
    const noChild = registry.register(identity('no-child'))
    noChild.markNoChild()
    noChild.markNoChild()
    expect(() => noChild.attachChild(new FakeHostCommandChild())).toThrow('from no-child')
    noChild.markTerminalProjectionComplete()
    await noChild.completion

    const attached = registry.register(identity('attached'))
    attached.attachChild(new FakeHostCommandChild())
    expect(() => attached.markNoChild()).toThrow('from attached')
    expect(() => attached.attachChild(new FakeHostCommandChild())).toThrow('from attached')
  })

  it('fails closed when cancellation wins before child attachment', async () => {
    vi.useFakeTimers()
    try {
      const registry = new HostCommandOperationRegistry()
      const controller = registry.register(identity('pre-attach'), { killGraceMs: 50 })
      const cancellation = registry.beginCancellation(
        { kind: 'chat', chatIds: ['chat-a'] },
        'chat-history-deletion'
      )
      expect(cancellation.operationIds).toEqual(['pre-attach'])
      expect(controller.cancelled).toBe(true)
      expect(controller.cancellationReason).toBe('chat-history-deletion')
      await expectPending(cancellation.completion)

      const child = new FakeHostCommandChild()
      expect(controller.attachChild(child)).toBe(false)
      expect(child.events).toEqual(['listen:close', 'kill:SIGTERM'])
      controller.markTerminalProjectionComplete()
      await vi.advanceTimersByTimeAsync(50)
      expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
      await expectPending(cancellation.completion)

      child.close(null, 'SIGKILL')
      await cancellation.completion
      expect(controller.settled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('joins a cancelled pre-attach operation only after explicit no-child and projection', async () => {
    const registry = new HostCommandOperationRegistry()
    const controller = registry.register(identity('cancelled-no-child'))
    const join = registry.cancelAndJoin({ kind: 'global' })

    controller.markNoChild()
    await expectPending(join)
    controller.markTerminalProjectionComplete()
    await join
  })

  it('uses one TERM/KILL sequence and suppresses KILL after actual close', async () => {
    vi.useFakeTimers()
    try {
      const registry = new HostCommandOperationRegistry()
      const controller = registry.register(identity('cancel-once'), { killGraceMs: 100 })
      const child = new FakeHostCommandChild()
      controller.attachChild(child)

      controller.cancel('first-reason')
      controller.cancel('second-reason')
      expect(controller.cancellationReason).toBe('first-reason')
      expect(child.signals).toEqual(['SIGTERM'])
      await vi.advanceTimersByTimeAsync(100)
      expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
      controller.cancel('third-reason')
      await vi.advanceTimersByTimeAsync(100)
      expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
      child.close(null, 'SIGTERM')
      controller.markTerminalProjectionComplete()
      await controller.completion
      await vi.advanceTimersByTimeAsync(100)
      expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not treat SIGKILL delivery as close evidence', async () => {
    vi.useFakeTimers()
    try {
      const registry = new HostCommandOperationRegistry()
      const controller = registry.register(identity('kill-is-not-close'), { killGraceMs: 10 })
      const child = new FakeHostCommandChild()
      controller.attachChild(child)
      controller.markTerminalProjectionComplete()
      controller.cancel()
      await vi.advanceTimersByTimeAsync(10)

      expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
      await expectPending(controller.completion)
      child.close(null, 'SIGKILL')
      await controller.completion
    } finally {
      vi.useRealTimers()
    }
  })

  it('selects exact chat, workspace, frozen workspace-chat, and global scopes', async () => {
    const registry = new HostCommandOperationRegistry()
    const chat = registry.register(identity('chat-op'))
    const workspace = registry.register(
      identity('workspace-op', {
        appRunId: 'run-shared',
        appChatId: 'chat-b',
        workspaceId: 'workspace-b',
        workspacePath: '/workspace/b'
      })
    )
    const legacyWorkspace = registry.register(
      identity('legacy-workspace-op', {
        appRunId: 'run-shared',
        appChatId: 'chat-legacy',
        workspaceId: undefined,
        workspacePath: undefined
      })
    )
    const pathCollision = registry.register(
      identity('path-collision-op', {
        appRunId: 'run-collision',
        appChatId: 'chat-collision',
        workspaceId: 'workspace-c',
        workspacePath: '/workspace/b'
      })
    )
    const global = registry.register(
      identity('global-op', {
        appRunId: undefined,
        appChatId: undefined,
        workspaceId: undefined,
        workspacePath: undefined
      })
    )

    const chatHold = registry.beginCancellation({ kind: 'chat', chatIds: ['chat-a'] })
    expect(chatHold.operationIds).toEqual(['chat-op'])
    expect(chat.cancelled).toBe(true)
    expect(workspace.cancelled).toBe(false)

    const workspaceHold = registry.beginCancellation({
      kind: 'workspace',
      workspaceId: 'workspace-b',
      workspacePath: '/workspace/b',
      chatIds: ['chat-legacy']
    })
    expect(workspaceHold.operationIds).toEqual(['legacy-workspace-op', 'workspace-op'])
    expect(workspace.cancelled).toBe(true)
    expect(legacyWorkspace.cancelled).toBe(true)
    expect(pathCollision.cancelled).toBe(false)
    expect(global.cancelled).toBe(false)
    expect(registry.hasRun('run-shared')).toBe(true)

    const globalHold = registry.beginCancellation({ kind: 'global' })
    expect(globalHold.operationIds).toEqual([
      'chat-op',
      'global-op',
      'legacy-workspace-op',
      'path-collision-op',
      'workspace-op'
    ])
    expect(global.cancelled).toBe(true)

    for (const controller of [chat, workspace, legacyWorkspace, pathCollision, global]) {
      finishWithoutChild(controller)
    }
    await Promise.all([chatHold.completion, workspaceHold.completion, globalHold.completion])
  })

  it('retains exact selected objects after registry cleanup and ignores later operations', async () => {
    const registry = new HostCommandOperationRegistry()
    const selected = registry.register(identity('selected'))
    const hold = registry.beginCancellation({ kind: 'global' })
    finishWithoutChild(selected)
    await selected.completion
    await Promise.resolve()
    expect(registry.get('selected')).toBeUndefined()

    const later = registry.register(identity('later'))
    expect(later.cancelled).toBe(false)
    await hold.completion
    expect(hold.operationIds).toEqual(['selected'])
    finishWithoutChild(later)
    await later.completion
  })

  it('keeps operations selectable after their RunManager lifetime has ended', async () => {
    const registry = new HostCommandOperationRegistry()
    const controller = registry.register(identity('post-run-manager'))
    const child = new FakeHostCommandChild()
    controller.attachChild(child)
    controller.markTerminalProjectionComplete()

    // There is deliberately no RunManager lookup or session dependency here.
    const hold = registry.beginCancellation({ kind: 'chat', chatIds: ['chat-a'] })
    expect(hold.operationIds).toEqual(['post-run-manager'])
    await expectPending(hold.completion)
    child.close(null, 'SIGTERM')
    await hold.completion
  })

  it('keeps global deletion pending for an unowned internal command through forced close', async () => {
    vi.useFakeTimers()
    try {
      const registry = new HostCommandOperationRegistry()
      const controller = registry.register(
        identity('internal-audit-gate', {
          appRunId: undefined,
          appChatId: undefined,
          workspaceId: undefined,
          workspacePath: undefined
        }),
        { killGraceMs: 25 }
      )
      const child = new FakeHostCommandChild()
      controller.attachChild(child)

      const globalDeletion = registry.beginCancellation(
        { kind: 'global' },
        'global-history-deletion'
      )
      controller.markTerminalProjectionComplete()
      expect(globalDeletion.operationIds).toEqual(['internal-audit-gate'])
      expect(child.signals).toEqual(['SIGTERM'])

      await vi.advanceTimersByTimeAsync(25)
      expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
      await expectPending(globalDeletion.completion)

      child.close(null, 'SIGKILL')
      await globalDeletion.completion
    } finally {
      vi.useRealTimers()
    }
  })

  it('matches a raw stored workspace path against its resolve()-normalized identity twin', async () => {
    const registry = new HostCommandOperationRegistry()
    // Identity captured via path.resolve (agent tool context); the workspace
    // record may still hold the raw user-entered form with a trailing slash
    // and a `.` segment. Both sides normalize, so the scope still joins —
    // and identities lacking workspaceId/chatIds no longer slip a
    // workspace-scoped clear.
    const controller = registry.register({
      operationId: 'raw-vs-resolved',
      appRunId: 'run-a',
      appChatId: null,
      workspaceId: null,
      workspacePath: '/workspace/a'
    })
    const cancellation = registry.beginCancellation({
      kind: 'workspace',
      workspacePath: '/workspace/./a/'
    })
    expect(cancellation.operationIds).toEqual(['raw-vs-resolved'])
    await expectPending(cancellation.completion)
    finishWithoutChild(controller)
    await cancellation.completion
  })

  it('rejects incomplete identities, scopes, and invalid kill bounds', () => {
    const registry = new HostCommandOperationRegistry()
    expect(() => registry.register(identity('   '))).toThrow('operation id')
    expect(() => registry.register(identity('bad-run', { appRunId: '  ' }))).toThrow('app run id')
    expect(() => registry.register(identity('bad-grace'), { killGraceMs: -1 })).toThrow(
      'finite non-negative'
    )
    expect(() => registry.beginCancellation({ kind: 'workspace' })).toThrow(
      'requires a workspace id'
    )
    const controller = registry.register(identity('bad-cancellation-reason'))
    expect(() => controller.cancel('   ')).toThrow('cancellation reason')
    expect(controller.cancelled).toBe(false)
  })
})
