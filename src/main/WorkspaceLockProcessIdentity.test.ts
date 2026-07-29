import { describe, expect, it, vi } from 'vitest'

import { WorkspaceLockProcessIdentityService } from './WorkspaceLockProcessIdentity'

function missingProcessError(): NodeJS.ErrnoException {
  return Object.assign(new Error('missing'), { code: 'ESRCH' })
}

describe('WorkspaceLockProcessIdentityService', () => {
  it('binds Linux identity to the boot id and exact proc start ticks', async () => {
    const readFile = vi.fn(async (path: string) => {
      if (path.endsWith('/boot_id')) return 'boot-abc\n'
      if (path === '/proc/41/stat') {
        return '41 (name with ) parens) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 4242 20'
      }
      throw missingProcessError()
    })
    const service = new WorkspaceLockProcessIdentityService({
      platform: 'linux',
      selfPid: 41,
      dependencies: {
        readFile,
        processKill: vi.fn()
      }
    })

    const identity = await service.initialize()

    expect(identity).toMatch(/^[a-f0-9]{64}$/)
    expect(await service.observe(41)).toEqual({
      state: 'live',
      processBirthIdentity: identity
    })
  })

  it('uses the private Darwin daemon and rejects missing exact identity', async () => {
    const dispose = vi.fn()
    const service = new WorkspaceLockProcessIdentityService({
      platform: 'darwin',
      selfPid: 77,
      dependencies: {
        createDarwinDaemon: () => ({
          start: vi.fn(async () => undefined),
          request: vi.fn(async () => ({
            pid: 77,
            source: 'procBSDInfo',
            launchTimeMicros: 123456,
            processStartedAt: 'procBSDInfo:123456'
          })),
          dispose
        }),
        processKill: vi.fn()
      }
    })

    expect(await service.initialize()).toMatch(/^[a-f0-9]{64}$/)
    service.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('never treats an identity lookup failure as live from PID alone', async () => {
    const service = new WorkspaceLockProcessIdentityService({
      platform: 'linux',
      selfPid: 50,
      dependencies: {
        readFile: vi.fn(async () => {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
        }),
        processKill: vi.fn()
      }
    })

    await expect(service.initialize()).rejects.toThrow('identity is unavailable')
  })

  it('reports dead only when the OS conclusively reports ESRCH', async () => {
    const service = new WorkspaceLockProcessIdentityService({
      platform: 'linux',
      selfPid: 50,
      dependencies: {
        readFile: vi.fn(async (path: string) => {
          if (path.endsWith('/boot_id')) return 'boot-abc'
          throw missingProcessError()
        }),
        processKill: vi.fn(() => {
          throw missingProcessError()
        })
      }
    })

    expect(await service.observe(999)).toEqual({ state: 'dead' })
  })

  it('uses only the fixed Windows PowerShell path and creation ticks', async () => {
    const execFile = vi.fn(async (_file: string, _args: readonly string[]) => ({
      stdout: '638000000000000000\n'
    }))
    const service = new WorkspaceLockProcessIdentityService({
      platform: 'win32',
      selfPid: 91,
      windowsRoot: 'C:\\Windows',
      dependencies: {
        execFile,
        processKill: vi.fn()
      }
    })

    expect(await service.initialize()).toMatch(/^[a-f0-9]{64}$/)
    expect(execFile.mock.calls[0]?.[0]).toContain(
      'C:\\Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
    )
  })
})
