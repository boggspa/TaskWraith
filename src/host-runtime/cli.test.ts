import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { HostStopAllOptions, HostStopAllReport } from '../host-client/HostStopAll'
import {
  runHostCli,
  runHostProductionCli,
  runHostShutdownCli,
  runHostStatusCli,
  runHostStopAllCli
} from './cli'
import {
  HOST_REGISTRY_ROOT_ENV,
  HostRegistryPublisher,
  hostRegistryEntryPath,
  readHostRegistryEntry
} from './HostRegistry'
import type { HostRegistryPublisherPort } from './HostRegistryPort'

const PAYLOAD_VERSION = `sha256:${'a'.repeat(64)}`
const resolvePayloadVersion = () => PAYLOAD_VERSION

/**
 * The CLI rejects a non-canonical --profile (`resolve(value) === value`), so
 * the fixture must already be in its runner-OS canonical form.
 */
const CLI_PROFILE = process.platform === 'win32' ? 'C:\\host-cli-profile' : '/tmp/host-cli-profile'

it('dispatches a parsed production server through an injected factory', async () => {
  const start = vi.fn(async () => {})
  const waitForShutdown = vi.fn(async () => {})
  const factory = vi.fn(() => ({ start, waitForShutdown }))
  await runHostProductionCli(
    ['serve', '--profile', CLI_PROFILE, '--mode', 'production'],
    factory as never,
    {
      createTerminalWindowLauncher: () => undefined,
      readFullAccessBootstrapSecret: () => null,
      resolvePayloadVersion
    }
  )
  expect(factory).toHaveBeenCalledWith({
    profilePath: CLI_PROFILE,
    payloadVersion: PAYLOAD_VERSION,
    registry: expect.any(HostRegistryPublisher)
  })
  expect(start).toHaveBeenCalledOnce()
  expect(waitForShutdown).toHaveBeenCalledOnce()
})

it('passes a terminal launcher only when every standard stream is an interactive TTY', async () => {
  const start = vi.fn(async () => {})
  const waitForShutdown = vi.fn(async () => {})
  const factory = vi.fn(() => ({ start, waitForShutdown }))
  const terminalLauncher = { launch: vi.fn() }
  const createTerminalLauncher = vi.fn(() => terminalLauncher)

  await runHostProductionCli(
    ['serve', '--profile', CLI_PROFILE, '--mode', 'production'],
    factory as never,
    {
      stdio: {
        stdin: { isTTY: true },
        stdout: { isTTY: true },
        stderr: { isTTY: true }
      },
      createTerminalLauncher,
      readFullAccessBootstrapSecret: () => null,
      resolvePayloadVersion
    }
  )

  expect(createTerminalLauncher).toHaveBeenCalledOnce()
  expect(factory).toHaveBeenCalledWith({
    profilePath: CLI_PROFILE,
    payloadVersion: PAYLOAD_VERSION,
    registry: expect.any(HostRegistryPublisher),
    terminalLauncher
  })
})

it('uses a separate terminal-window handoff for background or detached stdio', async () => {
  const start = vi.fn(async () => {})
  const waitForShutdown = vi.fn(async () => {})
  const factory = vi.fn(() => ({ start, waitForShutdown }))
  const terminalWindowLauncher = { launch: vi.fn(), launchForProvider: vi.fn() }
  const createTerminalLauncher = vi.fn(() => ({ launch: vi.fn() }))
  const createTerminalWindowLauncher = vi.fn(() => terminalWindowLauncher)

  await runHostProductionCli(
    ['serve', '--profile', CLI_PROFILE, '--mode', 'production'],
    factory as never,
    {
      stdio: {
        stdin: { isTTY: true },
        stdout: { isTTY: false },
        stderr: { isTTY: true }
      },
      createTerminalLauncher,
      createTerminalWindowLauncher,
      readFullAccessBootstrapSecret: () => null,
      resolvePayloadVersion
    }
  )

  expect(createTerminalLauncher).not.toHaveBeenCalled()
  expect(createTerminalWindowLauncher).toHaveBeenCalledOnce()
  expect(factory).toHaveBeenCalledWith({
    profilePath: CLI_PROFILE,
    payloadVersion: PAYLOAD_VERSION,
    registry: expect.any(HostRegistryPublisher),
    terminalLauncher: terminalWindowLauncher
  })
})

