import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HostProjectionClient } from '../../host-client/HostProjectionClient'
import type { HostAuthority } from '../../host-runtime/HostAuthority'
import { HostLeaseRegistry } from '../../host-runtime/HostLeaseRegistry'
import { HostLocalServer } from '../../host-runtime/HostLocalServer'
import { HostSession } from '../../host-runtime/HostSession'
import {
  TASKWRAITH_DESKTOP_HOST_CAPABILITIES,
  TASKWRAITH_DESKTOP_HOST_CLIENT_ID,
  type HostCapability,
  type HostStatusClientProjection,
  type HostStatusProjection
} from '../../shared/hostProtocol'
import type { HostProjectionTransportErrorReport } from './HostProjectionBroker'
import {
  DESKTOP_GRANT_REFERENCE_CLIENT_ID,
  POISON_BUSY_CAP_MS,
  POISON_MANUAL_RESTART_MESSAGE,
  POISON_RESTART_MIN_INTERVAL_MS,
  POISON_RESTARTS_PER_SESSION,
  POISON_UNAUTHORIZED_MIN,
  POISON_WINDOW_MS,
  HostPoisonDetector,
  createDesktopGrantReferenceProbe,
  createHostPoisonDetector,
  judgeHostPoison
} from './HostPoisonDetector'

/** What the production Host grants a Desktop bind: it does not offer `channels`. */
const GRANTED: HostCapability[] = TASKWRAITH_DESKTOP_HOST_CAPABILITIES.filter(
  (capability) => capability !== 'channels'
)
const NARROWED: HostCapability[] = ['bootstrap', 'health']

function client(
  capabilities: readonly HostCapability[],
  overrides: Partial<HostStatusClientProjection> = {}
): HostStatusClientProjection {
  return {
    clientClass: 'desktop',
    clientId: TASKWRAITH_DESKTOP_HOST_CLIENT_ID,
    connectedForMs: 1_000,
    lease: 'declined',
    capabilities: [...capabilities],
    ...overrides
  }
}

function status(clients: readonly HostStatusClientProjection[], runs = 0): HostStatusProjection {
  return {
    pid: 4242,
    startedAt: '2026-09-23T10:00:00.000Z',
    uptimeMs: 60_000,
    hostId: 'host-install-1',
    profilePath: '/profile',
    persist: false,
    lifetime: { phase: 'held', holders: 1, implicitHolders: 0, declined: clients.length },
    liveWork: { runs },
    clients: [...clients]
  }
}

const POISONED = status([
  client(GRANTED),
  client(NARROWED),
  client(['bootstrap'], { clientId: 'taskwraith-desktop-lease', lease: 'explicit' })
])
const HEALTHY = status([
  client(GRANTED),
  client(['bootstrap'], { clientId: 'taskwraith-desktop-lease', lease: 'explicit' })
])

const UNAUTHORIZED: HostProjectionTransportErrorReport = {
  code: 'unauthorized',
  operation: 'snapshot',
  clientId: TASKWRAITH_DESKTOP_HOST_CLIENT_ID,
  connected: true
}

describe('judgeHostPoison', () => {
  it('confirms a Desktop socket granted less than a fresh bind of the same request', () => {
    expect(judgeHostPoison(POISONED, GRANTED)).toEqual({
      kind: 'confirmed',
      missing: GRANTED.filter((capability) => !NARROWED.includes(capability))
    })
  })

  it('never mistakes a Host that does not offer a capability for a poisoned session', () => {
    // Every Desktop socket lacks `channels`, and so does the reference: the
    // Host never offered it. A "strict subset of the Desktop request" rule
    // would restart this healthy Host on every flood.
    expect(judgeHostPoison(HEALTHY, GRANTED)).toEqual({
      kind: 'unconfirmed',
      why: 'the Desktop grant matches a fresh bind'
    })
  })

  it('reads only Desktop-identity sockets, and needs one to compare', () => {
    const others = status([
      client(['bootstrap'], { clientId: 'taskwraith-desktop-lease', lease: 'explicit' }),
      client(['bootstrap'], { clientClass: 'tui', clientId: 'tui-1' }),
      client(['bootstrap'], { clientClass: 'ios', clientId: undefined })
    ])
    expect(judgeHostPoison(others, GRANTED)).toEqual({
      kind: 'unconfirmed',
      why: 'no Desktop socket is connected to compare'
    })
  })
})

