import { chatPathForId, isSafeChatId } from '../ChatPath'
import { readStoredChat, writeJsonAtomically } from './ThreadWorktreeBindingPersistence'
import type { ChatRecord, FanoutWorktreeCandidate } from './types'

/**
 * Async atomic patchers for the chat's main-owned fan-out worktree candidate
 * list. Mirrors ThreadWorktreeBindingPersistence: small read-modify-write
 * patches, never saveChat's synchronous whole-record writer; the caller (the
 * AppStore statics) owns per-chat serialization and cache invalidation.
 * saveChat strips this field from renderer records and re-merges the persisted
 * value, so these patchers are the ONLY writers.
 */

export interface UpsertFanoutCandidatePatchInput {
  chatsDir: string
  chatId: string
  candidate: FanoutWorktreeCandidate
  admitMutation?: (chat: ChatRecord) => Promise<void>
}

export interface PatchFanoutCandidateInput {
  chatsDir: string
  chatId: string
  candidateId: string
  patch: Partial<Omit<FanoutWorktreeCandidate, 'schemaVersion' | 'candidateId'>>
  admitMutation?: (chat: ChatRecord) => Promise<void>
}

export interface ReadFanoutCandidatesInput {
  chatsDir: string
  chatId: string
}

export async function upsertFanoutWorktreeCandidatePatch(
  input: UpsertFanoutCandidatePatchInput
): Promise<ChatRecord> {
  if (!isSafeChatId(input.chatId)) {
    throw new Error('A fan-out candidate can only be recorded on a saved chat.')
  }
  const candidate = normalizeCandidate(input.candidate)
  const chatPath = chatPathForId(input.chatsDir, input.chatId)
  const stored = await readStoredChat(chatPath, input.chatId)
  await input.admitMutation?.(stored)

  const existing = candidateList(stored)
  const nextList = existing.some((entry) => entry.candidateId === candidate.candidateId)
    ? existing.map((entry) => (entry.candidateId === candidate.candidateId ? candidate : entry))
    : [...existing, candidate]

  const next: ChatRecord = {
    ...stored,
    fanoutWorktreeCandidates: nextList,
    updatedAt: Date.now(),
    persistenceRevision: persistenceRevision(stored) + 1
  }
  await writeJsonAtomically(chatPath, next)
  return next
}

/**
 * Merge a partial update into one candidate. Returns the updated chat, or
 * null when the candidate does not exist — settle callbacks fire for every
 * lane run and most lanes never had a worktree, so absence is a normal no-op,
 * not an error.
 */
export async function patchFanoutWorktreeCandidate(
  input: PatchFanoutCandidateInput
): Promise<ChatRecord | null> {
  if (!isSafeChatId(input.chatId)) {
    throw new Error('A fan-out candidate can only be updated on a saved chat.')
  }
  const chatPath = chatPathForId(input.chatsDir, input.chatId)
  const stored = await readStoredChat(chatPath, input.chatId)
  const existing = candidateList(stored)
  const target = existing.find((entry) => entry.candidateId === input.candidateId)
  if (!target) return null
  await input.admitMutation?.(stored)

  const merged = normalizeCandidate({ ...target, ...input.patch })
  const next: ChatRecord = {
    ...stored,
    fanoutWorktreeCandidates: existing.map((entry) =>
      entry.candidateId === input.candidateId ? merged : entry
    ),
    updatedAt: Date.now(),
    persistenceRevision: persistenceRevision(stored) + 1
  }
  await writeJsonAtomically(chatPath, next)
  return next
}

/** Valid candidates only; malformed legacy entries are dropped, not fatal. */
export async function readFanoutWorktreeCandidates(
  input: ReadFanoutCandidatesInput
): Promise<FanoutWorktreeCandidate[]> {
  if (!isSafeChatId(input.chatId)) return []
  let stored: ChatRecord
  try {
    stored = await readStoredChat(chatPathForId(input.chatsDir, input.chatId), input.chatId)
  } catch {
    return []
  }
  return candidateList(stored)
}

