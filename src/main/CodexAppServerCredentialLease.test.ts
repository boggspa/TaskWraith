import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/taskwraith-codex-credential-lease-test',
    getVersion: () => 'test'
  }
}))

import {
  CodexAppServerClient,
  type CodexAppServerCredentialLease,
  type CodexAppServerStartupDependencies
} from './CodexAppServerClient'
import type { CodexAppServerProcessLaunchPlan } from './codex/CodexAppServerProcessLaunchPlan'

function fakeChildProcess(pid: number | undefined = 4242): ChildProcessWithoutNullStreams {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough
    stdout: PassThrough
    stderr: PassThrough
    killed: boolean
    pid: number | undefined
    kill: ReturnType<typeof vi.fn>
  }
  proc.stdin = new PassThrough()
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  proc.killed = false
  proc.pid = pid
  proc.kill = vi.fn(() => {
    proc.killed = true
    return true
  })
  return proc as unknown as ChildProcessWithoutNullStreams
}

const launchPlan: CodexAppServerProcessLaunchPlan = {
  transport: 'app-server',
  startupCompatibility: 'configured',
  command: '/opt/codex',
  args: Object.freeze(['app-server']),
  shell: false,
  env: Object.freeze({ CODEX_HOME: '/tmp/taskwraith-codex-home' })
}

function harness(
  options: {
    lease?: CodexAppServerCredentialLease | null
    pid?: number | undefined
    spawnThrows?: Error
  } = {}
) {
  const events: string[] = []
  const proc = fakeChildProcess(options.pid === undefined && 'pid' in options ? undefined : 4242)

  const lease: CodexAppServerCredentialLease | null =
    options.lease === undefined
      ? {
          seedIntoIsolatedHome: vi.fn(async () => {
            events.push('seed')
          }),
          noteProviderProcess: vi.fn(async (pid: number) => {
            events.push(`note:${pid}`)
          }),
          commitAndRelease: vi.fn(async () => {
            events.push('release')
            return 'unchanged'
          })
        }
      : options.lease

  const acquireCredentialLease = vi.fn(async () => {
    events.push('acquire')
    return lease
  })
  const spawnProcess = vi.fn(() => {
    events.push('spawn')
    if (options.spawnThrows) throw options.spawnThrows
    return proc
  }) as unknown as typeof spawn

  const dependencies: CodexAppServerStartupDependencies = {
    ensureHomeForLaunch: vi.fn(async () => {}),
    resolveBinary: vi.fn(async () => ({
      provider: 'codex' as const,
      binaryPath: '/opt/codex',
      source: 'path' as const
    })),
    buildProcessLaunchPlan: vi.fn(async () => launchPlan),
    spawnProcess,
    acquireCredentialLease
  }

  const client = new CodexAppServerClient('/tmp/taskwraith-codex-home', () => [], dependencies)
  return { client, proc, events, lease, acquireCredentialLease, spawnProcess }
}

