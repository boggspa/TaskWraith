import { describe, expect, it } from 'vitest'

import {
  CHANNEL_AGENT_MAX_POST_BYTES,
  CHANNEL_AGENT_PROTOCOL_VERSION,
  channelAgentPublicKeyFingerprint,
  hashChannelAgentContent,
  signChannelAgentDelegation,
  signChannelAgentDispatchGrant,
  verifyChannelAgentPost
} from '../../shared/collaboration/ChannelAgentProtocol'
import {
  exportRawEd25519PublicKey,
  generateIdentityKeyPair,
  type KeyPair
} from '../../shared/e2ee/keys'
import { resolveEffectiveRunPermissions } from '../EffectiveRunPermissions'
import type { AppSettings } from '../store/types'
import {
  CHANNEL_AGENT_AUTHORITY_STATE_VERSION,
  type ChannelAgentDispatchConsumption
} from './ChannelAgentAuthorityState'
import {
  CHANNEL_AGENT_RUN_AUTHORITY_VERSION,
  type ChannelAgentDispatchPlan,
  type ChannelAgentRunAuthoritySeal
} from './ChannelAgentDispatchAuthority'
import type { ChannelAgentIdentityMaterial } from './ChannelAgentIdentityStore'
import {
  channelAgentPostClientMessageId,
  ChannelAgentDispatchJournalState,
  type ChannelAgentDispatchJournalSnapshot
} from './ChannelAgentDispatchJournalState'
import {
  signChannelAgentTerminalPost,
  type ChannelAgentTerminalPostSignerErrorCode
} from './ChannelAgentTerminalPostSigner'

const CHANNEL_ID = 'channel-terminal-signer-proof'
const CHAT_ID = 'chat-terminal-signer-proof'
const OWNER_ID = 'member-owner'
const HUMAN_ID = 'member-human'
const AGENT_ID = 'member-agent'
const SEAT_ID = 'pooled-agent-terminal-signer-proof'
const GRANT_ID = 'grant-terminal-signer-proof'
const DELEGATION_ID = 'delegation-terminal-signer-proof'
const TRIGGER_ID = 'trigger-terminal-signer-proof'
const WORKSPACE_PATH = '/workspace/channel-terminal-signer'
const WORKSPACE_HASH = 'a'.repeat(64)
const POSTURE_HASH = 'b'.repeat(64)
const NOW = 1_000

const settings = {
  agenticServices: {
    shellCommands: 'ask',
    fileChanges: 'ask',
    mcpTools: 'ask',
    subThreadDelegation: 'ask',
    canvasInteraction: 'ask',
    canvasEval: 'ask',
    networkAccess: 'allow'
  },
  agenticWorkspaceGrants: []
} as Pick<AppSettings, 'agenticServices' | 'agenticWorkspaceGrants'>

interface Fixture {
  readonly ownerKeys: KeyPair
  readonly agentKeys: KeyPair
  readonly identity: ChannelAgentIdentityMaterial
  readonly plan: ChannelAgentDispatchPlan
  readonly snapshot: ChannelAgentDispatchJournalSnapshot
}

function publicKey(keys: KeyPair): string {
  return exportRawEd25519PublicKey(keys.publicKey).toString('base64')
}

