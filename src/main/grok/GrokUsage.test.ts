import { describe, it, expect } from 'vitest'
import {
  estimateProjectedTokenUsage,
  parseGrokUsage,
  stripGrokAnsi,
  probeGrokUsage,
  type GrokPtyLike
} from './GrokUsage'

// ── Pure parser (the fully-tested core; everything else is impure PTY glue) ──

describe('parseGrokUsage', () => {
  it('parses a decimal percent from the "Credits used:" form', () => {
    const s = parseGrokUsage('Credits used: 1.05%')
    expect(s.creditsUsedPercent).toBe(1.05)
    expect(s.creditsUsedDisplay).toBe('1.05%')
    expect(s.confidence).toBe('observed')
  })

  it('parses an exact 0%', () => {
    const s = parseGrokUsage('Credits used: 0%')
    expect(s.creditsUsedPercent).toBe(0)
    expect(s.creditsUsedDisplay).toBe('0%')
    expect(s.confidence).toBe('observed')
  })

  it('preserves the "<1%" band as a display string without inventing a number', () => {
    const s = parseGrokUsage('Credits used: <1%')
    expect(s.creditsUsedPercent).toBeNull()
    expect(s.creditsUsedDisplay).toBe('<1%')
    expect(s.confidence).toBe('observed')
  })

  it('parses the status-line "<1% used" form', () => {
    const s = parseGrokUsage('grok · <1% used · plan')
    expect(s.creditsUsedDisplay).toBe('<1%')
    expect(s.creditsUsedPercent).toBeNull()
    expect(s.confidence).toBe('observed')
  })

  it('parses the status-line "12% used" form', () => {
    const s = parseGrokUsage('12% used')
    expect(s.creditsUsedPercent).toBe(12)
    expect(s.creditsUsedDisplay).toBe('12%')
  })

  it('captures an explicit PT reset window and derives a pace reset timestamp', () => {
    const s = parseGrokUsage(
      'Credits used: 0%\nResets: May 31, 16:00 PT',
      '2026-05-31T09:00:00.000Z'
    )
    expect(s.resetAtText).toBe('May 31, 16:00 PT')
    expect(s.resetAt).toBe('2026-05-31T23:00:00.000Z')
    expect(s.limitWindowSeconds).toBe(30 * 24 * 60 * 60)
  })

  it('captures a short "Resets 1 Jun" window (no colon)', () => {
    const s = parseGrokUsage('Credits used: 0%  Resets 1 Jun')
    expect(s.resetAtText).toBe('1 Jun')
    expect(s.resetAt).toBeNull()
  })

  it('stops the reset capture before a trailing pay-as-you-go field on the same line', () => {
    const s = parseGrokUsage('Resets: May 31, 16:00 PT  Pay as you go: disabled')
    expect(s.resetAtText).toBe('May 31, 16:00 PT')
  })

  it('reads the "Free credits with SuperGrok" plan label', () => {
    const s = parseGrokUsage('Free credits with SuperGrok')
    expect(s.planLabel).toBe('Free credits with SuperGrok')
  })

  it('reads a bare "SuperGrok Heavy" plan label', () => {
    const s = parseGrokUsage('Plan: SuperGrok Heavy')
    expect(s.planLabel).toBe('SuperGrok Heavy')
  })

  it('reads pay-as-you-go disabled/enabled (and on/off synonyms)', () => {
    expect(parseGrokUsage('Pay as you go: disabled').payAsYouGoEnabled).toBe(false)
    expect(parseGrokUsage('Pay as you go: enabled').payAsYouGoEnabled).toBe(true)
    expect(parseGrokUsage('Pay as you go: off').payAsYouGoEnabled).toBe(false)
    expect(parseGrokUsage('Pay as you go: on').payAsYouGoEnabled).toBe(true)
  })

  // ── Weekly-limit /usage screen (mid-2026 CLI) ───────────────────────────────

  it('parses the "Weekly limit:" used-percent form as a weekly_limit snapshot', () => {
    const s = parseGrokUsage('Weekly limit: 98%')
    expect(s.creditsUsedPercent).toBe(98)
    expect(s.creditsUsedDisplay).toBe('98%')
    expect(s.usageKind).toBe('weekly_limit')
    expect(s.confidence).toBe('observed')
  })

  it('preserves a "Weekly limit: <1%" band without inventing a number', () => {
    const s = parseGrokUsage('Weekly limit: <1%')
    expect(s.creditsUsedPercent).toBeNull()
    expect(s.creditsUsedDisplay).toBe('<1%')
    expect(s.usageKind).toBe('weekly_limit')
  })

  it('converts the status-line "Weekly limit left:" remaining form into used percent', () => {
    const s = parseGrokUsage('Weekly limit left: 2% · Composer 2.5')
    expect(s.creditsUsedPercent).toBe(98)
    expect(s.creditsUsedDisplay).toBe('98%')
    expect(s.usageKind).toBe('weekly_limit')
  })

  it('converts a decimal "Weekly limit left:" without float noise', () => {
    const s = parseGrokUsage('Weekly limit left: 2.5%')
    expect(s.creditsUsedPercent).toBe(97.5)
    expect(s.creditsUsedDisplay).toBe('97.5%')
  })

  it('maps "Weekly limit left: <1%" to a ">99%" used band (no invented number)', () => {
    const s = parseGrokUsage('Weekly limit left: <1%')
    expect(s.creditsUsedPercent).toBeNull()
    expect(s.creditsUsedDisplay).toBe('>99%')
    expect(s.usageKind).toBe('weekly_limit')
    expect(s.confidence).toBe('observed')
  })

  it('captures the "Next reset:" window and derives a 7-day weekly pace window', () => {
    const s = parseGrokUsage(
      'Weekly limit: 98%\nNext reset: July 2, 09:04 PT',
      '2026-07-01T12:00:00.000Z'
    )
    expect(s.resetAtText).toBe('July 2, 09:04 PT')
    expect(s.resetAt).toBe('2026-07-02T16:04:00.000Z')
    expect(s.limitWindowSeconds).toBe(7 * 24 * 60 * 60)
  })

  it('parses the full weekly /usage screen (the real capture shape)', () => {
    const screen = ['Weekly limit: 98%', 'Next reset: July 2, 09:04 PT'].join('\n')
    const s = parseGrokUsage(screen, '2026-07-01T12:00:00.000Z')
    expect(s).toMatchObject({
      provider: 'grok',
      source: 'grok-cli-usage',
      usageKind: 'weekly_limit',
      creditsUsedPercent: 98,
      creditsUsedDisplay: '98%',
      resetAtText: 'July 2, 09:04 PT',
      resetAt: '2026-07-02T16:04:00.000Z',
      limitWindowSeconds: 7 * 24 * 60 * 60,
      confidence: 'observed'
    })
  })

  it('keeps the legacy credits forms on the monthly window and subscription_credits kind', () => {
    const s = parseGrokUsage(
      'Credits used: 1%\nResets: May 31, 16:00 PT',
      '2026-05-28T00:00:00.000Z'
    )
    expect(s.usageKind).toBe('subscription_credits')
    expect(s.limitWindowSeconds).toBe(30 * 24 * 60 * 60)
  })

  it('stops the "Next reset" capture before a trailing weekly-limit field on the same line', () => {
    const s = parseGrokUsage('Next reset: July 2, 09:04 PT  Weekly limit: 98%')
    expect(s.resetAtText).toBe('July 2, 09:04 PT')
  })

  it('returns an "unavailable" snapshot when no credit signal is present', () => {
    const s = parseGrokUsage('Welcome to grok\nType a message to begin')
    expect(s.confidence).toBe('unavailable')
    expect(s.creditsUsedDisplay).toBe('')
    expect(s.creditsUsedPercent).toBeNull()
    expect(s.resetAtText).toBeNull()
  })

  it('strips ANSI/VT control sequences before parsing', () => {
    const raw = '\x1b[1m\x1b[32mCredits used:\x1b[0m 2.5%\x1b[0m'
    const s = parseGrokUsage(raw)
    expect(s.creditsUsedPercent).toBe(2.5)
    expect(s.creditsUsedDisplay).toBe('2.5%')
  })

  it('parses a full multi-field screen (the real "/usage" capture shape)', () => {
    const screen = [
      'Free credits with SuperGrok',
      'Credits used: 1.05%',
      'Resets: May 31, 16:00 PT',
      'Pay as you go: disabled'
    ].join('\n')
    const s = parseGrokUsage(screen, '2026-05-31T09:00:00.000Z')
    expect(s).toMatchObject({
      provider: 'grok',
      source: 'grok-cli-usage',
      usageKind: 'subscription_credits',
      creditsUsedPercent: 1.05,
      creditsUsedDisplay: '1.05%',
      resetAtText: 'May 31, 16:00 PT',
      resetAt: '2026-05-31T23:00:00.000Z',
      limitWindowSeconds: 30 * 24 * 60 * 60,
      planLabel: 'Free credits with SuperGrok',
      payAsYouGoEnabled: false,
      confidence: 'observed'
    })
  })

  it('preserves the provided refreshedAt timestamp', () => {
    const s = parseGrokUsage('Credits used: 0%', '2026-05-28T12:00:00.000Z')
    expect(s.refreshedAt).toBe('2026-05-28T12:00:00.000Z')
  })

  it('always sets stable provider/source/usageKind identifiers', () => {
    const s = parseGrokUsage('Credits used: 0%')
    expect(s.provider).toBe('grok')
    expect(s.source).toBe('grok-cli-usage')
    expect(s.usageKind).toBe('subscription_credits')
  })

  it('tolerates empty/garbage input without throwing', () => {
    expect(parseGrokUsage('').confidence).toBe('unavailable')
    // @ts-expect-error — defensively accepts non-string at runtime.
    expect(parseGrokUsage(undefined).confidence).toBe('unavailable')
  })
})

