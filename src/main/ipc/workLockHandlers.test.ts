import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import {
  createWorkLockProjectionSnapshot,
  type WorkLockProjectionQuery,
  type WorkLockProjectionSource
} from '../../shared/workLockProjection'
import {
  registerWorkLockHandlers,
  type WorkLockHandlerDeps,
  type WorkLockProjectionServiceUpdate
} from './workLockHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function lock(
  lockId: string,
  basePath: string,
  effectivePath = basePath
): WorkLockProjectionSource {
  return {
    lockId,
    status: 'held',
    owner: {
      displayName: 'Builder',
      provider: 'codex',
      chatId: 'chat-1',
      laneId: 'lane-1'
    },
    workspace: {
      basePath,
      effectivePath,
      isWorktree: basePath !== effectivePath
    },
    target: {
      kind: 'file',
      path: 'src/app.ts'
    },
    acquiredAt: '2026-07-29T15:00:00.000Z',
    statusChangedAt: '2026-07-29T15:00:00.000Z'
  }
}

function snapshot(generation = 1) {
  return createWorkLockProjectionSnapshot({
    generation,
    sampledAt: '2026-07-29T15:05:00.000Z',
    locks: [
      lock('base', '/repo'),
      lock('linked', '/repo', '/worktrees/lane'),
      lock('other', '/other')
    ]
  })
}

function sender(id: number) {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    id,
    send: vi.fn(),
    isDestroyed: vi.fn(() => false)
  })
}

function setup(overrides: Partial<WorkLockHandlerDeps> = {}) {
  let listener: ((update: WorkLockProjectionServiceUpdate) => void) | null = null
  const unsubscribe = vi.fn()
  const deps: WorkLockHandlerDeps = {
    resolveAuthorizedQuery: vi.fn((_event, query) => query),
    list: vi.fn(() => snapshot()),
    subscribe: vi.fn((_query, onUpdate) => {
      listener = onUpdate
      return { snapshot: snapshot(), unsubscribe }
    }),
    forceReleaseRecovery: vi.fn(async () => ({
      ok: true as const,
      releasedLeaseCount: 1,
      attentionRequired: false,
      message: 'released'
    })),
    ...overrides
  }
  registerWorkLockHandlers(deps)
  return {
    deps,
    unsubscribe,
    publish: (update: WorkLockProjectionServiceUpdate) => listener?.(update)
  }
}

beforeEach(() => {
  mockedHandle.mockReset()
})

