import type { ChatRecord } from '../../../main/store/types'
import type { SeatChangeLink } from '../../../shared/seatChange'
import { collectCloseoutCommits, type CloseoutCommit } from './taskWraithCloseoutMessage'

export interface TaskWraithCommitAttribution {
  hash: string
  seatLink: SeatChangeLink
  participantId?: string
}

function normalizedCommitHash(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const hash = value.trim().toLowerCase()
  return /^[0-9a-f]{7,40}$/.test(hash) ? hash : null
}

function addAttributedCommit(
  target: Map<string, TaskWraithCommitAttribution>,
  commit: Pick<CloseoutCommit, 'hash' | 'seatLink' | 'participantId'>
): void {
  const hash = normalizedCommitHash(commit.hash)
  if (!hash || !commit.seatLink) return
  target.set(hash, {
    hash,
    seatLink: commit.seatLink,
    ...(commit.participantId ? { participantId: commit.participantId } : {})
  })
}

/**
 * Build the TaskWraith-owned side of the Inspector's attribution column from
 * durable close-out tombstones plus still-live tool receipts. Git's author is
 * deliberately resolved elsewhere and remains the fallback for every commit
 * without TaskWraith evidence.
 */
export function collectTaskWraithCommitAttributions(
  chats: readonly ChatRecord[]
): Map<string, TaskWraithCommitAttribution> {
  const attributions = new Map<string, TaskWraithCommitAttribution>()
  for (const chat of chats) {
    for (const message of chat.messages || []) {
      for (const commit of message.metadata?.closeoutCommits || []) {
        addAttributedCommit(attributions, commit)
      }
    }
    for (const commit of collectCloseoutCommits(chat.messages || [], () => true, { chat })) {
      addAttributedCommit(attributions, commit)
    }
  }
  return attributions
}

/** Match full Git hashes with the abbreviated receipts emitted by Git tools. */
export function resolveTaskWraithCommitAttribution(
  attributions: ReadonlyMap<string, TaskWraithCommitAttribution>,
  commitHash: string
): TaskWraithCommitAttribution | null {
  const hash = normalizedCommitHash(commitHash)
  if (!hash) return null
  const exact = attributions.get(hash)
  if (exact) return exact

  let best: TaskWraithCommitAttribution | null = null
  for (const [candidateHash, attribution] of attributions) {
    if (!hash.startsWith(candidateHash) && !candidateHash.startsWith(hash)) continue
    if (!best || candidateHash.length > best.hash.length) best = attribution
  }
  return best
}
