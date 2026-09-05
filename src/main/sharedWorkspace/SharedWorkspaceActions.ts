import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import type {
  WorkspaceLockRuntime,
  WorkspaceMutationCommitFenceAcquisition
} from '../WorkspaceLockRuntime'
import type { WorkspaceLockOwner } from '../workLocks/WorkspaceLockTypes'
import {
  executeGitCommit,
  type WorkspaceToolExecutorDependencies
} from '../mcp/WorkspaceToolExecutors'
import {
  confirmRecoveredContribution,
  previewSharedWorkspaceContribution,
  settleSharedWorkspaceContribution,
  suspendSharedWorkspaceIntent
} from './SharedWorkspaceContributions'

export interface SharedWorkspaceActionDependencies {
  getRuntime: () => WorkspaceLockRuntime | null
  host: WorkspaceToolExecutorDependencies['host']
}

export interface SharedWorkspaceActionInput {
  root: string
  chatId: string
  id: string
  generation: string
  action: 'commit' | 'undo' | 'recover'
  message?: string
}

/** Desktop-user actions only. The IPC caller must first validate sender and workspace write scope. */
export async function applySharedWorkspaceAction(
  deps: SharedWorkspaceActionDependencies,
  input: SharedWorkspaceActionInput
): Promise<{ ok: boolean; error?: string; commit?: string; warning?: string }> {
  if (!['commit', 'undo', 'recover'].includes(input.action))
    return { ok: false, error: 'Unknown contribution action.' }
  if (input.action === 'commit' && (!input.message?.trim() || input.message.length > 10000))
    return { ok: false, error: 'Enter a commit message of at most 10,000 characters.' }
  const runtime = deps.getRuntime()
  if (!runtime) return { ok: false, error: 'Workspace mutation authority is unavailable.' }
  const acquired: Array<{ owner: WorkspaceLockOwner; transitionId: string }> = []
  const fences: WorkspaceMutationCommitFenceAcquisition[] = []
  let restoreIntent: (() => Promise<void>) | undefined
  let completed = false
  const owner = {
    lockOwnerId: randomUUID(),
    runId: `user-contribution-${randomUUID()}`,
    chatId: input.chatId,
    displayName: 'You'
  }
  const deadline = Date.now() + 15_000
  const stillWanted = () => Date.now() < deadline && deps.getRuntime() === runtime
  let result: { ok: boolean; error?: string; commit?: string; warning?: string }
  try {
    const preview = await previewSharedWorkspaceContribution(input.root, input.id)
    if (preview.generation !== input.generation)
      throw new Error('The contribution changed after the preview. Review the updated patch.')
    if (
      preview.state === 'changed' ||
      (preview.state === 'interrupted' && input.action !== 'recover')
    )
      throw new Error(preview.reason || 'Review this contribution before changing it.')
    const patch = input.action === 'undo' ? preview.reversePatch : preview.patch
    if (!patch) throw new Error('There is no unambiguous patch for this contribution.')

    // Always include Git metadata: undo can remove only our own staged patch.
    // Failed second acquisition releases the first; it never waits holding a partial set.
    for (const mutation of [
      {
        source: 'taskwraith-catalog' as const,
        workspacePath: input.root,
        action: 'git_commit',
        args: {
          mode: 'private_index',
          message: input.message || input.action,
          paths: preview.paths,
          patch
        }
      },
      {
        source: 'taskwraith-catalog' as const,
        workspacePath: input.root,
        action: 'apply_patch',
        args: { patch }
      }
    ]) {
      const lease = await runtime.acquire({ owner, mutation })
      if (!lease.ok) throw new Error(lease.message)
      acquired.push({ owner: lease.owner, transitionId: lease.authority.transitionId })
      fences.push(
        await runtime.acquireMutationFence(
          lease.owner,
          lease.authority.leases.map((l) => l.claim),
          stillWanted
        )
      )
    }
    const verify = async () => {
      if (deps.getRuntime() !== runtime) throw new Error('Workspace mutation authority changed.')
      for (const lease of acquired) {
        const verification = await runtime.verifyAcquisitionForMutation(
          lease.owner,
          lease.transitionId
        )
        if (!verification.ok) throw new Error(verification.message)
      }
    }
    await verify()
    const current = await previewSharedWorkspaceContribution(input.root, input.id)
    if (current.generation !== input.generation)
      throw new Error(
        'Files changed while waiting for their edit scopes. Review the updated patch.'
      )
    restoreIntent = await suspendSharedWorkspaceIntent(input.root, input.id)

    if (input.action === 'commit') {
      const commit = await executeGitCommit(
        {
          host: deps.host,
          store: {} as WorkspaceToolExecutorDependencies['store'],
          runs: {} as WorkspaceToolExecutorDependencies['runs']
        },
        {
          mode: 'private_index',
          paths: preview.paths,
          patch,
          message: input.message
        },
        input.root,
        {
          scope: 'workspace',
          cwd: input.root,
          workspacePath: input.root,
          appChatId: input.chatId,
          workspaceLockOwnerId: owner.lockOwnerId,
          assertMutationAuthorized: verify
        }
      )
      const committed = commit as {
        ok?: boolean
        committed?: boolean
        commit?: string
        error?: string
      }
      if (!committed.ok && !committed.committed)
        throw new Error(committed.error || 'Contribution commit failed.')
      completed = true
      await settleSharedWorkspaceContribution(input.root, preview, 'committed')
      result = {
        ok: true,
        ...(committed.commit ? { commit: committed.commit } : {}),
        ...(!committed.ok
          ? {
              warning: 'The commit landed, but shared staging needs review. Do not commit it again.'
            }
          : {})
      }
    } else {
      const directory = await fs.mkdtemp(
        join(deps.host.getTempDir(), 'taskwraith-contribution-action-')
      )
      try {
        const patchPath = join(directory, 'change.patch')
        await fs.writeFile(patchPath, patch, { mode: 0o600 })
        const run = (args: string[]) =>
          deps.host.runHostCommand(['git', ...args], input.root, 30_000)
        const check = await run(['apply', '--check', '--binary', '--', patchPath])
        const alreadyApplied =
          check.exitCode !== 0 && input.action === 'recover'
            ? await run(['apply', '--reverse', '--check', '--binary', '--', patchPath])
            : null
        if (check.exitCode !== 0 && alreadyApplied?.exitCode !== 0)
          throw new Error(check.stderr || 'The recovery patch no longer applies.')
        await verify()
        if (check.exitCode === 0) {
          const applied = await run(['apply', '--binary', '--', patchPath])
          if (applied.exitCode !== 0)
            throw new Error(
              applied.stderr || 'Patch application failed; recovery snapshots were retained.'
            )
        }
        completed = true
        let warning: string | undefined
        if (input.action === 'undo') {
          const staged = await run(['apply', '--cached', '--check', '--binary', '--', patchPath])
          if (staged.exitCode === 0) {
            const unstaged = await run(['apply', '--cached', '--binary', '--', patchPath])
            if (unstaged.exitCode !== 0)
              warning = 'Working files were restored; staged changes need review.'
          }
          await settleSharedWorkspaceContribution(input.root, preview, 'undone')
        } else {
          await confirmRecoveredContribution(input.root, preview)
        }
        result = { ok: true, ...(warning ? { warning } : {}) }
      } finally {
        await fs.rm(directory, { recursive: true, force: true })
      }
    }
  } catch (error) {
    result = completed
      ? {
          ok: true,
          warning:
            'The change completed, but its receipt could not be saved. Refresh and inspect the files before retrying.'
        }
      : { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (!completed) await restoreIntent?.()
    let cleanupError: unknown
    for (const fence of fences.reverse()) {
      try {
        runtime.releaseMutationFence(fence)
      } catch (error) {
        cleanupError = error
      }
    }
    if (!cleanupError) {
      for (const lease of acquired.reverse()) {
        try {
          const released = await runtime.releaseAcquisition(lease.owner.runId, lease.transitionId)
          if (!released.ok) cleanupError = new Error(released.message)
        } catch (error) {
          cleanupError = error
        }
      }
    }
    if (cleanupError)
      result = {
        ok: completed,
        ...(completed
          ? { warning: 'The change completed, but edit ownership needs recovery.' }
          : { error: 'Edit ownership needs recovery before retrying.' })
      }
  }
  return result!
}
