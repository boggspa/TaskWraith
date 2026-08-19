import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { AppStore, HistoryDeletionMutationBlockedError } from './store'
import type { ChatRecord } from './store/types'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-subthread-mailbox-test-${process.pid}`)

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  }
}))

function eventInput(sourceAssistantMessageId = 'assistant-1') {
  return {
    parentChatId: 'parent-1',
    subThreadId: 'child-1',
    subThreadProvider: 'codex' as const,
    subThreadTitle: 'Worker',
    sourceAssistantMessageId,
    sourceRunId: 'child-run-1',
    outcome: 'done' as const,
    required: true,
    priority: 'normal' as const,
    content: `Result from ${sourceAssistantMessageId}`
  }
}

function saveParent(): void {
  AppStore.saveChat({
    appChatId: 'parent-1',
    scope: 'workspace',
    chatKind: 'single',
    provider: 'claude',
    title: 'Parent',
    workspaceId: 'ws-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: []
  } as ChatRecord)
}

describe('AppStore sub-thread mailbox ledger', () => {
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(userDataPath, { recursive: true })
    AppStore.resetTransientDeletionGuardsForTests()
  })

  it('persists ordered mailbox events independently of chat records', () => {
    const first = AppStore.enqueueSubThreadMailboxEvent(eventInput('assistant-1'), {
      now: '2026-07-11T12:00:00.000Z'
    })
    const duplicate = AppStore.enqueueSubThreadMailboxEvent(eventInput('assistant-1'))
    AppStore.enqueueSubThreadMailboxEvent(eventInput('assistant-2'), {
      now: '2026-07-11T12:01:00.000Z'
    })

    const mailbox = AppStore.getSubThreadMailbox('parent-1')
    expect(first.inserted).toBe(true)
    expect(duplicate.inserted).toBe(false)
    expect(mailbox.events.map((event) => event.sequence)).toEqual([1, 2])
    // Ledger semantics: processed at enqueue — no delivery leg exists.
    expect(mailbox.events.every((event) => event.processedAt === event.createdAt)).toBe(true)
    expect(fs.existsSync(join(userDataPath, 'subthread-mailboxes.json'))).toBe(true)
    expect(fs.existsSync(join(userDataPath, 'chats', 'parent-1.json'))).toBe(false)
  })

  it('persists the delegated worker join policy on the child record', () => {
    saveParent()
    const joinPolicy = {
      schemaVersion: 1 as const,
      groupId: 'parent-run-1',
      required: false,
      quorum: 1,
      debounceMs: 350,
      armedAt: '2026-07-11T12:00:00.000Z',
      deadlineAt: '2026-07-11T12:05:00.000Z'
    }
    const child = AppStore.createSubThread({
      parentChatId: 'parent-1',
      provider: 'codex',
      delegationPrompt: 'Review the diff.',
      returnResultToParent: true,
      joinPolicy
    })

    expect(child.delegationContext?.joinPolicy).toEqual(joinPolicy)
    expect(AppStore.getChat(child.appChatId)?.delegationContext?.joinPolicy).toEqual(joinPolicy)
  })

  it('fences ledger enqueue on a prepared (uncommitted) deletion of the parent', () => {
    saveParent()
    AppStore.prepareHistoryDeletion({ kind: 'chat', rootChatId: 'parent-1' })

    // The one surviving mailbox writer must observe the durable fence:
    // no ledger write into a frozen parent.
    expect(() => AppStore.enqueueSubThreadMailboxEvent(eventInput())).toThrow(
      HistoryDeletionMutationBlockedError
    )
    expect(AppStore.getSubThreadMailbox('parent-1').events).toEqual([])
  })

  it('deletes a parent mailbox with the parent chat and clears all ledgers with chat history', () => {
    saveParent()
    AppStore.enqueueSubThreadMailboxEvent(eventInput())
    AppStore.deleteChat('parent-1')
    expect(AppStore.getSubThreadMailbox('parent-1').events).toEqual([])

    saveParent()
    AppStore.enqueueSubThreadMailboxEvent(eventInput('assistant-2'))
    AppStore.clearChats()
    expect(fs.existsSync(join(userDataPath, 'subthread-mailboxes.json'))).toBe(false)
  })
})
