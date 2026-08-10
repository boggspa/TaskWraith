import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  CHANNEL_AGENT_PARTICIPATION_REVIEW_GATE,
  CHANNEL_AGENT_REVIEW_ACCEPTANCE_COMMIT,
  CHANNEL_AGENT_REVIEW_ACCEPTED_CANDIDATE,
  channelAgentParticipationEnabled
} from '../src/shared/collaboration/ChannelAgentReviewGate'
import { verifyChannelAgentMessageProof } from '../src/shared/collaboration/ChannelAgentMessageProof'
import { generateIdentityKeyPair } from '../src/shared/e2ee/keys'
import type { RunEventSink } from '../src/main/RunEventBus'
import type { RunSessionChangeEvent } from '../src/main/RunManager'
import type { AgentRunPayload } from '../src/main/run/AgentRunTypes'
import type {
  ChannelAgentComposerAuthority,
  ComposerInput,
  ComposerRunPayload
} from '../src/main/services/ComposerService'
import type { AppSettings, ChatRecord, EnsembleParticipant } from '../src/main/store/types'
import type { ChannelAgentDispatchHooks } from '../src/main/collaboration/ChannelAgentDispatchCoordinator'
import type { ChannelAgentIdentitySafeStorage } from '../src/main/collaboration/ChannelAgentIdentityStore'
import {
  createChannelProductionService,
  type ChannelProductionAgentExecutionOptions,
  type ChannelProductionService
} from '../src/main/collaboration/ChannelProductionService'
import { resolveChannelAgentGrantAuthority } from '../src/main/collaboration/ChannelAgentSeatAuthority'
import type { AgentChannelMessage } from '../src/main/collaboration/ChannelMessageLog'
import type { TransportSocketFactory } from '../src/main/remote/RemoteTransportClient'

const TERMINAL_REPLY = 'CHANNELS_P3_ENABLED_SIGNED_REPLY_OK'
const REVIEW_ID = 'channels-p3-agent-participation-v1'
const CHAT_ID = 'chat-channels-p3-enabled-proof'
const WORKSPACE_ID = 'workspace-channels-p3-enabled-proof'
const AGENT_SEAT_ID = 'pooled-agent-channels-p3-enabled-proof'
const AGENT_PARTICIPANT_ID = 'participant-channels-p3-enabled-proof'

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

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function occurrences(value: string, fragment: string): number {
  return value.split(fragment).length - 1
}

