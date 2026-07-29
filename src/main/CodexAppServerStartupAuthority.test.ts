import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/taskwraith-codex-app-server-startup-authority-test',
    getVersion: () => 'test'
  }
}))

import {
  CodexAppServerClient,
  type CodexAppServerStartupDependencies
} from './CodexAppServerClient'
import type { CodexAppServerProcessLaunchPlan } from './codex/CodexAppServerProcessLaunchPlan'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function fakeChildProcess(pid = 4242): ChildProcessWithoutNullStreams {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough
    stdout: PassThrough
    stderr: PassThrough
    killed: boolean
    pid: number
    exitCode: number | null
    signalCode: NodeJS.Signals | null
    kill: ReturnType<typeof vi.fn>
  }
  proc.stdin = new PassThrough()
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  proc.killed = false
  proc.pid = pid
  proc.exitCode = null
  proc.signalCode = null
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

function harness(overrides: Partial<CodexAppServerStartupDependencies> = {}) {
  const proc = fakeChildProcess()
  const ensureHomeForLaunch = vi.fn(async () => {})
  const resolveBinary = vi.fn(async () => ({
    provider: 'codex' as const,
    binaryPath: '/opt/codex',
    source: 'path' as const
  }))
  const buildProcessLaunchPlan = vi.fn(async () => launchPlan)
  const spawnProcess = vi.fn(() => proc) as unknown as typeof spawn
  const dependencies: CodexAppServerStartupDependencies = {
    ensureHomeForLaunch,
    resolveBinary,
    buildProcessLaunchPlan,
    spawnProcess,
    acquireCredentialLease: async () => null,
    ...overrides
  }
  const client = new CodexAppServerClient('/tmp/taskwraith-codex-home', () => [], dependencies)
  return {
    client,
    proc,
    ensureHomeForLaunch: dependencies.ensureHomeForLaunch,
    resolveBinary: dependencies.resolveBinary,
    buildProcessLaunchPlan: dependencies.buildProcessLaunchPlan,
    spawnProcess: dependencies.spawnProcess
  }
}

