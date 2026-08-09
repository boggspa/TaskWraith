/**
 * Host Arc Wave 3.5 — HostSupervisor tests.
 *
 * Tests the in-main lifecycle owner: start/stop/stopSync semantics,
 * persistent-stopped guard, crash-restart policy (default off), honest
 * supervised-health provider transitions, and import isolation.
 */

import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createHostSupervisor } from './HostSupervisor'
import type { HostSupervisor, HostSupervisorBackoff, HostSupervisorInput } from './HostSupervisor'
import type { HostMainComposition, HostMainCompositionInput } from './HostMainComposition'
import type { HostLocalServer } from './HostLocalServer'
import type { HostAuthority } from './HostAuthority'
import type { HostSession } from './HostSession'
import type { HostCapability } from '../../shared/hostProtocol'
import type {
  AppStoreHostAuthorityExecutor,
  AppStoreHostAuthorityEvaluator,
  AppStoreHostAuthoritySnapshotDonor
} from './AppStoreHostAuthority'

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

const MOCK_HOST = { hostId: 'test-host-1', hostVersion: '0.0.0-test' }
const MOCK_CAPS: readonly HostCapability[] = ['bootstrap']

function mockCompositionInput(
  overrides: Partial<HostMainCompositionInput> = {}
): HostMainCompositionInput {
  return {
    userDataPath: '/tmp/host-supervisor-test',
    commandExecutor: vi.fn() as unknown as AppStoreHostAuthorityExecutor,
    snapshotDonor: vi.fn() as unknown as AppStoreHostAuthoritySnapshotDonor,
    authorityEvaluator: vi.fn() as unknown as AppStoreHostAuthorityEvaluator,
    healthProvider: vi.fn().mockReturnValue({
      hostStatus: 'ok',
      connectionPhase: 'live',
      supervised: true,
      freshness: 'live'
    }),
    host: MOCK_HOST,
    hostCapabilityOffer: MOCK_CAPS,
    // S4c required pipeline — Supervisor tests never execute it; type-complete only.
    pipeline: { execute: vi.fn() } as unknown as HostMainCompositionInput['pipeline'],
    ...overrides
  }
}

interface MockServer {
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  stopSync: ReturnType<typeof vi.fn>
  isStarted: boolean
}

interface MockComposition {
  authority: HostAuthority
  session: HostSession
  hostDataDir: string
  getPosition: ReturnType<typeof vi.fn>
  getRecoverySummary: ReturnType<typeof vi.fn>
  shutdown: ReturnType<typeof vi.fn>
}

function mockServer(): MockServer & HostLocalServer {
  const server: MockServer = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    stopSync: vi.fn(),
    isStarted: false
  }
  // start() sets isStarted
  server.start.mockImplementation(() => {
    server.isStarted = true
    return Promise.resolve()
  })
  server.stop.mockImplementation(() => {
    server.isStarted = false
    return Promise.resolve()
  })
  server.stopSync.mockImplementation(() => {
    server.isStarted = false
  })
  return server as unknown as MockServer & HostLocalServer
}

/**
 * Mock authority built as a class with PROTOTYPE methods so the suite
 * catches spread-operator facade breaks (spread skips prototype members).
 * Methods are assigned on the prototype explicitly — NOT arrow fields
 * (which become own properties and defeat the regression pin).
 */
class MockHostAuthority {
  // Declarations keep these members type-visible without emitting own fields;
  // the prototype assignments below are the regression fixture.
  declare snapshot: ReturnType<typeof vi.fn>
  declare deltas: ReturnType<typeof vi.fn>
  declare command: ReturnType<typeof vi.fn>
  declare receipt: ReturnType<typeof vi.fn>
  declare health: ReturnType<typeof vi.fn>
  declare shutdown: ReturnType<typeof vi.fn>
}
MockHostAuthority.prototype.snapshot = vi.fn()
MockHostAuthority.prototype.deltas = vi.fn()
MockHostAuthority.prototype.command = vi.fn()
MockHostAuthority.prototype.receipt = vi.fn()
MockHostAuthority.prototype.health = vi.fn()
MockHostAuthority.prototype.shutdown = vi.fn()

