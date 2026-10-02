import { parseRunEventLine } from '../RunEventStore'

export interface RunEventTailHead {
  sequence: number
  hash: string | null
}

/** Pure EOF decision, used at first open and again after any failed write.
 * Preserve every existing byte, including a valid record missing only its LF.
 * The caller must read the actual last byte after a partial/failed append.
 */
export function runEventLedgerAppendPrefix(lastByte: number | undefined): '' | '\n' {
  return lastByte === undefined || lastByte === 0x0a ? '' : '\n'
}

/** Fold a supplied tail window without retaining its records. A window cut
 * inside a line discards that fragment; a valid final record need not have LF.
 * Highest sequence owns the hash, even in shuffled or duplicated input.
 * Conflicting duplicates fail closed rather than guessing a chain identity.
 */
export function inspectRunEventLedgerTail(
  bytes: Uint8Array,
  atFileStart = true
): { head: RunEventTailHead | null; appendPrefix: '' | '\n' } {
  const lines = Buffer.from(bytes).toString('utf8').split(/\r?\n/)
  if (!atFileStart) lines.shift()
  let head: RunEventTailHead | null = null
  for (const line of lines) {
    const record = parseRunEventLine(line)
    if (!record || !Number.isSafeInteger(record.sequence) || record.sequence < 1) continue
    const hash = record.hash || null
    if (!head || record.sequence > head.sequence) {
      head = { sequence: record.sequence, hash }
    } else if (record.sequence === head.sequence && hash !== head.hash) {
      throw new Error('Conflicting run-event tail heads')
    }
  }
  return {
    head,
    appendPrefix: runEventLedgerAppendPrefix(bytes.length > 0 ? bytes[bytes.length - 1] : undefined)
  }
}
