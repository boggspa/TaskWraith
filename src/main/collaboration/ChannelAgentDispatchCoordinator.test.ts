import { describe, expect, it, vi } from 'vitest'

import {
  CHANNEL_AGENT_AUTHORITY_STATE_VERSION,
  type ChannelAgentDispatchConsumption
} from './ChannelAgentAuthorityState'
import {
  createChannelAgentRunAuthoritySeal,
  type ChannelAgentDispatchPlan,
  type ChannelAgentRunAuthoritySeal
} from './ChannelAgentDispatchAuthority'
import {
  ChannelAgentDispatchJournalState,
  type ChannelAgentDispatchJournalSnapshot
} from './ChannelAgentDispatchJournalState'
import type { ChannelAgentDispatchReservationResult } from './ChannelAgentDispatchJournalStore'
import type { ChannelAgentIdentityMaterial } from './ChannelAgentIdentityStore'
import type { ChannelAgentRunTerminalEvidence } from './ChannelAgentRunEventCollector'
import type {
  ChannelAgentRunLaunchRegistration,
  ChannelAgentRunLaunchRegistrationInput,
  ChannelAgentRunLaunchStatus
} from './ChannelAgentRunLaunchRegistry'
import { buildChannelAgentTurnPrompt } from './ChannelAgentRunComposer'
import { ChannelAuditLog, type ChannelAuditInput } from './ChannelAuditLog'
import {
  ChannelAgentDispatchCoordinator,
  type ChannelAgentDispatchCoordinatorOptions,
  type ChannelAgentDispatchHooks
} from './ChannelAgentDispatchCoordinator'
import type { AgentChannelMessage, HumanChannelMessage } from './ChannelMessageLog'
import {
  CHANNEL_AGENT_MESSAGE_PROOF_VERSION,
  type ChannelAgentMessageProof
} from '../../shared/collaboration/ChannelAgentMessageProof'
import {
  CHANNEL_AGENT_MAX_POST_BYTES,
  CHANNEL_AGENT_PROTOCOL_VERSION,
  channelAgentPublicKeyFingerprint,
  type SignedChannelAgentPost
} from '../../shared/collaboration/ChannelAgentProtocol'
import {
  exportRawEd25519PublicKey,
  generateIdentityKeyPair,
  type KeyPair
} from '../../shared/e2ee/keys'
import { resolveEffectiveRunPermissions } from '../EffectiveRunPermissions'
import type { AgentRunPayload, RunAdapterInvocationReceipt } from '../run/AgentRunTypes'
import type { AppSettings } from '../store/types'

const CHANNEL_ID = 'channel-dispatch-coordinator-proof'
const CHAT_ID = 'chat-dispatch-coordinator-proof'
const OWNER_ID = 'member-owner'
const HUMAN_ID = 'member-human'
const AGENT_ID = 'member-agent'
const SEAT_ID = 'pooled-agent-dispatch-coordinator-proof'
const TRIGGER_ID = 'trigger-dispatch-coordinator-proof'
const DELEGATION_ID = 'delegation-dispatch-coordinator-proof'
const GRANT_ID = 'grant-dispatch-coordinator-proof'
const WORKSPACE_PATH = '/workspace/channel-dispatch-coordinator'
const WORKSPACE_HASH = 'a'.repeat(64)
const POSTURE_HASH = 'b'.repeat(64)
const TRIGGER_HASH = 'c'.repeat(64)
const RESERVED_AT = 4_000
const LAUNCHED_AT = 4_001
const CONFIRMED_AT = 4_002
const TERMINAL_AT = 4_003
const POSTED_AT = 4_004

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

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function clock(...values: number[]): () => number {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)]
}

