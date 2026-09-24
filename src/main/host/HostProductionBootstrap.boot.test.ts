/**
 * Wave 4.4 — PRODUCTION BOOT PROOF.
 *
 * THIS FILE EXISTS BECAUSE OF ONE OMISSION, AND THE OMISSION IS THE POINT.
 *
 * `createHostProductionBootstrap` accepts an OPTIONAL `createComposition` seam
 * that defaults to the real `createHostMainComposition`. Every test in
 * `HostProductionBootstrap.test.ts` injects `createComposition: () =>
 * fakeComposition()` and `createServer: () => fakeServer()`. Those are correct
 * for what that file proves — assembly, re-entrancy, teardown — but the
 * consequence is that THE REAL COMPOSITION AND THE REAL LOCAL SERVER HAVE
 * NEVER BEEN BOOTED BY ANY TEST.
 *
 * So the arc has been shipping a Host that was never observed to start, serve,
 * or stop. This file omits BOTH seams and boots the real thing. The only fakes
 * are `chatList` and `bridge`, which are genuinely external boundaries
 * (AppStore / BridgeActionExecutor) rather than parts of the Host transport
 * path. Everything between the supervisor and the socket is real.
 *
 * SEAT REQUIREMENT: this suite performs a real unix-domain socket listen.
 * Sandboxed seats that return EPERM on `listen()` cannot run it. That limit is
 * seat-specific, not environmental.
 *
 * SAFETY: every test uses a fresh `fs.mkdtemp` directory. It must NEVER use a
 * real userData path — a live TaskWraith app would collide with it, and the
 * teardown assertions delete Host artifacts.
 */

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  decodeTaskWraithHostDiscovery,
  taskWraithHostDiscoveryPath,
  taskWraithHostTokenPath
} from '../../shared/taskWraithHostPaths.node'
import {
  HOST_PROTOCOL_VERSION,
  TASKWRAITH_DESKTOP_HOST_ACTOR,
  TASKWRAITH_DESKTOP_HOST_CLIENT_ID,
  type HostActorIdentity,
  type HostCommand,
  type HostCommandName
} from '../../shared/hostProtocol'

import type { BridgeQuestionReplyAction } from '../BridgeActionPayload'
import { RemoteQuestionRegistry } from '../RemoteQuestionRegistry'
import type { ProviderId } from '../store/types'
import { HostProjectionClient } from './HostProjectionClient'
import {
  createHostProductionBootstrap,
  type HostProductionBootstrapOptions
} from './HostProductionBootstrap'
import { createHostProductionQuestionShadow } from './HostProductionQuestionShadow'
import type { HostSupervisor } from '../../host-runtime/HostSupervisor'
import { publishHostThreadRecordTransfer } from '../../host-runtime/HostThreadRecordTransfer'

const HOST_ID = 'boot-proof-host-0001'
const HOST_VERSION = '0.0.0-boot-proof'
const MUTATION_CLIENT_ID = 'wave-44-mutation-proof'
const MUTATION_ACTOR: HostActorIdentity = {
  actorId: MUTATION_CLIENT_ID,
  clientId: MUTATION_CLIENT_ID,
  clientClass: 'desktop'
}

let userDataPath: string
let supervisor: HostSupervisor | null = null
let client: HostProjectionClient | null = null

/** Genuinely external boundary — not part of the Host transport path. */
function externalChatList(): HostProductionBootstrapOptions['chatList'] {
  return { getChatList: vi.fn().mockReturnValue([]) }
}

