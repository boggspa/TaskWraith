interface EnsembleTranscriptNoticeLike {
  role?: unknown
  content?: unknown
  metadata?: { kind?: unknown } | null
}

const MAX_NOTICE_LENGTH = 512

const ROUTINE_SUCCESS_NOTICES = [
  /^Routed next: .+\.$/,
  /^@-mention: .+ is (?:Boss|active Captain) and takes routing priority over advisory participant mentions\.$/,
  /^@-mention: .+ promoted to speak next\.$/,
  /^User Fan-Out complete · \d+ lane\(s\) returned\.$/
]

/**
 * Historical, routine Ensemble receipts whose effect is already visible in
 * the participant order or fan-out viewport. New producers avoid writing
 * these rows; this predicate keeps older persisted transcripts equally quiet.
 */
export function isRedundantEnsembleTranscriptNotice(
  message: EnsembleTranscriptNoticeLike
): boolean {
  if (message.role !== 'system' || message.metadata?.kind !== 'ensembleRoundStatus') return false
  if (typeof message.content !== 'string') return false
  const content = message.content.trim()
  if (!content || content.length > MAX_NOTICE_LENGTH || content.includes('\n')) return false
  return ROUTINE_SUCCESS_NOTICES.some((pattern) => pattern.test(content))
}
