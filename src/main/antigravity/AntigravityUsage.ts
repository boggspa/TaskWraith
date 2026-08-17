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

/** Minimum spacing between manual `/usage` probe attempts. Autonomous reads
 * use the rotating cadence owned by AntigravityQuotaClient. */
export const AGY_USAGE_MANUAL_MIN_INTERVAL_MS = 5 * 60 * 1000

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
  /**
   * Permit Enter on agy's exact trust prompt only when `cwd` was freshly
   * created by TaskWraith for this probe. Never enable this for a workspace or
   * a broad temporary root.
   */
  confirmAppOwnedCwdTrust?: boolean
  inheritedEnv?: Readonly<Record<string, string | undefined>>
  timeoutMs?: number
  readyDelayMs?: number
  trustReadyDelayMs?: number
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

/**
 * A quota-unavailable snapshot for a lane that IS set up but has no data to
 * show yet, carrying the reason.
 *
 * `configured: true` is what makes it visible: the renderer admits a quota
 * entry only when it has windows OR (`quotaConfigured === true` and a
 * `quotaError`), and `ModelUsageCard` then renders the reason in place of the
 * window rows. A `configured: false` snapshot with no error — which is what
 * both the gate-refused and awaiting-manual-refresh paths used to return — is
 * therefore indistinguishable from "this lane does not exist", and was why a
 * manual ↻ that never probed, a clamped retry, and a genuinely absent
 * connection all rendered as the same nothing.
 */
