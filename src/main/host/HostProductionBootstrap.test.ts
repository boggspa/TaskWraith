/**
 * Host Arc Wave 3.6c — HostProductionBootstrap tests.
 *
 * Tests the production bootstrap: options validation, supervisor assembly,
 * the allowCrashRestart pin (MUST be false — explicit stop is persistent),
 * re-entrancy, healthProvider circularity resolution, and import isolation.
 *
 * Several pins here are deliberately BEHAVIOURAL rather than structural,
 * because a test that has never been seen red proves nothing. The
 * allowCrashRestart pin in particular asserts both the literal argument and
 * the retry behaviour it controls, so flipping the flag fails twice.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MainSourceProbe } from '../mainSourceProbe.testutil'
import {
  createHostProductionBootstrap,
  resetHostProductionBootstrapForTests
} from './HostProductionBootstrap'
import type { HostProductionBootstrapOptions } from './HostProductionBootstrap'
import type { HostProductionQueuedStartAdapter } from './HostProductionBootstrap'
import type { HostProductionContextResolverDeps } from './HostProductionContextResolvers'
import { createHostBridgeQueuedStartProducerBinding } from './HostBridgeQueuedStartProducerBinding'
import {
  verifyHostBridgeQueuedStartRecord,
  type createHostBridgeQueuedStartProducer,
  type HostBridgeQueuedStartIdentity
} from './HostBridgeQueuedStartProducer'
import {
  dispatchObservedHostBridgeRound,
  verifyHostBridgeQueuedRoundStartRecord,
  type createHostBridgeQueuedRoundStartProducer,
  type HostBridgeQueuedRoundStartIdentity
} from './HostBridgeQueuedRoundStartProducer'
import { createEnsembleRoundStartObservation } from '../services/EnsembleRoundStartObserver'
import type { ChatRecord, ChatRun } from '../store/types'
import type { HostCursorPosition } from '../../shared/hostProtocol'
import type { HostDeltaAppendEvent } from '../../host-runtime/HostDeltaStore'
import type {
  HostProductionChatListPort,
  HostProductionProviderListPort
} from '../../host-runtime/HostProductionSuppliers'
import { HostDeferredAllowPipeline } from '../../host-runtime/HostDeferredAllowPipeline'
import type { HostLocalServer, HostLocalServerOptions } from '../../host-runtime/HostLocalServer'
import {
  createHostMainComposition,
  type HostMainComposition,
  type HostMainCompositionInput
} from '../../host-runtime/HostMainComposition'
import { HostRuntimeBootstrap } from '../../host-runtime/HostRuntimeBootstrap'
import type { HostSupervisor, HostSupervisorInput } from '../../host-runtime/HostSupervisor'

/* ------------------------------------------------------------------ */
/*  Scaffolding                                                       */
/* ------------------------------------------------------------------ */

const MOCK_HOST = { hostId: 'test-host-1', hostVersion: '0.0.0-test' }

let pathSeq = 0
const profilePaths: string[] = []

function uniquePath(): string {
  pathSeq += 1
  return `/tmp/host-bootstrap-test-${pathSeq}`
}

function profilePath(): string {
  const path = mkdtempSync(join(tmpdir(), 'host-bootstrap-profile-'))
  profilePaths.push(path)
  return path
}

function mockChatList(): HostProductionChatListPort {
  return { getChatList: vi.fn().mockReturnValue([]) }
}

function mockContextSources(): HostProductionContextResolverDeps {
  return {
    getChat: vi.fn().mockReturnValue(null),
    getApproval: vi.fn().mockReturnValue(null),
    getQuestion: vi.fn().mockReturnValue(null)
  }
}

function mockBridge(): HostProductionBootstrapOptions['bridge'] {
  const ok = async (): Promise<{ executed: boolean }> => ({ executed: true })
  return {
    executeComposerPrompt: ok,
    executeEnsembleSteer: ok,
    executeCancelRun: ok,
    executeEnsembleCancelRound: ok,
    executeApprovalReply: ok,
    executeQuestionReply: ok,
    executeQuestionReject: ok,
    executeEnsembleRosterUpdate: ok,
    executeSetWatchedThread: ok
  } as unknown as HostProductionBootstrapOptions['bridge']
}

function fakeComposition(): HostMainComposition {
  return {
    hostDataDir: '/fake',
    authority: { snapshot: async () => ({ ok: true, value: {} }) },
    session: {},
    getPosition: () => ({ generation: 1, cursor: 0 }),
    getRecoverySummary: () => ({}),
    startProjectionReconciliation: async () => {},
    reconcileProjection: async () => ({
      kind: 'unchanged',
      position: { generation: 1, cursor: 0 }
    }),
    stopProjectionReconciliation: async () => {},
    shutdown: async () => {}
  } as unknown as HostMainComposition
}

function fakeServer(): HostLocalServer {
  return {
    start: async () => {},
    stop: async () => {},
    stopSync: () => {}
  } as unknown as HostLocalServer
}

function fakeSupervisor(): HostSupervisor {
  return {
    start: async () => {},
    stop: async () => {},
    stopSync: () => {},
    isRunning: false,
    isStopped: false,
    healthProvider: () => ({
      hostStatus: 'offline',
      connectionPhase: 'connecting',
      supervised: false,
      freshness: 'live'
    })
  } as unknown as HostSupervisor
}

function validOptions(
  overrides: Partial<HostProductionBootstrapOptions> = {}
): HostProductionBootstrapOptions {
  return {
    userDataPath: uniquePath(),
    chatList: mockChatList(),
    contextSources: mockContextSources(),
    bridge: mockBridge(),
    host: MOCK_HOST,
    // Fakes keep construction pure: no real server, no real journal.
    createComposition: () => fakeComposition(),
    createServer: (_o: HostLocalServerOptions) => fakeServer(),
    ...overrides
  }
}

function projectionFamilyPorts(): Partial<HostProductionBootstrapOptions> {
  return {
    missions: { listMissions: () => [] },
    rounds: { listRounds: () => [] },
    participants: { listParticipants: () => [] },
    questions: { listQuestions: () => [] },
    schedules: { listSchedules: () => [] },
    artifacts: { listArtifacts: () => [] }
  }
}

/** Bootstrap with a supervisor spy; returns the captured supervisor input. */
function captureSupervisorInput(overrides: Partial<HostProductionBootstrapOptions> = {}): {
  supervisorInput: HostSupervisorInput
  compositionInput: HostMainCompositionInput
} {
  let captured: HostSupervisorInput | null = null
  createHostProductionBootstrap(
    validOptions({
      ...overrides,
      createSupervisor: (input) => {
        captured = input
        return fakeSupervisor()
      }
    })
  )
  if (!captured) throw new Error('supervisor factory was never called')
  const supervisorInput = captured as HostSupervisorInput
  return { supervisorInput, compositionInput: supervisorInput.compositionInput }
}

beforeEach(() => {
  resetHostProductionBootstrapForTests()
})

