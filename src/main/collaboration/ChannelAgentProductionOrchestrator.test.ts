import { describe, expect, it, vi } from 'vitest'

import {
  CHANNEL_AGENT_MAX_POST_BYTES,
  CHANNEL_AGENT_PROTOCOL_VERSION
} from '../../shared/collaboration/ChannelAgentProtocol'
import { exportRawEd25519PublicKey, generateIdentityKeyPair } from '../../shared/e2ee/keys'
import { resolveEffectiveRunPermissions } from '../EffectiveRunPermissions'
import type { RunEventAudienceLease, RunEventSink } from '../RunEventBus'
import type { RunSessionChangeEvent } from '../RunManager'
import type { AppSettings } from '../store/types'
import type { ChannelAgentDispatchPlan } from './ChannelAgentDispatchAuthority'
import { ChannelAgentDispatchJournalState } from './ChannelAgentDispatchJournalState'
import {
  ChannelAgentProductionOrchestrator,
  type ChannelAgentProductionOrchestratorOptions
} from './ChannelAgentProductionOrchestrator'

const CHANNEL_ID = 'channel-production-orchestrator-proof'
const CHAT_ID = 'chat-production-orchestrator-proof'
const OWNER_ID = 'member-owner'
const HUMAN_ID = 'member-human'
const AGENT_ID = 'member-agent'
const SEAT_ID = 'pooled-agent-production-orchestrator-proof'
const TRIGGER_ID = 'trigger-production-orchestrator-proof'
const GRANT_ID = 'grant-production-orchestrator-proof'
const DELEGATION_ID = 'delegation-production-orchestrator-proof'
const WORKSPACE_PATH = '/workspace/channel-production-orchestrator'
const WORKSPACE_HASH = 'a'.repeat(64)
const POSTURE_HASH = 'b'.repeat(64)
const TRIGGER_HASH = 'c'.repeat(64)
const NOW = 4_000

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

function dispatchPlan(): ChannelAgentDispatchPlan {
  const keys = generateIdentityKeyPair()
  const identityPublicKey = exportRawEd25519PublicKey(keys.publicKey).toString('base64')
  const effectivePermissions = resolveEffectiveRunPermissions({
    provider: 'codex',
    workspacePath: WORKSPACE_PATH,
    model: 'gpt-5.6-terra',
    settings,
    presetId: 'read_only'
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
      participantId: 'participant-production-orchestrator-proof',
      displayName: 'Build Agent',
      provider: 'codex',
      role: 'Channel responder',
      instructions: 'Answer only the accepted Channel contribution.',
      configuredPermissionPresetId: 'read_only',
      model: 'gpt-5.6-terra',
      runtimeProfileId: 'profile-channel-agent',
      reasoningEffort: 'high',
      serviceTier: 'priority'
    },
    permissionPresetId: 'read_only',
    effectivePermissions,
    workspacePrincipal: {
      kind: 'workspace',
      workspaceId: 'workspace-production-orchestrator'
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
      'BEGIN UNTRUSTED CHANNEL CONTRIBUTION\nPlease inspect this proof.\nEND UNTRUSTED CHANNEL CONTRIBUTION'
  }
}

interface HarnessOptions {
  readonly compositionBarrier?: Promise<void>
  readonly sessionSubscriptionFailure?: boolean
  readonly malformedAudienceLease?: boolean
}

function harness(options: HarnessOptions = {}) {
  const trace: string[] = []
  let journalState: ChannelAgentDispatchJournalState | null = null
  let eventSink: RunEventSink | null = null
  let sessionListener: ((event: RunSessionChangeEvent) => void) | null = null
  const unsubscribeEvents = vi.fn(() => trace.push('unsubscribe.events'))
  const unsubscribeSessions = vi.fn(() => trace.push('unsubscribe.sessions'))
  const releaseAudience = vi.fn(() => true)
  const journal = {
    reserve: vi.fn((plan: ChannelAgentDispatchPlan, at: number) => {
      trace.push('journal.reserve')
      if (!journalState) journalState = ChannelAgentDispatchJournalState.reserve(plan, at)
      return { created: true, snapshot: journalState.snapshot() }
    }),
    snapshot: vi.fn(() => journalState?.snapshot() ?? null),
    beginConsumption: vi.fn(),
    commitConsumption: vi.fn(),
    beginLaunch: vi.fn(),
    confirmLaunch: vi.fn(),
    recordTerminal: vi.fn(),
    recordSignedPost: vi.fn(),
    recordPosted: vi.fn(),
    abandon: vi.fn((_channelId: string, _dispatchId: string, reason: never, at: number) => {
      trace.push('journal.abandon')
      journalState!.abandon(reason, at)
      return journalState!.snapshot()
    }),
    complete: vi.fn(() => {
      trace.push('journal.complete')
      if (!journalState || journalState.phase() !== 'abandoned') return false
      journalState = null
      return true
    })
  } as unknown as ChannelAgentProductionOrchestratorOptions['journal']
  const claimRunAudience = vi.fn(
    (runId: string, sinkIds: readonly string[]): RunEventAudienceLease => {
      trace.push('audience.claim')
      return Object.freeze({
        runId: options.malformedAudienceLease ? 'other-run' : runId,
        sinkIds: Object.freeze([...sinkIds]),
        release: releaseAudience
      })
    }
  )
  const composeMainOwnedChannelAgentRun = vi.fn(async () => {
    trace.push('composer.compose')
    await options.compositionBarrier
    throw new Error('secret prompt and provider path')
  })
  const orchestrator = new ChannelAgentProductionOrchestrator({
    journal,
    authority: { consumeDispatch: vi.fn() },
    identities: { load: vi.fn() },
    composeMainOwnedChannelAgentRun,
    dispatch: vi.fn(),
    appendSignedPost: vi.fn(),
    audit: {
      append: vi.fn(() => {
        trace.push('audit.append')
      })
    },
    subscribeRunEvents: vi.fn((sink) => {
      trace.push('subscribe.events')
      eventSink = sink
      return unsubscribeEvents
    }),
    subscribeRunSessions: vi.fn((listener) => {
      trace.push('subscribe.sessions')
      if (options.sessionSubscriptionFailure) throw new Error('secret session path')
      sessionListener = listener
      return unsubscribeSessions
    }),
    claimRunAudience,
    now: () => NOW
  })
  return {
    trace,
    journal,
    orchestrator,
    claimRunAudience,
    composeMainOwnedChannelAgentRun,
    unsubscribeEvents,
    unsubscribeSessions,
    releaseAudience,
    get eventSink() {
      return eventSink
    },
    get sessionListener() {
      return sessionListener
    }
  }
}

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation()
    throw new Error('Expected ChannelAgentProductionOrchestratorError')
  } catch (error) {
    expect(error).toMatchObject({ code })
    expect(String((error as Error).message)).not.toContain('secret')
  }
}

