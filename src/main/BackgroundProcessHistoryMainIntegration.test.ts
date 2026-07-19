import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const indexSource = readFileSync(join(__dirname, 'index.ts'), 'utf8')

function between(start: string, end: string): string {
  const from = indexSource.indexOf(start)
  const to = indexSource.indexOf(end, from)
  expect(from).toBeGreaterThanOrEqual(0)
  expect(to).toBeGreaterThan(from)
  return indexSource.slice(from, to)
}

describe('agent-started background-process destructive-history main integration', () => {
  it('binds each process to its authoritative chat workspace', () => {
    const tools = between(
      'const workspaceToolExecutors = createWorkspaceToolExecutors({',
      'const workspaceBoardToolExecutors = createWorkspaceBoardToolExecutors({'
    )
    const owner = tools.indexOf('AppStore.getChat(options.appChatId)?.workspaceId')
    const start = tools.indexOf('backgroundProcessRegistry.start(command, cwd, {')
    const forwarded = tools.indexOf('...(workspaceId ? { workspaceId } : {})')

    expect(owner).toBeGreaterThanOrEqual(0)
    expect(start).toBeGreaterThan(owner)
    expect(forwarded).toBeGreaterThan(start)
  })

  it('workspace/global deletion retains its process-close hold through durable commit', () => {
    const broad = between('type BroadHistoryDeletionHolds = {', 'const clearBroadChatHistory = ')
    const genericFence = broad.indexOf('historyGateHeld = true')
    const processFence = broad.indexOf(
      'backgroundProcessRegistry.beginHistoryDeletion(',
      genericFence
    )
    const processJoin = broad.indexOf('await holds.backgroundProcessHold.completion', processFence)
    const commit = broad.indexOf(
      'commit: (operationId) => AppStore.commitPreparedHistoryDeletion(operationId)',
      processJoin
    )
    const release = broad.indexOf(
      'backgroundProcessRegistry.endHistoryDeletion(holds.backgroundProcessHold)',
      commit
    )

    expect(broad).toContain('backgroundProcessHold: BackgroundProcessHistoryHold')
    expect(processFence).toBeGreaterThan(genericFence)
    expect(processJoin).toBeGreaterThan(processFence)
    expect(commit).toBeGreaterThan(processJoin)
    expect(release).toBeGreaterThan(commit)
  })

  it('scoped delete/truncate installs the exact frozen-chat hold through the coordinator', () => {
    const scoped = between(
      'const scopedHistoryDeletionCoordinator = new ScopedHistoryDeletionCoordinator({',
      'const deleteChatWithLifecycle = async'
    )
    const begin = scoped.indexOf('beginBackgroundProcessDeletion: (kind, chatIds) =>')
    const exactScope = scoped.indexOf(
      'backgroundProcessRegistry.beginHistoryDeletion({ kind, chatIds })',
      begin
    )
    const release = scoped.indexOf('endBackgroundProcessDeletion: (hold) =>', exactScope)
    const exactRelease = scoped.indexOf(
      'backgroundProcessRegistry.endHistoryDeletion(hold as BackgroundProcessHistoryHold)',
      release
    )

    expect(begin).toBeGreaterThanOrEqual(0)
    expect(exactScope).toBeGreaterThan(begin)
    expect(release).toBeGreaterThan(exactScope)
    expect(exactRelease).toBeGreaterThan(release)
  })

  it('recovers a pending durable deletion before run-queue startup can spawn tools', () => {
    const recovery = indexSource.indexOf('await recoverPendingHistoryDeletionBeforeRunQueue()')
    const queueRecovery = indexSource.indexOf('AppStore.recoverRunQueueAfterStartup()', recovery)

    expect(recovery).toBeGreaterThanOrEqual(0)
    expect(queueRecovery).toBeGreaterThan(recovery)
  })
})
