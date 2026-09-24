import { describe, expect, it } from 'vitest'

import { appendSilentShellCommandNotice } from './SilentShellFailureNotice'

const silentFailure = { stdout: '', stderr: '', timedOut: false, exitCode: 1 }

describe('appendSilentShellCommandNotice', () => {
  it('names the command behind a silent non-zero exit', () => {
    const annotated = appendSilentShellCommandNotice(
      'Exit code: 1',
      'grep -rn needle src/',
      silentFailure
    )
    expect(annotated).toBe('Exit code: 1\n\ncommand: grep -rn needle src/')
  })

  it('tells two silent failures apart, which the bare text cannot', () => {
    const first = appendSilentShellCommandNotice(
      'Exit code: 1',
      'grep -rn alpha src/',
      silentFailure
    )
    const second = appendSilentShellCommandNotice(
      'Exit code: 1',
      'grep -rn beta docs/',
      silentFailure
    )
    expect(first).not.toBe(second)
    // The premise: without the notice they are the same bytes.
    expect(first.startsWith('Exit code: 1')).toBe(true)
    expect(second.startsWith('Exit code: 1')).toBe(true)
  })

  it('leaves a successful command alone', () => {
    const text = 'Exit code: 0\n\nstdout:\nok'
    expect(appendSilentShellCommandNotice(text, 'ls', { ...silentFailure, exitCode: 0 })).toBe(text)
  })

  it('leaves a failure that already printed something alone', () => {
    const text = 'Exit code: 1\n\nstderr:\nboom'
    expect(
      appendSilentShellCommandNotice(text, 'ls /nope', { ...silentFailure, stderr: 'boom' })
    ).toBe(text)
  })

  it('annotates a timeout and a spawn error, which are also silent', () => {
    expect(
      appendSilentShellCommandNotice('Exit code: timeout', 'sleep 99', {
        ...silentFailure,
        exitCode: null,
        timedOut: true
      })
    ).toContain('command: sleep 99')
  })

  it('renders an argv array as one readable line', () => {
    // A matched rule replaces the string command with argv before execution.
    expect(
      appendSilentShellCommandNotice('Exit code: 1', ['/bin/grep', '-rn', 'needle'], silentFailure)
    ).toBe('Exit code: 1\n\ncommand: /bin/grep -rn needle')
  })

  it('adds nothing for a command shape it cannot describe', () => {
    expect(appendSilentShellCommandNotice('Exit code: 1', { cmd: 'ls' }, silentFailure)).toBe(
      'Exit code: 1'
    )
  })

  it('adds nothing when there is no command to name', () => {
    expect(appendSilentShellCommandNotice('Exit code: 1', '   ', silentFailure)).toBe(
      'Exit code: 1'
    )
  })
})
