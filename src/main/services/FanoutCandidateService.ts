import { createHash } from 'node:crypto'

import {
  FanoutWorktreeAllocator,
  type FanoutWorktreeAllocation
} from '../run/FanoutWorktreeAllocation'
import type {
  GitApplyPatchInput,
  GitCaptureWorktreePatchInput,
  GitCreateWorktreeInput,
  GitDeleteBranchInput,
  GitNumstatEntry,
  GitPatchApplicationInspection,
  GitRemoveWorktreeInput,
  GitRepositorySnapshot,
  GitResult,
  GitWorktreeList,
  GitWorktreePatchCapture
} from './GitService'
import type { FanoutWorktreeCandidate, ProviderId } from '../store/types'
import type { FanoutCandidatePromotionLock } from './FanoutCandidatePromotionLock'

/**
 * Candidate lifecycle for worktree-isolated fan-out lanes: allocate a
 * per-lane worktree at dispatch, settle it when the lane's run ends, and let
 * the user (or a Boss surface later) promote ONE candidate's changes onto the
 * base workspace's working tree — uncommitted, exactly like a serial agent
 * run — or discard it. Composes the hardened GitService and the main-owned
 * candidate persistence; owns no git or fs logic of its own.
 *
 * Promotion is patch application, deliberately NOT `git merge`: parallel
 * lanes never commit (the orchestrator blocks git_stage/commit/push in
 * lanes), so the candidate's value is its working-tree state, and landing it
 * as uncommitted changes keeps the user's history untouched and the publish
 * step in their hands.
 */

export interface FanoutCandidateGit {
  listWorktrees(inputPath: string): Promise<GitResult<GitWorktreeList>>
  createWorktree(input: GitCreateWorktreeInput): Promise<GitResult<GitRepositorySnapshot>>
  removeWorktree(input: GitRemoveWorktreeInput): Promise<GitResult<GitRepositorySnapshot>>
  captureWorktreePatch(
    input: GitCaptureWorktreePatchInput
  ): Promise<GitResult<GitWorktreePatchCapture>>
  inspectPatchApplication(
    input: Pick<GitApplyPatchInput, 'repoPath' | 'patch' | 'verifiedTargetPaths'>
  ): Promise<GitResult<GitPatchApplicationInspection>>
  applyPatchToRepository(input: GitApplyPatchInput): Promise<GitResult<GitRepositorySnapshot>>
  deleteBranch(input: GitDeleteBranchInput): Promise<GitResult<{ branch: string }>>
}

export interface FanoutCandidateStore {
  getCandidates(chatId: string): Promise<FanoutWorktreeCandidate[]>
  upsertCandidate(chatId: string, candidate: FanoutWorktreeCandidate): Promise<unknown>
  patchCandidate(
    chatId: string,
    candidateId: string,
    patch: Partial<Omit<FanoutWorktreeCandidate, 'schemaVersion' | 'candidateId'>>
  ): Promise<unknown | null>
}

export interface FanoutCandidateServiceOptions {
  git: FanoutCandidateGit
  store: FanoutCandidateStore
  /** Required: promotion must never fall back to an unlocked base-tree write. */
  promotionLock: FanoutCandidatePromotionLock
  nowIso?: () => string
}

export interface AllocateFanoutLaneInput {
  chatId: string
  roundId: string
  laneId: string
  runId: string
  participantId: string
  participantLabel?: string
  provider: ProviderId
  model?: string
  baseWorkspacePath: string
}

export interface SettleFanoutLaneInput {
  chatId: string
  laneId: string
  runStatus: 'completed' | 'failed' | 'cancelled'
}

export interface CandidatePatchPreview {
  candidateId: string
  patch: string
  truncated: boolean
  numstat: GitNumstatEntry[]
  totals: { files: number; insertions: number; deletions: number }
  clean: boolean
}

export interface CandidateResolution {
  ok: boolean
  error?: string
  /** promote only: false when the candidate had no changes to apply. */
  applied?: boolean
}

type LockedCandidatePromotion =
  | { ok: false; error: string }
  | { ok: true; cleanupError: string | null }

/** Preview payloads stay renderer-friendly; promote re-captures internally. */
const PATCH_PREVIEW_CHAR_LIMIT = 2_000_000