describe('stripGrokAnsi', () => {
  it('removes CSI color sequences but keeps text and spaces', () => {
    expect(stripGrokAnsi('\x1b[1mhello \x1b[0mworld')).toBe('hello world')
  })

  it('removes OSC (title) sequences', () => {
    expect(stripGrokAnsi('\x1b]0;some title\x07text')).toBe('text')
  })

  it('converts carriage returns to newlines so line scans survive TUI redraws', () => {
    expect(stripGrokAnsi('a\rb')).toBe('a\nb')
  })
})

describe('estimateProjectedTokenUsage', () => {
  it('uses the Grok 4.6 short-context rates below 200K prompt tokens', () => {
    const usage = estimateProjectedTokenUsage(
      'a'.repeat(400_000),
      'b'.repeat(400_000),
      0,
      'grok-4.6'
    )

    expect(usage.input_tokens).toBe(100_000)
    expect(usage.output_tokens).toBe(100_000)
    expect(usage.total_cost_usd).toBe(0.8)
  })

  it('uses short-context rates immediately below the 200K input-token threshold', () => {
    const usage = estimateProjectedTokenUsage(
      'a'.repeat(799_996),
      'b'.repeat(400_000),
      0,
      'grok-4.6'
    )

    expect(usage.input_tokens).toBe(199_999)
    expect(usage.output_tokens).toBe(100_000)
    expect(usage.total_cost_usd).toBeCloseTo(0.999998, 8)
  })

  it('prices the entire request at long-context rates at the 200K input-token boundary', () => {
    const usage = estimateProjectedTokenUsage(
      'a'.repeat(800_000),
      'b'.repeat(400_000),
      0,
      'grok-4.6'
    )

    expect(usage.input_tokens).toBe(200_000)
    expect(usage.output_tokens).toBe(100_000)
    expect(usage.total_cost_usd).toBe(2)
  })

  it('keeps using long-context rates above the threshold', () => {
    const usage = estimateProjectedTokenUsage(
      'a'.repeat(4_000_000),
      'b'.repeat(4_000_000),
      0,
      'grok-4.6'
    )

    expect(usage.input_tokens).toBe(1_000_000)
    expect(usage.output_tokens).toBe(1_000_000)
    expect(usage.total_cost_usd).toBe(16)
  })

  it('keeps Grok 4.5 on its flat rate above the Grok 4.6 long-context threshold', () => {
    const usage = estimateProjectedTokenUsage(
      'a'.repeat(800_000),
      'b'.repeat(400_000),
      0,
      'grok-4.5'
    )

    expect(usage.input_tokens).toBe(200_000)
    expect(usage.output_tokens).toBe(100_000)
    expect(usage.total_cost_usd).toBe(1)
  })

  it('keeps Grok Composer 2.5 Fast on its distinct projected rate', () => {
    const usage = estimateProjectedTokenUsage(
      'a'.repeat(400_000),
      'b'.repeat(400_000),
      0,
      'grok-composer-2.5-fast'
    )

    expect(usage.input_tokens).toBe(100_000)
    expect(usage.output_tokens).toBe(100_000)
    expect(usage.total_cost_usd).toBe(1.8)
  })

  it('preserves the historical Composer projection when the caller omits the model', () => {
    const usage = estimateProjectedTokenUsage('a'.repeat(400_000), 'b'.repeat(400_000))

    expect(usage.total_cost_usd).toBe(1.8)
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

class FakePty implements GrokPtyLike {
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

describe('probeGrokUsage', () => {
  const FIXED_NOW = '2026-05-28T00:00:00.000Z'

  it('resolves an observed snapshot once a credit line streams in', async () => {
    const pty = new FakePty()
    const clock = new FakeClock()
    const promise = probeGrokUsage({
      spawnPty: () => pty,
      now: () => FIXED_NOW,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    })

    pty.emit('Credits used: 1.05%\nResets: May 31, 16:00 PT\nPay as you go: disabled\n')
    // The probe waits one beat (250ms) for trailing lines, then parses.
    clock.advance(250)

    const snap = await promise
    expect(snap.confidence).toBe('observed')
    expect(snap.creditsUsedPercent).toBe(1.05)
    expect(snap.resetAtText).toBe('May 31, 16:00 PT')
    expect(snap.payAsYouGoEnabled).toBe(false)
    expect(snap.refreshedAt).toBe(FIXED_NOW)
    expect(pty.killed).toBe(true)
  })

  it('answers the TUI terminal queries (DSR + XTVERSION) it blocks on at startup', async () => {
    const pty = new FakePty()
    const clock = new FakeClock()
    const promise = probeGrokUsage({
      spawnPty: () => pty,
      now: () => FIXED_NOW,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      timeoutMs: 1000
    })

    pty.emit('\x1b[?25l\x1b[6n\x1b[>0q')
    expect(pty.writes).toContain('\x1b[1;1R')
    expect(pty.writes).toContain('\x1bP>|xterm(370)\x1b\\')

    clock.advance(1000)
    await promise
  })

  it('early-outs on the weekly-limit /usage screen too', async () => {
    const pty = new FakePty()
    const clock = new FakeClock()
    const promise = probeGrokUsage({
      spawnPty: () => pty,
      now: () => FIXED_NOW,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    })

    pty.emit('Weekly limit: 98%\nNext reset: July 2, 09:04 PT\n')
    clock.advance(250)

    const snap = await promise
    expect(snap.confidence).toBe('observed')
    expect(snap.usageKind).toBe('weekly_limit')
    expect(snap.creditsUsedPercent).toBe(98)
    expect(snap.resetAtText).toBe('July 2, 09:04 PT')
    expect(pty.killed).toBe(true)
  })

  it('holds a status-line-only reading open for the full /usage screen, then upgrades', async () => {
    const pty = new FakePty()
    const clock = new FakeClock()
    let resolved = false
    const promise = probeGrokUsage({
      spawnPty: () => pty,
      now: () => FIXED_NOW,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      readyDelayMs: 100
    }).then((s) => {
      resolved = true
      return s
    })

    // Welcome screen status line arrives first — usable, but no reset window.
    pty.emit('[stable] Weekly limit left: 2% ·')
    clock.advance(300)
    await Promise.resolve()
    expect(resolved).toBe(false) // did NOT settle on the partial reading

    // The /usage screen streams in → full signal → settles on the beat.
    pty.emit('Weekly limit: 98%\nNext reset: July 2, 09:04 PT\n')
    clock.advance(250)
    const snap = await promise
    expect(snap.creditsUsedPercent).toBe(98)
    expect(snap.resetAtText).toBe('July 2, 09:04 PT')
    expect(snap.limitWindowSeconds).toBe(7 * 24 * 60 * 60)
  })

  it('falls back to the status-line reading when the /usage screen never renders', async () => {
    const pty = new FakePty()
    const clock = new FakeClock()
    const promise = probeGrokUsage({
      spawnPty: () => pty,
      now: () => FIXED_NOW,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      readyDelayMs: 100
    })

    pty.emit('[stable] Weekly limit left: 2% ·')
    clock.advance(100 + 1500)

    const snap = await promise
    expect(snap.confidence).toBe('observed')
    expect(snap.usageKind).toBe('weekly_limit')
    expect(snap.creditsUsedPercent).toBe(98)
    expect(snap.resetAtText).toBeNull()
    expect(pty.killed).toBe(true)
  })

  it('buffers data split across multiple chunks before the credit regex matches', async () => {
    const pty = new FakePty()
    const clock = new FakeClock()
    const promise = probeGrokUsage({
      spawnPty: () => pty,
      now: () => FIXED_NOW,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    })

    pty.emit('Credits used: ') // no digit yet → no early-out
    clock.advance(10)
    pty.emit('1.05%\n') // now the line is complete
    clock.advance(250)

    const snap = await promise
    expect(snap.creditsUsedPercent).toBe(1.05)
    expect(snap.confidence).toBe('observed')
  })

  it('sends only "/usage" and never a follow-up Enter', async () => {
    const pty = new FakePty()
    const clock = new FakeClock()
    const promise = probeGrokUsage({
      spawnPty: () => pty,
      now: () => FIXED_NOW,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      readyDelayMs: 100,
      timeoutMs: 1000
    })

    clock.advance(100)
    expect(pty.writes).toEqual(['/usage\r'])

    clock.advance(900) // reach the hard timeout without another activation key
    const snap = await promise
    expect(snap.confidence).toBe('unavailable')
    expect(pty.writes).toEqual(['/usage\r'])
  })

  it('resolves an "unavailable" snapshot on timeout with no data', async () => {
    const pty = new FakePty()
    const clock = new FakeClock()
    const promise = probeGrokUsage({
      spawnPty: () => pty,
      now: () => FIXED_NOW,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      timeoutMs: 5000
    })

    clock.advance(5000)
    const snap = await promise
    expect(snap.confidence).toBe('unavailable')
    expect(snap.creditsUsedDisplay).toBe('')
    expect(pty.killed).toBe(true)
  })

  it('resolves "unavailable" when the child exits before any usable data', async () => {
    const pty = new FakePty()
    const clock = new FakeClock()
    const promise = probeGrokUsage({
      spawnPty: () => pty,
      now: () => FIXED_NOW,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    })

    pty.exit(0)
    const snap = await promise
    expect(snap.confidence).toBe('unavailable')
  })

  it('resolves "unavailable" (never throws) when spawnPty itself fails', async () => {
    const snap = await probeGrokUsage({
      spawnPty: () => {
        throw new Error('node-pty unavailable')
      },
      now: () => FIXED_NOW
    })
    expect(snap.confidence).toBe('unavailable')
    expect(snap.provider).toBe('grok')
  })

  it('settles only once even if data arrives after an exit', async () => {
    const pty = new FakePty()
    const clock = new FakeClock()
    let resolveCount = 0
    const promise = probeGrokUsage({
      spawnPty: () => pty,
      now: () => FIXED_NOW,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    }).then((s) => {
      resolveCount += 1
      return s
    })

    pty.exit(0)
    pty.emit('Credits used: 9%\n') // late, post-settle data must be ignored
    clock.advance(250)

    const snap = await promise
    expect(resolveCount).toBe(1)
    expect(snap.confidence).toBe('unavailable')
  })
})
