import { describe, expect, it, vi } from 'vitest'

import { HostNodeInteractionRegistry } from './HostNodeInteractionRegistry'

const actor = { clientId: 'tui-1', clientClass: 'tui', actorId: 'actor-1' }

function approval(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'approval' as const,
    providerId: 'claude',
    runId: 'run-1',
    threadId: 'thread-1',
    title: 'Approve tool use',
    summary: 'Allow tool execution',
    createdAt: '2026-08-24T05:00:00.000Z',
    ...overrides
  }
}

function question(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'question' as const,
    providerId: 'claude',
    runId: 'run-1',
    threadId: 'thread-1',
    title: 'Choose option',
    summary: 'Pick one',
    options: ['a', 'b'],
    createdAt: '2026-08-24T05:00:00.000Z',
    ...overrides
  }
}

describe('HostNodeInteractionRegistry', () => {
  it('registers pending approval and question metadata without tool bodies', () => {
    const registry = new HostNodeInteractionRegistry()
    void registry.register(approval('ap-1'))
    void registry.register(question('q-1'))
    const pending = registry.listPending()
    expect(pending).toHaveLength(2)
    expect(pending).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'ap-1' })]))
    expect(pending).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'q-1' })]))
  })

  it('settles an approval exactly once and resolves the provider promise', async () => {
    const onSettled = vi.fn()
    const registry = new HostNodeInteractionRegistry({ onSettled })
    const settlement = registry.register(approval('ap-1'))
    const result = registry.decide({ id: 'ap-1', decision: 'accept', actor })
    expect(result.settled).toMatchObject({ id: 'ap-1', kind: 'approval' })
    expect(onSettled).toHaveBeenCalledOnce()
    expect(registry.listPending()).toHaveLength(0)
    await expect(settlement).resolves.toMatchObject({
      id: 'ap-1',
      kind: 'approval',
      decision: 'accept',
      actor
    })
    expect(registry.decide({ id: 'ap-1', decision: 'decline', actor }).settled).toBeNull()
  })

  it('settles a question exactly once and resolves the provider promise with the answer', async () => {
    const onSettled = vi.fn()
    const registry = new HostNodeInteractionRegistry({ onSettled })
    const settlement = registry.register(question('q-1'))
    const result = registry.answer({ id: 'q-1', decision: 'answer', answer: 'a', actor })
    expect(result.settled).toMatchObject({ id: 'q-1', kind: 'question' })
    expect(onSettled).toHaveBeenCalledOnce()
    expect(registry.listPending()).toHaveLength(0)
    await expect(settlement).resolves.toMatchObject({
      id: 'q-1',
      kind: 'question',
      decision: 'answer',
      answer: 'a',
      actor
    })
  })

  it('rejects invalid id, decision, or actor', () => {
    const registry = new HostNodeInteractionRegistry()
    void registry.register(approval('ap-1'))
    expect(registry.decide({ id: 'ap-1', decision: 'bogus' as 'accept', actor }).settled).toBeNull()
    expect(registry.decide({ id: '', decision: 'accept', actor }).settled).toBeNull()
    expect(
      registry.decide({ id: 'ap-1', decision: 'accept', actor: { ...actor, actorId: '' } }).settled
    ).toBeNull()
    expect(registry.listPending()).toHaveLength(1)
  })

  it('rejects cross-kind commands', () => {
    const registry = new HostNodeInteractionRegistry()
    void registry.register(approval('ap-1'))
    expect(registry.answer({ id: 'ap-1', decision: 'answer', actor }).settled).toBeNull()
    void registry.register(question('q-1'))
    expect(registry.decide({ id: 'q-1', decision: 'accept', actor }).settled).toBeNull()
    expect(registry.listPending()).toHaveLength(2)
  })

  it('cancels all pending interactions on shutdown and rejects their promises', async () => {
    const registry = new HostNodeInteractionRegistry()
    const ap = registry.register(approval('ap-1'))
    const q = registry.register(question('q-1'))
    await expect(registry.shutdown()).resolves.toBeUndefined()
    expect(registry.listPending()).toHaveLength(0)
    await expect(ap).rejects.toThrow('HostNodeInteractionRegistry: shutdown')
    await expect(q).rejects.toThrow('HostNodeInteractionRegistry: shutdown')
    expect(registry.decide({ id: 'ap-1', decision: 'accept', actor }).settled).toBeNull()
  })

  it('bounds pending entries and evicts oldest when full', () => {
    const registry = new HostNodeInteractionRegistry({ maxPending: 3 })
    const evicted = registry.register(approval('ap-1'))
    void registry.register(approval('ap-2'))
    void registry.register(approval('ap-3'))
    void registry.register(approval('ap-4'))
    const pending = registry.listPending()
    expect(pending).toHaveLength(3)
    expect(pending.map((p) => p.id)).not.toContain('ap-1')
    return expect(evicted).rejects.toThrow('HostNodeInteractionRegistry: evicted by newer entry')
  })

  it('rejects invalid registrations that carry control characters or missing fields', async () => {
    const registry = new HostNodeInteractionRegistry()
    const nullId = `ap-1${String.fromCharCode(0)}`
    await expect(registry.register({ ...approval('ap-1'), id: nullId })).rejects.toThrow()
    await expect(registry.register({ ...approval('ap-1'), title: '' })).rejects.toThrow()
    await expect(
      registry.register({ ...approval('ap-1'), summary: 'x'.repeat(1_001) })
    ).rejects.toThrow()
    // Valid registration returns a pending promise; do not await it.
    const pending = registry.register({ ...approval('ap-1'), options: ['a', 'b', 'c', 'd'] })
    expect(pending).toBeInstanceOf(Promise)
    await registry.shutdown()
    await expect(pending).rejects.toThrow('HostNodeInteractionRegistry: shutdown')
  })

  it('rejects registration after shutdown', async () => {
    const registry = new HostNodeInteractionRegistry()
    await registry.shutdown()
    await expect(registry.register(approval('ap-1'))).rejects.toThrow(
      'HostNodeInteractionRegistry: shutdown requested'
    )
  })

  it('times out a pending interaction and rejects its promise', async () => {
    const registry = new HostNodeInteractionRegistry({ timeoutMs: 50 })
    const settlement = registry.register(approval('ap-1'))
    expect(registry.listPending()).toHaveLength(1)
    await expect(settlement).rejects.toThrow('HostNodeInteractionRegistry: interaction timed out')
    expect(registry.listPending()).toHaveLength(0)
  })

  it('cancels by run id for a provider child exit', async () => {
    const registry = new HostNodeInteractionRegistry()
    const ap = registry.register(approval('ap-1'))
    void registry.register({ ...approval('ap-2'), runId: 'run-2' })
    expect(registry.cancelByRunId('run-1')).toBe(1)
    expect(registry.listPending()).toHaveLength(1)
    await expect(ap).rejects.toThrow('HostNodeInteractionRegistry: provider child exited')
  })

  it('cancels by thread id', async () => {
    const registry = new HostNodeInteractionRegistry()
    const ap = registry.register(approval('ap-1'))
    void registry.register({ ...approval('ap-2'), threadId: 'thread-2' })
    expect(registry.cancelByThreadId('thread-1')).toBe(1)
    expect(registry.listPending()).toHaveLength(1)
    await expect(ap).rejects.toThrow('HostNodeInteractionRegistry: thread closed')
  })

  it('cancels by exact id', async () => {
    const registry = new HostNodeInteractionRegistry()
    const ap = registry.register(approval('ap-1'))
    expect(registry.cancelById('ap-1')).toBe(true)
    expect(registry.cancelById('ap-1')).toBe(false)
    expect(registry.listPending()).toHaveLength(0)
    await expect(ap).rejects.toThrow('HostNodeInteractionRegistry: interaction cancelled')
  })

  it('deletes the pending entry BEFORE invoking onSettled and onCancelled', async () => {
    const pendingDuringSettle: string[] = []
    const pendingDuringCancel: string[] = []
    const registry = new HostNodeInteractionRegistry({
      onSettled: () => {
        pendingDuringSettle.push(...registry.listPending().map((entry) => entry.id))
      },
      onCancelled: () => {
        pendingDuringCancel.push(...registry.listPending().map((entry) => entry.id))
      }
    })
    const settlement = registry.register(approval('ap-1'))
    registry.decide({ id: 'ap-1', decision: 'accept', actor })
    await expect(settlement).resolves.toMatchObject({ id: 'ap-1' })
    expect(pendingDuringSettle).toEqual([])
    const ap2 = registry.register(approval('ap-2'))
    registry.cancelById('ap-2', 'test: cancelled')
    await expect(ap2).rejects.toThrow('test: cancelled')
    expect(pendingDuringCancel).toEqual([])
  })
})