/** Genuinely external boundary — not part of the Host transport path. */
function externalBridge(): HostProductionBootstrapOptions['bridge'] {
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

/** Live-source boundary for governed mutations; this read-only boot proof has none. */
function externalContextSources(): HostProductionBootstrapOptions['contextSources'] {
  return {
    getChat: vi.fn().mockReturnValue(null),
    getApproval: vi.fn().mockReturnValue(null),
    getQuestion: vi.fn().mockReturnValue(null)
  }
}

/**
 * NOTE THE ABSENCES. `createComposition` and `createServer` are deliberately
 * NOT provided, so the production defaults run. Adding either one back turns
 * this suite into a restatement of the existing fake-driven tests.
 */
function productionOptions(): HostProductionBootstrapOptions {
  return {
    userDataPath,
    chatList: externalChatList(),
    bridge: externalBridge(),
    contextSources: externalContextSources(),
    host: { hostId: HOST_ID, hostVersion: HOST_VERSION }
  }
}

function readOnlyClient(): HostProjectionClient {
  return new HostProjectionClient({
    client: {
      clientId: 'wave-44-boot-proof',
      clientClass: 'desktop',
      clientVersion: HOST_VERSION
    },
    capabilities: ['bootstrap', 'snapshot', 'health'],
    userDataPath,
    connectTimeoutMs: 5_000,
    requestTimeoutMs: 5_000
  })
}

function mutationClient(): HostProjectionClient {
  return new HostProjectionClient({
    client: {
      clientId: MUTATION_CLIENT_ID,
      clientClass: 'desktop',
      clientVersion: HOST_VERSION
    },
    capabilities: ['bootstrap', 'snapshot', 'commands', 'receipts', 'health'],
    userDataPath,
    connectTimeoutMs: 5_000,
    requestTimeoutMs: 5_000
  })
}

function desktopRecordMutationClient(): HostProjectionClient {
  return new HostProjectionClient({
    client: {
      clientId: TASKWRAITH_DESKTOP_HOST_CLIENT_ID,
      clientClass: TASKWRAITH_DESKTOP_HOST_ACTOR.clientClass,
      clientVersion: HOST_VERSION
    },
    capabilities: ['bootstrap', 'snapshot', 'commands', 'receipts', 'health'],
    userDataPath,
    connectTimeoutMs: 5_000,
    requestTimeoutMs: 5_000
  })
}

function questionMutationClient(): HostProjectionClient {
  return new HostProjectionClient({
    client: {
      clientId: MUTATION_CLIENT_ID,
      clientClass: 'desktop',
      clientVersion: HOST_VERSION
    },
    capabilities: [
      'bootstrap',
      'snapshot',
      'deltas',
      'commands',
      'receipts',
      'health',
      'questions'
    ],
    userDataPath,
    connectTimeoutMs: 5_000,
    requestTimeoutMs: 5_000
  })
}

function setupMutationClient(): HostProjectionClient {
  return new HostProjectionClient({
    client: {
      clientId: MUTATION_CLIENT_ID,
      clientClass: 'desktop',
      clientVersion: HOST_VERSION
    },
    capabilities: [
      'bootstrap',
      'snapshot',
      'provider-catalog',
      'provider-auth',
      'history',
      'setup',
      'commands',
      'receipts',
      'health'
    ],
    userDataPath,
    connectTimeoutMs: 5_000,
    requestTimeoutMs: 5_000
  })
}

function productionSetupOptions(): HostProductionBootstrapOptions {
  const workspaces: Array<{ id: string; path: string; realPath?: string }> = []
  const chats = new Map<
    string,
    {
      appChatId: string
      workspaceId: string
      workspacePath: string
      provider?: ProviderId
      title: string
      archived: boolean
      updatedAt: number
      messages: Array<{
        id: string
        role: 'assistant'
        content: string
        timestamp: string
      }>
    }
  >()
  const getChat = (threadId: string) => chats.get(threadId) ?? null
  return {
    ...productionOptions(),
    chatList: {
      getChatList: () =>
        [...chats.values()].map((chat) => ({
          ...chat,
          scope: 'workspace' as const,
          chatKind: 'single' as const,
          pinned: false,
          messageCount: chat.messages.length
        }))
    },
    contextSources: {
      getChat,
      getApproval: () => null,
      getQuestion: () => null
    },
    setup: {
      workspace: {
        registerWorkspace: ({ selectedPath }) => {
          const existing = workspaces.find((workspace) => workspace.path === selectedPath)
          if (existing) return existing
          const workspace = { id: 'workspace-setup', path: selectedPath, realPath: selectedPath }
          workspaces.push(workspace)
          return workspace
        },
        getWorkspaces: () => workspaces
      },
      chat: {
        createSingleThread: (input) => {
          if (input.scope !== 'workspace') throw new Error('workspace setup expected')
          const chat = {
            appChatId: 'thread-setup',
            workspaceId: input.workspaceId,
            workspacePath: input.workspacePath,
            title: 'Setup thread',
            archived: false,
            updatedAt: 1,
            messages: [
              {
                id: 'history-setup',
                role: 'assistant' as const,
                content: 'Host setup history is available.',
                timestamp: '2026-08-24T00:00:00.000Z'
              }
            ]
          }
          chats.set(chat.appChatId, chat)
          return chat
        },
        configureThread: (input) => {
          const chat = chats.get(input.chatId)
          if (!chat) throw new Error('thread unavailable')
          chat.provider = input.provider
          chat.title = input.title ?? chat.title
          chat.updatedAt += 1
          return chat
        },
        archiveThread: ({ chatId, archived }) => {
          const chat = chats.get(chatId)
          if (!chat) throw new Error('thread unavailable')
          chat.archived = archived
          chat.updatedAt += 1
          return chat
        }
      },
      terminal: {
        begin: ({ provider, operationId }) => ({ provider, operationId }),
        cancel: () => ({ outcome: 'not_cancellable' as const })
      },
      providers: () => [
        {
          providerId: 'codex' as const,
          label: 'Codex',
          status: 'ready' as const,
          models: [
            {
              modelId: 'gpt-5.6',
              label: 'GPT-5.6',
              default: true,
              reasoning: [{ reasoningId: 'high', label: 'High' }]
            }
          ]
        }
      ]
    },
    history: { getChat }
  }
}

function mutationCommand(input: {
  commandId: string
  idempotencyKey: string
  name: HostCommandName
  target: Record<string, string>
  arguments?: Record<string, unknown>
}): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    actor: MUTATION_ACTOR,
    name: input.name,
    target: input.target,
    arguments: input.arguments ?? {},
    issuedAt: '2026-08-09T00:00:00.000Z'
  }
}

