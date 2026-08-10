import { describe, expect, it, vi } from 'vitest'

import {
  CHANNEL_AGENT_MAX_POST_BYTES,
  CHANNEL_AGENT_PROTOCOL_VERSION,
  hashChannelAgentContent,
  signChannelAgentDelegation,
  signChannelAgentDispatchGrant,
  signChannelAgentPost,
  type ChannelAgentPost,
  type SignedChannelAgentPost
} from '../../shared/collaboration/ChannelAgentProtocol'
import { CHANNEL_AGENT_MESSAGE_PROOF_VERSION } from '../../shared/collaboration/ChannelAgentMessageProof'
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
  hashChannelAgentRunAuthoritySeal,
  type ChannelAgentDispatchPlan,
  type ChannelAgentRunAuthoritySeal
} from './ChannelAgentDispatchAuthority'
import { channelAgentDispatchAuditDedupeKey } from './ChannelAgentDispatchCoordinator'
import {
  ChannelAgentDispatchRecovery,
  type ChannelAgentDispatchRecoveryOptions
} from './ChannelAgentDispatchRecovery'
import {
  channelAgentPostClientMessageId,
  ChannelAgentDispatchJournalState,
  type ChannelAgentDispatchJournalPhase,
  type ChannelAgentDispatchJournalSnapshot
} from './ChannelAgentDispatchJournalState'
import type { AgentChannelMessage } from './ChannelMessageLog'

const CHANNEL_ID = 'channel-dispatch-recovery-proof'
const CHAT_ID = 'chat-dispatch-recovery-proof'
const OWNER_ID = 'member-owner'
const HUMAN_ID = 'member-human'
const AGENT_ID = 'member-agent'
const SEAT_ID = 'pooled-agent-dispatch-recovery-proof'
const GRANT_ID = 'grant-dispatch-recovery-proof'
const DELEGATION_ID = 'delegation-dispatch-recovery-proof'
const TRIGGER_ID = 'trigger-dispatch-recovery-proof'
const WORKSPACE_PATH = '/workspace/channel-dispatch-recovery'
const WORKSPACE_HASH = 'a'.repeat(64)
const POSTURE_HASH = 'b'.repeat(64)
const TRIGGER_CONTENT = 'Recover this exact durable Channel contribution.'
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
  readonly plan: ChannelAgentDispatchPlan
  readonly consumption: ChannelAgentDispatchConsumption
}

function publicKey(keys: KeyPair): string {
  return exportRawEd25519PublicKey(keys.publicKey).toString('base64')
}

function fixture(): Fixture {
  const ownerKeys = generateIdentityKeyPair()
  const agentKeys = generateIdentityKeyPair()
  const agentPublicKeyB64 = publicKey(agentKeys)
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
    expiresAt: 20_000,
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
    expiresAt: 20_000,
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
    triggerContentHash: hashChannelAgentContent(TRIGGER_CONTENT),
    mentionerMemberId: HUMAN_ID,
    target: {
      memberId: AGENT_ID,
      agentSeatId: SEAT_ID,
      keyGeneration: 1,
      displayName: 'Recovery Agent',
      source: 'structured_member_id'
    },
    member: {
      channelId: CHANNEL_ID,
      memberId: AGENT_ID,
      kind: 'agent',
      displayName: 'Recovery Agent',
      identityPublicKey: agentPublicKeyB64,
      status: 'active',
      agentSeatId: SEAT_ID,
      keyGeneration: 1,
      joinedAt: 10
    },
    seat: {
      agentSeatId: SEAT_ID,
      participantId: 'participant-dispatch-recovery-proof',
      displayName: 'Recovery Agent',
      provider: 'codex',
      role: 'Channel responder',
      instructions: 'Answer only the accepted Channel contribution.',
      configuredPermissionPresetId: 'read_only',
      model: 'gpt-5.6-terra'
    },
    permissionPresetId: 'read_only',
    effectivePermissions,
    workspacePrincipal: {
      kind: 'workspace',
      workspaceId: 'workspace-dispatch-recovery-proof'
    },
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
    wrappedPrompt:
      'BEGIN UNTRUSTED CHANNEL CONTRIBUTION\nRecover this proof.\nEND UNTRUSTED CHANNEL CONTRIBUTION'
  }
  return {
    ownerKeys,
    agentKeys,
    plan,
    consumption: {
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
  }
}

function launchSeal(
  value: Fixture,
  state: ChannelAgentDispatchJournalState
): ChannelAgentRunAuthoritySeal {
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
    launchedAt: value.consumption.consumedAt
  }
}

