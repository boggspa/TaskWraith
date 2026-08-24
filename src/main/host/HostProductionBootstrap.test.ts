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

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  createHostProductionBootstrap,
  resetHostProductionBootstrapForTests
} from './HostProductionBootstrap'
import type { HostProductionBootstrapOptions } from './HostProductionBootstrap'
import type { HostProductionContextResolverDeps } from './HostProductionContextResolvers'
import type {
  HostProductionChatListPort,
  HostProductionProviderListPort
} from '../../host-runtime/HostProductionSuppliers'
import { HostDeferredAllowPipeline } from '../../host-runtime/HostDeferredAllowPipeline'
import type { HostLocalServer, HostLocalServerOptions } from '../../host-runtime/HostLocalServer'
import type {
  HostMainComposition,
  HostMainCompositionInput
} from '../../host-runtime/HostMainComposition'
import type { HostRuntimeBootstrap } from '../../host-runtime/HostRuntimeBootstrap'
import type { HostSupervisor, HostSupervisorInput } from '../../host-runtime/HostSupervisor'

/* ------------------------------------------------------------------ */
/*  Scaffolding                                                       */
/* ------------------------------------------------------------------ */

const MOCK_HOST = { hostId: 'test-host-1', hostVersion: '0.0.0-test' }

let pathSeq = 0
function uniquePath(): string {
  pathSeq += 1
  return `/tmp/host-bootstrap-test-${pathSeq}`
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

/* ------------------------------------------------------------------ */
/*  Options validation                                                */
/* ------------------------------------------------------------------ */

describe('HostProductionBootstrap options validation', () => {
  it('rejects missing options object', () => {
    expect(() =>
      createHostProductionBootstrap(undefined as unknown as HostProductionBootstrapOptions)
    ).toThrow('HostProductionBootstrap requires an options object')
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

  it('keeps the ISO clock and the millisecond clock separate', () => {
    const { supervisorInput, compositionInput } = captureSupervisorInput({
      nowIso: () => '2026-08-06T00:00:00.000Z',
      nowMs: () => 1234
    })
    expect(compositionInput.now?.()).toBe('2026-08-06T00:00:00.000Z')
    expect(supervisorInput.now?.()).toBe(1234)
  })
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