it('keeps auth flows unavailable when a headless Host has no terminal-window handoff', async () => {
  const start = vi.fn(async () => {})
  const waitForShutdown = vi.fn(async () => {})
  const factory = vi.fn(() => ({ start, waitForShutdown }))
  const createTerminalWindowLauncher = vi.fn(() => undefined)

  await runHostProductionCli(
    ['serve', '--profile', CLI_PROFILE, '--mode', 'production'],
    factory as never,
    {
      stdio: { stdin: {}, stdout: {}, stderr: {} },
      createTerminalWindowLauncher,
      readFullAccessBootstrapSecret: () => null,
      resolvePayloadVersion
    }
  )

  expect(createTerminalWindowLauncher).toHaveBeenCalledOnce()
  expect(factory).toHaveBeenCalledWith({
    profilePath: CLI_PROFILE,
    payloadVersion: PAYLOAD_VERSION,
    registry: expect.any(HostRegistryPublisher)
  })
})

it('forwards an inherited-fd Full Access secret once and zeroes the source buffer', async () => {
  const source = Buffer.alloc(32, 6)
  let observed: Buffer | null = null
  const factory = vi.fn((input: { fullAccessBootstrapSecret?: Buffer }) => {
    observed = input.fullAccessBootstrapSecret ? Buffer.from(input.fullAccessBootstrapSecret) : null
    return { start: vi.fn(async () => {}), waitForShutdown: vi.fn(async () => {}) }
  })

  await runHostProductionCli(
    ['serve', '--profile', CLI_PROFILE, '--mode', 'production'],
    factory as never,
    {
      createTerminalWindowLauncher: () => undefined,
      readFullAccessBootstrapSecret: () => source,
      resolvePayloadVersion
    }
  )

  expect(observed).toEqual(Buffer.alloc(32, 6))
  expect(source).toEqual(Buffer.alloc(32, 0))
})

it('hands serve a registry publisher for this profile, this CLI and this Node', async () => {
  const start = vi.fn(async () => {})
  const waitForShutdown = vi.fn(async () => {})
  const factory = vi.fn(() => ({ start, waitForShutdown }))
  const registry: HostRegistryPublisherPort = {
    publish: vi.fn(),
    refresh: vi.fn(),
    check: vi.fn(() => 'present' as const),
    remove: vi.fn()
  }
  const createRegistryPublisher = vi.fn(() => registry)
  const env = { [HOST_REGISTRY_ROOT_ENV]: '/registry-root' }
  await runHostProductionCli(
    ['serve', '--profile', CLI_PROFILE, '--mode', 'production'],
    factory as never,
    {
      env,
      createTerminalWindowLauncher: () => undefined,
      readFullAccessBootstrapSecret: () => null,
      resolvePayloadVersion,
      createRegistryPublisher
    }
  )
  expect(createRegistryPublisher).toHaveBeenCalledOnce()
  expect(createRegistryPublisher).toHaveBeenCalledWith({
    profilePath: CLI_PROFILE,
    env,
    cliPath: resolve(__dirname, 'cli.js'),
    nodeExecutable: process.execPath,
    log: expect.any(Function)
  })
  expect(factory).toHaveBeenCalledWith({
    profilePath: CLI_PROFILE,
    payloadVersion: PAYLOAD_VERSION,
    registry
  })
  // Serve only hands the publisher over; the server publishes after it listens.
  expect(registry.publish).not.toHaveBeenCalled()
})

it('builds the default publisher on the registry root the serve environment names', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'host-cli-registry-serve-')))
  const profile = realpathSync(mkdtempSync(join(tmpdir(), 'host-cli-registry-profile-')))
  try {
    let registry: HostRegistryPublisherPort | undefined
    const factory = vi.fn((input: { registry?: HostRegistryPublisherPort }) => {
      registry = input.registry
      return { start: vi.fn(async () => {}), waitForShutdown: vi.fn(async () => {}) }
    })
    await runHostProductionCli(
      ['serve', '--profile', profile, '--mode', 'production'],
      factory as never,
      {
        env: { [HOST_REGISTRY_ROOT_ENV]: root },
        createTerminalWindowLauncher: () => undefined,
        readFullAccessBootstrapSecret: () => null,
        resolvePayloadVersion
      }
    )
    expect(registry).toBeInstanceOf(HostRegistryPublisher)
    registry!.publish({
      profilePath: profile,
      pid: process.pid,
      startedAt: '2026-09-23T00:00:00.000Z',
      hostId: 'host-cli',
      persist: false,
      leaseMode: 'lease',
      holders: 0,
      implicitHolders: 0,
      lifetimePhase: 'held'
    })
    expect(readHostRegistryEntry(root, profile)).toMatchObject({
      kind: 'present',
      entry: {
        pid: process.pid,
        cliPath: resolve(__dirname, 'cli.js'),
        nodeExecutable: process.execPath
      }
    })
    registry!.remove()
    expect(existsSync(hostRegistryEntryPath(root, profile))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(profile, { recursive: true, force: true })
  }
})

