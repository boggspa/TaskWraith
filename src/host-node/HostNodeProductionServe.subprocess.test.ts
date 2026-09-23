import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

import { HostLeaseClient } from '../host-client/HostLeaseClient'
import { HostProjectionClient } from '../host-client/HostProjectionClient'
import { HOST_PROTOCOL_VERSION, type HostCommand } from '../shared/hostProtocol'
import {
  decodeTaskWraithHostDiscovery,
  taskWraithHostDiscoveryPath,
  taskWraithHostSocketPath,
  taskWraithHostTokenPath
} from '../shared/taskWraithHostPaths.node'
import { HOST_PROFILE_AUTHORITY_LEASE_FILENAME } from '../host-runtime/HostProfileAuthorityLease'
import {
  HOST_LEASE_DISABLED_ENV,
  HOST_LEASE_TIMING_ENV,
  HOST_PERSIST_ENV
} from '../host-runtime/HostLeaseRegistry'

const paths: string[] = []

afterEach(() => {
  while (paths.length) rmSync(paths.pop()!, { recursive: true, force: true })
})

function waitFor(check: () => boolean, label: string, timeoutMs = 12_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() >= deadline) {
        clearInterval(timer)
        reject(new Error(`Timed out waiting for ${label}`))
      }
    }, 25)
    timer.unref?.()
  })
}

async function waitForAsync(
  check: () => Promise<boolean>,
  label: string,
  timeoutMs = 12_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    const timer = setTimeout(() => reject(new Error('production Host did not exit')), 10_000)
    timer.unref?.()
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function command(
  name: HostCommand['name'],
  id: string,
  target: Record<string, string>,
  arguments_: Record<string, unknown>
): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: id,
    idempotencyKey: `key-${id}`,
    actor: { actorId: 'subprocess-client', clientId: 'subprocess-client', clientClass: 'test' },
    name,
    target,
    arguments: arguments_,
    issuedAt: '2026-08-24T00:00:00.000Z'
  }
}

