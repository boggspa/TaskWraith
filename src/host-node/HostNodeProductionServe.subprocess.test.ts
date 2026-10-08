import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
import { readHostRegistryEntry } from '../host-runtime/HostRegistry'
import { HOST_END_PROCESS_FLUSH_MS } from '../host-runtime/cli'
import { observeProcessBirthIdentity } from '../host-runtime/ProcessBirthIdentity'

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

function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    const timer = setTimeout(() => reject(new Error('production Host did not exit')), timeoutMs)
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
  const hostProfiles: string[] = []

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
      // The native child handle has reported its exit. On Windows a numeric
      // PID can remain queryable while another process still holds a handle.
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
      if (process.platform !== 'win32') expect(() => process.kill(child.pid!, 0)).toThrow()
    }
    // A Host that died without cleaning up (a regression these tests catch)
    // leaves its socket directory in the OS temp dir; every Host here is gone.
    for (const profile of hostProfiles.splice(0)) {
      if (!existsSync(profile)) continue
      // Windows named pipes have no filesystem socket directory to remove.
      if (process.platform === 'win32') continue
      rmSync(dirname(taskWraithHostSocketPath(realpathSync(profile))), {
        recursive: true,
        force: true
      })
    }
  })

  function buildCli(root: string, outDir = join(root, 'out'), historyWorkers = true): string {
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
    if (!historyWorkers) return join(outDir, 'host-runtime', 'cli.js')
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
    extraEnv: Record<string, string>,
    extraArgs: readonly string[] = [],
    nodeArgs: readonly string[] = []
  ): { child: ChildProcess; stderr: () => string } {
    mkdirSync(profile, { recursive: true })
    hostProfiles.push(profile)
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
      [...nodeArgs, cli, 'serve', '--mode', 'production', '--profile', profile, ...extraArgs],
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
    // The socket path hashes the canonical profile path, as the Host names it
    // (the OS temp dir is behind a symlink on macOS).
    expect(existsSync(taskWraithHostSocketPath(realpathSync(profile)))).toBe(false)
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
    // `cli.js serve` publishes this Host's entry into the registry root its
    // environment names, recording this CLI and this Node.
    const registryRoot = join(root, 'registry')
    await waitFor(
      () => readHostRegistryEntry(registryRoot, persisted).kind === 'present',
      'registry entry'
    )
    const birth = await observeProcessBirthIdentity(persistent.child.pid!)
    expect(birth.state).toBe('live')
    expect(readHostRegistryEntry(registryRoot, persisted)).toMatchObject({
      kind: 'present',
      entry: {
        profilePath: realpathSync(persisted),
        pid: persistent.child.pid,
        birthIdentity: birth.state === 'live' ? birth.birthIdentity : null,
        cliPath: realpathSync(cli),
        nodeExecutable: process.execPath,
        payloadVersion: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        persist: true,
        leaseMode: 'lease'
      }
    })
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
    // A clean stop removes the entry before the authority lease goes.
    expect(readHostRegistryEntry(registryRoot, persisted).kind).toBe('missing')

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

  /**
   * S1a review F1. The Desktop supervisor spawns the Host detached with a
   * stderr pipe it reads only while the app lives. Once the app has exited,
   * every lease log line (grace armed, grace cancelled, exit requested) is a
   * write into a pipe with no reader. An unguarded stderr turned the first one
   * into an uncaught EPIPE: exit 1, no cleanup, runs orphaned.
   */
  async function outlivesAGoneStderrReader(
    root: string,
    profile: string,
    entry: readonly string[]
  ): Promise<void> {
    mkdirSync(profile, { recursive: true })
    hostProfiles.push(profile)
    // A longer grace than the rest of this block: the relaunch below must land inside it.
    const graceMs = 3_000
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: '',
      TASKWRAITH_HOST_REGISTRY_ROOT: join(root, 'registry'),
      [HOST_LEASE_TIMING_ENV]: `heartbeat:200,ttl:1000,grace:${graceMs}`
    }
    delete env[HOST_PERSIST_ENV]
    delete env[HOST_LEASE_DISABLED_ENV]
    // HostExternalSupervisor's spawn shape.
    const child = spawn(process.execPath, [...entry], {
      env,
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })
    spawned.push(child)
    const app = await connect(profile, 'tui-epipe-app')

    // The app process exits: the read end of the Host's stderr pipe goes away...
    const stderr = child.stderr!
    const readerGone = new Promise((resolve) => stderr.once('close', resolve))
    stderr.destroy()
    await readerGone
    // ...and its socket with it. The Host logs "no holder: grace armed".
    app.close()
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(child.exitCode, 'the Host must outlive its stderr reader').toBeNull()
    expect(child.signalCode).toBeNull()

    // The app is reopened within the grace: "grace cancelled", and it finds its Host.
    const relaunched = await connect(profile, 'tui-epipe-relaunched')
    await expect(relaunched.getHostStatus()).resolves.toMatchObject({
      pid: child.pid,
      lifetime: { phase: 'held', holders: 1 }
    })

    // Quit for good: grace armed, then "exit requested" and the stop line at expiry.
    relaunched.close()
    const leftAt = Date.now()
    await waitForExit(child)
    expect(child.exitCode).toBe(0)
    expect(Date.now() - leftAt).toBeGreaterThanOrEqual(graceMs - 300)
    expectArtefactsGone(profile)
  }

  it('outlives a stderr reader that has gone: every lease line after it is dropped, and it still stops cleanly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-epipe-subprocess-'))
    paths.push(root)
    const cli = buildCli(root)
    const profile = join(root, 'orphaned')
    await outlivesAGoneStderrReader(root, profile, [
      cli,
      'serve',
      '--mode',
      'production',
      '--profile',
      profile
    ])
  }, 90_000)

  // S1a re-review R2: the published package's `taskwraith-host` command calls
  // runHostProductionCli directly, not through cli.js's main().
  it('outlives a gone stderr reader through the npm taskwraith-host bin as well', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-epipe-bin-subprocess-'))
    paths.push(root)
    // The package layout scripts/prepare-cli-package.cjs produces: bin/ beside dist/host/.
    const packageRoot = join(root, 'package')
    buildCli(root, join(packageRoot, 'dist', 'host'))
    const bin = join(packageRoot, 'bin', 'taskwraith-host.cjs')
    mkdirSync(join(packageRoot, 'bin'))
    copyFileSync(join(process.cwd(), 'packages', 'cli', 'bin', 'taskwraith-host.cjs'), bin)
    const profile = join(root, 'orphaned')
    await outlivesAGoneStderrReader(root, profile, [bin, '--profile', profile])
  }, 90_000)

  // S1a confirmation C4: the bin's `stop` calls runHostShutdownCli directly as
  // well. Its only writes are its failures, and unguarded the first one into a
  // gone reader was an uncaught EPIPE: exit 1 in place of the bin's own code.
  it("keeps the npm bin's own exit code for a failed stop whose stderr reader has gone", async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-epipe-bin-stop-subprocess-'))
    paths.push(root)
    const packageRoot = join(root, 'package')
    buildCli(root, join(packageRoot, 'dist', 'host'), false)
    const bin = join(packageRoot, 'bin', 'taskwraith-host.cjs')
    mkdirSync(join(packageRoot, 'bin'))
    copyFileSync(join(process.cwd(), 'packages', 'cli', 'bin', 'taskwraith-host.cjs'), bin)
    const stop = async (readerGone: boolean): Promise<{ code: number | null; stderr: string }> => {
      const child = spawn(process.execPath, [bin, 'stop', '--not-an-option'], {
        env: { ...process.env, PATH: '' },
        stdio: ['ignore', 'ignore', 'pipe']
      })
      spawned.push(child)
      let stderr = ''
      if (readerGone) {
        // Gone before the bin has even booted, let alone written.
        child.stderr!.destroy()
      } else {
        child.stderr!.setEncoding('utf8')
        child.stderr!.on('data', (chunk: string) => {
          stderr += chunk
        })
      }
      await waitForExit(child)
      return { code: child.exitCode, stderr }
    }
    // A usage error: the bin reports it and exits 2...
    const kept = await stop(false)
    expect(kept.stderr).toContain('Unknown argument "--not-an-option"')
    expect(kept.code).toBe(2)
    // ...and exits 2 all the same when the report goes nowhere.
    await expect(stop(true)).resolves.toMatchObject({ code: 2 })
  }, 90_000)

  /**
   * S1a re-review R3 on the real binary, by the reviewer's reproduction: a
   * Host whose history worker cannot start (built without the stage-3 worker
   * bundles) reaches its idle exit. The catalogue dispose in its cleanup then
   * waits only on unref'd timers, and with the listener closed nothing else
   * held the event loop: the process ran dry halfway and exited 0 with the
   * profile authority and its registry entry left behind.
   */
  it("finishes a lifetime stop that waits only on unref'd timers, instead of exiting halfway", async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-partial-stop-subprocess-'))
    paths.push(root)
    const cli = buildCli(root, join(root, 'out'), false)
    const profile = join(root, 'partial')
    const graceMs = 2_000
    const host = spawnHost(cli, profile, {
      [HOST_LEASE_TIMING_ENV]: `heartbeat:200,ttl:1000,grace:${graceMs}`
    })
    const holder = await connect(profile, 'tui-partial-holder')
    // The worker fails at once and restarts on a doubling backoff (250 ms to
    // 8 s). Its sixth restart is due about 16.7 s in: holding for 9.5 s puts
    // the stop, one grace after the close, in that eight-second gap, where no
    // restarting worker is alive to keep the process up by accident.
    await new Promise((resolve) => setTimeout(resolve, 9_500))
    holder.close()
    await waitForExit(host.child, 45_000)
    expect(host.child.exitCode, host.stderr()).toBe(0)
    expect(host.stderr()).toContain('stopping after the last client lease (idle)')
    expect(host.stderr()).not.toContain('did not finish')
    expectArtefactsGone(profile)
    expect(readHostRegistryEntry(join(root, 'registry'), profile).kind).toBe('missing')
  }, 90_000)

  /**
   * A test-only hook on the built Host: a preload that replaces the history
   * writers' drain, the step a busy-cap stop cancelling many runs can run
   * past its bound. `fail` first writes a megabyte to stderr, the backlog a
   * reader that has fallen behind leaves queued, then rejects, and given a
   * path records there when it did; `hang` never settles and keeps an interval
   * running, a live handle of the kind a wedged step leaves.
   */
  function writersDrainHook(
    root: string,
    cli: string,
    mode: 'fail' | 'hang',
    failedAtPath?: string
  ): string {
    const publisher = join(
      dirname(dirname(cli)),
      'host-shared',
      'thread-catalogue',
      'ThreadCatalogueSourcePublisher.js'
    )
    const hook = join(root, `writers-drain-${mode}.cjs`)
    writeFileSync(
      hook,
      [
        "'use strict'",
        `const { ThreadCatalogueSourcePublisher } = require(${JSON.stringify(publisher)})`,
        mode === 'fail'
          ? "ThreadCatalogueSourcePublisher.prototype.dispose = async () => { process.stderr.write('x'.repeat(1024 * 1024) + '\\n'); " +
            (failedAtPath
              ? `require('node:fs').writeFileSync(${JSON.stringify(failedAtPath)}, String(Date.now())); `
              : '') +
            "throw new Error('History source writers have not drained') }"
          : 'ThreadCatalogueSourcePublisher.prototype.dispose = () => new Promise(() => { setInterval(() => {}, 1_000) })',
        ''
      ].join('\n')
    )
    return hook
  }

  /** A second Host takes the profile over and serves it, then leaves cleanly. */
  async function takesTheProfileOver(cli: string, profile: string, root: string): Promise<void> {
    const next = spawnHost(cli, profile, {
      [HOST_LEASE_TIMING_ENV]: 'heartbeat:200,ttl:1000,grace:1500'
    })
    const client = await connect(profile, 'tui-takeover')
    await expect(client.getHostStatus()).resolves.toMatchObject({ pid: next.child.pid })
    client.close()
    await waitForExit(next.child)
    expect(next.child.exitCode, next.stderr()).toBe(0)
    expectArtefactsGone(profile)
    expect(readHostRegistryEntry(join(root, 'registry'), profile).kind).toBe('missing')
  }

  /**
   * S1a confirmation A1 on the real binary. A stop the Host decided on that
   * fails used to keep the process up for a retry nobody sends: listener
   * closed, profile authority held, every relaunch finding no Host. It must
   * end the process within its deadline, crash-equivalent, so the next Host
   * can take the profile.
   */
  it('ends the process when a lifetime stop fails, and a second Host takes the profile', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-failed-stop-subprocess-'))
    paths.push(root)
    const cli = buildCli(root)
    const profile = join(root, 'failed')
    const host = spawnHost(
      cli,
      profile,
      { [HOST_LEASE_TIMING_ENV]: 'heartbeat:200,ttl:1000,grace:1500,stop:5000' },
      [],
      ['--require', writersDrainHook(root, cli, 'fail')]
    )
    // What arrives after the hook's megabyte.
    let tail = ''
    host.child.stderr?.on('data', (chunk: string) => {
      tail = (tail + chunk).slice(-4_096)
    })
    await waitFor(
      () => host.stderr().includes('stopping after the last client lease (idle)'),
      'the lifetime stop'
    )
    const stopAt = Date.now()
    await waitForExit(host.child, 15_000)
    expect(host.child.exitCode, tail).toBe(1)
    expect(Date.now() - stopAt).toBeLessThan(5_000)
    // It ends only once its last lines are through, the reason and the CLI's
    // own, although they were queued a megabyte behind.
    expect(tail).toContain(
      'stopping after the last client lease failed, profile authority retained: ' +
        'History source writers have not drained'
    )
    expect(tail).toContain('taskwraith-host: History source writers have not drained')
    // Crash-equivalent: the authority and the entry name a process that is gone.
    expect(existsSync(join(profile, HOST_PROFILE_AUTHORITY_LEASE_FILENAME))).toBe(true)
    expect(readHostRegistryEntry(join(root, 'registry'), profile).kind).toBe('present')
    await takesTheProfileOver(cli, profile, root)
  }, 90_000)

  // The same for a stop requested over the socket. `cli.js stop` and the
  // Desktop's HostShutdownClient reach the Host through the listener the stop
  // closes first, so nothing can request it again.
  it('ends the process when a requested stop fails, and a second Host takes the profile', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-failed-request-subprocess-'))
    paths.push(root)
    const cli = buildCli(root)
    const profile = join(root, 'requested')
    const host = spawnHost(
      cli,
      profile,
      // A grace longer than the test: only the request stops this Host.
      { [HOST_LEASE_TIMING_ENV]: 'heartbeat:200,ttl:1000,grace:40000,stop:5000' },
      [],
      ['--require', writersDrainHook(root, cli, 'fail')]
    )
    let tail = ''
    host.child.stderr?.on('data', (chunk: string) => {
      tail = (tail + chunk).slice(-4_096)
    })
    await waitFor(() => existsSync(taskWraithHostDiscoveryPath(profile)), 'production discovery')
    const requestedAt = Date.now()
    const stop = spawn(process.execPath, [cli, 'stop', '--profile', realpathSync(profile)], {
      env: { ...process.env, PATH: '' },
      stdio: ['ignore', 'ignore', 'pipe']
    })
    spawned.push(stop)
    let stopStderr = ''
    stop.stderr?.setEncoding('utf8')
    stop.stderr?.on('data', (chunk: string) => {
      stopStderr += chunk
    })
    await waitForExit(host.child, 15_000)
    expect(host.child.exitCode, tail).toBe(1)
    expect(Date.now() - requestedAt).toBeLessThan(5_000)
    expect(tail).toContain(
      'stopping on request failed, profile authority retained: ' +
        'History source writers have not drained'
    )
    // The request was acknowledged, but the authority it waits to see go
    // names a process that is gone: `cli.js stop` says the stop did not finish.
    await waitForExit(stop, 15_000)
    expect(stop.exitCode, stopStderr).toBe(1)
    expect(stopStderr).toContain('ownership artifacts remain')
    expect(existsSync(join(profile, HOST_PROFILE_AUTHORITY_LEASE_FILENAME))).toBe(true)
    await takesTheProfileOver(cli, profile, root)
  }, 90_000)

  /**
   * S1a review N2b. endHostProcess exits once stderr has drained, and only its
   * fallback, HOST_END_PROCESS_FLUSH_MS, ends a Host whose reader is alive but
   * has stopped reading: a Desktop main that hangs, or any parent that stopped
   * draining. The tests above all read the Host's stderr, so none of them
   * reaches it. Here the parent never reads, and the failing drain's megabyte
   * fills the pipe ahead of the failure's lines. Windows writes a stdio pipe
   * synchronously, so there the megabyte blocks the Host inside the write
   * itself, where no timer runs: the fallback is not what ends it there.
   */
  it.skipIf(process.platform === 'win32')(
    'ends the process within HOST_END_PROCESS_FLUSH_MS of a failed stop when its stderr reader never reads',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'host-unread-stderr-subprocess-'))
      paths.push(root)
      const cli = buildCli(root)
      const profile = join(root, 'unread')
      mkdirSync(profile, { recursive: true })
      hostProfiles.push(profile)
      const failedAtPath = join(root, 'failed-at')
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: '',
        TASKWRAITH_HOST_REGISTRY_ROOT: join(root, 'registry'),
        [HOST_LEASE_TIMING_ENV]: 'heartbeat:200,ttl:1000,grace:1500,stop:5000'
      }
      delete env[HOST_PERSIST_ENV]
      delete env[HOST_LEASE_DISABLED_ENV]
      const child = spawn(
        process.execPath,
        [
          '--require',
          writersDrainHook(root, cli, 'fail', failedAtPath),
          cli,
          'serve',
          '--mode',
          'production',
          '--profile',
          profile
        ],
        // Piped, and never read: no listener is ever attached to its stderr.
        { env, stdio: ['ignore', 'ignore', 'pipe'] }
      )
      spawned.push(child)
      await waitForExit(child, 20_000)
      const exitedAt = Date.now()
      expect(child.exitCode).toBe(1)
      const sinceFailure = exitedAt - Number(readFileSync(failedAtPath, 'utf8'))
      // Not at once: the flush never completes, so it is the fallback that
      // ends the process. And not later than the fallback plus scheduling.
      expect(sinceFailure).toBeGreaterThanOrEqual(HOST_END_PROCESS_FLUSH_MS / 2)
      expect(sinceFailure).toBeLessThan(HOST_END_PROCESS_FLUSH_MS + 4_000)
    },
    90_000
  )

  it('ends the process at its deadline while a stop step still holds it open, and a second Host takes the profile', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-hung-stop-subprocess-'))
    paths.push(root)
    const cli = buildCli(root)
    const profile = join(root, 'hung')
    const host = spawnHost(
      cli,
      profile,
      { [HOST_LEASE_TIMING_ENV]: 'heartbeat:200,ttl:1000,grace:1500,stop:1000' },
      [],
      ['--require', writersDrainHook(root, cli, 'hang')]
    )
    await waitFor(
      () => host.stderr().includes('stopping after the last client lease (idle)'),
      'the lifetime stop'
    )
    const stopAt = Date.now()
    await waitForExit(host.child, 15_000)
    const elapsed = Date.now() - stopAt
    expect(host.child.exitCode, host.stderr()).toBe(1)
    expect(elapsed).toBeGreaterThanOrEqual(900)
    expect(elapsed).toBeLessThan(3_000)
    expect(host.stderr()).toContain(
      'stopping after the last client lease did not finish within 1000 ms, profile authority retained'
    )
    await takesTheProfileOver(cli, profile, root)
  }, 90_000)

  /**
   * The same deadline with nothing but unref'd timers left, by the reviewer's
   * reproduction: the Host with no history worker bundles, its stop landed in
   * the worker's eight-second restart gap (the R3 test above explains it). The
   * deadline's timer holds the process to the 1 s deadline `stop:` sets, and
   * no further: it ends there, exit 1, with the profile authority and registry
   * entry kept, not after waiting out the gap.
   */
  it('exits 1 at the deadline from a lifetime stop that leaves nothing to run, keeping the profile authority', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-stuck-stop-subprocess-'))
    paths.push(root)
    const cli = buildCli(root, join(root, 'out'), false)
    const profile = join(root, 'stuck')
    const host = spawnHost(cli, profile, {
      [HOST_LEASE_TIMING_ENV]: 'heartbeat:200,ttl:1000,grace:2000,stop:1000'
    })
    const holder = await connect(profile, 'tui-stuck-holder')
    await new Promise((resolve) => setTimeout(resolve, 9_500))
    holder.close()
    await waitFor(
      () => host.stderr().includes('stopping after the last client lease (idle)'),
      'the lifetime stop',
      10_000
    )
    const stopAt = Date.now()
    await waitForExit(host.child, 15_000)
    const elapsed = Date.now() - stopAt
    expect(host.child.exitCode, host.stderr()).toBe(1)
    // Held to the deadline, and no further: the worker's next restart, which
    // would have let the stop finish, is seconds away.
    expect(elapsed).toBeGreaterThanOrEqual(900)
    expect(elapsed).toBeLessThan(3_000)
    expect(host.stderr()).toContain(
      'stopping after the last client lease did not finish within 1000 ms, profile authority retained'
    )
    expect(existsSync(join(profile, HOST_PROFILE_AUTHORITY_LEASE_FILENAME))).toBe(true)
    expect(readHostRegistryEntry(join(root, 'registry'), profile).kind).toBe('present')
  }, 90_000)

  /**
   * S1a re-review R1 on the real binary. The app quits with a run in flight,
   * so the grace expires with the run live and the Host drains. The app is
   * reopened during the drain, the run finishes under it, and its socket drops
   * once. The reconnect 1.8 s later (the TUI's first retry) must find the
   * Host, which still leaves one grace after the client does.
   */
  it.skipIf(process.platform === 'win32')(
    'keeps a draining Host for a client that came back, saw the run finish and dropped once',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'host-drain-return-subprocess-'))
      paths.push(root)
      const cli = buildCli(root)
      const profile = join(root, 'draining')
      const workspace = join(root, 'workspace')
      mkdirSync(workspace)
      const graceMs = 4_000
      // @portability-ok: a POSIX fake Muse (skipped on win32) whose run outlives the grace.
      const muse = join(root, 'muse')
      writeFileSync(
        muse,
        '#!/bin/sh\n/bin/sleep 6\nprintf \'%s\\n\' \'{"schema_version":1,"id":"33333333-3333-3333-3333-333333333333","stream":{"kind":"session","id":"subprocess-slow-muse-session"},"sequence":1,"recorded_at":1780531400000000,"record_type":"event","payload_type":"run.terminal.completed","payload":{"kind":"run_terminal_completed","terminal":"completed","text":"subprocess slow muse completed"}}\'\n'
      )
      chmodSync(muse, 0o700)
      const host = spawnHost(
        cli,
        profile,
        {
          [HOST_LEASE_TIMING_ENV]: `heartbeat:200,ttl:1000,grace:${graceMs}`,
          META_API_KEY: 'subprocess-test-key'
        },
        ['--muse-binary', muse]
      )

      // The app starts the run and quits.
      await waitFor(() => existsSync(taskWraithHostDiscoveryPath(profile)), 'production discovery')
      const app = new HostProjectionClient({
        userDataPath: profile,
        // The identity command() stamps as the actor.
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
      await app.connect()
      const ws = await app.submitCommand(
        command('workspace.register', 'cmd-ws', {}, { path: workspace })
      )
      const workspaceId = ws.resultRef?.kind === 'workspace' ? ws.resultRef.workspaceId : ''
      const thread = await app.submitCommand(
        command('thread.create', 'cmd-thread', {}, { scope: 'workspace', workspaceId })
      )
      const threadId = thread.resultRef?.kind === 'thread' ? thread.resultRef.threadId : ''
      const offers = await app.getProviderOffers('muse')
      await expect(
        app.submitCommand(
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
      ).resolves.toMatchObject({ status: 'succeeded' })
      await expect(
        app.submitCommand(command('composer.send', 'cmd-send', { threadId }, { text: 'slow' }))
      ).resolves.toMatchObject({ status: 'succeeded' })
      app.close()
      await waitFor(() => host.stderr().includes('draining (cap'), 'the drain', 15_000)

      // Reopened during the drain; the run finishes while it is attached.
      const reopened = await connect(profile, 'tui-drain-reopened')
      await waitForAsync(
        async () => (await reopened.getHostStatus()).liveWork.runs === 0,
        'the run to finish',
        15_000
      )
      // One drop, and the reconnect 1.8 s later.
      reopened.close()
      await new Promise((resolve) => setTimeout(resolve, 1_800))
      expect(host.child.exitCode, host.stderr()).toBeNull()
      const back = await connect(profile, 'tui-drain-back')
      await expect(back.getHostStatus()).resolves.toMatchObject({
        pid: host.child.pid,
        lifetime: { phase: 'held', holders: 1 }
      })

      // It quits for good: the Host leaves one grace later, and cleanly.
      back.close()
      const leftAt = Date.now()
      await waitForExit(host.child)
      expect(host.child.exitCode, host.stderr()).toBe(0)
      expect(Date.now() - leftAt).toBeGreaterThanOrEqual(graceMs - 300)
      expect(host.stderr()).toContain('draining resumes')
      expect(host.stderr()).toContain('exit requested: drained')
      expectArtefactsGone(profile)
    },
    90_000
  )
})