describe('Codex app-server credential lease', () => {
  it('seeds the borrowed credential BEFORE spawn and notes the child after it', async () => {
    // Ordering is the whole contract. Seeding after spawn would hand the CLI a
    // home with no auth.json — the exact "sign-in required" the lease exists to
    // prevent — and noting the pid late leaves a window where a crashed owner's
    // lease looks reclaimable while this app-server is still alive.
    const setup = harness()
    void setup.client.ensureStarted('test').catch(() => {})

    await vi.waitFor(() => expect(setup.events).toContain('note:4242'))
    expect(setup.events).toEqual(['acquire', 'seed', 'spawn', 'note:4242'])
  })

  it('writes the credential back when the app-server exits', async () => {
    const setup = harness()
    void setup.client.ensureStarted('test').catch(() => {})
    await vi.waitFor(() => expect(setup.events).toContain('note:4242'))

    setup.proc.emit('close', 0)
    await vi.waitFor(() => expect(setup.events).toContain('release'))
  })

  it('releases once when the child exits first and dispose follows', async () => {
    // This is the order that actually exercises the once-only guard. The
    // reverse (dispose first) is already covered by the close handler's
    // identity check, because dispose clears this.proc before close lands —
    // so asserting only that direction passes even with the guard removed.
    const setup = harness()
    void setup.client.ensureStarted('test').catch(() => {})
    await vi.waitFor(() => expect(setup.events).toContain('note:4242'))

    setup.proc.emit('close', 0)
    await vi.waitFor(() => expect(setup.events).toContain('release'))
    setup.client.dispose()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(setup.events.filter((event) => event === 'release')).toHaveLength(1)
  })

  it('releases once when dispose runs before the child closes', async () => {
    const setup = harness()
    void setup.client.ensureStarted('test').catch(() => {})
    await vi.waitFor(() => expect(setup.events).toContain('note:4242'))

    setup.client.dispose()
    setup.proc.emit('close', 0)
    await vi.waitFor(() => expect(setup.events).toContain('release'))
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(setup.events.filter((event) => event === 'release')).toHaveLength(1)
  })

  it('hands the credential straight back if the spawn itself throws', async () => {
    // The credential is already seeded at this point. Leaving it claimed would
    // block every later start with "another seat owns the credential".
    const setup = harness({ spawnThrows: new Error('ENOENT') })
    await expect(setup.client.ensureStarted('test')).rejects.toThrow('ENOENT')
    expect(setup.events).toEqual(['acquire', 'seed', 'spawn', 'release'])
  })

  it('starts normally when no lease is available, borrowing nothing', async () => {
    // Consent withheld, no ~/.codex credential, or another instance holding it.
    // Every one of those must degrade to exactly the pre-lease behaviour rather
    // than failing a launch that would otherwise have worked.
    const setup = harness({ lease: null })
    void setup.client.ensureStarted('test').catch(() => {})

    await vi.waitFor(() => expect(setup.events).toContain('spawn'))
    expect(setup.events).toEqual(['acquire', 'spawn'])

    setup.proc.emit('close', 0)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(setup.events).toEqual(['acquire', 'spawn'])
  })

  it('reports consent as stale so the idle daemon restarts and picks it up', async () => {
    // The app-server is long-lived and ensureStarted returns early while it is
    // alive, so enabling the borrow mid-session would otherwise do nothing
    // until the next launch — the setting reads as broken.
    const setup = harness({ lease: null })
    void setup.client.ensureStarted('test').catch(() => {})
    await vi.waitFor(() => expect(setup.client.isRunning()).toBe(true))

    expect(setup.client.hasStaleCredentialLeaseConsent()).toBe(false)
    setup.client.setCredentialLeaseConsent(true)
    expect(setup.client.hasStaleCredentialLeaseConsent()).toBe(true)
  })

  it('does not report stale forever when consent is on but nothing can be borrowed', async () => {
    // Comparing "did we get a lease" instead of "what did the user consent to"
    // would mark a consenting-but-credential-less daemon stale on every
    // accessor call, restarting Codex in a loop.
    const setup = harness({ lease: null })
    setup.client.setCredentialLeaseConsent(true)
    void setup.client.ensureStarted('test').catch(() => {})
    await vi.waitFor(() => expect(setup.client.isRunning()).toBe(true))

    expect(setup.client.hasStaleCredentialLeaseConsent()).toBe(false)
    expect(setup.client.hasStaleCredentialLeaseConsent()).toBe(false)
  })

  it('does not borrow at all unless the caller supplies an acquirer', async () => {
    // The bare client must stay inert: the default dependency borrows nothing,
    // so anything constructing a client without opting in is unaffected.
    const proc = fakeChildProcess()
    const client = new CodexAppServerClient('/tmp/taskwraith-codex-home', () => [], {
      ensureHomeForLaunch: async () => {},
      resolveBinary: async () => ({
        provider: 'codex' as const,
        binaryPath: '/opt/codex',
        source: 'path' as const
      }),
      buildProcessLaunchPlan: async () => launchPlan,
      spawnProcess: (() => proc) as unknown as typeof spawn
    })

    void client.ensureStarted('test').catch(() => {})
    await vi.waitFor(() => expect(client.isRunning()).toBe(true))
  })
})