function plan(keys: KeyPair, overrides: Partial<ChannelAgentDispatchPlan> = {}) {
  const identityPublicKey = exportRawEd25519PublicKey(keys.publicKey).toString('base64')
  const effectivePermissions = resolveEffectiveRunPermissions({
    provider: 'codex',
    workspacePath: WORKSPACE_PATH,
    model: 'gpt-5.6-terra',
    settings,
    presetId: 'workspace_write'
  })
  return {
    channelId: CHANNEL_ID,
    chatId: CHAT_ID,
    ownerMemberId: OWNER_ID,
    triggerMessageId: TRIGGER_ID,
    triggerContentHash: TRIGGER_HASH,
    mentionerMemberId: HUMAN_ID,
    target: {
      memberId: AGENT_ID,
      agentSeatId: SEAT_ID,
      keyGeneration: 1,
      displayName: 'Build Agent',
      source: 'structured_member_id'
    },
    member: {
      channelId: CHANNEL_ID,
      memberId: AGENT_ID,
      kind: 'agent',
      displayName: 'Build Agent',
      identityPublicKey,
      status: 'active',
      agentSeatId: SEAT_ID,
      keyGeneration: 1,
      joinedAt: 10
    },
    seat: {
      agentSeatId: SEAT_ID,
      participantId: 'participant-dispatch-coordinator-proof',
      displayName: 'Build Agent',
      provider: 'codex',
      role: 'Channel responder',
      instructions: 'Answer only the accepted Channel contribution.',
      configuredPermissionPresetId: 'workspace_write',
      model: 'gpt-5.6-terra',
      runtimeProfileId: 'profile-channel-agent',
      reasoningEffort: 'high',
      serviceTier: 'priority'
    },
    permissionPresetId: 'workspace_write',
    effectivePermissions,
    workspacePrincipal: {
      kind: 'workspace',
      workspaceId: 'workspace-channel-dispatch-coordinator'
    },
    workspacePath: WORKSPACE_PATH,
    workspaceIdentityHash: WORKSPACE_HASH,
    permissionPostureHash: POSTURE_HASH,
    authorityRevision: 2,
    expectedDispatchOrdinal: 1,
    delegation: {
      delegation: {
        schemaVersion: CHANNEL_AGENT_PROTOCOL_VERSION,
        delegationId: DELEGATION_ID,
        channelId: CHANNEL_ID,
        ownerMemberId: OWNER_ID,
        agentMemberId: AGENT_ID,
        agentSeatId: SEAT_ID,
        agentPublicKeyB64: identityPublicKey,
        keyGeneration: 1,
        scopes: ['channel.dispatch', 'channel.post'],
        issuedAt: 100,
        notBefore: 100,
        expiresAt: 20_000,
        maxPostBytes: CHANNEL_AGENT_MAX_POST_BYTES
      },
      ownerSignatureB64: 'owner-delegation-signature'
    },
    dispatchGrant: {
      grant: {
        schemaVersion: CHANNEL_AGENT_PROTOCOL_VERSION,
        grantId: GRANT_ID,
        channelId: CHANNEL_ID,
        ownerMemberId: OWNER_ID,
        agentMemberId: AGENT_ID,
        agentSeatId: SEAT_ID,
        agentPublicKeyB64: identityPublicKey,
        keyGeneration: 1,
        delegationId: DELEGATION_ID,
        trigger: 'mention',
        allowedMentionerMemberIds: [HUMAN_ID],
        workspaceIdentityHash: WORKSPACE_HASH,
        permissionPostureHash: POSTURE_HASH,
        issuedAt: 100,
        notBefore: 100,
        expiresAt: 20_000,
        maxDispatches: 2
      },
      ownerSignatureB64: 'owner-grant-signature'
    },
    consumeInput: {
      grantId: GRANT_ID,
      triggerMessageId: TRIGGER_ID,
      mentionerMemberId: HUMAN_ID,
      workspaceIdentityHash: WORKSPACE_HASH,
      permissionPostureHash: POSTURE_HASH
    },
    wrappedPrompt:
      'BEGIN UNTRUSTED CHANNEL CONTRIBUTION\nPlease inspect this proof.\nEND UNTRUSTED CHANNEL CONTRIBUTION',
    ...overrides
  } satisfies ChannelAgentDispatchPlan
}

