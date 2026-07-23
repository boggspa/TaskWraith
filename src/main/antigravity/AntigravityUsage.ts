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

function isSupportedQuotaGroup(value: string): boolean {
  const normalized = cleanPanelLine(value).toLowerCase()
  return [
    'gemini',
    'gemini model',
    'gemini models',
    'claude + gpt',
    'claude + gpt model',
    'claude + gpt models',
    'claude & gpt',
    'claude & gpt model',
    'claude & gpt models',
    'claude and gpt',
    'claude and gpt model',
    'claude and gpt models'
  ].includes(normalized)
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

function quotaGroupId(label: string, index: number): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72)
  return `agy-${slug || `group-${index + 1}`}`
}

/**
 * Parse a documented `/usage` panel conservatively. The exact observed group,
 * percent, tier, and reset text are preserved; we do not infer a schedule or
 * manufacture a quota from an account tier.
 */
export function parseAgyUsagePanel(raw: string): AgyQuotaObservation {
  const lines = stripAgyUsageTerminalControls(raw)
    .split('\n')
    .map(cleanPanelLine)
    .filter(Boolean)
  const hasUsageHeading = lines.slice(0, 20).some((line) => /\b(?:usage|quota)\b/i.test(line))
  if (!hasUsageHeading) return { windows: [] }

  const windows: NormalizedProviderUsageWindow[] = []
  const seen = new Set<string>()
  for (let index = 0; index < lines.length && windows.length < MAX_QUOTA_GROUPS; index += 1) {
    const label = boundedLabel(lines[index])
    if (!label || !isSupportedQuotaGroup(label)) continue

    const nearby = lines.slice(index, Math.min(lines.length, index + 5))
    const remainingLine = nearby.find((line) => parseRemainingPercent(line))
    const remaining = remainingLine ? parseRemainingPercent(remainingLine) : null
    if (!remaining) continue

    const id = quotaGroupId(label, windows.length)
    if (seen.has(id)) continue
    seen.add(id)
    const reset = nearby.map(parseObservedReset).find((value): value is string => Boolean(value))
    windows.push({
      id,
      label,
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
  }
  return { planType: parsePlanType(lines), windows }
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
