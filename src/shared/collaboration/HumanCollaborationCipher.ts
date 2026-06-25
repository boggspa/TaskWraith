import { open, seal } from '../e2ee/cipher'
import { b64 } from '../e2ee/keys'
import type { Direction } from '../e2ee/protocol'
import type { HumanCollaborationSessionKeys } from './HumanCollaborationKeySchedule'
import {
  HUMAN_COLLABORATION_EVENTS,
  HUMAN_COLLABORATION_METHODS,
  HUMAN_COLLABORATION_PROTOCOL,
  type HumanCollaborationEncryptedFrame,
  type HumanCollaborationFrameDirection,
  type HumanCollaborationPlainMessage
} from './HumanCollaborationProtocol'

const WIRE_NAMES = new Set<string>([
  ...Object.values(HUMAN_COLLABORATION_METHODS),
  ...Object.values(HUMAN_COLLABORATION_EVENTS)
])

export function sealHumanCollaborationMessage(args: {
  keys: HumanCollaborationSessionKeys
  direction: HumanCollaborationFrameDirection
  sessionId: string
  seq: number
  message: HumanCollaborationPlainMessage
}): HumanCollaborationEncryptedFrame {
  const sealed = seal(
    keyForDirection(args.keys, args.direction),
    cipherDirection(args.direction),
    args.sessionId,
    args.seq,
    Buffer.from(JSON.stringify(args.message), 'utf8')
  )
  return {
    t: 'humanCollaboration.enc',
    protocol: HUMAN_COLLABORATION_PROTOCOL,
    sessionId: args.sessionId,
    direction: args.direction,
    seq: args.seq,
    nonce: b64.encode(sealed.nonce),
    ct: b64.encode(sealed.ct),
    tag: b64.encode(sealed.tag)
  }
}

export function openHumanCollaborationFrame(args: {
  keys: HumanCollaborationSessionKeys
  expectedDirection: HumanCollaborationFrameDirection
  frame: HumanCollaborationEncryptedFrame
}): HumanCollaborationPlainMessage {
  const frame = args.frame
  if (frame.t !== 'humanCollaboration.enc') throw new Error('Invalid collaboration frame.')
  if (frame.protocol !== HUMAN_COLLABORATION_PROTOCOL) {
    throw new Error('Collaboration frame protocol mismatch.')
  }
  if (frame.direction !== args.expectedDirection) {
    throw new Error('Collaboration frame direction mismatch.')
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
  return parsePlainMessage(plaintext)
}

function parsePlainMessage(plaintext: Buffer): HumanCollaborationPlainMessage {
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext.toString('utf8'))
  } catch {
    throw new Error('Collaboration frame payload is not valid JSON.')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Collaboration frame payload is invalid.')
  }
  const candidate = parsed as { msgId?: unknown; method?: unknown; params?: unknown }
  if (
    typeof candidate.msgId !== 'number' ||
    !Number.isInteger(candidate.msgId) ||
    candidate.msgId < 1
  ) {
    throw new Error('Collaboration frame message id is invalid.')
  }
  if (typeof candidate.method !== 'string' || !WIRE_NAMES.has(candidate.method)) {
    throw new Error('Collaboration frame method is not allowed.')
  }
  return {
    msgId: candidate.msgId,
    method: candidate.method as HumanCollaborationPlainMessage['method'],
    ...(candidate.params !== undefined ? { params: candidate.params } : {})
  }
}

function keyForDirection(
  keys: HumanCollaborationSessionKeys,
  direction: HumanCollaborationFrameDirection
): Buffer {
  return direction === 'hostToCollaborator' ? keys.hostToCollaborator : keys.collaboratorToHost
}

function cipherDirection(direction: HumanCollaborationFrameDirection): Direction {
  return direction === 'hostToCollaborator' ? 'mac->iphone' : 'iphone->mac'
}