function consumption(value: ChannelAgentDispatchPlan): ChannelAgentDispatchConsumption {
  return {
    schemaVersion: CHANNEL_AGENT_AUTHORITY_STATE_VERSION,
    recordedRevision: value.authorityRevision + 1,
    channelId: value.channelId,
    grantId: value.dispatchGrant.grant.grantId,
    triggerMessageId: value.triggerMessageId,
    mentionerMemberId: value.mentionerMemberId,
    workspaceIdentityHash: value.workspaceIdentityHash,
    permissionPostureHash: value.permissionPostureHash,
    dispatchOrdinal: value.expectedDispatchOrdinal,
    consumedAt: LAUNCHED_AT
  }
}

function payload(value: ChannelAgentDispatchPlan): AgentRunPayload {
  const runId = ChannelAgentDispatchJournalState.reserve(value, RESERVED_AT).binding().runId
  return {
    provider: value.seat.provider,
    scope: 'workspace',
    workspace: WORKSPACE_PATH,
    prompt: `TaskWraith runtime preamble.\n\n${buildChannelAgentTurnPrompt(value)}`,
    activeGoal: null,
    appRunId: runId,
    appChatId: value.chatId,
    model: value.seat.model,
    reasoningEffort: value.seat.reasoningEffort ?? null,
    serviceTier: value.seat.serviceTier ?? null,
    claudeReasoningEffort: null,
    claudeFastMode: null,
    kimiThinking: null,
    approvalMode: value.effectivePermissions.approvalMode,
    workflowMode: 'normal',
    imagePaths: [],
    providerSessionId: null,
    externalPathGrants: [],
    sessionTrust: false,
    geminiWorktree: null,
    runtimeProfileId: value.seat.runtimeProfileId,
    geminiAuthProfileId: null,
    taskWraithMcpProfileId: 'taskwraith-core-v1',
    taskWraithMcpAdvertised: true,
    effectivePermissions: clone(value.effectivePermissions),
    effectivePermissionsSignature: 'main-owned-posture-signature'
  }
}

type JournalFailure =
  | 'none'
  | 'record_terminal'
  | 'record_signed'
  | 'record_posted'
  | 'abandon'
  | 'complete'

class MemoryJournal {
  failure: JournalFailure = 'none'
  state: ChannelAgentDispatchJournalState | null = null
  completed: ChannelAgentDispatchJournalSnapshot | null = null

  constructor(private readonly trace: string[]) {}

  reserve(value: ChannelAgentDispatchPlan, at: number): ChannelAgentDispatchReservationResult {
    this.trace.push('journal.reserve')
    if (this.state) return { created: false, snapshot: this.state.snapshot() }
    this.state = ChannelAgentDispatchJournalState.reserve(value, at)
    return { created: true, snapshot: this.state.snapshot() }
  }

  beginConsumption(
    _channelId: string,
    _dispatchId: string,
    value: ChannelAgentDispatchPlan,
    at: number
  ): ChannelAgentDispatchJournalSnapshot {
    this.trace.push('journal.beginConsumption')
    this.requireState().beginConsumption(value, at)
    return this.requireState().snapshot()
  }

  commitConsumption(
    _channelId: string,
    _dispatchId: string,
    spent: ChannelAgentDispatchConsumption
  ): ChannelAgentDispatchJournalSnapshot {
    this.trace.push('journal.commitConsumption')
    this.requireState().commitConsumption(spent)
    return this.requireState().snapshot()
  }

  beginLaunch(
    _channelId: string,
    _dispatchId: string,
    seal: ChannelAgentRunAuthoritySeal
  ): ChannelAgentDispatchJournalSnapshot {
    this.trace.push('journal.beginLaunch')
    this.requireState().beginLaunch(seal)
    return this.requireState().snapshot()
  }

  confirmLaunch(
    _channelId: string,
    _dispatchId: string,
    at: number
  ): ChannelAgentDispatchJournalSnapshot {
    this.trace.push('journal.confirmLaunch')
    this.requireState().confirmLaunch(at)
    return this.requireState().snapshot()
  }