function buildState(value: Fixture, phase: ChannelAgentDispatchJournalPhase) {
  const state = ChannelAgentDispatchJournalState.reserve(value.plan, NOW)
  if (phase === 'reserved') return state
  if (phase === 'abandoned') {
    state.abandon('preflight_declined', NOW + 1)
    return state
  }
  state.beginConsumption(value.plan, NOW + 1)
  if (phase === 'consuming') return state
  state.commitConsumption(value.consumption)
  if (phase === 'consumed') return state
  const seal = launchSeal(value, state)
  state.beginLaunch(seal)
  if (phase === 'launching') return state
  state.confirmLaunch(NOW + 2)
  if (phase === 'launched') return state
  state.recordTerminal({
    status: 'succeeded',
    exitCode: 0,
    content: 'Recovered terminal answer.',
    at: NOW + 3
  })
  if (phase === 'terminal') return state
  const signedPost = signForSnapshot(value, state.snapshot(), NOW + 4)
  state.recordSignedPost(signedPost)
  if (phase === 'signed') return state
  state.recordPosted(messageFor(value, signedPost, NOW + 5), false)
  return state
}

function signForSnapshot(
  value: Fixture,
  snapshot: ChannelAgentDispatchJournalSnapshot,
  createdAt: number
): SignedChannelAgentPost {
  const launch = snapshot.events.find((event) => event.kind === 'launch.intent')
  const terminal = snapshot.events.find((event) => event.kind === 'run.terminal')
  if (!launch || !terminal) throw new Error('terminal fixture is incomplete')
  const binding = snapshot.binding
  const post: ChannelAgentPost = {
    schemaVersion: CHANNEL_AGENT_PROTOCOL_VERSION,
    channelId: binding.channelId,
    agentMemberId: binding.agentMemberId,
    agentSeatId: binding.agentSeatId,
    agentPublicKeyB64: publicKey(value.agentKeys),
    keyGeneration: binding.keyGeneration,
    delegationId: binding.delegationId,
    dispatchGrantId: binding.dispatchGrantId,
    triggerMessageId: binding.triggerMessageId,
    runId: binding.runId,
    runAuthorityHash: hashChannelAgentRunAuthoritySeal(launch.seal),
    clientMessageId: channelAgentPostClientMessageId(binding.dispatchId),
    kind: 'agent.text',
    content: terminal.content,
    contentHash: terminal.contentHash,
    createdAt
  }
  return signChannelAgentPost(value.agentKeys.privateKey, post)
}

function messageFor(
  value: Fixture,
  signedPost: SignedChannelAgentPost,
  acceptedAt: number
): AgentChannelMessage {
  return {
    channelId: CHANNEL_ID,
    sequence: 2,
    messageId: 'message-dispatch-recovery-proof',
    authorMemberId: AGENT_ID,
    clientMessageId: signedPost.post.clientMessageId,
    kind: 'agent.text',
    content: signedPost.post.content,
    acceptedAt,
    contentHash: signedPost.post.contentHash,
    agentProof: {
      schemaVersion: CHANNEL_AGENT_MESSAGE_PROOF_VERSION,
      authorityRevision: value.consumption.recordedRevision,
      signedDelegation: value.plan.delegation,
      signedDispatchGrant: value.plan.dispatchGrant,
      consumption: value.consumption,
      signedPost
    }
  }
}

function memoryJournal(initial: ChannelAgentDispatchJournalState, trace: string[]) {
  let state: ChannelAgentDispatchJournalState | null = initial
  const requireState = () => {
    if (!state) throw new Error('journal missing')
    return state
  }
  const journal = {
    listChannel: vi.fn(() => (state ? [state.snapshot()] : [])),
    snapshot: vi.fn(() => state?.snapshot() ?? null),
    commitConsumption: vi.fn(
      (_channelId: string, _dispatchId: string, consumption: ChannelAgentDispatchConsumption) => {
        trace.push('journal.commitConsumption')
        requireState().commitConsumption(consumption)
        return requireState().snapshot()
      }
    ),
    recordTerminal: vi.fn(
      (
        _channelId: string,
        _dispatchId: string,
        input: Parameters<ChannelAgentDispatchJournalState['recordTerminal']>[0]
      ) => {
        trace.push('journal.recordTerminal')
        requireState().recordTerminal(input)
        return requireState().snapshot()
      }
    ),
    recordSignedPost: vi.fn(
      (_channelId: string, _dispatchId: string, signedPost: SignedChannelAgentPost) => {
        trace.push('journal.recordSignedPost')
        requireState().recordSignedPost(signedPost)
        return requireState().snapshot()
      }
    ),
    recordPosted: vi.fn(
      (
        _channelId: string,
        _dispatchId: string,
        record: AgentChannelMessage,
        deduplicated: boolean
      ) => {
        trace.push('journal.recordPosted')
        requireState().recordPosted(record, deduplicated)
        return requireState().snapshot()
      }
    ),
    abandon: vi.fn(
      (
        _channelId: string,
        _dispatchId: string,
        reason: Parameters<ChannelAgentDispatchJournalState['abandon']>[0],
        at: number
      ) => {
        trace.push(`journal.abandon.${reason}`)
        requireState().abandon(reason, at)
        return requireState().snapshot()
      }
    ),
    complete: vi.fn(() => {
      trace.push('journal.complete')
      const phase = requireState().phase()
      if (phase !== 'posted' && phase !== 'abandoned') throw new Error('not terminal')
      state = null
      return true
    })
  } as unknown as ChannelAgentDispatchRecoveryOptions['journal']
  return {
    journal,
    get snapshot() {
      return state?.snapshot() ?? null
    },
    clear() {
      state = null
    }
  }
}

