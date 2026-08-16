import type { ChatMessage, EnsembleRoundSummaryRecord, ProviderId } from './store/types'

const SUMMARY_LABELS = [
  'Round summary:',
  'Decisions:',
  'Corrections:',
  'Open risks:',
  'Next action:'
] as const

const MAX_SUMMARY_CHARS = 2000

export function extractRoundSummaryBlock(content: string): string | null {
  if (!content || typeof content !== 'string') return null
  const normalized = content.replace(/\r\n/g, '\n').trim()
  if (!normalized) return null
  const matches = Array.from(normalized.matchAll(/(?:^|\n)\s*(?:#{1,6}\s*)?Round summary\s*:/gi))
  if (matches.length === 0) return null
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const match = matches[i]
    const start = match.index === undefined ? 0 : match.index + (match[0].startsWith('\n') ? 1 : 0)
    const candidate = normalized.slice(start).trim()
    if (hasRequiredLabels(candidate)) {
      return candidate.slice(0, MAX_SUMMARY_CHARS).trim()
    }
  }
  return null
}

export function findTerminalSynthesizerRoundSummary(input: {
  messages: ChatMessage[]
  roundId: string
  synthesizerParticipantId?: string
  capturedAt: string
}): EnsembleRoundSummaryRecord | null {
  const synthesizerParticipantId = input.synthesizerParticipantId?.trim()
  if (!synthesizerParticipantId) return null
  const roundMessages = input.messages.filter((message) => {
    const metadata = message.metadata as Record<string, unknown> | undefined
    return metadata?.ensembleRoundId === input.roundId
  })
  // Host status rows may legitimately land between the chair's close-out and
  // the terminal fold (for example a Continuous hop-limit receipt). They do
  // not supersede participant evidence. A later assistant or tool row does.
  const terminal = [...roundMessages]
    .reverse()
    .find((message) => message.role === 'assistant' || message.role === 'tool')
  if (!terminal || terminal.role !== 'assistant') return null
  const metadata = terminal.metadata as Record<string, unknown> | undefined
  if (metadata?.ensembleParticipantId !== synthesizerParticipantId) return null
  const summary = extractRoundSummaryBlock(terminal.content)
  if (!summary) return null
  const provider =
    typeof metadata?.ensembleProvider === 'string'
      ? (metadata.ensembleProvider as ProviderId)
      : 'codex'
  const role = typeof metadata?.ensembleRole === 'string' ? metadata.ensembleRole : undefined
  return {
    roundId: input.roundId,
    participantId: synthesizerParticipantId,
    provider,
    ...(role ? { role } : {}),
    ...(terminal.runId ? { runId: terminal.runId } : {}),
    summary,
    capturedAt: input.capturedAt
  }
}

function hasRequiredLabels(content: string): boolean {
  const lower = content.toLowerCase()
  return SUMMARY_LABELS.every((label) => lower.includes(label.toLowerCase()))
}