  recordTerminal(
    _channelId: string,
    _dispatchId: string,
    input: Parameters<ChannelAgentDispatchJournalState['recordTerminal']>[0]
  ): ChannelAgentDispatchJournalSnapshot {
    this.trace.push('journal.recordTerminal')
    if (this.failure === 'record_terminal') throw new Error('secret terminal path')
    this.requireState().recordTerminal(input)
    return this.requireState().snapshot()
  }

  recordSignedPost(
    _channelId: string,
    _dispatchId: string,
    signedPost: SignedChannelAgentPost
  ): ChannelAgentDispatchJournalSnapshot {
    this.trace.push('journal.recordSignedPost')
    if (this.failure === 'record_signed') throw new Error('secret signed path')
    this.requireState().recordSignedPost(signedPost)
    return this.requireState().snapshot()
  }

  recordPosted(
    _channelId: string,
    _dispatchId: string,
    record: AgentChannelMessage,
    deduplicated: boolean
  ): ChannelAgentDispatchJournalSnapshot {
    this.trace.push('journal.recordPosted')
    if (this.failure === 'record_posted') throw new Error('secret receipt path')
    this.requireState().recordPosted(record, deduplicated)
    return this.requireState().snapshot()
  }

  abandon(
    _channelId: string,
    _dispatchId: string,
    reason: Parameters<ChannelAgentDispatchJournalState['abandon']>[0],
    at: number
  ): ChannelAgentDispatchJournalSnapshot {
    this.trace.push('journal.abandon')
    if (this.failure === 'abandon') throw new Error('secret abandon path')
    this.requireState().abandon(reason, at)
    return this.requireState().snapshot()
  }

  complete(): boolean {
    this.trace.push('journal.complete')
    if (this.failure === 'complete') throw new Error('secret complete path')
    const state = this.requireState()
    if (state.phase() !== 'posted' && state.phase() !== 'abandoned') return false
    this.completed = state.snapshot()
    this.state = null
    return true
  }

  private requireState(): ChannelAgentDispatchJournalState {
    if (!this.state) throw new Error('journal unavailable')
    return this.state
  }
}

class TestLaunchRegistry {
  mode: 'normal' | 'authorization_failed' | 'consumption_unknown' | 'launch_unknown' = 'normal'
  released: 'none' | 'before' | 'terminal' | 'recovery' = 'none'

  constructor(
    private readonly journal: MemoryJournal,
    private readonly terminalValue: ChannelAgentRunTerminalEvidence,
    private readonly trace: string[]
  ) {}

