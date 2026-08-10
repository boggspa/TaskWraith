import { describe, expect, it } from 'vitest'

import {
  CHANNEL_AGENT_AUTHORITY_STATE_VERSION,
  type ChannelAgentDispatchConsumption,
  type ChannelAgentDispatchConsumptionResult,
  type ConsumeChannelAgentDispatchInput
} from './ChannelAgentAuthorityState'
import type {
  ChannelAgentDispatchPlan,
  ChannelAgentRunAuthoritySeal
} from './ChannelAgentDispatchAuthority'
import {
  ChannelAgentDispatchJournalState,
  type ChannelAgentDispatchJournalSnapshot
} from './ChannelAgentDispatchJournalState'
import type {
  ChannelAgentRunCollectionBinding,
  ChannelAgentRunCollectionHandle,
  ChannelAgentRunTerminalEvidence
} from './ChannelAgentRunEventCollector'
import {
  ChannelAgentRunLaunchRegistry,
  ChannelAgentRunLaunchRegistryError
} from './ChannelAgentRunLaunchRegistry'
import { buildChannelAgentTurnPrompt } from './ChannelAgentRunComposer'
import {
  CHANNEL_AGENT_MAX_POST_BYTES,
  CHANNEL_AGENT_PROTOCOL_VERSION
} from '../../shared/collaboration/ChannelAgentProtocol'
import { resolveEffectiveRunPermissions } from '../EffectiveRunPermissions'
import type { AgentRunPayload, RunAdapterInvocationReceipt } from '../run/AgentRunTypes'
import type { AppSettings } from '../store/types'

const CHANNEL_ID = 'channel-launch-registry-proof'
const CHAT_ID = 'chat-launch-registry-proof'
const OWNER_ID = 'member-owner'
const HUMAN_ID = 'member-human'
const AGENT_ID = 'member-agent'
const SEAT_ID = 'pooled-agent-launch-registry-proof'
const TRIGGER_ID = 'trigger-launch-registry-proof'
const DELEGATION_ID = 'delegation-launch-registry-proof'
const GRANT_ID = 'grant-launch-registry-proof'
const WORKSPACE_PATH = '/workspace/channel-launch-registry'
const WORKSPACE_HASH = 'a'.repeat(64)
const POSTURE_HASH = 'b'.repeat(64)
const TRIGGER_HASH = 'c'.repeat(64)
const NOW = 4_000
const CONSUMED_AT = NOW + 1

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

function plan(overrides: Partial<ChannelAgentDispatchPlan> = {}): ChannelAgentDispatchPlan {
  const identityPublicKey = Buffer.alloc(32, 9).toString('base64')
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
      participantId: 'participant-launch-registry-proof',
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
      workspaceId: 'workspace-channel-launch-registry'
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
  }
}

function consumption(
  value: ChannelAgentDispatchPlan,
  at: number,
  overrides: Partial<ChannelAgentDispatchConsumption> = {}
): ChannelAgentDispatchConsumption {
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
    consumedAt: at,
    ...overrides
  }
}

function stateAt(
  value: ChannelAgentDispatchPlan,
  phase: 'reserved' | 'consumed' = 'reserved'
): ChannelAgentDispatchJournalState {
  const state = ChannelAgentDispatchJournalState.reserve(value, NOW)
  if (phase === 'consumed') {
    const spent = consumption(value, CONSUMED_AT)
    state.beginConsumption(value, spent.consumedAt)
    state.commitConsumption(spent)
  }
  return state
}

function payload(
  value: ChannelAgentDispatchPlan,
  state: ChannelAgentDispatchJournalState,
  overrides: Partial<AgentRunPayload> = {}
): AgentRunPayload {
  return {
    provider: value.seat.provider,
    scope: 'workspace',
    workspace: WORKSPACE_PATH,
    prompt: `TaskWraith runtime preamble.\n\n${buildChannelAgentTurnPrompt(value)}`,
    activeGoal: null,
    appRunId: state.binding().runId,
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
    effectivePermissionsSignature: 'main-owned-posture-signature',
    ...overrides
  }
}

type FailureMode = 'none' | 'before' | 'after'

