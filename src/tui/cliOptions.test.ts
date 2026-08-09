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
    expect(usage).toContain('Ctrl+R missions')
    expect(usage).toContain('detached replay')
  })
})
