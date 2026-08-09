import { describe, expect, it } from 'vitest'
import {
  CHANNEL_WIRE_PROTOCOL,
  makeChannelEvent,
  makeChannelRequest,
  makeChannelResponse,
  parseChannelAdmissionBeginParams,
  parseChannelApplicationMessage,
  parseChannelLogAppendParams,
  parseChannelLogResumeParams,
  parseChannelWireMessage
} from './ChannelWireProtocol'

describe('ChannelWireProtocol', () => {
  it('allows only handshake requests in plaintext relay frames', () => {
    const begin = makeChannelRequest('begin-1', 'channel.admission.begin', {
      channelId: 'channel',
      inviteId: 'invite',
      inviteToken: 'token',
      roomId: 'room',
      displayName: 'Member',
      memberIdentityPubKeyB64: 'identity',
      memberEphemeralPubKeyB64: 'ephemeral',
      memberNonceB64: 'nonce'
    })
    expect(parseChannelWireMessage(JSON.stringify(begin))).toEqual(begin)

    const append = makeChannelRequest('append-1', 'channel.log.append', {
      clientMessageId: 'client-1',
      content: 'hello'
    })
    expect(parseChannelWireMessage(JSON.stringify(append))).toBeNull()
    expect(parseChannelApplicationMessage(append)).toEqual(append)
    expect(
      parseChannelWireMessage(
        JSON.stringify(makeChannelEvent('channel.log.batch', { records: [] }))
      )
    ).toBeNull()
  })

  it('accepts only the exact human append shape', () => {
    expect(parseChannelLogAppendParams({ clientMessageId: 'message-1', content: 'hello' })).toEqual(
      { clientMessageId: 'message-1', content: 'hello' }
    )
    for (const extra of [
      { authorMemberId: 'forged' },
      { memberId: 'forged' },
      { kind: 'agent.text' },
      { agent: true },
      { provider: 'codex' },
      { dispatch: true },
      { unknown: true }
    ]) {
      expect(
        parseChannelLogAppendParams({
          clientMessageId: 'message-1',
          content: 'hello',
          ...extra
        })
      ).toBeNull()
    }
    expect(
      parseChannelLogAppendParams({
        clientMessageId: 'message-1',
        content: 'x'.repeat(8_001)
      })
    ).toBeNull()
  })

  it('bounds and closes replay params', () => {
    expect(parseChannelLogResumeParams({ resumeAfter: 0 })).toEqual({ resumeAfter: 0 })
    expect(parseChannelLogResumeParams({ resumeAfter: 2, maxRecords: 10, maxBytes: 1000 })).toEqual(
      { resumeAfter: 2, maxRecords: 10, maxBytes: 1000 }
    )
    expect(parseChannelLogResumeParams({ resumeAfter: -1 })).toBeNull()
    expect(parseChannelLogResumeParams({ resumeAfter: 0, extra: true })).toBeNull()
  })

  it('strictly validates admission params without echoing authority fields', () => {
    const input = {
      channelId: 'channel',
      inviteId: 'invite',
      inviteToken: 'token',
      roomId: 'room',
      displayName: 'Member',
      memberIdentityPubKeyB64: 'identity',
      memberEphemeralPubKeyB64: 'ephemeral',
      memberNonceB64: 'nonce'
    }
    expect(parseChannelAdmissionBeginParams(input)).toEqual(input)
    expect(parseChannelAdmissionBeginParams({ ...input, providerDispatch: 'now' })).toBeNull()
  })

  it('validates encrypted envelopes and typed bounded responses', () => {
    const encrypted = {
      t: 'channel.enc',
      protocol: CHANNEL_WIRE_PROTOCOL,
      sessionId: 'session',
      direction: 'memberToHost',
      seq: 1,
      nonce: 'nonce',
      ct: 'ciphertext',
      tag: 'tag'
    }
    expect(parseChannelWireMessage(JSON.stringify(encrypted))).toEqual(encrypted)
    expect(parseChannelWireMessage(JSON.stringify({ ...encrypted, seq: 0 }))).toBeNull()
    expect(parseChannelWireMessage(JSON.stringify({ ...encrypted, extra: true }))).toBeNull()

    const response = makeChannelResponse('request', {
      ok: false,
      error: { code: 'revoked', message: 'member revoked' }
    })
    expect(parseChannelWireMessage(JSON.stringify(response))).toEqual(response)
  })
})
