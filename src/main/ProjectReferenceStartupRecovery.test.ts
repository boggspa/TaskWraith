import fs from 'fs'
import path from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { AppStore } from './store'
import type { ChatRecord } from './store/types'
import { ProjectReferenceArtifactStore } from './services/ProjectReferenceArtifactStore'
import { projectReferenceOwnedArtifactRefsFromRunEvents } from './services/ProjectReferenceContextAuditService'

const userDataPath = vi.hoisted(
  () => `/tmp/taskwraith-project-reference-startup-${process.pid}/user-data`
)
const testRoot = path.dirname(userDataPath)

vi.mock('electron', () => ({
  app: { getPath: () => userDataPath }
}))

function chat(appChatId: string, runId: string): ChatRecord {
  return {
    appChatId,
    scope: 'workspace',
    chatKind: 'single',
    provider: 'codex',
    title: appChatId,
    workspaceId: 'workspace-a',
    workspacePath: path.join(testRoot, 'workspace'),
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [{ runId, provider: 'codex', startedAt: '2026-07-19T00:00:00.000Z' }]
  }
}

describe('Project-reference startup recovery', () => {
  beforeEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true })
    fs.mkdirSync(path.join(testRoot, 'workspace'), { recursive: true })
    AppStore.resetTransientDeletionGuardsForTests()
  })

  afterAll(() => {
    fs.rmSync(testRoot, { recursive: true, force: true })
  })

  it('resumes after a purge receipt by excluding stale deleted events and retaining a shared survivor', async () => {
    const deletedChatId = 'deleted-chat'
    const deletedRunId = 'deleted-run'
    const survivorChatId = 'survivor-chat'
    const survivorRunId = 'survivor-run'
    AppStore.saveChat(chat(deletedChatId, deletedRunId))
    AppStore.saveChat(chat(survivorChatId, survivorRunId))

    const source = path.join(testRoot, 'workspace', 'shared.txt')
    fs.writeFileSync(source, 'shared project reference')
    const artifactStore = new ProjectReferenceArtifactStore(
      path.join(userDataPath, 'project-reference-context-artifacts')
    )
    const deleted = artifactStore.snapshotOwnedMany({
      appChatId: deletedChatId,
      runId: deletedRunId,
      files: [{ workspacePath: path.dirname(source), candidatePath: source }]
    })
    const survivor = artifactStore.snapshotOwnedMany({
      appChatId: survivorChatId,
      runId: survivorRunId,
      files: [{ workspacePath: path.dirname(source), candidatePath: source }]
    })
    expect(deleted.ok).toBe(true)
    expect(survivor.ok).toBe(true)
    if (!deleted.ok || !survivor.ok) return
    artifactStore.commitOwnedBatch(deleted.receipt)
    artifactStore.commitOwnedBatch(survivor.receipt)
    for (const [chatId, runId, artifact] of [
      [deletedChatId, deletedRunId, deleted.artifacts[0]],
      [survivorChatId, survivorRunId, survivor.artifacts[0]]
    ] as const) {
      AppStore.appendRunEvent(
        {
          runId,
          chatId,
          kind: 'reference_context',
          phase: 'artifact',
          source: 'main',
          artifacts: [artifact]
        },
        { durability: 'strict' }
      )
    }

    const prepared = AppStore.prepareHistoryDeletion({
      kind: 'chat',
      rootChatId: deletedChatId,
      quiescenceTargets: [
        { id: 'project-reference:chat-run-batch', kind: 'project-reference' }
      ]
    })
    const hold = artifactStore.beginHistoryMutation({
      kind: 'chat',
      appChatIds: prepared.chatIds
    })
    await artifactStore.revokeOwnershipStrict({
      appChatIds: prepared.chatIds,
      runIds: prepared.runIds
    })
    AppStore.recordHistoryDeletionQuiesced(prepared.operationId, [
      'project-reference:chat-run-batch'
    ])
    expect(fs.existsSync(survivor.artifacts[0].path)).toBe(true)

    // Crash before the outer AppStore commit: both stale run-event files and
    // the pending intent survive, while the scoped owner has already gone.
    AppStore.resetTransientDeletionGuardsForTests()
    const pending = AppStore.getPendingHistoryDeletion()
    expect(pending?.operationId).toBe(prepared.operationId)
    const references = projectReferenceOwnedArtifactRefsFromRunEvents(
      await AppStore.getRunEventsAsync({ kinds: ['reference_context'] }),
      pending
    )
    const restarted = new ProjectReferenceArtifactStore(
      path.join(userDataPath, 'project-reference-context-artifacts')
    )
    expect(() => restarted.reconcileLegacyOwnership(references)).not.toThrow()
    expect(restarted.owns(survivor.artifacts[0].sha256, {
      appChatId: survivorChatId,
      runId: survivorRunId
    })).toBe(true)
    expect(restarted.owns(deleted.artifacts[0].sha256, {
      appChatId: deletedChatId,
      runId: deletedRunId
    })).toBe(false)

    AppStore.commitPreparedHistoryDeletion(prepared.operationId)
    expect(AppStore.getChat(deletedChatId)).toBeNull()
    expect(AppStore.getChat(survivorChatId)?.appChatId).toBe(survivorChatId)
    expect(artifactStore.endHistoryMutation(hold)).toBe(true)
  })
})
