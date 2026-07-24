// Watch-PR poll cycle orchestrator — Workstream A / Slice-6 (A1d poller core).
//
// PURE, dependency-injected async orchestrator for ONE poll cycle of ONE watched
// chat: fetch the PR/CI state, re-read the current authoritative head, run the A1a
// non-mutating decision, and on a genuine fresh event fire the injected notify —
// then record the delivered signature ONLY after notify succeeds. No IPC, no
// GitService import, no timers — the host wires those in the A1d INTEGRATION slice
// (ipc/gitHandlers.ts + the App.tsx handleNotifyThreadOfCi auto variant, both
// KimiCapt-custodied). Kept pure so dedupe, freshness, and failure surfaces are
// unit-testable.
//
// Quality bar (parity-four-baseline): zero sync IO (all injected async); every
// cycle emits a visible progress phase; a fetch/notify failure yields a SPECIFIC,
// actionable surface (esp. the gh-auth silent-failure gap flagged in a-recon — a
// broken auth must be reported, never a silent no-op). Never throws: the progress
// sink is best-effort, and a failed notify preserves the previous dedupe cursor
// (retry next cycle) instead of destructively rolling it back.

import type {
  PolledPrCiState,
  WatchNotifyDecision,
  WatchHeadSnapshot,
  WatchedPrDescriptor,
} from './watchedPrNotify';

export type WatchPollPhase = 'polling' | 'notified' | 'skipped' | 'unavailable';

const WATCH_POLL_FAILURE_KINDS = [
  'gh-unauthenticated',
  'gh-not-installed',
  'offline',
  'fetch-error',
  'notify-error',
] as const;

export type WatchPollFailureKind = (typeof WATCH_POLL_FAILURE_KINDS)[number];

/** A specific, actionable reason a poll cycle could not complete. */
export interface WatchPollFailure {
  kind: WatchPollFailureKind;
  /** Calm, specific, actionable one-liner for the UI failure surface. */
  message: string;
}

export interface WatchPollProgress {
  chatId: string;
  phase: WatchPollPhase;
  /** Present on 'skipped'/'notified' — the decision that drove the phase. */
  decision?: WatchNotifyDecision;
  /** Present on 'unavailable' — the specific failure surface. */
  failure?: WatchPollFailure;
}

/** The A1a dedupe-ledger surface this cycle depends on (structural — inject the real one or a fake). */
export interface WatchNotifyLedgerLike {
  decide(stored: WatchedPrDescriptor, polled: PolledPrCiState, currentHead: WatchHeadSnapshot): WatchNotifyDecision;
  record(chatId: string, signature: string): void;
}

export interface WatchPollDeps {
  /**
   * Fetch the current PR/CI state for a watched PR. Injected so the cycle never
   * imports GitService directly. SHOULD reject with a WatchPollFailure (gh
   * unauthenticated / not installed / offline) so the surface stays specific; any
   * other thrown value is wrapped as a 'fetch-error' (still never silent).
   */
  fetchPrCiState(descriptor: WatchedPrDescriptor): Promise<PolledPrCiState>;
  /**
   * Re-read the CURRENT authoritative head immediately before notify, so a poll
   * that raced a force-push / new commit is re-validated (PR# AND headSha) rather
   * than announcing a superseded commit.
   */
  fetchCurrentHead(descriptor: WatchedPrDescriptor): Promise<WatchHeadSnapshot>;
  ledger: WatchNotifyLedgerLike;
  /** Fire the actual thread notification (App.tsx handleNotifyThreadOfCi auto variant). */
  notify(descriptor: WatchedPrDescriptor, polled: PolledPrCiState, signature: string): Promise<void>;
  /** Optional progress sink for the visible progress state. Best-effort — may throw safely. */
  onProgress?(progress: WatchPollProgress): void;
}

/** Strict guard: only the five declared kinds with a non-empty message are a WatchPollFailure. */
export function isWatchPollFailure(value: unknown): value is WatchPollFailure {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<WatchPollFailure>;
  return (
    typeof candidate.kind === 'string' &&
    (WATCH_POLL_FAILURE_KINDS as readonly string[]).includes(candidate.kind) &&
    typeof candidate.message === 'string' &&
    candidate.message.length > 0
  );
}

/**
 * Run ONE poll cycle for ONE watched chat. Never throws — always resolves to a
 * terminal WatchPollProgress (notified / skipped / unavailable). The onProgress
 * sink is best-effort (a throwing observer cannot break the cycle), and the dedupe
 * cursor advances (record) ONLY after a successful notify.
 */
export async function runWatchPrPollCycle(
  descriptor: WatchedPrDescriptor,
  deps: WatchPollDeps,
): Promise<WatchPollProgress> {
  const emit = (progress: WatchPollProgress): WatchPollProgress => {
    try {
      deps.onProgress?.(progress);
    } catch {
      // Progress is a best-effort sink; a throwing observer must not break the cycle.
    }
    return progress;
  };

  emit({ chatId: descriptor.chatId, phase: 'polling' });

  let polled: PolledPrCiState;
  try {
    polled = await deps.fetchPrCiState(descriptor);
  } catch (error) {
    return emit({
      chatId: descriptor.chatId,
      phase: 'unavailable',
      failure: toFailure(error, 'fetch-error', "Couldn't check this PR's status"),
    });
  }

  let currentHead: WatchHeadSnapshot;
  try {
    currentHead = await deps.fetchCurrentHead(descriptor);
  } catch (error) {
    return emit({
      chatId: descriptor.chatId,
      phase: 'unavailable',
      failure: toFailure(error, 'fetch-error', "Couldn't re-validate this PR's current head"),
    });
  }

  const decision = deps.ledger.decide(descriptor, polled, currentHead);
  if (!decision.shouldNotify || decision.signature === null) {
    return emit({ chatId: descriptor.chatId, phase: 'skipped', decision });
  }

  try {
    await deps.notify(descriptor, polled, decision.signature);
  } catch (error) {
    // Do NOT record and do NOT forget: the previous delivered signature is preserved
    // (stays deduped) and THIS event retries next cycle. Never roll the cursor back.
    return emit({
      chatId: descriptor.chatId,
      phase: 'unavailable',
      failure: toFailure(error, 'notify-error', "Couldn't post the CI update to this thread"),
    });
  }

  // Commit the delivered signature ONLY after the notify actually succeeded.
  deps.ledger.record(descriptor.chatId, decision.signature);
  return emit({ chatId: descriptor.chatId, phase: 'notified', decision });
}

function toFailure(error: unknown, fallbackKind: WatchPollFailureKind, prefix: string): WatchPollFailure {
  if (isWatchPollFailure(error)) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return { kind: fallbackKind, message: `${prefix}: ${detail}` };
}