function fixture(): Fixture {
  const ownerKeys = generateIdentityKeyPair()
  const agentKeys = generateIdentityKeyPair()
  const agentPublicKeyB64 = publicKey(agentKeys)
  const fingerprint = channelAgentPublicKeyFingerprint(agentPublicKeyB64)
  const delegation = signChannelAgentDelegation(ownerKeys.privateKey, {
    schemaVersion: CHANNEL_AGENT_PROTOCOL_VERSION,
    delegationId: DELEGATION_ID,
    channelId: CHANNEL_ID,
    ownerMemberId: OWNER_ID,
    agentMemberId: AGENT_ID,
    agentSeatId: SEAT_ID,
    agentPublicKeyB64,
    keyGeneration: 1,
    scopes: ['channel.dispatch', 'channel.post'],
    issuedAt: 100,
    notBefore: 100,
    expiresAt: 10_000,
    maxPostBytes: CHANNEL_AGENT_MAX_POST_BYTES
  })
  const dispatchGrant = signChannelAgentDispatchGrant(ownerKeys.privateKey, {
    schemaVersion: CHANNEL_AGENT_PROTOCOL_VERSION,
    grantId: GRANT_ID,
    channelId: CHANNEL_ID,
    ownerMemberId: OWNER_ID,
    agentMemberId: AGENT_ID,
    agentSeatId: SEAT_ID,
    agentPublicKeyB64,
    keyGeneration: 1,
    delegationId: DELEGATION_ID,
    trigger: 'mention',
    allowedMentionerMemberIds: [HUMAN_ID],
    workspaceIdentityHash: WORKSPACE_HASH,
    permissionPostureHash: POSTURE_HASH,
    issuedAt: 100,
    notBefore: 100,
    expiresAt: 10_000,
    maxDispatches: 2
  })
  const effectivePermissions = resolveEffectiveRunPermissions({
    provider: 'codex',
    workspacePath: WORKSPACE_PATH,
    model: 'gpt-5.6-terra',
    settings,
    presetId: 'read_only'
  })
  const plan: ChannelAgentDispatchPlan = {
    channelId: CHANNEL_ID,
    chatId: CHAT_ID,
    ownerMemberId: OWNER_ID,
    triggerMessageId: TRIGGER_ID,
    triggerContentHash: hashChannelAgentContent('Sign this exact terminal answer.'),
    mentionerMemberId: HUMAN_ID,
    target: {
      memberId: AGENT_ID,
      agentSeatId: SEAT_ID,
      keyGeneration: 1,
      displayName: 'Signer Agent',
      source: 'structured_member_id'
    },
    member: {
      channelId: CHANNEL_ID,
      memberId: AGENT_ID,
      kind: 'agent',
      displayName: 'Signer Agent',
      identityPublicKey: agentPublicKeyB64,
      status: 'active',
      agentSeatId: SEAT_ID,
      keyGeneration: 1,
      joinedAt: 10
    },
    seat: {
      agentSeatId: SEAT_ID,
      participantId: 'participant-terminal-signer-proof',
      displayName: 'Signer Agent',
      provider: 'codex',
      role: 'Channel responder',
      instructions: 'Answer only the accepted Channel contribution.',
      configuredPermissionPresetId: 'read_only',
      model: 'gpt-5.6-terra'
    },
    permissionPresetId: 'read_only',
    effectivePermissions,
    workspacePrincipal: { kind: 'workspace', workspaceId: 'workspace-terminal-signer-proof' },
    workspacePath: WORKSPACE_PATH,
    workspaceIdentityHash: WORKSPACE_HASH,
    permissionPostureHash: POSTURE_HASH,
    authorityRevision: 2,
    expectedDispatchOrdinal: 1,
    delegation,
    dispatchGrant,
    consumeInput: {
      grantId: GRANT_ID,
      triggerMessageId: TRIGGER_ID,
      mentionerMemberId: HUMAN_ID,
      workspaceIdentityHash: WORKSPACE_HASH,
      permissionPostureHash: POSTURE_HASH
    },
    wrappedPrompt: 'BEGIN UNTRUSTED CHANNEL CONTRIBUTION\nSign this.\nEND UNTRUSTED'
  }
  const consumption: ChannelAgentDispatchConsumption = {
    schemaVersion: CHANNEL_AGENT_AUTHORITY_STATE_VERSION,
    recordedRevision: 3,
    channelId: CHANNEL_ID,
    grantId: GRANT_ID,
    triggerMessageId: TRIGGER_ID,
    mentionerMemberId: HUMAN_ID,
    workspaceIdentityHash: WORKSPACE_HASH,
    permissionPostureHash: POSTURE_HASH,
    dispatchOrdinal: 1,
    consumedAt: NOW + 1
  }
  const state = ChannelAgentDispatchJournalState.reserve(plan, NOW)
  state.beginConsumption(plan, NOW + 1)
  state.commitConsumption(consumption)
  const seal: ChannelAgentRunAuthoritySeal = {
    schemaVersion: CHANNEL_AGENT_RUN_AUTHORITY_VERSION,
    channelId: CHANNEL_ID,
    chatId: CHAT_ID,
    ownerMemberId: OWNER_ID,
    agentMemberId: AGENT_ID,
    agentSeatId: SEAT_ID,
    keyGeneration: 1,
    delegationId: DELEGATION_ID,
    dispatchGrantId: GRANT_ID,
    triggerMessageId: TRIGGER_ID,
    mentionerMemberId: HUMAN_ID,
    consumptionRevision: 3,
    dispatchOrdinal: 1,
    runId: state.binding().runId,
    provider: 'codex',
    scope: 'workspace',
    workspaceIdentityHash: WORKSPACE_HASH,
    permissionPostureHash: POSTURE_HASH,
    promptHash: 'c'.repeat(64),
    launchPayloadHash: 'd'.repeat(64),
    launchedAt: NOW + 1
  }
  state.beginLaunch(seal)
  state.confirmLaunch(NOW + 2)
  state.recordTerminal({
    status: 'succeeded',
    exitCode: 0,
    content: 'Terminal signer answer.',
    at: NOW + 3
  })
  return {
    ownerKeys,
    agentKeys,
    identity: {
      agentSeatId: SEAT_ID,
      keyGeneration: 1,
      publicKeyB64: agentPublicKeyB64,
      fingerprint,
      privateKey: agentKeys.privateKey,
      publicKey: agentKeys.publicKey,
      createdAt: 100
    },
    plan,
    snapshot: state.snapshot()
  }
}