function desktopRecordMutationCommand(input: {
  commandId: string
  transferId: string
  sha256: string
  byteLength: number
}): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: input.commandId,
    idempotencyKey: `desktop:thread-record:${input.commandId}`,
    actor: { ...TASKWRAITH_DESKTOP_HOST_ACTOR },
    name: 'thread.record.persist',
    target: { threadId: 'thread-ensemble-start' },
    arguments: {
      transferId: input.transferId,
      sha256: input.sha256,
      byteLength: input.byteLength,
      expectedRevision: 0
    },
    issuedAt: '2026-08-28T10:00:00.000Z'
  }
}

function productionMutationOptions(): {
  options: HostProductionBootstrapOptions
  executeSetWatchedThread: ReturnType<typeof vi.fn>
} {
  const executeSetWatchedThread = vi.fn(async () => ({
    executed: true,
    message: 'selected through production Host'
  }))
  return {
    executeSetWatchedThread,
    options: {
      ...productionOptions(),
      chatList: {
        getChatList: () => [
          {
            appChatId: 'thread-mutation',
            scope: 'workspace',
            workspaceId: 'workspace-1',
            provider: 'codex',
            title: 'Mutation proof',
            archived: false,
            updatedAt: Date.parse('2026-08-09T00:00:00.000Z'),
            messageCount: 0
          }
        ]
      },
      bridge: { ...externalBridge(), executeSetWatchedThread },
      contextSources: {
        getChat: (threadId) =>
          threadId === 'thread-mutation'
            ? {
                appChatId: 'thread-mutation',
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
  }
}

function productionQuestionMutationOptions(): {
  options: HostProductionBootstrapOptions
  executeQuestionReply: ReturnType<typeof vi.fn>
  resolveQuestion: ReturnType<typeof vi.fn>
} {
  const registry = new RemoteQuestionRegistry({
    now: () => Date.parse('2026-08-09T00:00:00.000Z'),
    setTimer: () => 'question-timer',
    clearTimer: vi.fn()
  })
  const resolveQuestion = vi.fn()
  registry.register({
    questionId: 'question-receipt',
    question: 'Proceed with the Host receipt proof?',
    workspaceId: 'workspace-1',
    threadId: 'thread-question',
    runId: 'run-question',
    resolve: resolveQuestion
  })

  const executeQuestionReply = vi.fn(async (action: BridgeQuestionReplyAction) => {
    const result = registry.answerScoped(
      action.promptId,
      {
        workspaceId: action.workspaceId,
        threadId: action.threadId,
        runId: action.runId
      },
      action.answer,
      action.isCustom ?? true,
      'remote',
      action.receiptId
    )
    return {
      executed: result.ok,
      message: result.ok ? 'answered through production Host' : 'question resolution failed'
    }
  })

  const questions = createHostProductionQuestionShadow({
    listPending: () =>
      registry.listPending().map((record) => ({
        questionId: record.questionId,
        question: record.question,
        threadId: record.threadId,
        createdAt: record.createdAt
      })),
    listResolved: () =>
      registry.listResolved().map((record) => ({
        questionId: record.questionId,
        question: record.question,
        threadId: record.threadId,
        createdAt: record.createdAt,
        status: record.status,
        resolvedAt: record.resolvedAt,
        receiptId: record.receiptId
      }))
  })

  return {
    executeQuestionReply,
    resolveQuestion,
    options: {
      ...productionOptions(),
      chatList: {
        getChatList: () => [
          {
            appChatId: 'thread-question',
            scope: 'workspace',
            workspaceId: 'workspace-1',
            provider: 'codex',
            title: 'Question receipt proof',
            archived: false,
            updatedAt: Date.parse('2026-08-09T00:00:00.000Z'),
            messageCount: 0
          }
        ]
      },
      questions,
      bridge: { ...externalBridge(), executeQuestionReply },
      contextSources: {
        getChat: (threadId) =>
          threadId === 'thread-question'
            ? {
                appChatId: 'thread-question',
                scope: 'workspace',
                workspaceId: 'workspace-1',
                provider: 'codex',
                archived: false,
                runs: []
              }
            : null,
        getApproval: () => null,
        getQuestion: (questionId) => registry.get(questionId)
      }
    }
  }
}

beforeEach(() => {
  userDataPath = realpathSync(mkdtempSync(join(tmpdir(), 'tw-host-boot-proof-')))
  supervisor = null
  client = null
})

afterEach(() => {
  // Teardown must survive a failed assertion mid-test, or one red test leaves a
  // live listener that hangs the whole suite.
  try {
    client?.close()
  } catch {
    /* client already closed */
  }
  try {
    supervisor?.stopSync()
  } catch {
    /* supervisor already stopped or never started */
  }
  rmSync(userDataPath, { recursive: true, force: true })
})

/* ------------------------------------------------------------------ */
/*  1. BOOT                                                            */
/* ------------------------------------------------------------------ */

describe('Wave 4.4 boot — the real composition actually starts', () => {
  it('starts the REAL composition and publishes a decodable discovery record', async () => {
    supervisor = createHostProductionBootstrap(productionOptions())
    await supervisor.start()

    const discoveryPath = taskWraithHostDiscoveryPath(userDataPath)
    expect(existsSync(discoveryPath)).toBe(true)

    // Existence alone is not evidence — a stale artifact also exists. Decode it
    // through the SHIPPING fail-closed decoder, so this asserts the record a
    // real client would actually accept rather than a shape invented here.
    const decoded = decodeTaskWraithHostDiscovery(JSON.parse(readFileSync(discoveryPath, 'utf8')))
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return

    expect(decoded.discovery.protocolVersion).toBe(2)
    expect(decoded.discovery.pid).toBe(process.pid)
    expect(decoded.discovery.startedAt.length).toBeGreaterThan(0)

    // The socket and token it advertises must really be there. A discovery
    // record pointing at nothing is worse than no record: a client would trust
    // it and then fail obscurely.
    expect(existsSync(decoded.discovery.socketPath)).toBe(true)
    expect(existsSync(decoded.discovery.tokenPath)).toBe(true)
    expect(decoded.discovery.tokenPath).toBe(taskWraithHostTokenPath(userDataPath))
  }, 20_000)

  it('reports itself running after a real start', async () => {
    supervisor = createHostProductionBootstrap(productionOptions())
    await supervisor.start()

    expect(supervisor.isRunning).toBe(true)
    expect(supervisor.isStopped).toBe(false)
  }, 20_000)
})

/* ------------------------------------------------------------------ */
/*  2. SERVE                                                           */
/* ------------------------------------------------------------------ */

describe('Wave 4.4 serve — a real client completes a real authenticated round trip', () => {
  it('accepts a REAL client over the REAL socket and returns a REAL snapshot', async () => {
    supervisor = createHostProductionBootstrap(productionOptions())
    await supervisor.start()

    // No injected transport anywhere in this test. The client reads the
    // discovery file, reads the token, opens the unix socket, and performs the
    // authenticated bootstrap handshake exactly as Desktop and TUI do.
    client = readOnlyClient()
    const welcome = await client.connect()

    // The identity we injected at bootstrap must be the identity the wire
    // advertises. This is the assertion that proves the hostId resolved by
    // HostInstallIdentity actually reaches a connecting client.
    expect(welcome.hostId).toBe(HOST_ID)
    expect(welcome.hostVersion).toBe(HOST_VERSION)
    expect(welcome.protocolVersion).toBe(2)
    expect(welcome.sessionId.length).toBeGreaterThan(0)

    const frame = await client.getSnapshot()

    // A real HostSnapshot over the real wire — the first in the arc.
    //
    // NOTE, because it is easy to assert wrongly here: HostSnapshot carries NO
    // hostId. Identity is a BOOTSTRAP concern, established once in the welcome
    // above and not restated on every snapshot. So the identity assertion
    // belongs on `welcome.hostId`, and what a snapshot must prove instead is
    // that it is a real bounded projection rather than a stub.
    expect(frame.snapshot).toBeDefined()
    expect(frame.snapshot.protocolVersion).toBe(2)
    expect(typeof frame.snapshot.generation).toBe('number')
    expect(typeof frame.snapshot.cursor).toBe('number')
    expect(frame.snapshot.generatedAt.length).toBeGreaterThan(0)
    expect(frame.snapshot.health).toBeDefined()

    // Every projection family must be present as an array. Empty is correct
    // here (the injected chatList is empty) — but ABSENT would mean the wire
    // dropped a family, which a client would read as "there is nothing here".
    for (const family of [
      frame.snapshot.workspaces,
      frame.snapshot.threads,
      frame.snapshot.runs,
      frame.snapshot.approvals,
      frame.snapshot.warnings
    ]) {
      expect(Array.isArray(family)).toBe(true)
    }
  }, 20_000)

  it('negotiates only the capabilities it asked for', async () => {
    supervisor = createHostProductionBootstrap(productionOptions())
    await supervisor.start()

    client = readOnlyClient()
    const welcome = await client.connect()

    // Host intersects its offer with the request. A read-only client must not
    // come back holding command/receipt authority it never asked for.
    expect(welcome.capabilities).not.toContain('commands')
    expect(welcome.capabilities).not.toContain('receipts')
  }, 20_000)

  it('serves setup, durable result refs, provider offers, and history over the real Host', async () => {
    supervisor = createHostProductionBootstrap(productionSetupOptions())
    await supervisor.start()

    client = setupMutationClient()
    const welcome = await client.connect()
    expect(welcome.capabilities).toEqual(
      expect.arrayContaining([
        'provider-catalog',
        'provider-auth',
        'history',
        'setup',
        'commands',
        'receipts'
      ])
    )
    await expect(client.getProviderStatuses()).resolves.toEqual([
      { providerId: 'codex', status: 'ready', label: 'Codex' }
    ])
    const offers = await client.getProviderOffers('codex')
    expect(offers.models).toEqual(
      expect.arrayContaining([expect.objectContaining({ modelId: 'gpt-5.6', available: true })])
    )

    const workspaceReceipt = await client.submitCommand(
      mutationCommand({
        commandId: '10000000-0000-4000-8000-000000000001',
        idempotencyKey: 'desktop:setup:workspace',
        name: 'workspace.register',
        target: {},
        arguments: { path: join(userDataPath, 'workspace') }
      })
    )
    expect(workspaceReceipt).toMatchObject({
      status: 'succeeded',
      resultRef: { kind: 'workspace', workspaceId: 'workspace-setup' }
    })

    const threadReceipt = await client.submitCommand(
      mutationCommand({
        commandId: '10000000-0000-4000-8000-000000000002',
        idempotencyKey: 'desktop:setup:thread',
        name: 'thread.create',
        target: {},
        arguments: { scope: 'workspace', workspaceId: 'workspace-setup' }
      })
    )
    expect(threadReceipt).toMatchObject({
      status: 'succeeded',
      resultRef: { kind: 'thread', threadId: 'thread-setup' }
    })

    const configureReceipt = await client.submitCommand(
      mutationCommand({
        commandId: '10000000-0000-4000-8000-000000000003',
        idempotencyKey: 'desktop:setup:configure',
        name: 'thread.configure',
        target: { threadId: 'thread-setup' },
        arguments: {
          providerId: 'codex',
          modelId: 'gpt-5.6',
          reasoningId: 'high',
          postureId: 'default',
          offerRevision: offers.offerRevision,
          title: 'Configured through Host'
        }
      })
    )
    expect(configureReceipt).toMatchObject({
      status: 'succeeded',
      resultRef: { kind: 'thread', threadId: 'thread-setup' }
    })

    await expect(
      client.getThreadHistory({ threadId: 'thread-setup', limit: 10 })
    ).resolves.toMatchObject({
      threadId: 'thread-setup',
      entries: [
        {
          entryId: 'history-setup',
          role: 'assistant',
          text: 'Host setup history is available.'
        }
      ]
    })
  }, 20_000)

  it('persists Ensemble round-start state through the real in-process Host fallback', async () => {
    const assertProfileAuthority = vi.fn()
    supervisor = createHostProductionBootstrap({
      ...productionOptions(),
      profileAuthority: { assertProfileAuthority }
    })
    await supervisor.start()

    client = desktopRecordMutationClient()
    await client.connect()
    const record = {
      appChatId: 'thread-ensemble-start',
      scope: 'workspace',
      workspaceId: 'workspace-1',
      workspacePath: userDataPath,
      title: 'Ensemble start',
      archived: false,
      messages: [],
      updatedAt: Date.parse('2026-08-28T10:00:00.000Z'),
      ensemble: {
        activeRound: {
          roundId: 'round-1',
          status: 'running',
          prompt: 'Begin',
          startedAt: '2026-08-28T10:00:00.000Z',
          participants: []
        },
        participants: []
      }
    }
    const descriptor = publishHostThreadRecordTransfer({
      profilePath: userDataPath,
      transferId: 'ensemble-start-transfer',
      record
    })
    const commandId = '77777777-7777-4777-8777-777777777777'
    const receipt = await client.submitCommand(
      desktopRecordMutationCommand({ commandId, ...descriptor })
    )

    expect(receipt).toMatchObject({
      commandId,
      status: 'succeeded',
      resultSummary: 'thread_record_persisted'
    })
    expect(
      JSON.parse(readFileSync(join(userDataPath, 'chats', 'thread-ensemble-start.json'), 'utf8'))
    ).toMatchObject({
      appChatId: 'thread-ensemble-start',
      persistenceRevision: 0,
      ensemble: record.ensemble
    })
    expect(assertProfileAuthority).toHaveBeenCalled()
  }, 20_000)

  it('executes a governed mutation through challenge, allow, Bridge, and receipt', async () => {
    const mutation = productionMutationOptions()
    supervisor = createHostProductionBootstrap(mutation.options)
    await supervisor.start()

    client = mutationClient()
    const welcome = await client.connect()
    expect(welcome.capabilities).toEqual(
      expect.arrayContaining(['snapshot', 'commands', 'receipts'])
    )

    const originalCommandId = '11111111-1111-4111-8111-111111111111'
    const pending = await client.submitCommand(
      mutationCommand({
        commandId: originalCommandId,
        idempotencyKey: 'desktop:wave-44-mutation-proof:22222222-2222-4222-8222-222222222222',
        name: 'thread.select',
        target: { threadId: 'thread-mutation' }
      })
    )
    expect(pending).toMatchObject({ commandId: originalCommandId, status: 'pending' })
    expect(mutation.executeSetWatchedThread).not.toHaveBeenCalled()

    const awaiting = await client.getSnapshot()
    const challenge = awaiting.snapshot.approvals.find(
      (approval) => approval.commandId === originalCommandId
    )
    expect(challenge).toBeDefined()
    if (!challenge) throw new Error('production Host did not publish its deferred challenge')

    const terminal = await client.submitCommand(
      mutationCommand({
        commandId: '33333333-3333-4333-8333-333333333333',
        idempotencyKey: 'desktop:wave-44-mutation-proof:44444444-4444-4444-8444-444444444444',
        name: 'approval.decide',
        target: { approvalId: challenge.approvalId },
        arguments: { decision: 'accept' }
      })
    )

    expect(terminal).toMatchObject({
      commandId: originalCommandId,
      status: 'succeeded',
      resultSummary: 'selected through production Host'
    })
    expect(mutation.executeSetWatchedThread).toHaveBeenCalledTimes(1)
    expect(mutation.executeSetWatchedThread).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'setWatchedThread',
        appChatId: 'thread-mutation',
        actionId: `host:command:${originalCommandId}`
      })
    )

    await expect(client.lookupReceipt({ commandId: originalCommandId })).resolves.toMatchObject({
      commandId: originalCommandId,
      status: 'succeeded'
    })
    const after = await client.getSnapshot()
    expect(after.snapshot.approvals.map((approval) => approval.approvalId)).not.toContain(
      challenge.approvalId
    )
  }, 20_000)

  it('publishes the exact question command receipt through snapshot and ordered delta', async () => {
    const mutation = productionQuestionMutationOptions()
    supervisor = createHostProductionBootstrap(mutation.options)
    await supervisor.start()

    client = questionMutationClient()
    const welcome = await client.connect()
    expect(welcome.capabilities).toEqual(
      expect.arrayContaining(['snapshot', 'deltas', 'commands', 'receipts', 'questions'])
    )

    const before = await client.getSnapshot()
    expect(before.snapshot.questions).toContainEqual(
      expect.objectContaining({
        questionId: 'question-receipt',
        threadId: 'thread-question',
        status: 'open'
      })
    )

    const commandId = '55555555-5555-4555-8555-555555555555'
    const receipt = await client.submitCommand(
      mutationCommand({
        commandId,
        idempotencyKey: 'desktop:wave-44-mutation-proof:66666666-6666-4666-8666-666666666666',
        name: 'question.answer',
        target: { questionId: 'question-receipt' },
        arguments: { decision: 'answer', answer: 'Yes', isCustom: false }
      })
    )
    expect(receipt).toMatchObject({
      commandId,
      status: 'succeeded',
      resultSummary: 'answered through production Host'
    })

    expect(mutation.executeQuestionReply).toHaveBeenCalledTimes(1)
    expect(mutation.executeQuestionReply).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'questionReply',
        workspaceId: 'workspace-1',
        threadId: 'thread-question',
        runId: 'run-question',
        promptId: 'question-receipt',
        receiptId: commandId,
        answer: 'Yes',
        isCustom: false
      })
    )
    expect(mutation.resolveQuestion).toHaveBeenCalledWith({
      answer: 'Yes',
      is_custom: false
    })

    await expect(client.lookupReceipt({ commandId })).resolves.toMatchObject({
      commandId,
      status: 'succeeded'
    })

    const after = await client.getSnapshot()
    const resolvedQuestion = after.snapshot.questions.find(
      (question) => question.questionId === 'question-receipt'
    )
    expect(resolvedQuestion).toMatchObject({
      questionId: 'question-receipt',
      threadId: 'thread-question',
      status: 'answered',
      receiptId: commandId
    })
    expect(resolvedQuestion).not.toHaveProperty('answer')

    const deltas = await client.getDeltasSince({
      generation: before.snapshot.generation,
      cursor: before.snapshot.cursor
    })
    expect(deltas.result.kind).toBe('deltas')
    if (deltas.result.kind !== 'deltas') {
      throw new Error('production Host required a resnapshot for one coherent question mutation')
    }
    const questionDelta = deltas.result.deltas.find(
      (delta) => delta.family === 'question' && delta.entityId === 'question-receipt'
    )
    expect(questionDelta).toMatchObject({
      kind: 'upsert',
      family: 'question',
      entityId: 'question-receipt',
      payload: {
        questionId: 'question-receipt',
        threadId: 'thread-question',
        status: 'answered',
        receiptId: commandId
      }
    })
  }, 20_000)
})

