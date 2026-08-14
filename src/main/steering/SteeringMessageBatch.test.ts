import { describe, expect, it } from 'vitest'
import { appendSteeringMessage } from './SteeringMessageBatch'

describe('appendSteeringMessage', () => {
  it('returns the first message unchanged', () => {
    expect(appendSteeringMessage(null, 'first')).toBe('first')
  })

  it('preserves rapid messages in arrival order with neutral framing', () => {
    const batched = appendSteeringMessage('peer-authored first', 'host-authored second')

    expect(batched).toContain('[TaskWraith: next steering message]')
    expect(batched.indexOf('peer-authored first')).toBeLessThan(
      batched.indexOf('host-authored second')
    )
  })

  it('does not erase pending text when the next message is blank', () => {
    expect(appendSteeringMessage('first', '   ')).toBe('first')
  })
})