class TestJournal {
  failBeginConsumption: FailureMode = 'none'
  failCommitConsumption: FailureMode = 'none'
  failBeginLaunch: FailureMode = 'none'
  failConfirmLaunch: FailureMode = 'none'
  missing = false
  corruptBeginConsumptionSnapshot = false
  corruptBeginLaunchSnapshot = false

  constructor(
    readonly state: ChannelAgentDispatchJournalState,
    private readonly trace: string[]
  ) {}

  snapshot(channelId: string, dispatchId: string): ChannelAgentDispatchJournalSnapshot | null {
    this.trace.push('journal.snapshot')
    const binding = this.state.binding()
    if (this.missing || channelId !== binding.channelId || dispatchId !== binding.dispatchId) {
      return null
    }
    return this.state.snapshot()
  }

  beginConsumption(
    channelId: string,
    dispatchId: string,
    value: ChannelAgentDispatchPlan,
    at: number
  ): ChannelAgentDispatchJournalSnapshot {
    this.trace.push('journal.beginConsumption')
    this.requireBinding(channelId, dispatchId)
    if (this.failBeginConsumption === 'before') throw new Error('secret consumption intent')
    this.state.beginConsumption(value, at)
    if (this.failBeginConsumption === 'after') throw new Error('secret post-intent rename')
    const snapshot = this.state.snapshot()
    if (!this.corruptBeginConsumptionSnapshot) return snapshot
    const event = snapshot.events.at(-1)
    if (event?.kind !== 'consumption.intent') throw new Error('missing intent')
    return {
      ...snapshot,
      events: [
        ...snapshot.events.slice(0, -1),
        { ...event, authorityRevision: event.authorityRevision + 1 }
      ]
    }
  }

  commitConsumption(
    channelId: string,
    dispatchId: string,
    spent: ChannelAgentDispatchConsumption
  ): ChannelAgentDispatchJournalSnapshot {
    this.trace.push('journal.commitConsumption')
    this.requireBinding(channelId, dispatchId)
    if (this.failCommitConsumption === 'before') throw new Error('secret consumption commit')
    this.state.commitConsumption(spent)
    if (this.failCommitConsumption === 'after') throw new Error('secret post-commit rename')
    return this.state.snapshot()
  }

  beginLaunch(
    channelId: string,
    dispatchId: string,
    seal: ChannelAgentRunAuthoritySeal
  ): ChannelAgentDispatchJournalSnapshot {
    this.trace.push('journal.beginLaunch')
    this.requireBinding(channelId, dispatchId)
    if (this.failBeginLaunch === 'before') throw new Error('secret begin path')
    this.state.beginLaunch(seal)
    if (this.failBeginLaunch === 'after') throw new Error('secret post-launch rename')
    const snapshot = this.state.snapshot()
    if (!this.corruptBeginLaunchSnapshot) return snapshot
    return { ...snapshot, events: snapshot.events.slice(0, -1) }
  }

  confirmLaunch(
    channelId: string,
    dispatchId: string,
    at: number
  ): ChannelAgentDispatchJournalSnapshot {
    this.trace.push('journal.confirmLaunch')
    this.requireBinding(channelId, dispatchId)
    if (this.failConfirmLaunch === 'before') throw new Error('secret confirm path')
    this.state.confirmLaunch(at)
    if (this.failConfirmLaunch === 'after') throw new Error('secret post-confirm path')
    return this.state.snapshot()
  }

  private requireBinding(channelId: string, dispatchId: string): void {
    const binding = this.state.binding()
    if (channelId !== binding.channelId || dispatchId !== binding.dispatchId) {
      throw new Error('wrong journal')
    }
  }
}

class TestAuthority {
  mode: 'authorized' | 'denied' | 'duplicate' | 'throw' = 'authorized'
  consumptionOverrides: Partial<ChannelAgentDispatchConsumption> = {}
  readonly inputs: ConsumeChannelAgentDispatchInput[] = []

  constructor(
    private readonly value: ChannelAgentDispatchPlan,
    private readonly trace: string[]
  ) {}

