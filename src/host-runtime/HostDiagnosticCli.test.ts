import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  HostDiagnosticCliError,
  HostDiagnosticModeUnavailableError,
  parseHostDiagnosticCli
} from './HostDiagnosticCli'

describe('parseHostDiagnosticCli', () => {
  it('accepts only the explicit diagnostic serve shape', () => {
    expect(
      parseHostDiagnosticCli([
        'serve',
        '--profile',
        '/tmp/taskwraith-diagnostic-profile',
        '--mode',
        'diagnostic',
        '--parent-pid',
        '123'
      ])
    ).toEqual({
      command: 'serve',
      profilePath: '/tmp/taskwraith-diagnostic-profile',
      mode: 'diagnostic',
      parentPid: 123
    })
  })

  it('rejects missing, relative, root, duplicate, and unknown arguments', () => {
    for (const argv of [
      [],
      ['serve', '--profile', '/tmp/profile', '--mode'],
      ['serve', '--profile', 'relative', '--mode', 'diagnostic'],
      ['serve', '--profile', '/', '--mode', 'diagnostic'],
      ['serve', '--profile', '/tmp/a', '--profile', '/tmp/b', '--mode', 'diagnostic'],
      ['serve', '--profile', '/tmp/a', '--mode', 'diagnostic', '--unknown']
    ]) {
      expect(() => parseHostDiagnosticCli(argv)).toThrow(HostDiagnosticCliError)
    }
  })

  it('fails closed for production and read-only modes before profile ownership', () => {
    for (const mode of ['production', 'read-only']) {
      expect(() =>
        parseHostDiagnosticCli(['serve', '--profile', '/tmp/taskwraith-profile', '--mode', mode])
      ).toThrow(HostDiagnosticModeUnavailableError)
    }
  })

  it('requires a safe positive parent pid', () => {
    for (const parentPid of ['0', '-1', '1.5', 'abc', '9007199254740992']) {
      expect(() =>
        parseHostDiagnosticCli([
          'serve',
          '--profile',
          '/tmp/taskwraith-profile',
          '--mode',
          'diagnostic',
          '--parent-pid',
          parentPid
        ])
      ).toThrow(/parent-pid/)
    }
  })

  it('defaults the packaged Host script to production while retaining explicit diagnostic access', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      bin?: Record<string, string>
      scripts?: Record<string, string>
    }

    expect(packageJson.bin?.['taskwraith-host']).toBe('./out/host/host-runtime/cli.js')
    expect(packageJson.scripts?.['host:serve']).toContain('serve --mode production')
    expect(packageJson.scripts?.['host:serve:diagnostic']).toContain('serve --mode diagnostic')
    expect(packageJson.scripts?.typecheck).toContain('typecheck:host')
    expect(packageJson.scripts?.build).toContain('host:build')
  })
})
