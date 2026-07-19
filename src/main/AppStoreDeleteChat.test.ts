import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { AppStore } from './store'
import { kimiAcpSeatStatePath, kimiAcpSeatStateRoot } from './kimi/KimiAcpSeatState'
import type { ChatRecord, ChatRun } from './store/types'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-delete-chat-test-${process.pid}`)

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  }
}))

const runEventPath = (runId: string): string => join(userDataPath, 'run-events', `${runId}.jsonl`)
const artifactDir = (runId: string): string => join(userDataPath, 'run-artifacts', runId)
const chatListIndexPath = (): string => join(userDataPath, 'chat-list-index.json')
const runQueuePath = (): string => join(userDataPath, 'run-queue.json')
const runRecoveryPath = (): string => join(userDataPath, 'run-recovery.json')
const approvalLedgerPath = (): string => join(userDataPath, 'approval-ledger.json')

function makeRun(runId: string): ChatRun {
  return { runId, startedAt: '2026-05-08T00:00:00.000Z' }
}

function seedRunFiles(runId: string): void {
  fs.mkdirSync(join(userDataPath, 'run-events'), { recursive: true })
  fs.writeFileSync(runEventPath(runId), `{"runId":"${runId}"}\n`, 'utf8')
  fs.mkdirSync(artifactDir(runId), { recursive: true })
  fs.writeFileSync(join(artifactDir(runId), 'stdout.log'), 'stream\n', 'utf8')
}

function seedKimiSeat(chatId: string, participantId = 'solo'): string {
  const seatPath = kimiAcpSeatStatePath(userDataPath, chatId, participantId)
  fs.mkdirSync(join(seatPath, 'sessions'), { recursive: true })
  fs.writeFileSync(join(seatPath, 'sessions', 'checkpoint.json'), '{}', 'utf8')
  return seatPath
}

function resetStoreTestState(): void {
  AppStore.resetTransientDeletionGuardsForTests()
}

function saveChatWithRuns(appChatId: string, runs: ChatRun[]): ChatRecord {
  const chat: ChatRecord = {
    appChatId,
    scope: 'workspace',
    chatKind: 'single',
    provider: 'gemini',
    title: appChatId,
    workspaceId: 'workspace-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs
  }
  AppStore.saveChat(chat)
  return chat
}

describe('AppStore.deleteChat run cleanup', () => {
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    resetStoreTestState()
    fs.mkdirSync(join(userDataPath, 'chats'), { recursive: true })
  })

  it('removes the deleted chat run-event files and artifacts', () => {
    saveChatWithRuns('chat-a', [makeRun('run-1'), makeRun('run-2')])
    seedRunFiles('run-1')
    seedRunFiles('run-2')

    expect(fs.existsSync(runEventPath('run-1'))).toBe(true)
    expect(fs.existsSync(artifactDir('run-1'))).toBe(true)

    AppStore.deleteChat('chat-a')

    // Chat JSON gone (behaviour preserved).
    expect(fs.existsSync(join(userDataPath, 'chats', 'chat-a.json'))).toBe(false)
    // Both runs' forensic files removed.
    expect(fs.existsSync(runEventPath('run-1'))).toBe(false)
    expect(fs.existsSync(artifactDir('run-1'))).toBe(false)
    expect(fs.existsSync(runEventPath('run-2'))).toBe(false)
    expect(fs.existsSync(artifactDir('run-2'))).toBe(false)
  })

  it('leaves a sibling chat with a prefix-similar run id untouched', () => {
    // chat-a owns `run-1`; sibling chat-b owns `run-1-extra` whose id has
    // `run-1` as a string prefix. A prefix/readdir-based delete would wrongly
    // catch the sibling's files; an exact-name delete must not.
    saveChatWithRuns('chat-a', [makeRun('run-1')])
    saveChatWithRuns('chat-b', [makeRun('run-1-extra')])
    seedRunFiles('run-1')
    seedRunFiles('run-1-extra')

    AppStore.deleteChat('chat-a')

    // Deleted chat's run is gone...
    expect(fs.existsSync(runEventPath('run-1'))).toBe(false)
    expect(fs.existsSync(artifactDir('run-1'))).toBe(false)
    // ...but the sibling's prefix-similar run is fully intact.
    expect(fs.existsSync(runEventPath('run-1-extra'))).toBe(true)
    expect(fs.existsSync(artifactDir('run-1-extra'))).toBe(true)
    expect(fs.existsSync(join(userDataPath, 'chats', 'chat-b.json'))).toBe(true)
  })

  it('succeeds when a run-event file is already missing', () => {
    // run-1 has files, run-2 was never persisted (missing on disk).
    saveChatWithRuns('chat-a', [makeRun('run-1'), makeRun('run-2')])
    seedRunFiles('run-1')
    expect(fs.existsSync(runEventPath('run-2'))).toBe(false)

    expect(() => AppStore.deleteChat('chat-a')).not.toThrow()

    expect(fs.existsSync(runEventPath('run-1'))).toBe(false)
    expect(fs.existsSync(join(userDataPath, 'chats', 'chat-a.json'))).toBe(false)
  })

  it('removes only the deleted chat native Kimi seat checkpoints', () => {
    saveChatWithRuns('chat-a', [])
    saveChatWithRuns('chat-b', [])
    const solo = seedKimiSeat('chat-a')
    const participant = seedKimiSeat('chat-a', 'worker')
    const sibling = seedKimiSeat('chat-b')
    const chat = AppStore.getChat('chat-a')!
    AppStore.saveChat({
      ...chat,
      chatKind: 'ensemble',
      ensemble: {
        enabled: true,
        maxParticipants: 1,
        participants: [
          {
            id: 'worker',
            provider: 'kimi',
            enabled: true,
            role: 'Worker',
            instructions: '',
            order: 1
          }
        ]
      }
    })

    AppStore.deleteChat('chat-a')

    expect(fs.existsSync(solo)).toBe(false)
    expect(fs.existsSync(participant)).toBe(false)
    expect(fs.existsSync(sibling)).toBe(true)
  })
})

describe('AppStore.deleteChat cascade + orphan reap', () => {
  const chatFile = (id: string): string => join(userDataPath, 'chats', `${id}.json`)

  function saveChild(
    appChatId: string,
    parentChatId: string,
    relation?: 'subThread' | 'sideChat'
  ): void {
    const chat: ChatRecord = {
      appChatId,
      scope: 'workspace',
      chatKind: 'single',
      provider: 'gemini',
      title: appChatId,
      workspaceId: 'workspace-1',
      workspacePath: '/repo',
      parentChatId,
      ...(relation ? { parentChatRelation: relation } : {}),
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      messages: [],
      runs: []
    }
    AppStore.saveChat(chat)
  }

  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    resetStoreTestState()
    fs.mkdirSync(join(userDataPath, 'chats'), { recursive: true })
    // The orphan reap runs once per process; reset the latch so each test
    // exercises it fresh.
    ;(AppStore as unknown as { orphanSubThreadsReaped: boolean }).orphanSubThreadsReaped = false
  })

  it('cascades deletion to sub-thread, side-chat and nested children', () => {
    saveChatWithRuns('parent', [])
    saveChild('sub', 'parent', 'subThread')
    saveChild('side', 'parent', 'sideChat')
    saveChild('grandchild', 'sub', 'subThread')

    AppStore.deleteChat('parent')

    expect(fs.existsSync(chatFile('parent'))).toBe(false)
    expect(fs.existsSync(chatFile('sub'))).toBe(false)
    expect(fs.existsSync(chatFile('side'))).toBe(false)
    expect(fs.existsSync(chatFile('grandchild'))).toBe(false)
  })

  it('does not touch unrelated chats when cascading', () => {
    saveChatWithRuns('parent', [])
    saveChild('sub', 'parent', 'subThread')
    saveChatWithRuns('bystander', [])

    AppStore.deleteChat('parent')

    expect(fs.existsSync(chatFile('sub'))).toBe(false)
    expect(fs.existsSync(chatFile('bystander'))).toBe(true)
  })

  it('discovers an orphan without deleting from the getChats read path', () => {
    // Legacy orphan: child persisted, parent never existed on disk.
    saveChild('orphan', 'missing-parent', 'subThread')
    expect(fs.existsSync(chatFile('orphan'))).toBe(true)

    const chats = AppStore.getChats()

    expect(fs.existsSync(chatFile('orphan'))).toBe(true)
    expect(chats.some((c) => c.appChatId === 'orphan')).toBe(false)
    expect(AppStore.listOrphanSubThreadReapCandidates()).toEqual(['orphan'])

    // Main owns the lifecycle-fenced deletion, then acknowledges only after it
    // succeeds. A failed main deletion leaves the candidate retryable.
    AppStore.deleteChat('orphan')
    AppStore.acknowledgeOrphanSubThreadReapCandidate('orphan')
    expect(fs.existsSync(chatFile('orphan'))).toBe(false)
    expect(AppStore.listOrphanSubThreadReapCandidates()).toEqual([])
  })

  it('keeps a child whose parent still exists', () => {
    saveChatWithRuns('parent', [])
    saveChild('sub', 'parent', 'subThread')

    const chats = AppStore.getChats()

    expect(fs.existsSync(chatFile('sub'))).toBe(true)
    expect(fs.existsSync(chatFile('parent'))).toBe(true)
    expect(chats.some((c) => c.appChatId === 'sub')).toBe(true)
  })
})

describe('AppStore.clearChats all-history cleanup', () => {
  const chatFile = (id: string): string => join(userDataPath, 'chats', `${id}.json`)

  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    resetStoreTestState()
    fs.mkdirSync(join(userDataPath, 'chats'), { recursive: true })
    ;(AppStore as unknown as { orphanSubThreadsReaped: boolean }).orphanSubThreadsReaped = false
  })

  it('removes every chat file, malformed chat, index, run events, and artifacts', () => {
    const parent = saveChatWithRuns('parent', [makeRun('run-parent')])
    saveChatWithRuns('ensemble', [makeRun('run-ensemble')])
    fs.writeFileSync(chatFile('malformed'), '{not json', 'utf8')
    fs.writeFileSync(
      runQueuePath(),
      JSON.stringify([{ runId: 'queued-run', request: { prompt: 'private queued prompt' } }]),
      'utf8'
    )
    fs.writeFileSync(
      runRecoveryPath(),
      JSON.stringify([{ runId: 'recovered-run', promptPreview: 'private recovered prompt' }]),
      'utf8'
    )
    fs.writeFileSync(
      approvalLedgerPath(),
      JSON.stringify([{ approvalId: 'legacy-eval', preview: { script: 'private script' } }]),
      'utf8'
    )
    seedRunFiles('run-parent')
    seedRunFiles('run-ensemble')
    seedRunFiles('orphan-run')
    seedKimiSeat('parent')

    expect(fs.existsSync(chatListIndexPath())).toBe(true)
    expect(fs.existsSync(chatFile('malformed'))).toBe(true)
    expect(fs.existsSync(runEventPath('orphan-run'))).toBe(true)
    expect(fs.existsSync(runQueuePath())).toBe(true)
    expect(fs.existsSync(runRecoveryPath())).toBe(true)
    expect(fs.existsSync(approvalLedgerPath())).toBe(true)

    AppStore.clearChats()

    AppStore.saveChat(parent)
    AppStore.appendRunEvent({
      runId: 'orphan-run',
      provider: 'gemini',
      kind: 'lifecycle',
      phase: 'control',
      source: 'renderer',
      summary: 'late event'
    })

    expect(fs.existsSync(chatFile('parent'))).toBe(false)
    expect(fs.existsSync(chatFile('ensemble'))).toBe(false)
    expect(fs.existsSync(chatFile('malformed'))).toBe(false)
    expect(fs.existsSync(chatListIndexPath())).toBe(false)
    expect(fs.existsSync(runEventPath('run-parent'))).toBe(false)
    expect(fs.existsSync(runEventPath('run-ensemble'))).toBe(false)
    expect(fs.existsSync(runEventPath('orphan-run'))).toBe(false)
    expect(fs.existsSync(artifactDir('run-parent'))).toBe(false)
    expect(fs.existsSync(artifactDir('orphan-run'))).toBe(false)
    expect(fs.existsSync(runQueuePath())).toBe(false)
    expect(fs.existsSync(runRecoveryPath())).toBe(false)
    expect(fs.existsSync(approvalLedgerPath())).toBe(false)
    expect(fs.existsSync(kimiAcpSeatStateRoot(userDataPath))).toBe(false)
    expect(AppStore.getChats()).toEqual([])
  })

  it('keeps workspace-scoped clear limited to that workspace', () => {
    const workspaceA = saveChatWithRuns('workspace-a-chat', [makeRun('run-a')])
    const workspaceB = saveChatWithRuns('workspace-b-chat', [makeRun('run-b')])
    AppStore.saveChat({ ...workspaceB, workspaceId: 'workspace-2', workspacePath: '/repo-2' })
    seedRunFiles('run-a')
    seedRunFiles('run-b')
    fs.writeFileSync(approvalLedgerPath(), '[{"approvalId":"global-ledger"}]', 'utf8')

    AppStore.clearChats(workspaceA.workspaceId)

    expect(fs.existsSync(chatFile('workspace-a-chat'))).toBe(false)
    expect(fs.existsSync(runEventPath('run-a'))).toBe(false)
    expect(fs.existsSync(chatFile('workspace-b-chat'))).toBe(true)
    expect(fs.existsSync(runEventPath('run-b'))).toBe(true)
    expect(fs.existsSync(approvalLedgerPath())).toBe(true)
    expect(AppStore.getChats().map((chat) => chat.appChatId)).toEqual(['workspace-b-chat'])
  })

  it('does not recreate a workspace-cleared run event from a late append', () => {
    const workspaceA = saveChatWithRuns('workspace-a-chat', [makeRun('run-a')])
    AppStore.appendRunEvent({
      runId: 'run-a',
      chatId: workspaceA.appChatId,
      workspaceId: workspaceA.workspaceId,
      workspacePath: workspaceA.workspacePath,
      provider: 'gemini',
      kind: 'lifecycle',
      phase: 'control',
      source: 'renderer',
      summary: 'initial event'
    })
    expect(fs.existsSync(runEventPath('run-a'))).toBe(true)

    AppStore.clearChats(workspaceA.workspaceId)
    AppStore.appendRunEvent({
      runId: 'run-a',
      chatId: workspaceA.appChatId,
      workspaceId: workspaceA.workspaceId,
      workspacePath: workspaceA.workspacePath,
      provider: 'gemini',
      kind: 'lifecycle',
      phase: 'control',
      source: 'renderer',
      summary: 'late event'
    })

    expect(fs.existsSync(runEventPath('run-a'))).toBe(false)
  })
})
