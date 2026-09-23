import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn as nodeSpawn, spawnSync, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

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
import { hasExternalHostBootHold, releaseExternalHostBootHold } from './HostExternalBootHold'
import { resolveHostExternalLaunch } from './HostExternalLaunchResolver'
import { createHostProjectionBroker } from './HostProjectionBroker'
import { HostExternalSupervisor } from './HostExternalSupervisor'

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

/**
 * S1a review F2 on the real binary, through the real Desktop pieces: the
 * production launch resolver, the supervisor that spawns and probes the Host,
 * and main's projection broker. Main's boot is synchronous from the moment its
 * first broker asks for the Host until it first yields, so the Host must stay
 * held from the supervisor's readiness probe until that broker authenticates,
 * however long the boot outlasts the Host's last-lease grace.
 */
describe('external Host supervisor subprocess: boot hold', () => {
  const GRACE_MS = 1_500
  const TIMING = `heartbeat:200,ttl:1000,grace:${GRACE_MS}`
  const spawned: ChildProcess[] = []
  const roots: string[] = []

  afterEach(async () => {
    releaseExternalHostBootHold()
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
    while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
  })

  it("keeps a Host it launched through a main boot that outlasts the grace, until main's own client takes over", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'host-boot-hold-subprocess-')))
    roots.push(root)
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

    const profile = join(root, 'profile')
    mkdirSync(profile)
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
    const supervisor = new HostExternalSupervisor({
      profilePath: profile,
      // The launcher strips the test-only timing; put it back for this Host only.
      resolveLaunch: async () => ({
        ...production,
        env: { ...production.env, [HOST_LEASE_TIMING_ENV]: TIMING }
      }),
      spawn: (executable, args, options) => {
        const child = nodeSpawn(executable, [...args], options)
        spawned.push(child)
        return child
      }
    })
    const broker = createHostProjectionBroker({
      userDataPath: profile,
      appVersion: 'boot-hold-subprocess'
    })
    try {
      await expect(supervisor.ensureAvailable()).resolves.toMatchObject({ kind: 'launched' })
      expect(spawned).toHaveLength(1)
      const host = spawned[0]
      let hostStderr = ''
      host.stderr?.on('data', (chunk: string) => {
        if (hostStderr.length < 64 * 1024) hostStderr += chunk
      })
      expect(hasExternalHostBootHold()).toBe(true)

      // Main asks for the Host, then boots synchronously for twice the grace.
      const first = broker.snapshot()
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2 * GRACE_MS)
      let snapshot = await first
      // The first connect's deadline can expire inside the block; main retries.
      for (let attempt = 0; !snapshot.ok && attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        snapshot = await broker.snapshot()
      }
      expect(host.exitCode, hostStderr).toBeNull()
      expect(snapshot.ok, snapshot.ok ? hostStderr : `${snapshot.error}\n${hostStderr}`).toBe(true)
      // Main's own client holds the Host now; the spawner's probe has let go.
      expect(hasExternalHostBootHold()).toBe(false)
      // Never without a holder from readiness on: no grace ever armed.
      expect(hostStderr).not.toContain('grace armed')
      expect(hostStderr).not.toContain('exit requested')

      // And the lifetime still works: main goes, the Host goes one grace later.
      broker.close()
      const leftAt = Date.now()
      await waitForExit(host)
      expect(host.exitCode, hostStderr).toBe(0)
      expect(Date.now() - leftAt).toBeGreaterThanOrEqual(GRACE_MS - 300)
      expect(hostStderr).toContain('stopping after the last client lease (idle)')
      expect(existsSync(taskWraithHostDiscoveryPath(profile))).toBe(false)
      expect(existsSync(taskWraithHostTokenPath(profile))).toBe(false)
      expect(existsSync(taskWraithHostSocketPath(profile))).toBe(false)
      expect(existsSync(join(profile, HOST_PROFILE_AUTHORITY_LEASE_FILENAME))).toBe(false)
    } finally {
      broker.close()
      supervisor.close()
    }
  }, 90_000)
})
