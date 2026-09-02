import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { HostProductionCliError, parseHostProductionCli } from './HostProductionCli'
import { runHostShutdownCli } from './cli'

/**
 * The CLI rejects a non-canonical --profile (`resolve(value) === value`), so
 * the happy-path fixtures must already be in their runner-OS canonical form.
 * The negative-path fixtures below intentionally stay POSIX-shaped: every
 * platform rejects them with a HostProductionCliError.
 */
const NEW_PROFILE = process.platform === 'win32' ? 'C:\\new-host-profile' : '/tmp/new-host-profile'
const STOP_PROFILE = process.platform === 'win32' ? 'C:\\profile' : '/tmp/profile'

it('strictly parses production cold-profile serving without parent supervision', () => {
  expect(
    parseHostProductionCli(['serve', '--profile', NEW_PROFILE, '--mode', 'production'])
  ).toEqual({ command: 'serve', profilePath: NEW_PROFILE, mode: 'production' })
  expect(parseHostProductionCli(['stop', '--profile', NEW_PROFILE])).toEqual({
    command: 'stop',
    profilePath: NEW_PROFILE
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
  await runHostShutdownCli(['stop', '--profile', STOP_PROFILE], createShutdown)
  expect(createShutdown).toHaveBeenCalledWith({ profilePath: STOP_PROFILE })
  expect(shutdown).toHaveBeenCalledOnce()
})