  register(input: ChannelAgentRunLaunchRegistrationInput): ChannelAgentRunLaunchRegistration {
    this.trace.push('launches.register')
    let status: ChannelAgentRunLaunchStatus = 'registered'
    let seal: ChannelAgentRunAuthoritySeal | null = null
    let resolveTerminal!: (value: ChannelAgentRunTerminalEvidence) => void
    const terminal = new Promise<ChannelAgentRunTerminalEvidence>((resolve) => {
      resolveTerminal = resolve
    })
    const spent = consumption(input.plan)
    const registration: ChannelAgentRunLaunchRegistration = {
      runId: input.expectedPayload.appRunId!,
      terminal,
      authorizeBeforeAdapterRun: (launchPayload) => {
        this.trace.push('launch.authorize')
        if (this.mode === 'authorization_failed') {
          status = 'authorization_failed'
          throw new Error('secret authorization')
        }
        this.journal.beginConsumption(
          input.plan.channelId,
          input.dispatchId,
          input.plan,
          spent.consumedAt
        )
        if (this.mode === 'consumption_unknown') {
          status = 'consumption_unknown'
          throw new Error('secret consumption')
        }
        this.journal.commitConsumption(input.plan.channelId, input.dispatchId, spent)
        seal = createChannelAgentRunAuthoritySeal({
          plan: input.plan,
          consumption: spent,
          expectedPayload: input.expectedPayload,
          launchPayload,
          launchedAt: spent.consumedAt
        })
        if (this.mode === 'launch_unknown') {
          status = 'launch_intent_unknown'
          throw new Error('secret launch')
        }
        this.journal.beginLaunch(input.plan.channelId, input.dispatchId, seal)
        status = 'launching'
        return clone(seal)
      },
      observer: {
        onAdapterInvoked: (receipt: RunAdapterInvocationReceipt) => {
          this.trace.push('launch.observe')
          if (
            !seal ||
            receipt.appRunId !== seal.runId ||
            receipt.provider !== seal.provider ||
            receipt.effectiveWorkspacePath !== WORKSPACE_PATH
          ) {
            status = 'launch_confirmation_unknown'
            return
          }
          this.journal.confirmLaunch(input.plan.channelId, input.dispatchId, CONFIRMED_AT)
          status = 'confirmed'
          resolveTerminal(clone(this.terminalValue))
        }
      },
      status: () => status,
      requireLaunchConfirmed: () => {
        if (status !== 'confirmed' || !seal) throw new Error('launch not confirmed')
        return clone(seal)
      },
      releaseBeforeLaunch: () => {
        this.trace.push('launch.releaseBefore')
        status = 'released'
        this.released = 'before'
      },
      releaseAfterTerminal: () => {
        this.trace.push('launch.releaseTerminal')
        status = 'released'
        this.released = 'terminal'
      },
      releaseForRecovery: () => {
        this.trace.push('launch.releaseRecovery')
        status = 'released'
        this.released = 'recovery'
      }
    }
    return registration
  }
}

class TestAudit {
  readonly log = new ChannelAuditLog()
  failKind: ChannelAuditInput['kind'] | null = null

  constructor(private readonly trace: string[]) {}

  append(input: ChannelAuditInput): void {
    this.trace.push(`audit.${input.kind}`)
    if (input.kind === this.failKind) throw new Error('secret audit path')
    this.log.append(input)
  }
}

interface HarnessOptions {
  dispatchMode?: 'success' | 'preflight_declined' | 'throw_before_receipt' | 'throw_after_receipt'
  terminal?: ChannelAgentRunTerminalEvidence
}

