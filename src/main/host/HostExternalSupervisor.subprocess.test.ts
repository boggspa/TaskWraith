import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn as nodeSpawn, spawnSync, type ChildProcess } from 'node:child_process'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { HostProjectionClient } from '../../host-client/HostProjectionClient'
import {
  HOST_LEASE_DISABLED_ENV,
  HOST_LEASE_TIMING_ENV,
  HOST_PERSIST_ENV
} from '../../host-runtime/HostLeaseRegistry'
import { HOST_PROFILE_AUTHORITY_LEASE_FILENAME } from '../../host-runtime/HostProfileAuthorityLease'
import {
  taskWraithHostDiscoveryPath,
  taskWraithHostSocketPath,
  taskWraithHostTokenPath
} from '../../shared/taskWraithHostPaths.node'
import {
  hasExternalHostBootHold,
  releaseAllExternalHostBootHolds,
  releaseExternalHostBootHold
} from './HostExternalBootHold'
import { createHostExternalLifecycleAdapter } from './HostExternalLifecycleAdapter'
import { resolveHostExternalLaunch } from './HostExternalLaunchResolver'
import { HostExternalSupervisor } from './HostExternalSupervisor'
import { startDesktopHostLease, type DesktopHostLeaseWiring } from './HostLeaseReasons'
import { HostLifecycleController } from './HostLifecycleController'
import { createHostProjectionBroker } from './HostProjectionBroker'

function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    const timer = setTimeout(() => reject(new Error('external Host did not exit')), timeoutMs)
    timer.unref?.()
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The real binary through the real Desktop pieces: the production launch
 * resolver, the supervisor that spawns and probes the Host, main's projection
 * broker, the lifecycle controller and main's own lease. Every Host here
 * serves a temporary profile and publishes to a temporary registry root.
 */
