export const CLOSEOUT_RECEIPT_VERSION = 1 as const

export const CLOSEOUT_VALIDATION_KINDS = [
  'tests',
  'typecheck',
  'lint',
  'build',
  'diagnostics'
] as const

export type CloseoutValidationKind = (typeof CLOSEOUT_VALIDATION_KINDS)[number]

export type CloseoutReceiptParticipantOutcome = {
  status: string
  count: number
}

export type CloseoutReceipt = {
  version: typeof CLOSEOUT_RECEIPT_VERSION
  targetId: string
  scope: 'run' | 'ensembleRound'
  status: string
  durationMs?: number
  totalTokens?: number
  observedCommitCount: number
  observedChangedFileCount: number
  participants?: {
    total: number
    outcomes: CloseoutReceiptParticipantOutcome[]
  }
  validations?: {
    passed: CloseoutValidationKind[]
    failed: CloseoutValidationKind[]
  }
}

export type CloseoutReceiptInput = {
  targetId: string
  scope: CloseoutReceipt['scope']
  status?: string
  durationMs?: number
  totalTokens?: number
  commits?: ReadonlyArray<{ hash?: string }>
  fileChanges?: ReadonlyArray<{ path?: string }>
  /** Full valid-path count when the persisted row list was intentionally capped. */
  changedFileCount?: number
  participants?: ReadonlyArray<{ status?: string }>
  validations?: {
    passed?: readonly CloseoutValidationKind[]
    failed?: readonly CloseoutValidationKind[]
  }
}

function boundedWholeNumber(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return Math.round(value)
}

function uniqueNonEmptyCount(values: ReadonlyArray<string | undefined>): number {
  return new Set(
    values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))
  ).size
}

function validationKinds(
  values: readonly CloseoutValidationKind[] | undefined
): CloseoutValidationKind[] {
  const requested = new Set(values || [])
  return CLOSEOUT_VALIDATION_KINDS.filter((kind) => requested.has(kind))
}

/** Build the app-owned receipt before any qualitative close-out prose is selected. */
export function buildCloseoutReceipt(input: CloseoutReceiptInput): CloseoutReceipt {
  const participantOutcomes = new Map<string, number>()
  for (const participant of input.participants || []) {
    const status = participant.status
      ?.trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .slice(0, 40)
    if (!status) continue
    participantOutcomes.set(status, (participantOutcomes.get(status) || 0) + 1)
  }
  const failed = validationKinds(input.validations?.failed)
  const failedSet = new Set(failed)
  const passed = validationKinds(input.validations?.passed).filter((kind) => !failedSet.has(kind))
  const durationMs = boundedWholeNumber(input.durationMs)
  const totalTokens = boundedWholeNumber(input.totalTokens)

  const observedChangedFileCount = Math.max(
    uniqueNonEmptyCount((input.fileChanges || []).map((change) => change.path)),
    boundedWholeNumber(input.changedFileCount) || 0
  )

  return {
    version: CLOSEOUT_RECEIPT_VERSION,
    targetId: input.targetId.trim(),
    scope: input.scope,
    status: input.status?.trim() || 'unknown',
    ...(durationMs !== undefined && durationMs > 0 ? { durationMs } : {}),
    ...(totalTokens !== undefined && totalTokens > 0 ? { totalTokens } : {}),
    observedCommitCount: uniqueNonEmptyCount((input.commits || []).map((commit) => commit.hash)),
    observedChangedFileCount,
    ...((input.participants?.length || 0) > 0
      ? {
          participants: {
            total: input.participants!.length,
            outcomes: Array.from(participantOutcomes, ([status, count]) => ({
              status,
              count
            })).sort((left, right) => left.status.localeCompare(right.status))
          }
        }
      : {}),
    ...(passed.length > 0 || failed.length > 0 ? { validations: { passed, failed } } : {})
  }
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

function naturalList(items: string[]): string {
  if (items.length <= 1) return items[0] || ''
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`
}

/** Render only quantities computed by the app; provider prose never supplies these numerals. */
export function closeoutReceiptSentence(receipt: CloseoutReceipt): string | null {
  const facts: string[] = []
  if (receipt.participants && receipt.participants.total > 0) {
    const outcomes = receipt.participants.outcomes.map(
      ({ status, count }) => `${count} ${status.replace(/_/g, ' ')}`
    )
    facts.push(
      `${plural(receipt.participants.total, 'participant')}${
        outcomes.length > 0 ? ` (${naturalList(outcomes)})` : ''
      }`
    )
  }
  if (receipt.observedCommitCount > 0) {
    facts.push(plural(receipt.observedCommitCount, 'commit'))
  }
  if (receipt.observedChangedFileCount > 0) {
    facts.push(plural(receipt.observedChangedFileCount, 'changed file'))
  }
  return facts.length > 0 ? `Receipt recorded ${naturalList(facts)}.` : null
}

const AUTHORED_NUMBER_WORD =
  /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/i

/** True when model/participant prose carries a numeral that belongs in the receipt. */
export function closeoutNarrativeHasAuthoredNumeral(value: string): boolean {
  return /\p{N}/u.test(value) || AUTHORED_NUMBER_WORD.test(value)
}

/** Preserve stronger tombstoned evidence when compacted telemetry yields a thinner rebuild. */
export function mergeCloseoutReceipts(
  previous: CloseoutReceipt | undefined,
  next: CloseoutReceipt
): CloseoutReceipt {
  if (!previous || previous.targetId !== next.targetId || previous.scope !== next.scope) return next
  const participants =
    (next.participants?.total || 0) >= (previous.participants?.total || 0)
      ? next.participants
      : previous.participants
  const passed: CloseoutValidationKind[] = []
  const failed: CloseoutValidationKind[] = []
  for (const kind of CLOSEOUT_VALIDATION_KINDS) {
    if (next.validations?.failed.includes(kind)) failed.push(kind)
    else if (next.validations?.passed.includes(kind)) passed.push(kind)
    else if (previous.validations?.failed.includes(kind)) failed.push(kind)
    else if (previous.validations?.passed.includes(kind)) passed.push(kind)
  }
  return {
    ...next,
    ...((next.durationMs || 0) >= (previous.durationMs || 0)
      ? {}
      : { durationMs: previous.durationMs }),
    ...((next.totalTokens || 0) >= (previous.totalTokens || 0)
      ? {}
      : { totalTokens: previous.totalTokens }),
    observedCommitCount: Math.max(previous.observedCommitCount, next.observedCommitCount),
    observedChangedFileCount: Math.max(
      previous.observedChangedFileCount,
      next.observedChangedFileCount
    ),
    ...(participants ? { participants } : {}),
    ...(passed.length > 0 || failed.length > 0 ? { validations: { passed, failed } } : {})
  }
}