describe('production Host CLI subprocess', () => {
  it('owns a cold profile, serves the production capability floor, rejects a duplicate lease, and cleans up', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-production-subprocess-'))
    paths.push(root)
    const outDir = join(root, 'out')
    const profile = join(root, 'profile')
    const workspace = join(root, 'workspace')
    const muse = join(root, 'muse')
    const exerciseMuse = process.platform !== 'win32'
    mkdirSync(workspace)
    if (exerciseMuse) {
      writeFileSync(
        muse,
        '#!/bin/sh\nprintf \'%s\\n\' \'{"schema_version":1,"id":"22222222-2222-2222-2222-222222222222","stream":{"kind":"session","id":"subprocess-muse-session"},"sequence":1,"recorded_at":1780531400000000,"record_type":"event","payload_type":"run.terminal.completed","payload":{"kind":"run_terminal_completed","terminal":"completed","text":"subprocess muse completed"}}\'\n'
      )
      chmodSync(muse, 0o700)
    }
    const compile = spawnSync(
      process.execPath,
      [
        join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc'),
        '-p',
        join(process.cwd(), 'src', 'host-runtime', 'tsconfig.json'),
        '--outDir',
        outDir
      ],
      { cwd: process.cwd(), encoding: 'utf8' }
    )
    expect(compile.status).toBe(0)
    const workers = spawnSync(
      process.execPath,
      [
        join(process.cwd(), 'scripts', 'build-history-workers.cjs'),
        '--outdir',
        join(outDir, 'host-node')
      ],
      { cwd: process.cwd(), encoding: 'utf8' }
    )
    expect(workers.status, workers.stderr).toBe(0)
    const cli = join(outDir, 'host-runtime', 'cli.js')
    expect(existsSync(cli)).toBe(true)
    const args = [
      cli,
      'serve',
      '--mode',
      'production',
      '--profile',
      profile,
      ...(exerciseMuse ? ['--muse-binary', muse] : [])
    ]
    const child = spawn(process.execPath, args, {
      env: {
        ...process.env,
        ...(exerciseMuse ? { META_API_KEY: 'subprocess-test-key' } : {}),
        // Never the real machine-wide registry, once a publisher is wired.
        TASKWRAITH_HOST_REGISTRY_ROOT: join(root, 'registry'),
        PATH: ''
      },
      stdio: ['ignore', 'ignore', 'pipe']
    })
    // Keep the Host's stderr: when the graceful stop below cannot reach the
    // socket, the only explanation lives there. Drained continuously so the
    // pipe can never back-pressure the Host.
    let hostStderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (hostStderr.length < 64 * 1024) hostStderr += chunk
    })
    let bodyFailure: unknown = null
    let client: HostProjectionClient | null = null
    let reconnected: HostProjectionClient | null = null
    let desktopPeer: HostProjectionClient | null = null
    let tuiPeer: HostProjectionClient | null = null
    try {
      await waitFor(
        () =>
          existsSync(taskWraithHostDiscoveryPath(profile)) &&
          existsSync(taskWraithHostTokenPath(profile)),
        'production discovery'
      )
      const duplicate = spawnSync(process.execPath, args, {
        env: {
          ...process.env,
          ...(exerciseMuse ? { META_API_KEY: 'subprocess-test-key' } : {}),
          TASKWRAITH_HOST_REGISTRY_ROOT: join(root, 'registry'),
          PATH: ''
        },
        encoding: 'utf8',
        timeout: 5_000
      })
      expect(duplicate.error).toBeUndefined()
      expect(duplicate.signal).toBeNull()
      expect(duplicate.status).not.toBe(0)
      expect(`${duplicate.stdout || ''}${duplicate.stderr || ''}`).toMatch(
        /profile|authority|lease/i
      )

      client = new HostProjectionClient({
        userDataPath: profile,
        client: { clientId: 'subprocess-client', clientClass: 'test', clientVersion: '1.0' },
        capabilities: [
          'bootstrap',
          'commands',
          'receipts',
          'setup',
          'provider-catalog',
          'provider-auth',
          'history',
          'health'
        ]
      })
      const welcome = await client.connect()
      expect(welcome.hostVersion).toBe('node-host-v1')
      expect(welcome.capabilities).toEqual(
        expect.arrayContaining([
          'commands',
          'receipts',
          'setup',
          'provider-catalog',
          'provider-auth',
          'history',
          'health'
        ])
      )
      const ws = await client.submitCommand(
        command('workspace.register', 'cmd-ws', {}, { path: workspace })
      )
      const workspaceId = ws.resultRef?.kind === 'workspace' ? ws.resultRef.workspaceId : ''
      const thread = await client.submitCommand(
        command('thread.create', 'cmd-thread', {}, { scope: 'workspace', workspaceId })
      )
      const threadId = thread.resultRef?.kind === 'thread' ? thread.resultRef.threadId : ''
      desktopPeer = new HostProjectionClient({
        userDataPath: profile,
        client: { clientId: 'desktop-peer', clientClass: 'desktop', clientVersion: '1.0' },
        capabilities: ['bootstrap', 'snapshot', 'history', 'health']
      })
      tuiPeer = new HostProjectionClient({
        userDataPath: profile,
        client: { clientId: 'tui-peer', clientClass: 'tui', clientVersion: '1.0' },
        capabilities: ['bootstrap', 'snapshot', 'history', 'health']
      })
      await Promise.all([desktopPeer.connect(), tuiPeer.connect()])
      await expect(desktopPeer.getSnapshot()).resolves.toMatchObject({
        snapshot: { threads: expect.arrayContaining([expect.objectContaining({ id: threadId })]) }
      })
      desktopPeer.close()
      desktopPeer = null
      await expect(tuiPeer.getHealth()).resolves.toMatchObject({ type: 'host.health' })
      await expect(tuiPeer.getSnapshot()).resolves.toMatchObject({
        snapshot: { threads: expect.arrayContaining([expect.objectContaining({ id: threadId })]) }
      })
      expect(existsSync(taskWraithHostDiscoveryPath(profile))).toBe(true)
      if (exerciseMuse) {
        const offers = await client.getProviderOffers('muse')
        const configured = await client.submitCommand(
          command(
            'thread.configure',
            'cmd-config',
            { threadId },
            {
              providerId: 'muse',
              modelId: 'muse-spark-1.2',
              postureId: 'default',
              offerRevision: offers.offerRevision
            }
          )
        )
        expect(configured.status).toBe('succeeded')
        const sent = await client!.submitCommand(
          command('composer.send', 'cmd-send', { threadId }, { text: 'execute Muse' })
        )
        expect(sent.status).toBe('succeeded')
        await waitForAsync(async () => {
          const history = await client!.getThreadHistory({ threadId, limit: 20 })
          return history.entries.some((entry) => entry.text === 'subprocess muse completed')
        }, 'Muse assistant transcript')
        await waitForAsync(async () => {
          const snapshot = await client!.getSnapshot()
          return snapshot.snapshot.runs.some(
            (run) => run.runId === 'cmd-send' && run.providerOutcome === 'completed'
          )
        }, 'Muse terminal projection')
        expect(await client.getThreadHistory({ threadId, limit: 10 })).toMatchObject({ threadId })
        await expect(client.lookupReceipt({ commandId: 'cmd-config' })).resolves.toMatchObject({
          commandId: 'cmd-config'
        })
        client.close()
        reconnected = new HostProjectionClient({
          userDataPath: profile,
          client: { clientId: 'subprocess-client', clientClass: 'test', clientVersion: '1.0' },
          capabilities: [
            'bootstrap',
            'commands',
            'receipts',
            'setup',
            'provider-catalog',
            'provider-auth',
            'history',
            'health'
          ]
        })
        await reconnected.connect()
        await expect(reconnected.lookupReceipt({ commandId: 'cmd-send' })).resolves.toMatchObject({
          commandId: 'cmd-send'
        })
        await expect(reconnected.getThreadHistory({ threadId, limit: 20 })).resolves.toMatchObject({
          entries: expect.arrayContaining([
            expect.objectContaining({ text: 'subprocess muse completed' })
          ])
        })
        reconnected.close()
      } else {
        await expect(client.lookupReceipt({ commandId: 'cmd-thread' })).resolves.toMatchObject({
          commandId: 'cmd-thread'
        })
      }
    } catch (error) {
      bodyFailure = error
      throw error
    } finally {
      client?.close()
      reconnected?.close()
      desktopPeer?.close()
      tuiPeer?.close()
      const graceful = spawnSync(
        process.execPath,
        [cli, 'stop', '--profile', realpathSync(profile)],
        {
          env: { ...process.env, PATH: '' },
          encoding: 'utf8',
          timeout: 10_000
        }
      )
      if (graceful.status === 0) {
        await waitForExit(child)
        expect(child.exitCode).toBe(0)
      } else if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await waitForExit(child)
      }
      const stopEvidence = `${graceful.stdout || ''}${graceful.stderr || ''}\nhost exit=${String(
        child.exitCode
      )} signal=${String(child.signalCode)}\nhost stderr:\n${hostStderr}`
      if (bodyFailure !== null) {
        // The body already failed; report the stop outcome without replacing that error.
        console.error(
          `[production Host subprocess] graceful stop status=${String(graceful.status)}\n${stopEvidence}`
        )
      } else {
        expect(graceful.status, stopEvidence).toBe(0)
      }
    }
    expect(existsSync(taskWraithHostDiscoveryPath(profile))).toBe(false)
    expect(existsSync(taskWraithHostTokenPath(profile))).toBe(false)
    expect(existsSync(taskWraithHostSocketPath(profile))).toBe(false)
    expect(existsSync(join(profile, HOST_PROFILE_AUTHORITY_LEASE_FILENAME))).toBe(false)
    expect(existsSync(join(profile, 'host-runtime', 'host-install-identity.json'))).toBe(true)
  }, 30_000)
})