function harness(phase: ChannelAgentDispatchJournalPhase) {
  const value = fixture()
  const trace: string[] = []
  const memory = memoryJournal(buildState(value, phase), trace)
  const retryReserved = vi.fn<ChannelAgentDispatchRecoveryOptions['retryReserved']>(async () => ({
    kind: 'retained'
  }))
  const inspectConsumption = vi.fn<ChannelAgentDispatchRecoveryOptions['inspectConsumption']>(
    async () => ({ kind: 'unavailable' })
  )
  const reconcileRun = vi.fn<ChannelAgentDispatchRecoveryOptions['reconcileRun']>(async () => ({
    kind: 'unavailable'
  }))
  const signTerminalPost = vi.fn<ChannelAgentDispatchRecoveryOptions['signTerminalPost']>(
    async () => ({ kind: 'unavailable' })
  )
  const appendSignedPost = vi.fn<ChannelAgentDispatchRecoveryOptions['appendSignedPost']>(
    async () => {
      throw new Error('secret append path')
    }
  )
  const appendAudit = vi.fn<ChannelAgentDispatchRecoveryOptions['audit']['append']>(() => {
    trace.push('audit.append')
  })
  const now = vi.fn(() => NOW + 10)
  const recovery = new ChannelAgentDispatchRecovery({
    journal: memory.journal,
    retryReserved,
    inspectConsumption,
    reconcileRun,
    signTerminalPost,
    appendSignedPost,
    audit: { append: appendAudit },
    now
  })
  return {
    value,
    trace,
    memory,
    retryReserved,
    inspectConsumption,
    reconcileRun,
    signTerminalPost,
    appendSignedPost,
    appendAudit,
    now,
    recovery
  }
}

