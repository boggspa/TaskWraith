import fs from 'fs'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AppStore } from './store'
import type { ChatRecord } from './store/types'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-tool-detail-store-${process.pid}`)

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  }
}))

function terminalChat(): ChatRecord {
  return {
    appChatId: 'chat-tool-detail',
    scope: 'workspace',
    chatKind: 'single',
    provider: 'codex',
    title: 'Tool detail',
    workspaceId: 'workspace-1',
    workspacePath: '/repo',
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    messages: [
      {
        id: 'message-tool',
        role: 'tool',
        content: '',
        timestamp: '2026-08-16T00:00:01.000Z',
        runId: 'run-tool-detail',
        toolActivities: [
          {
            id: 'tool-call-1',
            toolName: 'run_shell_command',
            displayName: 'Ran command',
            category: 'shell',
            status: 'success',
            parameters: { command: 'printf complete-detail' },
            resultSummary: 'complete-detail',
            rawResultEvent: { output: 'complete-detail' }
          }
        ]
      }
    ],
    runs: [
      {
        runId: 'run-tool-detail',
        provider: 'codex',
        startedAt: '2026-08-16T00:00:00.000Z',
        endedAt: '2026-08-16T00:00:02.000Z',
        status: 'success'
      }
    ]
  }
}

describe('AppStore terminal tool detail externalization', () => {
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(userDataPath, { recursive: true })
    AppStore.resetTransientDeletionGuardsForTests()
  })

  it('checkpoints full detail before persisting a lightweight chat row', async () => {
    const saved = AppStore.saveChat(terminalChat())
    const compact = saved.messages[0].toolActivities![0]
    const detailRef = compact.detailRef!

    expect(compact.parameters).toBeUndefined()
    expect(compact.resultSummary).toBeUndefined()
    expect(detailRef).toMatchObject({
      storage: 'run_event_artifact',
      runId: 'run-tool-detail',
      activityId: 'tool-call-1'
    })
    expect(saved.runs[0].toolDetailExternalizationGeneration).toBe(1)
    expect(
      AppStore.getRunEvents({ runId: 'run-tool-detail', kinds: ['tool'] }).some(
        (event) =>
          (event.payload as { type?: string } | undefined)?.type ===
          'tool_activity_detail_checkpoint'
      )
    ).toBe(true)

    AppStore.resetTransientDeletionGuardsForTests()
    const reloaded = AppStore.getChat('chat-tool-detail')!
    const reloadedRef = reloaded.messages[0].toolActivities![0].detailRef!
    await expect(AppStore.getToolActivityDetails([reloadedRef])).resolves.toEqual([
      {
        ref: reloadedRef,
        activity: expect.objectContaining({
          id: 'tool-call-1',
          parameters: { command: 'printf complete-detail' },
          resultSummary: 'complete-detail',
          rawResultEvent: { output: 'complete-detail' }
        })
      }
    ])
    expect(
      fs.existsSync(
        join(userDataPath, 'run-artifacts', 'run-tool-detail', 'tool-activity-details.jsonl')
      )
    ).toBe(true)
  })
})
