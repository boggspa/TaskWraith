/**
 * T3a-1 saveCoalescer tests.
 *
 * Coverage targets:
 * - Normal writes are coalesced (same-chat rapid saves → one write)
 * - Different chats are NOT coalesced (independent timers)
 * - Urgent writes bypass the timer (terminal, approval, history-deletion)
 * - Shutdown flushes all pending writes
 * - Zero-delay still allows same-tick coalescing
 * - Disabled (negative delay) passes through immediately
 * - Stats counters are accurate
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSaveCoalescer } from './saveCoalescer';
import type { FlushReason } from './saveCoalescer';

describe('saveCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('normal coalescing', () => {
    it('coalesces rapid same-chat saves into a single write', async () => {
      const writes: string[] = [];
      const c = createSaveCoalescer(100);

      c.schedule('chat-1', () => writes.push('write-1'), 'normal');
      c.schedule('chat-1', () => writes.push('write-2'), 'normal');
      c.schedule('chat-1', () => writes.push('write-3'), 'normal');

      // No writes should have happened yet
      expect(writes).toEqual([]);

      // Advance past the coalesce window
      vi.advanceTimersByTime(150);

      // Only the LAST write should have fired
      expect(writes).toEqual(['write-3']);

      const s = c.stats();
      expect(s.scheduled).toBe(3);
      expect(s.coalesced).toBe(2); // first two were replaced
      expect(s.flushed).toBe(1);
      expect(s.pending).toBe(0);
    });

    it('does NOT coalesce different chats', async () => {
      const writes: string[] = [];
      const c = createSaveCoalescer(100);

      c.schedule('chat-a', () => writes.push('a'), 'normal');
      c.schedule('chat-b', () => writes.push('b'), 'normal');

      vi.advanceTimersByTime(150);

      expect(writes).toHaveLength(2);
      expect(writes).toContain('a');
      expect(writes).toContain('b');
    });

    it('resets the timer on each new save for the same chat', async () => {
      const writes: string[] = [];
      const c = createSaveCoalescer(100);

      c.schedule('chat-1', () => writes.push('first'), 'normal');
      vi.advanceTimersByTime(80); // not yet expired

      c.schedule('chat-1', () => writes.push('second'), 'normal');
      vi.advanceTimersByTime(80); // only 80ms since second, 160ms since first

      // Should not have fired yet (timer reset to 100ms from second schedule)
      expect(writes).toEqual([]);

      vi.advanceTimersByTime(30); // 110ms since second
      expect(writes).toEqual(['second']);
    });
  });

  describe('urgent writes (terminal, approval, history-deletion)', () => {
    const urgentReasons: FlushReason[] = ['terminal', 'approval', 'history-deletion'];

    for (const reason of urgentReasons) {
      it(`flushes ${reason} synchronously, bypassing the timer`, () => {
        const writes: string[] = [];
        const c = createSaveCoalescer(100);

        // Schedule a normal pending write first
        c.schedule('chat-1', () => writes.push('normal'), 'normal');

        // Urgent write should flush immediately
        const result = c.schedule('chat-1', () => writes.push(reason), reason);

        // Result should be -1 (synchronous flush)
        expect(result).toBe(-1);
        // The urgent write fired; the normal one was cancelled
        expect(writes).toEqual([reason]);

        const s = c.stats();
        expect(s.urgentFlushes).toBe(1);
        expect(s.pending).toBe(0);
      });
    }

    it('flushes urgent write even with no pending normal write', () => {
      const writes: string[] = [];
      const c = createSaveCoalescer(100);

      c.schedule('chat-1', () => writes.push('terminal'), 'terminal');

      expect(writes).toEqual(['terminal']);
      expect(c.stats().flushed).toBe(1);
      expect(c.stats().urgentFlushes).toBe(1);
    });

    it('cancels pending normal write when urgent arrives for same chat', () => {
      const writes: string[] = [];
      const c = createSaveCoalescer(100);

      // Normal write scheduled
      c.schedule('chat-1', () => writes.push('normal-1'), 'normal');
      // Urgent write same chat — cancels normal and flushes urgent
      c.schedule('chat-1', () => writes.push('terminal'), 'terminal');

      // Normal write should never fire
      vi.advanceTimersByTime(200);
      expect(writes).toEqual(['terminal']);
    });

    it('shutdown reason flushes all pending synchronously', () => {
      const writes: string[] = [];
      const c = createSaveCoalescer(100);

      c.schedule('chat-a', () => writes.push('a'), 'normal');
      c.schedule('chat-b', () => writes.push('b'), 'normal');
      c.schedule('chat-c', () => writes.push('c'), 'normal');

      // Manual flushAll
      c.flushAll();

      expect(writes).toHaveLength(3);
      expect(writes).toContain('a');
      expect(writes).toContain('b');
      expect(writes).toContain('c');
      expect(c.stats().pending).toBe(0);
    });
  });

  describe('flush by id', () => {
    it('flushes a specific chat and leaves others pending', () => {
      const writes: string[] = [];
      const c = createSaveCoalescer(100);

      c.schedule('chat-a', () => writes.push('a'), 'normal');
      c.schedule('chat-b', () => writes.push('b'), 'normal');

      const flushed = c.flush('chat-a');
      expect(flushed).toBe(true);
      expect(writes).toEqual(['a']);

      // chat-b still pending
      expect(c.stats().pending).toBe(1);

      // Flush non-existent
      expect(c.flush('chat-x')).toBe(false);
    });
  });

  describe('disabled mode (negative delay)', () => {
    it('passes through every write immediately', () => {
      const writes: string[] = [];
      const c = createSaveCoalescer(-1);

      c.schedule('chat-1', () => writes.push('a'), 'normal');
      c.schedule('chat-1', () => writes.push('b'), 'normal');
      c.schedule('chat-1', () => writes.push('c'), 'normal');

      // All writes fired immediately — no coalescing
      expect(writes).toEqual(['a', 'b', 'c']);
      expect(c.stats().scheduled).toBe(0);
      expect(c.stats().coalesced).toBe(0);
      expect(c.stats().flushed).toBe(3);
    });
  });

  describe('zero delay', () => {
    it('still coalesces within the same synchronous batch', () => {
      const writes: string[] = [];
      const c = createSaveCoalescer(0);

      // Same-tick saves
      c.schedule('chat-1', () => writes.push('first'), 'normal');
      c.schedule('chat-1', () => writes.push('second'), 'normal');

      // The zero-delay setImmediate should coalesce to just the second write
      expect(writes).toEqual([]); // not flushed yet

      vi.runAllTimers();

      expect(writes).toEqual(['second']);
    });
  });

  describe('error handling', () => {
    it('does not throw when a write function throws', () => {
      const c = createSaveCoalescer(100);

      c.schedule('chat-1', () => {
        throw new Error('disk full');
      }, 'normal');

      // Should not throw during timer execution
      expect(() => vi.advanceTimersByTime(150)).not.toThrow();
      expect(c.stats().flushed).toBe(1);
      expect(c.stats().pending).toBe(0);
    });

    it('continues processing other chats after one fails', () => {
      const writes: string[] = [];
      const c = createSaveCoalescer(100);

      c.schedule('chat-a', () => {
        throw new Error('fail');
      }, 'normal');
      c.schedule('chat-b', () => writes.push('b-ok'), 'normal');

      vi.advanceTimersByTime(150);

      expect(writes).toEqual(['b-ok']);
      expect(c.stats().flushed).toBe(2);
      expect(c.stats().pending).toBe(0);
    });
  });
});
