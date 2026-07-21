import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import {
  AppStore,
  HistoryDeletionIncompleteError,
  HistoryDeletionMutationBlockedError,
  HistoryDeletionQuiescenceRequiredError
} from './store'
import { getNextScheduledTaskRunAtMs } from './ScheduledTaskTimer'
import { kimiAcpSeatStatePath } from './kimi/KimiAcpSeatState'
import type { ChatRecord, ChatRun } from './store/types'

const userDataPath = vi.hoisted(
  () => `/tmp/taskwraith-history-deletion-transaction-test-${process.pid}`
)

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  }
}))

const historyIntentPath = join(userDataPath, 'history-deletion-intent.json')
const runQueuePath = join(userDataPath, 'run-queue.json')
const runRecoveryPath = join(userDataPath, 'run-recovery.json')
const approvalLedgerPath = join(userDataPath, 'approval-ledger.json')
const mailboxPath = join(userDataPath, 'subthread-mailboxes.json')
const settingsPath = join(userDataPath, 'settings.json')
const chatsDir = join(userDataPath, 'chats')
const runEventsDir = join(userDataPath, 'run-events')
const runArtifactsDir = join(userDataPath, 'run-artifacts')
const scheduledTasksPath = join(userDataPath, 'scheduled-tasks.json')
const workflowsPath = join(userDataPath, 'workflows.json')
const workflowRunsDir = join(userDataPath, 'workflow-runs')

function chatPath(chatId: string): string {
  return join(chatsDir, `${chatId}.json`)
}

function makeRun(runId: string): ChatRun {
  return { runId, startedAt: '2026-07-19T00:00:00.000Z' }
}

function saveChat(
  chatId: string,
  workspaceId: string,
  runs: ChatRun[] = [],
  extra: Partial<ChatRecord> = {}
): ChatRecord {
  const chat: ChatRecord = {
    appChatId: chatId,
    scope: 'workspace',
    chatKind: 'single',
    provider: 'codex',
    title: chatId,
    workspaceId,
    workspacePath: `/repo/${workspaceId}`,
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs,
    ...extra
  }
  AppStore.saveChat(chat)
  return chat
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(join(filePath, '..'), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(value), 'utf8')
}

function readArray(filePath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(filePath)) return []
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Array<Record<string, unknown>>
}

function scheduledTemplate(chatId: string, workspaceId: string, prompt: string) {
  return {
    workspaceId,
    workspacePath: `/repo/${workspaceId}`,
    chatId,
    provider: 'codex' as const,
    prompt,
    selectedModelType: 'cli-default',
    customModel: '',
    approvalMode: 'plan',
    sessionTrust: false,
    imageAttachments: []
  }
}

