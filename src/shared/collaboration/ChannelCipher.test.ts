import { randomBytes } from 'crypto'
import { describe, expect, it } from 'vitest'
import { makeChannelEvent, makeChannelRequest } from './ChannelWireProtocol'
import { openChannelFrame, sealChannelMessage } from './ChannelCipher'

const keys = {
  hostToMember: randomBytes(32),
  memberToHost: randomBytes(32)
}

describe('ChannelCipher', () => {
  it('round-trips closed application messages in both directions', () => {
    const request = makeChannelRequest('append', 'channel.log.append', {
      clientMessageId: 'client',
      content: 'hello'
    })
    const requestFrame = sealChannelMessage({
      keys,
      direction: 'memberToHost',
      sessionId: 'session',
      seq: 1,
      message: request
    })
    expect(
      openChannelFrame({
        keys,
        expectedDirection: 'memberToHost',
        frame: requestFrame
      })
    ).toEqual(request)

    const event = makeChannelEvent('channel.log.batch', { records: [], live: true })
    const eventFrame = sealChannelMessage({
      keys,
      direction: 'hostToMember',
      sessionId: 'session',
      seq: 1,
      message: event
    })
    expect(
      openChannelFrame({ keys, expectedDirection: 'hostToMember', frame: eventFrame })
    ).toEqual(event)
  })

  it('rejects direction swaps, tampering, and methods outside P1', () => {
    const frame = sealChannelMessage({
      keys,
      direction: 'memberToHost',
      sessionId: 'session',
      seq: 1,
      message: makeChannelRequest('append', 'channel.log.append', {
        clientMessageId: 'client',
        content: 'hello'
      })
    })
    expect(() => openChannelFrame({ keys, expectedDirection: 'hostToMember', frame })).toThrow(
      'direction mismatch'
    )
    expect(() =>
      openChannelFrame({
        keys,
        expectedDirection: 'memberToHost',
        frame: { ...frame, ct: `${frame.ct.slice(0, -2)}AA` }
      })
    ).toThrow()

    const unknown = sealChannelMessage({
      keys,
      direction: 'memberToHost',
      sessionId: 'session',
      seq: 2,
      message: {
        t: 'channel.req',
        protocol: frame.protocol,
        reqId: 'bad',
        method: 'channel.agent.dispatch',
        params: {}
      } as never
    })
    expect(() =>
      openChannelFrame({ keys, expectedDirection: 'memberToHost', frame: unknown })
    ).toThrow('not allowed')
  })
})