afterEach(() => {
  while (profilePaths.length > 0) rmSync(profilePaths.pop()!, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ */
/*  Options validation                                                */
/* ------------------------------------------------------------------ */

describe('HostProductionBootstrap options validation', () => {
  it('rejects missing options object', () => {
    expect(() =>
      createHostProductionBootstrap(undefined as unknown as HostProductionBootstrapOptions)
    ).toThrow('HostProductionBootstrap requires an options object')
  })

  it('advertises setup/provider/history only with their complete injected adapters in canonical order', () => {
    const { compositionInput } = captureSupervisorInput({
      setup: {
        workspace: {
          getWorkspaces: () => [],
          registerWorkspace: () => ({ id: 'workspace-1' })
        },
        chat: {
          createSingleThread: () => ({ appChatId: 'thread-1' }),
          configureThread: () => ({ appChatId: 'thread-1' }),
          archiveThread: () => ({ appChatId: 'thread-1' })
        },
        terminal: {
          begin: ({ provider, operationId }) => ({ provider, operationId }),
          cancel: () => ({ outcome: 'not_cancellable' })
        },
        providers: () => []
      },
      history: { getChat: () => null }
    })
    expect(compositionInput.hostCapabilityOffer).toEqual([
      'bootstrap',
      'snapshot',
      'deltas',
      'model-offers',
      'provider-catalog',
      'provider-auth',
      'history',
      'setup',
      'commands',
      'receipts',
      'health',
      'approvals',
      'compact-export',
      'recovery'
    ])
    expect(compositionInput.setupExecutor).toBeDefined()
    expect(compositionInput.providerStatusesProvider).toBeDefined()
    expect(compositionInput.threadHistoryProvider).toBeDefined()
  })

  it('rejects an incomplete history option before advertising the history capability', () => {
    expect(() =>
      createHostProductionBootstrap(
        validOptions({ history: {} as HostProductionBootstrapOptions['history'] })
      )
    ).toThrow('history.getChat')
  })

  it('rejects null options', () => {
    expect(() =>
      createHostProductionBootstrap(null as unknown as HostProductionBootstrapOptions)
    ).toThrow('HostProductionBootstrap requires an options object')
  })

  it('rejects missing userDataPath', () => {
    expect(() => createHostProductionBootstrap(validOptions({ userDataPath: '' }))).toThrow(
      'HostProductionBootstrap requires an injected userDataPath'
    )
  })

  it('rejects missing chatList', () => {
    expect(() =>
      createHostProductionBootstrap(
        validOptions({ chatList: null as unknown as HostProductionChatListPort })
      )
    ).toThrow('HostProductionBootstrap requires an injected chatList')
  })

  it('accepts a class-like chatList whose static getChatList satisfies the port', () => {
    // Production passes `AppStore` — a class whose static `getChatList`
    // structurally satisfies HostProductionChatListPort. The guard now
    // checks the METHOD (typeof getChatList === 'function'), not the
    // container, so a class-with-statics is a valid port. This was seen
    // FAILING (throwing) before the fix and MUST stay green — it pins the
    // exact shape that shipped broken in Wave 4.8.
    class ChatStoreStub {
      static getChatList(_workspaceId?: string): [] {
        return []
      }
    }
    const result = createHostProductionBootstrap(
      validOptions({ chatList: ChatStoreStub as unknown as HostProductionChatListPort })
    )
    expect(result).toBeDefined()
  })

  it('rejects an empty object chatList — a hole that is open today', () => {
    // Today `typeof {} === 'object'` passes the guard, so an empty object
    // sails through construction and explodes at first snapshot call.
    // After the fix (checking `typeof options.chatList.getChatList !== 'function'`),
    // this MUST throw and this test name stays correct.
    expect(() =>
      createHostProductionBootstrap(
        validOptions({ chatList: {} as unknown as HostProductionChatListPort })
      )
    ).toThrow('HostProductionBootstrap requires an injected chatList')
  })

  it('rejects a providers object missing getProviders (Step 5b guard)', () => {
    // Mirrors the chatList empty-object pin. providers is OPTIONAL, but when
    // present the METHOD must satisfy the port — otherwise snapshot reads
    // throw mid-flight instead of failing closed to [].
    expect(() =>
      createHostProductionBootstrap(
        validOptions({ providers: {} as unknown as HostProductionProviderListPort })
      )
    ).toThrow('HostProductionBootstrap requires providers.getProviders to be a function')
  })

  it('accepts omitted providers — optional port stays optional', () => {
    const result = createHostProductionBootstrap(validOptions())
    expect(result).toBeDefined()
  })

  it('accepts a class-like providers port whose static getProviders satisfies the port', () => {
    class ProvidersStub {
      static getProviders(): [] {
        return []
      }
    }
    const result = createHostProductionBootstrap(
      validOptions({ providers: ProvidersStub as unknown as HostProductionProviderListPort })
    )
    expect(result).toBeDefined()
  })

  it('rejects an approvals object missing listApprovals (Wave 5c Phase 2 guard)', () => {
    // Mirrors the providers guard pin. approvals is OPTIONAL, but when present
    // the METHOD must satisfy the port — otherwise snapshot reads throw
    // mid-flight instead of failing closed to [].
    expect(() => createHostProductionBootstrap(validOptions({ approvals: {} as never }))).toThrow(
      'HostProductionBootstrap requires approvals.listApprovals to be a function'
    )
  })

  it('accepts omitted approvals — optional port stays optional', () => {
    const result = createHostProductionBootstrap(validOptions())
    expect(result).toBeDefined()
  })

  it('threads an injected approvals port through to the snapshot donor', async () => {
    const { compositionInput } = captureSupervisorInput({
      approvals: {
        listApprovals: () => [
          {
            approvalId: '1700000000000-abc123',
            commandId: 'appstore-shadow:1700000000000-abc123',
            status: 'pending',
            actionKind: 'mcpTools',
            createdAt: 0,
            summary: 'Allow a gated tool?'
          }
        ]
      }
    })
    const families = await compositionInput.snapshotDonor()
    expect(families.approvals.map((row) => row.approvalId)).toEqual(['1700000000000-abc123'])
  })

  it('rejects a questions object missing listQuestions (Wave 5c Phase 3 guard)', () => {
    expect(() => createHostProductionBootstrap(validOptions({ questions: {} as never }))).toThrow(
      'HostProductionBootstrap requires questions.listQuestions to be a function'
    )
  })

  it('accepts omitted questions — optional port stays optional', () => {
    const result = createHostProductionBootstrap(validOptions())
    expect(result).toBeDefined()
  })

  it('requires live context sources for governed Host mutations', () => {
    expect(() =>
      createHostProductionBootstrap(validOptions({ contextSources: undefined as never }))
    ).toThrow('HostProductionBootstrap requires injected contextSources')
    expect(() =>
      createHostProductionBootstrap(
        validOptions({
          contextSources: {
            getChat: undefined as never,
            getApproval: () => null,
            getQuestion: () => null
          }
        })
      )
    ).toThrow('HostProductionBootstrap requires contextSources.getChat')
    expect(() =>
      createHostProductionBootstrap(
        validOptions({
          contextSources: {
            getChat: () => null,
            getApproval: undefined as never,
            getQuestion: () => null
          }
        })
      )
    ).toThrow('HostProductionBootstrap requires contextSources.getApproval')
    expect(() =>
      createHostProductionBootstrap(
        validOptions({
          contextSources: {
            getChat: () => null,
            getApproval: () => null,
            getQuestion: undefined as never
          }
        })
      )
    ).toThrow('HostProductionBootstrap requires contextSources.getQuestion')
  })

  it('threads an injected questions port through to the snapshot donor', async () => {
    const { compositionInput } = captureSupervisorInput({
      questions: {
        listQuestions: () => [
          {
            questionId: 'q-1700000000000-abc123',
            threadId: 'chat-1',
            status: 'open',
            promptPreview: 'Which approach should we take?',
            askedAt: Date.parse('2024-11-14T22:13:20.000Z')
          }
        ]
      }
    })
    const families = await compositionInput.snapshotDonor()
    expect(families.questions.map((row) => row.questionId)).toEqual(['q-1700000000000-abc123'])
  })

  it('rejects missing bridge', () => {
    expect(() =>
      createHostProductionBootstrap(
        validOptions({ bridge: null as unknown as HostProductionBootstrapOptions['bridge'] })
      )
    ).toThrow('HostProductionBootstrap requires an injected bridge')
  })

  it('rejects missing host identity', () => {
    expect(() =>
      createHostProductionBootstrap(validOptions({ host: { hostId: '', hostVersion: '' } }))
    ).toThrow('HostProductionBootstrap requires an injected host identity')
  })

  it('rejects an incomplete in-process profile authority port', () => {
    expect(() =>
      createHostProductionBootstrap(validOptions({ profileAuthority: {} as never }))
    ).toThrow('profileAuthority.assertProfileAuthority')
  })
})

/* ------------------------------------------------------------------ */
/*  R1 — the root must not perform domain assembly                    */
/* ------------------------------------------------------------------ */

describe('HostProductionBootstrap R1 (composition root stays wiring-only)', () => {
  it('builds the command executor and capability offer internally', () => {
    // The root supplies only what it uniquely holds. If either of these ever
    // moves back into Options, index.ts has to construct a Host type again
    // and this test is the tripwire.
    const { compositionInput } = captureSupervisorInput(projectionFamilyPorts())

    expect(typeof compositionInput.commandExecutor).toBe('function')
    expect(compositionInput.hostCapabilityOffer).toEqual([
      'bootstrap',
      'snapshot',
      'deltas',
      'model-offers',
      'commands',
      'receipts',
      'health',
      'missions',
      'ensemble',
      'approvals',
      'questions',
      'schedules',
      'artifacts',
      'compact-export',
      'recovery'
    ])
  })

  it('advertises Channels only with a real port and routes its commands outside Bridge', async () => {
    const closeChannel = vi.fn(async (channelId: string) => ({
      ok: true as const,
      channel: { channelId, status: 'closed' as const }
    }))
    const { compositionInput } = captureSupervisorInput({
      channels: {
        listChannels: () => [],
        revokeMember: vi.fn(),
        closeChannel
      }
    })
    expect(compositionInput.hostCapabilityOffer).toContain('channels')

    const actor = { actorId: 'actor-1', clientId: 'client-1', clientClass: 'desktop' as const }
    await expect(
      compositionInput.commandExecutor(
        {
          type: 'host.command',
          protocolVersion: 2,
          commandId: '11111111-1111-4111-8111-111111111111',
          idempotencyKey: 'channel-close-1',
          actor,
          name: 'channel.close',
          target: { channelId: 'channel-a' },
          arguments: {},
          issuedAt: '2026-08-12T20:00:00.000Z'
        },
        {
          actor,
          client: { clientId: 'client-1', clientClass: 'desktop', clientVersion: 'test' }
        }
      )
    ).resolves.toMatchObject({ status: 'succeeded' })
    expect(closeChannel).toHaveBeenCalledWith('channel-a')
  })

  it('routes Host-owned profile commands outside Bridge when fallback authority is present', async () => {
    const bridge = mockBridge()
    const bridgeSend = vi.spyOn(bridge, 'executeComposerPrompt')
    const assertProfileAuthority = vi.fn()
    const { compositionInput } = captureSupervisorInput({
      userDataPath: profilePath(),
      bridge,
      profileAuthority: { assertProfileAuthority }
    })
    const actor = { actorId: 'desktop', clientId: 'desktop', clientClass: 'desktop' as const }

    await expect(
      Promise.resolve(
        compositionInput.commandExecutor(
          {
            type: 'host.command',
            protocolVersion: 2,
            commandId: '11111111-1111-4111-8111-111111111111',
            idempotencyKey: 'workspace-records-clear-1',
            actor,
            name: 'workspace.records.clear',
            target: {},
            arguments: {},
            issuedAt: '2026-08-28T10:00:00.000Z'
          },
          {
            actor,
            client: { clientId: 'desktop', clientClass: 'desktop', clientVersion: 'test' }
          }
        )
      )
    ).resolves.toEqual({
      status: 'succeeded',
      resultSummary: 'workspace_records_already_empty'
    })
    expect(assertProfileAuthority).toHaveBeenCalled()
    expect(bridgeSend).not.toHaveBeenCalled()
  })

  it('wires canonical thread offers from the same live context source as composer validation', async () => {
    const getChat = vi.fn((threadId: string) =>
      threadId === 'thread-1'
        ? {
            appChatId: 'thread-1',
            scope: 'workspace',
            workspaceId: 'workspace-1',
            provider: 'codex',
            requestedModel: 'gpt-5.6-sol',
            providerMetadata: { codexReasoningEffort: 'high' },
            runs: []
          }
        : null
    )
    const { compositionInput } = captureSupervisorInput({
      contextSources: {
        getChat,
        getApproval: () => null,
        getQuestion: () => null
      }
    })

    await expect(compositionInput.threadOffersProvider?.('thread-1')).resolves.toMatchObject({
      threadId: 'thread-1',
      currentModel: 'gpt-5.6-sol',
      currentReasoningEffort: 'high',
      source: 'curated'
    })
    expect(getChat).toHaveBeenCalledWith('thread-1')
  })

  it('builds live production context resolvers instead of an unwired refusal', async () => {
    const executeComposerPrompt = vi.fn(async () => ({ executed: true, message: 'sent' }))
    const { compositionInput } = captureSupervisorInput({
      bridge: { ...mockBridge(), executeComposerPrompt },
      contextSources: {
        getChat: (threadId) =>
          threadId === 'thread-1'
            ? {
                appChatId: 'thread-1',
                scope: 'workspace',
                workspaceId: 'workspace-1',
                provider: 'codex',
                archived: false,
                runs: []
              }
            : null,
        getApproval: () => null,
        getQuestion: () => null
      }
    })

    const actor = { actorId: 'actor-1', clientId: 'client-1', clientClass: 'desktop' as const }
    const result = await compositionInput.commandExecutor(
      {
        type: 'host.command',
        protocolVersion: 2,
        commandId: '11111111-1111-4111-8111-111111111111',
        idempotencyKey: 'desktop:client-1:22222222-2222-4222-8222-222222222222',
        actor,
        name: 'composer.send',
        target: { threadId: 'thread-1' },
        arguments: { text: 'hello from Host' },
        issuedAt: '2026-08-09T00:00:00.000Z'
      },
      {
        actor,
        client: { clientId: 'client-1', clientClass: 'desktop', clientVersion: 'test' }
      }
    )

    expect(result).toMatchObject({ status: 'succeeded', resultSummary: 'sent' })
    expect(executeComposerPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'composerPrompt',
        workspaceId: 'workspace-1',
        threadId: 'thread-1',
        provider: 'codex',
        text: 'hello from Host'
      })
    )
  })

  it('withholds capabilities the donor cannot honestly populate', () => {
    const withoutPorts = captureSupervisorInput().compositionInput
    // Host-native approvals and compact export remain real without optional
    // AppStore shadows; the other family offers must not overclaim.
    expect(withoutPorts.hostCapabilityOffer).toEqual([
      'bootstrap',
      'snapshot',
      'deltas',
      'model-offers',
      'commands',
      'receipts',
      'health',
      'approvals',
      'compact-export',
      'recovery'
    ])
    for (const withheld of [
      'usage',
      'missions',
      'ensemble',
      'schedules',
      'artifacts',
      'questions'
    ]) {
      expect(withoutPorts.hostCapabilityOffer).not.toContain(withheld)
    }

    const { compositionInput } = captureSupervisorInput(projectionFamilyPorts())
    // usage stays unavailable; the .twmission consumer makes compact-export honest.
    for (const withheld of ['usage']) {
      expect(compositionInput.hostCapabilityOffer).not.toContain(withheld)
    }
    // Track3/Track4 + Phase 2/3 shadows make these honest to advertise.
    for (const offered of [
      'missions',
      'ensemble',
      'schedules',
      'artifacts',
      'approvals',
      'questions'
    ]) {
      expect(compositionInput.hostCapabilityOffer).toContain(offered)
    }
    expect(compositionInput.hostCapabilityOffer).toContain('compact-export')
  })

  it('offers ensemble only when both round and participant projections exist', () => {
    expect(
      captureSupervisorInput({ rounds: { listRounds: () => [] } }).compositionInput
        .hostCapabilityOffer
    ).not.toContain('ensemble')
    expect(
      captureSupervisorInput({ participants: { listParticipants: () => [] } }).compositionInput
        .hostCapabilityOffer
    ).not.toContain('ensemble')
    expect(
      captureSupervisorInput({
        rounds: { listRounds: () => [] },
        participants: { listParticipants: () => [] }
      }).compositionInput.hostCapabilityOffer
    ).toContain('ensemble')
  })

  it('wires the production evaluator, not an allow-all fixture', async () => {
    const { compositionInput } = captureSupervisorInput()
    const ctx = {
      actor: { actorId: 'a', clientId: 'c', clientClass: 'desktop' as const },
      client: { clientId: 'c', clientClass: 'desktop' as const, clientVersion: '1' }
    }
    const cmd = (name: string): never => ({ name, actor: ctx.actor }) as never

    await expect(
      Promise.resolve(compositionInput.authorityEvaluator(cmd('totally.unknown'), ctx))
    ).resolves.toMatchObject({ decision: 'denied' })
    await expect(
      Promise.resolve(compositionInput.authorityEvaluator(cmd('composer.send'), ctx))
    ).resolves.toMatchObject({ decision: 'deferred' })
  })

  it('supplies a real AllowPipeline chain through pipelineFactory', () => {
    const { compositionInput } = captureSupervisorInput()
    // The real resolver/publisher constructors validate their ports, so this
    // fake must satisfy them — which is what makes the assertion meaningful.
    const runtime = {
      envelopeStore: {
        getByDeferredId: () => ({ kind: 'not_found' }),
        getByCommandId: () => ({ kind: 'not_found' }),
        markQuarantined: () => ({})
      },
      receiptStore: {
        getByCommandId: () => ({ kind: 'not_found' }),
        complete: () => ({}),
        markIndeterminate: () => ({})
      },
      deltaStore: { append: () => ({}), getPosition: () => ({ generation: 1, cursor: 0 }) },
      getPosition: () => ({ generation: 1, cursor: 0 })
    } as unknown as HostRuntimeBootstrap

    expect(compositionInput.pipelineFactory?.(runtime)).toBeInstanceOf(HostDeferredAllowPipeline)
  })

  // Capture-01: a command whose observed effects were appended one at a time
  // paid one F_FULLFSYNC per effect; here that cost lands on the main thread.
  it('publishes deferred-allow command effects as one durable batch', () => {
    const probe = new MainSourceProbe(
      'HostProductionBootstrap.ts',
      new URL('./HostProductionBootstrap.ts', import.meta.url)
    )
    const coordinators = probe.construction('HostMutationCompletionCoordinator')
    expect(coordinators).toHaveLength(1)
    expect(probe.propText(coordinators[0]!, 0, 'publishEffects')).toBe(
      '(effects) => publisher.publishDurableBatch(effects)'
    )
  })

  it('keeps the ISO clock and the millisecond clock separate', () => {
    const { supervisorInput, compositionInput } = captureSupervisorInput({
      nowIso: () => '2026-08-06T00:00:00.000Z',
      nowMs: () => 1234
    })
    expect(compositionInput.now?.()).toBe('2026-08-06T00:00:00.000Z')
    expect(supervisorInput.now?.()).toBe(1234)
  })

  it('OFF golden: without queuedStart the composition input carries exactly the pre-3a keys', () => {
    // Captured BEFORE the queued-start wiring was added (A1.61 ruling). The
    // OFF path must stay byte-equivalent: no queuedComposerSend, no lifecycle
    // bind, no shutdown hook, and no extra key of any kind.
    const createComposition = vi.fn((_input: HostMainCompositionInput) => fakeComposition())
    const { supervisorInput, compositionInput } = captureSupervisorInput({ createComposition })
    supervisorInput.createComposition(compositionInput)
    expect(createComposition).toHaveBeenCalledWith(compositionInput)
    expect(createComposition.mock.calls[0][0]).toBe(compositionInput)
    expect(Object.keys(compositionInput).sort()).toEqual(
      [
        'authorityEvaluator',
        'commandExecutor',
        'healthProvider',
        'host',
        'hostCapabilityOffer',
        'pipelineFactory',
        'snapshotDonor',
        'threadOffersProvider',
        'userDataPath'
      ].sort()
    )
    expect(compositionInput.queuedComposerSend).toBeUndefined()
    expect(compositionInput.queuedStartStartingBind).toBeUndefined()
    expect(compositionInput.queuedStartStartedBind).toBeUndefined()
    expect(compositionInput.queuedStartDispatchSettledBind).toBeUndefined()
    expect(compositionInput.queuedStartAbortBind).toBeUndefined()
    expect(compositionInput.queuedStartBeforeShutdown).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ */
/*  Queued start (producer step 3a)                                   */
/* ------------------------------------------------------------------ */

const OFF_COMPOSITION_KEYS = [
  'authorityEvaluator',
  'commandExecutor',
  'healthProvider',
  'host',
  'hostCapabilityOffer',
  'pipelineFactory',
  'snapshotDonor',
  'threadOffersProvider',
  'userDataPath'
]

const ON_QUEUED_START_KEYS = [
  'queuedComposerSend',
  'queuedStartStartingBind',
  'queuedStartDispatchSettledBind',
  'queuedStartAbortBind',
  'queuedStartBeforeShutdown'
]

const COMMAND_ID = '11111111-1111-4111-8111-111111111111'
const ACTION_ID = `host:command:${COMMAND_ID}`
const ACTOR = { actorId: 'actor-1', clientId: 'client-1', clientClass: 'desktop' as const }

type QueuedComposerSend = NonNullable<HostMainCompositionInput['queuedComposerSend']>

function composerSendCommand(
  name: Parameters<QueuedComposerSend>[0]['name'] = 'composer.send'
): Parameters<QueuedComposerSend>[0] {
  return {
    type: 'host.command',
    protocolVersion: 2,
    commandId: COMMAND_ID,
    idempotencyKey: 'desktop:client-1:22222222-2222-4222-8222-222222222222',
    actor: ACTOR,
    name,
    target: { threadId: 'thread-1' },
    arguments: { text: 'hello from Host' },
    issuedAt: '2026-08-09T00:00:00.000Z'
  } as Parameters<QueuedComposerSend>[0]
}

function callContext(): Parameters<QueuedComposerSend>[1] {
  return {
    actor: ACTOR,
    client: { clientId: 'client-1', clientClass: 'desktop', clientVersion: 'test' }
  }
}

function soloChatSources(): HostProductionContextResolverDeps {
  return {
    getChat: (threadId) =>
      threadId === 'thread-1'
        ? {
            appChatId: 'thread-1',
            scope: 'workspace',
            workspaceId: 'workspace-1',
            provider: 'codex',
            archived: false,
            runs: []
          }
        : null,
    getApproval: () => null,
    getQuestion: () => null
  }
}

/**
 * ON harness: a real supervisor over fake server/composition, with the fake
 * composition binding spy handlers through the sanctioned binds exactly as
 * HostMainComposition does, and the root callbacks recorded.
 */
function queuedStartHarness(input: {
  readonly bind?: boolean
  readonly bridge?: HostProductionBootstrapOptions['bridge']
  readonly beforeShutdown?: (adapter: HostProductionQueuedStartAdapter) => void | Promise<void>
}) {
  const adapters: HostProductionQueuedStartAdapter[] = []
  const aborts: Array<(commandId: string) => void> = []
  const order: string[] = []
  const starting = vi.fn()
  const settled = vi.fn()
  const abort = vi.fn()
  let captured: HostMainCompositionInput | null = null
  const supervisor = createHostProductionBootstrap(
    validOptions({
      contextSources: soloChatSources(),
      ...(input.bridge ? { bridge: input.bridge } : {}),
      queuedStart: {
        onAdapter: (adapter, abortQueuedStart) => {
          order.push('adapter')
          adapters.push(adapter)
          aborts.push(abortQueuedStart)
        },
        ...(input.beforeShutdown ? { beforeShutdown: input.beforeShutdown } : {})
      },
      createComposition: (compositionInput) => {
        order.push('composition')
        captured = compositionInput
        if (input.bind !== false) {
          compositionInput.queuedStartStartingBind?.(starting)
          compositionInput.queuedStartDispatchSettledBind?.(settled)
          compositionInput.queuedStartAbortBind?.(abort)
        }
        return {
          ...fakeComposition(),
          shutdown: async () => {
            await compositionInput.queuedStartBeforeShutdown?.()
          }
        }
      }
    })
  )
  const compositionInput = (): HostMainCompositionInput => {
    if (!captured) throw new Error('composition input was never captured')
    return captured
  }
  return { supervisor, adapters, aborts, order, starting, settled, abort, compositionInput }
}

describe('HostProductionBootstrap queued start (producer step 3a)', () => {
  it('rejects a queuedStart option whose onAdapter is not a function', () => {
    expect(() =>
      createHostProductionBootstrap(
        validOptions({
          queuedStart: {} as unknown as HostProductionBootstrapOptions['queuedStart']
        })
      )
    ).toThrow('HostProductionBootstrap requires queuedStart.onAdapter to be a function')
  })

  it('rejects a queuedStart.beforeShutdown that is not a function', () => {
    expect(() =>
      createHostProductionBootstrap(
        validOptions({
          queuedStart: {
            onAdapter: () => {},
            beforeShutdown: 'later'
          } as unknown as HostProductionBootstrapOptions['queuedStart']
        })
      )
    ).toThrow('HostProductionBootstrap requires queuedStart.beforeShutdown to be a function')
  })

  it('ON shape: adds exactly the ACK executor, three sanctioned binds and the shutdown hook', async () => {
    const h = queuedStartHarness({})
    await h.supervisor.start()
    const compositionInput = h.compositionInput()
    for (const key of ON_QUEUED_START_KEYS) {
      expect(typeof (compositionInput as unknown as Record<string, unknown>)[key]).toBe('function')
    }
    // No started bind: the in-main route holds no durable pre-spawn claim, so
    // nothing can ever produce a started view to forward.
    expect(compositionInput.queuedStartStartedBind).toBeUndefined()
    expect(Object.keys(compositionInput).sort()).toEqual(
      [...OFF_COMPOSITION_KEYS, ...ON_QUEUED_START_KEYS].sort()
    )
  })

  it('builds nothing at construction; one generation per composition, rebuilt on restart', async () => {
    const h = queuedStartHarness({})
    expect(h.adapters).toHaveLength(0)

    await h.supervisor.start()
    expect(h.adapters).toHaveLength(1)
    expect(typeof h.adapters[0].register).toBe('function')
    expect(typeof h.aborts[0]).toBe('function')
    // onAdapter runs BEFORE the composition is built so a throwing root cannot
    // strand a built composition the supervisor never receives.
    expect(h.order).toEqual(['adapter', 'composition'])

    await h.supervisor.stop()
    await h.supervisor.start()
    expect(h.adapters).toHaveLength(2)
    expect(h.adapters[1]).not.toBe(h.adapters[0])
    expect(h.aborts[1]).not.toBe(h.aborts[0])
  })

  it('routes glue publications through the composition-bound handlers and forwards startEntities verbatim', async () => {
    const h = queuedStartHarness({})
    await h.supervisor.start()
    const adapter = h.adapters[0]

    expect(
      adapter.register({
        hostCommandActionId: ACTION_ID,
        threadId: 'thread-1',
        authority: {
          actorId: 'actor-1',
          clientId: 'client-1',
          clientClass: 'desktop',
          commandFingerprint: 'fingerprint-1'
        }
      }).kind
    ).toBe('registered')

    const prepared = await adapter.prepared({
      kind: 'prepared',
      hostCommandActionId: ACTION_ID,
      threadId: 'thread-1',
      durablePromptAndStartPersisted: true,
      start: { kind: 'solo', runId: 'run-1' },
      effectRefs: [
        { family: 'run', entityId: 'run-1' },
        { family: 'thread', entityId: 'thread-1' }
      ]
    })
    expect(prepared.kind).toBe('applied')

    expect(h.starting).toHaveBeenCalledTimes(1)
    expect(h.starting).toHaveBeenCalledWith(
      expect.objectContaining({ commandId: COMMAND_ID, threadId: 'thread-1', phase: 'starting' })
    )
    // The 3t regression pin: the third argument must survive the forwarder.
    expect(h.settled).toHaveBeenCalledTimes(1)
    expect(h.settled).toHaveBeenCalledWith(
      COMMAND_ID,
      { status: 'succeeded' },
      { runEntityId: 'run-1' }
    )
  })

  it('hands onAdapter an abort forwarder that reaches the composition-bound abort handler', async () => {
    const h = queuedStartHarness({})
    await h.supervisor.start()
    h.aborts[0](COMMAND_ID)
    expect(h.abort).toHaveBeenCalledTimes(1)
    expect(h.abort).toHaveBeenCalledWith(COMMAND_ID)
  })

  it('refuses by name instead of dropping a call when a handler was never bound', async () => {
    const h = queuedStartHarness({ bind: false })
    await h.supervisor.start()
    expect(() => h.aborts[0](COMMAND_ID)).toThrow(
      'HostProductionBootstrap queued-start abort handler is not bound'
    )
  })

  it('exposes no generation ports before a composition has been assembled', () => {
    const onAdapter = vi.fn()
    const { compositionInput } = captureSupervisorInput({
      queuedStart: { onAdapter }
    })
    expect(onAdapter).not.toHaveBeenCalled()
    expect(Object.keys(compositionInput).sort()).toEqual([...OFF_COMPOSITION_KEYS].sort())
  })

  it('drives a real composer.send through the ACK executor and abandons proof via the abort bind', async () => {
    // Bridge success with neither a run identity nor a queue reservation:
    // the prompt may have been delivered, so the receipt goes indeterminate
    // through the composition's abort bind, never a false failure.
    const executeComposerPrompt = vi.fn(async () => ({ executed: true, message: 'sent' }))
    const h = queuedStartHarness({ bridge: { ...mockBridge(), executeComposerPrompt } })
    await h.supervisor.start()

    const result = await h
      .compositionInput()
      .queuedComposerSend?.(composerSendCommand(), callContext())
    expect(result).toEqual({ status: 'succeeded', resultSummary: 'run_queued_unproven' })
    expect(executeComposerPrompt).toHaveBeenCalledTimes(1)
    expect(executeComposerPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'composerPrompt',
        actionId: ACTION_ID,
        workspaceId: 'workspace-1',
        threadId: 'thread-1',
        provider: 'codex',
        text: 'hello from Host'
      })
    )
    expect(h.abort).toHaveBeenCalledWith(COMMAND_ID)
    expect(h.settled).not.toHaveBeenCalled()
    expect(h.adapters[0].get(ACTION_ID)).toMatchObject({ phase: 'registered' })
  })

  it('shutdown hook fences the executor and adapter before the root drains, then drains the executor', async () => {
    const observed: string[] = []
    let hooksSeen: { register: string; send: unknown } | null = null
    const h = queuedStartHarness({
      beforeShutdown: async (adapter) => {
        observed.push('root')
        expect(adapter).toBe(h.adapters[0])
        // By the time the root drains, both fences must already be up.
        const register = adapter.register({
          hostCommandActionId: ACTION_ID,
          threadId: 'thread-1',
          authority: {
            actorId: 'actor-1',
            clientId: 'client-1',
            clientClass: 'desktop',
            commandFingerprint: 'fingerprint-1'
          }
        })
        const send = await h
          .compositionInput()
          .queuedComposerSend?.(composerSendCommand(), callContext())
        hooksSeen = {
          register: register.kind === 'refused' ? register.reason : register.kind,
          send
        }
      }
    })
    await h.supervisor.start()

    // Before the hook the generation is open for business.
    await expect(
      h.compositionInput().queuedComposerSend?.(composerSendCommand('run.cancel'), callContext())
    ).resolves.toMatchObject({ status: 'failed', errorCode: 'not_governed_mutation' })

    await expect(h.compositionInput().queuedStartBeforeShutdown?.()).resolves.toBeUndefined()
    expect(observed).toEqual(['root'])
    expect(hooksSeen).toEqual({
      register: 'shutting_down',
      send: { status: 'failed', errorCode: 'shutting_down', errorMessage: expect.any(String) }
    })
    // Idempotent: a second call neither throws nor re-runs anything it must not.
    await expect(h.compositionInput().queuedStartBeforeShutdown?.()).resolves.toBeUndefined()
  })

  it('a restarted handle receives a fresh, unfenced generation rather than the stopped fence', async () => {
    const h = queuedStartHarness({})
    await h.supervisor.start()
    await h.compositionInput().queuedStartBeforeShutdown?.()
    await h.supervisor.stop()

    await h.supervisor.start()
    expect(
      h.adapters[1].register({
        hostCommandActionId: ACTION_ID,
        threadId: 'thread-1',
        authority: {
          actorId: 'actor-1',
          clientId: 'client-1',
          clientClass: 'desktop',
          commandFingerprint: 'fingerprint-1'
        }
      }).kind
    ).toBe('registered')
    await expect(
      h.compositionInput().queuedComposerSend?.(composerSendCommand('run.cancel'), callContext())
    ).resolves.toMatchObject({ status: 'failed', errorCode: 'not_governed_mutation' })
  })

  it('keeps a delayed real-composition shutdown on its own generation across immediate stopSync/start', async () => {
    const adapters: HostProductionQueuedStartAdapter[] = []
    const inputs: HostMainCompositionInput[] = []
    const compositions: HostMainComposition[] = []
    const drainedAdapters: HostProductionQueuedStartAdapter[] = []
    let releaseOldDrain!: () => void
    const oldDrain = new Promise<void>((resolve) => {
      releaseOldDrain = resolve
    })
    let markOldDrainEntered!: () => void
    const oldDrainEntered = new Promise<void>((resolve) => {
      markOldDrainEntered = resolve
    })
    let oldShutdown: Promise<void> | undefined
    let restarting: Promise<void> | undefined
    let oldShutdownComplete = false
    const supervisor = createHostProductionBootstrap(
      validOptions({
        userDataPath: profilePath(),
        contextSources: soloChatSources(),
        queuedStart: {
          onAdapter: (adapter) => {
            adapters.push(adapter)
          },
          beforeShutdown: async (adapter) => {
            drainedAdapters.push(adapter)
            if (drainedAdapters.length === 1) {
              markOldDrainEntered()
              await oldDrain
            }
          }
        },
        createComposition: (input) => {
          inputs.push(input)
          const composition = createHostMainComposition(input)
          compositions.push(composition)
          return composition
        }
      })
    )
    const register = (adapter: HostProductionQueuedStartAdapter) =>
      adapter.register({
        hostCommandActionId: ACTION_ID,
        threadId: 'thread-1',
        authority: {
          actorId: 'actor-1',
          clientId: 'client-1',
          clientClass: 'desktop',
          commandFingerprint: 'fingerprint-1'
        }
      })

    try {
      await supervisor.start()
      supervisor.stopSync()
      // Obtain the same real shutdown promise that stopSync fired without
      // awaiting it: start must replace the composition before its hook runs.
      oldShutdown = compositions[0].shutdown().then(() => {
        oldShutdownComplete = true
      })
      restarting = supervisor.start()
      expect(adapters).toHaveLength(2)
      expect(drainedAdapters).toEqual([])

      await oldDrainEntered
      await restarting
      expect(oldShutdownComplete).toBe(false)
      expect(drainedAdapters).toEqual([adapters[0]])
      expect(inputs[1]).not.toBe(inputs[0])
      expect(inputs[1].queuedComposerSend).not.toBe(inputs[0].queuedComposerSend)
      expect(register(adapters[0])).toMatchObject({ kind: 'refused', reason: 'shutting_down' })
      expect(register(adapters[1])).toMatchObject({ kind: 'registered' })
      await expect(
        inputs[0].queuedComposerSend?.(composerSendCommand('run.cancel'), callContext())
      ).resolves.toMatchObject({ errorCode: 'shutting_down' })
      await expect(
        inputs[1].queuedComposerSend?.(composerSendCommand('run.cancel'), callContext())
      ).resolves.toMatchObject({ errorCode: 'not_governed_mutation' })

      releaseOldDrain()
      await oldShutdown
      expect(supervisor.isRunning).toBe(true)
      await expect(
        inputs[1].queuedComposerSend?.(composerSendCommand('run.cancel'), callContext())
      ).resolves.toMatchObject({ errorCode: 'not_governed_mutation' })
      await supervisor.stop()
      expect(drainedAdapters).toEqual(adapters)
    } finally {
      releaseOldDrain()
      await oldShutdown
      await restarting
      await supervisor.stop()
    }
  })
})

/* ------------------------------------------------------------------ */
/*  Queued-start receipt integration                                  */
/* ------------------------------------------------------------------ */

describe('HostProductionBootstrap queued-start receipt integration', () => {
  it.each(['solo', 'ensemble'] as const)(
    'publishes a durable %s start before terminal success and serializes other projection work',
    async (mode) => {
      const gate = () => {
        let resolve!: () => void
        const promise = new Promise<void>((done) => {
          resolve = done
        })
        return { promise, resolve }
      }
      const journal = gate()
      const publication = gate()
      const publicationEntered = vi.fn()
      const startedAt = '2026-09-24T00:00:00.000Z'
      const runId = 'provider-run-bootstrap'
      const roundId = 'ensemble-round-bootstrap'
      const promptMessageId = 'prompt-bootstrap'
      const stored: Pick<ChatRecord, 'appChatId' | 'messages' | 'ensemble'> & {
        runs: Array<ChatRun & { provider: 'codex' }>
      } = {
        appChatId: 'thread-1',
        runs: [],
        messages: [],
        ...(mode === 'ensemble'
          ? { ensemble: { enabled: true, maxParticipants: 2, participants: [] } }
          : {})
      }
      const producers: {
        solo: ReturnType<typeof createHostBridgeQueuedStartProducer> | null
        round: ReturnType<typeof createHostBridgeQueuedRoundStartProducer> | null
      } = { solo: null, round: null }
      const soloBarrier = vi.fn((_identity: HostBridgeQueuedStartIdentity) => journal.promise)
      const roundBarrier = vi.fn((_identity: HostBridgeQueuedRoundStartIdentity) => journal.promise)
      const binding = createHostBridgeQueuedStartProducerBinding({
        persistenceEnabled: () => true,
        awaitPromptAndStartDurable: soloBarrier,
        verifyPromptAndStart: (identity) => verifyHostBridgeQueuedStartRecord(stored, identity),
        onCurrentProducer: (producer) => {
          producers.solo = producer
        },
        roundStart: {
          persistenceEnabled: () => true,
          awaitPromptAndRoundDurable: roundBarrier,
          verifyPromptAndRound: (identity) =>
            verifyHostBridgeQueuedRoundStartRecord(stored, identity),
          onCurrentProducer: (producer) => {
            producers.round = producer
          }
        }
      })
      const compositions: HostMainComposition[] = []
      const runtimes: HostRuntimeBootstrap[] = []
      const durableEvents: HostDeltaAppendEvent[] = []
      const order: string[] = []
      let title = 'Queued-start integration'
      let holdNextSnapshot = false
      let beforeParticipants: Promise<void> | undefined
      let positionBeforeSelection: HostCursorPosition | undefined
      let receiptBeforeSelection:
        | ReturnType<HostRuntimeBootstrap['receiptStore']['getByCommandId']>
        | undefined
      let receiptAtStartAppend:
        | ReturnType<HostRuntimeBootstrap['receiptStore']['getByCommandId']>
        | undefined
      const executeComposerPrompt = vi.fn<
        HostProductionBootstrapOptions['bridge']['executeComposerPrompt']
      >(async (action) => {
        stored.messages.push({
          id: promptMessageId,
          role: 'user',
          content: action.text,
          timestamp: startedAt
        })
        stored.runs.push({
          runId,
          promptMessageId,
          provider: 'codex',
          status: 'running',
          startedAt
        })
        const observation = producers.solo?.observeDispatch({
          hostCommandActionId: action.actionId,
          threadId: action.threadId,
          runId,
          promptMessageId,
          provider: 'codex'
        })
        // Controlled provider boundary: invocation is observed, but the full
        // turn never completes in this test. Its result cannot prove a start.
        observation?.observer.onAdapterInvoked?.({ appRunId: runId, provider: 'codex' })
        return { executed: true, message: 'Solo dispatch registered', data: { appRunId: runId } }
      })
      const executeEnsembleSteer = vi.fn<
        HostProductionBootstrapOptions['bridge']['executeEnsembleSteer']
      >(async (action) => {
        const observation = producers.round?.observeRound({
          hostCommandActionId: action.actionId,
          threadId: action.threadId
        })
        const result = dispatchObservedHostBridgeRound(observation, (observer) => {
          if (!stored.ensemble) throw new Error('expected an Ensemble fixture')
          stored.ensemble.activeRound = {
            roundId,
            status: 'running',
            prompt: action.text,
            startedAt,
            participants: []
          }
          stored.messages.push({
            id: `ensemble-user-${roundId}`,
            role: 'user',
            content: action.text,
            timestamp: startedAt,
            metadata: { kind: 'ensembleRoundPrompt', ensembleRoundId: roundId }
          })
          const observed = createEnsembleRoundStartObservation(observer, roundId)
          observed.reserved()
          beforeParticipants = observed.beforeParticipants()
          return { status: 'started', roundId }
        })
        return {
          executed: true,
          message: 'Ensemble round started',
          data: { actionKind: 'ensembleSteer', result }
        }
      })
      const executeSetWatchedThread = vi.fn<
        HostProductionBootstrapOptions['bridge']['executeSetWatchedThread']
      >(async () => {
        order.push('ordinary-command')
        const runtime = runtimes[0]
        positionBeforeSelection = runtime.getPosition()
        receiptBeforeSelection = runtime.receiptStore.getByCommandId(COMMAND_ID, ACTOR)
        // A real projection change gives this command its own later cursor.
        title = 'Selected after durable start'
        return { executed: true, message: 'Thread selected' }
      })
      const supervisor = createHostProductionBootstrap(
        validOptions({
          userDataPath: profilePath(),
          contextSources: {
            ...soloChatSources(),
            getChat: (threadId) =>
              threadId === stored.appChatId
                ? { ...stored, workspaceId: 'workspace-1', scope: 'workspace', provider: 'codex' }
                : null
          },
          chatList: {
            getChatList: () => [
              {
                appChatId: stored.appChatId,
                workspaceId: 'workspace-1',
                title,
                archived: false,
                updatedAt: Date.parse(startedAt) + stored.messages.length,
                messageCount: stored.messages.length,
                provider: 'codex'
              }
            ]
          },
          runs: {
            listRuns: () =>
              stored.runs.map((run) => ({
                runId: run.runId,
                threadId: stored.appChatId,
                providerId: run.provider,
                providerOutcome: 'running',
                startedAt: Date.parse(startedAt)
              }))
          },
          rounds: {
            listRounds: () =>
              stored.ensemble?.activeRound
                ? [
                    {
                      roundId: stored.ensemble.activeRound.roundId,
                      threadId: stored.appChatId,
                      status: 'running',
                      startedAt: Date.parse(startedAt),
                      participantIds: [],
                      providerRunIds: []
                    }
                  ]
                : []
          },
          bridge: {
            ...mockBridge(),
            executeComposerPrompt,
            executeEnsembleSteer,
            executeSetWatchedThread
          },
          queuedStart: binding,
          createComposition: (input) => {
            const composition = createHostMainComposition({
              ...input,
              // Explicit test authorization. Production's default deferral
              // policy is covered separately; no approval service runs here.
              authorityEvaluator: () => ({ decision: 'allowed' }),
              pipelineFactory: (runtime) => {
                runtimes.push(runtime)
                return input.pipelineFactory!(runtime)
              },
              snapshotDonor: async () => {
                if (holdNextSnapshot) {
                  // One-shot hold at the publication's AFTER snapshot. Other
                  // readers are free to run, so only the real shared queue can
                  // keep the command and reconciler behind this publication.
                  holdNextSnapshot = false
                  publicationEntered()
                  await publication.promise
                }
                return input.snapshotDonor()
              }
            })
            compositions.push(composition)
            return composition
          }
        })
      )
      let selection: ReturnType<HostMainComposition['authority']['command']> | undefined
      let reconciliation: ReturnType<HostMainComposition['reconcileProjection']> | undefined
      try {
        await supervisor.start()
        const composition = compositions[0]
        const runtime = runtimes[0]
        const initialPosition = composition.getPosition()
        const startFamily = mode === 'solo' ? 'run' : 'round'
        const startEntityId = mode === 'solo' ? runId : roundId
        composition.subscribeDeltas((event) => {
          durableEvents.push(event)
          if (event.record.envelope.family === startFamily) {
            order.push('start-effect')
            receiptAtStartAppend = runtime.receiptStore.getByCommandId(COMMAND_ID, ACTOR)
          }
        })

        const queued = await composition.authority.command(callContext(), composerSendCommand())
        expect(queued).toMatchObject({ ok: true, value: { status: 'pending', phase: 'queued' } })
        const barrier = mode === 'solo' ? soloBarrier : roundBarrier
        expect(barrier).toHaveBeenCalledExactlyOnceWith({
          hostCommandActionId: ACTION_ID,
          threadId: stored.appChatId,
          ...(mode === 'solo' ? { runId, promptMessageId, provider: 'codex' } : { roundId })
        })
        // Leave the journal unresolved across a real scheduling window: an
        // early Bridge result or an ignored barrier must not certify a start.
        await new Promise((resolve) => setTimeout(resolve, 50))
        await expect(
          composition.authority.receipt(callContext(), { commandId: COMMAND_ID })
        ).resolves.toMatchObject({
          ok: true,
          outcome: 'found',
          receipt: { status: 'pending', phase: 'queued' }
        })
        expect(durableEvents).toEqual([])
        expect(composition.getPosition()).toEqual(initialPosition)

        holdNextSnapshot = true
        journal.resolve()
        await vi.waitFor(() => expect(publicationEntered).toHaveBeenCalledOnce())
        await expect(
          composition.authority.receipt(callContext(), { commandId: COMMAND_ID })
        ).resolves.toMatchObject({
          ok: true,
          outcome: 'found',
          receipt: { status: 'pending', phase: 'started' }
        })
        expect(durableEvents).toEqual([])

        selection = composition.authority.command(callContext(), {
          ...composerSendCommand('thread.select'),
          commandId: '33333333-3333-4333-8333-333333333333',
          idempotencyKey: 'desktop:client-1:44444444-4444-4444-8444-444444444444',
          arguments: {}
        })
        reconciliation = composition.reconcileProjection().then((result) => {
          order.push('reconcile')
          return result
        })
        // A real timer window makes the serialization assertion sensitive to
        // removing either queue injection, rather than to microtask ordering.
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(executeSetWatchedThread).not.toHaveBeenCalled()
        expect(order).toEqual([])
        expect(composition.getPosition()).toEqual(initialPosition)

        publication.resolve()
        const selected = await selection
        expect(selected).toMatchObject({ ok: true, value: { status: 'succeeded' } })
        expect(['unchanged', 'published']).toContain((await reconciliation).kind)
        await beforeParticipants
        expect(order).toEqual(['start-effect', 'ordinary-command', 'reconcile'])
        expect(receiptAtStartAppend).toMatchObject({
          kind: 'found',
          receipt: { status: 'pending' }
        })
        expect(receiptBeforeSelection).toMatchObject({
          kind: 'found',
          receipt: { status: 'succeeded', phase: 'started', resultSummary: 'run_started' }
        })
        const terminal = await composition.authority.receipt(callContext(), {
          commandId: COMMAND_ID
        })
        if (!terminal.ok || terminal.outcome !== 'found') throw new Error('missing start receipt')
        const receipt = terminal.receipt
        expect(receipt).toMatchObject({
          status: 'succeeded',
          phase: 'started',
          resultSummary: 'run_started'
        })
        expect(positionBeforeSelection).toEqual({
          generation: receipt.generation,
          cursor: receipt.cursor
        })
        expect(receipt.cursor).toBeGreaterThan(initialPosition.cursor)
        if (!selected.ok) throw new Error('ordinary command failed')
        expect(selected.value.cursor).toBeGreaterThan(receipt.cursor)
        const startBatch = durableEvents.filter((event) => event.position.cursor <= receipt.cursor)
        expect(startBatch.map((event) => event.record.envelope.family)).toEqual(
          mode === 'solo' ? ['run', 'thread'] : ['thread', 'round']
        )
        const startEffect = startBatch.find((event) => event.record.envelope.family === startFamily)
        expect(startEffect?.record.envelope).toMatchObject({
          kind: 'upsert',
          entityId: startEntityId,
          payload: { threadId: stored.appChatId }
        })
        expect(startBatch.at(-1)?.position).toEqual({
          generation: receipt.generation,
          cursor: receipt.cursor
        })
        if (mode === 'ensemble') {
          expect(startEffect?.record.envelope.payload).toMatchObject({ providerRunIds: [] })
          expect(executeComposerPrompt).not.toHaveBeenCalled()
          expect(executeEnsembleSteer).toHaveBeenCalledOnce()
        } else {
          expect(executeComposerPrompt).toHaveBeenCalledOnce()
          expect(executeEnsembleSteer).not.toHaveBeenCalled()
        }
        // Replaying the same Host command returns its receipt, never a second
        // Bridge invocation or a second provider/round start.
        await expect(
          composition.authority.command(callContext(), composerSendCommand())
        ).resolves.toEqual({ ok: true, value: receipt })
        expect(
          executeComposerPrompt.mock.calls.length + executeEnsembleSteer.mock.calls.length
        ).toBe(1)

        await supervisor.stop()
        expect(producers).toEqual({ solo: null, round: null })
        const recovered = new HostRuntimeBootstrap({ hostDataDir: composition.hostDataDir })
        expect(recovered.receiptStore.getByCommandId(COMMAND_ID, ACTOR)).toMatchObject({
          kind: 'found',
          receipt: {
            status: 'succeeded',
            resultSummary: 'run_started',
            generation: receipt.generation,
            cursor: receipt.cursor
          }
        })
        // Reload the real journal/checkpoint: the exact start effect and the
        // final effect at the receipt cursor must both survive teardown.
        for (const event of startBatch) {
          expect(recovered.deltaStore.getByCursor(event.position.cursor)?.envelope).toEqual(
            event.record.envelope
          )
        }
      } finally {
        journal.resolve()
        publication.resolve()
        await Promise.allSettled([selection, reconciliation, beforeParticipants])
        await supervisor.stop()
      }
    }
  )
})

/* ------------------------------------------------------------------ */
/*  Supervisor assembly                                               */
/* ------------------------------------------------------------------ */

describe('HostProductionBootstrap assembly', () => {
  it('returns a HostSupervisor handle', () => {
    const supervisor = createHostProductionBootstrap(validOptions())

    expect(supervisor).toBeDefined()
    expect(typeof supervisor.start).toBe('function')
    expect(typeof supervisor.stop).toBe('function')
    expect(typeof supervisor.stopSync).toBe('function')
    expect(typeof supervisor.isRunning).toBe('boolean')
    expect(typeof supervisor.isStopped).toBe('boolean')
    expect(typeof supervisor.healthProvider).toBe('function')
  })

  it('supervisor is not running after construction', () => {
    const supervisor = createHostProductionBootstrap(validOptions())

    expect(supervisor.isRunning).toBe(false)
    expect(supervisor.isStopped).toBe(false)
  })

  it('healthProvider returns honest offline projection before start', async () => {
    const supervisor = createHostProductionBootstrap(validOptions())

    const health = await supervisor.healthProvider()
    expect(health.hostStatus).toBe('offline')
    expect(health.supervised).toBe(false)
    // Supervisor is always live once constructed — 'live' is the honest freshness.
    expect(health.freshness).toBe('live')
  })

  it('reports supervised health once running, and offline again after stop', async () => {
    let captured: HostMainCompositionInput | null = null
    const supervisor = createHostProductionBootstrap(
      validOptions({
        createComposition: (input) => {
          captured = input
          return fakeComposition()
        }
      })
    )
    await supervisor.start()

    const compositionInput = captured as HostMainCompositionInput | null
    if (!compositionInput) throw new Error('composition input was never captured')

    await expect(Promise.resolve(compositionInput.healthProvider())).resolves.toMatchObject({
      hostStatus: 'ok',
      supervised: true
    })

    supervisor.stopSync()
    await expect(Promise.resolve(compositionInput.healthProvider())).resolves.toMatchObject({
      hostStatus: 'offline',
      supervised: false
    })
  })

  it('fails loudly if health is requested before assembly completes', () => {
    // The pre-back-patch window is real and reachable: inside the supervisor
    // factory, healthProviderRef has not been assigned yet. This replaces the
    // former FALLBACK_HEALTH branch, which was unreachable dead code.
    expect(() =>
      createHostProductionBootstrap(
        validOptions({
          createSupervisor: (input) => {
            input.compositionInput.healthProvider()
            return fakeSupervisor()
          }
        })
      )
    ).toThrow('health requested before supervisor assembly completed')
  })
})

/* ------------------------------------------------------------------ */
/*  allowCrashRestart pin (R2)                                        */
/* ------------------------------------------------------------------ */

describe('allowCrashRestart: false (R2 pin)', () => {
  it('passes allowCrashRestart:false LITERALLY to the supervisor', () => {
    // A pin on the argument's absence would still pass if HostSupervisor's
    // default ever flipped. This asserts the value we actually send.
    const { supervisorInput } = captureSupervisorInput()
    expect(supervisorInput.allowCrashRestart).toBe(false)
  })

  it('does not retry a failed start — a crashed Host never silently respawns', async () => {
    // Behavioural counterpart. If allowCrashRestart were true the supervisor
    // would enter its backoff loop and call the composition factory
    // repeatedly instead of rejecting, so this fails on exactly that flip.
    const createComposition = vi.fn(() => {
      throw new Error('composition exploded')
    })

    const supervisor = createHostProductionBootstrap(
      validOptions({ createComposition: createComposition as never })
    )

    await expect(supervisor.start()).rejects.toThrow('composition exploded')
    expect(createComposition).toHaveBeenCalledTimes(1)
    expect(supervisor.isRunning).toBe(false)
  })

  it('explicit stop is persistent — isStopped set by stop()', async () => {
    const supervisor = createHostProductionBootstrap(validOptions())

    expect(supervisor.isStopped).toBe(false)

    await supervisor.stop()
    expect(supervisor.isStopped).toBe(true)

    supervisor.stopSync()
    expect(supervisor.isStopped).toBe(true)
  })
})

/* ------------------------------------------------------------------ */
/*  Re-entrancy                                                       */
/* ------------------------------------------------------------------ */

describe('HostProductionBootstrap re-entrancy', () => {
  it('returns the SAME supervisor for the same userDataPath', () => {
    // Two supervisors over one data dir = two runtime bootstraps over one
    // journal (the forbidden second journal) + two listeners on one socket.
    const userDataPath = uniquePath()
    const first = createHostProductionBootstrap(validOptions({ userDataPath }))
    const second = createHostProductionBootstrap(validOptions({ userDataPath }))

    expect(second).toBe(first)
  })

  it('treats a trailing slash as the same directory', () => {
    // NOTE: hostRuntimeDataDir uses path.join, which already normalises a
    // trailing slash and `..` segments. This pin guards that behaviour rather
    // than the resolve() below — recorded honestly because the reviewed
    // premise ("a trailing slash silently creates two supervisors") does not
    // actually hold against join.
    const userDataPath = uniquePath()
    const first = createHostProductionBootstrap(validOptions({ userDataPath }))
    const second = createHostProductionBootstrap(validOptions({ userDataPath: `${userDataPath}/` }))

    expect(second).toBe(first)
  })

  it('treats a relative and absolute spelling of one directory as the same', () => {
    // THIS is what resolve() buys over join(): join leaves a relative path
    // relative, so `data` and `/cwd/data` would key differently and admit two
    // supervisors onto one journal. Goes red if resolve() is removed.
    const relative = `tmp-host-bootstrap-rel-${(pathSeq += 1)}`
    const first = createHostProductionBootstrap(validOptions({ userDataPath: relative }))
    const second = createHostProductionBootstrap(
      validOptions({ userDataPath: join(process.cwd(), relative) })
    )

    expect(second).toBe(first)
  })

  it('builds only ONE supervisor for repeated calls on one directory', () => {
    const createSupervisor = vi.fn(() => fakeSupervisor())
    const userDataPath = uniquePath()

    createHostProductionBootstrap(validOptions({ userDataPath, createSupervisor }))
    createHostProductionBootstrap(validOptions({ userDataPath, createSupervisor }))

    expect(createSupervisor).toHaveBeenCalledTimes(1)
  })

  it('keeps distinct directories independent', () => {
    const a = createHostProductionBootstrap(validOptions())
    const b = createHostProductionBootstrap(validOptions())
    expect(a).not.toBe(b)
  })

  it('purges on stop so the Host can be started again afterwards', async () => {
    // Explicit stop is user-controlled and must be reversible. Without the
    // purge, every later caller would receive the dead stopped handle.
    const userDataPath = uniquePath()
    const first = createHostProductionBootstrap(validOptions({ userDataPath }))
    await first.start()
    await first.stop()
    expect(first.isStopped).toBe(true)

    const restarted = createHostProductionBootstrap(validOptions({ userDataPath }))
    expect(restarted).not.toBe(first)
    expect(restarted.isStopped).toBe(false)

    await restarted.start()
    expect(restarted.isRunning).toBe(true)
  })

  it('purges on stopSync too', () => {
    const userDataPath = uniquePath()
    const first = createHostProductionBootstrap(validOptions({ userDataPath }))
    first.stopSync()

    const restarted = createHostProductionBootstrap(validOptions({ userDataPath }))
    expect(restarted).not.toBe(first)
    expect(restarted.isStopped).toBe(false)
  })

  it('stopSync never throws when teardown throws, and logs the failure', () => {
    const lines: string[] = []
    const supervisor = createHostProductionBootstrap(
      validOptions({
        log: (line) => lines.push(line),
        createSupervisor: () =>
          ({
            ...fakeSupervisor(),
            stopSync: () => {
              throw new Error('port stranded')
            }
          }) as unknown as HostSupervisor
      })
    )

    // An exception escaping a will-quit handler would abort application quit.
    expect(() => supervisor.stopSync()).not.toThrow()
    expect(lines.some((l) => l.includes('stopSync error'))).toBe(true)
  })

  it('stop and stopSync are idempotent', async () => {
    const supervisor = createHostProductionBootstrap(validOptions())
    await expect(
      (async () => {
        await supervisor.stop()
        await supervisor.stop()
        supervisor.stopSync()
        supervisor.stopSync()
      })()
    ).resolves.toBeUndefined()
  })
})

/* ------------------------------------------------------------------ */
/*  Import isolation                                                  */
/* ------------------------------------------------------------------ */

const SOURCE = readFileSync(join(__dirname, 'HostProductionBootstrap.ts'), 'utf-8')

/** Strip comments so prose about Electron cannot satisfy or break a code pin. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('import isolation', () => {
  it('does not import electron', () => {
    expect(SOURCE).not.toMatch(/from\s+['"]electron['"]/)
    expect(SOURCE).not.toMatch(/require\s*\(\s*['"]electron['"]/)
  })

  it('never names a window surface in code', () => {
    // AC-critical: the Host lifecycle is anchored to the process, never to a
    // BrowserWindow, so an active mission survives a renderer reload.
    const code = stripComments(SOURCE)
    expect(code).not.toMatch(/BrowserWindow/)
    expect(code).not.toMatch(/webContents/)
  })

  it('does not import AppStore or Bridge value modules', () => {
    const valueImportPatterns = [
      /import\s+(?!type)(?!\{[^}]*\})\s*.*from\s+['"]\.\.\/AppStore/,
      /import\s+(?!type)(?!\{[^}]*\})\s*.*from\s+['"]\.\.\/BridgeActionExecutor/,
      /import\s+(?!type)(?!\{[^}]*\})\s*.*from\s+['"]\.\.\/BridgeActionPayload/,
      /import\s+(?!type)(?!\{[^}]*\})\s*.*from\s+['"]\.\.\/store/
    ]
    for (const pattern of valueImportPatterns) {
      expect(SOURCE).not.toMatch(pattern)
    }
  })

  it('does not import from composition roots', () => {
    expect(SOURCE).not.toMatch(/from\s+['"]\.\.\/index/)
    expect(SOURCE).not.toMatch(/from\s+['"]\.\.\/App/)
    expect(SOURCE).not.toMatch(/from\s+['"]\.\.\/EnsembleOrchestrator/)
  })
})
