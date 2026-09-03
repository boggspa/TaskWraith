import { describe, expect, it } from 'vitest'
import {
  MUSE_SUBSCRIPTION_USAGE_COMMAND,
  MUSE_SUBSCRIPTION_WEEKLY_WINDOW_SECONDS,
  parseMuseSubscriptionUsagePanel,
  probeMuseSubscriptionUsage,
  stripMuseSubscriptionAnsi,
  type MuseSubscriptionPtyLike
} from './MuseSubscriptionUsage'

// The user's screenshot state (muse-bin-1.0.2-R2040.1, observed 15:50 local
// 2026-09-03): zeroed session token block plus the "Muse Code High Usage"
// subscription block — Current 47% resetting 4:18 PM same-day, Weekly 17%
// resetting Sep 7 1:00 AM.
function observedPanel(): string {
  return [
    'Session',
    'Input 0  Cached 0  Output 0  Total 0',
    'Turns 0  Subagents 0',
    'Subscription',
    'Muse Code High Usage',
    'Current  47%  Resets 4:18 PM',
    'Weekly  17%  Resets Sep 7 1:00 AM'
  ].join('\n')
}

describe('parseMuseSubscriptionUsagePanel', () => {
  it('parses the screenshot panel: plan, percents, resets, zero session counts', () => {
    const r = parseMuseSubscriptionUsagePanel(
      observedPanel(),
      '2026-09-03T15:50:00.000Z'
    )
    expect(r.planName).toBe('Muse Code High Usage')
    expect(r.hasSubscription).toBe(true)
    expect(r.current.usedPercent).toBe(47)
    expect(r.current.resetAtText).toBe('4:18 PM')
    expect(r.current.resetAt).toBe('2026-09-03T16:18:00.000Z')
    expect(r.current.limitWindowSeconds).toBeNull()
    expect(r.weekly.usedPercent).toBe(17)
    expect(r.weekly.resetAtText).toBe('Sep 7 1:00 AM')
    expect(r.weekly.resetAt).toBe('2026-09-07T01:00:00.000Z')
    expect(r.weekly.limitWindowSeconds).toBe(MUSE_SUBSCRIPTION_WEEKLY_WINDOW_SECONDS)
    expect(r.session).toMatchObject({
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      turns: 0,
      subagents: 0
    })
    expect(r.refreshedAt).toBe('2026-09-03T15:50:00.000Z')
  })

  it('resolves a bare Current clock earlier than now to TOMORROW (wrap case)', () => {
    const r = parseMuseSubscriptionUsagePanel('Current 47% Resets 4:18 PM', '2026-09-03T18:00:00.000Z')
    expect(r.current.resetAt).toBe('2026-09-04T16:18:00.000Z')
  })

  it('resolves a bare Current clock later than now to TODAY (same-day case)', () => {
    const r = parseMuseSubscriptionUsagePanel('Current 47% Resets 4:18 PM', '2026-09-03T15:50:00.000Z')
    expect(r.current.resetAt).toBe('2026-09-03T16:18:00.000Z')
  })

  it('rolls a past Weekly month/day reset into next year (Dec -> Jan)', () => {
    const r = parseMuseSubscriptionUsagePanel(
      'Weekly 17% Resets Jan 5 1:00 AM',
      '2026-12-20T12:00:00.000Z'
    )
    expect(r.weekly.resetAt).toBe('2027-01-05T01:00:00.000Z')
  })

  it('keeps a future Weekly month/day reset in the same year', () => {
    const r = parseMuseSubscriptionUsagePanel(
      'Weekly 17% Resets Sep 7 1:00 AM',
      '2026-09-03T15:50:00.000Z'
    )
    expect(r.weekly.resetAt).toBe('2026-09-07T01:00:00.000Z')
  })

  it('parses 12-hour edges (12 AM is midnight, 12 PM is noon)', () => {
    const before = parseMuseSubscriptionUsagePanel(
      'Current 10% Resets 12:00 AM',
      '2026-09-03T15:50:00.000Z'
    )
    expect(before.current.resetAt).toBe('2026-09-04T00:00:00.000Z')
    const noon = parseMuseSubscriptionUsagePanel(
      'Current 10% Resets 12:00 PM',
      '2026-09-03T11:00:00.000Z'
    )
    expect(noon.current.resetAt).toBe('2026-09-03T12:00:00.000Z')
  })

  it('keeps the percent when the reset text is unparseable, with null resetAt', () => {
    const r = parseMuseSubscriptionUsagePanel('Current 47% Resets soon-ish', '2026-09-03T15:50:00.000Z')
    expect(r.current.usedPercent).toBe(47)
    expect(r.current.resetAtText).toBe('soon-ish')
    expect(r.current.resetAt).toBeNull()
    expect(r.current.limitWindowSeconds).toBeNull()
  })

  it('returns a meter-less reading (no throw) when the subscription block is absent', () => {
    const r = parseMuseSubscriptionUsagePanel(
      'Welcome to Muse\nType a message to begin',
      '2026-09-03T15:50:00.000Z'
    )
    expect(r.hasSubscription).toBe(false)
    expect(r.planName).toBeNull()
    expect(r.current.usedPercent).toBeNull()
    expect(r.weekly.usedPercent).toBeNull()
  })

  it('treats 0% as a real observed value, not absent', () => {
    const r = parseMuseSubscriptionUsagePanel(
      'Current 0% Resets 4:18 PM\nWeekly 0% Resets Sep 7 1:00 AM',
      '2026-09-03T15:50:00.000Z'
    )
    expect(r.hasSubscription).toBe(true)
    expect(r.current.usedPercent).toBe(0)
    expect(r.weekly.usedPercent).toBe(0)
  })

  it('strips ANSI/VT control sequences before parsing', () => {
    const raw = '\x1b[1mCurrent\x1b[0m  \x1b[32m47%\x1b[0m  Resets 4:18 PM'
    const r = parseMuseSubscriptionUsagePanel(raw, '2026-09-03T15:50:00.000Z')
    expect(r.current.usedPercent).toBe(47)
    expect(r.current.resetAt).toBe('2026-09-03T16:18:00.000Z')
  })

  it('tolerates empty/garbage input without throwing', () => {
    expect(parseMuseSubscriptionUsagePanel('', '2026-09-03T15:50:00.000Z').hasSubscription).toBe(
      false
    )
    // @ts-expect-error — defensively accepts non-string at runtime.
    expect(parseMuseSubscriptionUsagePanel(undefined, '2026-09-03T15:50:00.000Z').hasSubscription).toBe(
      false
    )
  })
})

