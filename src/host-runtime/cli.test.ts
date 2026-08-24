import { expect, it, vi } from 'vitest'
import { runHostProductionCli, runHostShutdownCli } from './cli'

it('dispatches a parsed production server through an injected factory', async () => {
  const start = vi.fn(async () => {})
  const waitForShutdown = vi.fn(async () => {})
  const factory = vi.fn(() => ({ start, waitForShutdown }))
  await runHostProductionCli(
    ['serve', '--profile', '/tmp/host-cli-profile', '--mode', 'production'],
    factory as never
  )
  expect(factory).toHaveBeenCalledWith({ profilePath: '/tmp/host-cli-profile' })
  expect(start).toHaveBeenCalledOnce()
  expect(waitForShutdown).toHaveBeenCalledOnce()
})

it('dispatches stop through an injected authenticated shutdown client', async () => {
  const shutdown = vi.fn(async () => 'stopping')
  await runHostShutdownCli(['stop', '--profile', '/tmp/host-cli-profile'], () => ({ shutdown }))
  expect(shutdown).toHaveBeenCalledOnce()
})
