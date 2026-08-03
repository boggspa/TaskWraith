import { describe, expect, it } from 'vitest'

import { CodexClientRunCohortRegistry } from './CodexClientRunCohort'

describe('CodexClientRunCohortRegistry', () => {
  it('lets compatible distinct runs overlap and closes only after the final owner', async () => {
    const registry = new CodexClientRunCohortRegistry<{ id: string }>()
    let closeCount = 0
    const first = registry.open('run-a', 'compatible', { id: 'client-a' }, async () => {
      closeCount += 1
    })
    const second = registry.tryJoin('run-b', 'compatible')

    expect(second?.resource).toBe(first.resource)
    await first.release()
    expect(closeCount).toBe(0)
    await second?.release()
    expect(closeCount).toBe(1)
  })

  it('refuses mismatched or closed admission without disturbing active owners', async () => {
    const registry = new CodexClientRunCohortRegistry<{ id: string }>()
    let closeCount = 0
    const owner = registry.open('run-a', 'profile-a', { id: 'client-a' }, async () => {
      closeCount += 1
    })

    expect(registry.tryJoin('run-b', 'profile-b')).toBeNull()
    registry.stopAccepting()
    expect(registry.tryJoin('run-c', 'profile-a')).toBeNull()
    await owner.release()
    expect(closeCount).toBe(1)

    const successor = registry.open('run-b', 'profile-b', { id: 'client-b' }, async () => {
      closeCount += 1
    })
    await successor.release()
    expect(closeCount).toBe(2)
  })

  it('runs the post-close transition only after the cohort stops accepting joins', async () => {
    const registry = new CodexClientRunCohortRegistry<object>()
    let couldJoinDuringAfterClose: boolean | null = null
    const owner = registry.open(
      'run-a',
      'compatible',
      {},
      async () => {},
      () => {
        couldJoinDuringAfterClose = registry.tryJoin('run-b', 'compatible') !== null
      }
    )

    await owner.release()
    expect(couldJoinDuringAfterClose).toBe(false)
  })

  it('keeps a configuration-neutral read borrower inside the exact teardown fence', async () => {
    const registry = new CodexClientRunCohortRegistry<{ id: string }>()
    let closeCount = 0
    const owner = registry.open('run-a', 'profile-a', { id: 'client-a' }, async () => {
      closeCount += 1
    })
    const reader = registry.tryBorrow('status-read')

    expect(reader?.resource).toBe(owner.resource)
    await owner.release()
    expect(closeCount).toBe(0)
    await reader?.release()
    expect(closeCount).toBe(1)
  })

  it('does not let duplicate or stale owners release another cohort', async () => {
    const registry = new CodexClientRunCohortRegistry<object>()
    const owner = registry.open('run-a', 'compatible', {}, async () => {})
    expect(() => registry.tryJoin('run-a', 'compatible')).toThrow(/already owns/)
    await owner.release()
    await expect(owner.release()).resolves.toBeUndefined()
  })
})