/* ------------------------------------------------------------------ */
/*  3. STOP                                                            */
/* ------------------------------------------------------------------ */

describe('Wave 4.4 stop — explicit stop is real, not cosmetic', () => {
  it('removes its discovery artifacts on stopSync', async () => {
    supervisor = createHostProductionBootstrap(productionOptions())
    await supervisor.start()

    const discoveryPath = taskWraithHostDiscoveryPath(userDataPath)
    expect(existsSync(discoveryPath)).toBe(true)

    supervisor.stopSync()

    // A Host that claims to stop but leaves a discovery record behind will be
    // found by the next client, which then hangs against a dead socket.
    expect(existsSync(discoveryPath)).toBe(false)
    expect(supervisor.isStopped).toBe(true)
    expect(supervisor.isRunning).toBe(false)
  }, 20_000)

  it('REFUSES a fresh connection after stop', async () => {
    supervisor = createHostProductionBootstrap(productionOptions())
    await supervisor.start()

    // Prove the socket was genuinely live first, so the refusal below cannot be
    // explained by a Host that never served at all.
    const before = readOnlyClient()
    await before.connect()
    before.close()

    supervisor.stopSync()

    // This is the assertion that separates "stopped" from "claims to be
    // stopped". A listener still accepting connections after an explicit stop
    // is an undeclared background service, which the goal forbids outright.
    client = readOnlyClient()
    await expect(client.connect()).rejects.toThrow()
  }, 25_000)
})
