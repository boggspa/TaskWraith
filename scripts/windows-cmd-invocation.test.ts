import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
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
  ) => {
    command: string
    arguments: string[]
    spawnOptions: { windowsVerbatimArguments?: boolean }
  }
  quoteWindowsCmdToken: (value: string, label?: string) => string
  resolvePlatformCommandInvocation: (
    command: string,
    args?: string[],
    platform?: string,
    env?: Record<string, string | undefined>
  ) => {
    command: string
    arguments: string[]
    spawnOptions: { windowsVerbatimArguments?: boolean }
  }
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
      ],
      spawnOptions: { windowsVerbatimArguments: true }
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
      arguments: ['/d', '/s', '/c', 'call "npm.cmd" "run" "security:sbom"'],
      spawnOptions: { windowsVerbatimArguments: true }
    })
    expect(resolvePlatformCommandInvocation('npm', ['run', 'test'], 'linux', {})).toEqual({
      command: 'npm',
      arguments: ['run', 'test'],
      spawnOptions: {}
    })
  })

  it('executes a quoted batch path and argument on Windows', () => {
    if (process.platform !== 'win32') return

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith cmd smoke '))
    const launcher = path.join(root, 'launcher with spaces.cmd')
    try {
      fs.writeFileSync(launcher, '@echo off\r\necho launcher-ok:%~1\r\n')
      const invocation = createWindowsCmdInvocation(launcher, ['value with spaces'])
      const result = spawnSync(invocation.command, invocation.arguments, {
        encoding: 'utf8',
        ...invocation.spawnOptions
      })

      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).toContain('launcher-ok:value with spaces')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
