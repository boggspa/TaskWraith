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
  /^(?:User Fan-Out|Locked writer fan-out|Automatic read stage|Scout fan-out|Worker fan-out|Review fan-out|Background fan-out|Ensemble fan-out|Parallel fan-out|Full fan-out) · \d+ participant\(s\) dispatched concurrently \((?:\d+ read \/ \d+ write-intent|host-clamped reader lanes|read-only seat lanes|read-clamped lanes)\)\.(?: .*)?$/,
  /^(?:User Fan-Out|Locked writer fan-out|Scout fan-out|Worker fan-out|Review fan-out|Background fan-out|Ensemble fan-out|Parallel fan-out|Full fan-out) complete · \d+ lane\(s\) returned(?: to the caller)?\.$/,
  /^Automatic read stage complete · returning to serial writer step\.$/,
  /^(?:Locked writer|Scout|Worker|Review|Background|Ensemble|Parallel|Full) fan-out: .+ requested \d+ (?:reader )?lane\(s\)(?: under their own permission postures)?\.(?: .*)?$/,
  /^Locked writer fan-out .+; continuing (?:with serial writers|serially)\.$/,
  /^(?:Boss|Captain) selection arrived after this pass's seats dispatched — queued to apply once when the next Continuous pass forms\.$/,
  /^Yield target "[^"]+" was not routed: .+\.$/
]

/**
 * Routine Ensemble receipts whose effect is already visible in the participant
 * order or fan-out viewport. They may remain persisted for agent context; this
 * predicate keeps them out of transcript presentation, including older rows.
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
