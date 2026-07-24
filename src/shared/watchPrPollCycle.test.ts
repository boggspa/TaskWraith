import { describe, it, expect, vi } from 'vitest';

import {
  isWatchPollFailure,
  runWatchPrPollCycle,
  type WatchPollDeps,
  type WatchPollFailure,
} from './watchPrPollCycle';
import {
  WatchNotifyLedger,
  type PolledPrCiState,
  type WatchHeadSnapshot,
  type WatchedPrDescriptor,
} from './watchedPrNotify';

const descriptor: WatchedPrDescriptor = {
  chatId: 'chat-1',
  workspacePath: '/repo',
  owner: 'acme',
  repo: 'widgets',
  prNumber: 42,
};

function polled(overrides: Partial<PolledPrCiState> = {}): PolledPrCiState {
  return { prNumber: 42, headSha: 'abc123', conclusion: 'failure', notifyWorthy: true, ...overrides };
}

const freshHead: WatchHeadSnapshot = { prNumber: 42, headSha: 'abc123' };

function deps(overrides: Partial<WatchPollDeps> = {}): WatchPollDeps {
  return {
    fetchPrCiState: async () => polled(),
    fetchCurrentHead: async () => freshHead,
    ledger: new WatchNotifyLedger(),
    notify: async () => {},
    ...overrides,
  };
}