export class FanoutCandidateService {
  private git: FanoutCandidateGit
  private store: FanoutCandidateStore
  private promotionLock: FanoutCandidatePromotionLock
  private nowIso: () => string
  private allocator = new FanoutWorktreeAllocator()
  private resolutionTails = new Map<string, Promise<unknown>>()

  constructor(options: FanoutCandidateServiceOptions) {
    this.git = options.git
    this.store = options.store
    this.promotionLock = options.promotionLock
    this.nowIso = options.nowIso || (() => new Date().toISOString())
  }

  /**
   * Allocate (or re-adopt) this lane's isolated worktree and record the
   * candidate as `active`. The worktree forks from the workspace's last
   * commit (HEAD) — uncommitted changes in the base tree are deliberately
   * not carried into candidates.
   */
  async allocateForLane(input: AllocateFanoutLaneInput): Promise<FanoutWorktreeAllocation> {
    const allocation = await this.allocator.ensure({
      chatId: input.chatId,
      laneId: input.laneId,
      participantHint: input.participantLabel || input.participantId,
      baseWorkspacePath: input.baseWorkspacePath,
      git: this.git
    })
    await this.store.upsertCandidate(input.chatId, {
      schemaVersion: 1,
      candidateId: input.laneId,
      roundId: input.roundId,
      laneId: input.laneId,
      runId: input.runId,
      participantId: input.participantId,
      ...(input.participantLabel ? { participantLabel: input.participantLabel } : {}),
      provider: input.provider,
      ...(input.model ? { model: input.model } : {}),
      baseWorkspacePath: allocation.baseWorkspacePath,
      worktreePath: allocation.effectiveWorkspacePath,
      branch: allocation.branch,
      createdAt: this.nowIso(),
      status: 'active'
    })
    return allocation
  }

  /**
   * Mark the lane's candidate settled once its run reaches a terminal state,
   * capturing a best-effort change summary. Missing candidates are a normal
   * no-op — most lanes never ran isolated.
   */
  async settleLane(input: SettleFanoutLaneInput): Promise<void> {
    const candidates = await this.store.getCandidates(input.chatId)
    const candidate = candidates.find((entry) => entry.laneId === input.laneId)
    if (!candidate || candidate.status !== 'active') return

    let diffStat: FanoutWorktreeCandidate['diffStat']
    const capture = await this.git.captureWorktreePatch({ worktreePath: candidate.worktreePath })
    if (capture.ok) {
      diffStat = capture.data.totals
    }
    await this.store.patchCandidate(input.chatId, candidate.candidateId, {
      status: 'settled',
      runStatus: input.runStatus,
      settledAt: this.nowIso(),
      ...(diffStat ? { diffStat } : {}),
      ...(capture.ok
        ? {}
        : { reason: `Change summary unavailable: ${capture.error || 'git capture failed'}` })
    })
  }

  async list(chatId: string): Promise<FanoutWorktreeCandidate[]> {
    return this.store.getCandidates(chatId)
  }

  /** Full patch preview for the adjudication surface (read-only intent). */
  async candidatePatch(chatId: string, candidateId: string): Promise<CandidatePatchPreview> {
    const candidate = await this.requireCandidate(chatId, candidateId)
    if (candidate.status === 'promoted' || candidate.status === 'discarded') {
      throw new Error('This candidate was already resolved; its worktree is gone.')
    }
    const capture = await this.git.captureWorktreePatch({ worktreePath: candidate.worktreePath })
    if (!capture.ok) {
      throw new Error(capture.error || 'Could not capture the candidate diff.')
    }
    const truncated = capture.data.patch.length > PATCH_PREVIEW_CHAR_LIMIT
    return {
      candidateId,
      patch: truncated ? capture.data.patch.slice(0, PATCH_PREVIEW_CHAR_LIMIT) : capture.data.patch,
      truncated,
      numstat: capture.data.numstat,
      totals: capture.data.totals,
      clean: capture.data.clean
    }
  }

  /**
   * Apply the winning candidate's changes onto the base workspace working
   * tree, then clean up its worktree and branch. Serialized per candidate so
   * a double-click cannot promote twice.
   */
  promote(chatId: string, candidateId: string): Promise<CandidateResolution> {
    return this.enqueueResolution(chatId, candidateId, () =>
      this.promoteUnshared(chatId, candidateId)
    )
  }

  /** Drop a candidate: remove its worktree and branch, keep the record. */
  discard(chatId: string, candidateId: string): Promise<CandidateResolution> {
    return this.enqueueResolution(chatId, candidateId, () =>
      this.discardUnshared(chatId, candidateId)
    )
  }

