// Watch-PR notify decision core — Workstream A / Slice-6 ("watch PR" auto-toggle).
//
// PURE decision logic for the per-chat "watch PR" auto-toggle: given the chat's
// stored watch descriptor, a freshly-polled PR/CI state, a LIVE current-head
// re-validation snapshot, and the last signature we already notified for that
// chat, decide whether the host poller should fire a NEW thread notification. No
// IPC, no store, no I/O — unit-testable in isolation and reusable from whichever
// layer owns the poller.
//
// Invariants (baseline A1 spec, key parity-four-baseline-2026-07-24):
//  - The visible per-chat toggle is the ENTIRE authorization; a host poller has no
//    permission posture. This module only runs for a chat with an active watch.
//  - Re-validate the polled PR number AND head SHA against the CURRENT authoritative
//    head (an injected live snapshot) before ANY notify — guard against the PR
//    rotating OR the head moving under a stale poll. The persisted descriptor stays
//    the Boss-locked {chatId,workspacePath,owner,repo,prNumber}; the head lives only
//    in the live snapshot, never in the persisted contract.
//  - The decision is NON-MUTATING; the dedupe cursor advances ONLY via record()
//    AFTER a notify succeeds, so a failed notify never loses or repeats an event.

/**
 * The opt-in record persisted on the chat when the user toggles "watch PR" on.
 * Boss-locked contract — do NOT add fields (head SHA lives in WatchHeadSnapshot).
 */
export interface WatchedPrDescriptor {
  chatId: string;
  workspacePath: string;
  owner: string;
  repo: string;
  prNumber: number;
}

/** Minimal PR shape the descriptor needs. Structural, so both the renderer's
 * `GitPrSummary` and the main process's raw status data satisfy it without
 * shared/ taking a dependency on the Electron-side GitService types. */
export interface WatchedPrSource {
  number?: number | string
  url?: string
}

export function watchedPrDescriptorFromGitHubUrl(input: {
  chatId: string
  workspacePath: string
  pr: WatchedPrSource
}): WatchedPrDescriptor | null {
  const chatId = input.chatId.trim()
  const workspacePath = input.workspacePath.trim()
  const prNumber = Number(input.pr.number)
  const rawUrl = input.pr.url?.trim()
  if (!chatId || !workspacePath || !Number.isInteger(prNumber) || prNumber <= 0 || !rawUrl) {
    return null
  }

  try {
    const url = new URL(rawUrl)
    if (!['github.com', 'www.github.com'].includes(url.hostname.toLowerCase())) return null
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length < 4 || parts[2] !== 'pull' || Number(parts[3]) !== prNumber) return null
    const owner = decodeURIComponent(parts[0] || '').trim()
    const repo = decodeURIComponent(parts[1] || '').trim()
    if (!owner || !repo || owner.includes('/') || repo.includes('/')) return null
    return { chatId, workspacePath, owner, repo, prNumber }
  } catch {
    return null
  }
}

/** A single poll result the host poller obtained for a watched chat. */
export interface PolledPrCiState {
  prNumber: number;
  /** Head commit SHA the polled CI conclusion is FOR. */
  headSha: string;
  /** Terminal CI conclusion for that head, e.g. "success" | "failure" | "timed_out". */
  conclusion: string;
  /** notify-worthiness — mirror of ciNotice.buildCiNotice().shouldOffer. */
  notifyWorthy: boolean;
}

/**
 * A LIVE current-authoritative-head snapshot, re-read immediately before notify to
 * re-validate that the polled result still reflects the PR's current head. Kept
 * separate from the persisted WatchedPrDescriptor so the Boss-locked contract is
 * unchanged.
 */
export interface WatchHeadSnapshot {
  prNumber: number;
  headSha: string;
}

export type WatchNotifyReason =
  | 'notify'
  | 'skip-not-worthy' // CI state isn't a notify-worthy terminal state yet
  | 'skip-pr-changed' // polled PR# != the opted-in stored PR#
  | 'skip-stale-head' // polled (PR#, headSha) != the current authoritative head
  | 'skip-duplicate'; // this exact signature was already notified

export interface WatchNotifyDecision {
  shouldNotify: boolean;
  reason: WatchNotifyReason;
  /** The signature to record() after a successful notify. null in every skip case. */
  signature: string | null;
}

/**
 * Stable identity of a notify-worthy CI event for one PR. Includes headSha and
 * conclusion so a new commit OR a changed conclusion yields a NEW signature.
 */
export function watchNotifySignature(
  polled: Pick<PolledPrCiState, 'prNumber' | 'headSha' | 'conclusion'>,
): string {
  return `${polled.prNumber}@${polled.headSha}:${polled.conclusion}`;
}

/**
 * Decide whether to notify. PURE — never mutates. Re-validates the polled result
 * against BOTH the opted-in descriptor (PR#) AND the live current head (PR# +
 * headSha) before allowing a notify.
 */
export function decideWatchNotify(
  stored: WatchedPrDescriptor,
  polled: PolledPrCiState,
  currentHead: WatchHeadSnapshot,
  lastNotifiedSignature: string | undefined,
): WatchNotifyDecision {
  // (1) Opted-in PR: the poll must resolve the PR the user actually toggled on.
  if (polled.prNumber !== stored.prNumber) {
    return { shouldNotify: false, reason: 'skip-pr-changed', signature: null };
  }
  // (2) Freshness: the polled CI result must reflect the CURRENT authoritative head
  //     (PR# AND headSha), re-validated immediately before notify. A moved/rotated
  //     head means this poll is stale; skip rather than announce a superseded commit.
  if (polled.prNumber !== currentHead.prNumber || polled.headSha !== currentHead.headSha) {
    return { shouldNotify: false, reason: 'skip-stale-head', signature: null };
  }
  // (3) Only terminal/actionable CI states are worth a notification.
  if (!polled.notifyWorthy) {
    return { shouldNotify: false, reason: 'skip-not-worthy', signature: null };
  }
  // (4) Dedupe: identical (pr, headSha, conclusion) already announced.
  const signature = watchNotifySignature(polled);
  if (lastNotifiedSignature === signature) {
    return { shouldNotify: false, reason: 'skip-duplicate', signature: null };
  }
  return { shouldNotify: true, reason: 'notify', signature };
}

/**
 * In-memory lastNotifiedSignature dedupe map, keyed by chatId. NON-MUTATING
 * decide() + explicit record() (call ONLY after a notify succeeds) so a failed
 * notify neither loses the previous delivered signature nor repeats it.
 */
export class WatchNotifyLedger {
  private readonly lastNotified = new Map<string, string>();

  /** PURE — returns the decision for the current cursor WITHOUT advancing it. */
  decide(
    stored: WatchedPrDescriptor,
    polled: PolledPrCiState,
    currentHead: WatchHeadSnapshot,
  ): WatchNotifyDecision {
    return decideWatchNotify(stored, polled, currentHead, this.lastNotified.get(stored.chatId));
  }

  /** Commit a delivered signature. Call ONLY after the notify actually succeeds. */
  record(chatId: string, signature: string): void {
    this.lastNotified.set(chatId, signature);
  }

  /** Drop a chat's dedupe cursor when its watch toggle is turned off. */
  forget(chatId: string): void {
    this.lastNotified.delete(chatId);
  }

  /** Introspection / test helper. */
  lastSignatureFor(chatId: string): string | undefined {
    return this.lastNotified.get(chatId);
  }
}
