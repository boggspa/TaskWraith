import * as fs from 'fs'
import * as path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  normalizeCandidate,
  patchFanoutWorktreeCandidate,
  readFanoutWorktreeCandidates,
  upsertFanoutWorktreeCandidatePatch
} from './FanoutCandidatePersistence'
import type { ChatRecord, FanoutWorktreeCandidate } from './types'

const testRoot = path.join('/tmp', `taskwraith-fanout-candidate-persist-${process.pid}`)

afterEach(() => {
  fs.rmSync(testRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function storedChat(chatId: string): ChatRecord {
  return {
    appChatId: chatId,
    scope: 'workspace',
    chatKind: 'ensemble',
    title: 'Ensemble',
    workspaceId: 'workspace-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    persistenceRevision: 3,
    archived: false,
    messages: [],
    runs: []
  }
}

function candidate(overrides: Partial<FanoutWorktreeCandidate> = {}): FanoutWorktreeCandidate {
  return {
    schemaVersion: 1,
    candidateId: 'lane-r1-p1-1',
    roundId: 'r1',
    laneId: 'lane-r1-p1-1',
    runId: 'run-1',
    participantId: 'p1',
    participantLabel: 'Writer',
    provider: 'claude',
    model: 'cli-default',
    baseWorkspacePath: '/repo/',
    worktreePath: '/worktrees/fanout-p1-abc123/',
    branch: 'taskwraith/fanout-p1-abc123',
    createdAt: '2026-07-25T00:00:00.000Z',
    status: 'active',
    ...overrides
  }
}

async function seedChat(chatId: string, record: ChatRecord = storedChat(chatId)): Promise<string> {
  const chatsDir = path.join(testRoot, 'chats')
  await fs.promises.mkdir(chatsDir, { recursive: true })
  await fs.promises.writeFile(path.join(chatsDir, `${chatId}.json`), JSON.stringify(record))
  return chatsDir
}

describe('upsertFanoutWorktreeCandidatePatch', () => {
  it('appends a normalized candidate and preserves the rest of the record', async () => {
    const chatId = 'ensemble-1'
    const chatsDir = await seedChat(chatId, { ...storedChat(chatId), title: 'Keep this title' })

    const saved = await upsertFanoutWorktreeCandidatePatch({
      chatsDir,
      chatId,
      candidate: candidate()
    })

    expect(saved.title).toBe('Keep this title')
    expect(saved.persistenceRevision).toBe(4)
    expect(saved.fanoutWorktreeCandidates).toHaveLength(1)
    expect(saved.fanoutWorktreeCandidates?.[0]).toMatchObject({
      candidateId: 'lane-r1-p1-1',
      baseWorkspacePath: '/repo',
      worktreePath: '/worktrees/fanout-p1-abc123',
      status: 'active'
    })
    const tmpEntries = (await fs.promises.readdir(chatsDir)).filter((entry) =>
      entry.endsWith('.tmp')
    )
    expect(tmpEntries).toEqual([])
  })

  it('replaces an existing candidate with the same id instead of duplicating', async () => {
    const chatId = 'ensemble-2'
    const chatsDir = await seedChat(chatId)

    await upsertFanoutWorktreeCandidatePatch({ chatsDir, chatId, candidate: candidate() })
    await upsertFanoutWorktreeCandidatePatch({
      chatsDir,
      chatId,
      candidate: candidate({ status: 'settled', runStatus: 'completed' })
    })

    const list = await readFanoutWorktreeCandidates({ chatsDir, chatId })
    expect(list).toHaveLength(1)
    expect(list[0].status).toBe('settled')
    expect(list[0].runStatus).toBe('completed')
  })

  it('refuses a candidate with missing identity fields', async () => {
    const chatId = 'ensemble-3'
    const chatsDir = await seedChat(chatId)
    await expect(
      upsertFanoutWorktreeCandidatePatch({
        chatsDir,
        chatId,
        candidate: candidate({ worktreePath: '  ' })
      })
    ).rejects.toThrow('missing worktreePath')
  })
})

describe('patchFanoutWorktreeCandidate', () => {
  it('merges a partial update into the target candidate only', async () => {
    const chatId = 'ensemble-4'
    const chatsDir = await seedChat(chatId)
    await upsertFanoutWorktreeCandidatePatch({ chatsDir, chatId, candidate: candidate() })
    await upsertFanoutWorktreeCandidatePatch({
      chatsDir,
      chatId,
      candidate: candidate({ candidateId: 'lane-r1-p2-1', laneId: 'lane-r1-p2-1' })
    })

    const updated = await patchFanoutWorktreeCandidate({
      chatsDir,
      chatId,
      candidateId: 'lane-r1-p1-1',
      patch: {
        status: 'settled',
        runStatus: 'completed',
        settledAt: '2026-07-25T01:00:00.000Z',
        diffStat: { files: 2, insertions: 10, deletions: 1 }
      }
    })

    expect(updated).not.toBeNull()
    const list = await readFanoutWorktreeCandidates({ chatsDir, chatId })
    expect(list.find((entry) => entry.candidateId === 'lane-r1-p1-1')).toMatchObject({
      status: 'settled',
      runStatus: 'completed',
      diffStat: { files: 2, insertions: 10, deletions: 1 }
    })
    expect(list.find((entry) => entry.candidateId === 'lane-r1-p2-1')?.status).toBe('active')
  })

  it('resolves null for an unknown candidate without touching the record', async () => {
    const chatId = 'ensemble-5'
    const chatsDir = await seedChat(chatId)

    const result = await patchFanoutWorktreeCandidate({
      chatsDir,
      chatId,
      candidateId: 'lane-missing',
      patch: { status: 'settled' }
    })

    expect(result).toBeNull()
    const onDisk = JSON.parse(
      await fs.promises.readFile(path.join(chatsDir, `${chatId}.json`), 'utf-8')
    ) as ChatRecord
    expect(onDisk.persistenceRevision).toBe(3)
  })
})

describe('readFanoutWorktreeCandidates', () => {
  it('drops malformed legacy entries instead of failing the list', async () => {
    const chatId = 'ensemble-6'
    const chatsDir = await seedChat(chatId, {
      ...storedChat(chatId),
      fanoutWorktreeCandidates: [
        candidate(),
        { schemaVersion: 1, candidateId: 'broken' } as FanoutWorktreeCandidate
      ]
    })

    const list = await readFanoutWorktreeCandidates({ chatsDir, chatId })
    expect(list).toHaveLength(1)
    expect(list[0].candidateId).toBe('lane-r1-p1-1')
  })

  it('returns empty for a missing chat', async () => {
    await expect(
      readFanoutWorktreeCandidates({ chatsDir: path.join(testRoot, 'chats'), chatId: 'missing' })
    ).resolves.toEqual([])
  })
})

describe('normalizeCandidate', () => {
  it('rejects unknown statuses and preserves optional fields', () => {
    expect(() =>
      normalizeCandidate(candidate({ status: 'weird' as FanoutWorktreeCandidate['status'] }))
    ).toThrow('unrecognized schema or status')
    const normalized = normalizeCandidate(
      candidate({ reason: '  drift  ', model: '', participantLabel: '  Writer  ' })
    )
    expect(normalized.reason).toBe('drift')
    expect(normalized.model).toBeUndefined()
    expect(normalized.participantLabel).toBe('Writer')
  })

  it('preserves a valid promotion intent and rejects malformed patch digests', () => {
    expect(
      normalizeCandidate(
        candidate({
          promotionIntent: {
            patchSha256: 'A'.repeat(64),
            startedAt: '2026-07-29T18:00:00.000Z'
          }
        })
      ).promotionIntent
    ).toEqual({
      patchSha256: 'a'.repeat(64),
      startedAt: '2026-07-29T18:00:00.000Z'
    })
    expect(() =>
      normalizeCandidate(
        candidate({
          promotionIntent: {
            patchSha256: 'not-a-digest',
            startedAt: '2026-07-29T18:00:00.000Z'
          }
        })
      )
    ).toThrow('malformed promotion intent')
  })
})
