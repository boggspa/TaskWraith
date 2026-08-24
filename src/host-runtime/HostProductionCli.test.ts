import { expect, it } from 'vitest'
import { HostProductionCliError, parseHostProductionCli } from './HostProductionCli'

it('strictly parses production cold-profile serving without parent supervision', () => {
  expect(
    parseHostProductionCli(['serve', '--profile', '/tmp/new-host-profile', '--mode', 'production'])
  ).toEqual({ command: 'serve', profilePath: '/tmp/new-host-profile', mode: 'production' })
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
})
