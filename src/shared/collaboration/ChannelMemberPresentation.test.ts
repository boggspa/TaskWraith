import { describe, expect, it } from 'vitest'
import {
  MAX_CHANNEL_MEMBER_COLOR_INDEX,
  MAX_CHANNEL_MEMBER_SEAT_ORDER,
  channelMemberPublicPresentation,
  copyChannelMemberPresentation,
  isChannelMemberPresentation
} from './ChannelMemberPresentation'

describe('Channel member presentation', () => {
  it('accepts only the closed bounded host presentation shape', () => {
    expect(
      isChannelMemberPresentation(
        {
          seatOrder: MAX_CHANNEL_MEMBER_SEAT_ORDER,
          colorIndex: MAX_CHANNEL_MEMBER_COLOR_INDEX,
          seatDisabled: true
        },
        { allowSeatDisabled: true }
      )
    ).toBe(true)

    for (const value of [
      {},
      { seatOrder: -1 },
      { seatOrder: 1.5 },
      { seatOrder: MAX_CHANNEL_MEMBER_SEAT_ORDER + 1 },
      { seatOrder: undefined },
      { colorIndex: -1 },
      { colorIndex: MAX_CHANNEL_MEMBER_COLOR_INDEX + 1 },
      { colorIndex: undefined },
      { seatDisabled: 'yes' },
      { seatDisabled: undefined },
      { colorIndex: 1, cssColor: 'red' }
    ]) {
      expect(isChannelMemberPresentation(value, { allowSeatDisabled: true })).toBe(false)
    }
  })

  it('copies canonical fields and strips the host-private mute from public projection', () => {
    const presentation = { seatOrder: 3, colorIndex: 5, seatDisabled: true }
    expect(copyChannelMemberPresentation(presentation)).toEqual(presentation)
    expect(channelMemberPublicPresentation(presentation)).toEqual({
      seatOrder: 3,
      colorIndex: 5
    })
    expect(channelMemberPublicPresentation({ seatDisabled: true })).toBeUndefined()
    expect(isChannelMemberPresentation(presentation, { allowSeatDisabled: false })).toBe(false)
  })
})
