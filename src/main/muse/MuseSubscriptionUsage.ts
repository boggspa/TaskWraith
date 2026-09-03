// Muse subscription `/usage` PTY capture — distinct from token metering.
//
// `MuseUsage.ts` meters session.jsonl TOKENS (input/cached/output, turns).
// The subscription meters on the interactive `/usage` panel — Current %,
// Weekly %, reset timestamps, plan name — are a DIFFERENT quantity that does
// not exist in session.jsonl. There is no non-interactive `muse` flag for
// them (`muse --help` lists no usage command), so the only source is the
// interactive `/usage` screen, captured via PTY. This module keeps the PARSER
// pure + fully unit-tested and isolates the impure PTY capture behind an
// injected `spawnPty` (fake-terminal testable). No prompt is ever sent and no
// credential file is touched.
//
// Panel shape (observed muse-bin-1.0.2-R2040.1, 2026-09-03): a Session token
// block (Input / Cached / Output / Total, Turns, Subagents) plus a
// Subscription block titled e.g. "Muse Code High Usage" with
// "Current  47%  Resets 4:18 PM" and "Weekly  17%  Resets Sep 7 1:00 AM".
//
// Deliberate rulings:
// - Current carries its resetAt but NO window duration: no source states a
//   window length, and a fabricated 18000s would paint 5 dashes on an
//   unproven window. Weekly may carry 604800s.
// - The bare Current clock ("4:18 PM") has no date and no zone; it is
//   resolved against the injected `now` in UTC day terms. If the clock time
//   is at or before now's time-of-day it belongs to TOMORROW.
// - Weekly's reset ("Sep 7 1:00 AM") has no year; a past instant rolls to
//   next year (Dec -> Jan).
// - A missing subscription block (free tier, signed out) is a reading with
//   no subscription meters, never a throw.

export const MUSE_SUBSCRIPTION_USAGE_COMMAND = '/usage\r'
export const MUSE_SUBSCRIPTION_TUI_ARGS = [] as const
export const MUSE_SUBSCRIPTION_WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60

const MAX_CAPTURED_OUTPUT = 80_000

/** ESC as a runtime value so no raw control byte ever sits in source. */
const MUSE_ESC = String.fromCharCode(27)
const MUSE_OSC_RE = new RegExp(`${MUSE_ESC}\\][^\\x07${MUSE_ESC}]*(?:\\x07|${MUSE_ESC}\\\\)`, 'g')
const MUSE_CSI_RE = new RegExp(`${MUSE_ESC}\\[[0-?]*[ -/]*[@-~]`, 'g')
const MUSE_SINGLE_ESC_RE = new RegExp(`${MUSE_ESC}[@-Z\\-_]`, 'g')

/** Strip ANSI/VT control sequences while preserving printable text + spaces. */
export function stripMuseSubscriptionAnsi(input: string): string {
  return String(input || '')
    .replace(MUSE_OSC_RE, '')
    .replace(MUSE_CSI_RE, '')
    .replace(MUSE_SINGLE_ESC_RE, '')
    .replace(/\r/g, '\n')
}

export interface MuseSubscriptionMeter {
  /** USED percent (0-100) as shown; null when the meter row is absent. */
  usedPercent: number | null
  /** Reset text exactly as shown (e.g. "4:18 PM", "Sep 7 1:00 AM"). */
  resetAtText: string | null
  /** ISO instant resolved against the injected `now`; null when unparseable. */
  resetAt: string | null
  /** Weekly only (604800 when resetAt parses); Current never carries one. */
  limitWindowSeconds: number | null
}

export interface MuseSubscriptionSessionCounts {
  inputTokens: number | null
  cachedTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  turns: number | null
  subagents: number | null
}

export interface MuseSubscriptionUsageReading {
  /** Plan title as shown (e.g. "Muse Code High Usage"); null when absent. */
  planName: string | null
  /** False when the subscription block is absent — never a throw. */
  hasSubscription: boolean
  current: MuseSubscriptionMeter
  weekly: MuseSubscriptionMeter
  session: MuseSubscriptionSessionCounts
  refreshedAt: string
}

function emptyMeter(): MuseSubscriptionMeter {
  return { usedPercent: null, resetAtText: null, resetAt: null, limitWindowSeconds: null }
}