describe('external Host supervisor subprocess', () => {
  const GRACE_MS = 1_500
  const TIMING = `heartbeat:200,ttl:1000,grace:${GRACE_MS}`
  const spawned: ChildProcess[] = []
  const stderrOf = new Map<ChildProcess, string>()
  let root = ''

  /** Spawns for the supervisor and keeps every Host's stderr, bounded. */
  const spawnTracked = (
    executable: string,
    args: readonly string[],
    options: Parameters<typeof nodeSpawn>[2]
  ): ChildProcess => {
    const child = nodeSpawn(executable, [...args], options)
    spawned.push(child)
    capture(child)
    return child
  }

  /** (Re-)attaches the reader: a launch that succeeds drops the supervisor's readers. */
  function capture(child: ChildProcess): () => string {
    if (!stderrOf.has(child)) stderrOf.set(child, '')
    child.stderr?.on('data', (chunk: string | Buffer) => {
      const text = stderrOf.get(child) ?? ''
      if (text.length < 64 * 1024) stderrOf.set(child, text + String(chunk))
    })
    return () => stderrOf.get(child) ?? ''
  }

  function freshProfile(name: string): string {
    const profile = join(root, name)
    mkdirSync(profile)
    return profile
  }

  async function productionLaunch(profile: string, nodeArgs: readonly string[] = []) {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: '',
      // Never the real machine-wide registry.
      TASKWRAITH_HOST_REGISTRY_ROOT: join(root, 'registry')
    }
    delete environment[HOST_PERSIST_ENV]
    delete environment[HOST_LEASE_DISABLED_ENV]
    const production = await resolveHostExternalLaunch({
      profilePath: profile,
      packaged: false,
      repoRoot: root,
      env: environment
    })
    if (!production) throw new Error('the built Host payload was not found')
    // The launcher strips the test-only timing; put it back for this Host only.
    return {
      ...production,
      args: [...nodeArgs, ...production.args],
      env: { ...production.env, [HOST_LEASE_TIMING_ENV]: TIMING }
    }
  }

  function expectArtefactsGone(profile: string): void {
    expect(existsSync(taskWraithHostDiscoveryPath(profile))).toBe(false)
    expect(existsSync(taskWraithHostTokenPath(profile))).toBe(false)
    expect(existsSync(taskWraithHostSocketPath(profile))).toBe(false)
    expect(existsSync(join(profile, HOST_PROFILE_AUTHORITY_LEASE_FILENAME))).toBe(false)
  }

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'host-external-subprocess-')))
    // The development payload layout the resolver expects: <repo>/out/host.
    const hostRoot = join(root, 'out', 'host')
    const compile = spawnSync(
      process.execPath,
      [
        join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc'),
        '-p',
        join(process.cwd(), 'src', 'host-runtime', 'tsconfig.json'),
        '--outDir',
        hostRoot
      ],
      { cwd: process.cwd(), encoding: 'utf8' }
    )
    expect(compile.status, compile.stdout).toBe(0)
    const workers = spawnSync(
      process.execPath,
      [
        join(process.cwd(), 'scripts', 'build-history-workers.cjs'),
        '--outdir',
        join(hostRoot, 'host-node')
      ],
      { cwd: process.cwd(), encoding: 'utf8' }
    )
    expect(workers.status, workers.stderr).toBe(0)
  }, 180_000)

  afterEach(async () => {
    releaseAllExternalHostBootHolds()
    for (const child of spawned.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        try {
          await waitForExit(child)
        } catch {
          child.kill('SIGKILL')
          await waitForExit(child)
        }
      }
      // Reaped: the pid no longer names a process this test started.
      expect(() => process.kill(child.pid!, 0)).toThrow()
    }
    stderrOf.clear()
  })

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it("keeps a Host it launched through a main boot that outlasts the grace, until main's lease is held", async () => {
    const profile = freshProfile('boot')
    const supervisor = new HostExternalSupervisor({
      profilePath: profile,
      resolveLaunch: () => productionLaunch(profile),
      spawn: spawnTracked
    })
    const broker = createHostProjectionBroker({
      userDataPath: profile,
      appVersion: 'boot-hold-subprocess'
    })
    let lifecycle: HostLifecycleController | null = null
    let wiring: DesktopHostLeaseWiring | null = null
    try {
      const prepared = await supervisor.ensureAvailable()
      expect(prepared).toMatchObject({ kind: 'launched' })
      expect(spawned).toHaveLength(1)
      const host = spawned[0]
      const hostStderr = capture(host)
      // Before readiness the Host has only its start-up grace; from readiness
      // on it must never be without a holder.
      const atReadiness = hostStderr().length
      const sinceReadiness = () => hostStderr().slice(atReadiness)
      expect(hasExternalHostBootHold(profile)).toBe(true)

      // Main asks for the Host, then boots synchronously for twice the grace.
      const first = broker.snapshot()
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2 * GRACE_MS)
      let snapshot = await first
      // The first connect's deadline can expire inside the block; main retries.
      for (let attempt = 0; !snapshot.ok && attempt < 20; attempt += 1) {
        await sleep(100)
        snapshot = await broker.snapshot()
      }
      expect(host.exitCode, hostStderr()).toBeNull()
      expect(snapshot.ok, snapshot.ok ? hostStderr() : `${snapshot.error}\n${hostStderr()}`).toBe(
        true
      )
      // S1a re-review RN3: the broker's socket declined. It neither holds the
      // Host nor lets the spawner's hold go; only main's lease does that.
      expect(hasExternalHostBootHold(profile)).toBe(true)

      lifecycle = new HostLifecycleController({
        createSupervisor: () =>
          createHostExternalLifecycleAdapter({
            profilePath: profile,
            supervisor,
            preparedResult: prepared
          }),
        onOffline: () => broker.close()
      })
      wiring = startDesktopHostLease({
        profilePath: profile,
        appVersion: 'boot-hold-subprocess',
        lifecycle,
        releaseBootHold: (profilePath) => releaseExternalHostBootHold(profilePath)
      })
      await expect(lifecycle.start('app-start')).resolves.toMatchObject({ ok: true })
      wiring.reasons.hold('app')
      const lease = wiring.lease
      await waitFor(() => lease.held, "main's lease")
      expect(hasExternalHostBootHold(profile)).toBe(false)

      // Two graces on, main's lease alone holds the Host: the broker declined.
      await sleep(2 * GRACE_MS)
      expect(host.exitCode, hostStderr()).toBeNull()
      const status = await wiring.readHostStatus()
      expect(status?.pid).toBe(host.pid)
      expect(status?.lifetime).toMatchObject({ phase: 'held', holders: 1, implicitHolders: 0 })
      expect(status!.lifetime.declined).toBeGreaterThanOrEqual(1)
      expect(status!.clients.filter((client) => client.lease === 'explicit')).toEqual([
        expect.objectContaining({ clientId: 'taskwraith-desktop-lease' })
      ])
      // Never without a holder from readiness on: no grace ever armed.
      expect(sinceReadiness()).not.toContain('grace armed')
      expect(sinceReadiness()).not.toContain('exit requested')
      expect(wiring.leaseProjection()).toEqual({ mode: 'lease', held: true, reasons: ['app'] })

      // Quit in will-quit's order: the release first, then the lifecycle
      // detaches. The Host goes one grace later, on its own.
      expect(wiring.releaseSync()).toBe(true)
      lifecycle.stopSync()
      broker.close()
      const leftAt = Date.now()
      await waitForExit(host)
      expect(host.exitCode, hostStderr()).toBe(0)
      expect(host.signalCode).toBeNull()
      expect(Date.now() - leftAt).toBeGreaterThanOrEqual(GRACE_MS - 300)
      expect(hostStderr()).toContain('stopping after the last client lease (idle)')
      expectArtefactsGone(profile)
    } finally {
      wiring?.releaseSync()
      lifecycle?.stopSync()
      broker.close()
      supervisor.close()
    }
  }, 90_000)

  /**
   * S1a review A2/C2 on the real binary. A Host stopping on its own closes its
   * listener first and holds the profile authority until its cleanup is done;
   * a Host launched in that window used to refuse to start and fail the
   * launch. A preload slows this Host's history writers' drain, a step that
   * runs after the listener has closed, so the window is seconds wide.
   */
  it('waits out a stopping Host that still holds the profile authority, then launches its own', async () => {
    const profile = freshProfile('authority')
    const hostRoot = join(root, 'out', 'host')
    const publisher = join(
      hostRoot,
      'host-shared',
      'thread-catalogue',
      'ThreadCatalogueSourcePublisher.js'
    )
    expect(existsSync(publisher)).toBe(true)
    const hook = join(root, 'slow-writers-drain.cjs')
    writeFileSync(
      hook,
      [
        "'use strict'",
        `const { ThreadCatalogueSourcePublisher } = require(${JSON.stringify(publisher)})`,
        'const dispose = ThreadCatalogueSourcePublisher.prototype.dispose',
        'ThreadCatalogueSourcePublisher.prototype.dispose = function (...args) {',
        '  return new Promise((resolve) => setTimeout(resolve, 8000)).then(() => dispose.apply(this, args))',
        '}',
        ''
      ].join('\n')
    )

    const first = new HostExternalSupervisor({
      profilePath: profile,
      resolveLaunch: () => productionLaunch(profile, ['--require', hook]),
      spawn: spawnTracked
    })
    await expect(first.ensureAvailable()).resolves.toMatchObject({ kind: 'launched' })
    const stopping = spawned[0]
    const stoppingStderr = capture(stopping)
    // Its only holder goes: one grace later it stops on its own, and keeps the
    // authority for seconds after its listener has gone.
    first.close()
    await waitFor(
      () => stoppingStderr().includes('stopping after the last client lease (idle)'),
      'the lifetime stop'
    )
    await waitFor(() => !existsSync(taskWraithHostDiscoveryPath(profile)), 'the listener to close')
    expect(stopping.exitCode, stoppingStderr()).toBeNull()
    expect(existsSync(join(profile, HOST_PROFILE_AUTHORITY_LEASE_FILENAME))).toBe(true)

    const lines: string[] = []
    const second = new HostExternalSupervisor({
      profilePath: profile,
      resolveLaunch: () => productionLaunch(profile),
      spawn: spawnTracked,
      log: (line) => lines.push(line)
    })
    try {
      const result = await second.ensureAvailable()
      expect(result, lines.join('\n')).toMatchObject({ kind: 'launched' })
      expect(spawned).toHaveLength(3)
      const [, refused, serving] = spawned
      // The launch in the window was refused for the live holder, and waited on it.
      expect(refused.exitCode).toBe(1)
      expect(stderrOf.get(refused)).toContain(
        `The profile authority is held by pid ${stopping.pid} (owner is live)`
      )
      expect(lines.join('\n')).toContain(
        `the profile authority is held by Host pid ${stopping.pid}; waiting up to`
      )
      // The stopping Host finished its own stop, and was never signalled.
      expect(stopping.exitCode, stoppingStderr()).toBe(0)
      expect(stopping.signalCode).toBeNull()
      expect(result).toMatchObject({ pid: serving.pid })

      const check = new HostProjectionClient({
        userDataPath: profile,
        client: { clientId: 'a2-subprocess-check', clientClass: 'tui', clientVersion: 'test' },
        capabilities: ['bootstrap'],
        optionalCapabilities: ['health']
      })
      try {
        await check.connect()
        await expect(check.getHostStatus()).resolves.toMatchObject({ pid: serving.pid })
      } finally {
        check.close()
      }
    } finally {
      second.close()
    }
    // With its boot hold gone, the relaunched Host leaves one grace later.
    const serving = spawned[2]
    await waitForExit(serving)
    expect(serving.exitCode, stderrOf.get(serving)).toBe(0)
    expectArtefactsGone(profile)
  }, 90_000)
})