describe('registerWorkLockHandlers', () => {
  it('registers list, recovery, subscribe, and unsubscribe handlers', () => {
    setup()

    expect(handlerFor('work-locks:list')).toBeTypeOf('function')
    expect(handlerFor('work-locks:force-release-recovery')).toBeTypeOf('function')
    expect(handlerFor('work-locks:subscribe')).toBeTypeOf('function')
    expect(handlerFor('work-locks:unsubscribe')).toBeTypeOf('function')
  })

  it('forwards only a visible recovery-blocked lock to the recovery authority', async () => {
    const recovery = snapshot()
    recovery.locks = recovery.locks.map((entry) =>
      entry.lockId === 'base' ? { ...entry, status: 'recovery_blocked' as const } : entry
    )
    const forceReleaseRecovery = vi.fn(async () => ({
      ok: true as const,
      releasedLeaseCount: 1,
      attentionRequired: false,
      message: 'released'
    }))
    setup({ list: vi.fn(() => recovery), forceReleaseRecovery })
    const renderer = sender(1)

    await expect(
      handlerFor('work-locks:force-release-recovery')(
        { sender: renderer },
        { lockId: 'base', workspacePath: '/repo', chatId: 'chat-1' }
      )
    ).resolves.toMatchObject({ ok: true, releasedLeaseCount: 1 })
    expect(forceReleaseRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ sender: renderer }),
      { lockId: 'base', workspacePath: '/repo', chatId: 'chat-1' }
    )
  })

  it('does not reveal or release a held, hidden, or malformed lock', async () => {
    const forceReleaseRecovery = vi.fn()
    setup({ forceReleaseRecovery })
    const renderer = sender(1)
    const handler = handlerFor('work-locks:force-release-recovery')

    await expect(
      handler({ sender: renderer }, { lockId: 'base', workspacePath: '/repo' })
    ).resolves.toMatchObject({ ok: false, reason: 'not_found_or_forbidden' })
    await expect(
      handler({ sender: renderer }, { lockId: 'other', workspacePath: '/repo' })
    ).resolves.toMatchObject({ ok: false, reason: 'not_found_or_forbidden' })
    await expect(handler({ sender: renderer }, { lockId: ' ' })).resolves.toMatchObject({
      ok: false,
      reason: 'invalid_request'
    })
    expect(forceReleaseRecovery).not.toHaveBeenCalled()
  })

  it('authorizes and scopes list results to a base checkout and its worktrees', async () => {
    const resolveAuthorizedQuery = vi.fn(
      (_event: unknown, query: WorkLockProjectionQuery): WorkLockProjectionQuery => ({
        ...query,
        workspacePath: '/repo'
      })
    )
    setup({ resolveAuthorizedQuery })
    const renderer = sender(1)

    const result = await handlerFor('work-locks:list')(
      { sender: renderer },
      { workspacePath: '/repo', chatId: 'chat-1' }
    )

    expect(resolveAuthorizedQuery).toHaveBeenCalled()
    expect((result as ReturnType<typeof snapshot>).locks.map((entry) => entry.lockId)).toEqual([
      'base',
      'linked'
    ])
  })

  it('preserves exact workspace path bytes for list and subscription authorization', async () => {
    const resolveAuthorizedQuery = vi.fn(
      (_event: unknown, query: WorkLockProjectionQuery): WorkLockProjectionQuery => query
    )
    const list = vi.fn(() => snapshot())
    const subscribe = vi.fn((_query, _onUpdate) => ({
      snapshot: snapshot(),
      unsubscribe: vi.fn()
    }))
    setup({ resolveAuthorizedQuery, list, subscribe })
    const renderer = sender(1)

    await handlerFor('work-locks:list')(
      { sender: renderer },
      { workspacePath: '/repo ', chatId: ' chat-1 ' }
    )
    await handlerFor('work-locks:subscribe')(
      { sender: renderer },
      { subscriptionId: 'sub-exact', workspacePath: '/repo ', chatId: ' chat-1 ' }
    )

    expect(resolveAuthorizedQuery).toHaveBeenNthCalledWith(1, expect.anything(), {
      workspacePath: '/repo ',
      chatId: 'chat-1'
    })
    expect(resolveAuthorizedQuery).toHaveBeenNthCalledWith(2, expect.anything(), {
      workspacePath: '/repo ',
      chatId: 'chat-1'
    })
    expect(list).toHaveBeenCalledWith({ workspacePath: '/repo ', chatId: 'chat-1' })
    expect(subscribe).toHaveBeenCalledWith(
      { workspacePath: '/repo ', chatId: 'chat-1' },
      expect.any(Function)
    )
  })

  it('returns an initial snapshot and publishes later scoped generations', async () => {
    const renderer = sender(1)
    const harness = setup()

    const initial = await handlerFor('work-locks:subscribe')(
      { sender: renderer },
      { subscriptionId: 'sub-1', workspacePath: '/repo', chatId: 'chat-1' }
    )
    expect(initial).toMatchObject({
      ok: true,
      data: {
        subscriptionId: 'sub-1',
        snapshot: { generation: 1 }
      }
    })
    expect(
      (initial as any).data.snapshot.locks.map((entry: { lockId: string }) => entry.lockId)
    ).toEqual(['base', 'linked'])

    harness.publish({ reason: 'acquired', snapshot: snapshot(2) })

    expect(renderer.send).toHaveBeenCalledWith(
      'work-locks:changed',
      expect.objectContaining({
        subscriptionId: 'sub-1',
        reason: 'acquired',
        snapshot: expect.objectContaining({ generation: 2 })
      })
    )
    const event = renderer.send.mock.calls[0][1]
    expect(event.snapshot.locks.map((entry: { lockId: string }) => entry.lockId)).toEqual([
      'base',
      'linked'
    ])
  })

  it('rechecks scope on every event and cleans up when authority changes', async () => {
    let authorized = true
    const resolveAuthorizedQuery = vi.fn((_event, query: WorkLockProjectionQuery) => {
      if (!authorized) throw new Error('renderer scope changed')
      return query
    })
    const renderer = sender(1)
    const harness = setup({ resolveAuthorizedQuery })
    await handlerFor('work-locks:subscribe')(
      { sender: renderer },
      { subscriptionId: 'sub-1', workspacePath: '/repo' }
    )

    authorized = false
    harness.publish({ reason: 'recovery-blocked', snapshot: snapshot(2) })

    expect(renderer.send).not.toHaveBeenCalled()
    expect(harness.unsubscribe).toHaveBeenCalledOnce()
  })

  it('binds subscription ids to one renderer and cleans up destroyed senders', async () => {
    const owner = sender(1)
    const other = sender(2)
    const harness = setup()
    await handlerFor('work-locks:subscribe')(
      { sender: owner },
      { subscriptionId: 'owned', workspacePath: '/repo' }
    )

    await expect(
      handlerFor('work-locks:unsubscribe')({ sender: other }, { subscriptionId: 'owned' })
    ).resolves.toEqual({
      ok: false,
      error: 'Work lock subscription id belongs to another renderer.'
    })

    owner.emit('destroyed')
    expect(harness.unsubscribe).toHaveBeenCalledOnce()
  })

  it('keeps the preload list, subscribe, event, and cleanup channels in one contract', () => {
    const preload = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
    const preloadTypes = readFileSync(join(process.cwd(), 'src/preload/index.d.ts'), 'utf8')

    expect(preload).toContain("ipcRenderer.invoke('work-locks:list'")
    expect(preload).toContain("'work-locks:force-release-recovery'")
    expect(preload).toContain(".invoke('work-locks:subscribe'")
    expect(preload).toContain("ipcRenderer.on('work-locks:changed'")
    expect(preload).toContain("ipcRenderer.invoke('work-locks:unsubscribe'")
    expect(preloadTypes).toContain('listWorkLocks:')
    expect(preloadTypes).toContain('forceReleaseRecoveryBlockedWorkLock:')
    expect(preloadTypes).toContain('subscribeWorkLocks:')
    expect(preloadTypes).not.toContain('processBirthIdentity')
    expect(preloadTypes).not.toContain('ownerPid')
  })
})
