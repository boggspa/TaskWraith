import { open, seal } from '../e2ee/cipher'
import { b64 } from '../e2ee/keys'
import type { Direction } from '../e2ee/protocol'
import type { ChannelSessionKeys } from './ChannelKeySchedule'
import {
  CHANNEL_WIRE_PROTOCOL,
  parseChannelApplicationMessage,
  type ChannelApplicationMessage,
  type ChannelEncryptedFrame,
  type ChannelFrameDirection
} from './ChannelWireProtocol'

export function sealChannelMessage(args: {
  keys: ChannelSessionKeys
  direction: ChannelFrameDirection
  sessionId: string
  seq: number
  message: ChannelApplicationMessage
}): ChannelEncryptedFrame {
  const sealed = seal(
    keyForDirection(args.keys, args.direction),
    cipherDirection(args.direction),
    args.sessionId,
    args.seq,
    Buffer.from(JSON.stringify(args.message), 'utf8')
  )
  return {
    t: 'channel.enc',
    protocol: CHANNEL_WIRE_PROTOCOL,
    sessionId: args.sessionId,
    direction: args.direction,
    seq: args.seq,
    nonce: b64.encode(sealed.nonce),
    ct: b64.encode(sealed.ct),
    tag: b64.encode(sealed.tag)
  }
}

export function openChannelFrame(args: {
  keys: ChannelSessionKeys
  expectedDirection: ChannelFrameDirection
  frame: ChannelEncryptedFrame
}): ChannelApplicationMessage {
  const frame = args.frame
  if (frame.t !== 'channel.enc' || frame.protocol !== CHANNEL_WIRE_PROTOCOL) {
    throw new Error('Channel frame protocol mismatch.')
  }
  if (frame.direction !== args.expectedDirection) {
    throw new Error('Channel frame direction mismatch.')
  }
  const plaintext = open(
    keyForDirection(args.keys, args.expectedDirection),
    cipherDirection(args.expectedDirection),
    frame.sessionId,
    frame.seq,
    {
      nonce: b64.decode(frame.nonce),
      ct: b64.decode(frame.ct),
      tag: b64.decode(frame.tag)
    }
  )
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext.toString('utf8'))
  } catch {
    throw new Error('Channel frame payload is not valid JSON.')
  }
  const message = parseChannelApplicationMessage(parsed)
  if (!message) throw new Error('Channel frame payload is not allowed.')
  return message
}

function keyForDirection(keys: ChannelSessionKeys, direction: ChannelFrameDirection): Buffer {
  return direction === 'hostToMember' ? keys.hostToMember : keys.memberToHost
}

function cipherDirection(direction: ChannelFrameDirection): Direction {
  return direction === 'hostToMember' ? 'mac->iphone' : 'iphone->mac'
}
