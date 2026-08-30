import { expect, it, vi } from 'vitest'
import { runHostProductionCli, runHostShutdownCli } from './cli'

const PAYLOAD_VERSION = `sha256:${'a'.repeat(64)}`
const resolvePayloadVersion = () => PAYLOAD_VERSION

it('dispatches a parsed production server through an injected factory', async () => {
  const start = vi.fn(async () => {})
  const waitForShutdown = vi.fn(async () => {})
  const factory = vi.fn(() => ({ start, waitForShutdown }))
  await runHostProductionCli(
    ['serve', '--profile', '/tmp/host-cli-profile', '--mode', 'production'],
    factory as never,
    { readFullAccessBootstrapSecret: () => null, resolvePayloadVersion }
  )
  expect(factory).toHaveBeenCalledWith({
    profilePath: '/tmp/host-cli-profile',
    payloadVersion: PAYLOAD_VERSION
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
    ['serve', '--profile', '/tmp/host-cli-profile', '--mode', 'production'],
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
    profilePath: '/tmp/host-cli-profile',
    payloadVersion: PAYLOAD_VERSION,
    terminalLauncher
  })
})

it('does not advertise a terminal handoff for background or detached stdio', async () => {
  const start = vi.fn(async () => {})
  const waitForShutdown = vi.fn(async () => {})
  const factory = vi.fn(() => ({ start, waitForShutdown }))
  const createTerminalLauncher = vi.fn(() => ({ launch: vi.fn() }))

  await runHostProductionCli(
    ['serve', '--profile', '/tmp/host-cli-profile', '--mode', 'production'],
    factory as never,
    {
      stdio: {
        stdin: { isTTY: true },
        stdout: { isTTY: false },
        stderr: { isTTY: true }
      },
      createTerminalLauncher,
      readFullAccessBootstrapSecret: () => null,
      resolvePayloadVersion
    }
  )

  expect(createTerminalLauncher).not.toHaveBeenCalled()
  expect(factory).toHaveBeenCalledWith({
    profilePath: '/tmp/host-cli-profile',
    payloadVersion: PAYLOAD_VERSION
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
    ['serve', '--profile', '/tmp/host-cli-profile', '--mode', 'production'],
    factory as never,
    { readFullAccessBootstrapSecret: () => source, resolvePayloadVersion }
  )

  expect(observed).toEqual(Buffer.alloc(32, 6))
  expect(source).toEqual(Buffer.alloc(32, 0))
})

it('dispatches stop through an injected authenticated shutdown client', async () => {
  const shutdown = vi.fn(async () => 'stopping' as const)
  await runHostShutdownCli(['stop', '--profile', '/tmp/host-cli-profile'], () => ({ shutdown }))
  expect(shutdown).toHaveBeenCalledOnce()
})