function emptySession(): MuseSubscriptionSessionCounts {
  return {
    inputTokens: null,
    cachedTokens: null,
    outputTokens: null,
    totalTokens: null,
    turns: null,
    subagents: null
  }
}

function monthIndex(name: string): number | null {
  const key = name.slice(0, 3).toLowerCase()
  const index = [
    'jan',
    'feb',
    'mar',
    'apr',
    'may',
    'jun',
    'jul',
    'aug',
    'sep',
    'oct',
    'nov',
    'dec'
  ].indexOf(key)
  return index >= 0 ? index : null
}

function parseClockTime(value: string): { hour: number; minute: number } | null {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})\s*([AP])\.?\s*M\.?$/i)
  if (!match) return null
  let hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isInteger(hour) || hour < 1 || hour > 12) return null
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null
  const pm = match[3].toUpperCase() === 'P'
  if (hour === 12) hour = pm ? 12 : 0
  else if (pm) hour += 12
  return { hour, minute }
}

/** "4:18 PM" against `now`: same UTC day when still ahead, else tomorrow. */
function resolveBareClockTime(clock: string, nowMs: number): string | null {
  const parsed = parseClockTime(clock)
  if (!parsed || !Number.isFinite(nowMs)) return null
  const now = new Date(nowMs)
  let candidate = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    parsed.hour,
    parsed.minute
  )
  if (candidate <= nowMs) candidate += 24 * 60 * 60 * 1000
  return new Date(candidate).toISOString()
}

/** "Sep 7 1:00 AM" (no year) against `now`: this year when ahead, else next. */
function resolveMonthDayClock(value: string, nowMs: number): string | null {
  const match = value
    .trim()
    .match(/^([A-Za-z]+)\s+(\d{1,2})(?:\s+(\d{1,2}):(\d{2})\s*([AP])\.?\s*M\.?)?$/i)
  if (!match || !Number.isFinite(nowMs)) return null
  const month = monthIndex(match[1])
  const day = Number(match[2])
  if (month === null || !Number.isInteger(day) || day < 1 || day > 31) return null
  let hour = 0
  let minute = 0
  if (match[3] !== undefined) {
    const parsed = parseClockTime(`${match[3]}:${match[4]} ${match[5]}M`)
    if (!parsed) return null
    hour = parsed.hour
    minute = parsed.minute
  }
  const now = new Date(nowMs)
  let candidate = Date.UTC(now.getUTCFullYear(), month, day, hour, minute)
  const probe = new Date(candidate)
  if (probe.getUTCMonth() !== month || probe.getUTCDate() !== day) return null
  if (candidate <= nowMs) {
    candidate = Date.UTC(now.getUTCFullYear() + 1, month, day, hour, minute)
  }
  return new Date(candidate).toISOString()
}

function parsePercent(value: string): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null
}

