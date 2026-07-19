import { describe, expect, it, vi } from 'vitest'
import { completeRegenerableHistoryByteOperation } from './RegenerableHistoryByteCompletion'

describe('completeRegenerableHistoryByteOperation', () => {
  it.each(['descriptor close', 'dictation removal'])(
    'checks revocation after deferred %s before release or publication',
    async () => {
      let resolveCleanup!: () => void
      let current = true
      const events: string[] = []
      const release = vi.fn(() => events.push('release'))
      const completing = completeRegenerableHistoryByteOperation({
        cleanup: () =>
          new Promise<void>((resolve) => {
            resolveCleanup = resolve
          }),
        isCurrent: () => {
          events.push('check')
          return current
        },
        release,
        onCurrent: () => {
          events.push('publish')
          return 'current'
        },
        onRevoked: () => {
          events.push('revoke')
          return 'revoked'
        }
      })

      await Promise.resolve()
      expect(events).toEqual([])
      current = false
      resolveCleanup()

      await expect(completing).resolves.toBe('revoked')
      expect(events).toEqual(['check', 'release', 'revoke'])
      expect(release).toHaveBeenCalledOnce()
    }
  )

  it('publishes only when authority remains current after cleanup', async () => {
    const events: string[] = []
    await expect(
      completeRegenerableHistoryByteOperation({
        cleanup: async () => {
          events.push('cleanup')
        },
        isCurrent: () => {
          events.push('check')
          return true
        },
        onCurrent: () => {
          events.push('publish')
          return 'ok'
        },
        onRevoked: () => 'revoked'
      })
    ).resolves.toBe('ok')
    expect(events).toEqual(['cleanup', 'check', 'publish'])
  })
})
