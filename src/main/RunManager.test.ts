import { describe, expect, it, vi } from 'vitest'
import { RunManager, canStartRunTransport } from './RunManager'

describe('RunManager', () => {
  it('requires live ownership before a provider fallback transport may start', () => {
    expect(canStartRunTransport('running', true)).toBe(true)
    expect(canStartRunTransport('starting', true)).toBe(true)
    expect(canStartRunTransport('cancelled', true)).toBe(false)
    expect(canStartRunTransport('completed', true)).toBe(false)
    expect(canStartRunTransport(undefined, true)).toBe(false)
    expect(canStartRunTransport(undefined, false)).toBe(true)
  })

  it('indexes sessions by run id, provider, chat, and provider session id', () => {
    const manager = new RunManager()
    const first = manager.create({
      runId: 'run-1',
      provider: 'codex',
      appChatId: 'chat-1',
      providerSessionId: 'thread-1',
      workspacePath: '/workspace-a'
    })
    const second = manager.create({
      runId: 'run-2',
      provider: 'codex',
      appChatId: 'chat-2',
      providerSessionId: 'thread-2',
      workspacePath: '/workspace-b'
    })

    expect(manager.get('run-1')).toBe(first)
    expect(manager.getByProvider('codex')).toEqual([first, second])
    expect(manager.getByProviderSession('codex', 'thread-2')).toBe(second)
    expect(manager.resolve('codex', { appRunId: 'run-1' })).toBe(first)
    expect(manager.resolve('codex', { appChatId: 'chat-2' })).toBe(second)
  })

  it('tracks approvals and session grants on the owning run', () => {
    const manager = new RunManager()
    manager.create({
      runId: 'gemini-run',
      provider: 'gemini',
      workspacePath: '/workspace'
    })

    manager.registerApproval('gemini-run', 'approval-1')
    manager.addSessionGrant('gemini-run', 'shellCommands')

    expect(manager.resolveApproval('approval-1')?.runId).toBe('gemini-run')
    expect(manager.hasSessionGrant('gemini-run', 'shellCommands')).toBe(true)

    manager.clearApproval('approval-1')
    expect(manager.resolveApproval('approval-1')).toBeUndefined()
  })

  it('cancels only the selected run process', () => {
    const manager = new RunManager()
    const firstKill = vi.fn()
    const secondKill = vi.fn()
    manager.create({
      runId: 'run-1',
      provider: 'claude',
      process: { kill: firstKill },
      status: 'running'
    })
    manager.create({
      runId: 'run-2',
      provider: 'claude',
      process: { kill: secondKill },
      status: 'running'
    })

    expect(manager.cancel('run-1')).toBe(true)

    expect(firstKill).toHaveBeenCalledTimes(1)
    expect(secondKill).not.toHaveBeenCalled()
    expect(manager.get('run-1')?.status).toBe('cancelled')
    expect(manager.get('run-2')?.status).toBe('running')
  })

  it('reindexes provider session ids when they change', () => {
    const manager = new RunManager()
    manager.create({ runId: 'run-1', provider: 'codex', providerSessionId: 'thread-old' })

    manager.registerProviderSession('run-1', 'thread-new')

    expect(manager.getByProviderSession('codex', 'thread-old')).toBeUndefined()
    expect(manager.getByProviderSession('codex', 'thread-new')?.runId).toBe('run-1')
  })

  it('resolves provider sessions as active only while their app run is live', () => {
    const manager = new RunManager()
    manager.create({
      runId: 'run-1',
      provider: 'codex',
      providerSessionId: 'thread-1',
      status: 'running'
    })

    expect(manager.getActiveByProviderSession('codex', 'thread-1')?.runId).toBe('run-1')
    manager.finish('run-1', 'completed')

    expect(manager.getByProviderSession('codex', 'thread-1')?.runId).toBe('run-1')
    expect(manager.getActiveByProviderSession('codex', 'thread-1')).toBeUndefined()
    expect(manager.resolve('codex', { appRunId: 'run-1' })?.status).toBe('completed')
  })

  it('does not fall back to latest when a routed run or chat is unknown', () => {
    const manager = new RunManager()
    manager.create({ runId: 'run-1', provider: 'gemini', appChatId: 'chat-1', status: 'running' })

    expect(manager.resolve('gemini', { appRunId: 'missing-run' })).toBeUndefined()
    expect(manager.resolve('gemini', { appChatId: 'missing-chat' })).toBeUndefined()
    expect(manager.resolve('gemini')).toBe(manager.get('run-1'))
  })

  it('does not guess when multiple active provider sessions need an explicit route', () => {
    const manager = new RunManager()
    manager.create({ runId: 'run-1', provider: 'codex', appChatId: 'chat-1', status: 'running' })
    manager.create({ runId: 'run-2', provider: 'codex', appChatId: 'chat-2', status: 'running' })

    expect(manager.resolve('codex')).toBeUndefined()
    expect(manager.resolve('codex', { appChatId: 'chat-2' })?.runId).toBe('run-2')
    expect(manager.resolve('codex', { appChatId: 'chat-1' })?.runId).toBe('run-1')
  })

  it('emits lifecycle changes for persistence adapters', () => {
    const manager = new RunManager()
    const events: string[] = []
    const dispose = manager.onChange((event) => {
      events.push(`${event.type}:${event.session.runId}:${event.session.status}`)
    })

    manager.create({ runId: 'run-1', provider: 'codex' })
    manager.attachProcess('run-1', { kill: vi.fn() })
    manager.finish('run-1', 'completed')
    manager.remove('run-1')
    dispose()
    manager.create({ runId: 'run-2', provider: 'codex' })

    expect(events).toEqual([
      'created:run-1:starting',
      'updated:run-1:running',
      'updated:run-1:completed',
      'removed:run-1:completed'
    ])
  })

  it('keeps the first terminal status when late process events arrive', () => {
    const manager = new RunManager()
    manager.create({ runId: 'run-1', provider: 'gemini', status: 'running' })

    manager.finish('run-1', 'cancelled')
    manager.finish('run-1', 'failed')

    expect(manager.get('run-1')?.status).toBe('cancelled')
  })

  it('preserves a claimed failure when abort emits a competing cancelled exit', () => {
    const manager = new RunManager()
    manager.create({ runId: 'run-1', provider: 'codex', status: 'running' })

    expect(manager.claimTerminalStatus('run-1', 'failed')?.runId).toBe('run-1')
    manager.finish('run-1', 'cancelled')

    expect(manager.get('run-1')?.status).toBe('failed')
  })

  it('exposes a terminal claim without publishing a terminal session', () => {
    const manager = new RunManager()
    const events: string[] = []
    manager.onChange((event) => events.push(`${event.type}:${event.session.status}`))
    manager.create({ runId: 'run-1', provider: 'codex', status: 'running' })

    expect(manager.claimTerminalStatus('run-1', 'cancelled')?.status).toBe('running')

    expect(manager.getClaimedTerminalStatus('run-1')).toBe('cancelled')
    expect(manager.get('run-1')?.status).toBe('running')
    expect(events).toEqual(['created:running'])

    manager.finish('run-1', 'failed')

    expect(manager.get('run-1')?.status).toBe('cancelled')
    expect(manager.getClaimedTerminalStatus('run-1')).toBeUndefined()
  })

  it('defers a claimed terminal status until the transport confirms it', () => {
    const manager = new RunManager()
    const events: string[] = []
    manager.onChange((event) => events.push(`${event.type}:${event.session.status}`))
    manager.create({ runId: 'run-1', provider: 'claude', status: 'running' })
    manager.claimTerminalStatus('run-1', 'cancelled', { requireConfirmation: true })

    manager.finish('run-1', 'failed')

    expect(manager.get('run-1')?.status).toBe('running')
    expect(events).toEqual(['created:running'])

    manager.confirmClaimedTerminalStatus('run-1')

    expect(manager.get('run-1')?.status).toBe('cancelled')
    expect(events).toEqual(['created:running', 'updated:cancelled'])
  })

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'makes %s sessions absorbing and contains late resources',
    (terminalStatus) => {
      const manager = new RunManager()
      const lateKill = vi.fn()
      const lateAbort = vi.fn()
      manager.create({ runId: 'run-1', provider: 'claude', status: 'running' })
      manager.finish('run-1', terminalStatus)

      manager.update('run-1', { status: 'running', providerSessionId: 'late-session' })
      manager.attachProcess('run-1', { kill: lateKill })
      manager.attachAbortController('run-1', { abort: lateAbort })
      manager.registerApproval('run-1', 'late-approval')
      manager.addSessionGrant('run-1', 'shellCommands')

      expect(manager.get('run-1')?.status).toBe(terminalStatus)
      expect(manager.get('run-1')?.providerSessionId).toBeUndefined()
      expect(manager.get('run-1')?.process).toBeUndefined()
      expect(manager.get('run-1')?.abortController).toBeUndefined()
      expect(lateKill).toHaveBeenCalledTimes(1)
      expect(lateAbort).toHaveBeenCalledTimes(1)
      expect(manager.resolveApproval('late-approval')).toBeUndefined()
      expect(manager.hasSessionGrant('run-1', 'shellCommands')).toBe(false)
    }
  )

  it('rejects duplicate app-run ids instead of replacing their lifecycle', () => {
    const manager = new RunManager()
    manager.create({ runId: 'run-1', provider: 'claude', status: 'running' })

    expect(() => manager.create({ runId: 'run-1', provider: 'claude' })).toThrow(
      /already exists/
    )
    expect(manager.get('run-1')?.status).toBe('running')
  })
})
