import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { join, resolve } from 'node:path'

import { resolveGitCommonDirectory } from './WorkspaceMarkerGitExclude'

/**
 * Opt-in installer for the concurrent-work pre-commit hook, for repositories
 * that are not this one.
 *
 * WHY THIS EXISTS. TaskWraith already projects work markers into every checkout
 * it leases, but only AGBench has anything that READS them: marker enforcement
 * lives entirely in `.githooks/pre-commit`, and a guest repository's
 * `core.hooksPath` is unset. So in someone else's repo the markers are inert,
 * and an agent working outside TaskWraith — a plain CLI session in the same
 * checkout — is invisible in both directions. This closes that half.
 *
 * WHY NOT `core.hooksPath`. Setting it is the obvious move and the wrong one:
 * it REPLACES the repository's entire hooks directory rather than adding to it,
 * so pointing it at our own directory silently disables husky, lefthook, and
 * every hook the user already relies on. We install a single `pre-commit` file
 * instead, and only where none exists — additive, and reversible by deleting
 * one file. Where `core.hooksPath` is already redirected we refuse outright,
 * because git would never read our hook there anyway.
 *
 * Every install leaves a receipt so the uninstall restores exactly what it
 * changed, mirroring the lease-receipt shape in AntigravityPermissionLease.
 */

/** Marks a hook as ours. Recognition must never depend on the body's content. */
export const TASKWRAITH_HOOK_SIGNATURE =
  '# taskwraith-managed-hook v1 — installed by TaskWraith, safe to delete'

export const TASKWRAITH_HOOK_RECEIPT_FILENAME = 'taskwraith-hook-receipt.json'

export type WorkspaceHookBlockedReason =
  | 'not-a-git-worktree'
  | 'hooks-path-redirected'
  | 'foreign-hook-present'

export type WorkspaceHookPlan =
  | { status: 'installable'; hookPath: string }
  | { status: 'already-installed'; hookPath: string }
  | { status: 'blocked'; reason: WorkspaceHookBlockedReason; detail?: string }

export type WorkspaceHookInstallResult =
  | { status: 'installed'; hookPath: string }
  | { status: 'blocked'; reason: WorkspaceHookBlockedReason; detail?: string }
  | { status: 'write-failed'; detail: string }

export type WorkspaceHookUninstallResult =
  | { status: 'removed' }
  | { status: 'not-installed' }
  | { status: 'modified-since-install'; hookPath: string }

export interface WorkspaceHookReceipt {
  version: 1
  hookPath: string
  /** sha256 of the exact bytes we wrote, so we never delete an edited hook. */
  digest: string
  /** Always false today: we refuse to install over an existing pre-commit. */
  previousExists: boolean
}

export interface WorkspaceHookPlanInput {
  worktreeRoot: string
  /**
   * Resolves `core.hooksPath` as git itself would, including global and system
   * scope. Injectable because a test must not depend on the caller's own config.
   */
  readHooksPath?: (worktreeRoot: string) => string | null
}

export interface WorkspaceHookInstallInput extends WorkspaceHookPlanInput {
  /** The hook body to install. Resolution of its on-disk source is the caller's. */
  hookSource: string
}

function readHooksPathFromGit(worktreeRoot: string): string | null {
  try {
    const value = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
      cwd: worktreeRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    return value.length > 0 ? value : null
  } catch {
    // Exit code 1 simply means unset, which is the common and healthy case.
    return null
  }
}

