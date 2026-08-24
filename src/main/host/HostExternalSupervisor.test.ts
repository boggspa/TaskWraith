import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import type { HostBootstrapWelcome } from '../../shared/hostProtocol'
import { HostExternalProductionModeError, HostExternalSupervisor } from './HostExternalSupervisor'

const welcome = {
  hostVersion: 'node-host-v1',
  capabilities: [
    'commands',
    'receipts',
    'setup',
    'provider-catalog',
    'provider-auth',
    'history',
    'health'
  ]
} as HostBootstrapWelcome

describe('HostExternalSupervisor', () => {
  it('rejects noncanonical profiles and marks resolver/spawn failures failed', async () => {
    expect(
      () => new HostExternalSupervisor({ profilePath: 'relative', resolveLaunch: async () => null })
    ).toThrow('options')
    const resolver = new HostExternalSupervisor({
      profilePath: '/p',
      probe: async () => {
        throw new Error('offline')
      },
      resolveLaunch: async () => {
        throw new Error('resolver failed')
      }
    })
    await expect(resolver.ensureAvailable()).rejects.toThrow('resolver failed')
    expect(resolver.status).toBe('failed')
    const spawning = new HostExternalSupervisor({
      profilePath: '/p',
      probe: async () => {
        throw new Error('offline')
      },
      resolveLaunch: async () => ({ executable: '/node', args: [], cwd: '/', env: {} }),
      spawn: () => {
        throw new Error('spawn failed')
      }
    })
    await expect(spawning.ensureAvailable()).rejects.toThrow('spawn failed')
    expect(spawning.status).toBe('failed')
  })
  it('has no Electron, AppStore, TUI, or dynamic-import dependency', () => {
    for (const name of ['HostExternalSupervisor.ts', 'HostExternalLaunchResolver.ts']) {
      const source = readFileSync(join(process.cwd(), 'src/main/host', name), 'utf8')
      const imports = source
        .split('\n')
        .filter((line) => line.startsWith('import'))
        .join('\n')
      expect(imports).not.toMatch(/electron|AppStore|\.\.\/\.\.\/tui|import\s*\(/i)
    }
  })
  it('attaches an existing production Host without spawning', async () => {
    const spawn = vi.fn()
    const supervisor = new HostExternalSupervisor({
      profilePath: '/p',
      probe: async () => welcome,
      resolveLaunch: async () => null,
      spawn
    })
    await expect(supervisor.ensureAvailable()).resolves.toEqual({ kind: 'existing', welcome })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('coalesces launch and refuses App-mode Host without spawning', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      unref: vi.fn()
    }) as unknown as ChildProcess
    const probe = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(welcome)
    const supervisor = new HostExternalSupervisor({
      profilePath: '/p',
      probe,
      resolveLaunch: async () => ({
        executable: '/node',
        args: ['/cli', 'serve', '--mode', 'production', '--profile', '/p'],
        cwd: '/',
        env: {}
      }),
      spawn: vi.fn(() => child),
      delay: async () => {}
    })
    await expect(
      Promise.all([supervisor.ensureAvailable(), supervisor.ensureAvailable()])
    ).resolves.toEqual([
      { kind: 'launched', pid: 42, welcome },
      { kind: 'launched', pid: 42, welcome }
    ])
    const incompatible = new HostExternalSupervisor({
      profilePath: '/p',
      probe: async () => ({ ...welcome, hostVersion: '1.9.6' }),
      resolveLaunch: async () => null
    })
    await expect(incompatible.ensureAvailable()).rejects.toBeInstanceOf(
      HostExternalProductionModeError
    )
  })

  it('never spawns after close wins the resolve race', async () => {
    let release: (() => void) | undefined
    const spawn = vi.fn()
    const supervisor = new HostExternalSupervisor({
      profilePath: '/p',
      probe: async () => {
        throw new Error('offline')
      },
      resolveLaunch: () =>
        new Promise((resolve) => {
          release = () => resolve({ executable: '/node', args: [], cwd: '/', env: {} })
        }),
      spawn
    })
    const pending = supervisor.ensureAvailable()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    supervisor.close()
    release?.()
    await expect(pending).rejects.toThrow('closed')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('wakes a never-resolving poll when closed without killing the child', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 7,
      unref: vi.fn(),
      kill: vi.fn()
    }) as unknown as ChildProcess
    const supervisor = new HostExternalSupervisor({
      profilePath: '/p',
      probe: vi.fn().mockRejectedValue(new Error('offline')),
      resolveLaunch: async () => ({ executable: '/node', args: [], cwd: '/', env: {} }),
      spawn: vi.fn(() => child),
      delay: () => new Promise<void>(() => {})
    })
    const pending = supervisor.ensureAvailable()
    await vi.waitFor(() =>
      expect((child as unknown as { unref: ReturnType<typeof vi.fn> }).unref).toHaveBeenCalled()
    )
    supervisor.close()
    await expect(pending).rejects.toThrow('closed')
    expect(supervisor.status).toBe('closed')
    expect((child as unknown as { kill: ReturnType<typeof vi.fn> }).kill).not.toHaveBeenCalled()
  })

  it('fails promptly for a child error or nonzero exit and never kills it on close', async () => {
    for (const event of ['error', 'exit'] as const) {
      const child = Object.assign(new EventEmitter(), {
        pid: 9,
        unref: vi.fn(),
        kill: vi.fn()
      }) as unknown as ChildProcess
      const spawn = vi.fn(() => child)
      const supervisor = new HostExternalSupervisor({
        profilePath: '/p',
        probe: async () => {
          throw new Error('offline')
        },
        resolveLaunch: async () => ({ executable: '/node', args: [], cwd: '/', env: {} }),
        spawn,
        delay: async () => {
          event === 'error'
            ? child.emit('error', new Error('spawn fail'))
            : child.emit('exit', 2, null)
        }
      })
      await expect(supervisor.ensureAvailable()).rejects.toThrow(
        event === 'error' ? 'spawn fail' : 'exited 2'
      )
      supervisor.close()
      expect((child as unknown as { kill: ReturnType<typeof vi.fn> }).kill).not.toHaveBeenCalled()
    }
  })
})
