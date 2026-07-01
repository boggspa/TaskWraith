import { GROK_PROJECTED_INPUT_USD_PER_MILLION, GROK_PROJECTED_OUTPUT_USD_PER_MILLION } from '../index.constants'
// Grok SUBSCRIPTION-LIMIT usage — distinct from token/cost usage.
//
// SuperGrok/grok.com CLI auth bills against a subscription pool (a percent +
// reset window), NOT per-token. There is NO noninteractive command for it
// (`grok inspect --json` is config-only; no `usage`/`account` subcommand), so
// the only safe source is the interactive `/usage` screen, captured via PTY.
// This module keeps the PARSER pure + fully unit-tested and isolates the
// impure PTY capture behind an injected `spawnPty` (testable for
// timeout/failure with a fake terminal). No prompt is ever sent (no model call
// / credit consumption); we never touch ~/.grok or credential files.
//
// Two generations of the /usage screen exist:
//  - legacy (≤ mid-2026): "Credits used: 1.05%" + "Resets: May 31, 16:00 PT"
//    → a MONTHLY credit pool ('subscription_credits')
//  - current: "Weekly limit: 98%" + "Next reset: July 2, 09:04 PT", with a
//    status-line form "Weekly limit left: 2%" → a WEEKLY window
//    ('weekly_limit'). "Weekly limit: N%" is the USED percent (the CLI shows
//    "left" only in the explicitly-labelled status-line form).
// Both are parsed; `usageKind` says which one was observed.

export interface GrokUsageSnapshot {
  provider: 'grok'
  source: 'grok-cli-usage'
  usageKind: 'subscription_credits' | 'weekly_limit'
  /** Parsed USED percent (0–100). null when only a coarse band like "<1%" is known. */
  creditsUsedPercent: number | null
  /** Raw display, preserved exactly (e.g. "1.05%", "0%", "<1%"). */
  creditsUsedDisplay: string
  /** Reset window text exactly as shown (e.g. "May 31, 16:00 PT", "July 2, 09:04 PT"). */
  resetAtText: string | null
  /** ISO timestamp when robustly parseable; null otherwise (we trust the text). */
  resetAt: string | null
  /** Monthly credit window (legacy) or 7-day weekly window when parseable. */
  limitWindowSeconds: number | null
  /** Plan label when shown (e.g. "Free credits with SuperGrok"). */
  planLabel: string | null
  payAsYouGoEnabled: boolean | null
  refreshedAt: string
  /** 'observed' = captured from the live CLI; 'unavailable' = probe found nothing. */
  confidence: 'observed' | 'unavailable'
}

export const GROK_CREDIT_WINDOW_SECONDS = 30 * 24 * 60 * 60
export const GROK_WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60

/** Strip ANSI/VT control sequences while preserving printable text + spaces. */
export function stripGrokAnsi(input: string): string {
  return (
    input
      // OSC (operating system command) sequences, BEL- or ST-terminated.
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // CSI sequences (colors, cursor moves, etc.).
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
      // Single-char escapes.
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[@-Z\\-_]/g, '')
      // Carriage returns (TUI redraws) → newlines so line scans still work.
      .replace(/\r/g, '\n')
  )
}

interface ParsedPercent {
  display: string
  percent: number | null
  kind: GrokUsageSnapshot['usageKind']
}

function parsePercentDisplay(text: string): ParsedPercent | null {
  const asUsed = (
    isBand: boolean,
    raw: string,
    kind: GrokUsageSnapshot['usageKind']
  ): ParsedPercent => {
    const num = Number(raw)
    return {
      display: isBand ? `<${raw}%` : `${raw}%`,
      percent: isBand || !Number.isFinite(num) ? null : num,
      kind
    }
  }
  // "Credits used: 1.05%" / "Credits used: 0%" / "Credits used: <1%" (legacy)
  const labelled = text.match(/Credits?\s*used:?\s*(<\s*)?(\d[\d.]*)\s*%/i)
  if (labelled) return asUsed(Boolean(labelled[1]), labelled[2], 'subscription_credits')
  // Status-line form: "Weekly limit left: 2%" / "Weekly limit left: <1%" —
  // REMAINING percent; convert to used (exact arithmetic, not invented).
  const weeklyLeft = text.match(/Weekly\s*limit\s*left:?\s*(<\s*)?(\d[\d.]*)\s*%/i)
  if (weeklyLeft) {
    const num = Number(weeklyLeft[2])
    if (Boolean(weeklyLeft[1]) || !Number.isFinite(num)) {
      // "<1% left" → used is only known as a ">99%" band; never invent a number.
      return { display: `>${100 - Math.ceil(num || 1)}%`, percent: null, kind: 'weekly_limit' }
    }
    const used = Number((100 - num).toFixed(2))
    return { display: `${used}%`, percent: used, kind: 'weekly_limit' }
  }
  // "Weekly limit: 98%" / "Weekly limit used: 98%" / "Weekly limit: <1%" — USED percent.
  const weekly = text.match(/Weekly\s*limit(?:\s*used)?:?\s*(<\s*)?(\d[\d.]*)\s*%/i)
  if (weekly) return asUsed(Boolean(weekly[1]), weekly[2], 'weekly_limit')
  // Status-line form: "<1% used" / "12% used" (legacy)
  const used = text.match(/(<\s*)?(\d[\d.]*)\s*%\s*used/i)
  if (used) return asUsed(Boolean(used[1]), used[2], 'subscription_credits')
  return null
}