function readTextOrNull(path: string): string | null {
  try {
    return nodeFs.readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function digestOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** Signature goes below the shebang, which must stay the first line. */
function composeHookBody(hookSource: string): string {
  const newlineIndex = hookSource.indexOf('\n')
  if (!hookSource.startsWith('#!') || newlineIndex === -1) {
    return `${TASKWRAITH_HOOK_SIGNATURE}\n${hookSource}`
  }
  const shebang = hookSource.slice(0, newlineIndex)
  const rest = hookSource.slice(newlineIndex + 1)
  return `${shebang}\n${TASKWRAITH_HOOK_SIGNATURE}\n${rest}`
}

interface ResolvedTarget {
  commonDirectory: string
  hookPath: string
  receiptPath: string
}

function resolveTarget(worktreeRoot: string): ResolvedTarget | null {
  const commonDirectory = resolveGitCommonDirectory(worktreeRoot)
  if (commonDirectory === null) return null
  return {
    commonDirectory,
    hookPath: join(commonDirectory, 'hooks', 'pre-commit'),
    receiptPath: join(commonDirectory, TASKWRAITH_HOOK_RECEIPT_FILENAME)
  }
}

export function planWorkspaceHookInstall(input: WorkspaceHookPlanInput): WorkspaceHookPlan {
  const target = resolveTarget(input.worktreeRoot)
  if (!target) return { status: 'blocked', reason: 'not-a-git-worktree' }

  const readHooksPath = input.readHooksPath || readHooksPathFromGit
  const configured = readHooksPath(input.worktreeRoot)
  if (configured) {
    // A hooksPath aimed at the directory we would write to is not a redirect.
    const configuredAbsolute = resolve(input.worktreeRoot, configured)
    if (configuredAbsolute !== resolve(join(target.commonDirectory, 'hooks'))) {
      return { status: 'blocked', reason: 'hooks-path-redirected', detail: configured }
    }
  }

  const existing = readTextOrNull(target.hookPath)
  if (existing === null) return { status: 'installable', hookPath: target.hookPath }
  if (existing.includes(TASKWRAITH_HOOK_SIGNATURE)) {
    return { status: 'already-installed', hookPath: target.hookPath }
  }
  return { status: 'blocked', reason: 'foreign-hook-present' }
}

export function installWorkspaceHook(
  input: WorkspaceHookInstallInput
): WorkspaceHookInstallResult {
  // Re-planned here rather than trusting a caller's earlier plan: the hook we
  // would overwrite is somebody's commit-time safety net, and the gap between
  // deciding and writing is exactly where it gets created.
  const plan = planWorkspaceHookInstall(input)
  if (plan.status === 'blocked') return plan
  const target = resolveTarget(input.worktreeRoot)
  if (!target) return { status: 'blocked', reason: 'not-a-git-worktree' }

  const body = composeHookBody(input.hookSource)
  const temporaryPath = `${target.hookPath}.taskwraith-${process.pid}.tmp`
  try {
    nodeFs.mkdirSync(join(target.commonDirectory, 'hooks'), { recursive: true })
    nodeFs.writeFileSync(temporaryPath, body, { encoding: 'utf8', mode: 0o755 })
    // writeFileSync honours mode only on create; chmod makes it unconditional.
    nodeFs.chmodSync(temporaryPath, 0o755)
    nodeFs.renameSync(temporaryPath, target.hookPath)

    const receipt: WorkspaceHookReceipt = {
      version: 1,
      hookPath: target.hookPath,
      digest: digestOf(body),
      previousExists: false
    }
    nodeFs.writeFileSync(target.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  } catch (error) {
    try {
      nodeFs.unlinkSync(temporaryPath)
    } catch {
      // Inert leftover; nothing depends on it.
    }
    return { status: 'write-failed', detail: String(error) }
  }

  return { status: 'installed', hookPath: target.hookPath }
}

export function uninstallWorkspaceHook(input: {
  worktreeRoot: string
}): WorkspaceHookUninstallResult {
  const target = resolveTarget(input.worktreeRoot)
  if (!target) return { status: 'not-installed' }

  const receiptRaw = readTextOrNull(target.receiptPath)
  if (receiptRaw === null) return { status: 'not-installed' }

  let receipt: WorkspaceHookReceipt
  try {
    receipt = JSON.parse(receiptRaw) as WorkspaceHookReceipt
  } catch {
    return { status: 'not-installed' }
  }

  const current = readTextOrNull(target.hookPath)
  if (current === null) {
    // Hook already gone; clear the stale receipt so a later install can proceed.
    try {
      nodeFs.unlinkSync(target.receiptPath)
    } catch {
      // Nothing further to do.
    }
    return { status: 'removed' }
  }

  // A changed digest means the user adopted or edited it. Their file now.
  if (digestOf(current) !== receipt.digest) {
    return { status: 'modified-since-install', hookPath: target.hookPath }
  }

  try {
    nodeFs.unlinkSync(target.hookPath)
    nodeFs.unlinkSync(target.receiptPath)
  } catch {
    return { status: 'modified-since-install', hookPath: target.hookPath }
  }
  return { status: 'removed' }
}
