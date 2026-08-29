import { describe, expect, it } from 'vitest'

import { parseTaskWraithTuiArgs, taskWraithTuiUsage } from './cliOptions'

describe('TaskWraith TUI CLI options', () => {
  it('parses machine JSON, compact export, and detached replay paths', () => {
    expect(parseTaskWraithTuiArgs(['--json', '--thread=thread-1'])).toMatchObject({
      json: true,
      threadId: 'thread-1'
    })
    expect(parseTaskWraithTuiArgs(['--export', './mission.twmission', '--force'])).toMatchObject({
      exportPath: expect.stringMatching(/mission\.twmission$/),
      force: true
    })
    expect(parseTaskWraithTuiArgs(['--replay=./mission.twmission', '--snapshot'])).toMatchObject({
      replayPath: expect.stringMatching(/mission\.twmission$/),
      snapshot: true
    })
  })

  it('defaults to safe Host startup and recognizes profile/opt-out posture', () => {
    expect(parseTaskWraithTuiArgs([])).toMatchObject({
      startHost: true,
      hostLaunchProfile: 'production'
    })
    expect(parseTaskWraithTuiArgs(['--dev', '--no-start-host'])).toMatchObject({
      startHost: false,
      hostLaunchProfile: 'development'
    })
    expect(parseTaskWraithTuiArgs(['--user-data', './private-profile'])).toMatchObject({
      startHost: true,
      hostLaunchProfile: 'custom'
    })
    expect(
      parseTaskWraithTuiArgs(['--user-data', '/tmp/taskwraith-tui-package-smoke-cli'], {
        TASKWRAITH_TUI_PACKAGE_SMOKE: '1'
      })
    ).toMatchObject({
      startHost: true,
      hostLaunchProfile: 'package-smoke'
    })
  })

  it('rejects ambiguous or state-mutating replay combinations', () => {
    expect(() => parseTaskWraithTuiArgs(['--json', '--snapshot'])).toThrow(/different output/)
    expect(() => parseTaskWraithTuiArgs(['--export=a', '--replay=b'])).toThrow(/cannot be combined/)
    expect(() => parseTaskWraithTuiArgs(['--replay=a', '--dev'])).toThrow(/cannot be combined/)
    expect(() => parseTaskWraithTuiArgs(['--force'])).toThrow(/only valid with --export/)
  })

  it('documents mission control, JSON, export, and replay', () => {
    const usage = taskWraithTuiUsage('test')
    expect(usage).toContain('--json')
    expect(usage).toContain('--export <file>')
    expect(usage).toContain('--replay <file>')
    expect(usage).toContain('--no-start-host')
    expect(usage).toContain('standalone Node Host profile')
    expect(usage).toContain('do not launch a Node Host')
    expect(usage).toContain('pure-Node TaskWraith Host')
    expect(usage).toContain('starts that Host when offline')
    expect(usage).not.toContain('sidecar')
    expect(usage).not.toContain('Host v2 socket')
    expect(usage).toContain('Ctrl+R missions')
    expect(usage).toContain('detached replay')
  })
  it('takes a theme from the flag, either spelling, and from the environment', () => {
    expect(parseTaskWraithTuiArgs(['--theme', 'tokyo-night'])).toMatchObject({
      themeName: 'tokyo-night'
    })
    expect(parseTaskWraithTuiArgs(['--theme=rosepine'])).toMatchObject({ themeName: 'rosepine' })
    expect(parseTaskWraithTuiArgs([], { TASKWRAITH_TUI_THEME: 'wraith-day' })).toMatchObject({
      themeName: 'wraith-day'
    })
    // Unspecified is not the same as "no theme": it means the default theme,
    // which is resolved downstream. Carrying `undefined` here keeps the flag
    // and the environment able to disagree without one of them inventing a name.
    expect(parseTaskWraithTuiArgs([]).themeName).toBeUndefined()
  })

  it('advertises the theme flag in the usage text', () => {
    expect(taskWraithTuiUsage('1.0.0')).toContain('--theme')
  })
})