describe('Codex app-server startup authority', () => {
  it('injects only a dedicated exact workspace-lock owner into a write-capable daemon', async () => {
    const setup = harness()
    vi.spyOn(setup.client, 'request').mockResolvedValue({ capabilities: {} })
    setup.client.setWorkspaceLockOwnerId('owner-run-1-lane-a')
    const spawned: Array<{ pid: number; closed: Promise<void> }> = []

    await setup.client.ensureStarted('test', {
      assertCanStart: () => {},
      bindSpawnedProcess: async (process) => {
        spawned.push(process)
      }
    })
    const spawnOptions = vi.mocked(setup.spawnProcess).mock.calls[0]?.[2]

    expect(spawnOptions?.env?.TASKWRAITH_LOCK_OWNER_ID).toBe('owner-run-1-lane-a')
    expect(setup.client.getWorkspaceLockOwnerId()).toBe('owner-run-1-lane-a')
    expect(setup.client.getProcessId()).toBe(4242)
    expect(() => setup.client.setWorkspaceLockOwnerId('owner-run-2-lane-b')).toThrow(
      /cannot change a live Codex/i
    )
    expect(spawned).toHaveLength(1)
    expect(spawned[0]?.pid).toBe(4242)
    let closed = false
    void spawned[0]?.closed.then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(closed).toBe(false)
    setup.proc.emit('close', 0, null)
    await spawned[0]?.closed
    expect(closed).toBe(true)
    setup.client.dispose()
  })

  it('refuses to spawn an owned daemon without an exact child binder', async () => {
    const setup = harness()
    setup.client.setWorkspaceLockOwnerId('owner-run-1-lane-a')

    await expect(setup.client.ensureStarted('test')).rejects.toThrow(
      /requires exact workspace-lock child binding/
    )
    expect(setup.spawnProcess).not.toHaveBeenCalled()
  })

  it('joins the exact child close and sends no request when binding fails', async () => {
    const setup = harness()
    const request = vi.spyOn(setup.client, 'request')
    setup.client.setWorkspaceLockOwnerId('owner-run-1-lane-a')
    vi.mocked(setup.proc.kill).mockImplementationOnce(() => {
      queueMicrotask(() => setup.proc.emit('close', null, 'SIGTERM'))
      return true
    })

    await expect(
      setup.client.ensureStarted('test', {
        assertCanStart: () => {},
        bindSpawnedProcess: async () => {
          throw new Error('durable transfer failed')
        }
      })
    ).rejects.toThrow(/durable transfer failed/)

    expect(setup.proc.kill).toHaveBeenCalledOnce()
    expect(request).not.toHaveBeenCalled()
    expect(setup.client.isRunning()).toBe(false)
  })

  it('strips an ambient owner from an unowned shared read-only daemon', async () => {
    const setup = harness({
      buildProcessLaunchPlan: vi.fn(async () => ({
        ...launchPlan,
        env: Object.freeze({
          ...launchPlan.env,
          TASKWRAITH_LOCK_OWNER_ID: 'ambient-owner'
        })
      }))
    })
    vi.spyOn(setup.client, 'request').mockResolvedValue({ capabilities: {} })

    await setup.client.ensureStarted('test')
    const spawnOptions = vi.mocked(setup.spawnProcess).mock.calls[0]?.[2]

    expect(spawnOptions?.env?.TASKWRAITH_LOCK_OWNER_ID).toBeUndefined()
    expect(setup.client.getWorkspaceLockOwnerId()).toBeNull()
    setup.client.dispose()
  })

  it('joins the shared daemon before the same private home becomes write-owned', async () => {
    const first = fakeChildProcess()
    const second = fakeChildProcess(4343)
    const spawnProcess = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second) as unknown as typeof spawn
    const credentialRelease = deferred<void>()
    let credentialReleased = false
    const acquireCredentialLease = vi
      .fn()
      .mockResolvedValueOnce({
        seedIntoIsolatedHome: async () => {},
        noteProviderProcess: async () => {},
        commitAndRelease: async () => {
          await credentialRelease.promise
          credentialReleased = true
        }
      })
      .mockResolvedValueOnce(null)
    const setup = harness({ spawnProcess, acquireCredentialLease })
    vi.spyOn(setup.client, 'request').mockResolvedValue({ capabilities: {} })

    await setup.client.ensureStarted('test')
    let stopped = false
    const stop = setup.client.disposeAndWait().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)
    expect(() => setup.client.setWorkspaceLockOwnerId('owner-run-1-lane-a')).toThrow(
      /cannot change a live Codex/i
    )

    first.emit('close', 0, null)
    await Promise.resolve()
    expect(stopped).toBe(false)
    expect(credentialReleased).toBe(false)
    credentialRelease.resolve()
    await stop
    expect(credentialReleased).toBe(true)
    setup.client.setWorkspaceLockOwnerId('owner-run-1-lane-a')
    await setup.client.ensureStarted('test', {
      assertCanStart: () => {},
      bindSpawnedProcess: async () => {}
    })

    expect(spawnProcess).toHaveBeenCalledTimes(2)
    expect(acquireCredentialLease).toHaveBeenCalledTimes(2)
    expect(vi.mocked(spawnProcess).mock.calls[1]?.[2]?.env?.TASKWRAITH_LOCK_OWNER_ID).toBe(
      'owner-run-1-lane-a'
    )
    second.emit('close', 0, null)
  })

  it('rejects an already-stopped owner before beginning private-home setup', async () => {
    const stopped = new AbortController()
    const stopReason = new Error('run stopped before startup')
    stopped.abort(stopReason)
    const setup = harness()

    await expect(
      setup.client.ensureStarted('test', { signal: stopped.signal })
    ).rejects.toMatchObject({
      name: 'AbortError',
      boundary: 'ensure-started-entry'
    })
    expect(setup.ensureHomeForLaunch).not.toHaveBeenCalled()
    expect(setup.spawnProcess).not.toHaveBeenCalled()
  })

  it('does not resolve a binary or spawn after Stop lands during private-home setup', async () => {
    const home = deferred<void>()
    const setup = harness({
      ensureHomeForLaunch: vi.fn(() => home.promise)
    })
    const stopped = new AbortController()

    const startup = setup.client.ensureStarted('test', { signal: stopped.signal })
    await vi.waitFor(() => expect(setup.ensureHomeForLaunch).toHaveBeenCalledTimes(1))
    stopped.abort(new Error('stopped during home setup'))
    home.resolve()

    await expect(startup).rejects.toMatchObject({
      name: 'AbortError',
      boundary: 'after-home-ready'
    })
    expect(setup.resolveBinary).not.toHaveBeenCalled()
    expect(setup.spawnProcess).not.toHaveBeenCalled()
  })

  it('does not build a launch plan or spawn after Stop lands during binary resolution', async () => {
    const binary = deferred<{
      provider: 'codex'
      binaryPath: string
      source: 'path'
    }>()
    const setup = harness({
      resolveBinary: vi.fn(() => binary.promise)
    })
    const stopped = new AbortController()

    const startup = setup.client.ensureStarted('test', { signal: stopped.signal })
    await vi.waitFor(() => expect(setup.resolveBinary).toHaveBeenCalledTimes(1))
    stopped.abort(new Error('stopped during binary resolution'))
    binary.resolve({
      provider: 'codex',
      binaryPath: '/opt/codex',
      source: 'path'
    })

    await expect(startup).rejects.toMatchObject({
      name: 'AbortError',
      boundary: 'after-binary-resolution'
    })
    expect(setup.buildProcessLaunchPlan).not.toHaveBeenCalled()
    expect(setup.spawnProcess).not.toHaveBeenCalled()
  })

  it('does not spawn after Stop lands while the immutable launch plan is being built', async () => {
    const plan = deferred<CodexAppServerProcessLaunchPlan>()
    const setup = harness({
      buildProcessLaunchPlan: vi.fn(() => plan.promise)
    })
    const stopped = new AbortController()

    const startup = setup.client.ensureStarted('test', { signal: stopped.signal })
    await vi.waitFor(() => expect(setup.buildProcessLaunchPlan).toHaveBeenCalledTimes(1))
    stopped.abort(new Error('stopped during launch-plan construction'))
    plan.resolve(launchPlan)

    await expect(startup).rejects.toMatchObject({
      name: 'AbortError',
      boundary: 'after-launch-plan'
    })
    expect(setup.spawnProcess).not.toHaveBeenCalled()
  })

  it('runs a synchronous authority assertion as the immediate pre-spawn fence', async () => {
    const setup = harness()
    const revocation = new Error('exact RunManager claim was revoked')
    const visited: string[] = []

    await expect(
      setup.client.ensureStarted('test', {
        assertCanStart: (boundary) => {
          visited.push(boundary)
          if (boundary === 'before-spawn') throw revocation
        }
      })
    ).rejects.toBe(revocation)

    expect(visited).toContain('after-launch-plan')
    expect(visited.at(-1)).toBe('before-spawn')
    expect(setup.spawnProcess).not.toHaveBeenCalled()

    const source = readFileSync(new URL('./CodexAppServerClient.ts', import.meta.url), 'utf8')
    expect(source).toMatch(
      /assertCodexAppServerStartupAuthority\(startupAuthority, 'before-spawn'\)\s+const proc = this\.startupDependencies\.spawnProcess/
    )
  })

  it('finishes the shared protocol handshake but rejects the stopped owner after startup', async () => {
    const setup = harness()
    const initialized = deferred<unknown>()
    vi.spyOn(setup.client, 'request').mockImplementation(async () => initialized.promise)
    const notify = vi.spyOn(setup.client, 'notify')
    const stopped = new AbortController()

    const startup = setup.client.ensureStarted('test', { signal: stopped.signal })
    await vi.waitFor(() => expect(setup.spawnProcess).toHaveBeenCalledTimes(1))
    stopped.abort(new Error('stopped during initialize handshake'))
    initialized.resolve({ capabilities: {} })

    await expect(startup).rejects.toMatchObject({
      name: 'AbortError',
      boundary: 'after-startup'
    })
    expect(notify).toHaveBeenCalledWith('initialized')
    expect(setup.client.isRunning()).toBe(true)

    const nextOwner = new AbortController()
    await expect(
      setup.client.ensureStarted('test', { signal: nextOwner.signal })
    ).resolves.toBeUndefined()
    expect(setup.spawnProcess).toHaveBeenCalledTimes(1)
    setup.client.dispose()
  })

  it('checks each joining caller after a shared startup without replacing its owner', async () => {
    const home = deferred<void>()
    const setup = harness({
      ensureHomeForLaunch: vi.fn(() => home.promise)
    })
    vi.spyOn(setup.client, 'request').mockResolvedValue({ capabilities: {} })
    const owner = new AbortController()
    const stoppedJoiner = new AbortController()

    const ownerStartup = setup.client.ensureStarted('test', { signal: owner.signal })
    await vi.waitFor(() => expect(setup.ensureHomeForLaunch).toHaveBeenCalledTimes(1))
    const joinedStartup = setup.client.ensureStarted('test', {
      signal: stoppedJoiner.signal
    })
    stoppedJoiner.abort(new Error('joining run stopped'))
    home.resolve()

    await expect(ownerStartup).resolves.toBeUndefined()
    await expect(joinedStartup).rejects.toMatchObject({
      name: 'AbortError',
      boundary: 'after-shared-startup'
    })
    expect(setup.spawnProcess).toHaveBeenCalledTimes(1)
    setup.client.dispose()
  })

  it('does not launch the compatibility retry when Stop follows a failed initialize', async () => {
    const setup = harness()
    const stopped = new AbortController()
    vi.spyOn(setup.client, 'request').mockImplementation(async () => {
      ;(setup.client as unknown as { recentStderr: string }).recentStderr =
        'Error loading config.toml: unknown variant `priority`, expected `fast` or `flex`'
      stopped.abort(new Error('stopped before compatibility retry'))
      throw new Error('Codex app-server exited.')
    })

    await expect(
      setup.client.ensureStarted('test', { signal: stopped.signal })
    ).rejects.toMatchObject({
      name: 'AbortError',
      boundary: 'before-compatibility-retry'
    })
    expect(setup.spawnProcess).toHaveBeenCalledTimes(1)
    expect(setup.proc.kill).not.toHaveBeenCalled()
    setup.client.dispose()
  })
})