function assertMission(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Channels P3 enabled mission failed: ${message}`)
}

function participant(): EnsembleParticipant {
  return {
    id: AGENT_PARTICIPANT_ID,
    provider: 'codex',
    enabled: true,
    role: 'Channel proof responder',
    instructions: 'Return the deterministic acceptance receipt.',
    order: 1,
    model: 'gpt-5.6-terra',
    runtimeProfileId: 'profile-channels-p3-enabled-proof',
    permissionPresetId: 'read_only',
    reasoningEffort: 'high',
    serviceTier: 'priority',
    pooledAgentId: AGENT_SEAT_ID,
    pooledAgentIdentity: {
      schemaVersion: 1,
      agentId: AGENT_SEAT_ID,
      nickname: 'Proof Agent',
      iconKind: 'seed',
      hue: 210
    }
  }
}

function chat(workspacePath: string): ChatRecord {
  return {
    appChatId: CHAT_ID,
    title: 'Channels P3 enabled proof',
    workspaceId: WORKSPACE_ID,
    workspacePath,
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ensemble: {
      enabled: true,
      participants: [participant()]
    }
  } as ChatRecord
}

function composedPayload(
  input: ComposerInput,
  authority: ChannelAgentComposerAuthority
): ComposerRunPayload {
  const finalPrompt = input.userInput ?? ''
  return {
    provider: authority.provider,
    scope: authority.scope,
    ...(authority.scope === 'workspace' ? { workspace: authority.workspacePath } : {}),
    prompt: `TaskWraith runtime preamble.\n\n${finalPrompt}`,
    activeGoal: null,
    appRunId: authority.appRunId,
    appChatId: authority.chatId,
    model: input.overrideModel ?? 'gpt-5.6-terra',
    reasoningEffort: input.codexReasoningEffort ?? null,
    serviceTier: input.codexServiceTier ?? null,
    claudeReasoningEffort: null,
    claudeFastMode: null,
    kimiThinking: null,
    approvalMode: authority.approvalMode,
    workflowMode: authority.workflowMode,
    effectivePermissions: clone(authority.effectivePermissions),
    effectivePermissionsSignature: 'channels-p3-enabled-main-owned-posture',
    imagePaths: [],
    providerSessionId: null,
    externalPathGrants: [],
    sessionTrust: false,
    geminiWorktree: null,
    runtimeProfileId: input.runtimeProfileId,
    taskWraithMcpProfileId: 'taskwraith-core-v1',
    taskWraithMcpAdvertised: true,
    geminiAuthProfileId: input.geminiAuthProfileId ?? null,
    composer: {
      finalPrompt,
      contextTurnsApplied: 0,
      applicationLog: 'Fresh isolated Channel agent turn.',
      providerLabel: 'Codex',
      requestedModel: input.overrideModel ?? 'gpt-5.6-terra',
      approvalMode: authority.approvalMode,
      workflowMode: authority.workflowMode,
      providerSessionId: null,
      imagePaths: []
    }
  }
}

interface RuntimeMetrics {
  composeCalls: number
  dispatchCalls: number
  finalAuthorizationCalls: number
  adapterReceiptCalls: number
  audienceClaims: number
  promptEnvelopeCount: number
  contributionCount: number
  runId: string
}

function agentExecution(
  sourceChat: ChatRecord,
  now: () => number,
  metrics: RuntimeMetrics
): ChannelProductionAgentExecutionOptions {
  let eventSink: RunEventSink | null = null
  let sessionListener: ((event: RunSessionChangeEvent) => void) | null = null

  return {
    getChat: (chatId) => (chatId === CHAT_ID ? sourceChat : null),
    resolveWorkspacePrincipal: (value) =>
      value.appChatId === CHAT_ID ? { kind: 'workspace', workspaceId: WORKSPACE_ID } : null,
    getSettings: () => settings,
    providerAllowed: (provider) => provider === 'codex',
    composeMainOwnedChannelAgentRun: async (input, authority) => {
      metrics.composeCalls += 1
      return composedPayload(input, authority)
    },
    dispatch: async (payload: AgentRunPayload, hooks: ChannelAgentDispatchHooks) => {
      assertMission(eventSink, 'run event subscription was not active')
      assertMission(sessionListener, 'run session subscription was not active')
      assertMission(payload.appRunId, 'generic dispatch received no exact run id')
      assertMission(payload.appChatId === CHAT_ID, 'generic dispatch changed the chat route')
      assertMission(payload.provider === 'codex', 'generic dispatch changed the provider route')
      assertMission(
        payload.workspace === sourceChat.workspacePath,
        'generic dispatch changed workspace'
      )
      metrics.dispatchCalls += 1
      metrics.runId = payload.appRunId
      metrics.promptEnvelopeCount = occurrences(payload.prompt, '<external_contribution')
      metrics.contributionCount = occurrences(payload.prompt, 'run the enabled P3 proof')

      hooks.finalAuthorization.authorizeBeforeAdapterRun(payload)
      metrics.finalAuthorizationCalls += 1
      hooks.observer.onAdapterInvoked?.({
        provider: payload.provider,
        appRunId: payload.appRunId,
        effectiveWorkspacePath: payload.workspace
      })
      metrics.adapterReceiptCalls += 1

      const publishedAt = new Date(now()).toISOString()
      eventSink.handle({
        channel: 'agent-output',
        provider: payload.provider,
        payload: {
          appRunId: payload.appRunId,
          appChatId: payload.appChatId,
          provider: payload.provider,
          type: 'content',
          text: TERMINAL_REPLY
        },
        publishedAt
      })
      eventSink.handle({
        channel: 'agent-exit',
        provider: payload.provider,
        payload: {
          appRunId: payload.appRunId,
          appChatId: payload.appChatId,
          provider: payload.provider,
          code: 0
        },
        publishedAt
      })
      sessionListener({
        type: 'updated',
        session: {
          runId: payload.appRunId,
          provider: payload.provider,
          appChatId: payload.appChatId,
          workspacePath: payload.workspace,
          status: 'completed'
        }
      } as RunSessionChangeEvent)
      return { dispatched: true, appRunId: payload.appRunId }
    },
    subscribeRunEvents: (sink) => {
      assertMission(eventSink === null, 'run event subscription was duplicated')
      eventSink = sink
      return () => {
        eventSink = null
      }
    },
    subscribeRunSessions: (listener) => {
      assertMission(sessionListener === null, 'run session subscription was duplicated')
      sessionListener = listener
      return () => {
        sessionListener = null
      }
    },
    claimRunAudience: (runId, sinkIds) => {
      metrics.audienceClaims += 1
      assertMission(sinkIds.length === 1, 'run audience was not closed')
      assertMission(sinkIds[0] === 'channel-agent-run-terminal', 'run audience used the wrong sink')
      return Object.freeze({
        runId,
        sinkIds: Object.freeze([...sinkIds]),
        release: () => true
      })
    },
    reconcileRun: async () => ({ kind: 'definitively_absent' })
  }
}

const safeStorage: ChannelAgentIdentitySafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plaintext) => Buffer.from(plaintext, 'utf8'),
  decryptString: (ciphertext) => ciphertext.toString('utf8'),
  getSelectedStorageBackend: () => 'keychain'
}

const socketFactory: TransportSocketFactory = () => ({
  send: () => undefined,
  close: () => undefined
})

async function waitForAgentRecord(
  service: ChannelProductionService,
  channelId: string,
  timeoutMs = 10_000
): Promise<AgentChannelMessage> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const record = service
      .readChannel({ channelId, resumeAfter: 0 })
      .records.find(
        (candidate): candidate is AgentChannelMessage => candidate.kind === 'agent.text'
      )
    if (record) return record
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10))
  }
  throw new Error('Channels P3 enabled mission timed out waiting for the signed post')
}

async function main(): Promise<void> {
  const userDataPath = resolve(process.env.CHANNELS_P3_ENABLED_PROOF_PROFILE || '')
  assertMission(Boolean(process.env.CHANNELS_P3_ENABLED_PROOF_PROFILE), 'profile path is required')
  mkdirSync(userDataPath, { recursive: true })
  const workspacePath = join(userDataPath, 'workspace')
  mkdirSync(workspacePath, { recursive: true })
  let clock = 1_700_000_000_000
  const now = (): number => clock++
  const sourceChat = chat(workspacePath)
  const hostIdentity = generateIdentityKeyPair()
  const metrics: RuntimeMetrics = {
    composeCalls: 0,
    dispatchCalls: 0,
    finalAuthorizationCalls: 0,
    adapterReceiptCalls: 0,
    audienceClaims: 0,
    promptEnvelopeCount: 0,
    contributionCount: 0,
    runId: ''
  }
  const options = {
    userDataPath,
    loadIdentity: () => hostIdentity,
    safeStorage,
    relay: { hostRelayUrl: () => '', inviteRelayUrls: () => [] },
    socketFactory,
    now,
    agentExecution: agentExecution(sourceChat, now, metrics)
  }

  assertMission(channelAgentParticipationEnabled(), 'accepted source gate is not enabled')
  assertMission(
    CHANNEL_AGENT_PARTICIPATION_REVIEW_GATE.status === 'accepted' &&
      CHANNEL_AGENT_PARTICIPATION_REVIEW_GATE.reviewId === REVIEW_ID,
    'accepted source gate metadata is invalid'
  )

  const service = createChannelProductionService(options)
  let restarted: ChannelProductionService | null = null
  try {
    service.start()
    service.startAgentExecution()
    const channel = service.createChannel({
      chatId: CHAT_ID,
      title: 'Channels P3 enabled proof',
      ownerDisplayName: 'Host'
    })
    const owner = service.readChannel({ channelId: channel.channelId, resumeAfter: 0 }).members[0]
    assertMission(owner?.kind === 'human', 'Channel owner is unavailable')

    const enrolled = await service.enrollAgent({
      channelId: channel.channelId,
      seat: { agentSeatId: AGENT_SEAT_ID, displayName: 'Proof Agent' },
      operationId: 'channels-p3-enabled-enroll'
    })
    const grantAuthority = resolveChannelAgentGrantAuthority({
      chat: sourceChat,
      agentSeatId: AGENT_SEAT_ID,
      permissionPresetId: 'read_only',
      workspacePrincipal: { kind: 'workspace', workspaceId: WORKSPACE_ID },
      settings,
      providerAllowed: (provider) => provider === 'codex'
    })
    const grant = await service.grantAgentDispatch({
      channelId: channel.channelId,
      agentSeatId: AGENT_SEAT_ID,
      operationId: 'channels-p3-enabled-grant',
      allowedMentionerMemberIds: [owner.memberId],
      workspaceIdentityHash: grantAuthority.workspaceIdentityHash,
      permissionPostureHash: grantAuthority.permissionPostureHash,
      ttlMs: 10 * 60 * 1_000,
      maxDispatches: 1
    })
    assertMission(
      grant.signedDispatchGrant.grant.agentMemberId === enrolled.member.memberId,
      'signed grant changed the enrolled agent binding'
    )

    const human = await service.appendHost({
      channelId: channel.channelId,
      clientMessageId: 'channels-p3-enabled-human-message',
      content: `Please <@${enrolled.member.memberId}> run the enabled P3 proof.`
    })
    const agentRecord = await waitForAgentRecord(service, channel.channelId)
    const verification = verifyChannelAgentMessageProof({
      ownerPublicKeyB64: service.hostIdentityPublicKey(),
      proof: agentRecord.agentProof,
      acceptedAt: agentRecord.acceptedAt
    })
    assertMission(verification.ok, 'persisted agent proof did not verify')
    assertMission(agentRecord.content === TERMINAL_REPLY, 'signed post content changed')
    assertMission(agentRecord.agentProof.consumption.dispatchOrdinal === 1, 'wrong grant ordinal')
    assertMission(metrics.composeCalls === 1, 'mention did not compose exactly once')
    assertMission(metrics.dispatchCalls === 1, 'mention did not dispatch exactly once')
    assertMission(metrics.finalAuthorizationCalls === 1, 'final authorization did not run once')
    assertMission(metrics.adapterReceiptCalls === 1, 'adapter receipt did not run once')
    assertMission(metrics.audienceClaims === 1, 'closed run audience was not claimed once')
    assertMission(
      metrics.promptEnvelopeCount === 1,
      'untrusted contribution wrapper was not singular'
    )
    assertMission(metrics.contributionCount === 1, 'accepted contribution was not singular')

    const audit = service.listAudit({ channelId: channel.channelId })
    const auditKinds = [...new Set(audit.map((event) => event.kind))].sort()
    for (const kind of [
      'agent.dispatch.started',
      'agent.dispatch.completed',
      'agent.post.committed'
    ]) {
      assertMission(auditKinds.includes(kind), `production audit is missing ${kind}`)
    }
    assertMission(!JSON.stringify(audit).includes(TERMINAL_REPLY), 'audit leaked terminal content')
    assertMission(
      !JSON.stringify(audit).includes(human.record.content),
      'audit leaked the accepted human contribution'
    )

    const beforeRestart = service.readChannel({ channelId: channel.channelId, resumeAfter: 0 })
    assertMission(beforeRestart.highWaterSequence === 2, 'Channel log is not exactly human + agent')
    await service.stop()

    restarted = createChannelProductionService(options)
    restarted.start()
    const afterRestart = restarted.readChannel({ channelId: channel.channelId, resumeAfter: 0 })
    const restoredAgent = afterRestart.records.find(
      (record): record is AgentChannelMessage => record.kind === 'agent.text'
    )
    assertMission(restoredAgent, 'signed agent post did not survive restart')
    assertMission(afterRestart.highWaterSequence === 2, 'restart changed the Channel high water')
    assertMission(
      verifyChannelAgentMessageProof({
        ownerPublicKeyB64: restarted.hostIdentityPublicKey(),
        proof: restoredAgent.agentProof,
        acceptedAt: restoredAgent.acceptedAt
      }).ok,
      'restored signed agent proof did not verify'
    )

    const assertions = {
      acceptedSourceGateEnabled: true,
      acceptedCandidateAndDecisionNamed: true,
      durableHumanMentionAdmitted: true,
      canonicalGrantConsumedOnce: true,
      genericDispatchInvokedOnce: true,
      finalAuthorizationInvokedOnce: true,
      adapterReceiptConfirmedOnce: true,
      closedRunAudienceClaimedOnce: true,
      untrustedContributionWrappedOnce: true,
      terminalSignalsAgreed: true,
      signedAgentPostAppended: true,
      publicMessageProofVerified: true,
      auditContentRedacted: true,
      signedPostSurvivedRestart: true
    }
    process.stdout.write(
      `${JSON.stringify({
        status: 'passed',
        reviewId: REVIEW_ID,
        acceptedCandidate: CHANNEL_AGENT_REVIEW_ACCEPTED_CANDIDATE,
        acceptanceCommit: CHANNEL_AGENT_REVIEW_ACCEPTANCE_COMMIT,
        dispatchCount: metrics.dispatchCalls,
        finalHighWaterSequence: afterRestart.highWaterSequence,
        terminalContentSha256: sha256(TERMINAL_REPLY),
        runIdSha256: sha256(metrics.runId),
        auditKinds,
        assertionCount: Object.keys(assertions).length,
        assertionsSha256: sha256(JSON.stringify(assertions)),
        assertions
      })}\n`
    )
  } finally {
    await restarted?.stop().catch(() => undefined)
    await service.stop().catch(() => undefined)
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exitCode = 1
})