  private async promoteUnshared(chatId: string, candidateId: string): Promise<CandidateResolution> {
    const candidate = await this.requireCandidate(chatId, candidateId)
    if (candidate.status === 'active') {
      return {
        ok: false,
        error: 'This lane is still running. Stop or wait for it before promoting.'
      }
    }
    if (candidate.status !== 'settled') {
      return { ok: false, error: 'This candidate was already resolved.' }
    }
    const linked = await this.assertWorktreeLinked(candidate)
    if (linked) return linked

    const capture = await this.git.captureWorktreePatch({ worktreePath: candidate.worktreePath })
    if (!capture.ok) {
      await this.recordReason(
        chatId,
        candidateId,
        capture.error || 'Could not capture the candidate patch.'
      )
      return { ok: false, error: capture.error || 'Could not capture the candidate patch.' }
    }

    const patchSha256 = sha256Text(capture.data.patch)
    if (!capture.data.clean) {
      if (
        candidate.promotionIntent &&
        candidate.promotionIntent.patchSha256.toLowerCase() !== patchSha256
      ) {
        const error =
          'Candidate promotion recovery stopped because the candidate patch changed after its durable intent was saved.'
        await this.recordReason(chatId, candidateId, error)
        return { ok: false, error }
      }
    }

    try {
      const locked = await this.promotionLock.withPromotionLock(
        {
          chatId,
          candidateId,
          baseWorkspacePath: candidate.baseWorkspacePath,
          patch: capture.data.patch
        },
        async (verified): Promise<LockedCandidatePromotion> => {
          const relinked = await this.assertWorktreeLinked(candidate)
          if (relinked) {
            return { ok: false, error: relinked.error || 'Candidate worktree is no longer linked.' }
          }
          if (!capture.data.clean) {
            let intentPreparedHere = false
            if (!candidate.promotionIntent) {
              const prepared = await this.store.patchCandidate(chatId, candidateId, {
                promotionIntent: {
                  patchSha256,
                  startedAt: this.nowIso()
                }
              })
              if (!prepared) {
                return {
                  ok: false,
                  error: 'Candidate promotion could not save its durable write-ahead intent.'
                }
              }
              intentPreparedHere = true
            }
            const applyInput = {
              repoPath: verified.baseWorkspacePath,
              patch: capture.data.patch,
              verifiedTargetPaths: verified.targetPaths
            }
            const inspection = await this.git.inspectPatchApplication(applyInput)
            if (!inspection.ok) {
              if (intentPreparedHere) {
                await this.store.patchCandidate(chatId, candidateId, {
                  promotionIntent: undefined
                })
              }
              return {
                ok: false,
                error: inspection.error || 'Candidate patch state could not be inspected.'
              }
            }
            if (inspection.data.state === 'applicable') {
              const applied = await this.git.applyPatchToRepository(applyInput)
              if (!applied.ok) {
                return { ok: false, error: applied.error || 'git apply failed.' }
              }
            } else if (inspection.data.state !== 'already-applied') {
              if (intentPreparedHere) {
                await this.store.patchCandidate(chatId, candidateId, {
                  promotionIntent: undefined
                })
              }
              return {
                ok: false,
                error:
                  inspection.data.state === 'ambiguous'
                    ? 'Candidate promotion recovery is ambiguous because the patch applies both forward and in reverse.'
                    : 'The candidate patch neither applies cleanly nor matches an already-applied promotion.'
              }
            }
          }

          // This is the semantic commit point. Persist it before fallible
          // worktree/branch and authority cleanup so a retry can never apply
          // the same patch twice after the base tree already changed.
          const committed = await this.store.patchCandidate(chatId, candidateId, {
            status: 'promoted',
            promotionIntent: undefined,
            resolvedAt: this.nowIso(),
            diffStat: capture.data.totals
          })
          if (!committed) {
            throw new Error(
              'Candidate promotion applied, but its durable status could not be saved.'
            )
          }
          const cleanupError = await this.cleanupWorktree(candidate)
          if (cleanupError) await this.recordReason(chatId, candidateId, cleanupError)
          return { ok: true, cleanupError }
        }
      )
      const promotion = locked.value
      if (!promotion.ok) {
        const error = [promotion.error || 'git apply failed.', locked.cleanupError]
          .filter((reason): reason is string => !!reason)
          .join(' ')
        await this.recordReason(chatId, candidateId, error)
        return { ok: false, error }
      }
      const cleanupError = [promotion.cleanupError, locked.cleanupError]
        .filter((reason): reason is string => !!reason)
        .join(' ')
      if (cleanupError) await this.recordReason(chatId, candidateId, cleanupError)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.recordReason(chatId, candidateId, message)
      const latest = await this.requireCandidate(chatId, candidateId).catch(() => null)
      if (latest?.status === 'promoted') {
        return { ok: true, applied: !capture.data.clean }
      }
      return { ok: false, error: message }
    }

    return { ok: true, applied: !capture.data.clean }
  }