  consumeDispatch(
    channelId: string,
    input: ConsumeChannelAgentDispatchInput
  ): ChannelAgentDispatchConsumptionResult {
    this.trace.push('authority.consumeDispatch')
    this.inputs.push(clone(input))
    if (channelId !== this.value.channelId) throw new Error('wrong authority root')
    if (this.mode === 'throw') throw new Error('secret authority store')
    const spent = consumption(this.value, input.at, this.consumptionOverrides)
    if (this.mode === 'duplicate') return { kind: 'duplicate', consumption: spent }
    if (this.mode === 'denied') return { kind: 'denied', reason: 'authority_revoked' }
    return {
      kind: 'authorized',
      delegation: clone(this.value.delegation),
      dispatchGrant: clone(this.value.dispatchGrant),
      consumption: spent,
      remainingDispatches: 1
    }
  }
}

class TestCollector {
  readonly bindings: ChannelAgentRunCollectionBinding[] = []
  readonly receipts: Array<{ receipt: RunAdapterInvocationReceipt; at: number }> = []
  failTrack = false
  failConfirm = false
  private active = false
  private resolveTerminal!: (value: ChannelAgentRunTerminalEvidence) => void
  private terminalPromise: Promise<ChannelAgentRunTerminalEvidence> | null = null

  constructor(private readonly trace: string[]) {}

  track(binding: ChannelAgentRunCollectionBinding): ChannelAgentRunCollectionHandle {
    this.trace.push('collector.track')
    if (this.failTrack) throw new Error('secret collector registration')
    if (this.active) throw new Error('already active')
    this.active = true
    this.bindings.push(clone(binding))
    this.terminalPromise = new Promise((resolve) => {
      this.resolveTerminal = resolve
    })
    return {
      terminal: this.terminalPromise,
      stop: () => {
        this.trace.push('collector.stop')
        if (!this.active) return false
        this.active = false
        return true
      }
    }
  }

  confirmAdapterInvocation(receipt: RunAdapterInvocationReceipt, at: number): void {
    this.trace.push('collector.confirmAdapterInvocation')
    if (this.failConfirm) throw new Error('secret collector confirmation')
    this.receipts.push({ receipt: clone(receipt), at })
  }

  settle(value: ChannelAgentRunTerminalEvidence): void {
    if (!this.active || !this.terminalPromise) throw new Error('not active')
    this.active = false
    this.resolveTerminal(clone(value))
  }
}

function harness(options: { phase?: 'reserved' | 'consumed'; now?: () => number } = {}) {
  const trace: string[] = []
  const value = plan()
  const state = stateAt(value, options.phase)
  const expectedPayload = payload(value, state)
  const journal = new TestJournal(state, trace)
  const authority = new TestAuthority(clone(value), trace)
  const collector = new TestCollector(trace)
  const registry = new ChannelAgentRunLaunchRegistry({
    authority,
    journal,
    collector,
    now: options.now ?? clock(CONSUMED_AT, CONSUMED_AT + 1)
  })
  return {
    trace,
    value,
    state,
    expectedPayload,
    journal,
    authority,
    collector,
    registry,
    dispatchId: state.binding().dispatchId
  }
}

function register(h: ReturnType<typeof harness>) {
  return h.registry.register({
    dispatchId: h.dispatchId,
    plan: h.value,
    expectedPayload: h.expectedPayload
  })
}

function receipt(
  h: ReturnType<typeof harness>,
  overrides: Partial<RunAdapterInvocationReceipt> = {}
): RunAdapterInvocationReceipt {
  return {
    provider: 'codex',
    appRunId: h.state.binding().runId,
    effectiveWorkspacePath: WORKSPACE_PATH,
    ...overrides
  }
}

function expectRegistryError(operation: () => unknown, code: string): void {
  try {
    operation()
    throw new Error('Expected ChannelAgentRunLaunchRegistryError')
  } catch (error) {
    expect(error).toBeInstanceOf(ChannelAgentRunLaunchRegistryError)
    expect(error).toMatchObject({ code })
    expect(String((error as Error).message)).not.toContain('secret')
  }
}

