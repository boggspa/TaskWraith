import { describe, expect, it, vi } from 'vitest'

import { attemptLiveSteering } from './liveSteering'

const input = {
  chatId: 'chat-1',
  activeRunId: 'active-1',
  queuedRunId: 'queued-1',
  ownerToken: 'owner-1'
}

describe('attemptLiveSteering', () => {
  it.each(['injected', 'broker-pending'] as const)(
    'treats %s as a live attempt owned by main',
    async (status) => {
      const result = await attemptLiveSteering(
        {
          injectSteering: vi.fn(async () => ({
            status,
            strategy: 'transport',
            entryId: 'entry-1'
          }))
        },
        input
      )
      expect(result.kind).toBe('accepted')
    }
  )

  it('reports a main-owned boundary fallback without retrying the injection', async () => {
    const result = await attemptLiveSteering(
      {
        injectSteering: vi.fn(async () => ({
          status: 'boundary' as const,
          strategy: 'boundary',
          entryId: 'entry-1'
        }))
      },
      input
    )
    expect(result.kind).toBe('boundary')
  })

  it('reports old preload and IPC failure as unavailable for renderer fallback', async () => {
    await expect(attemptLiveSteering({}, input)).resolves.toEqual({ kind: 'unavailable' })
    const error = new Error('ipc unavailable')
    await expect(
      attemptLiveSteering({ injectSteering: vi.fn(async () => Promise.reject(error)) }, input)
    ).resolves.toEqual({ kind: 'unavailable', error })
  })
})