/**
 * The Host-lifetime lease on the real binary: shortened timing through the
 * diagnostic override, a real lease client renewing on its own timer, and the
 * two escape valves (persist, and the test-only legacy simulation). Every
 * Host spawned here is killed and reaped in teardown, verified by pid.
 */
describe('production Host CLI subprocess: lease lifetime', () => {
  const GRACE_MS = 1_500
  const TIMING = `heartbeat:200,ttl:1000,grace:${GRACE_MS}`
  const spawned: ChildProcess[] = []

  afterEach(async () => {
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
  })

  function buildCli(root: string): string {
    const outDir = join(root, 'out')
    const compile = spawnSync(
      process.execPath,
      [
        join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc'),
        '-p',
        join(process.cwd(), 'src', 'host-runtime', 'tsconfig.json'),
        '--outDir',
        outDir
      ],
      { cwd: process.cwd(), encoding: 'utf8' }
    )
    expect(compile.status, compile.stdout).toBe(0)
    const workers = spawnSync(
      process.execPath,
      [
        join(process.cwd(), 'scripts', 'build-history-workers.cjs'),
        '--outdir',
        join(outDir, 'host-node')
      ],
      { cwd: process.cwd(), encoding: 'utf8' }
    )
    expect(workers.status, workers.stderr).toBe(0)
    return join(outDir, 'host-runtime', 'cli.js')
  }

  function spawnHost(
    cli: string,
    profile: string,
    extraEnv: Record<string, string>
  ): { child: ChildProcess; stderr: () => string } {
    mkdirSync(profile, { recursive: true })
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: '',
      // Never the real machine-wide registry, once a publisher is wired.
      TASKWRAITH_HOST_REGISTRY_ROOT: join(profile, '..', 'registry'),
      ...extraEnv
    }
    for (const key of [HOST_PERSIST_ENV, HOST_LEASE_DISABLED_ENV, HOST_LEASE_TIMING_ENV]) {
      if (!(key in extraEnv)) delete env[key]
    }
    const child = spawn(
      process.execPath,
      [cli, 'serve', '--mode', 'production', '--profile', profile],
      { env, stdio: ['ignore', 'ignore', 'pipe'] }
    )
    spawned.push(child)
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 64 * 1024) stderr += chunk
    })
    return { child, stderr: () => stderr }
  }

  async function connect(profile: string, clientId: string): Promise<HostProjectionClient> {
    await waitFor(() => existsSync(taskWraithHostDiscoveryPath(profile)), 'production discovery')
    const client = new HostProjectionClient({
      userDataPath: profile,
      client: { clientId, clientClass: 'tui', clientVersion: '1.0' },
      capabilities: ['bootstrap', 'health']
    })
    await client.connect()
    return client
  }

  function stopViaCli(cli: string, profile: string): void {
    const graceful = spawnSync(
      process.execPath,
      [cli, 'stop', '--profile', realpathSync(profile)],
      {
        env: { ...process.env, PATH: '' },
        encoding: 'utf8',
        timeout: 10_000
      }
    )
    expect(graceful.status, `${graceful.stdout}${graceful.stderr}`).toBe(0)
  }

  function expectArtefactsGone(profile: string): void {
    expect(existsSync(taskWraithHostDiscoveryPath(profile))).toBe(false)
    expect(existsSync(taskWraithHostTokenPath(profile))).toBe(false)
    expect(existsSync(taskWraithHostSocketPath(profile))).toBe(false)
    expect(existsSync(join(profile, HOST_PROFILE_AUTHORITY_LEASE_FILENAME))).toBe(false)
  }

  it('holds while a lease renews, exits cleanly one grace after the last holder, and honours persist and the legacy switch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-lease-subprocess-'))
    paths.push(root)
    const cli = buildCli(root)

    // 1. A renewing lease holds the Host past two graces; its release lets it go.
    const leased = join(root, 'leased')
    const host = spawnHost(cli, leased, { [HOST_LEASE_TIMING_ENV]: TIMING })
    const client = await connect(leased, 'tui-lease-subprocess')
    const lease = new HostLeaseClient({ client })
    const lapses: string[] = []
    lease.on('lapsed', (leaseId) => lapses.push(leaseId))
    try {
      await expect(lease.acquire()).resolves.toBe('held')
      const leaseId = lease.leaseId
      expect(leaseId).toEqual(expect.any(String))
      const discovery = decodeTaskWraithHostDiscovery(
        JSON.parse(readFileSync(taskWraithHostDiscoveryPath(leased), 'utf8'))
      )
      if (!discovery.ok) throw new Error(discovery.error)
      await new Promise((resolve) => setTimeout(resolve, 2 * GRACE_MS))
      // Renewed, never lapsed and re-taken: one lease the whole time.
      expect(lapses).toEqual([])
      expect(lease.leaseId).toBe(leaseId)
      const status = await client.getHostStatus()
      expect(status).toMatchObject({
        pid: host.child.pid,
        startedAt: discovery.discovery.startedAt,
        persist: false,
        lifetime: { phase: 'held', holders: 1, implicitHolders: 0 }
      })
      expect(status.clients).toEqual([
        expect.objectContaining({
          clientClass: 'tui',
          clientId: 'tui-lease-subprocess',
          lease: 'explicit'
        })
      ])
      expect(host.child.exitCode, host.stderr()).toBeNull()
    } finally {
      lease.releaseSync()
      lease.dispose()
    }
    const releasedAt = Date.now()
    await waitForExit(host.child)
    const elapsed = Date.now() - releasedAt
    expect(host.child.exitCode, host.stderr()).toBe(0)
    expect(elapsed).toBeGreaterThanOrEqual(GRACE_MS - 300)
    expect(host.stderr()).toContain(`${HOST_LEASE_TIMING_ENV} shortened timing`)
    expect(host.stderr()).toContain('stopping after the last client lease (idle)')
    expectArtefactsGone(leased)

    // 2. Persist: nobody attaches, two graces pass, the Host is still serving.
    const persisted = join(root, 'persisted')
    const persistent = spawnHost(cli, persisted, {
      [HOST_LEASE_TIMING_ENV]: TIMING,
      [HOST_PERSIST_ENV]: '1'
    })
    await waitFor(() => existsSync(taskWraithHostDiscoveryPath(persisted)), 'persist discovery')
    await new Promise((resolve) => setTimeout(resolve, 2 * GRACE_MS))
    expect(persistent.child.exitCode, persistent.stderr()).toBeNull()
    const observer = await connect(persisted, 'tui-persist-subprocess')
    await expect(observer.getHostStatus()).resolves.toMatchObject({
      persist: true,
      lifetime: { phase: 'held' }
    })
    observer.close()
    stopViaCli(cli, persisted)
    await waitForExit(persistent.child)
    expect(persistent.child.exitCode).toBe(0)
    expectArtefactsGone(persisted)

    // 3. Legacy switch: answers the lease kinds as a pre-lease Host and has no lease lifetime.
    const legacyProfile = join(root, 'legacy')
    const legacy = spawnHost(cli, legacyProfile, {
      [HOST_LEASE_TIMING_ENV]: TIMING,
      [HOST_LEASE_DISABLED_ENV]: '1'
    })
    const legacyClient = await connect(legacyProfile, 'tui-legacy-subprocess')
    const legacyLease = new HostLeaseClient({ client: legacyClient })
    await expect(legacyLease.acquire()).resolves.toBe('legacy')
    await expect(legacyClient.getHostStatus()).rejects.toMatchObject({
      code: 'unknown_request_kind'
    })
    await expect(legacyClient.getHealth()).resolves.toMatchObject({ type: 'host.health' })
    legacyLease.dispose()
    legacyClient.close()
    await new Promise((resolve) => setTimeout(resolve, 2 * GRACE_MS))
    expect(legacy.child.exitCode, legacy.stderr()).toBeNull()
    stopViaCli(cli, legacyProfile)
    await waitForExit(legacy.child)
    expect(legacy.child.exitCode).toBe(0)
    expectArtefactsGone(legacyProfile)
  }, 90_000)
})