  private async discardUnshared(chatId: string, candidateId: string): Promise<CandidateResolution> {
    const candidate = await this.requireCandidate(chatId, candidateId)
    if (candidate.status === 'active') {
      return {
        ok: false,
        error: 'This lane is still running. Stop or wait for it before discarding.'
      }
    }
    if (candidate.status !== 'settled') {
      return { ok: false, error: 'This candidate was already resolved.' }
    }
    if (candidate.promotionIntent) {
      return {
        ok: false,
        error:
          'This candidate has an unfinished promotion intent. Retry promotion to recover it before discarding.'
      }
    }
    const linked = await this.assertWorktreeLinked(candidate)
    if (linked) return linked

    const cleanupError = await this.cleanupWorktree(candidate)
    if (cleanupError) {
      await this.recordReason(chatId, candidateId, cleanupError)
      return { ok: false, error: cleanupError }
    }
    await this.store.patchCandidate(chatId, candidateId, {
      status: 'discarded',
      resolvedAt: this.nowIso()
    })
    return { ok: true }
  }

  /**
   * Defense-in-depth before destructive git operations: the recorded
   * worktree must still be linked to the recorded base repository. Returns a
   * resolution error when it is not, null when safe to proceed.
   */
  private async assertWorktreeLinked(
    candidate: FanoutWorktreeCandidate
  ): Promise<CandidateResolution | null> {
    const listed = await this.git.listWorktrees(candidate.baseWorkspacePath)
    if (!listed.ok) {
      return { ok: false, error: listed.error || 'Could not list linked worktrees.' }
    }
    const linked = listed.data.worktrees.some(
      (worktree) => normalizePath(worktree.path) === normalizePath(candidate.worktreePath)
    )
    if (!linked) {
      return {
        ok: false,
        error: 'The candidate worktree is no longer linked to the workspace repository.'
      }
    }
    return null
  }

  private async cleanupWorktree(candidate: FanoutWorktreeCandidate): Promise<string | null> {
    const removed = await this.git.removeWorktree({
      repoPath: candidate.baseWorkspacePath,
      path: candidate.worktreePath,
      force: true
    })
    if (!removed.ok) {
      return `Worktree cleanup failed: ${removed.error || 'git worktree remove failed'}`
    }
    const deleted = await this.git.deleteBranch({
      repoPath: candidate.baseWorkspacePath,
      branch: candidate.branch,
      force: true
    })
    if (!deleted.ok) {
      return `Branch cleanup failed: ${deleted.error || 'git branch -D failed'}`
    }
    return null
  }

  private async requireCandidate(
    chatId: string,
    candidateId: string
  ): Promise<FanoutWorktreeCandidate> {
    const candidates = await this.store.getCandidates(chatId)
    const candidate = candidates.find((entry) => entry.candidateId === candidateId)
    if (!candidate) {
      throw new Error('Unknown fan-out candidate for this chat.')
    }
    return candidate
  }

  private async recordReason(chatId: string, candidateId: string, reason: string): Promise<void> {
    await this.store.patchCandidate(chatId, candidateId, { reason }).catch(() => null)
  }

  private enqueueResolution(
    chatId: string,
    candidateId: string,
    operation: () => Promise<CandidateResolution>
  ): Promise<CandidateResolution> {
    const key = JSON.stringify([chatId, candidateId])
    const previous = this.resolutionTails.get(key) || Promise.resolve()
    const next = previous.catch(() => undefined).then(operation)
    this.resolutionTails.set(key, next)
    void next.finally(() => {
      if (this.resolutionTails.get(key) === next) this.resolutionTails.delete(key)
    })
    return next
  }
}

function normalizePath(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
