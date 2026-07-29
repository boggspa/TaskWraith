import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  createWindowsCmdInvocation,
  quoteWindowsCmdToken,
  resolvePlatformCommandInvocation
}: {
  createWindowsCmdInvocation: (
    scriptPath: string,
    args?: string[],
    env?: Record<string, string | undefined>
  ) => { command: string; arguments: string[] }
  quoteWindowsCmdToken: (value: string, label?: string) => string
  resolvePlatformCommandInvocation: (
    command: string,
    args?: string[],
    platform?: string,
    env?: Record<string, string | undefined>
  ) => { command: string; arguments: string[] }
} = require('./windows-cmd-invocation.cjs')

describe('Windows cmd launcher invocation', () => {
  it('uses a fixed ComSpec command and quotes paths and arguments with spaces', () => {
    expect(
      createWindowsCmdInvocation(
        'C:\\Program Files\\TaskWraith\\resources\\bin\\tw.cmd',
        ['--snapshot', '--user-data', 'C:\\Users\\Test User\\TaskWraith Data'],
        { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
      )
    ).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      arguments: [
        '/d',
        '/s',
        '/c',
        'call "C:\\Program Files\\TaskWraith\\resources\\bin\\tw.cmd" "--snapshot" "--user-data" "C:\\Users\\Test User\\TaskWraith Data"'
      ]
    })
  })

  it.each(['& whoami', '%PATH%', '!VAR!', 'with"quote', 'line\nbreak', 'a|b', 'a^b'])(
    'rejects shell metacharacters instead of interpolating %s',
    (value) => {
      expect(() => quoteWindowsCmdToken(value)).toThrow('Refusing unsafe')
    }
  )

  it('routes .cmd tools through ComSpec while leaving native commands direct', () => {
    expect(
      resolvePlatformCommandInvocation('npm.cmd', ['run', 'security:sbom'], 'win32', {
        ComSpec: 'C:\\Windows\\System32\\cmd.exe'
      })
    ).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      arguments: ['/d', '/s', '/c', 'call "npm.cmd" "run" "security:sbom"']
    })
    expect(resolvePlatformCommandInvocation('npm', ['run', 'test'], 'linux', {})).toEqual({
      command: 'npm',
      arguments: ['run', 'test']
    })
  })
})