describe('stripMuseSubscriptionAnsi', () => {
  it('removes CSI color sequences but keeps text and spaces', () => {
    expect(stripMuseSubscriptionAnsi('\x1b[1mhello \x1b[0mworld')).toBe('hello world')
  })

  it('converts carriage returns to newlines so line scans survive TUI redraws', () => {
    expect(stripMuseSubscriptionAnsi('a\rb')).toBe('a\nb')
  })
})

// ── Impure PTY probe (driven by a fake terminal + a virtual clock) ───────────

/** A controllable virtual clock so timeout/delay logic is deterministic. */
class FakeClock {
  now = 0
  private timers: { id: number; cb: () => void; at: number }[] = []
  private seq = 0

  setTimer = (cb: () => void, ms: number): number => {
    const id = ++this.seq
    this.timers.push({ id, cb, at: this.now + ms })
    return id
  }

  clearTimer = (handle: unknown): void => {
    this.timers = this.timers.filter((t) => t.id !== handle)
  }

  /** Fire every due timer in chronological order, honoring nested scheduling. */
  advance(ms: number): void {
    const target = this.now + ms
    for (;;) {
      const next = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      this.timers = this.timers.filter((t) => t.id !== next.id)
      this.now = next.at
      next.cb()
    }
    this.now = target
  }
}

class FakePty implements MuseSubscriptionPtyLike {
  writes: string[] = []
  killed = false
  private dataListener?: (data: string) => void
  private exitListener?: (event: { exitCode: number }) => void

  onData(listener: (data: string) => void): void {
    this.dataListener = listener
  }
  onExit(listener: (event: { exitCode: number }) => void): void {
    this.exitListener = listener
  }
  write(data: string): void {
    this.writes.push(data)
  }
  kill(): void {
    this.killed = true
  }

  /** Test helper: stream a chunk of terminal output to the probe. */
  emit(data: string): void {
    this.dataListener?.(data)
  }
  /** Test helper: simulate the child exiting. */
  exit(code = 0): void {
    this.exitListener?.({ exitCode: code })
  }
}

describe('probeMuseSubscriptionUsage', () => {
  const FIXED_NOW = '2026-09-03T15:50:00.000Z'

  it('sends the /usage command after the ready delay', async () => {
    const pty = new FakePty()
    const clock = new FakeClock()
    const promise = probeMuseSubscriptionUsage({
      spawnPty: () => pty,
      now: () => FIXED_NOW,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    })

    expect(pty.writes).not.toContain(MUSE_SUBSCRIPTION_USAGE_COMMAND)
    clock.advance(2200)
    expect(pty.writes).toContain(MUSE_SUBSCRIPTION_USAGE_COMMAND)

    pty.exit()
    await promise
  })

  it('resolves an observed reading once both meters stream in', async () => {
    const pty = new FakePty()
    const clock = new FakeClock()
    const promise = probeMuseSubscriptionUsage({
      spawnPty: () => pty,
      now: () => FIXED_NOW,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    })

    pty.emit(observedPanel())
    // The probe waits one beat (250ms) for trailing lines, then parses.
    clock.advance(250)

    const reading = await promise
    expect(reading.hasSubscription).toBe(true)
    expect(reading.planName).toBe('Muse Code High Usage')
    expect(reading.current.usedPercent).toBe(47)
    expect(reading.weekly.usedPercent).toBe(17)
    expect(reading.refreshedAt).toBe(FIXED_NOW)
    expect(pty.killed).toBe(true)
  })

  it('does not settle on a partial panel (Current alone)', async () => {
    const pty = new FakePty()
    const clock = new FakeClock()
    let resolved = false
    const promise = probeMuseSubscriptionUsage({
      spawnPty: () => pty,
      now: () => FIXED_NOW,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      timeoutMs: 5000
    }).then((reading) => {
      resolved = true
      return reading
    })

    pty.emit('Current 47% Resets 4:18 PM\n')
    clock.advance(1000)
    expect(resolved).toBe(false)

    pty.emit('Weekly 17% Resets Sep 7 1:00 AM\n')
    clock.advance(250)
    const reading = await promise
    expect(reading.weekly.usedPercent).toBe(17)
  })

  it('resolves a meter-less reading on timeout and always kills the child', async () => {
    const pty = new FakePty()
    const clock = new FakeClock()
    const promise = probeMuseSubscriptionUsage({
      spawnPty: () => pty,
      now: () => FIXED_NOW,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      timeoutMs: 1000
    })

    clock.advance(1000)
    const reading = await promise
    expect(reading.hasSubscription).toBe(false)
    expect(reading.current.usedPercent).toBeNull()
    expect(pty.killed).toBe(true)
  })

  it('resolves a meter-less reading when spawning throws', async () => {
    const reading = await probeMuseSubscriptionUsage({
      spawnPty: () => {
        throw new Error('no pty')
      },
      now: () => FIXED_NOW
    })
    expect(reading.hasSubscription).toBe(false)
  })
})