it('dispatches stop through an injected authenticated shutdown client', async () => {
  const shutdown = vi.fn(async () => 'stopping' as const)
  await runHostShutdownCli(['stop', '--profile', CLI_PROFILE], () => ({ shutdown }))
  expect(shutdown).toHaveBeenCalledOnce()
})

function stopAllReport(
  options: HostStopAllOptions,
  profilePaths: readonly string[] = [CLI_PROFILE]
): HostStopAllReport {
  return {
    registryRoot: '/registry',
    scope: options.scope,
    scanArgv: options.scanArgv === true,
    hosts: profilePaths.map((profilePath, index) => ({
      source: 'registry',
      profilePath,
      pid: 900 + index,
      cliPath: null,
      payloadVersion: null,
      startedAt: null,
      holders: 1,
      implicitHolders: 0,
      persist: false,
      liveness: 'live',
      selected: options.scope.kind !== 'list'
    })),
    unreadableEntries: [],
    exitCode: options.scope.kind === 'list' ? 3 : 0
  }
}

it('dispatches stop-all with the parsed scope and returns its exit code', async () => {
  const stopAll = vi.fn(async (options: HostStopAllOptions) => stopAllReport(options))
  const write = vi.fn()
  await expect(
    runHostStopAllCli(['stop-all', '--profile', CLI_PROFILE, '--sweep'], { stopAll, write })
  ).resolves.toBe(0)
  expect(stopAll).toHaveBeenCalledWith(
    expect.objectContaining({
      scope: { kind: 'profile', profilePath: CLI_PROFILE },
      scanArgv: false,
      sweep: true
    })
  )
  expect(write.mock.calls[0][0]).toContain(`pid 900 · live · registry · ${CLI_PROFILE}`)
  await expect(runHostStopAllCli(['stop-all', '--json'], { stopAll, write })).resolves.toBe(3)
  expect(JSON.parse(write.mock.calls[1][0])).toMatchObject({
    scope: { kind: 'list' },
    exitCode: 3
  })
})

it('reports status as a listing that exits 0 and narrows to one profile', async () => {
  const other = process.platform === 'win32' ? 'C:\\other-profile' : '/tmp/other-profile'
  const stopAll = vi.fn(async (options: HostStopAllOptions) =>
    stopAllReport(options, [CLI_PROFILE, other])
  )
  const write = vi.fn()
  await expect(
    runHostStatusCli(['status', '--profile', other, '--json'], { stopAll, write })
  ).resolves.toBe(0)
  expect(stopAll).toHaveBeenCalledWith(expect.objectContaining({ scope: { kind: 'list' } }))
  const report = JSON.parse(write.mock.calls[0][0]) as HostStopAllReport
  expect(report.exitCode).toBe(0)
  expect(report.hosts.map((host) => host.profilePath)).toEqual([other])
})

it('routes status and stop-all ahead of the diagnostic fallback, on the registry root from the environment', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'host-cli-registry-')))
  vi.stubEnv(HOST_REGISTRY_ROOT_ENV, root)
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    await expect(runHostCli(['status', '--json'])).resolves.toBe(0)
    // No scope: stop-all lists and stops nothing.
    await expect(runHostCli(['stop-all', '--json'])).resolves.toBe(3)
    const reports = stdout.mock.calls.map(([chunk]) => JSON.parse(String(chunk)))
    expect(reports).toMatchObject([
      { registryRoot: root, hosts: [], exitCode: 0 },
      { registryRoot: root, hosts: [], exitCode: 3, scope: { kind: 'list' } }
    ])
  } finally {
    stdout.mockRestore()
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  }
})
