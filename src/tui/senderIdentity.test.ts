import { describe, expect, it } from 'vitest'
import { CHAT_MESSAGE_ORIGIN_TEXT_MAX_CHARS } from '../shared/messageOrigin'
import { resolveSenderIdentity } from './senderIdentity'

describe('resolveSenderIdentity', () => {
  it('names Claude Code from its own environment and reports the agent pid, not the short-lived CLI process', () => {
    expect(resolveSenderIdentity({ CLAUDECODE: '1', CLAUDE_PID: '84536' }, 991)).toEqual({
      pid: 84536,
      label: 'Claude Code'
    })
  })

  it('still names Claude Code when the agent pid is absent, falling back to this process', () => {
    expect(resolveSenderIdentity({ CLAUDECODE: '1' }, 991)).toEqual({
      pid: 991,
      label: 'Claude Code'
    })
  })

  it('lets an explicit label beat both detection and the environment override', () => {
    expect(
      resolveSenderIdentity({ CLAUDECODE: '1', TW_CLIENT_LABEL: 'From env' }, 991, 'From flag')
    ).toMatchObject({ label: 'From flag' })
    expect(
      resolveSenderIdentity({ CLAUDECODE: '1', TW_CLIENT_LABEL: 'From env' }, 991)
    ).toMatchObject({ label: 'From env' })
  })

  it('reports no label for an unrecognised runtime rather than guessing one', () => {
    expect(resolveSenderIdentity({ TERM_PROGRAM: 'iTerm.app' }, 991)).toEqual({ pid: 991 })
  })

  it('bounds an oversized label instead of letting it reach the transcript', () => {
    const identity = resolveSenderIdentity({}, 991, 'x'.repeat(400))
    expect(identity.label).toHaveLength(CHAT_MESSAGE_ORIGIN_TEXT_MAX_CHARS)
  })

  it('ignores a blank or non-numeric agent pid instead of sending a bogus one', () => {
    expect(resolveSenderIdentity({ CLAUDECODE: '1', CLAUDE_PID: 'not-a-pid' }, 991).pid).toBe(991)
    // parseInt would read a leading number out of this and report pid 12.
    expect(resolveSenderIdentity({ CLAUDECODE: '1', CLAUDE_PID: '12abc' }, 991).pid).toBe(991)
    expect(resolveSenderIdentity({ CLAUDECODE: '1', CLAUDE_PID: '0' }, 991).pid).toBe(991)
    expect(resolveSenderIdentity({ CLAUDECODE: '1', CLAUDE_PID: '  ' }, 991).pid).toBe(991)
    expect(resolveSenderIdentity({ TW_CLIENT_LABEL: '   ' }, 991)).toEqual({ pid: 991 })
  })

  it('lets TW_CLIENT_PID name the owning agent for a runtime with no detector', () => {
    expect(resolveSenderIdentity({ TW_CLIENT_LABEL: 'Codex', TW_CLIENT_PID: '4242' }, 991)).toEqual(
      {
        pid: 4242,
        label: 'Codex'
      }
    )
  })
})
