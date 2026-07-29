import { describe, expect, it, vi } from 'vitest'

import { waitForWorkspaceLockProcessTreeExit } from './WorkspaceLockProcessTree'

describe('waitForWorkspaceLockProcessTreeExit', () => {
  it('accepts only a definite ESRCH for an isolated POSIX process group', async () => {
    await expect(
      waitForWorkspaceLockProcessTreeExit(
        { rootPid: 42, isolatedProcessGroup: true },
        { timeoutMs: 0 },
        {
          platform: 'linux',
          signalProcessGroup: () => {
            throw Object.assign(new Error('gone'), { code: 'ESRCH' })
          }
        }
      )
    ).resolves.toBe(true)
  })

  it('retains when the group is live or cannot be inspected', async () => {
    await expect(
      waitForWorkspaceLockProcessTreeExit(
        { rootPid: 42, isolatedProcessGroup: true },
        { timeoutMs: 0 },
        { platform: 'darwin', signalProcessGroup: () => undefined }
      )
    ).resolves.toBe(false)
    await expect(
      waitForWorkspaceLockProcessTreeExit(
        { rootPid: 42, isolatedProcessGroup: true },
        { timeoutMs: 0 },
        {
          platform: 'darwin',
          signalProcessGroup: () => {
            throw Object.assign(new Error('denied'), { code: 'EPERM' })
          }
        }
      )
    ).resolves.toBe(false)
  })

  it('polls until the isolated group disappears', async () => {
    const probe = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' })
      })
    await expect(
      waitForWorkspaceLockProcessTreeExit(
        { rootPid: 42, isolatedProcessGroup: true },
        { timeoutMs: 10_000, pollIntervalMs: 1 },
        {
          platform: 'linux',
          signalProcessGroup: probe,
          wait: async () => undefined
        }
      )
    ).resolves.toBe(true)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('fails closed without an isolated POSIX group', async () => {
    const probe = vi.fn()
    await expect(
      waitForWorkspaceLockProcessTreeExit(
        { rootPid: 42, isolatedProcessGroup: false },
        {},
        { platform: 'linux', signalProcessGroup: probe }
      )
    ).resolves.toBe(false)
    await expect(
      waitForWorkspaceLockProcessTreeExit(
        { rootPid: 42, isolatedProcessGroup: true },
        {},
        { platform: 'win32', signalProcessGroup: probe }
      )
    ).resolves.toBe(false)
    expect(probe).not.toHaveBeenCalled()
  })
})
