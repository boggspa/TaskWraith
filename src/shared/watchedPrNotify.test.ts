import { describe, it, expect } from 'vitest';

import {
  decideWatchNotify,
  watchNotifySignature,
  WatchNotifyLedger,
  type PolledPrCiState,
  type WatchHeadSnapshot,
  type WatchedPrDescriptor,
} from './watchedPrNotify';

const stored: WatchedPrDescriptor = {
  chatId: 'chat-1',
  workspacePath: '/repo',
  owner: 'acme',
  repo: 'widgets',
  prNumber: 42,
};

function polled(overrides: Partial<PolledPrCiState> = {}): PolledPrCiState {
  return { prNumber: 42, headSha: 'abc123', conclusion: 'failure', notifyWorthy: true, ...overrides };
}

/** Current authoritative head that MATCHES the default polled state (fresh). */
const freshHead: WatchHeadSnapshot = { prNumber: 42, headSha: 'abc123' };

describe('decideWatchNotify', () => {
  it('notifies a fresh notify-worthy terminal state for the watched PR', () => {
    expect(decideWatchNotify(stored, polled(), freshHead, undefined)).toEqual({
      shouldNotify: true,
      reason: 'notify',
      signature: '42@abc123:failure',
    });
  });

  it('skips when the polled PR# != the opted-in descriptor PR# (rotated PR)', () => {
    const d = decideWatchNotify(stored, polled({ prNumber: 43 }), { prNumber: 43, headSha: 'abc123' }, undefined);
    expect(d).toEqual({ shouldNotify: false, reason: 'skip-pr-changed', signature: null });
  });

  it('skips a STALE head: same PR#, but the polled head != the current authoritative head', () => {
    // Poll resolved head abc123; the PR head has since moved to def456.
    const d = decideWatchNotify(stored, polled({ headSha: 'abc123' }), { prNumber: 42, headSha: 'def456' }, undefined);
    expect(d).toEqual({ shouldNotify: false, reason: 'skip-stale-head', signature: null });
  });

  it('does not notify a non-notify-worthy state', () => {
    const d = decideWatchNotify(stored, polled({ notifyWorthy: false }), freshHead, undefined);
    expect(d).toEqual({ shouldNotify: false, reason: 'skip-not-worthy', signature: null });
  });

  it('dedupes an identical signature already notified', () => {
    const sig = watchNotifySignature(polled());
    const d = decideWatchNotify(stored, polled(), freshHead, sig);
    expect(d).toEqual({ shouldNotify: false, reason: 'skip-duplicate', signature: null });
  });

  it('re-notifies a new head (fresh) with a new signature', () => {
    const first = watchNotifySignature(polled());
    const head: WatchHeadSnapshot = { prNumber: 42, headSha: 'def456' };
    const d = decideWatchNotify(stored, polled({ headSha: 'def456' }), head, first);
    expect(d.shouldNotify).toBe(true);
    expect(d.signature).toBe('42@def456:failure');
  });
});

describe('WatchNotifyLedger (non-mutating decide + explicit record)', () => {
  it('decide() does NOT advance the cursor; record() does', () => {
    const ledger = new WatchNotifyLedger();

    const first = ledger.decide(stored, polled(), freshHead);
    expect(first.shouldNotify).toBe(true);
    expect(ledger.lastSignatureFor('chat-1')).toBeUndefined(); // decide alone left the cursor untouched
    expect(ledger.decide(stored, polled(), freshHead).shouldNotify).toBe(true); // still would notify — nothing recorded

    ledger.record('chat-1', first.signature ?? '');
    expect(ledger.lastSignatureFor('chat-1')).toBe('42@abc123:failure');
    expect(ledger.decide(stored, polled(), freshHead).reason).toBe('skip-duplicate');
  });

  it('a delivered signature stays deduped even when a later different event is never recorded', () => {
    const ledger = new WatchNotifyLedger();
    ledger.record('chat-1', watchNotifySignature(polled())); // old delivered

    // A new head decides notify, but if the caller never record()s it (notify failed),
    // the OLD signature must remain — old stays duplicate, new keeps deciding notify.
    const newHead: WatchHeadSnapshot = { prNumber: 42, headSha: 'def456' };
    expect(ledger.decide(stored, polled({ headSha: 'def456' }), newHead).shouldNotify).toBe(true);
    // old, re-polled while still current, remains deduped:
    expect(ledger.decide(stored, polled(), freshHead).reason).toBe('skip-duplicate');
  });

  it('forget() clears a chat cursor when the watch toggle is turned off', () => {
    const ledger = new WatchNotifyLedger();
    ledger.record('chat-1', watchNotifySignature(polled()));
    ledger.forget('chat-1');
    expect(ledger.lastSignatureFor('chat-1')).toBeUndefined();
    expect(ledger.decide(stored, polled(), freshHead).shouldNotify).toBe(true);
  });

  it('tracks distinct chats independently', () => {
    const ledger = new WatchNotifyLedger();
    ledger.record('chat-1', '42@abc123:failure');
    expect(ledger.lastSignatureFor('chat-1')).toBe('42@abc123:failure');
    expect(ledger.lastSignatureFor('chat-2')).toBeUndefined();
  });
});