describe('ChannelAgentDispatchRecovery', () => {
  it('retries only a pristine reservation and reports exact completion', async () => {
    const h = harness('reserved')
    h.retryReserved.mockImplementation(async () => {
      h.trace.push('reserved.retry')
      h.memory.clear()
      return { kind: 'retried' }
    })

    await expect(h.recovery.recoverChannel(CHANNEL_ID)).resolves.toMatchObject({
      completed: 1,
      retained: 0,
      items: [
        {
          initialDirective: 'retry_before_consumption',
          finalDirective: null,
          disposition: 'completed',
          code: 'completed_reserved_retry'
        }
      ]
    })
    expect(h.trace).toEqual(['reserved.retry'])

    const consumed = harness('consumed')
    await consumed.recovery.recoverChannel(CHANNEL_ID)
    expect(consumed.retryReserved).not.toHaveBeenCalled()
    expect(consumed.reconcileRun).not.toHaveBeenCalled()
    expect(consumed.trace).toContain('journal.abandon.consumed_before_launch_recovery')
    expect(consumed.memory.snapshot).toBeNull()
  })

  it('inspects atomic consumption before abandoning or committing intent', async () => {
    const found = harness('consuming')
    found.inspectConsumption.mockResolvedValue({
      kind: 'found',
      consumption: found.value.consumption
    })
    await expect(found.recovery.recoverChannel(CHANNEL_ID)).resolves.toMatchObject({
      completed: 1,
      items: [{ code: 'completed_abandoned' }]
    })
    expect(found.trace).toEqual([
      'journal.commitConsumption',
      'journal.abandon.consumed_before_launch_recovery',
      'audit.append',
      'journal.complete'
    ])
    expect(found.retryReserved).not.toHaveBeenCalled()

    const absent = harness('consuming')
    absent.inspectConsumption.mockResolvedValue({ kind: 'absent' })
    await absent.recovery.recoverChannel(CHANNEL_ID)
    expect(absent.trace).toContain('journal.abandon.preflight_declined')
    expect(absent.memory.journal.commitConsumption).not.toHaveBeenCalled()

    const unavailable = harness('consuming')
    await expect(unavailable.recovery.recoverChannel(CHANNEL_ID)).resolves.toMatchObject({
      retained: 1,
      items: [
        {
          finalDirective: 'inspect_atomic_consumption',
          code: 'consumption_unavailable'
        }
      ]
    })
    expect(unavailable.memory.snapshot?.events.at(-1)?.kind).toBe('consumption.intent')
  })

  it('never redispatches launching or launched work and retains uncertain runs', async () => {
    const active = harness('launched')
    active.reconcileRun.mockResolvedValue({ kind: 'active' })
    await expect(active.recovery.recoverChannel(CHANNEL_ID)).resolves.toMatchObject({
      retained: 1,
      items: [{ code: 'run_active' }]
    })
    expect(active.retryReserved).not.toHaveBeenCalled()
    expect(active.memory.journal.abandon).not.toHaveBeenCalled()

    const absent = harness('launching')
    absent.reconcileRun.mockResolvedValue({ kind: 'definitively_absent' })
    await absent.recovery.recoverChannel(CHANNEL_ID)
    expect(absent.retryReserved).not.toHaveBeenCalled()
    expect(absent.trace).toContain('journal.abandon.launch_outcome_unknown')
    expect(absent.memory.snapshot).toBeNull()

    const unavailable = harness('launched')
    await expect(unavailable.recovery.recoverChannel(CHANNEL_ID)).resolves.toMatchObject({
      retained: 1,
      items: [{ code: 'run_unavailable' }]
    })
    expect(unavailable.memory.snapshot?.events.at(-1)?.kind).toBe('launch.confirmed')
  })

  it('reconciles exact terminal evidence through signing, append, audit, and cleanup', async () => {
    const h = harness('launched')
    const binding = h.memory.snapshot!.binding
    h.reconcileRun.mockImplementation(async () => {
      h.trace.push('run.reconcile')
      return {
        kind: 'terminal',
        runId: binding.runId,
        provider: 'codex',
        terminal: {
          status: 'succeeded',
          exitCode: 0,
          content: 'Recovered terminal answer.',
          at: NOW + 3
        }
      }
    })
    h.signTerminalPost.mockImplementation(async ({ snapshot, at }) => {
      h.trace.push('post.sign')
      return { kind: 'signed', signedPost: signForSnapshot(h.value, snapshot, at) }
    })
    h.appendSignedPost.mockImplementation(async ({ signedPost, now }) => {
      h.trace.push('post.append')
      return { record: messageFor(h.value, signedPost, now), deduplicated: false }
    })

    await expect(h.recovery.recoverChannel(CHANNEL_ID)).resolves.toMatchObject({
      completed: 1,
      retained: 0,
      items: [{ code: 'completed_posted' }]
    })
    expect(h.trace).toEqual([
      'run.reconcile',
      'journal.recordTerminal',
      'post.sign',
      'journal.recordSignedPost',
      'post.append',
      'journal.recordPosted',
      'audit.append',
      'audit.append',
      'audit.append',
      'journal.complete'
    ])
    expect(h.retryReserved).not.toHaveBeenCalled()
    expect(h.memory.snapshot).toBeNull()
    expect(h.appendAudit.mock.calls.map(([event]) => event.kind)).toEqual([
      'agent.dispatch.started',
      'agent.dispatch.completed',
      'agent.post.committed'
    ])
    expect(h.appendAudit.mock.calls[1][0].dedupeKey).toBe(
      channelAgentDispatchAuditDedupeKey('agent.dispatch.completed', binding.dispatchId)
    )
  })

  it('rejects rebound reconciliation and retains terminal signing outages', async () => {
    const rebound = harness('launched')
    rebound.reconcileRun.mockResolvedValue({
      kind: 'terminal',
      runId: 'other-run',
      provider: 'codex',
      terminal: {
        status: 'succeeded',
        exitCode: 0,
        content: 'Wrong run.',
        at: NOW + 3
      }
    })
    await expect(rebound.recovery.recoverChannel(CHANNEL_ID)).resolves.toMatchObject({
      retained: 1,
      items: [{ code: 'recovery_failed' }]
    })
    expect(rebound.memory.journal.recordTerminal).not.toHaveBeenCalled()

    const unavailable = harness('terminal')
    await expect(unavailable.recovery.recoverChannel(CHANNEL_ID)).resolves.toMatchObject({
      retained: 1,
      items: [{ code: 'signing_unavailable' }]
    })
    expect(unavailable.memory.snapshot?.events.at(-1)?.kind).toBe('run.terminal')
    expect(unavailable.appendSignedPost).not.toHaveBeenCalled()
  })

  it('abandons a permanently denied terminal post without losing its failure audit', async () => {
    const h = harness('terminal')
    h.signTerminalPost.mockResolvedValue({ kind: 'denied' })
    await expect(h.recovery.recoverChannel(CHANNEL_ID)).resolves.toMatchObject({
      completed: 1,
      items: [{ code: 'completed_abandoned' }]
    })
    expect(h.trace).toContain('journal.abandon.post_authority_unavailable')
    expect(h.appendSignedPost).not.toHaveBeenCalled()
    expect(h.appendAudit.mock.calls.map(([event]) => [event.kind, event.code])).toEqual([
      ['agent.dispatch.started', 'codex'],
      ['agent.dispatch.failed', 'post_authority_unavailable']
    ])
  })

  it('retains a signed post across append failure and resumes idempotently', async () => {
    const h = harness('signed')
    await expect(h.recovery.recoverChannel(CHANNEL_ID)).resolves.toMatchObject({
      retained: 1,
      items: [{ finalDirective: 'append_signed_post', code: 'post_append_unavailable' }]
    })
    expect(h.memory.snapshot?.events.at(-1)?.kind).toBe('post.signed')
    expect(h.signTerminalPost).not.toHaveBeenCalled()

    h.appendSignedPost.mockImplementation(async ({ signedPost, now }) => ({
      record: messageFor(h.value, signedPost, now),
      deduplicated: true
    }))
    await expect(h.recovery.recoverChannel(CHANNEL_ID)).resolves.toMatchObject({
      completed: 1,
      items: [{ code: 'completed_posted' }]
    })
    expect(h.appendAudit.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'agent.post.committed',
      code: 'deduplicated'
    })
  })

  it('retains terminal journals until replay-safe audit succeeds', async () => {
    const h = harness('posted')
    h.appendAudit.mockImplementation(() => {
      throw new Error('secret audit path')
    })
    await expect(h.recovery.recoverChannel(CHANNEL_ID)).resolves.toMatchObject({
      retained: 1,
      items: [{ finalDirective: 'complete', code: 'recovery_failed' }]
    })
    expect(h.memory.snapshot?.events.at(-1)?.kind).toBe('post.committed')
    expect(h.memory.journal.complete).not.toHaveBeenCalled()

    h.appendAudit.mockImplementation(() => undefined)
    await expect(h.recovery.recoverChannel(CHANNEL_ID)).resolves.toMatchObject({
      completed: 1,
      items: [{ code: 'completed_posted' }]
    })
    expect(h.memory.snapshot).toBeNull()
  })

  it('serializes per-Channel recovery and redacts dependency failures', async () => {
    const h = harness('reserved')
    let releaseRetry!: () => void
    const barrier = new Promise<void>((resolve) => {
      releaseRetry = resolve
    })
    h.retryReserved.mockImplementation(async () => {
      await barrier
      return { kind: 'retained' }
    })
    const first = h.recovery.recoverChannel(CHANNEL_ID)
    await vi.waitFor(() => expect(h.retryReserved).toHaveBeenCalledOnce())
    await expect(h.recovery.recoverChannel(CHANNEL_ID)).rejects.toMatchObject({ code: 'busy' })
    releaseRetry()
    await expect(first).resolves.toMatchObject({ retained: 1 })

    h.memory.journal.listChannel = vi.fn(() => {
      throw new Error('secret storage /Users/alice/private')
    })
    try {
      await h.recovery.recoverChannel(CHANNEL_ID)
      throw new Error('Expected recovery failure')
    } catch (error) {
      expect(error).toMatchObject({ code: 'storage_unavailable' })
      expect(String((error as Error).message)).not.toContain('secret')
      expect(String((error as Error).message)).not.toContain('/Users/')
    }
  })

  it('fails closed on an invalid clock without mutating consumed work', async () => {
    const h = harness('consumed')
    h.now.mockReturnValue(Number.NaN)
    await expect(h.recovery.recoverChannel(CHANNEL_ID)).resolves.toMatchObject({
      retained: 1,
      items: [{ finalDirective: 'abandon_consumed_without_launch', code: 'recovery_failed' }]
    })
    expect(h.memory.journal.abandon).not.toHaveBeenCalled()
    expect(h.memory.snapshot?.events.at(-1)?.kind).toBe('consumption.committed')
  })
})
