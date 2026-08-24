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
    expect(usage).toContain('Ctrl+R missions')
    expect(usage).toContain('detached replay')
  })
})
