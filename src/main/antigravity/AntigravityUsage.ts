// Quota discovery for the user-installed official Antigravity CLI (`agy`).
//
// The documented quota view is the interactive `/usage` (alias `/quota`)
// panel, not a private HTTP API or a credentials file. This module therefore
// drives only that documented command in a temporary PTY after the caller has
// already confirmed both explicit consent and an authenticated S4 connection.
// It never sends a model prompt, reads a transcript/keyring, or enables a
// permission-bypass flag. Ambiguous output is deliberately reported as quota
// unavailable rather than guessed.

import type { NormalizedProviderUsageSnapshot, NormalizedProviderUsageWindow } from '../ProviderQuotaSnapshots'
import type { AppSettings } from '../store/types'
import { isAntigravityOptInEnabled } from '../../shared/retiredProviders'
import {
  createAgyCliEnv,
  resolveAgyCliBinary,
  type ResolvedAgyCliBinary
} from './AntigravityCli'

export const AGY_USAGE_TUI_ARGS = ['--sandbox', '--mode', 'plan'] as const
export const AGY_USAGE_COMMAND = '/usage\r'
export const AGY_USAGE_FRESH_TTL_MS = 5 * 60 * 1000

/** Minimum spacing between /usage PROBE ATTEMPTS (success or not). Applies to
 * the manual refresh button; the automatic meter heartbeat never probes at
 * all (see agyUsageProbeDecision). Keyed on attempts, not successes, so a
 * mashed button during a failing probe cannot retry-spam the lane. */
export const AGY_USAGE_MANUAL_MIN_INTERVAL_MS = 5 * 60 * 1000

/**
 * Decide what a quota request may do. The doctrine (2026-07-28): every
 * /usage probe is a real authenticated agy session, so cadence is the
 * fingerprint — only an explicit user action (`force`) may EVER spawn one,
 * and even that is clamped to one attempt per AGY_USAGE_MANUAL_MIN_INTERVAL_MS.
 * The 90-second meter heartbeat and any other automatic caller serves the
 * cache or reports unavailable; it must never reach the PTY. The clamp is
 * enforced here in main, so renderer button-mashing cannot route around it.
 */
export function agyUsageProbeDecision(input: {
  force: boolean
  nowMs: number
  cacheFetchedAtMs: number | null
  lastAttemptAtMs: number | null
}): 'serve-cache' | 'probe' | 'unavailable' {
  const hasCache = input.cacheFetchedAtMs !== null
  if (!input.force) {
    return hasCache ? 'serve-cache' : 'unavailable'
  }
  const cacheFresh =
    input.cacheFetchedAtMs !== null && input.nowMs - input.cacheFetchedAtMs < AGY_USAGE_FRESH_TTL_MS
  if (cacheFresh) return 'serve-cache'
  const attemptClamped =
    input.lastAttemptAtMs !== null &&
    input.nowMs - input.lastAttemptAtMs < AGY_USAGE_MANUAL_MIN_INTERVAL_MS
  if (attemptClamped) return hasCache ? 'serve-cache' : 'unavailable'
  return 'probe'
}

const MAX_CAPTURED_OUTPUT = 80_000
const MAX_QUOTA_GROUPS = 4
const MAX_LABEL_LENGTH = 120
const ANSI_CSI_RE = new RegExp(String.raw`\u001b\[[0-?]*[ -/]*[@-~]`, 'g')
const ANSI_OSC_RE = new RegExp(String.raw`\u001b\][^\u0007]*(?:\u0007|\u001b\\)`, 'g')
const CONTROL_CHARACTERS_RE = new RegExp(String.raw`[\u0000-\u0008\u000B-\u001F\u007F]`, 'g')

export interface AgyPtyLike {
  onData(listener: (data: string) => void): void
  onExit(listener: (event: { exitCode: number }) => void): void
  write(data: string): void
  kill(): void
}

export interface AgyUsageProbeDependencies {
  /** Only a user-installed official agy binary resolver is accepted. */
  resolveBinary?: () => Promise<ResolvedAgyCliBinary>
  /** The temporary PTY is injected so the parser/probe stays unit-testable. */
  spawnPty?: (
    command: string,
    args: readonly string[],
    options: { env: Record<string, string>; cwd: string }
  ) => AgyPtyLike
  /** A throwaway directory, never a user workspace. */
  cwd?: string
  inheritedEnv?: Readonly<Record<string, string | undefined>>
  timeoutMs?: number
  readyDelayMs?: number
  settleDelayMs?: number
  now?: () => string
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (timer: unknown) => void
}

