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
    registry.register(approval('ap-1'))
    registry.register(question('q-1'))
    const pending = registry.listPending()
    expect(pending).toHaveLength(2)
    expect(pending).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'ap-1' })]))
    expect(pending).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'q-1' })]))
  })

  it('settles an approval exactly once and reconciles via onSettled', () => {
    const onSettled = vi.fn()
    const registry = new HostNodeInteractionRegistry({ onSettled })
    registry.register(approval('ap-1'))
    const result = registry.decide({ id: 'ap-1', decision: 'accept', actor })
    expect(result.settled).toMatchObject({ id: 'ap-1', kind: 'approval' })
    expect(onSettled).toHaveBeenCalledOnce()
    expect(registry.listPending()).toHaveLength(0)
    expect(registry.decide({ id: 'ap-1', decision: 'decline', actor }).settled).toBeNull()
  })

  it('settles a question exactly once and reconciles via onSettled', () => {
    const onSettled = vi.fn()
    const registry = new HostNodeInteractionRegistry({ onSettled })
    registry.register(question('q-1'))
    const result = registry.answer({ id: 'q-1', decision: 'answer', answer: 'a', actor })
    expect(result.settled).toMatchObject({ id: 'q-1', kind: 'question' })
    expect(onSettled).toHaveBeenCalledOnce()
    expect(registry.listPending()).toHaveLength(0)
  })

  it('rejects invalid id, decision, or actor', () => {
    const registry = new HostNodeInteractionRegistry()
    registry.register(approval('ap-1'))
    expect(registry.decide({ id: 'ap-1', decision: 'bogus' as 'accept', actor }).settled).toBeNull()
    expect(registry.decide({ id: '', decision: 'accept', actor }).settled).toBeNull()
    expect(
      registry.decide({ id: 'ap-1', decision: 'accept', actor: { ...actor, actorId: '' } }).settled
    ).toBeNull()
    expect(registry.listPending()).toHaveLength(1)
  })

  it('rejects cross-kind commands', () => {
    const registry = new HostNodeInteractionRegistry()
    registry.register(approval('ap-1'))
    expect(registry.answer({ id: 'ap-1', decision: 'answer', actor }).settled).toBeNull()
    registry.register(question('q-1'))
    expect(registry.decide({ id: 'q-1', decision: 'accept', actor }).settled).toBeNull()
    expect(registry.listPending()).toHaveLength(2)
  })

  it('cancels all pending interactions on shutdown and never replays', async () => {
    const registry = new HostNodeInteractionRegistry()
    registry.register(approval('ap-1'))
    registry.register(question('q-1'))
    await expect(registry.shutdown()).resolves.toBeUndefined()
    expect(registry.listPending()).toHaveLength(0)
    expect(registry.decide({ id: 'ap-1', decision: 'accept', actor }).settled).toBeNull()
  })

  it('bounds pending entries and evicts oldest when full', () => {
    const registry = new HostNodeInteractionRegistry({ maxPending: 3 })
    registry.register(approval('ap-1'))
    registry.register(approval('ap-2'))
    registry.register(approval('ap-3'))
    registry.register(approval('ap-4'))
    const pending = registry.listPending()
    expect(pending).toHaveLength(3)
    expect(pending.map((p) => p.id)).not.toContain('ap-1')
  })

  it('rejects invalid registrations that carry control characters or missing fields', () => {
    const registry = new HostNodeInteractionRegistry()
    expect(() => registry.register({ ...approval('ap-1'), id: 'ap-1\u0000' })).toThrow()
    expect(() => registry.register({ ...approval('ap-1'), title: '' })).toThrow()
    expect(() => registry.register({ ...approval('ap-1'), summary: 'x'.repeat(1_001) })).toThrow()
    expect(() =>
      registry.register({ ...approval('ap-1'), options: ['a', 'b', 'c', 'd'] })
    ).not.toThrow()
  })
})
