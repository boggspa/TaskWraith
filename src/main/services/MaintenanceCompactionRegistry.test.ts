import { describe, expect, it, vi } from 'vitest'

import {
  MaintenanceCompactionAdmissionError,
  MaintenanceCompactionRegistry
} from './MaintenanceCompactionRegistry'

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('MaintenanceCompactionRegistry', () => {
  it('raises a synchronous deletion hold, aborts exact active work, and blocks new scope reservations', () => {
    const registry = new MaintenanceCompactionRegistry()
    const token = registry.reserve({
      chatId: 'chat-kimi',
      workspaceId: 'workspace-a',
      participantId: 'seat-kimi',
      provider: 'kimi'
    })
    const abort = vi.fn()
    token.signal.addEventListener('abort', abort)

    const hold = registry.beginHistoryDeletion({ kind: 'chat', chatIds: ['chat-kimi'] })

    expect(hold.reservationIds).toEqual([token.id])
    expect(abort).toHaveBeenCalledTimes(1)
    expect(registry.canWrite(token)).toBe(false)
    expect(() =>
      registry.reserve({ chatId: 'chat-kimi', participantId: 'other', provider: 'claude' })
    ).toThrow(MaintenanceCompactionAdmissionError)
    expect(
      registry.reserve({ chatId: 'unrelated-chat', participantId: 'other', provider: 'claude' })
    ).toBeTruthy()
  })

  it('does not treat a finished request as joined while quarantined native activity remains', async () => {
    const registry = new MaintenanceCompactionRegistry()
    const token = registry.reserve({ chatId: 'chat-kimi', participantId: 'seat', provider: 'kimi' })
    expect(registry.beginNativeActivity(token)).toBe(true)
    const hold = registry.beginHistoryDeletion({ kind: 'chat', chatIds: ['chat-kimi'] })
    registry.finish(token)

    let joined = false
    const join = registry.cancelAndJoinHold(hold).then(() => {
      joined = true
    })
    await nextTick()
    expect(joined).toBe(false)

    expect(registry.endNativeActivity(token)).toBe(true)
    await join
    expect(joined).toBe(true)
  })

  it('re-arms exact quiescence after child A closes and waits for sequential child B', async () => {
    const registry = new MaintenanceCompactionRegistry()
    const token = registry.reserve({ chatId: 'chat-grok', participantId: 'seat', provider: 'grok' })
    expect(registry.beginNativeActivity(token)).toBe(true)
    expect(registry.endNativeActivity(token)).toBe(true)
    expect(registry.beginNativeActivity(token)).toBe(true)

    const hold = registry.beginHistoryDeletion({ kind: 'chat', chatIds: ['chat-grok'] })
    registry.finish(token)
    let joined = false
    const join = registry.cancelAndJoinHold(hold).then((confirmed) => {
      joined = confirmed
    })
    await nextTick()
    expect(joined).toBe(false)

    expect(registry.endNativeActivity(token)).toBe(true)
    await join
    expect(joined).toBe(true)
  })

  it('fences a Kimi /compact continuation that tries to persist durable seat state after deletion begins', async () => {
    const durableSeatWrites: string[] = []
    const registry = new MaintenanceCompactionRegistry()
    const token = registry.reserve({
      chatId: 'chat-kimi',
      workspaceId: 'workspace-a',
      participantId: 'seat-kimi',
      provider: 'kimi'
    })
    expect(registry.beginNativeActivity(token)).toBe(true)

    let releaseProvider!: () => void
    const providerClosed = new Promise<void>((resolve) => {
      releaseProvider = resolve
    })
    const work = (async () => {
      await providerClosed
      registry.endNativeActivity(token)
      if (registry.canWrite(token)) durableSeatWrites.push('linked-session-and-compaction-card')
    })().finally(() => registry.finish(token))

    const discovery = registry.list({ kind: 'chat', chatIds: ['chat-kimi'] })
    expect(discovery.map((entry) => entry.id)).toEqual([token.id])
    const hold = registry.beginHistoryDeletion({ kind: 'chat', chatIds: ['chat-kimi'] })
    const deletionJoin = registry.cancelAndJoinHold(hold)

    releaseProvider()
    await Promise.all([work, deletionJoin])

    expect(durableSeatWrites).toEqual([])
    expect(registry.list({ kind: 'global' })).toEqual([])
  })

  it('captures a reservation admitted after target discovery but before durable hold acquisition', async () => {
    const registry = new MaintenanceCompactionRegistry()
    expect(registry.list({ kind: 'workspace', workspaceId: 'workspace-a' })).toEqual([])
    const token = registry.reserve({
      chatId: 'chat-a',
      workspaceId: 'workspace-a',
      participantId: 'seat-a',
      provider: 'grok'
    })
    const hold = registry.beginHistoryDeletion({
      kind: 'workspace',
      workspaceId: 'workspace-a',
      chatIds: ['chat-a']
    })
    expect(hold.reservationIds).toEqual([token.id])
    registry.finish(token)
    await expect(registry.cancelAndJoinHold(hold)).resolves.toBe(true)
  })

  it('fails closed for a restart-absent reservation without durable provider termination proof', async () => {
    const restartedRegistry = new MaintenanceCompactionRegistry()
    await expect(restartedRegistry.cancelAndJoin('pre-crash-reservation-id')).resolves.toBe(false)
  })

  it('recognizes same-generation exact-close evidence after a discovered request leaves the active map', async () => {
    const registry = new MaintenanceCompactionRegistry()
    const token = registry.reserve({ chatId: 'chat-a', provider: 'claude' })
    expect(registry.list({ kind: 'chat', chatIds: ['chat-a'] })).toHaveLength(1)
    registry.finish(token)
    await expect(registry.cancelAndJoin(token.id)).resolves.toBe(true)
  })

  it('checks the durable admission callback synchronously', () => {
    let blocked = true
    const registry = new MaintenanceCompactionRegistry(() => !blocked)
    expect(() => registry.reserve({ chatId: 'chat-a', provider: 'codex' })).toThrow(
      MaintenanceCompactionAdmissionError
    )
    blocked = false
    expect(registry.reserve({ chatId: 'chat-a', provider: 'codex' })).toBeTruthy()
  })
})