export function agyQuotaUnavailableSnapshot(
  reason: string,
  now: () => string = () => new Date().toISOString()
): NormalizedProviderUsageSnapshot {
  return unavailableSnapshot(true, now(), quotaUnavailableError(reason))
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

type AntigravityUsagePoolType = 'gemini' | 'thirdParty'

type AgyUsagePoolWindows = {
  weekly: { id: string; label: string }
  fiveHour: { id: string; label: string }
}

const AGY_USAGE_POOL_WINDOWS: Record<AntigravityUsagePoolType, AgyUsagePoolWindows> = {
  gemini: {
    weekly: { id: 'agy-gemini-weekly', label: 'Gemini Weekly' },
    fiveHour: { id: 'agy-gemini-5h', label: 'Gemini 5H' }
  },
  thirdParty: {
    weekly: { id: 'agy-3p-weekly', label: '3P Weekly' },
    fiveHour: { id: 'agy-3p-5h', label: '3P 5H' }
  }
}

function agyUsagePoolType(value: string): AntigravityUsagePoolType | null {
  const normalized = cleanPanelLine(value).toLowerCase()
  if (!isGroupHeaderLine(normalized)) return null
  if (/\bgemini\b/.test(normalized)) return 'gemini'
  if (/\bclaude\b/.test(normalized) && /\bgpt\b/.test(normalized)) return 'thirdParty'
  return null
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

function parseAgyUsagePoolWindows(
  poolType: AntigravityUsagePoolType,
  region: readonly string[],
  windows: NormalizedProviderUsageWindow[]
): void {
  const config = AGY_USAGE_POOL_WINDOWS[poolType]
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
    const mapping = kind === 'weekly' ? config.weekly : config.fiveHour
    windows.push({
      id: mapping.id,
      label: mapping.label,
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
    if (windows.length >= MAX_QUOTA_GROUPS) return
  }
}

/**
 * Parse a documented `/usage` panel conservatively. Verified against agy 1.1.8
 * (2026-07-28): the panel groups models into pools ("GEMINI MODELS",
 * "CLAUDE AND GPT MODELS"), and each pool carries TWO sub-limits with their own
 * progress bars — a "Weekly Limit" and a "Five Hour Limit".
 *
 * As of the August 2026 UI update, both pools are surfaced:
 * - Gemini pool windows: "agy-gemini-weekly" and "agy-gemini-5h"
 * - Claude+GPT pool windows: "agy-3p-weekly" and "agy-3p-5h"
 *
 * The observed percent and reset text are preserved verbatim; no schedule is
 * inferred and no quota is manufactured from an account tier.
 */
export function parseAgyUsagePanel(raw: string): AgyQuotaObservation {
  const lines = stripAgyUsageTerminalControls(raw)
    .split('\n')
    .map(cleanPanelLine)
    .filter(Boolean)
  // PTY output is an accumulated redraw stream, not just the final screen.
  // agy 1.1.13 can render more than twenty startup/trust lines before the
  // quota panel, so the old prefix-only check discarded a complete panel.
  // The buffer is already bounded, and the Gemini pool + sub-limit checks
  // below remain the authoritative structure guard.
  const hasUsageHeading = lines.some((line) => /\b(?:usage|quota)\b/i.test(line))
  if (!hasUsageHeading) return { windows: [] }

  const planType = parsePlanType(lines)

  // Bound each recognized pool to its own region (to its own header boundary) so
  // a Claude+GPT line is never mislabelled as Gemini, and vice versa.
  const headers = lines
    .map((line, index) => ({ line, index }))
    .filter((entry) => agyUsagePoolType(entry.line) !== null)
  if (headers.length === 0) return { planType, windows: [] }

  for (let headerIndex = 0; headerIndex < headers.length; headerIndex += 1) {
    if (windows.length >= MAX_QUOTA_GROUPS) break
    const currentHeader = headers[headerIndex]
    const currentPool = agyUsagePoolType(currentHeader.line)
    if (!currentPool) continue
    let nextHeaderIndex = lines.length
    const nextHeader = headers[headerIndex + 1]
    if (nextHeader) {
      nextHeaderIndex = nextHeader.index
    }
    const region = lines.slice(currentHeader.index + 1, nextHeaderIndex)
    parseAgyUsagePoolWindows(currentPool, region, windows)
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
  const trustReadyDelayMs = deps.trustReadyDelayMs ?? 4_000
  const settleDelayMs = deps.settleDelayMs ?? 300
  const setTimer = deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const clearTimer =
    deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))

  return new Promise((resolve) => {
    let settled = false
    let output = ''
    let child: AgyPtyLike | null = null
    let trustPromptConfirmed = false
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
      const cleanedOutput = stripAgyUsageTerminalControls(output)
      if (
        deps.confirmAppOwnedCwdTrust === true &&
        !trustPromptConfirmed &&
        cleanedOutput.includes('Do you trust the contents of this project?') &&
        /^\s*>\s*Yes, I trust this folder\s*$/m.test(cleanedOutput)
      ) {
        trustPromptConfirmed = true
        child?.write('\r')
        timers.push(
          setTimer(() => {
            if (!settled) child?.write(AGY_USAGE_COMMAND)
          }, trustReadyDelayMs)
        )
      }
      if (parseAgyUsagePanel(output).windows.length > 0) {
        timers.push(setTimer(() => finish({ output, timedOut: false }), settleDelayMs))
      }
    })
    child.onExit(() => finish({ output, timedOut: false }))
    timers.push(
      setTimer(() => {
        if (!settled && !trustPromptConfirmed) child?.write(AGY_USAGE_COMMAND)
      }, readyDelayMs)
    )
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
  // No recorded opt-in means the ban-risk lane is not set up at all, so it stays
  // invisible: configured false, no reason to report.
  if (!isAntigravityOptInEnabled(settings)) {
    return unavailableSnapshot(false, fetchedAt)
  }
  // Opted in but no authenticated agy connection was detected. That IS a
  // reportable state — previously it collapsed into the same silent
  // configured-false snapshot as "not opted in", so a user who had consented
  // and installed the CLI could not tell an unauthenticated CLI apart from a
  // lane that simply wasn't there.
  if (!authenticatedConnection) {
    return unavailableSnapshot(
      true,
      fetchedAt,
      quotaUnavailableError(
        'no authenticated agy connection was detected. Sign in with the official CLI, then refresh.'
      )
    )
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
