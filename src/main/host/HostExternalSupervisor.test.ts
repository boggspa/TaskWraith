import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import type { HostBootstrapWelcome } from '../../shared/hostProtocol'
import { hasExternalHostBootHold, releaseExternalHostBootHold } from './HostExternalBootHold'
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
const CURRENT_PAYLOAD = `sha256:${'a'.repeat(64)}`
const OLD_PAYLOAD = `sha256:${'b'.repeat(64)}`
// resolve() keeps the fixture canonical on win32 too (the constructor guard
// requires resolve(profilePath) === profilePath, which a POSIX literal fails).
const PROFILE = resolve('/p')

describe('HostExternalSupervisor', () => {
  it('rejects noncanonical profiles and marks resolver/spawn failures failed', async () => {
    expect(
      () => new HostExternalSupervisor({ profilePath: 'relative', resolveLaunch: async () => null })
    ).toThrow('options')
    const resolver = new HostExternalSupervisor({
      profilePath: PROFILE,
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
      profilePath: PROFILE,
      probe: async () => {
        throw new Error('offline')
      },
      resolveLaunch: async () => ({
        executable: '/node',
        args: [],
        cwd: '/',
        env: {},
        payloadVersion: CURRENT_PAYLOAD
      }),
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
      profilePath: PROFILE,
      probe: async () => welcome,
      resolveLaunch: async () => null,
      spawn
    })
    await expect(supervisor.ensureAvailable()).resolves.toEqual({ kind: 'existing', welcome })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('keeps a matching payload attached without issuing shutdown', async () => {
    const spawn = vi.fn()
    const shutdownExisting = vi.fn(async () => {})
    const supervisor = new HostExternalSupervisor({
      profilePath: PROFILE,
      probe: async () => ({ welcome, payloadVersion: CURRENT_PAYLOAD }),
      resolveLaunch: async () => ({
        executable: '/node',
        args: [],
        cwd: '/',
        env: {},
        payloadVersion: CURRENT_PAYLOAD
      }),
      shutdownExisting,
      spawn
    })

    await expect(supervisor.ensureAvailable()).resolves.toEqual({ kind: 'existing', welcome })
    expect(shutdownExisting).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('coalesces launch and refuses App-mode Host without spawning', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      unref: vi.fn()
    }) as unknown as ChildProcess
    const probe = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ welcome, payloadVersion: CURRENT_PAYLOAD })
    const supervisor = new HostExternalSupervisor({
      profilePath: PROFILE,
      probe,
      resolveLaunch: async () => ({
        executable: '/node',
        args: ['/cli', 'serve', '--mode', 'production', '--profile', '/p'],
        cwd: '/',
        env: {},
        payloadVersion: CURRENT_PAYLOAD
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
      profilePath: PROFILE,
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
      profilePath: PROFILE,
      probe: async () => {
        throw new Error('offline')
      },
      resolveLaunch: () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              executable: '/node',
              args: [],
              cwd: '/',
              env: {},
              payloadVersion: CURRENT_PAYLOAD
            })
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
      profilePath: PROFILE,
      probe: vi.fn().mockRejectedValue(new Error('offline')),
      resolveLaunch: async () => ({
        executable: '/node',
        args: [],
        cwd: '/',
        env: {},
        payloadVersion: CURRENT_PAYLOAD
      }),
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
        profilePath: PROFILE,
        probe: async () => {
          throw new Error('offline')
        },
        resolveLaunch: async () => ({
          executable: '/node',
          args: [],
          cwd: '/',
          env: {},
          payloadVersion: CURRENT_PAYLOAD
        }),
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

  it('authentically stops and replaces an existing stale Host payload', async () => {
    const order: string[] = []
    const child = Object.assign(new EventEmitter(), {
      pid: 73,
      unref: vi.fn()
    }) as unknown as ChildProcess
    const probe = vi
      .fn()
      .mockResolvedValueOnce({ welcome, payloadVersion: OLD_PAYLOAD })
      .mockResolvedValue({ welcome, payloadVersion: CURRENT_PAYLOAD })
    const supervisor = new HostExternalSupervisor({
      profilePath: PROFILE,
      probe,
      resolveLaunch: async () => ({
        executable: '/node',
        args: [],
        cwd: '/',
        env: {},
        payloadVersion: CURRENT_PAYLOAD
      }),
      shutdownExisting: async () => {
        order.push('shutdown')
      },
      spawn: vi.fn(() => {
        order.push('spawn')
        return child
      }),
      delay: async () => {}
    })

    await expect(supervisor.ensureAvailable()).resolves.toEqual({
      kind: 'launched',
      pid: 73,
      welcome
    })
    expect(order).toEqual(['shutdown', 'spawn'])
    expect(probe).toHaveBeenCalledTimes(2)
  })

  /**
   * S1a review F2: the Host must stay held from readiness until main's own
   * lasting client authenticates, or a slow boot outlasts its last-lease
   * grace. The probe connection behind the returned result is that hold.
   */
  describe('boot hold', () => {
    afterEach(() => {
      releaseExternalHostBootHold()
    })

    const launch = {
      executable: '/node',
      args: [],
      cwd: '/',
      env: {},
      payloadVersion: CURRENT_PAYLOAD
    }

    function fakeChild(pid: number): ChildProcess {
      return Object.assign(new EventEmitter(), { pid, unref: vi.fn() }) as unknown as ChildProcess
    }

    it('holds a launched Host by its final probe until main lets go, and closes every other probe', async () => {
      const stale = { close: vi.fn() }
      const ready = { close: vi.fn() }
      const probe = vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce({ welcome, payloadVersion: OLD_PAYLOAD, connection: stale })
        .mockResolvedValueOnce({ welcome, payloadVersion: CURRENT_PAYLOAD, connection: ready })
      const supervisor = new HostExternalSupervisor({
        profilePath: PROFILE,
        probe,
        resolveLaunch: async () => launch,
        spawn: vi.fn(() => fakeChild(55)),
        delay: async () => {}
      })

      await expect(supervisor.ensureAvailable()).resolves.toEqual({
        kind: 'launched',
        pid: 55,
        welcome
      })
      expect(probe).toHaveBeenCalledTimes(3)
      expect(stale.close).toHaveBeenCalledTimes(1)
      expect(ready.close).not.toHaveBeenCalled()
      expect(hasExternalHostBootHold()).toBe(true)

      // Main's lasting client authenticated: the hold goes, once.
      expect(releaseExternalHostBootHold()).toBe(true)
      expect(ready.close).toHaveBeenCalledTimes(1)
      supervisor.close()
      expect(ready.close).toHaveBeenCalledTimes(1)
    })

    it('holds an existing Host it attaches to until it closes, and never one it replaces', async () => {
      const current = { close: vi.fn() }
      const attached = new HostExternalSupervisor({
        profilePath: PROFILE,
        probe: async () => ({ welcome, payloadVersion: CURRENT_PAYLOAD, connection: current }),
        resolveLaunch: async () => launch
      })
      await expect(attached.ensureAvailable()).resolves.toEqual({ kind: 'existing', welcome })
      expect(current.close).not.toHaveBeenCalled()
      expect(hasExternalHostBootHold()).toBe(true)
      // Teardown before main's client ever took over lets the hold go.
      attached.close()
      expect(current.close).toHaveBeenCalledTimes(1)
      expect(hasExternalHostBootHold()).toBe(false)

      const order: string[] = []
      const old = { close: vi.fn(() => order.push('close old probe')) }
      const replacement = { close: vi.fn() }
      const replacing = new HostExternalSupervisor({
        profilePath: PROFILE,
        probe: vi
          .fn()
          .mockResolvedValueOnce({ welcome, payloadVersion: OLD_PAYLOAD, connection: old })
          .mockResolvedValue({ welcome, payloadVersion: CURRENT_PAYLOAD, connection: replacement }),
        resolveLaunch: async () => launch,
        shutdownExisting: async () => {
          order.push('shutdown')
        },
        spawn: vi.fn(() => {
          order.push('spawn')
          return fakeChild(74)
        }),
        delay: async () => {}
      })
      await expect(replacing.ensureAvailable()).resolves.toMatchObject({ kind: 'launched' })
      expect(order).toEqual(['close old probe', 'shutdown', 'spawn'])
      expect(replacement.close).not.toHaveBeenCalled()
      expect(hasExternalHostBootHold()).toBe(true)
      replacing.close()
      expect(replacement.close).toHaveBeenCalledTimes(1)
    })

    it('lets go of only its own hold when it closes', async () => {
      const held = { close: vi.fn() }
      const holder = new HostExternalSupervisor({
        profilePath: PROFILE,
        probe: async () => ({ welcome, connection: held }),
        resolveLaunch: async () => null
      })
      await holder.ensureAvailable()
      new HostExternalSupervisor({ profilePath: PROFILE, resolveLaunch: async () => null }).close()
      expect(held.close).not.toHaveBeenCalled()
      expect(hasExternalHostBootHold()).toBe(true)
      holder.close()
      expect(held.close).toHaveBeenCalledTimes(1)
    })

    it('closes the probe on every path that fails, and holds nothing', async () => {
      const appMode = { close: vi.fn() }
      await expect(
        new HostExternalSupervisor({
          profilePath: PROFILE,
          probe: async () => ({
            welcome: { ...welcome, hostVersion: '1.9.6' },
            connection: appMode
          }),
          resolveLaunch: async () => null
        }).ensureAvailable()
      ).rejects.toBeInstanceOf(HostExternalProductionModeError)
      expect(appMode.close).toHaveBeenCalledTimes(1)

      const unresolved = { close: vi.fn() }
      await expect(
        new HostExternalSupervisor({
          profilePath: PROFILE,
          probe: async () => ({ welcome, connection: unresolved }),
          resolveLaunch: async () => {
            throw new Error('resolver failed')
          }
        }).ensureAvailable()
      ).rejects.toThrow('resolver failed')
      expect(unresolved.close).toHaveBeenCalledTimes(1)

      // Closed while the launched Host's ready probe was in flight.
      let answer: ((value: unknown) => void) | undefined
      const late = { close: vi.fn() }
      const probe = vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              answer = resolve
            })
        )
      const closing = new HostExternalSupervisor({
        profilePath: PROFILE,
        probe,
        resolveLaunch: async () => launch,
        spawn: vi.fn(() => fakeChild(56)),
        delay: async () => {}
      })
      const pending = closing.ensureAvailable()
      await vi.waitFor(() => expect(answer).toBeTypeOf('function'))
      closing.close()
      answer?.({ welcome, payloadVersion: CURRENT_PAYLOAD, connection: late })
      await expect(pending).rejects.toThrow('closed')
      expect(late.close).toHaveBeenCalledTimes(1)
      expect(hasExternalHostBootHold()).toBe(false)
    })
  })
})