interface AgyQuotaObservation {
  planType?: string
  windows: NormalizedProviderUsageWindow[]
}

function unavailableSnapshot(
  configured: boolean,
  fetchedAt: string,
  error?: string
): NormalizedProviderUsageSnapshot {
  return {
    provider: 'antigravity',
    source: 'agy-usage-tui',
    configured,
    fetchedAt,
    ...(error ? { error } : {})
  }
}

function quotaUnavailableError(reason: string): string {
  return `Quota unavailable: ${reason}`
}

/** Strip terminal styling without retaining any terminal/session state. */
export function stripAgyUsageTerminalControls(raw: string): string {
  return String(raw || '')
    .replace(ANSI_OSC_RE, '')
    .replace(ANSI_CSI_RE, '')
    .replace(/\r/g, '\n')
    .replace(CONTROL_CHARACTERS_RE, '')
}

function cleanPanelLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function boundedLabel(value: string): string | null {
  const cleaned = cleanPanelLine(value)
  return cleaned && cleaned.length <= MAX_LABEL_LENGTH ? cleaned : null
}

/** A pool header line — "GEMINI MODELS", "CLAUDE AND GPT MODELS". Used to
 * bound a group's region so a sibling pool's sub-limits never leak in. The
 * "Models within this group: …" description line is deliberately excluded. */
function isGroupHeaderLine(value: string): boolean {
  const normalized = cleanPanelLine(value).toLowerCase()
  if (!normalized || normalized.startsWith('models within')) return false
  return /^[a-z0-9 .+&/-]{1,40}\bmodels?$/.test(normalized)
}

/** Gemini pools ONLY. The Claude + GPT pool is deliberately not surfaced: the
 * resold first-party models were removed from the agy offer entirely
 * (AntigravityAgyStaticModels — metering a pool the app never dispatches to
 * would only advertise the extra-ToS-risk lane), so the region scan treats
 * the Claude header purely as the Gemini region's END. */
function isGeminiGroupHeader(value: string): boolean {
  return isGroupHeaderLine(value) && /\bgemini\b/.test(cleanPanelLine(value).toLowerCase())
}

/** Within a Gemini pool the panel prints two sub-limits, each with its own
 * bar and percentage: "Weekly Limit" and "Five Hour Limit". */
function subLimitKind(value: string): 'weekly' | 'five-hour' | null {
  const normalized = cleanPanelLine(value).toLowerCase()
  if (!/\blimit\b/.test(normalized)) return null
  if (/\bweekly\b/.test(normalized)) return 'weekly'
  if (/\bfive[\s-]*hour\b/.test(normalized) || /\b5[\s-]*hour\b/.test(normalized)) {
    return 'five-hour'
  }
  return null
}

function parseRemainingPercent(value: string): { value: number; display: string } | null {
  const match =
    value.match(/\b(?:remaining|left)\b\s*[:=]?\s*(\d{1,3}(?:\.\d+)?)\s*%/i) ||
    value.match(/\b(\d{1,3}(?:\.\d+)?)\s*%\s*(?:remaining|left)\b/i)
  if (!match) return null
  const parsed = Number(match[1])
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return null
  return { value: parsed, display: `${match[1]}% remaining` }
}

/** Resolve one sub-limit block's remaining percentage. Precedence: the
 * explicit "N% remaining" text (clearest semantics) > a "Quota available"
 * status (a full window, 100%) > the bare percentage rendered on the progress
 * bar itself (a full green bar is remaining, not used). Fails closed. */
function parseSubLimitRemaining(
  blockLines: readonly string[]
): { value: number; display: string } | null {
  for (const line of blockLines) {
    const explicit = parseRemainingPercent(line)
    if (explicit) return explicit
  }
  for (const line of blockLines) {
    const normalized = cleanPanelLine(line).toLowerCase()
    if (/\bquota\s+available\b/.test(normalized) || /^available$/.test(normalized)) {
      return { value: 100, display: '100% remaining' }
    }
    if (/\b(?:quota\s+)?(?:exhausted|used\s+up|depleted)\b/.test(normalized)) {
      return { value: 0, display: '0% remaining' }
    }
  }
  for (const line of blockLines) {
    const bar = cleanPanelLine(line).match(/(?:^|\s)(\d{1,3}(?:\.\d+)?)\s*%(?:\s|$)/)
    if (!bar) continue
    const parsed = Number(bar[1])
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 100) {
      return { value: parsed, display: `${bar[1]}% remaining` }
    }
  }
  return null
}