describe('ChannelAgentProductionOrchestrator', () => {
  it('subscribes exact evidence sources and claims the closed run audience before reservation', async () => {
    const h = harness()
    const plan = dispatchPlan()
    const expectedRunId = ChannelAgentDispatchJournalState.reserve(plan, NOW).binding().runId

    expect(h.orchestrator.start()).toEqual({
      state: 'running',
      pendingDispatches: 0,
      pendingTerminalCollections: 0,
      restrictedRunCount: 0
    })
    await expect(h.orchestrator.dispatchPlan(plan)).resolves.toMatchObject({
      kind: 'declined',
      code: 'composition_failed',
      runId: expectedRunId
    })

    expect(h.claimRunAudience).toHaveBeenCalledWith(expectedRunId, ['channel-agent-run-terminal'])
    expect(h.trace.indexOf('audience.claim')).toBeLessThan(h.trace.indexOf('journal.reserve'))
    expect(h.eventSink?.id).toBe('channel-agent-run-terminal')
    expect(() =>
      h.eventSink?.handle({
        channel: 'agent-output',
        provider: 'codex',
        payload: { appRunId: 'unrelated-run', text: 'ignored' },
        publishedAt: new Date(0).toISOString()
      })
    ).not.toThrow()
    expect(() =>
      h.sessionListener?.({
        type: 'updated',
        session: { runId: 'unrelated-run' }
      } as RunSessionChangeEvent)
    ).not.toThrow()
    expect(h.orchestrator.status()).toMatchObject({
      state: 'running',
      restrictedRunCount: 1
    })

    h.orchestrator.dispose()
    expect(h.unsubscribeSessions).toHaveBeenCalledOnce()
    expect(h.unsubscribeEvents).toHaveBeenCalledOnce()
    expect(h.releaseAudience).not.toHaveBeenCalled()
    expect(h.orchestrator.status()).toMatchObject({
      state: 'stopped',
      restrictedRunCount: 1
    })
  })

  it('is start-idempotent and terminal after disposal', async () => {
    const h = harness()
    await expect(h.orchestrator.dispatchPlan(dispatchPlan())).rejects.toMatchObject({
      code: 'not_running'
    })

    h.orchestrator.start()
    h.orchestrator.start()
    expect(h.trace.filter((entry) => entry === 'subscribe.events')).toHaveLength(1)
    expect(h.trace.filter((entry) => entry === 'subscribe.sessions')).toHaveLength(1)
    h.orchestrator.dispose()
    h.orchestrator.dispose()

    expectCode(() => h.orchestrator.start(), 'not_running')
    await expect(h.orchestrator.dispatchPlan(dispatchPlan())).rejects.toMatchObject({
      code: 'not_running'
    })
  })

  it('rolls back a partial evidence subscription and rejects a malformed audience lease', async () => {
    const subscription = harness({ sessionSubscriptionFailure: true })
    expectCode(() => subscription.orchestrator.start(), 'subscription_unavailable')
    expect(subscription.unsubscribeEvents).toHaveBeenCalledOnce()
    expect(subscription.orchestrator.status().state).toBe('idle')

    const audience = harness({ malformedAudienceLease: true })
    audience.orchestrator.start()
    await expect(audience.orchestrator.dispatchPlan(dispatchPlan())).rejects.toMatchObject({
      code: 'audience_unavailable'
    })
    expect(audience.releaseAudience).toHaveBeenCalledOnce()
    expect(audience.journal.reserve).not.toHaveBeenCalled()
    expect(audience.orchestrator.status().restrictedRunCount).toBe(0)
    audience.orchestrator.dispose()
  })

  it('refuses disposal while composition still owns a dispatch', async () => {
    let releaseComposition!: () => void
    const barrier = new Promise<void>((resolve) => {
      releaseComposition = resolve
    })
    const h = harness({ compositionBarrier: barrier })
    h.orchestrator.start()
    const dispatch = h.orchestrator.dispatchPlan(dispatchPlan())
    await vi.waitFor(() => expect(h.orchestrator.status().pendingDispatches).toBe(1))

    expectCode(() => h.orchestrator.dispose(), 'busy')
    expect(h.unsubscribeEvents).not.toHaveBeenCalled()
    releaseComposition()
    await expect(dispatch).resolves.toMatchObject({ kind: 'declined' })

    expect(() => h.orchestrator.dispose()).not.toThrow()
  })
})
