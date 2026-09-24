import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { HOST_LIFETIME_STOP_DEADLINE_MS } from '../../host-node/HostNodeProductionServer'
import { HostProfileAuthorityLeaseBusyError } from '../../host-runtime/HostProfileAuthorityLease'
import type { HostBootstrapWelcome } from '../../shared/hostProtocol'
import {
  hasExternalHostBootHold,
  releaseAllExternalHostBootHolds,
  releaseExternalHostBootHold
} from './HostExternalBootHold'
import {
  HOST_AUTHORITY_BUSY_PATTERN,
  HOST_EXTERNAL_AUTHORITY_WAIT_MS,
  HostExternalProductionModeError,
  HostExternalSupervisor,
  type HostExternalAuthorityOwner,
  type HostExternalProbeResult
} from './HostExternalSupervisor'

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
const OTHER_PROFILE = resolve('/q')

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
      releaseAllExternalHostBootHolds()
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
      expect(hasExternalHostBootHold(PROFILE)).toBe(true)

      // Main's lease is held on this profile: the hold goes, once.
      expect(releaseExternalHostBootHold(PROFILE)).toBe(true)
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
      expect(hasExternalHostBootHold(PROFILE)).toBe(true)
      // Teardown before main's lease ever took over lets the hold go.
      attached.close()
      expect(current.close).toHaveBeenCalledTimes(1)
      expect(hasExternalHostBootHold(PROFILE)).toBe(false)

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
      expect(hasExternalHostBootHold(PROFILE)).toBe(true)
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
      expect(hasExternalHostBootHold(PROFILE)).toBe(true)
      holder.close()
      expect(held.close).toHaveBeenCalledTimes(1)
    })

    /** S1a re-review RN2: a supervisor on another profile used to close this one's hold. */
    it("keeps each profile's hold: another profile's supervisor neither replaces nor releases it", async () => {
      const heldA = { close: vi.fn() }
      const heldB = { close: vi.fn() }
      const a = new HostExternalSupervisor({
        profilePath: PROFILE,
        probe: async () => ({ welcome, connection: heldA }),
        resolveLaunch: async () => null
      })
      const b = new HostExternalSupervisor({
        profilePath: OTHER_PROFILE,
        probe: async () => ({ welcome, connection: heldB }),
        resolveLaunch: async () => null
      })
      await a.ensureAvailable()
      await b.ensureAvailable()
      expect(heldA.close).not.toHaveBeenCalled()
      expect(hasExternalHostBootHold(PROFILE)).toBe(true)
      expect(hasExternalHostBootHold(OTHER_PROFILE)).toBe(true)
      b.close()
      expect(heldB.close).toHaveBeenCalledTimes(1)
      expect(heldA.close).not.toHaveBeenCalled()
      expect(releaseExternalHostBootHold(PROFILE)).toBe(true)
      expect(heldA.close).toHaveBeenCalledTimes(1)
      a.close()
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
      expect(hasExternalHostBootHold(PROFILE)).toBe(false)
    })
  })

  /** D11: the probe hands back the discovery identity, so the snapshot shows a pid before any inspect. */
  it('returns the discovery identity the probe authenticated through', async () => {
    const process = {
      pid: 5151,
      startedAt: '2026-09-23T10:00:00.000Z',
      hostId: 'host-install-1',
      hostVersion: 'node-host-v1',
      payloadVersion: CURRENT_PAYLOAD
    }
    const supervisor = new HostExternalSupervisor({
      profilePath: PROFILE,
      probe: async () => ({ welcome, payloadVersion: CURRENT_PAYLOAD, process }),
      resolveLaunch: async () => null
    })
    await expect(supervisor.ensureAvailable()).resolves.toEqual({
      kind: 'existing',
      welcome,
      host: {
        pid: 5151,
        hostId: 'host-install-1',
        startedAt: '2026-09-23T10:00:00.000Z',
        payloadVersion: CURRENT_PAYLOAD
      }
    })
  })

  describe('replacing a Host serving another payload (D9)', () => {
    const launch = {
      executable: '/node',
      args: [],
      cwd: '/',
      env: {},
      payloadVersion: CURRENT_PAYLOAD
    }

    it('falls back to verified termination when the stale Host refuses its authenticated stop, then relaunches', async () => {
      const order: string[] = []
      const refused = new Error('Timed out waiting for the Host to acknowledge shutdown.')
      const terminateExisting = vi.fn(async () => {
        order.push('terminate')
        return { kind: 'terminated' as const, pid: 4242 }
      })
      const supervisor = new HostExternalSupervisor({
        profilePath: PROFILE,
        probe: vi
          .fn()
          .mockResolvedValueOnce({ welcome, payloadVersion: OLD_PAYLOAD })
          .mockResolvedValue({ welcome, payloadVersion: CURRENT_PAYLOAD }),
        resolveLaunch: async () => launch,
        shutdownExisting: async () => {
          order.push('shutdown')
          throw refused
        },
        terminateExisting,
        spawn: vi.fn(() => {
          order.push('spawn')
          return Object.assign(new EventEmitter(), {
            pid: 91,
            unref: vi.fn()
          }) as unknown as ChildProcess
        }),
        delay: async () => {}
      })
      await expect(supervisor.ensureAvailable()).resolves.toMatchObject({
        kind: 'launched',
        pid: 91
      })
      expect(order).toEqual(['shutdown', 'terminate', 'spawn'])
      expect(terminateExisting).toHaveBeenCalledWith(PROFILE, refused)
    })

    it('never spawns over a stale Host that verified termination could not prove gone', async () => {
      const spawn = vi.fn()
      const supervisor = new HostExternalSupervisor({
        profilePath: PROFILE,
        probe: async () => ({ welcome, payloadVersion: OLD_PAYLOAD }),
        resolveLaunch: async () => launch,
        shutdownExisting: async () => {
          throw new Error('connect ECONNREFUSED')
        },
        terminateExisting: async () => ({
          kind: 'identity_unavailable' as const,
          pid: 4242,
          detail: 'before SIGKILL'
        }),
        spawn
      })
      await expect(supervisor.ensureAvailable()).rejects.toThrow(
        'External Host could not be replaced: its stop failed (connect ECONNREFUSED) and verified termination ended identity_unavailable (before SIGKILL).'
      )
      expect(supervisor.status).toBe('failed')
      expect(spawn).not.toHaveBeenCalled()
    })
  })

  /**
   * S1a review A2/C2: a Host that stops on its own closes its listener but
   * holds the profile authority for the whole stop, so a Host launched in that
   * window refuses to start. The launch waits that Host out, bounded, and
   * spawns again; anything it cannot verify fails the launch as before.
   */
  describe('waiting out a Host that still holds the profile authority (A2)', () => {
    const BUSY = 'taskwraith-host: The profile authority is held by pid 777 (owner is live).\n'
    const launch = {
      executable: '/node',
      args: [],
      cwd: '/',
      env: {},
      payloadVersion: CURRENT_PAYLOAD
    }

    function childThatExits(pid: number, stderrText: string | null) {
      const stderr = new PassThrough()
      const child = Object.assign(new EventEmitter(), {
        pid,
        unref: vi.fn(),
        stderr
      }) as unknown as ChildProcess & { exitNow(): Promise<void> }
      let exited = false
      child.exitNow = async () => {
        if (exited) return
        exited = true
        if (stderrText) stderr.write(stderrText)
        // Let the bytes flow before 'exit'/'close', as a real child's do.
        await new Promise((resolve) => setImmediate(resolve))
        child.emit('exit', 1, null)
        stderr.end()
        child.emit('close', 1, null)
      }
      return child
    }

    function waitingSupervisor(input: {
      readonly owners: readonly HostExternalAuthorityOwner[]
      readonly children: readonly (ChildProcess & { exitNow(): Promise<void> })[]
      readonly readyAfterSpawn: number
      readonly authorityWaitMs?: number
      readonly now?: () => number
      readonly probeDuringWait?: () => Promise<HostExternalProbeResult>
    }) {
      const spawned: Array<ChildProcess & { exitNow(): Promise<void> }> = []
      const owners = [...input.owners]
      const observeAuthorityOwner = vi.fn(async () => owners.shift() ?? { kind: 'none' as const })
      const lines: string[] = []
      const supervisor = new HostExternalSupervisor({
        profilePath: PROFILE,
        probe: vi.fn(async (): Promise<HostExternalProbeResult> => {
          if (spawned.length >= input.readyAfterSpawn) {
            return { welcome, payloadVersion: CURRENT_PAYLOAD }
          }
          if (input.probeDuringWait && spawned.length > 0) return input.probeDuringWait()
          throw new Error('offline')
        }),
        resolveLaunch: async () => launch,
        spawn: vi.fn(() => {
          const child = input.children[spawned.length]
          spawned.push(child)
          return child
        }),
        // The newest child dies the first time the launch polls it.
        delay: async () => {
          const newest = spawned[spawned.length - 1]
          if (newest && spawned.length < input.readyAfterSpawn) await newest.exitNow()
        },
        observeAuthorityOwner,
        ...(input.authorityWaitMs ? { authorityWaitMs: input.authorityWaitMs } : {}),
        ...(input.now ? { now: input.now } : {}),
        log: (line) => lines.push(line)
      })
      return { supervisor, spawned, observeAuthorityOwner, lines }
    }

    it('waits for a verified Host to let the authority go, then launches again', async () => {
      const first = childThatExits(301, BUSY)
      const second = childThatExits(302, null)
      const { supervisor, spawned, observeAuthorityOwner, lines } = waitingSupervisor({
        owners: [{ kind: 'host', pid: 777 }, { kind: 'host', pid: 777 }, { kind: 'none' }],
        children: [first, second],
        readyAfterSpawn: 2
      })
      await expect(supervisor.ensureAvailable()).resolves.toMatchObject({
        kind: 'launched',
        pid: 302
      })
      expect(spawned).toEqual([first, second])
      expect(observeAuthorityOwner).toHaveBeenCalledTimes(3)
      expect(lines.join('\n')).toContain('held by Host pid 777; waiting up to')
      expect(supervisor.status).toBe('attached-launched')
    })

    it('fails the launch as before when the child exited for any other reason', async () => {
      const crashed = childThatExits(301, 'taskwraith-host: History worker failed\n')
      const { supervisor, spawned, observeAuthorityOwner } = waitingSupervisor({
        owners: [{ kind: 'host', pid: 777 }],
        children: [crashed],
        readyAfterSpawn: 99
      })
      await expect(supervisor.ensureAvailable()).rejects.toThrow('exited 1 before readiness')
      expect(spawned).toHaveLength(1)
      expect(observeAuthorityOwner).not.toHaveBeenCalled()
      expect(supervisor.status).toBe('failed')
    })

    it('never waits on a holder it cannot verify as a Host serving this profile', async () => {
      const { supervisor, spawned } = waitingSupervisor({
        owners: [
          { kind: 'unverifiable', pid: 777, detail: 'it is not a Host serving this profile' }
        ],
        children: [childThatExits(301, BUSY)],
        readyAfterSpawn: 99
      })
      await expect(supervisor.ensureAvailable()).rejects.toThrow(
        'The holder, pid 777, was not waited for: it is not a Host serving this profile.'
      )
      expect(spawned).toHaveLength(1)
      expect(supervisor.status).toBe('failed')
    })

    it('gives up once the holder outlives the wait bound', async () => {
      let clock = 0
      const { supervisor, spawned } = waitingSupervisor({
        owners: Array.from({ length: 50 }, () => ({ kind: 'host' as const, pid: 777 })),
        children: [childThatExits(301, BUSY)],
        readyAfterSpawn: 99,
        authorityWaitMs: 2_000,
        now: () => (clock += 500)
      })
      await expect(supervisor.ensureAvailable()).rejects.toThrow(
        'Host pid 777 still held the profile authority after 2000 ms.'
      )
      expect(spawned).toHaveLength(1)
    })

    it('attaches to a Host that comes up meanwhile instead of launching another', async () => {
      const connection = { close: vi.fn() }
      const { supervisor, spawned } = waitingSupervisor({
        owners: [{ kind: 'host', pid: 777 }],
        children: [childThatExits(301, BUSY)],
        readyAfterSpawn: 99,
        probeDuringWait: async () => ({ welcome, payloadVersion: CURRENT_PAYLOAD, connection })
      })
      try {
        await expect(supervisor.ensureAvailable()).resolves.toMatchObject({ kind: 'existing' })
        expect(spawned).toHaveLength(1)
        // It is held for main's boot like any Host this supervisor attaches to.
        expect(connection.close).not.toHaveBeenCalled()
        expect(hasExternalHostBootHold(PROFILE)).toBe(true)
      } finally {
        releaseAllExternalHostBootHolds()
      }
    })

    it('stops respawning at its attempt bound', async () => {
      const { supervisor, spawned } = waitingSupervisor({
        owners: [{ kind: 'none' }, { kind: 'none' }, { kind: 'none' }],
        children: [
          childThatExits(301, BUSY),
          childThatExits(302, BUSY),
          childThatExits(303, BUSY),
          childThatExits(304, BUSY)
        ],
        readyAfterSpawn: 99
      })
      await expect(supervisor.ensureAvailable()).rejects.toThrow('held by pid 777 (owner is live)')
      expect(spawned).toHaveLength(3)
    })

    it("keeps its wait bound above the Host's own lifetime-stop deadline", () => {
      // Drift pin: the Host ends a stop it decided on within this deadline.
      expect(HOST_EXTERNAL_AUTHORITY_WAIT_MS).toBeGreaterThanOrEqual(
        HOST_LIFETIME_STOP_DEADLINE_MS + 10_000
      )
    })

    it("recognizes exactly the Host's live-owner refusal", () => {
      const owner = {
        schemaVersion: 1 as const,
        purpose: 'taskwraith-host-profile-authority' as never,
        pid: 777,
        processStartIdentity: 'f'.repeat(64),
        processStartedAt: '2026-09-23T10:00:00.000Z',
        acquiredAt: '2026-09-23T10:00:00.000Z',
        token: 'a'.repeat(64)
      }
      expect(
        HOST_AUTHORITY_BUSY_PATTERN.test(
          new HostProfileAuthorityLeaseBusyError(owner, 'live').message
        )
      ).toBe(true)
      // An indeterminate owner cannot be verified, so it is never waited on.
      expect(
        HOST_AUTHORITY_BUSY_PATTERN.test(
          new HostProfileAuthorityLeaseBusyError(owner, 'unknown').message
        )
      ).toBe(false)
    })
  })
})