function parseObservedReset(value: string): string | null {
  const match = value.match(
    /\b(?:next\s+reset|resets?|refresh(?:es|ed)?(?:\s+at)?)\b\s*[:=]?\s*(.{1,120})$/i
  )
  return match ? boundedLabel(match[1]) : null
}

function parsePlanType(lines: readonly string[]): string | undefined {
  for (const line of lines.slice(0, 16)) {
    const named = line.match(/^\s*(?:plan|tier)\s*:\s*(Antigravity\b.{0,80})$/i)
    const bare = line.match(/^\s*(Antigravity\s+[A-Za-z0-9][A-Za-z0-9 ._-]{0,76})$/i)
    const value = boundedLabel(named?.[1] || bare?.[1] || '')
    if (value) return value
  }
  return undefined
}

/**
 * Parse a documented `/usage` panel conservatively. Verified against agy 1.1.8
 * (2026-07-28): the panel groups models into pools ("GEMINI MODELS",
 * "CLAUDE AND GPT MODELS"), and each pool carries TWO sub-limits with their own
 * progress bars — a "Weekly Limit" and a "Five Hour Limit". Only the Gemini
 * pool is surfaced; each of its sub-limits becomes one window (WK / 5H). The
 * observed percent and reset text are preserved verbatim; no schedule is
 * inferred and no quota is manufactured from an account tier.
 */
export function parseAgyUsagePanel(raw: string): AgyQuotaObservation {
  const lines = stripAgyUsageTerminalControls(raw)
    .split('\n')
    .map(cleanPanelLine)
    .filter(Boolean)
  const hasUsageHeading = lines
    .slice(0, 20)
    .some((line) => /\b(?:usage|quota)\b/i.test(line))
  if (!hasUsageHeading) return { windows: [] }

  const planType = parsePlanType(lines)

  // Bound the Gemini pool to its own region: from its header to the next pool
  // header (the Claude pool) or the panel end. Nothing outside that region is
  // read, so a Claude sub-limit can never be mislabelled as Gemini's.
  const geminiStart = lines.findIndex((line) => isGeminiGroupHeader(line))
  if (geminiStart === -1) return { planType, windows: [] }
  let geminiEnd = lines.length
  for (let index = geminiStart + 1; index < lines.length; index += 1) {
    if (isGroupHeaderLine(lines[index])) {
      geminiEnd = index
      break
    }
  }
  const region = lines.slice(geminiStart + 1, geminiEnd)

  const windows: NormalizedProviderUsageWindow[] = []
  const seenKinds = new Set<'weekly' | 'five-hour'>()
  for (let index = 0; index < region.length; index += 1) {
    const kind = subLimitKind(region[index])
    if (!kind || seenKinds.has(kind)) continue
    let blockEnd = region.length
    for (let next = index + 1; next < region.length; next += 1) {
      if (subLimitKind(region[next])) {
        blockEnd = next
        break
      }
    }
    const block = region.slice(index, blockEnd)
    const remaining = parseSubLimitRemaining(block)
    if (!remaining) continue
    seenKinds.add(kind)
    const reset = block.map(parseObservedReset).find((value): value is string => Boolean(value))
    windows.push({
      id: kind === 'weekly' ? 'agy-gemini-weekly' : 'agy-gemini-5h',
      label: kind === 'weekly' ? 'Gemini Weekly' : 'Gemini 5H',
      runs: 0,
      totalTokens: 0,
      limitLabel: [remaining.display, reset ? `refresh: ${reset}` : '']
        .filter(Boolean)
        .join(' · '),
      trackingOnly: false,
      usedPercent: Number((100 - remaining.value).toFixed(3)),
      remainingPercent: remaining.value,
      ...(reset && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(reset)
        ? { resetAt: reset }
        : {})
    })
    if (windows.length >= MAX_QUOTA_GROUPS) break
  }
  return { planType, windows }
}

