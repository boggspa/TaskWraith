import {
  CHANNEL_AGENT_PROTOCOL_VERSION,
  channelAgentPublicKeyFingerprint,
  signChannelAgentPost,
  type SignedChannelAgentPost
} from '../../shared/collaboration/ChannelAgentProtocol'
import type { ChannelAgentIdentityMaterial } from './ChannelAgentIdentityStore'
import {
  channelAgentPostClientMessageId,
  ChannelAgentDispatchJournalState,
  type ChannelAgentDispatchJournalSnapshot
} from './ChannelAgentDispatchJournalState'

export type ChannelAgentTerminalPostSignerErrorCode =
  | 'authority_expired'
  | 'identity_mismatch'
  | 'invalid_input'

export class ChannelAgentTerminalPostSignerError extends Error {
  constructor(
    readonly code: ChannelAgentTerminalPostSignerErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ChannelAgentTerminalPostSignerError'
  }
}

function signerError(
  code: ChannelAgentTerminalPostSignerErrorCode,
  message: string,
  _cause?: unknown
): ChannelAgentTerminalPostSignerError {
  // Key/store failures can contain secret material or local paths.
  return new ChannelAgentTerminalPostSignerError(code, message)
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

/**
 * Produce the sole publishable representation of a terminal Channel agent run.
 * The strict journal is the authority for every principal/run/content field;
 * provider output, a caller plan, and ambient session state are never inputs.
 */
export function signChannelAgentTerminalPost(args: {
  readonly snapshot: ChannelAgentDispatchJournalSnapshot
  readonly identity: ChannelAgentIdentityMaterial
  readonly at: number
}): SignedChannelAgentPost {
  if (!isTimestamp(args?.at)) {
    throw signerError('invalid_input', 'Channel agent terminal post time is invalid')
  }
  let state: ChannelAgentDispatchJournalState
  try {
    state = ChannelAgentDispatchJournalState.restore(args.snapshot)
  } catch (error) {
    throw signerError('invalid_input', 'Channel agent terminal journal is invalid', error)
  }
  if (state.phase() !== 'terminal') {
    throw signerError('invalid_input', 'Channel agent terminal journal is not ready for signing')
  }
  const snapshot = state.snapshot()
  const binding = snapshot.binding
  const launch = snapshot.events.find((event) => event.kind === 'launch.intent')
  const terminal = snapshot.events.find((event) => event.kind === 'run.terminal')
  if (!launch || !terminal) {
    throw signerError('invalid_input', 'Channel agent terminal journal evidence is incomplete')
  }
  let identityFingerprint = ''
  try {
    identityFingerprint = channelAgentPublicKeyFingerprint(args.identity?.publicKeyB64)
  } catch (error) {
    throw signerError('identity_mismatch', 'Channel agent signing identity is invalid', error)
  }
  if (
    args.identity.agentSeatId !== binding.agentSeatId ||
    args.identity.keyGeneration !== binding.keyGeneration ||
    args.identity.fingerprint !== binding.agentPublicKeyFingerprint ||
    identityFingerprint !== binding.agentPublicKeyFingerprint ||
    args.identity.privateKey?.type !== 'private' ||
    args.identity.privateKey?.asymmetricKeyType !== 'ed25519'
  ) {
    throw signerError('identity_mismatch', 'Channel agent signing identity does not match the run')
  }
  if (
    args.at < terminal.at ||
    args.at < binding.delegationNotBefore ||
    args.at >= binding.delegationExpiresAt
  ) {
    throw signerError('authority_expired', 'Channel agent post authority is not current')
  }
  let signedPost: SignedChannelAgentPost
  try {
    signedPost = signChannelAgentPost(args.identity.privateKey, {
      schemaVersion: CHANNEL_AGENT_PROTOCOL_VERSION,
      channelId: binding.channelId,
      agentMemberId: binding.agentMemberId,
      agentSeatId: binding.agentSeatId,
      agentPublicKeyB64: args.identity.publicKeyB64,
      keyGeneration: binding.keyGeneration,
      delegationId: binding.delegationId,
      dispatchGrantId: binding.dispatchGrantId,
      triggerMessageId: binding.triggerMessageId,
      runId: binding.runId,
      runAuthorityHash: launch.sealHash,
      clientMessageId: channelAgentPostClientMessageId(binding.dispatchId),
      kind: 'agent.text',
      content: terminal.content,
      contentHash: terminal.contentHash,
      createdAt: args.at
    })
    // Re-run the journal's complete binding/signature proof before returning.
    state.recordSignedPost(signedPost)
  } catch (error) {
    throw signerError('identity_mismatch', 'Channel agent terminal post could not be signed', error)
  }
  return signedPost
}
