import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BackgroundProcessRegistry,
  type BackgroundProcessSignalName,
  type BackgroundProcessStartOptions
} from './BackgroundProcessRegistry'

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null

  constructor(readonly pid: number) {
    super()
  }

  close(code: number | null = null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code
    this.signalCode = signal
    this.emit('close', code, signal)
  }
}

interface Harness {
  registry: BackgroundProcessRegistry
  children: FakeChild[]
  signals: Array<{ pid: number; signal: BackgroundProcessSignalName }>
  starts: Array<{ command: string; cwd: string }>
}

function createHarness(killGraceMs = 50): Harness {
  const children: FakeChild[] = []
  const signals: Array<{ pid: number; signal: BackgroundProcessSignalName }> = []
  const starts: Array<{ command: string; cwd: string }> = []
  let nextPid = 2_000
  let nextId = 1
  const registry = new BackgroundProcessRegistry({
    spawnProcess: (command, cwd) => {
      starts.push({ command, cwd })
      const child = new FakeChild(nextPid++)
      children.push(child)
      return child as unknown as ChildProcess
    },
    signalProcess: (child, signal) => {
      signals.push({ pid: child.pid!, signal })
    },
    createId: () => `bg-test-${nextId++}`,
    now: () => new Date('2026-07-19T00:00:00.000Z'),
    killGraceMs
  })
  return { registry, children, signals, starts }
}

function startOptions(
  appChatId: string,
  workspaceId: string,
  overrides: Partial<BackgroundProcessStartOptions> = {}
): BackgroundProcessStartOptions {
  return {
    appChatId,
    workspaceId,
    initialWaitMs: 0,
    maxInitialChars: 10_000,
    ...overrides
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('BackgroundProcessRegistry history lifecycle', () => {
  it('raises the chat admission fence synchronously and blocks matching starts', async () => {
    const harness = createHarness()
    await harness.registry.start('serve-a', '/workspace', startOptions('chat-a', 'workspace-a'))

    const hold = harness.registry.beginHistoryDeletion({
      kind: 'chat',
      chatIds: ['chat-a']
    })
    expect(harness.signals).toEqual([{ pid: 2_000, signal: 'SIGTERM' }])

    const blocked = await harness.registry.start(
      'late-a',
      '/workspace',
      startOptions('chat-a', 'workspace-a')
    )
    expect(blocked).toMatchObject({ ok: false, error: expect.stringContaining('history deletion') })
    expect(harness.starts).toHaveLength(1)

    const sibling = await harness.registry.start(
      'serve-b',
      '/workspace',
      startOptions('chat-b', 'workspace-a')
    )
    expect(sibling).toMatchObject({ ok: true, processId: 'bg-test-3' })
    expect(harness.starts).toHaveLength(2)

    harness.children[0].close(null, 'SIGTERM')
    await hold.completion
    expect(harness.registry.endHistoryDeletion(hold)).toBe(true)
    expect(harness.registry.endHistoryDeletion(hold)).toBe(false)
  })

  it('uses a KILL backstop but keeps deletion pending until the child closes', async () => {
    vi.useFakeTimers()
    const harness = createHarness(100)
    await harness.registry.start('ignore-term', '/workspace', startOptions('chat-a', 'workspace-a'))

    const hold = harness.registry.beginHistoryDeletion({ kind: 'truncate', chatIds: ['chat-a'] })
    let settled = false
    void hold.completion.then(() => {
      settled = true
    })
    expect(harness.signals).toEqual([{ pid: 2_000, signal: 'SIGTERM' }])

    await vi.advanceTimersByTimeAsync(100)
    expect(harness.signals).toEqual([
      { pid: 2_000, signal: 'SIGTERM' },
      { pid: 2_000, signal: 'SIGKILL' }
    ])
    expect(settled).toBe(false)

    harness.children[0].close(null, 'SIGKILL')
    await hold.completion
    expect(settled).toBe(true)
    expect(harness.registry.list({ appChatId: 'chat-a' })).toMatchObject({ count: 0 })
  })

  it('clears one workspace while preserving processes owned by sibling workspaces', async () => {
    const harness = createHarness()
    await harness.registry.start('serve-a', '/a', startOptions('chat-a', 'workspace-a'))
    await harness.registry.start('serve-b', '/b', startOptions('chat-b', 'workspace-b'))

    const hold = harness.registry.beginHistoryDeletion({
      kind: 'workspace',
      workspaceId: 'workspace-a',
      chatIds: ['chat-a']
    })
    expect(hold.processIds).toEqual(['bg-test-1'])
    expect(harness.signals).toEqual([{ pid: 2_000, signal: 'SIGTERM' }])
    expect(harness.registry.list({ appChatId: 'chat-b' })).toMatchObject({ count: 1 })

    harness.children[0].close(null, 'SIGTERM')
    await hold.completion
    expect(harness.registry.endHistoryDeletion(hold)).toBe(true)
    expect(harness.registry.list({ appChatId: 'chat-b' })).toMatchObject({ count: 1 })
  })

  it('globally joins every process and blocks all new starts through release', async () => {
    const harness = createHarness()
    await harness.registry.start('serve-a', '/a', startOptions('chat-a', 'workspace-a'))
    await harness.registry.start('serve-b', '/b', startOptions('chat-b', 'workspace-b'))

    const hold = harness.registry.beginHistoryDeletion({ kind: 'global' })
    expect(hold.processIds).toEqual(['bg-test-1', 'bg-test-2'])
    expect(harness.signals).toEqual([
      { pid: 2_000, signal: 'SIGTERM' },
      { pid: 2_001, signal: 'SIGTERM' }
    ])
    expect(
      await harness.registry.start('late', '/c', startOptions('chat-c', 'workspace-c'))
    ).toMatchObject({ ok: false })

    harness.children[0].close(null, 'SIGTERM')
    let settled = false
    void hold.completion.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    harness.children[1].close(null, 'SIGTERM')
    await hold.completion
    expect(harness.registry.endHistoryDeletion(hold)).toBe(true)

    expect(
      await harness.registry.start('after-commit', '/c', startOptions('chat-c', 'workspace-c'))
    ).toMatchObject({ ok: true })
  })

  it('does not publish a start result after deletion revokes it during initial wait', async () => {
    vi.useFakeTimers()
    const harness = createHarness(1_000)
    const start = harness.registry.start(
      'slow-start',
      '/a',
      startOptions('chat-a', 'workspace-a', { initialWaitMs: 500 })
    )
    expect(harness.children).toHaveLength(1)

    const hold = harness.registry.beginHistoryDeletion({ kind: 'chat', chatIds: ['chat-a'] })
    harness.children[0].close(null, 'SIGTERM')
    await hold.completion
    await vi.advanceTimersByTimeAsync(500)

    expect(await start).toMatchObject({
      ok: false,
      error: expect.stringContaining('revoked by history deletion')
    })
    expect(harness.registry.list({ appChatId: 'chat-a' })).toMatchObject({ count: 0 })
  })
})
