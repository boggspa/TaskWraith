import { describe, expect, it, vi } from 'vitest'
import { terminateAndJoinMainProviderRun } from './MainProviderRunTermination'

describe('main provider termination', () => {
  it('requires exact identity and does not manufacture missing-session proof', async () => {
    const terminate = vi.fn(async () => true)
    const ports = {
      getSession: () => undefined,
      getOperations: () => [],
      isActive: (status: string) => status === 'running',
      terminate,
      wait: async () => true
    }
    expect(await terminateAndJoinMainProviderRun(ports, 'codex', 'run')).toBe(false)
    expect(
      await terminateAndJoinMainProviderRun(
        { ...ports, getSession: () => ({ provider: 'claude', status: 'running' }) },
        'codex',
        'run'
      )
    ).toBe(false)
    expect(terminate).not.toHaveBeenCalled()
  })

  it('joins terminal callbacks and retries exact child termination after a bounded miss', async () => {
    const operation = Promise.resolve()
    const kill = vi.fn()
    const session = { provider: 'codex', status: 'running', process: { kill } }
    const wait = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const result = await terminateAndJoinMainProviderRun(
      {
        getSession: () => session,
        getOperations: () => [operation, operation],
        isActive: (status) => status === 'running',
        terminate: async () => {
          session.status = 'cancelled'
          return true
        },
        wait
      },
      'codex',
      'run'
    )
    expect(result).toBe(true)
    expect(wait).toHaveBeenCalledTimes(2)
    expect(kill).toHaveBeenCalledWith('SIGKILL')
  })
})