function candidateList(chat: ChatRecord): FanoutWorktreeCandidate[] {
  const raw = chat.fanoutWorktreeCandidates
  if (!Array.isArray(raw)) return []
  const out: FanoutWorktreeCandidate[] = []
  for (const entry of raw) {
    try {
      out.push(normalizeCandidate(entry as FanoutWorktreeCandidate))
    } catch {
      // Malformed legacy entry — skip rather than poison the whole list.
    }
  }
  return out
}

const CANDIDATE_STATUSES = new Set(['active', 'settled', 'promoted', 'discarded'])
const RUN_STATUSES = new Set(['completed', 'failed', 'cancelled'])

export function normalizeCandidate(candidate: FanoutWorktreeCandidate): FanoutWorktreeCandidate {
  const requiredStrings = {
    candidateId: candidate.candidateId,
    roundId: candidate.roundId,
    laneId: candidate.laneId,
    runId: candidate.runId,
    participantId: candidate.participantId,
    baseWorkspacePath: candidate.baseWorkspacePath,
    worktreePath: candidate.worktreePath,
    branch: candidate.branch,
    createdAt: candidate.createdAt
  }
  for (const [key, value] of Object.entries(requiredStrings)) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`Fan-out candidate is missing ${key}.`)
    }
  }
  if (candidate.schemaVersion !== 1 || !CANDIDATE_STATUSES.has(candidate.status)) {
    throw new Error('Fan-out candidate has an unrecognized schema or status.')
  }
  if (candidate.runStatus !== undefined && !RUN_STATUSES.has(candidate.runStatus)) {
    throw new Error('Fan-out candidate has an unrecognized run status.')
  }
  if (
    candidate.promotionIntent !== undefined &&
    (!candidate.promotionIntent ||
      typeof candidate.promotionIntent !== 'object' ||
      !/^[0-9a-f]{64}$/i.test(candidate.promotionIntent.patchSha256) ||
      typeof candidate.promotionIntent.startedAt !== 'string' ||
      !candidate.promotionIntent.startedAt.trim())
  ) {
    throw new Error('Fan-out candidate has a malformed promotion intent.')
  }
  const diffStat = candidate.diffStat
  return {
    schemaVersion: 1,
    candidateId: candidate.candidateId.trim(),
    roundId: candidate.roundId.trim(),
    laneId: candidate.laneId.trim(),
    runId: candidate.runId.trim(),
    participantId: candidate.participantId.trim(),
    ...(typeof candidate.participantLabel === 'string' && candidate.participantLabel.trim()
      ? { participantLabel: candidate.participantLabel.trim() }
      : {}),
    provider: candidate.provider,
    ...(typeof candidate.model === 'string' && candidate.model.trim()
      ? { model: candidate.model.trim() }
      : {}),
    baseWorkspacePath: candidate.baseWorkspacePath.trim().replace(/\/+$/, ''),
    worktreePath: candidate.worktreePath.trim().replace(/\/+$/, ''),
    branch: candidate.branch.trim(),
    createdAt: candidate.createdAt,
    status: candidate.status,
    ...(candidate.promotionIntent
      ? {
          promotionIntent: {
            patchSha256: candidate.promotionIntent.patchSha256.toLowerCase(),
            startedAt: candidate.promotionIntent.startedAt
          }
        }
      : {}),
    ...(candidate.runStatus ? { runStatus: candidate.runStatus } : {}),
    ...(typeof candidate.settledAt === 'string' ? { settledAt: candidate.settledAt } : {}),
    ...(typeof candidate.resolvedAt === 'string' ? { resolvedAt: candidate.resolvedAt } : {}),
    ...(diffStat &&
    Number.isFinite(diffStat.files) &&
    Number.isFinite(diffStat.insertions) &&
    Number.isFinite(diffStat.deletions)
      ? {
          diffStat: {
            files: diffStat.files,
            insertions: diffStat.insertions,
            deletions: diffStat.deletions
          }
        }
      : {}),
    ...(typeof candidate.reason === 'string' && candidate.reason.trim()
      ? { reason: candidate.reason.trim() }
      : {})
  }
}

function persistenceRevision(chat: Pick<ChatRecord, 'persistenceRevision'>): number {
  const revision = chat.persistenceRevision
  return Number.isSafeInteger(revision) && (revision ?? -1) >= 0 ? (revision as number) : 0
}