describe('AppStore strict history deletion transaction', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(chatsDir, { recursive: true })
    AppStore.resetTransientDeletionGuardsForTests()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('durably prepares before quiescence and refuses an early commit', () => {
    saveChat('chat-a', 'workspace-a', [makeRun('run-a')])

    const prepared = AppStore.prepareHistoryDeletion({
      kind: 'chat',
      rootChatId: 'chat-a',
      quiescenceTargets: [
        {
          id: 'provider-run:run-a',
          kind: 'provider-run',
          runId: 'run-a',
          provider: 'codex',
          chatId: 'chat-a',
          workspaceId: 'workspace-a'
        },
        { id: 'canvas:chat:chat-a', kind: 'canvas', chatId: 'chat-a' }
      ]
    })

    expect(fs.existsSync(historyIntentPath)).toBe(true)
    expect(() => AppStore.commitPreparedHistoryDeletion(prepared.operationId)).toThrow(
      HistoryDeletionQuiescenceRequiredError
    )
    expect(fs.existsSync(chatPath('chat-a'))).toBe(true)

    AppStore.recordHistoryDeletionQuiesced(prepared.operationId, ['provider-run:run-a'])
    expect(() => AppStore.commitPreparedHistoryDeletion(prepared.operationId)).toThrow(
      HistoryDeletionQuiescenceRequiredError
    )
    expect(fs.existsSync(chatPath('chat-a'))).toBe(true)

    AppStore.recordHistoryDeletionQuiesced(prepared.operationId, ['canvas:chat:chat-a'])
    AppStore.commitPreparedHistoryDeletion(prepared.operationId)

    expect(fs.existsSync(chatPath('chat-a'))).toBe(false)
    expect(fs.existsSync(historyIntentPath)).toBe(false)
  })

  it('reloads a crash-after-prepare intent and will not purge before recovery re-quiesces it', () => {
    saveChat('chat-a', 'workspace-a', [makeRun('run-a')])
    const prepared = AppStore.prepareHistoryDeletion({
      kind: 'chat',
      rootChatId: 'chat-a',
      quiescenceTargets: [
        {
          id: 'provider-run:run-a',
          kind: 'provider-run',
          runId: 'run-a',
          provider: 'codex',
          chatId: 'chat-a'
        }
      ]
    })

    AppStore.resetTransientDeletionGuardsForTests()
    expect(AppStore.getPendingHistoryDeletion()).toMatchObject({
      operationId: prepared.operationId,
      completedQuiescenceTargetIds: []
    })
    expect(() => AppStore.recoverPendingHistoryDeletion()).toThrow(
      HistoryDeletionQuiescenceRequiredError
    )
    expect(fs.existsSync(chatPath('chat-a'))).toBe(true)

    AppStore.recordHistoryDeletionQuiesced(prepared.operationId, ['provider-run:run-a'])
    AppStore.recoverPendingHistoryDeletion()

    expect(fs.existsSync(chatPath('chat-a'))).toBe(false)
    expect(AppStore.getPendingHistoryDeletion()).toBeNull()
  })

  it('rejects a Project-reference scope barrier carrying stray target identity', () => {
    const prepared = AppStore.prepareHistoryDeletion({
      kind: 'global',
      quiescenceTargets: [
        { id: 'project-reference:global', kind: 'project-reference' }
      ]
    })
    const intent = JSON.parse(fs.readFileSync(historyIntentPath, 'utf8')) as {
      quiescenceTargets: Array<Record<string, unknown>>
    }
    intent.quiescenceTargets[0].runId = 'stray-run'
    writeJson(historyIntentPath, intent)
    AppStore.resetTransientDeletionGuardsForTests()

    expect(() => AppStore.getPendingHistoryDeletion()).toThrow(
      /quiescence target does not belong/
    )
    expect(prepared.operationId).toBeTruthy()
  })

  it('uses the durable global intent as an admission fence for direct resurrection producers', () => {
    saveChat('chat-a', 'workspace-a', [makeRun('run-a')])
    const prepared = AppStore.prepareHistoryDeletion({ kind: 'global' })

    expect(() => AppStore.createGlobalChat()).toThrow(HistoryDeletionMutationBlockedError)
    expect(() =>
      AppStore.recordUsage({
        workspaceId: 'workspace-a',
        chatId: 'chat-a',
        runId: 'run-a',
        usageKind: 'run',
        model: 'model',
        provider: 'codex',
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 2,
        durationMs: 1,
        promptText: 'late prompt',
        responseText: 'late response'
      })
    ).toThrow(HistoryDeletionMutationBlockedError)
    expect(() => AppStore.createChat('workspace-b', '/repo/workspace-b')).toThrow(
      HistoryDeletionMutationBlockedError
    )
    expect(() =>
      AppStore.saveRunQueueJob({
        id: 'queue-new',
        runId: 'run-new',
        provider: 'codex',
        workspaceId: 'workspace-b',
        workspacePath: '/repo/workspace-b',
        chatId: 'chat-new',
        source: 'manual',
        status: 'queued',
        priority: 0,
        attempt: 0
      })
    ).toThrow(HistoryDeletionMutationBlockedError)
    expect(() =>
      AppStore.enqueueSubThreadMailboxEvent({
        parentChatId: 'chat-a',
        subThreadId: 'child-a',
        subThreadTitle: 'Child',
        sourceAssistantMessageId: 'message-a',
        sourceRunId: 'run-a',
        outcome: 'done',
        content: 'late result'
      })
    ).toThrow(HistoryDeletionMutationBlockedError)

    AppStore.commitPreparedHistoryDeletion(prepared.operationId)
  })

  it('refuses a cancel racer resurrecting a queue job for erased history', () => {
    saveChat('chat-a', 'workspace-a', [makeRun('run-a')])
    AppStore.saveRunQueueJob({
      id: 'run-a',
      runId: 'run-a',
      provider: 'codex',
      workspaceId: 'workspace-a',
      workspacePath: '/repo/workspace-a',
      chatId: 'chat-a',
      source: 'manual',
      status: 'active',
      priority: 0,
      attempt: 1
    })
    AppStore.deleteChat('chat-a')
    expect(readArray(runQueuePath).map((job) => job.runId)).not.toContain('run-a')

    // RunRepository.transition routes terminal cancels through saveRunQueueJob
    // as an insert; a user cancel settling after commit must not re-create the
    // job record for the erased chat/run.
    const synthetic = AppStore.saveRunQueueJob({
      id: 'run-a',
      runId: 'run-a',
      provider: 'codex',
      workspaceId: 'workspace-a',
      workspacePath: '/repo/workspace-a',
      chatId: 'chat-a',
      source: 'system',
      status: 'cancelled',
      priority: 0,
      attempt: 1
    })
    expect(synthetic.status).toBe('cancelled')
    expect(readArray(runQueuePath).map((job) => job.runId)).not.toContain('run-a')

    // A chat legitimately re-created on disk (import/restore path) queues
    // again: the tombstone rule keys on file absence, exactly like saveChat.
    writeJson(chatPath('chat-a'), {
      appChatId: 'chat-a',
      scope: 'workspace',
      chatKind: 'single',
      provider: 'codex',
      title: 'chat-a',
      workspaceId: 'workspace-a',
      workspacePath: '/repo/workspace-a',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      messages: [],
      runs: []
    })
    const requeued = AppStore.saveRunQueueJob({
      id: 'run-b',
      runId: 'run-b',
      provider: 'codex',
      workspaceId: 'workspace-a',
      workspacePath: '/repo/workspace-a',
      chatId: 'chat-a',
      source: 'manual',
      status: 'queued',
      priority: 0,
      attempt: 1
    })
    expect(requeued.runId).toBe('run-b')
    expect(readArray(runQueuePath).map((job) => job.runId)).toContain('run-b')
  })

  it('blocks only the prepared workspace while allowing unrelated chat mutations', () => {
    saveChat('chat-a', 'workspace-a')
    saveChat('chat-b', 'workspace-b')
    const prepared = AppStore.prepareHistoryDeletion({
      kind: 'workspace',
      workspaceId: 'workspace-a'
    })

    expect(() => AppStore.createChat('workspace-a', '/repo/workspace-a')).toThrow(
      HistoryDeletionMutationBlockedError
    )
    expect(() => AppStore.saveChat({ ...AppStore.getChat('chat-a')!, title: 'late write' })).toThrow(
      HistoryDeletionMutationBlockedError
    )
    expect(() => AppStore.createSideChat({ parentChatId: 'chat-a' })).toThrow(
      HistoryDeletionMutationBlockedError
    )
    expect(() => AppStore.createSubThread({
      parentChatId: 'chat-a',
      provider: 'codex',
      delegationPrompt: 'late child',
      returnResultToParent: true
    })).toThrow(HistoryDeletionMutationBlockedError)

    expect(() => AppStore.saveChat({ ...AppStore.getChat('chat-b')!, title: 'allowed' })).not.toThrow()
    expect(() => AppStore.createGlobalChat()).not.toThrow()

    AppStore.commitPreparedHistoryDeletion(prepared.operationId)
    expect(AppStore.getChat('chat-a')).toBeNull()
    expect(AppStore.getChat('chat-b')?.title).toBe('allowed')
  })

  it('keeps a prepared truncate fenced against late transcript persistence', () => {
    saveChat('chat-a', 'workspace-a', [makeRun('run-a')])
    saveChat('chat-b', 'workspace-a')
    const prepared = AppStore.prepareHistoryDeletion({ kind: 'truncate', rootChatId: 'chat-a' })

    expect(() =>
      AppStore.saveChat({
        ...AppStore.getChat('chat-a')!,
        messages: [
          {
            id: 'late-message',
            role: 'assistant',
            content: 'late output',
            timestamp: '2026-07-19T00:01:00.000Z'
          }
        ]
      })
    ).toThrow(HistoryDeletionMutationBlockedError)
    expect(() => AppStore.saveChat({ ...AppStore.getChat('chat-b')!, title: 'allowed' })).not.toThrow()

    AppStore.commitPreparedHistoryDeletion(prepared.operationId)
    expect(AppStore.getChat('chat-a')?.messages).toEqual([])
    expect(AppStore.getChat('chat-b')?.title).toBe('allowed')
  })

  it('pauses reusable schedules, purges occurrences, and preserves sibling automation', () => {
    saveChat('chat-a', 'workspace-a')
    saveChat('chat-b', 'workspace-b')
    const scheduledAt = Date.parse('2026-07-19T00:00:00.000Z')
    const standaloneA = AppStore.saveScheduledTask({
      ...scheduledTemplate('chat-a', 'workspace-a', 'preserve target schedule'),
      runAt: new Date(scheduledAt).toISOString(),
      timezone: 'UTC'
    })
    const terminalStandaloneA = AppStore.saveScheduledTask({
      ...scheduledTemplate('chat-a', 'workspace-a', 'purge completed occurrence'),
      runAt: new Date(scheduledAt - 60_000).toISOString(),
      timezone: 'UTC'
    })
    expect(
      AppStore.updateScheduledTask(terminalStandaloneA.id, {
        status: 'cancelled',
        completedAt: new Date(scheduledAt - 30_000).toISOString(),
        lastError: 'cancelled before deletion'
      })?.status
    ).toBe('cancelled')
    const standaloneB = AppStore.saveScheduledTask({
      ...scheduledTemplate('chat-b', 'workspace-b', 'preserve sibling schedule'),
      runAt: new Date(scheduledAt).toISOString(),
      timezone: 'UTC'
    })
    const workflowA = AppStore.saveWorkflowDefinition({
      name: 'Target workflow',
      workspaceId: 'workspace-a',
      workspacePath: '/repo/workspace-a',
      enabled: true,
      trigger: { kind: 'interval', intervalMs: 60_000 },
      template: scheduledTemplate('chat-a', 'workspace-a', 'preserve workflow prompt'),
      missedRunPolicy: 'skip',
      concurrencyPolicy: 'skip',
      limits: {}
    })
    const workflowB = AppStore.saveWorkflowDefinition({
      name: 'Sibling workflow',
      workspaceId: 'workspace-b',
      workspacePath: '/repo/workspace-b',
      enabled: true,
      trigger: { kind: 'interval', intervalMs: 60_000 },
      template: scheduledTemplate('chat-b', 'workspace-b', 'sibling workflow prompt'),
      missedRunPolicy: 'skip',
      concurrencyPolicy: 'skip',
      limits: {}
    })
    const occurrence = AppStore.materializeWorkflowNow(workflowA.id, scheduledAt)
    expect(occurrence?.workflowExecutionId).toBeTruthy()
    const claimed = AppStore.claimDueScheduledTaskForRun(occurrence!.id, {
      nowMs: scheduledAt,
      runId: 'scheduled-run-a',
      expectedWorkflowOccurrence: {
        workflowId: workflowA.id,
        executionId: occurrence!.workflowExecutionId!,
        plannedFor: occurrence!.workflowOccurrenceAt!,
        taskId: occurrence!.id
      }
    })
    expect(claimed?.status).toBe('running')

    AppStore.clearChats('workspace-a')

    const tasks = JSON.parse(fs.readFileSync(scheduledTasksPath, 'utf8')) as Array<
      Record<string, unknown>
    >
    expect(tasks.find((task) => task.id === occurrence!.id)).toBeUndefined()
    expect(tasks.find((task) => task.id === terminalStandaloneA.id)).toBeUndefined()
    expect(tasks.find((task) => task.id === standaloneA.id)).toMatchObject({
      status: 'cancelled',
      prompt: 'preserve target schedule',
      lastError: 'history_cleared'
    })
    expect(tasks.find((task) => task.id === standaloneA.id)).not.toHaveProperty('runId')
    expect(tasks.find((task) => task.id === standaloneB.id)).toMatchObject({
      status: 'pending',
      prompt: 'preserve sibling schedule'
    })

    const workflows = JSON.parse(fs.readFileSync(workflowsPath, 'utf8')) as Array<
      Record<string, any>
    >
    expect(workflows.find((workflow) => workflow.id === workflowA.id)).toMatchObject({
      enabled: false,
      history: [],
      lastStatus: 'cancelled',
      lastError: 'history_cleared',
      template: { prompt: 'preserve workflow prompt' }
    })
    expect(workflows.find((workflow) => workflow.id === workflowA.id)).not.toHaveProperty(
      'activeExecutionId'
    )
    expect(workflows.find((workflow) => workflow.id === workflowB.id)).toMatchObject({
      enabled: true,
      template: { prompt: 'sibling workflow prompt' }
    })
    expect(
      fs.existsSync(join(workflowRunsDir, `${occurrence!.workflowExecutionId}.jsonl`))
    ).toBe(false)
    expect(AppStore.getDueScheduledTasks(scheduledAt + 1).map((task) => task.id)).not.toContain(
      standaloneA.id
    )
  })

  it.each([
    { label: 'chat deletion', execute: () => AppStore.deleteChat('chat-a'), siblingCancelled: false },
    {
      label: 'chat truncation',
      execute: () => AppStore.truncateChatHistory('chat-a'),
      siblingCancelled: false
    },
    { label: 'global clear', execute: () => AppStore.clearChats(), siblingCancelled: true }
  ])('retires pending schedules before $label commits', ({ execute, siblingCancelled }) => {
    saveChat('chat-a', 'workspace-a')
    saveChat('chat-b', 'workspace-b')
    const taskA = AppStore.saveScheduledTask({
      ...scheduledTemplate('chat-a', 'workspace-a', 'target pending prompt'),
      runAt: '2026-07-19T00:00:00.000Z',
      timezone: 'UTC'
    })
    const taskB = AppStore.saveScheduledTask({
      ...scheduledTemplate('chat-b', 'workspace-b', 'sibling pending prompt'),
      runAt: '2026-07-19T00:00:00.000Z',
      timezone: 'UTC'
    })

    execute()

    const tasks = JSON.parse(fs.readFileSync(scheduledTasksPath, 'utf8')) as Array<
      Record<string, unknown>
    >
    expect(tasks.find((task) => task.id === taskA.id)).toMatchObject({
      status: 'cancelled',
      prompt: 'target pending prompt',
      lastError: 'history_cleared'
    })
    expect(tasks.find((task) => task.id === taskB.id)).toMatchObject({
      status: siblingCancelled ? 'cancelled' : 'pending',
      prompt: 'sibling pending prompt'
    })
  })

  it('fences scheduled dispatch and materialization throughout prepared quiescence', () => {
    saveChat('chat-a', 'workspace-a')
    saveChat('chat-b', 'workspace-b')
    const targetTask = AppStore.saveScheduledTask({
      ...scheduledTemplate('chat-a', 'workspace-a', 'target due prompt'),
      runAt: '2026-07-19T00:00:00.000Z',
      timezone: 'UTC'
    })
    AppStore.updateScheduledTask(targetTask.id, { status: 'due' })
    const targetWorkflow = AppStore.saveWorkflowDefinition({
      name: 'Target workflow',
      workspaceId: 'workspace-a',
      workspacePath: '/repo/workspace-a',
      enabled: true,
      trigger: { kind: 'interval', intervalMs: 60_000 },
      template: scheduledTemplate('chat-a', 'workspace-a', 'target workflow prompt'),
      missedRunPolicy: 'skip',
      concurrencyPolicy: 'skip',
      limits: {}
    })
    const prepared = AppStore.prepareHistoryDeletion({ kind: 'truncate', rootChatId: 'chat-a' })

    expect(AppStore.getScheduledTasks().map((task) => task.id)).toContain(targetTask.id)
    expect(AppStore.getDispatchableScheduledTasks().map((task) => task.id)).not.toContain(
      targetTask.id
    )
    expect(
      getNextScheduledTaskRunAtMs({
        tasks: AppStore.getDispatchableScheduledTasks(),
        nextWorkflowRunAtMs: null,
        nextIntrospectionRunAtMs: null,
        nowMs: Date.now()
      })
    ).toBeNull()
    expect(AppStore.getDueScheduledTasks(Date.now()).map((task) => task.id)).not.toContain(
      targetTask.id
    )
    expect(() => AppStore.claimDueScheduledTaskForRun(targetTask.id, { runId: 'late-run' })).toThrow(
      HistoryDeletionMutationBlockedError
    )
    expect(() => AppStore.materializeWorkflowNow(targetWorkflow.id)).toThrow(
      HistoryDeletionMutationBlockedError
    )
    expect(() =>
      AppStore.saveScheduledTask({
        ...scheduledTemplate('chat-a', 'workspace-a', 'late scheduled prompt'),
        runAt: '2026-07-20T00:00:00.000Z',
        timezone: 'UTC'
      })
    ).toThrow(HistoryDeletionMutationBlockedError)

    AppStore.commitPreparedHistoryDeletion(prepared.operationId)
  })

  it('recovers the frozen descendant cascade after a crash removed only one child', () => {
    saveChat('parent-a', 'workspace-a', [makeRun('run-parent')])
    saveChat('child-a', 'workspace-a', [makeRun('run-child')], {
      parentChatId: 'parent-a',
      parentChatRelation: 'subThread'
    })
    const prepared = AppStore.prepareHistoryDeletion({ kind: 'chat', rootChatId: 'parent-a' })
    expect(prepared.chatIds).toEqual(expect.arrayContaining(['parent-a', 'child-a']))

    fs.rmSync(chatPath('child-a'))
    AppStore.resetTransientDeletionGuardsForTests()
    expect(AppStore.getPendingHistoryDeletion()?.chatIds).toEqual(
      expect.arrayContaining(['parent-a', 'child-a'])
    )

    AppStore.recoverPendingHistoryDeletion()
    expect(fs.existsSync(chatPath('parent-a'))).toBe(false)
    expect(fs.existsSync(chatPath('child-a'))).toBe(false)
    expect(AppStore.getPendingHistoryDeletion()).toBeNull()
  })

  it('aggregates store failures, does not report success, and finishes after restart', () => {
    saveChat('chat-a', 'workspace-a', [makeRun('run-a')])
    fs.mkdirSync(runEventsDir, { recursive: true })
    fs.writeFileSync(join(runEventsDir, 'run-a.jsonl'), '{"runId":"run-a"}\n', 'utf8')
    fs.mkdirSync(join(runArtifactsDir, 'run-a'), { recursive: true })
    fs.writeFileSync(join(runArtifactsDir, 'run-a', 'stdout.log'), 'secret', 'utf8')
    writeJson(approvalLedgerPath, [{ chatId: 'chat-a', runId: 'run-a', preview: 'secret' }])
    fs.writeFileSync(settingsPath, '{"preserved":true}', 'utf8')

    AppStore.setHistoryDeletionFailureInjectionForTests(['run-events', 'approval-ledger'])

    let thrown: unknown
    try {
      AppStore.clearChats()
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(HistoryDeletionIncompleteError)
    expect((thrown as HistoryDeletionIncompleteError).failures.map((failure) => failure.step)).toEqual(
      expect.arrayContaining(['run-events', 'approval-ledger'])
    )
    // Other stores were still attempted, but the operation remains visibly incomplete.
    expect(fs.existsSync(chatsDir)).toBe(false)
    expect(fs.existsSync(runArtifactsDir)).toBe(false)
    expect(fs.existsSync(runEventsDir)).toBe(true)
    expect(fs.existsSync(approvalLedgerPath)).toBe(true)
    expect(fs.existsSync(historyIntentPath)).toBe(true)
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{"preserved":true}')

    AppStore.setHistoryDeletionFailureInjectionForTests([])
    AppStore.resetTransientDeletionGuardsForTests()
    AppStore.recoverPendingHistoryDeletion()

    expect(fs.existsSync(runEventsDir)).toBe(false)
    expect(fs.existsSync(approvalLedgerPath)).toBe(false)
    expect(fs.existsSync(historyIntentPath)).toBe(false)
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{"preserved":true}')
  })

  it('removes scoped queue and recovery rows for every cascade chat without touching siblings', () => {
    saveChat('parent-a', 'workspace-a', [makeRun('run-parent')])
    saveChat('child-a', 'workspace-a', [makeRun('run-child')], {
      parentChatId: 'parent-a',
      parentChatRelation: 'subThread'
    })
    saveChat('chat-b', 'workspace-b', [makeRun('run-b')])
    writeJson(runQueuePath, [
      { id: 'queue-parent', chatId: 'parent-a', workspaceId: 'workspace-a', runId: 'run-parent' },
      { id: 'queue-child', chatId: 'child-a', workspaceId: 'workspace-a', runId: 'run-child' },
      { id: 'queue-b', chatId: 'chat-b', workspaceId: 'workspace-b', runId: 'run-b' }
    ])
    writeJson(runRecoveryPath, [
      { id: 'recovery-parent', chatId: 'parent-a', workspaceId: 'workspace-a', runId: 'run-parent' },
      { id: 'recovery-child', chatId: 'child-a', workspaceId: 'workspace-a', runId: 'run-child' },
      { id: 'recovery-b', chatId: 'chat-b', workspaceId: 'workspace-b', runId: 'run-b' }
    ])

    AppStore.clearChats('workspace-a')

    expect(readArray(runQueuePath).map((row) => row.id)).toEqual(['queue-b'])
    expect(readArray(runRecoveryPath).map((row) => row.id)).toEqual(['recovery-b'])
    expect(fs.existsSync(chatPath('parent-a'))).toBe(false)
    expect(fs.existsSync(chatPath('child-a'))).toBe(false)
    expect(fs.existsSync(chatPath('chat-b'))).toBe(true)
  })

  it('previews the exact disk-backed cascade, including descendants hidden as orphan candidates', () => {
    saveChat('missing-parent', 'workspace-a')
    saveChat('orphan-child', 'workspace-a', [makeRun('run-child')], {
      parentChatId: 'missing-parent',
      parentChatRelation: 'subThread'
    })
    saveChat('orphan-grandchild', 'workspace-a', [makeRun('run-grandchild')], {
      parentChatId: 'orphan-child',
      parentChatRelation: 'subThread'
    })
    fs.rmSync(chatPath('missing-parent'))
    AppStore.resetTransientDeletionGuardsForTests()

    expect(AppStore.getChats().map((item) => item.appChatId)).not.toContain('orphan-child')
    const preview = AppStore.previewHistoryDeletionScope({
      kind: 'chat',
      rootChatId: 'orphan-child'
    })

    expect(preview.chatIds).toEqual(['orphan-child', 'orphan-grandchild'])
    expect(preview.runIds).toEqual(['run-child', 'run-grandchild'])
    expect(AppStore.getPendingHistoryDeletion()).toBeNull()
  })

  it('removes ordinary queued work for a deleted chat cascade but preserves same-workspace siblings', () => {
    saveChat('parent-a', 'workspace-a', [makeRun('run-parent')])
    saveChat('child-a', 'workspace-a', [makeRun('run-child')], {
      parentChatId: 'parent-a',
      parentChatRelation: 'sideChat'
    })
    saveChat('sibling-a', 'workspace-a', [makeRun('run-sibling')])
    writeJson(runQueuePath, [
      { id: 'queue-parent', chatId: 'parent-a', workspaceId: 'workspace-a', runId: 'run-parent' },
      { id: 'queue-child', chatId: 'child-a', workspaceId: 'workspace-a', runId: 'run-child' },
      { id: 'queue-sibling', chatId: 'sibling-a', workspaceId: 'workspace-a', runId: 'run-sibling' }
    ])
    writeJson(runRecoveryPath, [
      { id: 'recovery-child', chatId: 'child-a', workspaceId: 'workspace-a', runId: 'run-child' },
      { id: 'recovery-sibling', chatId: 'sibling-a', workspaceId: 'workspace-a', runId: 'run-sibling' }
    ])

    AppStore.deleteChat('parent-a')

    expect(readArray(runQueuePath).map((row) => row.id)).toEqual(['queue-sibling'])
    expect(readArray(runRecoveryPath).map((row) => row.id)).toEqual(['recovery-sibling'])
    expect(fs.existsSync(chatPath('parent-a'))).toBe(false)
    expect(fs.existsSync(chatPath('child-a'))).toBe(false)
    expect(fs.existsSync(chatPath('sibling-a'))).toBe(true)
  })

  it('truncates only after durable orchestration and mailbox resurrection sources are gone', () => {
    saveChat('chat-a', 'workspace-a', [makeRun('run-a')], {
      chatKind: 'ensemble',
      linkedProviderSessionId: 'provider-session-a',
      linkedGeminiSessionId: 'gemini-session-a',
      activeGoal: { id: 'goal-a', text: 'continue later', status: 'active' } as any,
      soloWakeups: {
        'solo-wakeup': {
          wakeupId: 'solo-wakeup',
          chatId: 'chat-a',
          provider: 'codex',
          runId: 'run-a',
          scheduledAt: '2026-07-19T00:00:00.000Z',
          wakeAt: '2026-07-19T01:00:00.000Z',
          status: 'pending'
        }
      },
      messages: [
        {
          id: 'message-a',
          role: 'user',
          content: 'private prompt',
          timestamp: '2026-07-19T00:00:00.000Z'
        }
      ],
      ensemble: {
        enabled: true,
        maxParticipants: 1,
        participants: [
          {
            id: 'worker',
            provider: 'codex',
            enabled: true,
            role: 'Worker',
            instructions: '',
            order: 1,
            linkedProviderSessionId: 'participant-session'
          }
        ],
        activeRound: {
          roundId: 'round-a',
          status: 'running',
          prompt: 'queued private prompt',
          startedAt: '2026-07-19T00:00:00.000Z',
          queuedPrompt: 'legacy queued prompt',
          queuedPrompts: ['queued prompt'],
          queuedPromptEntries: [],
          participants: [
            {
              participantId: 'worker',
              provider: 'codex',
              role: 'Worker',
              order: 1,
              status: 'running',
              runId: 'run-a'
            }
          ]
        },
        wakeups: {
          'ensemble-wakeup': {
            wakeupId: 'ensemble-wakeup',
            chatId: 'chat-a',
            roundId: 'round-a',
            participantId: 'worker',
            provider: 'codex',
            role: 'Worker',
            runId: 'run-a',
            scheduledAt: '2026-07-19T00:00:00.000Z',
            wakeAt: '2026-07-19T01:00:00.000Z',
            status: 'pending'
          }
        }
      } as any,
      delegationContext: {
        createdAt: 1,
        parentProvider: 'codex',
        delegationPrompt: 'private delegation',
        returnResultToParent: true,
        workerControl: {
          schemaVersion: 1,
          attachedAt: '2026-07-19T00:00:00.000Z',
          events: [
            {
              schemaVersion: 1,
              id: 'event-a',
              sourceToolCallId: 'tool-a',
              parentChatId: 'parent-a',
              subThreadId: 'chat-a',
              targetProvider: 'codex',
              parentProvider: 'codex',
              prompt: 'private worker prompt',
              returnResultToParent: true,
              priority: 'normal',
              status: 'pending',
              enqueuedAt: '2026-07-19T00:00:00.000Z',
              plannedRunId: 'run-worker',
              approvalMode: 'default',
              attempts: 0
            }
          ]
        }
      }
    })
    saveChat('chat-b', 'workspace-b', [])
    writeJson(runQueuePath, [
      { id: 'queue-a', chatId: 'chat-a', runId: 'run-a' },
      { id: 'queue-worker', chatId: 'chat-a', runId: 'run-worker' },
      { id: 'queue-b', chatId: 'chat-b', runId: 'run-b' }
    ])
    writeJson(runRecoveryPath, [
      { id: 'recovery-a', chatId: 'chat-a', runId: 'run-a' },
      { id: 'recovery-b', chatId: 'chat-b', runId: 'run-b' }
    ])
    writeJson(mailboxPath, {
      schemaVersion: 1,
      mailboxes: {
        'chat-a': {
          schemaVersion: 1,
          parentChatId: 'chat-a',
          nextSequence: 1,
          events: []
        }
      }
    })
    const seatPath = kimiAcpSeatStatePath(userDataPath, 'chat-a', 'worker')
    fs.mkdirSync(seatPath, { recursive: true })
    fs.writeFileSync(join(seatPath, 'checkpoint.json'), 'secret', 'utf8')

    const truncated = AppStore.truncateChatHistory('chat-a')

    expect(truncated).not.toBeNull()
    expect(truncated?.messages).toEqual([])
    expect(truncated?.runs).toEqual([])
    expect(truncated?.linkedProviderSessionId).toBeUndefined()
    expect(truncated?.linkedGeminiSessionId).toBeUndefined()
    expect(truncated?.activeGoal).toBeUndefined()
    expect(truncated?.soloWakeups).toBeUndefined()
    expect(truncated?.ensemble?.activeRound).toBeUndefined()
    expect(truncated?.ensemble?.wakeups).toBeUndefined()
    expect(truncated?.ensemble?.participants[0].linkedProviderSessionId).toBeNull()
    expect(truncated?.delegationContext?.workerControl).toBeUndefined()
    expect(readArray(runQueuePath).map((row) => row.id)).toEqual(['queue-b'])
    expect(readArray(runRecoveryPath).map((row) => row.id)).toEqual(['recovery-b'])
    expect(fs.existsSync(mailboxPath)).toBe(false)
    expect(fs.existsSync(seatPath)).toBe(false)
    expect(fs.existsSync(chatPath('chat-a'))).toBe(true)
    expect(fs.existsSync(chatPath('chat-b'))).toBe(true)
  })
})
