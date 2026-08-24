import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { HostProductionCliError, parseHostProductionCli } from './HostProductionCli'
import { runHostShutdownCli } from './cli'

it('strictly parses production cold-profile serving without parent supervision', () => {
  expect(
    parseHostProductionCli(['serve', '--profile', '/tmp/new-host-profile', '--mode', 'production'])
  ).toEqual({ command: 'serve', profilePath: '/tmp/new-host-profile', mode: 'production' })
  expect(parseHostProductionCli(['stop', '--profile', '/tmp/new-host-profile'])).toEqual({
    command: 'stop',
    profilePath: '/tmp/new-host-profile'
  })
  expect(() =>
    parseHostProductionCli([
      'serve',
      '--profile',
      '/tmp/p',
      '--mode',
      'production',
      '--parent-pid',
      '1'
    ])
  ).toThrow(HostProductionCliError)
  expect(() =>
    parseHostProductionCli(['serve', '--profile', '/tmp/../tmp/p', '--mode', 'production'])
  ).toThrow(HostProductionCliError)
  expect(() => parseHostProductionCli(['serve', '--profile', '/', '--mode', 'production'])).toThrow(
    HostProductionCliError
  )
  expect(() =>
    parseHostProductionCli(['serve', '--profile', '/tmp/host\u0007', '--mode', 'production'])
  ).toThrow(HostProductionCliError)
  expect(() =>
    parseHostProductionCli([
      'serve',
      '--profile',
      '/tmp/p',
      '--mode',
      'production',
      '--muse-binary',
      '/'
    ])
  ).toThrow(HostProductionCliError)
  expect(() =>
    parseHostProductionCli([
      'serve',
      '--profile',
      '/tmp/p',
      '--profile',
      '/tmp/q',
      '--mode',
      'production'
    ])
  ).toThrow(HostProductionCliError)
  expect(() =>
    parseHostProductionCli(['serve', '--profile', '/tmp/p', '--mode', 'production', '--wat'])
  ).toThrow(HostProductionCliError)
  for (const flag of ['--mode', '--muse-binary', '--parent-pid']) {
    expect(() => parseHostProductionCli(['stop', '--profile', '/tmp/p', flag, 'x'])).toThrow(
      HostProductionCliError
    )
  }
})

it('keeps packaged launchers fixed to production serve while routing explicit stop directly', () => {
  for (const name of ['taskwraith-host', 'taskwraith-host.cmd', 'taskwraith-host.ps1']) {
    const source = readFileSync(join(process.cwd(), 'build', 'host-launcher', name), 'utf8')
    expect(source).toMatch(/serve\s+--mode\s+production/)
    expect(source).toMatch(/stop/)
    expect(source).not.toMatch(/ELECTRON_RUN_AS_NODE=1/)
  }
})

it('dispatches stop only through the authenticated shutdown client', async () => {
  const shutdown = vi.fn(async () => 'stopping' as const)
  const createShutdown = vi.fn(() => ({ shutdown }))
  await runHostShutdownCli(['stop', '--profile', '/tmp/profile'], createShutdown)
  expect(createShutdown).toHaveBeenCalledWith({ profilePath: '/tmp/profile' })
  expect(shutdown).toHaveBeenCalledOnce()
})
