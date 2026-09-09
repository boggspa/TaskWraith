import { describe, expect, it } from 'vitest'
import { chatMessageOriginFrom, messageOriginLabel } from './messageOrigin'

describe('messageOriginLabel', () => {
  it('names the sending process and its label in place of "You"', () => {
    expect(messageOriginLabel({ channel: 'local-control', pid: 84536, label: 'Claude Code' })).toBe(
      'Sent from PID 84536 / Claude Code'
    )
    expect(messageOriginLabel({ channel: 'local-control', pid: 84536 })).toBe('Sent from PID 84536')
    expect(messageOriginLabel({ channel: 'local-control', label: 'Codex CLI' })).toBe(
      'Sent from Codex CLI'
    )
    expect(messageOriginLabel({ channel: 'local-control' })).toBe(
      'Sent from the local control socket'
    )
  })

  it('is undefined for an ordinary user row and for anything that is not a local-control origin', () => {
    expect(messageOriginLabel(undefined)).toBeUndefined()
    expect(messageOriginLabel(null)).toBeUndefined()
    expect(messageOriginLabel('local-control')).toBeUndefined()
    expect(messageOriginLabel({ channel: 'ios-bridge', pid: 1 })).toBeUndefined()
  })

  it('bounds and normalises what reaches the transcript', () => {
    expect(
      messageOriginLabel({
        channel: 'local-control',
        pid: 7,
        label: `  Claude\n  Code ${'x'.repeat(200)}`
      })
    ).toBe(`Sent from PID 7 / ${`Claude Code ${'x'.repeat(200)}`.slice(0, 80)}`)
    // A pid that is not a positive safe integer is not a pid.
    expect(messageOriginLabel({ channel: 'local-control', pid: -3, label: 'Codex' })).toBe(
      'Sent from Codex'
    )
    expect(messageOriginLabel({ channel: 'local-control', pid: '84536' })).toBe(
      'Sent from the local control socket'
    )
  })
})

describe('chatMessageOriginFrom', () => {
  it('keeps only the known fields, normalised', () => {
    expect(
      chatMessageOriginFrom({
        channel: 'local-control',
        pid: 42,
        label: ' Claude Code ',
        clientVersion: 'claude-steer-0.1',
        token: 'must-not-survive'
      })
    ).toEqual({
      channel: 'local-control',
      pid: 42,
      label: 'Claude Code',
      clientVersion: 'claude-steer-0.1'
    })
    expect(chatMessageOriginFrom({ channel: 'local-control', label: '   ' })).toEqual({
      channel: 'local-control'
    })
  })
})
