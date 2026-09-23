import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  HOST_PRODUCTION_USAGE,
  HostProductionCliError,
  parseHostProductionCli
} from './HostProductionCli'
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

/**
 * Golden captured from the pre-verb parser (HEAD 542e13cab, pristine worktree):
 * every serve/stop vector parses to the same value or the same error, the
 * usage text aside, now that status and stop-all share the parser. The
 * vectors are POSIX-shaped, as captured.
 */
const PRE_VERB_USAGE =
  'Usage: taskwraith-host serve --profile <absolute canonical non-root path> --mode production [--muse-binary <absolute canonical path>]\n       taskwraith-host stop --profile <absolute canonical non-root path>'
const PRE_VERB_GOLDEN: ReadonlyArray<{
  readonly argv: readonly string[]
  readonly value?: unknown
  readonly error?: string
}> = [
  {
    argv: ['serve', '--profile', '/tmp/new-host-profile', '--mode', 'production'],
    value: { command: 'serve', profilePath: '/tmp/new-host-profile', mode: 'production' }
  },
  {
    argv: ['serve', '--profile', '/tmp/p', '--mode', 'production', '--muse-binary', '/tmp/muse'],
    value: { command: 'serve', profilePath: '/tmp/p', mode: 'production', museBinary: '/tmp/muse' }
  },
  {
    argv: ['serve', '--mode', 'production', '--profile', '/tmp/p'],
    value: { command: 'serve', profilePath: '/tmp/p', mode: 'production' }
  },
  {
    argv: ['stop', '--profile', '/tmp/profile'],
    value: { command: 'stop', profilePath: '/tmp/profile' }
  },
  {
    argv: ['serve', '--profile', '/tmp/p', '--mode', 'production', '--parent-pid', '1'],
    error: '--parent-pid is unavailable in production mode.'
  },
  {
    argv: ['serve', '--profile', '/tmp/../tmp/p', '--mode', 'production'],
    error: '--profile must be an absolute canonical non-root path.'
  },
  {
    argv: ['serve', '--profile', '/', '--mode', 'production'],
    error: '--profile must be an absolute canonical non-root path.'
  },
  {
    argv: ['serve', '--profile', '/tmp/p', '--mode', 'production', '--wat'],
    error: 'Unknown argument "--wat". <usage>'
  },
  { argv: ['serve', '--profile', '/tmp/p'], error: '<usage>' },
  { argv: ['serve', '--profile', '/tmp/p', '--mode', 'diagnostic'], error: '<usage>' },
  { argv: ['stop'], error: '<usage>' },
  {
    argv: ['stop', '--profile', '/tmp/p', '--mode', 'x'],
    error: '--mode is unavailable for stop.'
  },
  {
    argv: ['stop', '--profile', '/tmp/p', '--muse-binary', 'x'],
    error: '--muse-binary is unavailable for stop.'
  },
  {
    argv: ['stop', '--profile', '/tmp/p', '--parent-pid', 'x'],
    error: '--parent-pid is unavailable in production mode.'
  },
  { argv: [], error: '<usage>' },
  { argv: ['serve', '--profile'], error: '--profile requires one value. <usage>' },
  {
    argv: ['serve', '--profile', '--mode', 'production'],
    error: '--profile requires one value. <usage>'
  },
  {
    argv: ['serve', '--profile', '/tmp/p', '--profile', '/tmp/q', '--mode', 'production'],
    error: '--profile may appear once.'
  },
  {
    argv: ['serve', '--profile', '/tmp/p', '--mode', 'production', '--mode', 'production'],
    error: '--mode may appear once.'
  },
  {
    argv: ['serve', '--profile', 'relative/p', '--mode', 'production'],
    error: '--profile must be an absolute canonical path.'
  },
  {
    argv: ['serve', '--profile', ' /tmp/p', '--mode', 'production'],
    error: '--profile must be an absolute canonical path.'
  }
]