function captureAgyUsagePanel(
  binary: ResolvedAgyCliBinary,
  deps: AgyUsageProbeDependencies
): Promise<{ output: string; timedOut: boolean; spawnError?: string }> {
  const timeoutMs = deps.timeoutMs ?? 12_000
  const readyDelayMs = deps.readyDelayMs ?? 1_500
  const settleDelayMs = deps.settleDelayMs ?? 300
  const setTimer = deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const clearTimer =
    deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))

  return new Promise((resolve) => {
    let settled = false
    let output = ''
    let child: AgyPtyLike | null = null
    const timers: unknown[] = []
    const finish = (result: { output: string; timedOut: boolean; spawnError?: string }): void => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimer(timer)
      try {
        child?.kill()
      } catch {
        // The terminal already exited.
      }
      resolve(result)
    }

    if (!binary.binaryPath) {
      finish({ output: '', timedOut: false, spawnError: binary.error || 'agy was not found.' })
      return
    }

    try {
      child = deps.spawnPty!(binary.binaryPath, AGY_USAGE_TUI_ARGS, {
        cwd: deps.cwd!,
        env: createAgyCliEnv(deps.inheritedEnv, {
          TERM: 'xterm-256color',
          NO_COLOR: '1',
          FORCE_COLOR: '0'
        })
      })
    } catch (error) {
      finish({
        output: '',
        timedOut: false,
        spawnError: error instanceof Error ? error.message : 'agy usage panel could not start.'
      })
      return
    }

    child.onData((chunk) => {
      output = `${output}${chunk}`
      if (output.length > MAX_CAPTURED_OUTPUT) output = output.slice(-MAX_CAPTURED_OUTPUT)
      if (parseAgyUsagePanel(output).windows.length > 0) {
        timers.push(setTimer(() => finish({ output, timedOut: false }), settleDelayMs))
      }
    })
    child.onExit(() => finish({ output, timedOut: false }))
    timers.push(setTimer(() => child?.write(AGY_USAGE_COMMAND), readyDelayMs))
    timers.push(setTimer(() => finish({ output, timedOut: true }), timeoutMs))
  })
}

/**
 * Discover quota only after S4 has confirmed the user-installed CLI is
 * authenticated and produced at least one official model. Every failed or
 * unsupported path resolves to a structured quota-unavailable snapshot.
 */
export async function fetchAuthenticatedAgyQuotaSnapshot(
  settings: Pick<AppSettings, 'antigravityEnabled' | 'antigravityOptInAcceptedAt'> | null | undefined,
  authenticatedConnection: boolean,
  deps: AgyUsageProbeDependencies
): Promise<NormalizedProviderUsageSnapshot> {
  const fetchedAt = (deps.now ?? (() => new Date().toISOString()))()
  if (!isAntigravityOptInEnabled(settings) || !authenticatedConnection) {
    return unavailableSnapshot(false, fetchedAt)
  }

  let binary: ResolvedAgyCliBinary
  try {
    binary = await (deps.resolveBinary ?? resolveAgyCliBinary)()
  } catch {
    return unavailableSnapshot(true, fetchedAt, quotaUnavailableError('official agy CLI could not be resolved.'))
  }
  if (!binary.binaryPath) {
    return unavailableSnapshot(
      true,
      fetchedAt,
      quotaUnavailableError(binary.error || 'official agy CLI is not installed.')
    )
  }
  if (!deps.spawnPty || !deps.cwd) {
    return unavailableSnapshot(
      true,
      fetchedAt,
      quotaUnavailableError('official agy /usage transport is unavailable.')
    )
  }

  const captured = await captureAgyUsagePanel(binary, deps)
  if (captured.spawnError) {
    return unavailableSnapshot(true, fetchedAt, quotaUnavailableError(captured.spawnError))
  }
  if (captured.timedOut) {
    return unavailableSnapshot(true, fetchedAt, quotaUnavailableError('official agy /usage timed out.'))
  }

  const observation = parseAgyUsagePanel(captured.output)
  if (observation.windows.length === 0) {
    return unavailableSnapshot(
      true,
      fetchedAt,
      quotaUnavailableError('official agy /usage returned no supported quota panel.')
    )
  }
  return {
    provider: 'antigravity',
    source: 'agy-usage-tui',
    configured: true,
    fetchedAt,
    windows: observation.windows,
    ...(observation.planType ? { planType: observation.planType } : {})
  }
}
