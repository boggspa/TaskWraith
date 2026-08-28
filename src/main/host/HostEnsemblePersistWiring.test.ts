import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { HostThreadRecordPersistError } from './HostThreadRecordPersistCommand'
import type {
  HostThreadRecordPersistInput,
  HostThreadRecordPersistPort
} from './HostThreadRecordPersistCommand'

const profiles: string[] = []

afterEach(() => {
  while (profiles.length > 0) rmSync(profiles.pop()!, { recursive: true, force: true })
})

interface WiredStore {
  AppStore: typeof import('../store/index').AppStore
  LegacyStoreWriterGateClosedError: typeof import('../store/LegacyStoreWriterGate').LegacyStoreWriterGateClosedError
  profilePath: string
  persistPort: HostThreadRecordPersistPort & {
    enqueue: ReturnType<typeof vi.fn>
    drain: ReturnType<typeof vi.fn>
  }
  enqueued: HostThreadRecordPersistInput[]
}

async function importStoreWithHostOwnedGate(options?: {
  hostOwnGate?: boolean
}): Promise<WiredStore> {
  const profilePath = mkdtempSync(join(tmpdir(), 'taskwraith-ensemble-persist-wiring-'))
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
  const { AppStore } = await import('../store/index')
  const { legacyStoreWriterGate, LegacyStoreWriterGateClosedError } =
    await import('../store/LegacyStoreWriterGate')
  if (options?.hostOwnGate !== false) {
    if (!legacyStoreWriterGate.beginDrain()) throw new Error('test gate did not begin draining')
    const owned = legacyStoreWriterGate.markHostOwned({
      hostId: 'test-host',
      generation: 1,
      cutoverId: 'test-cutover'
    })
    if (!owned) throw new Error('test gate did not become host-owned')
  }
  const enqueued: HostThreadRecordPersistInput[] = []
  const persistPort = {
    persist: vi.fn(),
    enqueue: vi.fn((input: HostThreadRecordPersistInput) => {
      enqueued.push(input)
    }),
    drain: vi.fn(async () => {}),
    drainAll: vi.fn(async () => {}),
    pending: vi.fn(() => 0)
  }
  AppStore.setHostThreadRecordPersistPortForTests(persistPort)
  return { AppStore, LegacyStoreWriterGateClosedError, profilePath, persistPort, enqueued }
}

function ensembleChatRecord(appChatId: string): Record<string, unknown> {
  return {
    appChatId,
    scope: 'global',
    chatKind: 'ensemble',
    provider: 'codex',
    title: 'New Ensemble',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    workflowMode: 'normal',
    messages: [
      {
        id: 'ensemble-user-round-1',
        role: 'user',
        content: 'Ship the cutover fix.',
        timestamp: '2026-08-27T00:00:00.000Z',
        metadata: { kind: 'ensembleRoundPrompt', ensembleRoundId: 'round-1' }
      }
    ],
    runs: [],
    ensemble: {
      enabled: true,
      maxParticipants: 8,
      orchestrationMode: 'turn_bound',
      participants: [
        {
          id: 'seat-boss',
          provider: 'codex',
          enabled: true,
          role: 'Boss',
          instructions: 'Coordinate the panel.',
          order: 1,
          permissionPresetId: 'default'
        },
        {
          id: 'seat-worker',
          provider: 'kimi',
          enabled: true,
          role: 'Worker',
          instructions: 'Implement the assigned slice.',
          order: 2,
          permissionPresetId: 'workspace_write'
        }
      ],
      bossmanParticipantId: 'seat-boss',
      activeRound: {
        roundId: 'round-1',
        status: 'running',
        startedAt: '2026-08-27T00:00:00.000Z',
        participants: [
          { participantId: 'seat-boss', provider: 'codex', role: 'Boss', order: 1, status: 'idle' }
        ],
        waves: [{ waveId: 'wave-1', laneIds: ['lane-1'] }]
      }
    },
    unknownDesktopField: { future: 'preserved' }
  }
}