function expectCode(operation: () => unknown, code: ChannelAgentTerminalPostSignerErrorCode): void {
  try {
    operation()
    throw new Error('Expected ChannelAgentTerminalPostSignerError')
  } catch (error) {
    expect(error).toMatchObject({ code })
  }
}

describe('signChannelAgentTerminalPost', () => {
  it('signs only the strict journal terminal with the deterministic post identity', () => {
    const value = fixture()
    const signed = signChannelAgentTerminalPost({
      snapshot: value.snapshot,
      identity: value.identity,
      at: NOW + 4
    })
    expect(signed.post).toMatchObject({
      channelId: CHANNEL_ID,
      agentMemberId: AGENT_ID,
      agentSeatId: SEAT_ID,
      keyGeneration: 1,
      delegationId: DELEGATION_ID,
      dispatchGrantId: GRANT_ID,
      triggerMessageId: TRIGGER_ID,
      runId: value.snapshot.binding.runId,
      runAuthorityHash: value.snapshot.events.find((event) => event.kind === 'launch.intent')!
        .sealHash,
      clientMessageId: channelAgentPostClientMessageId(value.snapshot.binding.dispatchId),
      content: 'Terminal signer answer.',
      contentHash: hashChannelAgentContent('Terminal signer answer.'),
      createdAt: NOW + 4
    })
    expect(
      verifyChannelAgentPost({
        ownerPublicKey: value.ownerKeys.publicKey,
        delegation: value.plan.delegation,
        post: signed,
        at: NOW + 4
      })
    ).toMatchObject({ ok: true })
    const restored = ChannelAgentDispatchJournalState.restore(value.snapshot)
    expect(() => restored.recordSignedPost(signed)).not.toThrow()
    expect(restored.phase()).toBe('signed')
  })

  it('rejects a different seat, generation, public key, fingerprint, or private key', () => {
    const value = fixture()
    const other = generateIdentityKeyPair()
    const cases: ChannelAgentIdentityMaterial[] = [
      { ...value.identity, agentSeatId: 'pooled-agent-other' },
      { ...value.identity, keyGeneration: 2 },
      { ...value.identity, publicKeyB64: publicKey(other) },
      { ...value.identity, fingerprint: 'e'.repeat(64) },
      { ...value.identity, privateKey: other.privateKey }
    ]
    for (const identity of cases) {
      expectCode(
        () => signChannelAgentTerminalPost({ snapshot: value.snapshot, identity, at: NOW + 4 }),
        'identity_mismatch'
      )
    }
  })

  it('rejects non-terminal, malformed, or rebound journal evidence', () => {
    const value = fixture()
    const reserved = ChannelAgentDispatchJournalState.reserve(value.plan, NOW).snapshot()
    expectCode(
      () =>
        signChannelAgentTerminalPost({
          snapshot: reserved,
          identity: value.identity,
          at: NOW + 4
        }),
      'invalid_input'
    )
    expectCode(
      () =>
        signChannelAgentTerminalPost({
          snapshot: {
            ...value.snapshot,
            binding: { ...value.snapshot.binding, chatId: 'other-chat' }
          },
          identity: value.identity,
          at: NOW + 4
        }),
      'invalid_input'
    )
  })

  it('rejects clock regression and expired delegation authority', () => {
    const value = fixture()
    expectCode(
      () =>
        signChannelAgentTerminalPost({
          snapshot: value.snapshot,
          identity: value.identity,
          at: NOW + 2
        }),
      'authority_expired'
    )
    expectCode(
      () =>
        signChannelAgentTerminalPost({
          snapshot: value.snapshot,
          identity: value.identity,
          at: 10_000
        }),
      'authority_expired'
    )
  })
})