function parseCount(value: string): number | null {
  const parsed = Number(value.replace(/,/g, ''))
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

/**
 * Parse captured `/usage` panel text into a reading. `text` may be raw (with
 * ANSI) or pre-stripped; stripping is defensive. `nowIso` is the observation
 * instant — always injected, never the wall clock. Zero counts/percents are
 * real values, never "absent".
 */
export function parseMuseSubscriptionUsagePanel(
  rawText: string,
  nowIso: string = new Date().toISOString()
): MuseSubscriptionUsageReading {
  const nowMs = new Date(nowIso).getTime()
  const refreshedAt = Number.isFinite(nowMs) ? new Date(nowMs).toISOString() : nowIso
  const text = stripMuseSubscriptionAnsi(rawText || '')
  const reading: MuseSubscriptionUsageReading = {
    planName: null,
    hasSubscription: false,
    current: emptyMeter(),
    weekly: emptyMeter(),
    session: emptySession(),
    refreshedAt
  }

  const planMatch = text.match(/^[^\n]*Muse\s+Code\s+[^\n]{1,80}$/im)
  if (planMatch) {
    reading.planName = planMatch[0].replace(/\s+/g, ' ').trim()
  }

  const meter = (
    label: 'Current' | 'Weekly',
    target: MuseSubscriptionMeter,
    weekly: boolean
  ): void => {
    const match = text.match(
      new RegExp(`${label}\\s+(\\d{1,3}(?:\\.\\d+)?)\\s*%\\s*(?:Resets?\\s+([^\\n]*))?`, 'i')
    )
    if (!match) return
    reading.hasSubscription = true
    target.usedPercent = parsePercent(match[1])
    const resetText = (match[2] || '').replace(/\s+/g, ' ').trim()
    target.resetAtText = resetText || null
    if (!resetText) return
    target.resetAt = weekly
      ? resolveMonthDayClock(resetText, nowMs)
      : resolveBareClockTime(resetText, nowMs)
    if (weekly && target.resetAt) {
      target.limitWindowSeconds = MUSE_SUBSCRIPTION_WEEKLY_WINDOW_SECONDS
    }
  }
  meter('Current', reading.current, false)
  meter('Weekly', reading.weekly, true)

  const sessionField = (label: string): number | null => {
    const match = text.match(new RegExp(`${label}\\s*[:=]?\\s*([\\d,]+)`, 'i'))
    return match ? parseCount(match[1]) : null
  }
  reading.session = {
    inputTokens: sessionField('Input'),
    cachedTokens: sessionField('Cached'),
    outputTokens: sessionField('Output'),
    totalTokens: sessionField('Total'),
    turns: sessionField('Turns'),
    subagents: sessionField('Subagents')
  }
  return reading
}

// ── PTY probe (impure; injected terminal keeps it testable) ──────────────────

export interface MuseSubscriptionPtyLike {
  onData(listener: (data: string) => void): void
  onExit(listener: (event: { exitCode: number }) => void): void
  write(data: string): void
  kill(): void
}

export interface MuseSubscriptionProbeDeps {
  /** Spawns the interactive `muse` TUI in a throwaway cwd. */
  spawnPty: () => MuseSubscriptionPtyLike
  /** Hard ceiling for the whole probe. */
  timeoutMs?: number
  /** ms to wait for the TUI before sending `/usage` (overridable for tests). */
  readyDelayMs?: number
  /** ms to wait after a full panel streams in before parsing (settle once). */
  settleDelayMs?: number
  now?: () => string
  setTimer?: (cb: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/**
 * Capture `/usage` via PTY and parse it. Resolves as soon as both
 * subscription meters have streamed in (settle-once, then parse), or with a
 * meter-less reading on timeout / clean-exit-without-data. Always kills the
 * child. The usage command's terminating carriage return is the only Enter
 * sent; the probe never sends a later activation keystroke.
 */
export function probeMuseSubscriptionUsage(
  deps: MuseSubscriptionProbeDeps
): Promise<MuseSubscriptionUsageReading> {
  const timeoutMs = deps.timeoutMs ?? 12_000
  const readyDelayMs = deps.readyDelayMs ?? 2200
  const settleDelayMs = deps.settleDelayMs ?? 250
  const now = deps.now ?? (() => new Date().toISOString())
  const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))

  return new Promise<MuseSubscriptionUsageReading>((resolve) => {
    let settled = false
    let settleArmed = false
    let buffer = ''
    const timers: unknown[] = []
    let child: MuseSubscriptionPtyLike | null = null

    const finish = (reading: MuseSubscriptionUsageReading): void => {
      if (settled) return
      settled = true
      for (const t of timers) clearTimer(t)
      try {
        child?.kill()
      } catch {
        // already gone
      }
      resolve(reading)
    }

    try {
      child = deps.spawnPty()
    } catch {
      resolve(parseMuseSubscriptionUsagePanel('', now()))
      return
    }

    child.onData((data) => {
      buffer += data
      if (buffer.length > MAX_CAPTURED_OUTPUT) buffer = buffer.slice(-MAX_CAPTURED_OUTPUT)
      if (settled || settleArmed) return
      const stripped = stripMuseSubscriptionAnsi(buffer)
      if (/Current\s+\d/i.test(stripped) && /Weekly\s+\d/i.test(stripped)) {
        settleArmed = true
        timers.push(setTimer(() => finish(parseMuseSubscriptionUsagePanel(buffer, now())), settleDelayMs))
      }
    })

    child.onExit(() => finish(parseMuseSubscriptionUsagePanel(buffer, now())))

    timers.push(setTimer(() => child?.write(MUSE_SUBSCRIPTION_USAGE_COMMAND), readyDelayMs))
    timers.push(
      setTimer(() => finish(parseMuseSubscriptionUsagePanel(buffer, now())), timeoutMs)
    )
  })
}