function harness(options: HarnessOptions = {}) {
  const trace: string[] = []
  const keys = generateIdentityKeyPair()
  const value = plan(keys)
  const expectedPayload = payload(value)
  const journal = new MemoryJournal(trace)
  const terminal = options.terminal ?? {
    status: 'succeeded',
    exitCode: 0,
    content: 'Exact terminal reply.',
    observedAt: TERMINAL_AT
  }
  const launches = new TestLaunchRegistry(journal, terminal, trace)
  const audit = new TestAudit(trace)
  const identity: ChannelAgentIdentityMaterial = {
    agentSeatId: SEAT_ID,
    keyGeneration: 1,
    publicKeyB64: value.member.identityPublicKey,
    fingerprint: channelAgentPublicKeyFingerprint(value.member.identityPublicKey),
    createdAt: 10,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey
  }
  const identities = {
    load: vi.fn((_agentSeatId: string): ChannelAgentIdentityMaterial | null => {
      trace.push('identity.load')
      return identity
    })
  }
  const composer = {
    compose: vi.fn(async () => {
      trace.push('composer.compose')
      return clone(expectedPayload)
    })
  }
  let appendedSignedPost: SignedChannelAgentPost | null = null
  let appendFailure = false
  let appendHumanRecord = false
  const appendSignedPost = vi.fn(async ({ signedPost }: { signedPost: SignedChannelAgentPost }) => {
    trace.push('appendSignedPost')
    if (appendFailure) throw new Error('secret append path')
    appendedSignedPost = clone(signedPost)
    if (appendHumanRecord) {
      return {
        record: {
          channelId: CHANNEL_ID,
          sequence: 1,
          messageId: 'human-record',
          authorMemberId: HUMAN_ID,
          clientMessageId: 'human-client-message',
          kind: 'human.text',
          content: 'wrong record',
          acceptedAt: POSTED_AT,
          contentHash: 'd'.repeat(64)
        } satisfies HumanChannelMessage,
        deduplicated: false
      }
    }
    const spent = consumption(value)
    const proof: ChannelAgentMessageProof = {
      schemaVersion: CHANNEL_AGENT_MESSAGE_PROOF_VERSION,
      authorityRevision: spent.recordedRevision,
      signedDelegation: value.delegation,
      signedDispatchGrant: value.dispatchGrant,
      consumption: spent,
      signedPost
    }
    const record: AgentChannelMessage = {
      channelId: CHANNEL_ID,
      sequence: 1,
      messageId: 'agent-message-1',
      authorMemberId: AGENT_ID,
      clientMessageId: signedPost.post.clientMessageId,
      kind: 'agent.text',
      content: signedPost.post.content,
      acceptedAt: signedPost.post.createdAt,
      contentHash: signedPost.post.contentHash,
      agentProof: proof
    }
    return { record, deduplicated: false }
  })
  const dispatch = vi.fn(async (runPayload: AgentRunPayload, hooks: ChannelAgentDispatchHooks) => {
    trace.push('dispatch.enter')
    if (options.dispatchMode === 'preflight_declined') {
      return { dispatched: false, appRunId: runPayload.appRunId! }
    }
    hooks.finalAuthorization.authorizeBeforeAdapterRun(runPayload)
    if (options.dispatchMode === 'throw_before_receipt') {
      throw new Error('secret adapter construction')
    }
    hooks.observer.onAdapterInvoked?.({
      provider: runPayload.provider,
      appRunId: runPayload.appRunId!,
      effectiveWorkspacePath: runPayload.workspace
    })
    if (options.dispatchMode === 'throw_after_receipt') {
      throw new Error('secret adapter failure')
    }
    return { dispatched: true, appRunId: runPayload.appRunId! }
  })
  const coordinatorOptions: ChannelAgentDispatchCoordinatorOptions = {
    journal: journal as never,
    identities,
    composer,
    launches,
    dispatch,
    appendSignedPost,
    audit,
    now: clock(RESERVED_AT, CONFIRMED_AT, POSTED_AT, POSTED_AT)
  }
  const coordinator = new ChannelAgentDispatchCoordinator(coordinatorOptions)
  return {
    trace,
    keys,
    value,
    expectedPayload,
    journal,
    launches,
    audit,
    identities,
    composer,
    dispatch,
    appendSignedPost,
    coordinator,
    get appendedSignedPost() {
      return appendedSignedPost
    },
    set appendFailure(value: boolean) {
      appendFailure = value
    },
    set appendHumanRecord(value: boolean) {
      appendHumanRecord = value
    }
  }
}