describe('runWatchPrPollCycle', () => {
  it('notifies on a fresh event and records the signature only after notify succeeds', async () => {
    const ledger = new WatchNotifyLedger();
    const notify = vi.fn(async () => {});
    const p = await runWatchPrPollCycle(descriptor, deps({ ledger, notify }));
    expect(p.phase).toBe('notified');
    expect(notify).toHaveBeenCalledWith(descriptor, expect.objectContaining({ prNumber: 42 }), '42@abc123:failure');
    expect(ledger.lastSignatureFor('chat-1')).toBe('42@abc123:failure'); // recorded AFTER success
  });

  it('dedupes a repeat (no second notify)', async () => {
    const notify = vi.fn(async () => {});
    const shared = deps({ ledger: new WatchNotifyLedger(), notify });
    await runWatchPrPollCycle(descriptor, shared);
    const second = await runWatchPrPollCycle(descriptor, shared);
    expect(second.phase).toBe('skipped');
    expect(second.decision?.reason).toBe('skip-duplicate');
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('skips a non-notify-worthy state without notifying', async () => {
    const notify = vi.fn(async () => {});
    const p = await runWatchPrPollCycle(
      descriptor,
      deps({ fetchPrCiState: async () => polled({ notifyWorthy: false }), notify }),
    );
    expect(p.phase).toBe('skipped');
    expect(p.decision?.reason).toBe('skip-not-worthy');
    expect(notify).not.toHaveBeenCalled();
  });

  it('skips a rotated PR (opted-in PR# mismatch) without notifying', async () => {
    const notify = vi.fn(async () => {});
    const p = await runWatchPrPollCycle(
      descriptor,
      deps({
        fetchPrCiState: async () => polled({ prNumber: 999 }),
        fetchCurrentHead: async () => ({ prNumber: 999, headSha: 'abc123' }),
        notify,
      }),
    );
    expect(p.phase).toBe('skipped');
    expect(p.decision?.reason).toBe('skip-pr-changed');
    expect(notify).not.toHaveBeenCalled();
  });

  it('skips a STALE head (poll head != current head re-validation) without notifying', async () => {
    const notify = vi.fn(async () => {});
    const p = await runWatchPrPollCycle(
      descriptor,
      deps({
        fetchPrCiState: async () => polled({ headSha: 'abc123' }),
        fetchCurrentHead: async () => ({ prNumber: 42, headSha: 'def456' }), // head moved since the poll
        notify,
      }),
    );
    expect(p.phase).toBe('skipped');
    expect(p.decision?.reason).toBe('skip-stale-head');
    expect(notify).not.toHaveBeenCalled();
  });

  it('surfaces a SPECIFIC failure (never silent) when fetch throws a WatchPollFailure', async () => {
    const failure: WatchPollFailure = {
      kind: 'gh-unauthenticated',
      message: 'GitHub CLI is not authenticated — run `gh auth login` to watch this PR.',
    };
    const notify = vi.fn(async () => {});
    const p = await runWatchPrPollCycle(
      descriptor,
      deps({ fetchPrCiState: async () => { throw failure; }, notify }),
    );
    expect(p.phase).toBe('unavailable');
    expect(p.failure).toEqual(failure);
    expect(notify).not.toHaveBeenCalled();
  });

  it('wraps an unexpected fetch error into a specific fetch-error surface', async () => {
    const p = await runWatchPrPollCycle(
      descriptor,
      deps({ fetchPrCiState: async () => { throw new Error('ETIMEDOUT'); } }),
    );
    expect(p.phase).toBe('unavailable');
    expect(p.failure?.kind).toBe('fetch-error');
    expect(p.failure?.message).toContain('ETIMEDOUT');
  });

  it('does NOT roll back a previously delivered signature when a later notify fails (P1 regression)', async () => {
    const ledger = new WatchNotifyLedger();

    // 1) old head delivered successfully → recorded.
    await runWatchPrPollCycle(descriptor, deps({ ledger }));
    expect(ledger.lastSignatureFor('chat-1')).toBe('42@abc123:failure');

    // 2) new head: notify FAILS → the old signature must be PRESERVED (not erased/rolled back).
    const newPolled = polled({ headSha: 'def456' });
    const newHead: WatchHeadSnapshot = { prNumber: 42, headSha: 'def456' };
    const failCycle = await runWatchPrPollCycle(
      descriptor,
      deps({
        ledger,
        fetchPrCiState: async () => newPolled,
        fetchCurrentHead: async () => newHead,
        notify: async () => { throw new Error('post failed'); },
      }),
    );
    expect(failCycle.phase).toBe('unavailable');
    expect(failCycle.failure?.kind).toBe('notify-error');
    expect(ledger.lastSignatureFor('chat-1')).toBe('42@abc123:failure'); // OLD preserved — NOT undefined

    // 3) new head retries with a working notify → advances only after success.
    const retry = await runWatchPrPollCycle(
      descriptor,
      deps({ ledger, fetchPrCiState: async () => newPolled, fetchCurrentHead: async () => newHead }),
    );
    expect(retry.phase).toBe('notified');
    expect(ledger.lastSignatureFor('chat-1')).toBe('42@def456:failure');
  });

  it('never throws even if the onProgress sink throws', async () => {
    const p = await runWatchPrPollCycle(descriptor, deps({ onProgress: () => { throw new Error('sink boom'); } }));
    expect(p.phase).toBe('notified'); // cycle completed despite a throwing observer
  });

  it('emits visible progress: polling first, terminal last', async () => {
    const phases: string[] = [];
    await runWatchPrPollCycle(descriptor, deps({ onProgress: (pr) => phases.push(pr.phase) }));
    expect(phases[0]).toBe('polling');
    expect(phases.at(-1)).toBe('notified');
  });
});

describe('isWatchPollFailure (strict guard)', () => {
  it('accepts only the five declared kinds with a non-empty message', () => {
    expect(isWatchPollFailure({ kind: 'offline', message: 'x' })).toBe(true);
    expect(isWatchPollFailure({ kind: 'notify-error', message: 'y' })).toBe(true);
    expect(isWatchPollFailure({ kind: 'totally-made-up', message: 'x' })).toBe(false); // unknown kind
    expect(isWatchPollFailure({ kind: 'offline', message: '' })).toBe(false); // empty message
    expect(isWatchPollFailure(new Error('nope'))).toBe(false);
    expect(isWatchPollFailure(null)).toBe(false);
  });
});