describe('HostPoisonDetector', () => {
  function detector(
    options: {
      readonly status?: () => HostStatusProjection | null
      readonly reference?: readonly HostCapability[] | null
      readonly closing?: () => boolean
      readonly updatePending?: () => boolean
      readonly startFailed?: () => boolean
    } = {}
  ) {
    let clock = 1_000_000
    const lines: string[] = []
    const readHostStatus = vi.fn(async () => (options.status ? options.status() : POISONED))
    const readReferenceGrant = vi.fn(async () =>
      options.reference === undefined ? GRANTED : options.reference
    )
    const restart = vi.fn(async () => ({ ok: true }))
    const notify = vi.fn()
    const delay = vi.fn(async (ms: number) => {
      clock += ms
    })
    const subject = new HostPoisonDetector({
      readHostStatus,
      readReferenceGrant,
      restart,
      isClosing: options.closing ?? (() => false),
      isUpdateRestartPending: options.updatePending ?? (() => false),
      lastStartFailed: options.startFailed ?? (() => false),
      notify,
      now: () => clock,
      delay,
      log: (line) => lines.push(line)
    })
    return {
      subject,
      readHostStatus,
      readReferenceGrant,
      restart,
      notify,
      delay,
      lines,
      advance: (ms: number) => {
        clock += ms
      },
      /** `count` Desktop `unauthorized` answers, one ms apart, then the evaluation. */
      flood: async (count = POISON_UNAUTHORIZED_MIN) => {
        for (let index = 0; index < count; index += 1) {
          subject.report(UNAUTHORIZED)
          clock += 1
        }
        await subject.settled()
      }
    }
  }

  it('restarts the Host once on a confirmed flood of ten within thirty seconds', async () => {
    const value = detector()
    await value.flood(POISON_UNAUTHORIZED_MIN - 1)
    expect(value.readHostStatus).not.toHaveBeenCalled()
    await value.flood(1)
    expect(value.readReferenceGrant).toHaveBeenCalledTimes(1)
    expect(value.restart).toHaveBeenCalledTimes(1)
    expect(value.subject.restartCount).toBe(1)
    expect(value.notify).not.toHaveBeenCalled()
    expect(value.lines.join('\n')).toContain('confirmed: the Desktop grant lacks snapshot')
  })

  it('counts only unauthorized answers under the Desktop identity', async () => {
    const value = detector()
    for (let index = 0; index < 20; index += 1) {
      value.subject.report({ ...UNAUTHORIZED, code: 'host_unavailable' })
      value.subject.report({ ...UNAUTHORIZED, clientId: 'taskwraith-desktop-lease' })
    }
    await value.flood(POISON_UNAUTHORIZED_MIN - 1)
    expect(value.readHostStatus).not.toHaveBeenCalled()
    expect(value.restart).not.toHaveBeenCalled()
  })

  it('forgets answers older than its window', async () => {
    const value = detector()
    await value.flood(POISON_UNAUTHORIZED_MIN - 1)
    value.advance(POISON_WINDOW_MS + 1)
    await value.flood(1)
    expect(value.readHostStatus).not.toHaveBeenCalled()
    await value.flood(POISON_UNAUTHORIZED_MIN - 1)
    expect(value.restart).toHaveBeenCalledTimes(1)
  })

  it('does not restart on an unconfirmed flood', async () => {
    const intact = detector({ status: () => HEALTHY })
    await intact.flood()
    expect(intact.restart).not.toHaveBeenCalled()
    expect(intact.lines.join('\n')).toContain('unconfirmed: the Desktop grant matches a fresh bind')

    const unreadable = detector({ status: () => null })
    await unreadable.flood()
    expect(unreadable.restart).not.toHaveBeenCalled()
    expect(unreadable.readReferenceGrant).not.toHaveBeenCalled()

    const noReference = detector({ reference: null })
    await noReference.flood()
    expect(noReference.restart).not.toHaveBeenCalled()
    expect(noReference.lines.join('\n')).toContain('the Host status could not be read')
  })

  it('never acts while the app quits, an update restart is pending, or after a failed start', async () => {
    for (const [blocked, why] of [
      [{ closing: () => true }, 'the app is quitting'],
      [{ updatePending: () => true }, 'an update restart is pending'],
      [{ startFailed: () => true }, 'the last Host start failed']
    ] as const) {
      const value = detector(blocked)
      await value.flood()
      expect(value.readHostStatus).not.toHaveBeenCalled()
      expect(value.restart).not.toHaveBeenCalled()
      expect(value.lines.join('\n')).toContain(`not acting because ${why}`)
    }
  })

  it('defers the restart while runs are live, then restarts once they are done', async () => {
    let runs = 2
    const value = detector({ status: () => status(POISONED.clients, runs) })
    value.delay.mockImplementation(async () => {
      runs = 0
    })
    await value.flood()
    expect(value.delay).toHaveBeenCalledTimes(1)
    expect(value.restart).toHaveBeenCalledTimes(1)
  })

  it('restarts at the busy cap when runs never finish', async () => {
    const value = detector({ status: () => status(POISONED.clients, 1) })
    await value.flood()
    expect(value.restart).toHaveBeenCalledTimes(1)
    const waited = value.delay.mock.calls.reduce((total, [ms]) => total + ms, 0)
    expect(waited).toBeGreaterThanOrEqual(POISON_BUSY_CAP_MS)
    expect(value.lines.join('\n')).toContain('with runs still live')
  })

  it.each(['stopped', 'replaced'] as const)(
    'abandons a deferred restart when the confirmed Host is %s',
    async (change) => {
      let current: HostStatusProjection | null = status(POISONED.clients, 1)
      const value = detector({ status: () => current })
      value.delay.mockImplementation(async (ms) => {
        value.advance(ms)
        current =
          change === 'stopped'
            ? null
            : { ...status(POISONED.clients, 0), pid: 5151, startedAt: '2026-09-24T01:00:00Z' }
      })
      await value.flood()
      expect(value.delay).toHaveBeenCalledTimes(1)
      expect(value.restart).not.toHaveBeenCalled()
      expect(value.lines.join('\n')).toContain('restart abandoned')
    }
  )

  it('abandons a deferred restart when the app starts quitting', async () => {
    let closing = false
    const value = detector({ status: () => status(POISONED.clients, 1), closing: () => closing })
    value.delay.mockImplementation(async () => {
      closing = true
    })
    await value.flood()
    expect(value.restart).not.toHaveBeenCalled()
    expect(value.lines.join('\n')).toContain('restart abandoned: the app is quitting')
  })

  it('does not auto-restart twice within ten minutes: one manual-restart notice, then nothing', async () => {
    const value = detector()
    await value.flood()
    expect(value.restart).toHaveBeenCalledTimes(1)
    value.advance(POISON_RESTART_MIN_INTERVAL_MS / 2)
    await value.flood()
    expect(value.restart).toHaveBeenCalledTimes(1)
    expect(value.notify).toHaveBeenCalledTimes(1)
    expect(value.notify).toHaveBeenCalledWith(POISON_MANUAL_RESTART_MESSAGE)
    expect(value.subject.isStopped).toBe(true)
    const reads = value.readHostStatus.mock.calls.length
    value.advance(POISON_RESTART_MIN_INTERVAL_MS * 2)
    await value.flood()
    expect(value.readHostStatus).toHaveBeenCalledTimes(reads)
    expect(value.notify).toHaveBeenCalledTimes(1)
  })

  it(`stops after ${POISON_RESTARTS_PER_SESSION} automatic restarts in one app session`, async () => {
    const value = detector()
    for (let round = 0; round < POISON_RESTARTS_PER_SESSION; round += 1) {
      await value.flood()
      value.advance(POISON_RESTART_MIN_INTERVAL_MS + 1)
    }
    expect(value.restart).toHaveBeenCalledTimes(POISON_RESTARTS_PER_SESSION)
    await value.flood()
    expect(value.restart).toHaveBeenCalledTimes(POISON_RESTARTS_PER_SESSION)
    expect(value.notify).toHaveBeenCalledWith(POISON_MANUAL_RESTART_MESSAGE)
    expect(value.subject.isStopped).toBe(true)
  })

  it('runs one evaluation at a time', async () => {
    let answer: (value: HostStatusProjection) => void = () => undefined
    const value = detector()
    value.readHostStatus.mockImplementationOnce(
      () => new Promise<HostStatusProjection>((resolve) => (answer = resolve))
    )
    for (let index = 0; index < POISON_UNAUTHORIZED_MIN * 3; index += 1) {
      value.subject.report(UNAUTHORIZED)
    }
    answer(POISONED)
    await value.subject.settled()
    expect(value.readReferenceGrant).toHaveBeenCalledTimes(1)
    expect(value.restart).toHaveBeenCalledTimes(1)
  })

  it("reads a failed start and the app's quit from the lifecycle", async () => {
    const lifecycle = {
      restart: vi.fn(async () => ({ ok: true })),
      isClosing: false,
      getSnapshot: vi.fn(() => ({ phase: 'failed', reason: 'start-failed' }))
    }
    const lines: string[] = []
    const wired = createHostPoisonDetector({
      profilePath: join(tmpdir(), 'no-host-profile'),
      appVersion: '1.0.0',
      lifecycle,
      readHostStatus: async () => POISONED,
      isUpdateRestartPending: () => false,
      notify: vi.fn(),
      log: (line) => lines.push(line)
    })
    for (let index = 0; index < POISON_UNAUTHORIZED_MIN; index += 1) wired.report(UNAUTHORIZED)
    await wired.settled()
    expect(lines.join('\n')).toContain('not acting because the last Host start failed')

    lifecycle.getSnapshot.mockReturnValue({ phase: 'running', reason: 'app-start' })
    lifecycle.isClosing = true
    for (let index = 0; index < POISON_UNAUTHORIZED_MIN; index += 1) wired.report(UNAUTHORIZED)
    await wired.settled()
    expect(lines.join('\n')).toContain('not acting because the app is quitting')
    expect(lifecycle.restart).not.toHaveBeenCalled()
  })
})