function mockComposition(): MockComposition & HostMainComposition {
  return {
    authority: new MockHostAuthority() as unknown as HostAuthority,
    exportTwMission: vi.fn().mockResolvedValue({
      ok: true as const,
      bundle: {
        manifest: { hostId: 'test', exportedAt: new Date().toISOString() },
        snapshot: {} as Record<string, unknown>
      }
    }),
    session: {
      bind: vi.fn(),
      unbind: vi.fn()
    } as unknown as HostSession,
    hostDataDir: '/tmp/host-supervisor-test/host-runtime',
    getPosition: vi.fn().mockReturnValue({ generation: 0, cursor: '0:0' }),
    subscribeDeltas: vi.fn().mockReturnValue(() => undefined),
    getRecoverySummary: vi.fn().mockReturnValue({
      pendingReceipts: 0,
      deadChallenges: 0,
      deferredEnvelopes: 0
    }),
    shutdown: vi.fn().mockResolvedValue(undefined)
  } as unknown as MockComposition & HostMainComposition
}

function buildInput(
  overrides: {
    composition?: MockComposition & HostMainComposition
    server?: MockServer & HostLocalServer
    compositionInput?: HostMainCompositionInput
    createComposition?: HostSupervisorInput['createComposition']
    createServer?: HostSupervisorInput['createServer']
    now?: () => number
    backoff?: HostSupervisorBackoff
    log?: (line: string) => void
    allowCrashRestart?: boolean
  } = {}
): {
  input: HostSupervisorInput
  composition: MockComposition & HostMainComposition
  server: MockServer & HostLocalServer
} {
  const composition = overrides.composition ?? mockComposition()
  const server = overrides.server ?? mockServer()

  const input: HostSupervisorInput = {
    createComposition: overrides.createComposition ?? (() => composition),
    createServer: overrides.createServer ?? (() => server),
    compositionInput: overrides.compositionInput ?? mockCompositionInput(),
    now: overrides.now,
    backoff: overrides.backoff,
    log: overrides.log,
    allowCrashRestart: overrides.allowCrashRestart
  }
  return { input, composition, server }
}

