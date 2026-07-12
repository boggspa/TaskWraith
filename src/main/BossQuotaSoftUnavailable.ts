import type { ChatRecord, ProviderId } from './store/types'
import { classifyProviderQuotaWall } from './ProviderQuotaWallClassifier'

/**
 * C1 — quota-aware Captain failover, shared PURE evaluator.
 *
 * ONE source of truth consumed by BOTH `EnsembleOrchestrator.primaryBossUnavailable`
 * (which serves `resolveBossAuthorityForCaller` + `@`-mention priority routing) and
 * the `index.ts` twin `bossmanAutoApprovalPrimaryState`, so the two authority-
 * resolution paths cannot drift (Design C1 / Captain G1b-v2). No I/O, no stored
 * state — a plain function of (chat messages, roundId, Boss identity).
 *
 * SCOPE is authority-only (Option R): callers apply the signal to authority
 * resolution, Bossman auto-approval, and `@Boss`→Captain priority routing. It must
 * NEVER reach worker roster order (`getOrderedEnsembleParticipants` /
 * `tryAutoContinueRound` do not call these consumers).
 *
 * EVIDENCE: a hard provider quota wall finalizes as an ANSWERED turn whose wall
 * text is the assistant CONTENT — `lastFailureReason`/`status` never carry it
 * (that field is only set by `markParticipantUnreachable`). So we read the Boss's
 * own latest finalized terminal from the transcript and classify it.
 */

/**
 * The Boss's OWN latest finalized assistant terminal content in `roundId`.
 *
 * The `ensembleParticipantId` scoping is load-bearing (Captain G1c): a PEER
 * quoting the wall template must never flip Boss authority — and this very
 * transcript is full of peers quoting "You've hit your limit". Returns undefined
 * when the Boss has produced no finalized terminal in the round yet.
 */
export function bossOwnTerminalContent(
  chat: Pick<ChatRecord, 'messages'>,
  roundId: string,
  bossParticipantId: string
): string | undefined {
  const messages = chat.messages
  if (!Array.isArray(messages)) return undefined
  // Walk from the tail so we read the MOST RECENT Boss terminal — this is what
  // makes the signal non-sticky (A1#5): a later healthy turn overrides an
  // earlier wall with zero extra bookkeeping.
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.role !== 'assistant') continue
    const meta = message.metadata
    if (!meta || meta.kind !== 'ensembleParticipant') continue
    if (meta.ensembleRoundId !== roundId) continue
    if (meta.ensembleParticipantId !== bossParticipantId) continue
    return typeof message.content === 'string' ? message.content : undefined
  }
  return undefined
}

/**
 * True when the Boss is SOFT-unavailable for authority because its own current-
 * round provider terminal hit a hard quota wall.
 *
 * Positive signal is `ProviderQuotaWallClassifier.hit` on the Boss's OWN terminal
 * — the SOLE positive detector (G1: template/envelope match, never a bare
 * "quota"/"resets" substring; G1c: Boss's own terminal only). PURELY DERIVED from
 * the latest terminal, so a subsequent healthy Boss turn (`hit:false`) restores
 * availability automatically — no stored flag, no flapping.
 */
export function evaluateBossQuotaSoftUnavailable(
  chat: Pick<ChatRecord, 'messages'>,
  roundId: string | undefined,
  boss: { id: string; provider: ProviderId } | null | undefined
): boolean {
  if (!roundId || !boss) return false
  const terminal = bossOwnTerminalContent(chat, roundId, boss.id)
  return classifyProviderQuotaWall(boss.provider, terminal).hit
}