/** The tell, end to end on the real session binding and listener. */
describe('the poisoned Desktop session on a real Host listener', () => {
  const cleanups: Array<() => unknown> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!()
  })

  async function realHost() {
    const profile = mkdtempSync(join(tmpdir(), 'host-poison-'))
    const server = new HostLocalServer({
      userDataPath: profile,
      hostId: 'poison-host',
      hostVersion: 'node-host-v1',
      session: new HostSession({
        host: { hostId: 'poison-host', hostVersion: 'node-host-v1' },
        runtime: { getPosition: () => ({ generation: 1, cursor: 0 }) },
        // As production: everything the Desktop asks for but `channels`.
        hostCapabilityOffer: GRANTED
      }),
      authority: {
        health: vi.fn().mockResolvedValue({
          ok: true,
          value: { hostStatus: 'ok', connectionPhase: 'live', supervised: false, freshness: 'live' }
        })
      } as unknown as HostAuthority,
      leases: new HostLeaseRegistry({
        onExit: () => undefined,
        ports: { monotonicNowNs: () => 0n, wallNowMs: () => 0, schedule: () => () => {} }
      })
    })
    await server.start()
    cleanups.push(async () => {
      await server.stop()
      rmSync(profile, { recursive: true, force: true })
    })
    return profile
  }

  async function connect(
    profile: string,
    clientId: string,
    capabilities: readonly HostCapability[]
  ): Promise<HostProjectionClient> {
    const socket = new HostProjectionClient({
      userDataPath: profile,
      client: { clientId, clientClass: 'desktop', clientVersion: '1.0.0' },
      capabilities: [...capabilities],
      connectTimeoutMs: 2_000,
      requestTimeoutMs: 2_000
    })
    cleanups.push(() => socket.close())
    await socket.connect()
    return socket
  }

  it('confirms a narrowed Desktop grant against the reference probe, and a healthy one never', async () => {
    const profile = await realHost()
    const reference = createDesktopGrantReferenceProbe({ userDataPath: profile, appVersion: '1' })
    const statusReader = await connect(profile, 'taskwraith-desktop-lease', ['bootstrap', 'health'])
    await connect(profile, TASKWRAITH_DESKTOP_HOST_CLIENT_ID, TASKWRAITH_DESKTOP_HOST_CAPABILITIES)

    const granted = await reference()
    expect(granted).toEqual(expect.arrayContaining(GRANTED))
    expect(granted).not.toContain('channels')
    expect(judgeHostPoison(await statusReader.getHostStatus(), granted!).kind).toBe('unconfirmed')

    // One consumer binds the shared identity narrowly: every later Desktop
    // socket is narrowed with it, until the Host restarts.
    await connect(profile, TASKWRAITH_DESKTOP_HOST_CLIENT_ID, NARROWED)
    const later = await connect(
      profile,
      TASKWRAITH_DESKTOP_HOST_CLIENT_ID,
      TASKWRAITH_DESKTOP_HOST_CAPABILITIES
    )
    expect(later.supports('snapshot')).toBe(false)
    // The reference identity is its own binding, never narrowed.
    expect(await reference()).toEqual(granted)
    const verdict = judgeHostPoison(await statusReader.getHostStatus(), granted!)
    expect(verdict.kind).toBe('confirmed')
    expect(verdict.kind === 'confirmed' ? verdict.missing : []).toContain('snapshot')
    expect(DESKTOP_GRANT_REFERENCE_CLIENT_ID).not.toBe(TASKWRAITH_DESKTOP_HOST_CLIENT_ID)
  })

  it("restarts through the lifecycle's poison reason once the real tell is confirmed", async () => {
    const profile = await realHost()
    const statusReader = await connect(profile, 'taskwraith-desktop-lease', ['bootstrap', 'health'])
    await connect(profile, TASKWRAITH_DESKTOP_HOST_CLIENT_ID, NARROWED)
    await connect(profile, TASKWRAITH_DESKTOP_HOST_CLIENT_ID, TASKWRAITH_DESKTOP_HOST_CAPABILITIES)
    const lifecycle = {
      restart: vi.fn(async () => ({ ok: true })),
      isClosing: false,
      getSnapshot: () => ({ phase: 'running', reason: 'app-start' })
    }
    const detector = createHostPoisonDetector({
      profilePath: profile,
      appVersion: '1.0.0',
      lifecycle,
      readHostStatus: () => statusReader.getHostStatus(),
      isUpdateRestartPending: () => false,
      notify: vi.fn()
    })
    for (let index = 0; index < POISON_UNAUTHORIZED_MIN; index += 1) detector.report(UNAUTHORIZED)
    await detector.settled()
    expect(lifecycle.restart).toHaveBeenCalledTimes(1)
    expect(lifecycle.restart).toHaveBeenCalledWith(
      'poison-restart',
      expect.objectContaining({ pid: process.pid, hostId: 'poison-host' })
    )
  })
})
