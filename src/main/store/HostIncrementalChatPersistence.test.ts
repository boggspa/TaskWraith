/**
 * Stage 2 — ID/revision mutation persistence re-homed onto the Host write path.
 *
 * After the Host cutover the legacy writer gate is host-owned, production
 * saves route through `saveChatThroughHost`, and the legacy-admitted
 * `persistIncrementalChat` is never reached — the T4 journal would be
 * write-dead. These tests pin the re-home:
 *
 *  - every Host-owned save appends its mutation to the main-owned sideband
 *    journal (`chat-journal-v2`);
 *  - normal streaming saves retain one latest full compatibility record and
 *    publish no Host transfer until an explicit barrier;
 *  - terminal and fallback saves materialize immediately;
 *  - the legacy admitted path is unchanged while the gate is open;
 *  - the Stage 1a save guard keeps admitting authored-mutation saves on the
 *    Host path (every saveChat below with authoredTranscript must not throw).
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CHAT_UPDATE_PROTOCOL_V2,
  applyChatUpdateDelivery,
  buildChatUpdateDelivery
} from '../../shared/chatUpdateTransport'
import { buildChatMarkdownTranscript } from '../TranscriptMarkdownExport'
import type {
  HostThreadRecordPersistInput,
  HostThreadRecordPersistPort
} from '../host/HostThreadRecordPersistCommand'
import { ChatTranscriptMutationAuthor } from './ChatTranscriptMutationAuthoring'
import type { ChatMessage, ChatRecord } from './types'

const profiles: string[] = []

afterEach(() => {
  while (profiles.length > 0) rmSync(profiles.pop()!, { recursive: true, force: true })
})

interface WiredStore {
  AppStore: typeof import('./index').AppStore
  profilePath: string
  enqueued: HostThreadRecordPersistInput[]
  persistPort: HostThreadRecordPersistPort & {
    enqueue: ReturnType<typeof vi.fn>
    drain: ReturnType<typeof vi.fn>
    drainAll: ReturnType<typeof vi.fn>
  }
}

async function importStoreWithHostOwnedGate(options?: {
  hostOwnGate?: boolean
}): Promise<WiredStore> {
  const profilePath = mkdtempSync(join(tmpdir(), 'taskwraith-host-incremental-persist-'))
  profiles.push(profilePath)
  vi.resetModules()
  const { configureHostStoreRuntime, resetHostStoreRuntimeForTests } =
    await import('../../host-runtime/HostStoreRuntime')
  resetHostStoreRuntimeForTests()
  configureHostStoreRuntime({
    profilePath,
    secureStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(`node:${plain}`, 'utf8'),
      decryptString: (encrypted) => encrypted.toString('utf8').replace(/^node:/, '')
    }
  })
  const { AppStore } = await import('./index')
  if (options?.hostOwnGate !== false) {
    const { legacyStoreWriterGate } = await import('./LegacyStoreWriterGate')
    if (!legacyStoreWriterGate.beginDrain()) throw new Error('test gate did not begin draining')
    const owned = legacyStoreWriterGate.markHostOwned({
      hostId: 'test-host',
      generation: 1,
      cutoverId: 'test-cutover'
    })
    if (!owned) throw new Error('test gate did not become host-owned')
  }
  const enqueued: HostThreadRecordPersistInput[] = []
  const persistPort: WiredStore['persistPort'] = {
    persist: vi.fn(),
    enqueue: vi.fn((input: HostThreadRecordPersistInput) => {
      enqueued.push(input)
    }),
    drain: vi.fn(async () => {}),
    drainAll: vi.fn(async () => {}),
    pending: vi.fn(() => 0)
  }
  AppStore.setHostThreadRecordPersistPortForTests(persistPort)
  return { AppStore, profilePath, enqueued, persistPort }
}

function message(id: string, role: ChatMessage['role'], content: string): ChatMessage {
  return { id, role, content, timestamp: '2026-09-01T00:00:00.000Z' }
}

function durableChat(chatId: string, revision: number, runs: ChatRecord['runs'] = []): ChatRecord {
  return {
    appChatId: chatId,
    provider: 'codex',
    title: 'Stage 2 chat',
    scope: 'global',
    chatKind: 'single',
    createdAt: 1,
    updatedAt: 1,
    persistenceRevision: revision,
    archived: false,
    messages: [
      message('m1', 'user', 'First message'),
      message('m2', 'assistant', 'Second message')
    ],
    runs
  }
}

function seedDurableChat(profilePath: string, chat: ChatRecord): void {
  const chatsDir = join(profilePath, 'chats')
  mkdirSync(chatsDir, { recursive: true, mode: 0o700 })
  const chatPath = join(chatsDir, `${chat.appChatId}.json`)
  writeFileSync(chatPath, JSON.stringify(chat))
  chmodSync(chatPath, 0o600)
}

function journalV2Files(profilePath: string, chatId: string): string[] {
  const dir = join(profilePath, 'chat-journal-v2')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((entry) => entry.startsWith(chatId))
    .sort()
}

function readJournalCheckpoint(
  profilePath: string,
  chatId: string
): { revision: number; record: ChatRecord } {
  return JSON.parse(
    readFileSync(join(profilePath, 'chat-journal-v2', `${chatId}.checkpoint.json`), 'utf8')
  ) as { revision: number; record: ChatRecord }
}

async function waitForLength(values: readonly unknown[], length: number): Promise<void> {
  for (let attempt = 0; attempt < 20 && values.length < length; attempt += 1) {
    await Promise.resolve()
  }
  expect(values).toHaveLength(length)
}

describe('Stage 2 — incremental persistence on the Host write path', () => {
  it('appends the journal batch alongside the whole-record enqueue for an authored mutation save', async () => {
    const { AppStore, profilePath, enqueued } = await importStoreWithHostOwnedGate()
    const chatId = 'chat-host-mutation'
    const previous = durableChat(chatId, 3)
    seedDurableChat(profilePath, previous)

    const m3 = message('m3', 'assistant', 'Appended by the mutation')
    const author = new ChatTranscriptMutationAuthor(previous.messages.length)
    author.append([m3])

    // The Stage 1a guard must keep admitting authored-mutation saves here;
    // a windowed-page rejection would throw synchronously inside saveChat.
    let saved: ChatRecord | undefined
    expect(() => {
      saved = AppStore.saveChat(
        { ...previous, messages: [...previous.messages, m3] },
        {
          authoredTranscript: author.finish()
        }
      ) as ChatRecord
    }).not.toThrow()

    // The whole record still rides the Host persist queue — the authoritative write.
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].chatId).toBe(chatId)
    expect(enqueued[0].expectedRevision).toBe(3)
    expect((enqueued[0].record as unknown as ChatRecord).persistenceRevision).toBe(4)
    expect(saved?.persistenceRevision).toBe(4)

    // ...and the authored mutation is durable in the sideband journal too.
    // The terminal boundary (no running run) checkpoints and parity-verifies.
    const stats = AppStore.getIncrementalChatPersistenceStats()
    expect(stats.seeds).toBe(0)
    expect(stats.mutationBatchesAppended).toBe(1)
    expect(stats.terminalCheckpoints).toBe(1)
    // Two parity checks by construction: ensureBaseline verifies the freshly
    // seeded baseline, then the terminal boundary verifies the append.
    expect(stats.parityChecks).toBe(2)
    expect(stats.parityMatches).toBe(2)
    expect(stats.parityMismatches).toBe(0)
    expect(journalV2Files(profilePath, chatId)).toEqual([`${chatId}.checkpoint.json`])
    const checkpoint = readJournalCheckpoint(profilePath, chatId)
    expect(checkpoint.revision).toBe(4)
    expect(checkpoint.record.messages.map((entry) => entry.id)).toEqual(['m1', 'm2', 'm3'])
  })

  it('keeps a running chat on the normal boundary: the mutation line lands in the journal', async () => {
    const { AppStore, profilePath, enqueued } = await importStoreWithHostOwnedGate()
    const { chatUpdateProducerEnvelopeFor } = await import('../../shared/chatUpdateTransport')
    const chatId = 'chat-host-mutation-running'
    const previous = durableChat(chatId, 3, [
      { runId: 'run-1', startedAt: '2026-09-01T00:00:00.000Z', status: 'running' }
    ])
    seedDurableChat(profilePath, previous)

    const m3 = message('m3', 'assistant', 'Streaming delta')
    const author = new ChatTranscriptMutationAuthor(previous.messages.length)
    author.append([m3])
    const input = { ...previous, messages: [...previous.messages, m3] }
    const saved = AppStore.saveChat(input, {
      authoredTranscript: author.finish()
    })

    // D1 is journal-only: no full-record transfer is even enqueued.
    expect(enqueued).toHaveLength(0)
    const stats = AppStore.getIncrementalChatPersistenceStats()
    expect(stats.mutationBatchesAppended).toBe(1)
    expect(stats.terminalCheckpoints).toBe(0)
    expect(stats.boundaryMix.normal).toBe(1)
    const lines = readFileSync(
      join(profilePath, 'chat-journal-v2', `${chatId}.mutations.jsonl`),
      'utf8'
    )
      .trim()
      .split('\n')
    expect(lines).toHaveLength(1)
    const batch = JSON.parse(lines[0]) as {
      chatId: string
      baseRevision: number
      revision: number
      operations: Array<{ type: string }>
    }
    expect(batch.chatId).toBe(chatId)
    expect(batch.baseRevision).toBe(3)
    expect(batch.revision).toBe(4)
    expect(batch.operations.some((operation) => operation.type === 'messages_splice')).toBe(true)

    const envelope = chatUpdateProducerEnvelopeFor(saved)
    expect(envelope?.delta).toMatchObject({
      chatId,
      basePersistenceRevision: 3,
      persistenceRevision: 4,
      transcriptOps: [{ op: 'append', messages: [m3] }]
    })
    expect(chatUpdateProducerEnvelopeFor(input)).toBe(envelope)
    const delivery = buildChatUpdateDelivery({
      deliveryId: 'host-authored-delta',
      revision: 2,
      chat: saved,
      baseline: { revision: 1, chat: previous },
      producerState: envelope?.state,
      producerDelta: envelope?.delta ?? undefined,
      protocolVersion: CHAT_UPDATE_PROTOCOL_V2
    })
    expect(delivery).toMatchObject({
      kind: 'patch',
      protocolVersion: CHAT_UPDATE_PROTOCOL_V2,
      transcriptOps: [{ op: 'append', messages: [m3] }]
    })
    expect('messages' in delivery).toBe(false)
    const applied = applyChatUpdateDelivery(delivery, { revision: 1, chat: previous })
    expect(applied.ok).toBe(true)
    if (!applied.ok) throw new Error(applied.reason)
    expect(JSON.parse(JSON.stringify(applied.baseline.chat))).toEqual(
      JSON.parse(JSON.stringify(saved))
    )

    await AppStore.awaitChatRecordPersisted(chatId)
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].expectedRevision).toBe(3)
    expect(enqueued[0].record).toBe(saved)
  })

  it('chains a barrier requested for a newer D1 revision behind the active barrier', async () => {
    const { AppStore, profilePath, enqueued, persistPort } = await importStoreWithHostOwnedGate()
    const chatId = 'chat-host-newer-barrier'
    const previous = durableChat(chatId, 3, [
      { runId: 'run-1', startedAt: '2026-09-01T00:00:00.000Z', status: 'running' }
    ])
    seedDurableChat(profilePath, previous)
    const releases: Array<() => void> = []
    persistPort.drain.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve)
        })
    )

    const firstSaved = AppStore.saveChat({ ...previous, title: 'First D1' })
    const firstBarrier = AppStore.awaitChatRecordPersisted(chatId)
    await waitForLength(releases, 1)
    expect(enqueued).toHaveLength(1)

    const latestSaved = AppStore.saveChat({ ...firstSaved, title: 'Second D1' })
    const latestBarrier = AppStore.awaitChatRecordPersisted(chatId)
    expect(latestBarrier).not.toBe(firstBarrier)

    releases.shift()!()
    await firstBarrier
    await waitForLength(releases, 1)
    expect(enqueued).toHaveLength(2)
    expect(enqueued[1].record).toBe(latestSaved)
    releases.shift()!()
    await latestBarrier
  })

  it('derives a chrome-only mutation for a non-authored D1 save and defers its Host record', async () => {
    const { AppStore, profilePath, enqueued } = await importStoreWithHostOwnedGate()
    const { chatUpdateProducerEnvelopeFor } = await import('../../shared/chatUpdateTransport')
    const chatId = 'chat-host-whole-only'
    const previous = durableChat(chatId, 3, [
      { runId: 'run-1', startedAt: '2026-09-01T00:00:00.000Z', status: 'running' }
    ])
    seedDurableChat(profilePath, previous)

    const saved = AppStore.saveChat({
      ...previous,
      title: 'Renamed without mutation'
    })

    expect(enqueued).toHaveLength(0)
    expect(journalV2Files(profilePath, chatId)).toEqual([
      `${chatId}.checkpoint.json`,
      `${chatId}.mutations.jsonl`
    ])
    const stats = AppStore.getIncrementalChatPersistenceStats()
    expect(stats.mutationBatchesAppended).toBe(1)
    expect(stats.seeds).toBe(0)
    expect(stats.baselineChecks).toBe(1)
    expect(chatUpdateProducerEnvelopeFor(saved)?.delta).toMatchObject({
      chatId,
      basePersistenceRevision: 3,
      persistenceRevision: 4
    })
  })

  it('externalizes repeated sealed jumbo tool detail without publishing a full Host record until barrier', async () => {
    const { AppStore, profilePath, enqueued } = await importStoreWithHostOwnedGate()
    const chatId = 'chat-host-tool-heavy'
    let current = durableChat(chatId, 3, [
      { runId: 'run-1', startedAt: '2026-09-01T00:00:00.000Z', status: 'running' }
    ])
    seedDurableChat(profilePath, current)
    const expectedRaw: Array<{ command: string; output: string }> = []

    for (let index = 0; index < 6; index += 1) {
      const raw = {
        command: `tool-command-${index}`,
        output: `tool-output-${index}-${'x'.repeat(70_000)}`
      }
      expectedRaw.push(raw)
      const toolMessage: ChatMessage = {
        id: `tool-message-${index}`,
        role: 'tool',
        content: '',
        timestamp: `2026-09-01T00:00:0${index}.000Z`,
        runId: 'run-1',
        toolActivities: [
          {
            id: `tool-activity-${index}`,
            toolName: 'run_shell_command',
            displayName: 'Ran command',
            category: 'shell',
            status: 'success',
            endedAt: `2026-09-01T00:00:0${index}.500Z`,
            parameters: { command: raw.command },
            rawResultEvent: { output: raw.output }
          }
        ]
      }
      const author = new ChatTranscriptMutationAuthor(current.messages.length)
      author.append([toolMessage])
      current = AppStore.saveChat(
        { ...current, messages: [...current.messages, toolMessage] },
        { authoredTranscript: author.finish() }
      )

      const compact = current.messages.at(-1)?.toolActivities?.[0]
      expect(compact?.detailRef).toBeDefined()
      expect(compact?.parameters).toBeUndefined()
      expect(compact?.rawResultEvent).toBeUndefined()
      expect(enqueued).toHaveLength(0)
    }

    const detailArtifact = join(
      profilePath,
      'run-artifacts',
      'run-1',
      'tool-activity-details.jsonl'
    )
    expect(existsSync(detailArtifact)).toBe(true)
    const refs = current.messages.flatMap((entry) =>
      (entry.toolActivities ?? []).flatMap((activity) =>
        activity.detailRef ? [activity.detailRef] : []
      )
    )
    expect(refs).toHaveLength(6)
    const hydrated = await AppStore.getToolActivityDetails(refs)
    expect(hydrated).toHaveLength(6)
    expect(
      hydrated.map((entry) => ({
        command: String((entry.activity.parameters as { command?: unknown })?.command),
        output: String((entry.activity.rawResultEvent as { output?: unknown })?.output)
      }))
    ).toEqual(expectedRaw)

    const hydratedById = new Map(hydrated.map((entry) => [entry.ref.activityId, entry.activity]))
    const hydratedChat: ChatRecord = {
      ...current,
      messages: current.messages.map((entry) => ({
        ...entry,
        ...(entry.toolActivities
          ? {
              toolActivities: entry.toolActivities.map((activity) =>
                hydratedById.has(activity.id)
                  ? { ...hydratedById.get(activity.id)!, detailRef: activity.detailRef }
                  : activity
              )
            }
          : {})
      }))
    }
    const exportOptions = { copiedAt: '2026-09-04T00:10:00.000Z' }
    expect(buildChatMarkdownTranscript(hydratedChat, exportOptions)).toEqual(
      buildChatMarkdownTranscript(current, exportOptions)
    )

    await AppStore.awaitChatRecordPersisted(chatId)
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].expectedRevision).toBe(3)
    expect(enqueued[0].record.persistenceRevision).toBe(current.persistenceRevision)
    expect(
      enqueued[0].record.messages
        .flatMap((entry) => entry.toolActivities ?? [])
        .every((activity) => activity.rawResultEvent === undefined)
    ).toBe(true)
  })

  it('materializes an approval transition immediately instead of leaving it in the D1 slot', async () => {
    const { AppStore, profilePath, enqueued } = await importStoreWithHostOwnedGate()
    const chatId = 'chat-host-approval'
    const previous = durableChat(chatId, 3, [
      { runId: 'run-1', startedAt: '2026-09-01T00:00:00.000Z', status: 'running' }
    ])
    seedDurableChat(profilePath, previous)

    const saved = AppStore.saveChat({
      ...previous,
      ensemble: {
        enabled: true,
        maxParticipants: 1,
        participants: [],
        activeRound: {
          roundId: 'round-1',
          status: 'running',
          startedAt: '2026-09-01T00:00:00.000Z',
          participants: [],
          lanes: {
            'lane-1': {
              laneId: 'lane-1',
              participantId: 'participant-1',
              provider: 'codex',
              intent: 'write',
              status: 'awaiting-approval',
              approvalsQueued: 1,
              startedAt: '2026-09-01T00:00:00.000Z'
            }
          }
        }
      } as never
    })

    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]).toMatchObject({ chatId, expectedRevision: 3 })
    expect(enqueued[0].record).toBe(saved)
    expect(AppStore.getIncrementalChatPersistenceStats().boundaryMix.approval).toBe(1)
  })

  it('falls back to an immediate full Host checkpoint when the incremental journal fails', async () => {
    const { AppStore, profilePath, enqueued } = await importStoreWithHostOwnedGate()
    const chatId = 'chat-host-journal-failure'
    const previous = durableChat(chatId, 3, [
      { runId: 'run-1', startedAt: '2026-09-01T00:00:00.000Z', status: 'running' }
    ])
    seedDurableChat(profilePath, previous)
    mkdirSync(join(profilePath, 'chat-journal-v2', `${chatId}.mutations.jsonl`), {
      recursive: true
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const saved = AppStore.saveChat({ ...previous, title: 'Fallback title' })
      expect(enqueued).toHaveLength(1)
      expect(enqueued[0]).toMatchObject({ chatId, expectedRevision: 3 })
      expect(enqueued[0].record).toBe(saved)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('keeps inline D4 bytes and materializes the full record when detail archival fails', async () => {
    const { AppStore, profilePath, enqueued } = await importStoreWithHostOwnedGate()
    const chatId = 'chat-host-detail-failure'
    const previous = durableChat(chatId, 3, [
      { runId: 'run-1', startedAt: '2026-09-01T00:00:00.000Z', status: 'running' }
    ])
    seedDurableChat(profilePath, previous)
    mkdirSync(join(profilePath, 'run-artifacts', 'run-1', 'tool-activity-details.jsonl'), {
      recursive: true
    })
    const toolMessage: ChatMessage = {
      id: 'tool-message-failure',
      role: 'tool',
      content: '',
      timestamp: '2026-09-01T00:00:01.000Z',
      runId: 'run-1',
      toolActivities: [
        {
          id: 'tool-activity-failure',
          toolName: 'run_shell_command',
          displayName: 'Ran command',
          category: 'shell',
          status: 'success',
          endedAt: '2026-09-01T00:00:01.500Z',
          parameters: { command: 'preserve me' },
          rawResultEvent: { output: 'y'.repeat(70_000) }
        }
      ]
    }
    const author = new ChatTranscriptMutationAuthor(previous.messages.length)
    author.append([toolMessage])
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const saved = AppStore.saveChat(
        { ...previous, messages: [...previous.messages, toolMessage] },
        { authoredTranscript: author.finish() }
      )

      expect(enqueued).toHaveLength(1)
      expect(enqueued[0].record).toBe(saved)
      const activity = saved.messages.at(-1)?.toolActivities?.[0]
      expect(activity?.detailRef).toBeUndefined()
      expect(activity?.parameters).toEqual({ command: 'preserve me' })
      expect((activity?.rawResultEvent as { output?: string })?.output).toHaveLength(70_000)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('coalesces authored and derived D1 saves into one revision-jumping Host checkpoint', async () => {
    const { AppStore, profilePath, enqueued } = await importStoreWithHostOwnedGate()
    const chatId = 'chat-host-baseline-repair'
    const previous = durableChat(chatId, 3, [
      { runId: 'run-1', startedAt: '2026-09-01T00:00:00.000Z', status: 'running' }
    ])
    seedDurableChat(profilePath, previous)

    // Mutation save: journal seeds at 3, then appends 3 -> 4.
    const m3 = message('m3', 'assistant', 'First mutation')
    const author1 = new ChatTranscriptMutationAuthor(previous.messages.length)
    author1.append([m3])
    const first = AppStore.saveChat(
      { ...previous, messages: [...previous.messages, m3] },
      { authoredTranscript: author1.finish() }
    ) as ChatRecord
    expect(first.persistenceRevision).toBe(4)

    // A non-authored chrome change advances through the same journal.
    const second = AppStore.saveChat({ ...first, title: 'Chrome-only change' })

    // The next authored mutation continues the uninterrupted revision chain.
    const current = AppStore.getChat(chatId)!
    const m4 = message('m4', 'assistant', 'Second mutation')
    const author2 = new ChatTranscriptMutationAuthor(current.messages.length)
    author2.append([m4])
    const saved = AppStore.saveChat(
      { ...current, messages: [...current.messages, m4] },
      { authoredTranscript: author2.finish() }
    ) as ChatRecord

    expect(saved.persistenceRevision).toBe(6)
    expect(second.persistenceRevision).toBe(5)
    expect(enqueued).toHaveLength(0)
    const stats = AppStore.getIncrementalChatPersistenceStats()
    expect(stats.mutationBatchesAppended).toBe(3)
    expect(stats.baselineRepairs).toBe(0)
    expect(stats.parityMismatches).toBe(0)

    await AppStore.awaitChatRecordPersisted(chatId)
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].expectedRevision).toBe(3)
    expect(enqueued[0].record.persistenceRevision).toBe(6)
    expect(enqueued[0].record.messages.map((entry) => entry.id)).toEqual(['m1', 'm2', 'm3', 'm4'])
  })

  it('keeps the legacy admitted incremental path live while the gate is open', async () => {
    const { AppStore, profilePath, enqueued } = await importStoreWithHostOwnedGate({
      hostOwnGate: false
    })
    const chatId = 'chat-legacy-mutation'
    const chat = durableChat(chatId, 3)
    // No seeded file: the first admitted save writes the compatibility
    // checkpoint and seeds the journal exactly as before the cutover.
    const m3 = message('m3', 'assistant', 'Legacy path mutation')
    const author = new ChatTranscriptMutationAuthor(chat.messages.length)
    author.append([m3])

    AppStore.saveChat(
      { ...chat, messages: [...chat.messages, m3] },
      {
        authoredTranscript: author.finish()
      }
    )

    expect(enqueued).toHaveLength(0)
    expect(existsSync(join(profilePath, 'chats', `${chatId}.json`))).toBe(true)
    const seedStats = AppStore.getIncrementalChatPersistenceStats()
    expect(seedStats.seeds).toBe(1)
    expect(seedStats.mutationBatchesAppended).toBe(0)

    // A follow-up admitted mutation save appends through the legacy wrapper.
    const current = AppStore.getChat(chatId)!
    const m4 = message('m4', 'assistant', 'Legacy second mutation')
    const author2 = new ChatTranscriptMutationAuthor(current.messages.length)
    author2.append([m4])
    AppStore.saveChat(
      { ...current, messages: [...current.messages, m4] },
      {
        authoredTranscript: author2.finish()
      }
    )

    const stats = AppStore.getIncrementalChatPersistenceStats()
    expect(stats.mutationBatchesAppended).toBe(1)
    expect(enqueued).toHaveLength(0)
    expect(AppStore.getChat(chatId)?.messages.map((entry) => entry.id)).toEqual([
      'm1',
      'm2',
      'm3',
      'm4'
    ])
  })
})