function parseResetText(text: string): string | null {
  // "Resets: …" (legacy) or "Next reset: …" (weekly screen). Capture the
  // window, stopping before trailing fields on the same line.
  const match = text.match(
    /(?:Next\s*reset|Resets):?\s*(.+?)\s*(?:Pay\s*as\s*you\s*go|Credits?\s*used|Weekly\s*limit|·|\||\n|$)/i
  )
  if (!match) return null
  const value = match[1].trim()
  return value || null
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

function nthSundayOfMonth(year: number, month: number, nth: number): number {
  let seen = 0
  for (let day = 1; day <= 31; day += 1) {
    const date = new Date(Date.UTC(year, month, day))
    if (date.getUTCMonth() !== month) break
    if (date.getUTCDay() === 0) {
      seen += 1
      if (seen === nth) return day
    }
  }
  return 1
}

function pacificUtcOffsetHours(year: number, month: number, day: number): number {
  if (month < 2 || month > 10) return -8
  if (month > 2 && month < 10) return -7
  if (month === 2) return day >= nthSundayOfMonth(year, 2, 2) ? -7 : -8
  return day < nthSundayOfMonth(year, 10, 1) ? -7 : -8
}

function parseResetAt(text: string | null, refreshedAt: string): string | null {
  if (!text) return null
  const refreshed = new Date(refreshedAt)
  if (Number.isNaN(refreshed.getTime())) return null
  const match = text.match(/^([A-Za-z]+)\s*(\d{1,2}),?\s*(\d{1,2}):(\d{2})\s*(PT|PST|PDT)$/i)
  if (!match) return null
  const month = monthIndex(match[1])
  const day = Number(match[2])
  const hour = Number(match[3])
  const minute = Number(match[4])
  if (
    month === null ||
    !Number.isInteger(day) ||
    day < 1 ||
    day > 31 ||
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    return null
  }
  const timezone = match[5].toUpperCase()
  const year = refreshed.getUTCFullYear()
  const offsetHours =
    timezone === 'PDT' ? -7 : timezone === 'PST' ? -8 : pacificUtcOffsetHours(year, month, day)
  const makeDate = (targetYear: number) =>
    new Date(Date.UTC(targetYear, month, day, hour - offsetHours, minute))
  let parsed = makeDate(year)
  if (parsed.getTime() <= refreshed.getTime() - 60 * 60 * 1000) {
    parsed = makeDate(year + 1)
  }
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function parsePlanLabel(text: string): string | null {
  const sup = text.match(/((?:Free\s*credits\s*with\s*)?SuperGrok(?:\s*Heavy)?)/i)
  if (sup) return sup[1].replace(/\s+/g, ' ').trim()
  return null
}

function parsePayAsYouGo(text: string): boolean | null {
  const match = text.match(/Pay\s*as\s*you\s*go:?\s*(enabled|disabled|on|off)/i)
  if (!match) return null
  const value = match[1].toLowerCase()
  return value === 'enabled' || value === 'on'
}

/**
 * Parse the captured `/usage` text into a snapshot. `text` may be raw (with
 * ANSI) or pre-stripped; we strip defensively. Returns an 'unavailable'
 * snapshot when no credit signal is found.
 */
export function parseGrokUsage(
  rawText: string,
  refreshedAt: string = new Date().toISOString()
): GrokUsageSnapshot {
  const text = stripGrokAnsi(rawText || '')
  const credit = parsePercentDisplay(text)
  const resetAtText = parseResetText(text)
  const resetAt = parseResetAt(resetAtText, refreshedAt)
  const planLabel = parsePlanLabel(text)
  const payAsYouGoEnabled = parsePayAsYouGo(text)

  const usageKind = credit?.kind ?? 'subscription_credits'
  const base: GrokUsageSnapshot = {
    provider: 'grok',
    source: 'grok-cli-usage',
    usageKind,
    creditsUsedPercent: credit ? credit.percent : null,
    creditsUsedDisplay: credit ? credit.display : '',
    resetAtText,
    resetAt,
    limitWindowSeconds: resetAt
      ? usageKind === 'weekly_limit'
        ? GROK_WEEKLY_WINDOW_SECONDS
        : GROK_CREDIT_WINDOW_SECONDS
      : null,
    planLabel,
    payAsYouGoEnabled,
    refreshedAt,
    confidence: credit ? 'observed' : 'unavailable'
  }
  return base
}

// ── PTY probe (impure; injected terminal keeps it testable) ──────────────────

export interface GrokPtyLike {
  onData(listener: (data: string) => void): void
  onExit(listener: (event: { exitCode: number }) => void): void
  write(data: string): void
  kill(): void
}

export interface GrokUsageProbeDeps {
  /** Spawns `grok --no-auto-update --no-alt-screen` in a throwaway cwd. */
  spawnPty: () => GrokPtyLike
  /** Hard ceiling for the whole probe. */
  timeoutMs?: number
  /** ms to wait for the TUI before sending `/usage` (overridable for tests). */
  readyDelayMs?: number
  /** ms after `/usage` before pressing Enter to pick "Show Usage". */
  selectDelayMs?: number
  now?: () => string
  setTimer?: (cb: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/**
 * Capture `/usage` → "Show Usage" via PTY and parse it. Resolves as soon as a
 * credit signal is seen (early-out), or with an 'unavailable' snapshot on
 * timeout / clean-exit-without-data. Always kills the child. Never sends a
 * prompt.
 */
export function probeGrokUsage(deps: GrokUsageProbeDeps): Promise<GrokUsageSnapshot> {
  const timeoutMs = deps.timeoutMs ?? 12_000
  const readyDelayMs = deps.readyDelayMs ?? 2200
  const selectDelayMs = deps.selectDelayMs ?? 2000
  const now = deps.now ?? (() => new Date().toISOString())
  const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))

  return new Promise<GrokUsageSnapshot>((resolve) => {
    let settled = false
    let buffer = ''
    let partialFallbackArmed = false
    const timers: unknown[] = []
    let child: GrokPtyLike | null = null

    const finish = (snapshot: GrokUsageSnapshot): void => {
      if (settled) return
      settled = true
      for (const t of timers) clearTimer(t)
      try {
        child?.kill()
      } catch {
        // already gone
      }
      resolve(snapshot)
    }

    try {
      child = deps.spawnPty()
    } catch (error) {
      resolve(parseGrokUsage('', now()))
      void error
      return
    }

    child.onData((data) => {
      buffer += data
      // The grok TUI (≥0.2.77) BLOCKS at startup waiting for terminal-query
      // replies a real emulator would send. We are the terminal here, so
      // answer them or the /usage screen never renders and the probe times
      // out. DSR cursor-position → "row 1, col 1"; XTVERSION → an xterm id.
      if (!settled) {
        if (data.includes('\x1b[6n')) child?.write('\x1b[1;1R')
        if (data.includes('\x1b[>0q') || data.includes('\x1b[>q')) {
          child?.write('\x1bP>|xterm(370)\x1b\\')
        }
      }
      const stripped = stripGrokAnsi(buffer)
      // Early-out once the FULL usage screen has streamed in: a used-percent
      // line ("Credits used" / "Weekly limit:") or a reset window.
      if (
        /(?:Credits?\s*used|Weekly\s*limit(?:\s*used)?):?\s*<?\s*\d/i.test(stripped) ||
        /(?:Next\s*reset|Resets):?\s*[A-Za-z0-9]/i.test(stripped)
      ) {
        // Give one more beat for the remaining lines, then parse.
        timers.push(setTimer(() => finish(parseGrokUsage(buffer, now())), 250))
      } else if (!partialFallbackArmed && /Weekly\s*limit\s*left:?\s*<?\s*\d/i.test(stripped)) {
        // The welcome screen's status line ("Weekly limit left: 2%") shows up
        // BEFORE /usage is even sent. It is a usable reading but has no reset
        // window, so don't settle on it immediately — leave time for the
        // /usage screen (sent at readyDelay, selected at +selectDelay) to
        // render, then fall back to the status-line data.
        partialFallbackArmed = true
        timers.push(
          setTimer(
            () => finish(parseGrokUsage(buffer, now())),
            readyDelayMs + selectDelayMs + 1500
          )
        )
      }
    })

    child.onExit(() => finish(parseGrokUsage(buffer, now())))

    timers.push(setTimer(() => child?.write('/usage\r'), readyDelayMs))
    timers.push(setTimer(() => child?.write('\r'), readyDelayMs + selectDelayMs))
    timers.push(setTimer(() => finish(parseGrokUsage(buffer, now())), timeoutMs))
  })
}

export function estimateProjectedTokenUsage(
  promptText: string | undefined,
  responseText: string | undefined
): { input_tokens: number; output_tokens: number; total_tokens: number; total_cost_usd: number } {
  const estimate = (text: string | undefined): number =>
    Math.max(0, Math.ceil((text || '').length / 4))
  const input_tokens = estimate(promptText)
  const output_tokens = estimate(responseText)
  const total_cost_usd =
    (input_tokens / 1_000_000) * GROK_PROJECTED_INPUT_USD_PER_MILLION +
    (output_tokens / 1_000_000) * GROK_PROJECTED_OUTPUT_USD_PER_MILLION
  return { input_tokens, output_tokens, total_tokens: input_tokens + output_tokens, total_cost_usd }
}