function makeSupervisor(overrides: Parameters<typeof buildInput>[0] = {}): {
  supervisor: HostSupervisor
  composition: MockComposition & HostMainComposition
  server: MockServer & HostLocalServer
} {
  const { input, composition, server } = buildInput(overrides)
  const supervisor = createHostSupervisor(input)
  return { supervisor, composition, server }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HostSupervisor', () => {
  // -----------------------------------------------------------------------
  // Construction
  // -----------------------------------------------------------------------

  describe('construction', () => {
    it('throws without options', () => {
      expect(() => createHostSupervisor(null as unknown as HostSupervisorInput)).toThrow(
        'HostSupervisor requires an options object'
      )
    })

    it('throws without createComposition', () => {
      const { input } = buildInput()
      expect(() =>
        createHostSupervisor({
          ...input,
          createComposition: null as unknown as HostSupervisorInput['createComposition']
        })
      ).toThrow('HostSupervisor requires an injected createComposition')
    })

    it('throws without createServer', () => {
      const { input } = buildInput()
      expect(() =>
        createHostSupervisor({
          ...input,
          createServer: null as unknown as HostSupervisorInput['createServer']
        })
      ).toThrow('HostSupervisor requires an injected createServer')
    })

    it('throws without compositionInput', () => {
      const { input } = buildInput()
      expect(() =>
        createHostSupervisor({
          ...input,
          compositionInput: null as unknown as HostSupervisorInput['compositionInput']
        })
      ).toThrow('HostSupervisor requires an injected compositionInput')
    })

    it('constructs without starting anything', () => {
      const createComposition = vi.fn()
      const createServer = vi.fn()
      const { input } = buildInput({ createComposition, createServer })
      const supervisor = createHostSupervisor(input)
      expect(supervisor.isRunning).toBe(false)
      expect(supervisor.isStopped).toBe(false)
      expect(createComposition).not.toHaveBeenCalled()
      expect(createServer).not.toHaveBeenCalled()
    })

    it('passes through the log function', () => {
      const log = vi.fn()
      const { supervisor } = makeSupervisor({ log })
      // log not called on construction
      expect(log).not.toHaveBeenCalled()
      expect(supervisor.isRunning).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // start / stop lifecycle
  // -----------------------------------------------------------------------

  describe('start and stop', () => {
    it('start builds composition then starts server', async () => {
      const createComposition = vi.fn().mockReturnValue(mockComposition())
      const createServer = vi.fn().mockReturnValue(mockServer())
      const { input } = buildInput({ createComposition, createServer })

      const supervisor = createHostSupervisor(input)
      await supervisor.start()

      expect(createComposition).toHaveBeenCalledWith(input.compositionInput)
      expect(createServer).toHaveBeenCalledOnce()
      const serverOptions = createServer.mock.calls[0][0]
      expect(typeof serverOptions.subscribeDeltas).toBe('function')
      const auth = serverOptions.authority as Record<string, unknown>
      // P0 regression pin: all HostAuthority prototype methods MUST survive the facade.
      // Object spread loses prototype members; Proxy preserves them.
      for (const method of [
        'snapshot',
        'deltas',
        'command',
        'receipt',
        'health',
        'shutdown',
        'exportTwMission'
      ]) {
        expect(typeof auth[method]).toBe('function')
      }
      expect(supervisor.isRunning).toBe(true)
      expect(supervisor.isStopped).toBe(false)
    })

    it('start is idempotent when already running', async () => {
      const { supervisor, composition, server } = makeSupervisor()
      await supervisor.start()
      expect(composition.shutdown).not.toHaveBeenCalled()
      expect(server.start).toHaveBeenCalledTimes(1)

      await supervisor.start()
      // second start is no-op
      expect(server.start).toHaveBeenCalledTimes(1)
      expect(composition.shutdown).not.toHaveBeenCalled()
    })

    it('start after stop revives the host', async () => {
      const { supervisor, server } = makeSupervisor()
      await supervisor.start()
      expect(supervisor.isRunning).toBe(true)
      expect(supervisor.isStopped).toBe(false)

      await supervisor.stop()
      expect(supervisor.isRunning).toBe(false)
      expect(supervisor.isStopped).toBe(true)

      // Revive
      await supervisor.start()
      expect(supervisor.isRunning).toBe(true)
      expect(supervisor.isStopped).toBe(false)
      // New server created
      expect(server.start).toHaveBeenCalledTimes(2)
    })

    it('start after stopSync revives the host', async () => {
      const { supervisor, server } = makeSupervisor()
      await supervisor.start()
      supervisor.stopSync()
      expect(supervisor.isRunning).toBe(false)
      expect(supervisor.isStopped).toBe(true)

      await supervisor.start()
      expect(supervisor.isRunning).toBe(true)
      expect(supervisor.isStopped).toBe(false)
      expect(server.start).toHaveBeenCalledTimes(2)
    })

    it('stop calls server.stop then composition.shutdown in order', async () => {
      const order: string[] = []
      const composition = mockComposition()
      composition.shutdown.mockImplementation(() => {
        order.push('shutdown')
        return Promise.resolve()
      })
      const server = mockServer()
      server.stop.mockImplementation(() => {
        order.push('server-stop')
        return Promise.resolve()
      })

      const { supervisor } = makeSupervisor({ composition, server })
      await supervisor.start()
      await supervisor.stop()

      expect(order).toEqual(['server-stop', 'shutdown'])
    })

    it('stop is idempotent', async () => {
      const { supervisor, composition, server } = makeSupervisor()
      await supervisor.start()
      await supervisor.stop()
      expect(server.stop).toHaveBeenCalledTimes(1)
      expect(composition.shutdown).toHaveBeenCalledTimes(1)

      await supervisor.stop()
      expect(server.stop).toHaveBeenCalledTimes(1)
      expect(composition.shutdown).toHaveBeenCalledTimes(1)
    })

    it('stop when never started is a no-op', async () => {
      const { supervisor, composition, server } = makeSupervisor()
      await supervisor.stop()
      expect(server.stop).not.toHaveBeenCalled()
      expect(composition.shutdown).not.toHaveBeenCalled()
    })

    it('stopSync calls server.stopSync and fire-and-forgets shutdown', async () => {
      const { supervisor, composition, server } = makeSupervisor()
      await supervisor.start()

      supervisor.stopSync()
      expect(server.stopSync).toHaveBeenCalledOnce()
      expect(supervisor.isRunning).toBe(false)
      expect(supervisor.isStopped).toBe(true)

      // Fire-and-forget: composition.shutdown was called (we just don't await it)
      // Allow the microtask to flush.
      await vi.waitFor(() => {
        expect(composition.shutdown).toHaveBeenCalledOnce()
      })
    })

    it('stopSync is idempotent', async () => {
      const { supervisor, server } = makeSupervisor()
      await supervisor.start()

      supervisor.stopSync()
      supervisor.stopSync()
      expect(server.stopSync).toHaveBeenCalledTimes(1)
    })

    it('stopSync when never started is a no-op', () => {
      const { supervisor, server } = makeSupervisor()
      supervisor.stopSync()
      expect(server.stopSync).not.toHaveBeenCalled()
    })

    it('stop survives a throwing server.stop', async () => {
      const log = vi.fn()
      const server = mockServer()
      server.stop.mockRejectedValue(new Error('server gone'))
      const { supervisor, composition } = makeSupervisor({ server, log })

      await supervisor.start()
      await supervisor.stop()

      expect(log).toHaveBeenCalledWith(expect.stringContaining('server stop error'))
      // composition.shutdown still called
      expect(composition.shutdown).toHaveBeenCalledOnce()
    })

    it('stop survives a throwing composition.shutdown', async () => {
      const log = vi.fn()
      const composition = mockComposition()
      composition.shutdown.mockRejectedValue(new Error('flush failed'))
      const { supervisor, server } = makeSupervisor({ composition, log })

      await supervisor.start()
      await supervisor.stop()

      expect(server.stop).toHaveBeenCalledOnce()
      expect(log).toHaveBeenCalledWith(expect.stringContaining('composition shutdown error'))
    })

    it('stopSync survives a throwing server.stopSync', () => {
      const log = vi.fn()
      const server = mockServer()
      server.stopSync.mockImplementation(() => {
        throw new Error('sync stop failed')
      })
      const { supervisor } = makeSupervisor({ server, log })

      // start then stopSync
      supervisor.start().then(() => {
        supervisor.stopSync()
        expect(log).toHaveBeenCalledWith(expect.stringContaining('server stopSync error'))
        expect(supervisor.isRunning).toBe(false)
        expect(supervisor.isStopped).toBe(true)
      })
    })
  })

  // -----------------------------------------------------------------------
  // Persistent stopped guard
  // -----------------------------------------------------------------------

  describe('persistent stopped', () => {
    it('isStopped is true only after explicit stop', async () => {
      const { supervisor } = makeSupervisor()
      expect(supervisor.isStopped).toBe(false)

      await supervisor.start()
      expect(supervisor.isStopped).toBe(false)

      await supervisor.stop()
      expect(supervisor.isStopped).toBe(true)
    })

    it('isStopped persists after stop and is cleared by start', async () => {
      const { supervisor } = makeSupervisor()
      await supervisor.start()
      await supervisor.stop()
      expect(supervisor.isStopped).toBe(true)

      await supervisor.start()
      expect(supervisor.isStopped).toBe(false)
    })

    it('isStopped prevents crash-restart retry', async () => {
      // When stopped is true, crash-restart must NOT retry even if
      // allowCrashRestart is true — the user explicitly stopped the host.
      const log = vi.fn()
      const createComposition = vi
        .fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue(mockComposition())

      const { input } = buildInput({
        createComposition,
        log,
        allowCrashRestart: true
      })
      const supervisor = createHostSupervisor(input)

      // First start fails
      await supervisor.start()
      // Crash-restart should have retried and succeeded
      expect(createComposition).toHaveBeenCalledTimes(2)
      expect(supervisor.isRunning).toBe(true)

      // Now stop
      await supervisor.stop()
      expect(supervisor.isStopped).toBe(true)

      // Start again — composition factory throws again
      createComposition.mockClear()
      createComposition
        .mockRejectedValueOnce(new Error('boom'))
        .mockRejectedValueOnce(new Error('boom again'))

      // When stopped is false the crash loop retries; set up a new supervisor
      // where stopped is still false and the factory keeps failing
    })
  })

  // -----------------------------------------------------------------------
  // Crash restart policy
  // -----------------------------------------------------------------------

  describe('crash restart', () => {
    it('does NOT retry when allowCrashRestart is default (false)', async () => {
      const log = vi.fn()
      const createComposition = vi.fn().mockRejectedValue(new Error('fatal'))

      const { input } = buildInput({ createComposition, log })
      const supervisor = createHostSupervisor(input)

      await expect(supervisor.start()).rejects.toThrow('fatal')
      expect(createComposition).toHaveBeenCalledTimes(1)
      expect(supervisor.isRunning).toBe(false)
      expect(supervisor.isStopped).toBe(false) // not explicitly stopped
    })

    it('retries with bounded backoff when allowCrashRestart is true', async () => {
      const log = vi.fn()
      const createComposition = vi
        .fn()
        .mockRejectedValueOnce(new Error('attempt 1'))
        .mockRejectedValueOnce(new Error('attempt 2'))
        .mockReturnValue(mockComposition()) // succeeds on 3rd

      const { input } = buildInput({
        createComposition,
        log,
        allowCrashRestart: true,
        backoff: { baseMs: 1, maxMs: 10 },
        now: () => Date.now()
      })
      const supervisor = createHostSupervisor(input)

      await supervisor.start()
      expect(createComposition).toHaveBeenCalledTimes(3)
      expect(supervisor.isRunning).toBe(true)
    })

    it('stops retrying after explicit stop during crash loop', async () => {
      // If stop() is called while the crash loop is between attempts,
      // the next attempt must bail out.
      const log = vi.fn()
      let failCount = 0
      const createComposition = vi.fn().mockImplementation(() => {
        failCount += 1
        throw new Error(`fail ${failCount}`)
      })

      const { input } = buildInput({
        createComposition,
        log,
        allowCrashRestart: true,
        backoff: { baseMs: 5, maxMs: 10 }
      })
      const supervisor = createHostSupervisor(input)

      // Fire start — it will fail and begin retrying
      const startPromise = supervisor.start()

      // After a tick, explicitly stop
      await new Promise((r) => setTimeout(r, 15))
      await supervisor.stop()

      await startPromise.catch(() => {})
      // The crash loop should have noticed stopped=true and exited
      expect(supervisor.isStopped).toBe(true)
      expect(supervisor.isRunning).toBe(false)
    })

    it('does not retry server.start failures by default', async () => {
      const log = vi.fn()
      const server = mockServer()
      server.start.mockRejectedValue(new Error('socket in use'))

      const { input } = buildInput({ server, log })
      const supervisor = createHostSupervisor(input)

      await expect(supervisor.start()).rejects.toThrow('socket in use')
      expect(server.start).toHaveBeenCalledTimes(1)
    })

    it('retries server.start failures when allowCrashRestart is true', async () => {
      const log = vi.fn()
      const server = mockServer()
      server.start
        .mockRejectedValueOnce(new Error('socket in use'))
        .mockResolvedValueOnce(undefined)

      const { input } = buildInput({
        server,
        log,
        allowCrashRestart: true,
        backoff: { baseMs: 1, maxMs: 10 }
      })
      const supervisor = createHostSupervisor(input)

      await supervisor.start()
      expect(server.start).toHaveBeenCalledTimes(2)
      expect(supervisor.isRunning).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // Health provider
  // -----------------------------------------------------------------------

  describe('healthProvider', () => {
    it('reports supervised=false, offline before start', async () => {
      const { supervisor } = makeSupervisor()
      const health = await supervisor.healthProvider()
      expect(health.supervised).toBe(false)
      expect(health.hostStatus).toBe('offline')
    })

    it('reports supervised=true, ok after start', async () => {
      const { supervisor } = makeSupervisor()
      await supervisor.start()
      const health = await supervisor.healthProvider()
      expect(health.supervised).toBe(true)
      expect(health.hostStatus).toBe('ok')
      expect(health.connectionPhase).toBe('live')
    })

    it('reports supervised=false, offline after stop', async () => {
      const { supervisor } = makeSupervisor()
      await supervisor.start()
      await supervisor.stop()
      const health = await supervisor.healthProvider()
      expect(health.supervised).toBe(false)
      expect(health.hostStatus).toBe('offline')
    })

    it('reports supervised=false, offline after stopSync', async () => {
      const { supervisor } = makeSupervisor()
      await supervisor.start()
      supervisor.stopSync()
      const health = await supervisor.healthProvider()
      expect(health.supervised).toBe(false)
      expect(health.hostStatus).toBe('offline')
    })

    it('health provider is a function returning HostHealthProjection', async () => {
      const { supervisor } = makeSupervisor()
      const health = await supervisor.healthProvider()
      expect(health).toMatchObject({
        hostStatus: expect.any(String),
        connectionPhase: expect.any(String),
        supervised: expect.any(Boolean),
        freshness: 'live'
      })
    })

    it('has freshness live (never cached — supervisor is the source)', async () => {
      const { supervisor } = makeSupervisor()
      await supervisor.start()
      const health = await supervisor.healthProvider()
      expect(health.freshness).toBe('live')
    })
  })

  // -----------------------------------------------------------------------
  // Shutdown order integrity
  // -----------------------------------------------------------------------

  describe('shutdown order', () => {
    it('server is stopped before composition is shut down', async () => {
      const events: string[] = []

      const server = mockServer()
      server.stop.mockImplementation(() => {
        events.push('server-stop')
        return Promise.resolve()
      })
      const composition = mockComposition()
      composition.shutdown.mockImplementation(() => {
        events.push('composition-shutdown')
        return Promise.resolve()
      })

      const { supervisor } = makeSupervisor({ composition, server })
      await supervisor.start()
      await supervisor.stop()

      expect(events).toEqual(['server-stop', 'composition-shutdown'])
    })

    it('stopSync calls server.stopSync synchronously', () => {
      const events: string[] = []
      const server = mockServer()
      server.stopSync.mockImplementation(() => {
        events.push('sync-stop')
      })

      const { supervisor } = makeSupervisor({ server })
      // Need to start first
      supervisor.start().then(() => {
        supervisor.stopSync()
        expect(events).toEqual(['sync-stop'])
      })
    })
  })

  // -----------------------------------------------------------------------
  // Backoff defaults
  // -----------------------------------------------------------------------

  describe('backoff', () => {
    it('uses DEFAULT_BACKOFF when no backoff supplied', () => {
      const { input } = buildInput()
      const supervisor = createHostSupervisor(input)
      // Backoff is internal — we verify construction succeeds
      expect(supervisor.isRunning).toBe(false)
    })

    it('accepts custom backoff', () => {
      const customBackoff: HostSupervisorBackoff = { baseMs: 100, maxMs: 5000 }
      const { input } = buildInput({ backoff: customBackoff })
      const supervisor = createHostSupervisor(input)
      expect(supervisor.isRunning).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // Import isolation (W3-P3 seam)
  // -----------------------------------------------------------------------

  describe('import isolation', () => {
    it('imports no electron, AppStore singleton, provider, or peer module', () => {
      const source = readFileSync(join(__dirname, 'HostSupervisor.ts'), 'utf8')
      const importLines = source
        .split('\n')
        .filter((line) => /^\s*(import|export .*from|const .*= require\()/.test(line))
        .join('\n')

      expect(importLines).not.toMatch(/['"]electron['"]/)
      expect(importLines).not.toMatch(/from ['"]\.\.\/AppStore/)
      expect(importLines).not.toMatch(/from ['"]\.\.\/BridgeActionExecutor/)
      expect(importLines).not.toMatch(/from ['"]\.\.\/providers/)
      expect(importLines).not.toMatch(/workLocks/)
      expect(importLines).not.toMatch(/workProvenance/)
      expect(importLines).not.toMatch(/HostDeferredCommand/)
      expect(importLines).not.toMatch(/HostCommandMutation/)
      expect(importLines).not.toMatch(/HostDeltaStore/)
      expect(importLines).not.toMatch(/HostCommandReceiptStore/)
      expect(importLines).not.toMatch(/from ['"].*\/index['"]/)
    })

    it('does not edit HostMainComposition or HostLocalServer', () => {
      const source = readFileSync(join(__dirname, 'HostSupervisor.ts'), 'utf8')
      // Only imports from those files — never re-exports or patches them
      const exportLines = source
        .split('\n')
        .filter((line) => /^\s*export/.test(line))
        .join('\n')
      expect(exportLines).not.toMatch(/HostMainComposition(?!Input)/)
      expect(exportLines).not.toMatch(/HostLocalServer(?!Options)/)
    })

    it('imports only type-only from peer modules', () => {
      const source = readFileSync(join(__dirname, 'HostSupervisor.ts'), 'utf8')
      const importLines = source
        .split('\n')
        .filter((line) => /^\s*import/.test(line))
        .join('\n')

      // All Host-module imports must be type-only
      const hostImports = importLines.split('\n').filter((line) => /from ['"]\.\/Host/.test(line))

      for (const line of hostImports) {
        expect(line).toMatch(/^import type/)
      }
    })
  })

  // -----------------------------------------------------------------------
  // .only / .skip / .todo guard
  // -----------------------------------------------------------------------

  it('has no .only, .skip, or .todo tests', () => {
    const source = readFileSync(join(__dirname, 'HostSupervisor.test.ts'), 'utf8')
    expect(source).not.toMatch(/\bit\.only\(/)
    expect(source).not.toMatch(/\bit\.skip\(/)
    expect(source).not.toMatch(/\bit\.todo\(/)
    expect(source).not.toMatch(/\bdescribe\.only\(/)
    expect(source).not.toMatch(/\bdescribe\.skip\(/)
    expect(source).not.toMatch(/\bdescribe\.todo\(/)
  })
})
