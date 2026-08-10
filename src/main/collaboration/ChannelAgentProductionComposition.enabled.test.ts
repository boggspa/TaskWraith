import { beforeEach, describe, expect, it, vi } from 'vitest'

const doubles = vi.hoisted(() => ({
  orchestratorOptions: undefined as unknown,
  recoveryOptions: undefined as unknown,
  startExecution: vi.fn(),
  dispatchPlan: vi.fn(),
  disposeExecution: vi.fn(),
  recoverChannel: vi.fn(),
  resolvePlan: vi.fn()
}))

vi.mock('./ChannelAgentProductionOrchestrator', () => ({
  ChannelAgentProductionOrchestrator: class {
    constructor(options: unknown) {
      doubles.orchestratorOptions = options
    }

    start(): unknown {
      return doubles.startExecution()
    }

    dispatchPlan(plan: unknown): Promise<unknown> {
      return doubles.dispatchPlan(plan)
    }

    dispose(): void {
      doubles.disposeExecution()
    }
  }
}))

vi.mock('./ChannelAgentDispatchRecovery', () => ({
  ChannelAgentDispatchRecovery: class {
    constructor(options: unknown) {
      doubles.recoveryOptions = options
    }

    recoverChannel(channelId: string): Promise<unknown> {
      return doubles.recoverChannel(channelId)
    }
  }
}))

vi.mock('./ChannelAgentDispatchAuthority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ChannelAgentDispatchAuthority')>()
  return {
    ...actual,
    resolveChannelAgentDispatchPlan: (...args: unknown[]) => doubles.resolvePlan(...args)
  }
})

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
import type { AppSettings, ChatRecord } from '../store/types'
import {
  CHANNEL_AGENT_AUTHORITY_STATE_VERSION,
  type ChannelAgentAuthoritySnapshot,
  type ChannelAgentDispatchConsumption,
  type ChannelAgentPostAuthorityResult,
  type VerifyChannelAgentPostAuthorityInput
} from './ChannelAgentAuthorityState'
import {
  CHANNEL_AGENT_RUN_AUTHORITY_VERSION,
  type ChannelAgentDispatchPlan,
  type ChannelAgentRunAuthoritySeal
} from './ChannelAgentDispatchAuthority'
import type { ChannelAgentDispatchRecoveryOptions } from './ChannelAgentDispatchRecovery'
import {
  ChannelAgentDispatchJournalState,
  type ChannelAgentDispatchJournalSnapshot
} from './ChannelAgentDispatchJournalState'
import type { ChannelAgentIdentityMaterial } from './ChannelAgentIdentityStore'
import { createChannelAgentProductionComposition } from './ChannelAgentProductionComposition'
import type { ChannelAgentProductionOrchestratorOptions } from './ChannelAgentProductionOrchestrator'
import type { HumanChannelMessage } from './ChannelMessageLog'
import type { Channel, ChannelMember } from './ChannelStore'

const CHANNEL_ID = 'channel-production-composition-enabled-proof'
const CHAT_ID = 'chat-production-composition-enabled-proof'
const OWNER_ID = 'member-owner'
const HUMAN_ID = 'member-human'
const AGENT_ID = 'agent-build'
const SEAT_ID = 'pooled-agent-build'
const GRANT_ID = 'grant-production-composition-enabled-proof'
const DELEGATION_ID = 'delegation-production-composition-enabled-proof'
const TRIGGER_ID = 'message-production-composition-enabled-proof'
const WORKSPACE_PATH = '/workspace/production-composition'
const WORKSPACE_HASH = 'a'.repeat(64)
const POSTURE_HASH = 'b'.repeat(64)
const CONTENT = 'Ask <@agent-build> to inspect this exact durable contribution.'
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
  readonly channel: Channel
  readonly members: readonly ChannelMember[]
  readonly chat: ChatRecord
  readonly record: HumanChannelMessage
  readonly plan: ChannelAgentDispatchPlan
  readonly authorityBefore: ChannelAgentAuthoritySnapshot
  readonly authorityAfter: ChannelAgentAuthoritySnapshot
  readonly consumption: ChannelAgentDispatchConsumption
}

function publicKey(keys: KeyPair): string {
  return exportRawEd25519PublicKey(keys.publicKey).toString('base64')
}