describe('ChannelAgentRunLaunchRegistry', () => {
  it('spends authority at the final barrier before writing launch intent', async () => {
    const h = harness()
    const registration = register(h)

    expect(h.collector.bindings).toEqual([
      {
        runId: h.state.binding().runId,
        chatId: CHAT_ID,
        provider: 'codex',
        workspacePath: WORKSPACE_PATH,
        launchIntentAt: NOW,
        maxPostBytes: CHANNEL_AGENT_MAX_POST_BYTES
      }
    ])
    expect(Object.isFrozen(registration.observer)).toBe(true)
    const seal = registration.authorizeBeforeAdapterRun(clone(h.expectedPayload))

    expect(seal.launchedAt).toBe(CONSUMED_AT)
    expect(h.authority.inputs).toEqual([{ ...h.value.consumeInput, at: CONSUMED_AT }])
    expect(h.trace).toEqual([
      'journal.snapshot',
      'collector.track',
      'journal.beginConsumption',
      'authority.consumeDispatch',
      'journal.commitConsumption',
      'journal.beginLaunch'
    ])
    expect(h.state.phase()).toBe('launching')
    expectRegistryError(() => registration.requireLaunchConfirmed(), 'launch_not_confirmed')

    expect(() => registration.observer.onAdapterInvoked?.(receipt(h))).not.toThrow()

    expect(h.trace.slice(-2)).toEqual([
      'journal.confirmLaunch',
      'collector.confirmAdapterInvocation'
    ])
    expect(h.state.phase()).toBe('launched')
    expect(registration.status()).toBe('confirmed')
    expect(registration.requireLaunchConfirmed()).toEqual(seal)

    const terminal: ChannelAgentRunTerminalEvidence = {
      status: 'succeeded',
      exitCode: 0,
      content: 'Exact terminal reply.',
      observedAt: CONSUMED_AT + 2
    }
    h.collector.settle(terminal)
    await expect(registration.terminal).resolves.toEqual(terminal)
    registration.releaseAfterTerminal()
    expect(registration.status()).toBe('released')
    expect(h.registry.pendingCount()).toBe(0)
  })

  it('registers only an exact reserved journal, plan, and expected payload', () => {
    const missing = harness()
    missing.journal.missing = true
    expectRegistryError(() => register(missing), 'invalid_registration')

    const consumed = harness({ phase: 'consumed' })
    expectRegistryError(() => register(consumed), 'invalid_registration')

    const changedPlan = harness()
    changedPlan.value = plan({ triggerMessageId: 'other-trigger' })
    expectRegistryError(() => register(changedPlan), 'invalid_registration')

    const changedPayload = harness()
    changedPayload.expectedPayload = {
      ...changedPayload.expectedPayload,
      appChatId: 'other-chat'
    }
    expectRegistryError(() => register(changedPayload), 'invalid_registration')

    const collectorFailure = harness()
    collectorFailure.collector.failTrack = true
    expectRegistryError(() => register(collectorFailure), 'invalid_registration')
    expect(collectorFailure.registry.pendingCount()).toBe(0)
  })

  it('rechecks expiry and payload drift before any durable consumption write', () => {
    const expired = harness({ now: () => 20_000 })
    const expiredRegistration = register(expired)
    expectRegistryError(
      () => expiredRegistration.authorizeBeforeAdapterRun(expired.expectedPayload),
      'authorization_failed'
    )
    expect(expired.state.phase()).toBe('reserved')
    expect(expired.authority.inputs).toEqual([])
    expiredRegistration.releaseBeforeLaunch()

    const drifts: Array<(value: AgentRunPayload) => void> = [
      (value) => {
        value.prompt += '\nmutated'
      },
      (value) => {
        value.appRunId = 'other-run'
      },
      (value) => {
        value.providerReroute = { from: 'claude', to: 'codex', reason: 'provider-paused' }
      },
      (value) => {
        value.providerSessionId = 'inherited-session'
      },
      (value) => {
        value.effectivePermissions = {
          ...value.effectivePermissions!,
          networkAccess: value.effectivePermissions!.networkAccess === 'allow' ? 'deny' : 'allow'
        }
      }
    ]
    for (const mutate of drifts) {
      const h = harness()
      const registration = register(h)
      const launchPayload = clone(h.expectedPayload)
      mutate(launchPayload)

      expectRegistryError(
        () => registration.authorizeBeforeAdapterRun(launchPayload),
        'authorization_failed'
      )
      expect(h.state.phase()).toBe('reserved')
      expect(h.authority.inputs).toEqual([])
      expectRegistryError(
        () => registration.authorizeBeforeAdapterRun(h.expectedPayload),
        'launch_already_attempted'
      )
      registration.releaseBeforeLaunch()
    }
  })

  it('retains registration copies against caller mutation', () => {
    const h = harness()
    const exactLaunch = clone(h.expectedPayload)
    const registration = register(h)
    ;(h.value.seat as { role: string }).role = 'mutated after registration'
    h.expectedPayload.prompt = 'mutated after registration'

    expect(() => registration.authorizeBeforeAdapterRun(exactLaunch)).not.toThrow()
    registration.observer.onAdapterInvoked?.(receipt(h))
    expect(registration.status()).toBe('confirmed')
  })

  it('never retries an ambiguous consumption-intent write', () => {
    for (const mode of ['before', 'after'] as const) {
      const h = harness()
      h.journal.failBeginConsumption = mode
      const registration = register(h)

      expectRegistryError(
        () => registration.authorizeBeforeAdapterRun(h.expectedPayload),
        'consumption_intent_unknown'
      )
      expect(registration.status()).toBe('consumption_intent_unknown')
      expect(h.state.phase()).toBe(mode === 'before' ? 'reserved' : 'consuming')
      expect(h.authority.inputs).toEqual([])
      expectRegistryError(
        () => registration.authorizeBeforeAdapterRun(h.expectedPayload),
        'launch_already_attempted'
      )
      expectRegistryError(() => registration.releaseBeforeLaunch(), 'release_forbidden')
      registration.releaseForRecovery()
    }

    const malformed = harness()
    malformed.journal.corruptBeginConsumptionSnapshot = true
    const registration = register(malformed)
    expectRegistryError(
      () => registration.authorizeBeforeAdapterRun(malformed.expectedPayload),
      'consumption_intent_unknown'
    )
    expect(malformed.state.phase()).toBe('consuming')
    registration.releaseForRecovery()
  })

  it('stops on denied, duplicate, thrown, or changed durable consumption', () => {
    const cases: Array<{
      mode: TestAuthority['mode']
      code: string
      mutate?: (authority: TestAuthority) => void
    }> = [
      { mode: 'denied', code: 'authorization_failed' },
      { mode: 'duplicate', code: 'consumption_unknown' },
      { mode: 'throw', code: 'consumption_unknown' },
      {
        mode: 'authorized',
        code: 'consumption_unknown',
        mutate: (authority) => {
          authority.consumptionOverrides = { recordedRevision: 99 }
        }
      }
    ]

    for (const value of cases) {
      const h = harness()
      h.authority.mode = value.mode
      value.mutate?.(h.authority)
      const registration = register(h)

      expectRegistryError(
        () => registration.authorizeBeforeAdapterRun(h.expectedPayload),
        value.code
      )
      expect(registration.status()).toBe('consumption_unknown')
      expect(h.state.phase()).toBe('consuming')
      expect(h.trace).not.toContain('journal.commitConsumption')
      expect(h.trace).not.toContain('journal.beginLaunch')
      registration.releaseForRecovery()
    }
  })

  it('preserves consumed evidence when the journal commit is ambiguous', () => {
    for (const mode of ['before', 'after'] as const) {
      const h = harness()
      h.journal.failCommitConsumption = mode
      const registration = register(h)

      expectRegistryError(
        () => registration.authorizeBeforeAdapterRun(h.expectedPayload),
        'consumption_unknown'
      )
      expect(registration.status()).toBe('consumption_unknown')
      expect(h.state.phase()).toBe(mode === 'before' ? 'consuming' : 'consumed')
      expect(h.authority.inputs).toHaveLength(1)
      expect(h.trace).not.toContain('journal.beginLaunch')
      registration.releaseForRecovery()
    }
  })

  it('treats every failed launch-intent outcome as non-retryable', () => {
    for (const mode of ['before', 'after'] as const) {
      const h = harness()
      h.journal.failBeginLaunch = mode
      const registration = register(h)

      expectRegistryError(
        () => registration.authorizeBeforeAdapterRun(h.expectedPayload),
        'launch_intent_unknown'
      )
      expect(registration.status()).toBe('launch_intent_unknown')
      expect(h.state.phase()).toBe(mode === 'before' ? 'consumed' : 'launching')
      expectRegistryError(() => registration.releaseBeforeLaunch(), 'release_forbidden')
      registration.releaseForRecovery()
    }

    const malformed = harness()
    malformed.journal.corruptBeginLaunchSnapshot = true
    const registration = register(malformed)
    expectRegistryError(
      () => registration.authorizeBeforeAdapterRun(malformed.expectedPayload),
      'launch_intent_unknown'
    )
    expect(malformed.state.phase()).toBe('launching')
    registration.releaseForRecovery()
  })

  it('captures mismatched or unprovable receipts without observer throws', () => {
    const receiptFailures: Array<(h: ReturnType<typeof harness>) => void> = [
      (h) => {
        h.journal.failConfirmLaunch = 'before'
      },
      (h) => {
        h.journal.failConfirmLaunch = 'after'
      },
      (h) => {
        h.collector.failConfirm = true
      }
    ]
    for (const configure of receiptFailures) {
      const h = harness()
      configure(h)
      const registration = register(h)
      registration.authorizeBeforeAdapterRun(h.expectedPayload)

      expect(() => registration.observer.onAdapterInvoked?.(receipt(h))).not.toThrow()
      expect(registration.status()).toBe('launch_confirmation_unknown')
      expectRegistryError(
        () => registration.requireLaunchConfirmed(),
        'launch_confirmation_unknown'
      )
      registration.releaseForRecovery()
    }

    const mismatches: Array<Partial<RunAdapterInvocationReceipt>> = [
      { appRunId: 'other-run' },
      { provider: 'claude' },
      { effectiveWorkspacePath: '/workspace/other' }
    ]
    for (const mismatch of mismatches) {
      const h = harness()
      const registration = register(h)
      registration.authorizeBeforeAdapterRun(h.expectedPayload)

      expect(() => registration.observer.onAdapterInvoked?.(receipt(h, mismatch))).not.toThrow()
      expect(registration.status()).toBe('launch_confirmation_unknown')
      expect(h.state.phase()).toBe('launching')
      expect(h.collector.receipts).toEqual([])
      registration.releaseForRecovery()
    }
  })

  it('rejects duplicate barriers, duplicate receipts, and invalid releases', () => {
    const regressed = harness({ now: clock(CONSUMED_AT, CONSUMED_AT - 1) })
    const regressedRegistration = register(regressed)
    regressedRegistration.authorizeBeforeAdapterRun(regressed.expectedPayload)
    regressedRegistration.observer.onAdapterInvoked?.(receipt(regressed))
    expect(regressedRegistration.status()).toBe('launch_confirmation_unknown')
    regressedRegistration.releaseForRecovery()

    const h = harness()
    const registration = register(h)
    expectRegistryError(() => register(h), 'duplicate_run')
    expectRegistryError(() => registration.releaseAfterTerminal(), 'release_forbidden')
    expectRegistryError(() => registration.releaseForRecovery(), 'release_forbidden')
    registration.authorizeBeforeAdapterRun(h.expectedPayload)
    expectRegistryError(
      () => registration.authorizeBeforeAdapterRun(h.expectedPayload),
      'launch_already_attempted'
    )
    registration.observer.onAdapterInvoked?.(receipt(h))
    registration.observer.onAdapterInvoked?.(receipt(h))
    expect(registration.status()).toBe('launch_confirmation_unknown')
    registration.releaseForRecovery()
    expectRegistryError(() => registration.requireLaunchConfirmed(), 'run_unavailable')

    const declined = harness()
    const declinedRegistration = register(declined)
    declinedRegistration.releaseBeforeLaunch()
    expect(declinedRegistration.status()).toBe('released')
    expect(declined.registry.pendingCount()).toBe(0)
    expectRegistryError(() => declinedRegistration.releaseBeforeLaunch(), 'run_unavailable')
  })
})