describe('HostEnsemblePersistWiring', () => {
  it('persists an ensemble round-start save through the Host when the gate is Host-owned (the user regression)', async () => {
    const { AppStore, persistPort, enqueued } = await importStoreWithHostOwnedGate()
    const chat = ensembleChatRecord('chat-ensemble-round')
    // RED-first evidence: before this slice this exact call threw
    // LegacyStoreWriterGateClosedError (proven against HEAD in this file's
    // first revision). It must now succeed synchronously and enqueue.
    let saved: Record<string, unknown> | undefined
    expect(() => {
      saved = AppStore.saveChat(chat as never) as unknown as Record<string, unknown>
    }).not.toThrow()
    expect(persistPort.enqueue).toHaveBeenCalledTimes(1)
    const [input] = enqueued
    expect(input.chatId).toBe('chat-ensemble-round')
    expect(input.expectedRevision).toBe(0)
    // The Host owns the next revision; the record is stamped with what the
    // Host will write for a create (0), keeping the two counters in lockstep.
    expect((saved as { persistenceRevision?: number }).persistenceRevision).toBe(0)
    // (d) Desktop-authored ensemble state (roster/round/wave lanes) and an
    // unknown future field survive the round trip losslessly. toMatchObject:
    // normalizeChatRecord legitimately enriches the ensemble (updatedAt stamp).
    const record = input.record as unknown as Record<string, unknown>
    expect(record.ensemble).toMatchObject(chat.ensemble as Record<string, unknown>)
    expect(record.unknownDesktopField).toEqual({ future: 'preserved' })
    // The durability barrier drains exactly this chat.
    await AppStore.awaitChatRecordPersisted('chat-ensemble-round')
    expect(persistPort.drain).toHaveBeenCalledWith('chat-ensemble-round')
  })

  it('creates an ensemble chat through the Host path with the create-case revision contract', async () => {
    const { AppStore, enqueued } = await importStoreWithHostOwnedGate()
    const chat = AppStore.createEnsembleChat({}, new Set(['codex'] as never))
    expect(chat.chatKind).toBe('ensemble')
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].chatId).toBe(chat.appChatId)
    expect(enqueued[0].expectedRevision).toBe(0)
    expect(
      (enqueued[0].record as unknown as { persistenceRevision?: number }).persistenceRevision
    ).toBe(0)
    // The renderer-facing object carries the same stamp.
    expect(chat.persistenceRevision).toBe(0)
    // A second save builds on the persisted revision (lockstep with the Host).
    AppStore.saveChat({ ...chat, title: 'Renamed ensemble' })
    expect(enqueued).toHaveLength(2)
    expect(enqueued[1].expectedRevision).toBe(0)
    expect(
      (enqueued[1].record as unknown as { persistenceRevision?: number }).persistenceRevision
    ).toBe(1)
  })

  it('surfaces a Host persist failure at the round-start barrier instead of swallowing it', async () => {
    const { AppStore, persistPort } = await importStoreWithHostOwnedGate()
    const failure = new HostThreadRecordPersistError(
      'host_unavailable',
      'The Host is not reachable.'
    )
    persistPort.drain.mockRejectedValueOnce(failure)
    const chat = ensembleChatRecord('chat-ensemble-failure')
    // The synchronous save still cannot throw (86 call sites depend on it).
    expect(() => AppStore.saveChat(chat as never)).not.toThrow()
    // ...but the barrier rethrows the typed failure where the user meets it.
    await expect(AppStore.awaitChatRecordPersisted('chat-ensemble-failure')).rejects.toBe(failure)
  })

  it('keeps the proven legacy admitted path when the writer gate is open', async () => {
    const { AppStore, persistPort } = await importStoreWithHostOwnedGate({ hostOwnGate: false })
    const chat = ensembleChatRecord('chat-ensemble-legacy')
    expect(() => AppStore.saveChat(chat as never)).not.toThrow()
    expect(persistPort.enqueue).not.toHaveBeenCalled()
    const persisted = AppStore.getChat('chat-ensemble-legacy')
    expect(persisted?.ensemble).toMatchObject({
      bossmanParticipantId: 'seat-boss',
      activeRound: { roundId: 'round-1' }
    })
  })

  it('heals the in-memory shadow when the Host advances the record (solo-chat interop)', async () => {
    const { AppStore, profilePath, enqueued } = await importStoreWithHostOwnedGate()
    // A desktop save through the Host branch leaves a dirty in-memory shadow.
    AppStore.saveChat({
      ...ensembleChatRecord('chat-solo-interop'),
      chatKind: 'single',
      ensemble: undefined
    } as never)
    // While the Host has not landed the file, the shadow is served.
    expect(AppStore.getChat('chat-solo-interop')?.title).toBe('New Ensemble')
    // The Host then lands the write AND advances the record on its own (solo
    // run lifecycle / thread.configure): revision 3, newer title.
    const chatsDir = join(profilePath, 'chats')
    mkdirSync(chatsDir, { recursive: true, mode: 0o700 })
    const hostAdvanced = {
      ...ensembleChatRecord('chat-solo-interop'),
      chatKind: 'single',
      ensemble: undefined,
      title: 'Host-side update',
      persistenceRevision: 3,
      updatedAt: 2000
    }
    writeFileSync(join(chatsDir, 'chat-solo-interop.json'), JSON.stringify(hostAdvanced))
    chmodSync(join(chatsDir, 'chat-solo-interop.json'), 0o600)
    // The shadow heals: reads return the Host's newer record, not the stale
    // desktop projection, so a transcript cannot freeze on the dirty marker.
    expect(AppStore.getChat('chat-solo-interop')?.title).toBe('Host-side update')
    // And the next desktop save builds on the Host's true revision instead of
    // looping a revision conflict against its own shadow.
    AppStore.saveChat({ ...hostAdvanced, title: 'Desktop follow-up' } as never)
    const last = enqueued[enqueued.length - 1]
    expect(last.expectedRevision).toBe(3)
    expect((last.record as unknown as { persistenceRevision?: number }).persistenceRevision).toBe(4)
  })
})
