import type { ProviderId, RunWarning } from '../../../main/store/types'
import { isContextOverflowErrorText } from '../../../shared/contextCompaction'
import { getProviderLabel } from './providerLabels'
import type { RawLogEntry } from './rawLogEntry'

export interface ProviderRunFailureLine {
  timestamp?: string
  text: string
}

export interface ProviderRunFailureSnippet {
  failureAt: string
  exitCode: number
  provider: ProviderId
  headline: string
  copyText: string
  lines: ProviderRunFailureLine[]
  /** Actionable next step when the failure is recognizable (e.g. a context-
   * window overflow names the /compact escape hatch). Rendered as a distinct
   * footer row on the failure card, outside the stderr body. */
  hint?: string
}

export interface BuildProviderRunFailureSnippetInput {
  provider: ProviderId
  exitCode: number
  failureAt: string
  payloadError?: string
  warnings?: RunWarning[]
  stderrLogs?: RawLogEntry[]
  ensembleRole?: string
  maxLines?: number
}

const DEFAULT_MAX_LINES = 6
const MAX_LINE_CHARS = 600

const normalizeLine = (value: string): string =>
  value.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim().slice(0, MAX_LINE_CHARS)

export const formatProviderRunFailureTimestamp = (iso: string): string => {
  const parsed = new Date(iso)
  if (!Number.isFinite(parsed.getTime())) return iso
  return parsed.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

const uniqueLines = (lines: ProviderRunFailureLine[]): ProviderRunFailureLine[] => {
  const seen = new Set<string>()
  const next: ProviderRunFailureLine[] = []
  for (const line of lines) {
    const text = normalizeLine(line.text)
    if (!text || seen.has(text)) continue
    seen.add(text)
    next.push({ ...line, text })
  }
  return next
}

export const buildProviderRunFailureSnippet = (
  input: BuildProviderRunFailureSnippetInput
): ProviderRunFailureSnippet => {
  const {
    provider,
    exitCode,
    failureAt,
    payloadError,
    warnings = [],
    stderrLogs = [],
    ensembleRole,
    maxLines = DEFAULT_MAX_LINES
  } = input
  const providerLabel = getProviderLabel(provider)
  const speakerLabel = ensembleRole ? `${providerLabel} / ${ensembleRole}` : providerLabel

  if (exitCode === 130) {
    const copyText = `[${formatProviderRunFailureTimestamp(failureAt)}] ${speakerLabel} run cancelled (exit 130)`
    return {
      failureAt,
      exitCode,
      provider,
      headline: `${speakerLabel} cancelled`,
      copyText,
      lines: [{ text: 'Run cancelled (SIGINT / user stop).' }]
    }
  }

  const collected: ProviderRunFailureLine[] = []

  for (const warning of warnings.slice(-4)) {
    const text = normalizeLine(warning.message)
    if (text) collected.push({ timestamp: warning.timestamp, text })
  }

  for (const log of stderrLogs.filter((entry) => entry.type === 'stderr').slice(-maxLines)) {
    const text = normalizeLine(log.content)
    if (text) collected.push({ timestamp: log.timestamp, text })
  }

  const payloadLine = payloadError ? normalizeLine(payloadError) : ''
  if (payloadLine) collected.push({ text: payloadLine })

  const lines = uniqueLines(collected).slice(-maxLines)
  if (lines.length === 0) {
    lines.push({ text: `Provider exited with code ${exitCode}.` })
  }

  // Name the context wall. Scan the PRE-slice pool too: the overflow line can
  // be pushed out of the visible tail by later shutdown noise.
  const hitContextWall =
    lines.some((line) => isContextOverflowErrorText(line.text)) ||
    collected.some((line) => isContextOverflowErrorText(line.text))
  const hint = hitContextWall
    ? 'Context window exhausted — run /compact to shrink this session, or start a fresh thread.'
    : undefined

  const copyText = [
    `[${formatProviderRunFailureTimestamp(failureAt)}] ${speakerLabel} run failed (exit ${exitCode})`,
    '---',
    ...lines.map((line) =>
      line.timestamp
        ? `[${formatProviderRunFailureTimestamp(line.timestamp)}] ${line.text}`
        : line.text
    ),
    ...(hint ? [hint] : [])
  ].join('\n')

  return {
    failureAt,
    exitCode,
    provider,
    headline: `${speakerLabel} failed · exit ${exitCode}`,
    copyText,
    lines,
    ...(hint ? { hint } : {})
  }
}
