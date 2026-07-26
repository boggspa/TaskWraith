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

function fakeChildProcess(): ChildProcessWithoutNullStreams {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough
    stdout: PassThrough
    stderr: PassThrough
    killed: boolean
    kill: ReturnType<typeof vi.fn>
  }
  proc.stdin = new PassThrough()
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  proc.killed = false
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