describe('ChannelAgentDispatchCoordinator', () => {
  it('commits one exact terminal, signed post, append receipt, audit, and cleanup', async () => {
    const h = harness()

    const result = await h.coordinator.run(h.value)

    expect(result).toMatchObject({
      kind: 'posted',
      channelId: CHANNEL_ID,
      triggerMessageId: TRIGGER_ID,
      agentMemberId: AGENT_ID,
      deduplicated: false,
      record: {
        kind: 'agent.text',
        content: 'Exact terminal reply.'
      }
    })
    expect(h.journal.state).toBeNull()
    expect(
      h.journal.completed && ChannelAgentDispatchJournalState.restore(h.journal.completed).phase()
    ).toBe('posted')
    expect(h.launches.released).toBe('terminal')
    expect(h.coordinator.pendingCount()).toBe(0)
    expect(h.appendedSignedPost?.post).toMatchObject({
      channelId: CHANNEL_ID,
      agentMemberId: AGENT_ID,
      agentSeatId: SEAT_ID,
      keyGeneration: 1,
      dispatchGrantId: GRANT_ID,
      triggerMessageId: TRIGGER_ID,
      kind: 'agent.text',
      content: 'Exact terminal reply.',
      createdAt: POSTED_AT
    })
    expect(h.trace).toEqual([
      'journal.reserve',
      'composer.compose',
      'launches.register',
      'dispatch.enter',
      'launch.authorize',
      'journal.beginConsumption',
      'journal.commitConsumption',
      'journal.beginLaunch',
      'launch.observe',
      'journal.confirmLaunch',
      'audit.agent.dispatch.started',
      'journal.recordTerminal',
      'identity.load',
      'journal.recordSignedPost',
      'appendSignedPost',
      'journal.recordPosted',
      'audit.agent.dispatch.completed',
      'audit.agent.post.committed',
      'journal.complete',
      'launch.releaseTerminal'
    ])
    expect(h.audit.log.list().map((event) => event.kind)).toEqual([
      'agent.post.committed',
      'agent.dispatch.completed',
      'agent.dispatch.started'
    ])
    expect(JSON.stringify(h.audit.log.list())).not.toContain('Exact terminal reply')
    expect(JSON.stringify(h.audit.log.list())).not.toContain(h.expectedPayload.prompt)
  })

  it('posts a bounded failed terminal even when the adapter operation rejects after receipt', async () => {
    const h = harness({
      dispatchMode: 'throw_after_receipt',
      terminal: {
        status: 'failed',
        exitCode: 1,
        content: 'The Channel agent run failed before a complete reply was available.',
        observedAt: TERMINAL_AT
      }
    })

    await expect(h.coordinator.run(h.value)).resolves.toMatchObject({
      kind: 'posted',
      record: {
        content: 'The Channel agent run failed before a complete reply was available.'
      }
    })
    expect(h.appendedSignedPost?.post.content).toContain('failed before a complete reply')
  })

  it('abandons without spending authority when composition or generic preflight declines', async () => {
    const composition = harness()
    composition.composer.compose.mockRejectedValue(new Error('secret composer prompt'))
    await expect(composition.coordinator.run(composition.value)).resolves.toMatchObject({
      kind: 'declined',
      code: 'composition_failed'
    })
    expect(composition.trace).not.toContain('launch.authorize')
    expect(
      composition.journal.completed &&
        ChannelAgentDispatchJournalState.restore(composition.journal.completed).phase()
    ).toBe('abandoned')

    const preflight = harness({ dispatchMode: 'preflight_declined' })
    await expect(preflight.coordinator.run(preflight.value)).resolves.toMatchObject({
      kind: 'declined',
      code: 'preflight_declined'
    })
    expect(preflight.trace).not.toContain('launch.authorize')
    expect(preflight.launches.released).toBe('before')
    expect(preflight.audit.log.list()[0]).toMatchObject({
      kind: 'agent.dispatch.failed',
      code: 'preflight_declined'
    })
  })

  it('never posts or redispatches an ambiguous consumption or launch outcome', async () => {
    for (const mode of ['consumption_unknown', 'launch_unknown'] as const) {
      const h = harness()
      h.launches.mode = mode

      await expect(h.coordinator.run(h.value)).resolves.toMatchObject({
        kind: 'recovery_required',
        stage: mode === 'consumption_unknown' ? 'consumption' : 'launch'
      })
      expect(h.appendSignedPost).not.toHaveBeenCalled()
      expect(h.launches.released).toBe('recovery')
      expect(h.journal.state).not.toBeNull()
    }

    const invokedWithoutReceipt = harness({ dispatchMode: 'throw_before_receipt' })
    await expect(
      invokedWithoutReceipt.coordinator.run(invokedWithoutReceipt.value)
    ).resolves.toMatchObject({
      kind: 'recovery_required',
      stage: 'launch'
    })
    expect(invokedWithoutReceipt.journal.state?.phase()).toBe('launching')
    expect(invokedWithoutReceipt.appendSignedPost).not.toHaveBeenCalled()
  })

  it('requires the exact current seat key and active post window', async () => {
    const missingIdentity = harness()
    missingIdentity.identities.load.mockReturnValue(null)
    await expect(missingIdentity.coordinator.run(missingIdentity.value)).resolves.toMatchObject({
      kind: 'declined',
      code: 'post_authority_unavailable'
    })
    expect(missingIdentity.appendSignedPost).not.toHaveBeenCalled()
    expect(
      missingIdentity.journal.completed &&
        ChannelAgentDispatchJournalState.restore(missingIdentity.journal.completed).phase()
    ).toBe('abandoned')

    const expired = harness()
    expired.value = plan(expired.keys, {
      delegation: {
        ...expired.value.delegation,
        delegation: { ...expired.value.delegation.delegation, expiresAt: POSTED_AT }
      },
      dispatchGrant: {
        ...expired.value.dispatchGrant,
        grant: { ...expired.value.dispatchGrant.grant, expiresAt: POSTED_AT }
      }
    })
    await expect(expired.coordinator.run(expired.value)).resolves.toMatchObject({
      kind: 'declined',
      code: 'post_authority_unavailable'
    })
    expect(expired.appendSignedPost).not.toHaveBeenCalled()
  })

  it('leaves the exact durable phase for recovery at every post-launch crash point', async () => {
    const cases: Array<{
      failure: JournalFailure | 'append' | 'human_receipt' | 'audit'
      stage: string
      phase: string
    }> = [
      { failure: 'record_terminal', stage: 'terminal', phase: 'launched' },
      { failure: 'record_signed', stage: 'signed_post', phase: 'terminal' },
      { failure: 'append', stage: 'post_append', phase: 'signed' },
      { failure: 'human_receipt', stage: 'post_receipt', phase: 'signed' },
      { failure: 'record_posted', stage: 'post_receipt', phase: 'signed' },
      { failure: 'audit', stage: 'audit', phase: 'posted' },
      { failure: 'complete', stage: 'cleanup', phase: 'posted' }
    ]

    for (const value of cases) {
      const h = harness()
      if (value.failure === 'append') h.appendFailure = true
      else if (value.failure === 'human_receipt') h.appendHumanRecord = true
      else if (value.failure === 'audit') h.audit.failKind = 'agent.post.committed'
      else h.journal.failure = value.failure

      await expect(h.coordinator.run(h.value)).resolves.toMatchObject({
        kind: 'recovery_required',
        stage: value.stage
      })
      expect(h.journal.state?.phase()).toBe(value.phase)
      expect(h.launches.released).toBe('recovery')
      expect(h.coordinator.pendingCount()).toBe(0)
    }
  })

  it('returns an existing non-reserved journal to recovery without composition', async () => {
    const h = harness()
    const reserved = h.journal.reserve(h.value, RESERVED_AT)
    h.journal.beginConsumption(
      h.value.channelId,
      reserved.snapshot.binding.dispatchId,
      h.value,
      LAUNCHED_AT
    )

    await expect(h.coordinator.run(h.value)).resolves.toMatchObject({
      kind: 'recovery_required',
      stage: 'existing_journal'
    })
    expect(h.composer.compose).not.toHaveBeenCalled()
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it('collapses concurrent attempts for one deterministic dispatch id', async () => {
    const h = harness()
    let releaseComposition!: () => void
    const compositionPending = new Promise<void>((resolve) => {
      releaseComposition = resolve
    })
    h.composer.compose.mockImplementation(async () => {
      await compositionPending
      return clone(h.expectedPayload)
    })

    const first = h.coordinator.run(h.value)
    await vi.waitFor(() => expect(h.coordinator.pendingCount()).toBe(1))
    await expect(h.coordinator.run(h.value)).resolves.toMatchObject({ kind: 'in_flight' })
    expect(h.dispatch).not.toHaveBeenCalled()

    releaseComposition()
    await expect(first).resolves.toMatchObject({ kind: 'posted' })
    expect(h.dispatch).toHaveBeenCalledOnce()
  })
})