it.skipIf(process.platform === 'win32')(
  'parses every serve and stop vector exactly as the pre-verb parser did',
  () => {
    expect(PRE_VERB_GOLDEN).toHaveLength(21)
    expect(HOST_PRODUCTION_USAGE.startsWith(PRE_VERB_USAGE)).toBe(true)
    for (const vector of PRE_VERB_GOLDEN) {
      let actual: { value?: unknown; error?: string }
      try {
        actual = { value: parseHostProductionCli(vector.argv) }
      } catch (error) {
        expect(error).toBeInstanceOf(HostProductionCliError)
        actual = { error: (error as Error).message.split(HOST_PRODUCTION_USAGE).join('<usage>') }
      }
      expect({ argv: vector.argv, ...actual }).toEqual(vector)
    }
  }
)

const REGISTRY_PROFILE =
  process.platform === 'win32' ? 'C:\\registry-profile' : '/tmp/registry-profile'
const PAYLOAD_ROOT = process.platform === 'win32' ? 'C:\\repo\\out\\host' : '/repo/out/host'

it('parses stop-all with one explicit scope and lists only without one', () => {
  expect(parseHostProductionCli(['stop-all'])).toEqual({
    command: 'stop-all',
    scope: { kind: 'list' },
    scanArgv: false,
    sweep: false,
    json: false
  })
  expect(parseHostProductionCli(['stop-all', '--all', '--sweep', '--json', '--scan-argv'])).toEqual(
    {
      command: 'stop-all',
      scope: { kind: 'all' },
      scanArgv: true,
      sweep: true,
      json: true
    }
  )
  expect(parseHostProductionCli(['stop-all', '--profile', REGISTRY_PROFILE])).toMatchObject({
    scope: { kind: 'profile', profilePath: REGISTRY_PROFILE }
  })
  expect(parseHostProductionCli(['stop-all', '--payload-root', PAYLOAD_ROOT])).toMatchObject({
    scope: { kind: 'payload-root', payloadRoot: PAYLOAD_ROOT }
  })
  for (const argv of [
    ['stop-all', '--all', '--profile', REGISTRY_PROFILE],
    ['stop-all', '--profile', REGISTRY_PROFILE, '--payload-root', PAYLOAD_ROOT],
    ['stop-all', '--payload-root', PAYLOAD_ROOT, '--all']
  ]) {
    expect(() => parseHostProductionCli(argv)).toThrow(/mutually exclusive/)
  }
  expect(() => parseHostProductionCli(['stop-all', '--all', '--all'])).toThrow(/may appear once/)
  expect(() => parseHostProductionCli(['stop-all', '--payload-root', 'relative/out'])).toThrow(
    HostProductionCliError
  )
  expect(() => parseHostProductionCli(['stop-all', '--payload-root'])).toThrow(/requires one value/)
})

it('parses status as a listing that can never stop anything', () => {
  expect(parseHostProductionCli(['status'])).toEqual({
    command: 'status',
    scanArgv: false,
    json: false
  })
  expect(
    parseHostProductionCli(['status', '--profile', REGISTRY_PROFILE, '--json', '--scan-argv'])
  ).toEqual({ command: 'status', profilePath: REGISTRY_PROFILE, scanArgv: true, json: true })
  for (const flag of ['--all', '--sweep', '--payload-root']) {
    expect(() => parseHostProductionCli(['status', flag, PAYLOAD_ROOT])).toThrow(/Unknown argument/)
  }
})

it('still refuses parent-death supervision and serve-only flags on the registry verbs', () => {
  for (const command of ['status', 'stop-all']) {
    expect(() => parseHostProductionCli([command, '--parent-pid', '1'])).toThrow(
      '--parent-pid is unavailable in production mode.'
    )
    expect(() => parseHostProductionCli([command, '--mode', 'production'])).toThrow(
      `--mode is unavailable for ${command}.`
    )
    expect(() => parseHostProductionCli([command, '--muse-binary', '/x'])).toThrow(
      `--muse-binary is unavailable for ${command}.`
    )
  }
  expect(HOST_PRODUCTION_USAGE).toContain('taskwraith-host status')
  expect(HOST_PRODUCTION_USAGE).toContain('taskwraith-host stop-all [--all | --profile')
})