function fixture(): Fixture {
  const ownerKeys = generateIdentityKeyPair()
  const agentKeys = generateIdentityKeyPair()
  const ownerPublicKey = publicKey(ownerKeys)
  const agentPublicKey = publicKey(agentKeys)
  const delegation = signChannelAgentDelegation(ownerKeys.privateKey, {
    schemaVersion: CHANNEL_AGENT_PROTOCOL_VERSION,
    delegationId: DELEGATION_ID,
    channelId: CHANNEL_ID,
    ownerMemberId: OWNER_ID,
    agentMemberId: AGENT_ID,
    agentSeatId: SEAT_ID,
    agentPublicKeyB64: agentPublicKey,
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
    agentPublicKeyB64: agentPublicKey,
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
  const channel: Channel = {
    channelId: CHANNEL_ID,
    chatId: CHAT_ID,
    ownerMemberId: OWNER_ID,
    status: 'active',
    createdAt: 10,
    updatedAt: 10,
    membershipRevision: 3,
    messageCount: 1,
    display: {
      title: 'Production composition proof',
      status: 'active',
      memberCount: 3,
      messageCount: 1
    }
  }
  const members: ChannelMember[] = [
    {
      channelId: CHANNEL_ID,
      memberId: OWNER_ID,
      kind: 'human',
      displayName: 'Host',
      identityPublicKey: ownerPublicKey,
      status: 'active',
      joinedAt: 10
    },
    {
      channelId: CHANNEL_ID,
      memberId: HUMAN_ID,
      kind: 'human',
      displayName: 'Reviewer',
      identityPublicKey: Buffer.alloc(32, 9).toString('base64'),
      status: 'active',
      joinedAt: 20
    },
    {
      channelId: CHANNEL_ID,
      memberId: AGENT_ID,
      kind: 'agent',
      displayName: 'Build Agent',
      identityPublicKey: agentPublicKey,
      status: 'active',
      agentSeatId: SEAT_ID,
      keyGeneration: 1,
      joinedAt: 30
    }
  ]
  const record: HumanChannelMessage = {
    channelId: CHANNEL_ID,
    sequence: 1,
    messageId: TRIGGER_ID,
    authorMemberId: HUMAN_ID,
    clientMessageId: 'client-production-composition-enabled-proof',
    kind: 'human.text',
    content: CONTENT,
    acceptedAt: 900,
    contentHash: hashChannelAgentContent(CONTENT)
  }
  const plan: ChannelAgentDispatchPlan = {
    channelId: CHANNEL_ID,
    chatId: CHAT_ID,
    ownerMemberId: OWNER_ID,
    triggerMessageId: TRIGGER_ID,
    triggerContentHash: record.contentHash,
    mentionerMemberId: HUMAN_ID,
    target: {
      memberId: AGENT_ID,
      agentSeatId: SEAT_ID,
      keyGeneration: 1,
      displayName: 'Build Agent',
      source: 'structured_member_id'
    },
    member: members[2] as Extract<ChannelMember, { kind: 'agent' }>,
    seat: {
      agentSeatId: SEAT_ID,
      participantId: 'participant-production-composition-enabled-proof',
      displayName: 'Build Agent',
      provider: 'codex',
      role: 'Channel responder',
      instructions: 'Answer only the accepted Channel contribution.',
      configuredPermissionPresetId: 'read_only',
      model: 'gpt-5.6-terra'
    },
    permissionPresetId: 'read_only',
    effectivePermissions,
    workspacePrincipal: { kind: 'workspace', workspaceId: 'workspace-proof' },
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
    wrappedPrompt: 'BEGIN UNTRUSTED CHANNEL CONTRIBUTION\nInspect this.\nEND UNTRUSTED'
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
  const authorityBefore: ChannelAgentAuthoritySnapshot = {
    schemaVersion: CHANNEL_AGENT_AUTHORITY_STATE_VERSION,
    channelId: CHANNEL_ID,
    ownerMemberId: OWNER_ID,
    revision: 2,
    delegations: [{ recordedRevision: 1, signedDelegation: delegation }],
    dispatchGrants: [{ recordedRevision: 2, signedDispatchGrant: dispatchGrant }],
    revocations: [],
    consumptions: []
  }
  return {
    ownerKeys,
    agentKeys,
    identity: {
      agentSeatId: SEAT_ID,
      keyGeneration: 1,
      publicKeyB64: agentPublicKey,
      fingerprint: channelAgentPublicKeyFingerprint(agentPublicKey),
      privateKey: agentKeys.privateKey,
      publicKey: agentKeys.publicKey,
      createdAt: 100
    },
    channel,
    members,
    chat: {
      appChatId: CHAT_ID,
      scope: 'workspace',
      workspaceId: 'workspace-proof',
      workspacePath: WORKSPACE_PATH
    } as ChatRecord,
    record,
    plan,
    authorityBefore,
    authorityAfter: {
      ...authorityBefore,
      revision: 3,
      consumptions: [consumption]
    },
    consumption
  }
}

function launchSeal(value: Fixture, state: ChannelAgentDispatchJournalState) {
  return {
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
    consumptionRevision: value.consumption.recordedRevision,
    dispatchOrdinal: value.consumption.dispatchOrdinal,
    runId: state.binding().runId,
    provider: 'codex',
    scope: 'workspace',
    workspaceIdentityHash: WORKSPACE_HASH,
    permissionPostureHash: POSTURE_HASH,
    promptHash: 'c'.repeat(64),
    launchPayloadHash: 'd'.repeat(64),
    launchedAt: NOW + 1
  } satisfies ChannelAgentRunAuthoritySeal
}

function journalSnapshot(
  value: Fixture,
  phase: 'reserved' | 'consuming' | 'terminal'
): ChannelAgentDispatchJournalSnapshot {
  const state = ChannelAgentDispatchJournalState.reserve(value.plan, NOW)
  if (phase === 'reserved') return state.snapshot()
  state.beginConsumption(value.plan, NOW + 1)
  if (phase === 'consuming') return state.snapshot()
  state.commitConsumption(value.consumption)
  state.beginLaunch(launchSeal(value, state))
  state.confirmLaunch(NOW + 2)
  state.recordTerminal({
    status: 'succeeded',
    exitCode: 0,
    content: 'Production composition terminal answer.',
    at: NOW + 3
  })
  return state.snapshot()
}

function harness(value: Fixture) {
  const journal = {
    reserve: vi.fn(),
    listChannel: vi.fn(),
    snapshot: vi.fn(),
    beginConsumption: vi.fn(),
    commitConsumption: vi.fn(),
    beginLaunch: vi.fn(),
    confirmLaunch: vi.fn(),
    recordTerminal: vi.fn(),
    recordSignedPost: vi.fn(),
    recordPosted: vi.fn(),
    abandon: vi.fn(),
    complete: vi.fn()
  }
  const authoritySnapshot = vi.fn(() => value.authorityBefore)
  const verifyPostAuthority = vi.fn<
    (
      channelId: string,
      input: VerifyChannelAgentPostAuthorityInput
    ) => ChannelAgentPostAuthorityResult
  >((_channelId, input) => ({
    kind: 'authorized',
    authorityRevision: value.authorityAfter.revision,
    delegation: value.plan.delegation,
    dispatchGrant: value.plan.dispatchGrant,
    consumption: value.consumption,
    signedPost: input.signedPost as never
  }))
  const loadIdentity = vi.fn<(agentSeatId: string) => ChannelAgentIdentityMaterial | null>(
    () => value.identity
  )
  const getChannel = vi.fn(() => value.channel)
  const listMembers = vi.fn(() => value.members)
  const getMessageById = vi.fn(() => value.record)
  const appendSignedAgentPost = vi.fn()
  const getChat = vi.fn(() => value.chat)
  const resolveWorkspacePrincipal = vi.fn(() => value.plan.workspacePrincipal)
  const getSettings = vi.fn(() => settings)
  const providerAllowed = vi.fn(() => true)
  const audit = vi.fn()
  const subscribeRunEvents = vi.fn()
  const subscribeRunSessions = vi.fn()
  const claimRunAudience = vi.fn()
  const reconcileRun = vi.fn()
  const service = createChannelAgentProductionComposition({
    journal: journal as never,
    authority: {
      consumeDispatch: vi.fn(),
      snapshot: authoritySnapshot,
      verifyPostAuthority
    } as never,
    identities: { load: loadIdentity } as never,
    channels: { getChannel, listMembers } as never,
    messages: { getMessageById } as never,
    runtime: { appendSignedAgentPost } as never,
    getChat,
    resolveWorkspacePrincipal,
    getSettings,
    providerAllowed,
    composeMainOwnedChannelAgentRun: vi.fn(),
    dispatch: vi.fn(),
    audit: { append: audit },
    subscribeRunEvents,
    subscribeRunSessions,
    claimRunAudience,
    reconcileRun,
    now: () => NOW
  })
  return {
    service,
    journal,
    authoritySnapshot,
    verifyPostAuthority,
    loadIdentity,
    getChannel,
    listMembers,
    getMessageById,
    appendSignedAgentPost,
    getChat,
    resolveWorkspacePrincipal,
    getSettings,
    providerAllowed,
    audit,
    subscribeRunEvents,
    subscribeRunSessions,
    claimRunAudience,
    reconcileRun
  }
}

function orchestratorOptions(): ChannelAgentProductionOrchestratorOptions {
  return doubles.orchestratorOptions as ChannelAgentProductionOrchestratorOptions
}

function recoveryOptions(): ChannelAgentDispatchRecoveryOptions {
  return doubles.recoveryOptions as ChannelAgentDispatchRecoveryOptions
}

beforeEach(() => {
  vi.clearAllMocks()
  doubles.orchestratorOptions = undefined
  doubles.recoveryOptions = undefined
  doubles.startExecution.mockReturnValue({ state: 'running' })
  doubles.recoverChannel.mockResolvedValue({
    channelId: CHANNEL_ID,
    items: [],
    completed: 0,
    retained: 0
  })
  doubles.dispatchPlan.mockResolvedValue({
    kind: 'posted',
    channelId: CHANNEL_ID,
    dispatchId: 'dispatch-proof',
    runId: 'run-proof',
    triggerMessageId: TRIGGER_ID,
    agentMemberId: AGENT_ID,
    record: { kind: 'agent.text' },
    deduplicated: false
  })
})

describe('createChannelAgentProductionComposition admitted adapters', () => {
  it('resolves the plan only from canonical main sources and forwards proven ports', async () => {
    const value = fixture()
    doubles.resolvePlan.mockReturnValue({ kind: 'authorized', plan: value.plan })
    const h = harness(value)
    h.service.start([CHANNEL_ID])
    await vi.waitFor(() => expect(doubles.recoverChannel).toHaveBeenCalledWith(CHANNEL_ID))

    await expect(
      h.service.handleDurableAppend({ record: value.record, deduplicated: false })
    ).resolves.toMatchObject({ kind: 'processed', dispatched: 1, posted: 1 })
    expect(doubles.resolvePlan).toHaveBeenCalledWith({
      channel: value.channel,
      trigger: value.record,
      target: value.plan.target,
      members: value.members,
      chat: value.chat,
      workspacePrincipal: value.plan.workspacePrincipal,
      settings,
      providerAllowed: h.providerAllowed,
      authority: value.authorityBefore,
      at: NOW
    })
    expect(doubles.dispatchPlan).toHaveBeenCalledWith(value.plan)
    expect(orchestratorOptions()).toMatchObject({
      subscribeRunEvents: h.subscribeRunEvents,
      subscribeRunSessions: h.subscribeRunSessions,
      claimRunAudience: h.claimRunAudience
    })
    expect(recoveryOptions().reconcileRun).toBe(h.reconcileRun)

    const signedPost = { post: { channelId: CHANNEL_ID } } as never
    h.appendSignedAgentPost.mockResolvedValue({
      record: { kind: 'agent.text' },
      deduplicated: false
    })
    await orchestratorOptions().appendSignedPost({ signedPost, now: NOW + 4 })
    await recoveryOptions().appendSignedPost({ signedPost, now: NOW + 5 })
    expect(h.appendSignedAgentPost.mock.calls).toEqual([
      [{ signedPost, now: NOW + 4 }],
      [{ signedPost, now: NOW + 5 }]
    ])

    await h.service.stop()
    expect(doubles.disposeExecution).toHaveBeenCalledOnce()
  })

  it('accepts only the exact atomic consumption recorded after its journal intent', async () => {
    const value = fixture()
    const h = harness(value)
    const snapshot = journalSnapshot(value, 'consuming')
    h.authoritySnapshot.mockReturnValue(value.authorityAfter)
    expect(await recoveryOptions().inspectConsumption(snapshot)).toEqual({
      kind: 'found',
      consumption: value.consumption
    })

    h.authoritySnapshot.mockReturnValue(value.authorityBefore)
    expect(await recoveryOptions().inspectConsumption(snapshot)).toEqual({
      kind: 'absent'
    })
    h.authoritySnapshot.mockReturnValue({
      ...value.authorityAfter,
      consumptions: [{ ...value.consumption, permissionPostureHash: 'e'.repeat(64) }]
    })
    expect(await recoveryOptions().inspectConsumption(snapshot)).toEqual({
      kind: 'unavailable'
    })
    expect(
      await recoveryOptions().inspectConsumption({
        ...snapshot,
        binding: { ...snapshot.binding, delegationId: 'delegation-rebound' }
      })
    ).toEqual({ kind: 'unavailable' })
  })

  it('loads the exact stable identity, signs the journal terminal, and denies key or time drift', async () => {
    const value = fixture()
    const h = harness(value)
    const snapshot = journalSnapshot(value, 'terminal')
    const result = await recoveryOptions().signTerminalPost({ snapshot, at: NOW + 4 })
    expect(result.kind).toBe('signed')
    if (result.kind !== 'signed') throw new Error('expected signed recovery post')
    expect(result.signedPost.post).toMatchObject({
      channelId: CHANNEL_ID,
      agentMemberId: AGENT_ID,
      agentSeatId: SEAT_ID,
      triggerMessageId: TRIGGER_ID,
      runId: snapshot.binding.runId,
      content: 'Production composition terminal answer.'
    })
    expect(
      verifyChannelAgentPost({
        ownerPublicKey: value.ownerKeys.publicKey,
        delegation: value.plan.delegation,
        post: result.signedPost,
        at: NOW + 4
      })
    ).toMatchObject({ ok: true })
    expect(h.loadIdentity).toHaveBeenCalledWith(SEAT_ID)
    expect(h.verifyPostAuthority).toHaveBeenCalledWith(
      CHANNEL_ID,
      expect.objectContaining({ signedPost: result.signedPost, acceptedAt: NOW + 4 })
    )

    h.loadIdentity.mockReturnValue(null)
    expect(await recoveryOptions().signTerminalPost({ snapshot, at: NOW + 4 })).toEqual({
      kind: 'denied'
    })
    h.loadIdentity.mockImplementation(() => {
      throw new Error('safeStorage path /Users/alice/private')
    })
    expect(await recoveryOptions().signTerminalPost({ snapshot, at: NOW + 4 })).toEqual({
      kind: 'unavailable'
    })
    h.loadIdentity.mockReturnValue(value.identity)
    h.verifyPostAuthority.mockReturnValue({
      kind: 'denied',
      reason: 'authority_revoked'
    })
    expect(await recoveryOptions().signTerminalPost({ snapshot, at: NOW + 4 })).toEqual({
      kind: 'denied'
    })
    h.verifyPostAuthority.mockImplementation((_channelId, input) => ({
      kind: 'authorized',
      authorityRevision: value.authorityAfter.revision,
      delegation: value.plan.delegation,
      dispatchGrant: value.plan.dispatchGrant,
      consumption: value.consumption,
      signedPost: input.signedPost as never
    }))
    expect(await recoveryOptions().signTerminalPost({ snapshot, at: 10_000 })).toEqual({
      kind: 'denied'
    })
  })

  it('retries only the exact durable reserved trigger and rejects rebound planning', async () => {
    const value = fixture()
    doubles.resolvePlan.mockReturnValue({ kind: 'authorized', plan: value.plan })
    const h = harness(value)
    const snapshot = journalSnapshot(value, 'reserved')
    await expect(recoveryOptions().retryReserved(snapshot)).resolves.toEqual({ kind: 'retried' })
    expect(h.getMessageById).toHaveBeenCalledWith(CHANNEL_ID, TRIGGER_ID)
    expect(doubles.dispatchPlan).toHaveBeenCalledWith(value.plan)

    doubles.dispatchPlan.mockClear()
    h.getMessageById.mockReturnValue({ ...value.record, contentHash: 'f'.repeat(64) })
    await expect(recoveryOptions().retryReserved(snapshot)).resolves.toEqual({ kind: 'retained' })
    expect(doubles.dispatchPlan).not.toHaveBeenCalled()

    h.getMessageById.mockReturnValue(value.record)
    doubles.resolvePlan.mockReturnValue({
      kind: 'authorized',
      plan: { ...value.plan, chatId: 'chat-rebound' }
    })
    await expect(recoveryOptions().retryReserved(snapshot)).resolves.toEqual({ kind: 'retained' })
    expect(doubles.dispatchPlan).not.toHaveBeenCalled()
  })
})
