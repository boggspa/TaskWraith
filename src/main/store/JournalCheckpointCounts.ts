/**
 * The journal's checkpoints counted by what triggered each one, with the bytes
 * written and the time the calling thread spent writing them: the baseline
 * for moving checkpoints off the main thread. Counting changes nothing about
 * when or how a checkpoint is written, and runs whatever switch is on.
 *
 * The journal is wrapped, not changed. Each call that can write a checkpoint
 * is timed, and the journal's own counters, read before and after it, say how
 * many checkpoints it wrote and how many bytes they took:
 * - `initialize`: `initial`, the first checkpoint of a thread;
 * - `checkpoint`: the reason its caller gives (`terminal` from the save);
 * - `append`: `bounded`, the compaction an append forces past the journal's bounds;
 * - `replaceAuthoritativeCheckpoint`: `recovery`, the re-anchor;
 * - `checkpointIdle`: `idle`, and `checkpointAll`: its reason, `shutdown` by default.
 * The time of an append that compacts includes its own line, which is small
 * beside the record it writes. A call made inside another counted call is
 * left to the outer one.
 *
 * Checkpoints the journal wrote outside these calls (one prepared off the
 * thread and installed later) appear under `other`, untimed.
 */
import type {
  IncrementalChatCheckpointReason,
  IncrementalChatJournal
} from './IncrementalChatJournal'

export type JournalCheckpointTrigger = IncrementalChatCheckpointReason | 'other'

export const JOURNAL_CHECKPOINT_TRIGGERS: readonly JournalCheckpointTrigger[] = [
  'initial',
  'terminal',
  'idle',
  'bounded',
  'shutdown',
  'manual',
  'recovery',
  'other'
]

export interface JournalCheckpointTriggerCounts {
  count: number
  bytes: number
  /** Milliseconds the calling thread spent in the calls that wrote them. */
  mainMs: number
}

export type JournalCheckpointCounts = Record<
  JournalCheckpointTrigger,
  JournalCheckpointTriggerCounts
>

export interface CountedJournal {
  /** The journal, with its checkpoints counted. */
  readonly journal: IncrementalChatJournal
  snapshot(): JournalCheckpointCounts
}

type Counted = Exclude<JournalCheckpointTrigger, 'other'>

const TRIGGER_OF: Partial<Record<keyof IncrementalChatJournal, (args: unknown[]) => Counted>> = {
  initialize: () => 'initial',
  checkpoint: (args) => args[1] as Counted,
  append: () => 'bounded',
  replaceAuthoritativeCheckpoint: () => 'recovery',
  checkpointIdle: () => 'idle',
  checkpointAll: (args) => (args[0] as Counted | undefined) ?? 'shutdown'
}

function zero(): JournalCheckpointTriggerCounts {
  return { count: 0, bytes: 0, mainMs: 0 }
}

export function countJournalCheckpoints(
  journal: IncrementalChatJournal,
  now: () => number = () => performance.now()
): CountedJournal {
  const counts = Object.fromEntries(
    JOURNAL_CHECKPOINT_TRIGGERS.filter((trigger) => trigger !== 'other').map((trigger) => [
      trigger,
      zero()
    ])
  ) as Partial<JournalCheckpointCounts>
  const baseline = journal.stats()
  let depth = 0
  const wrapped = new Map<PropertyKey, unknown>()
  const counted = new Proxy(journal, {
    get(target, key, receiver) {
      const member = Reflect.get(target, key, receiver)
      const triggerOf = TRIGGER_OF[key as keyof IncrementalChatJournal]
      if (typeof member !== 'function' || !triggerOf) return member
      let call = wrapped.get(key)
      if (!call) {
        call = (...args: unknown[]) => {
          if (depth > 0) return member.apply(target, args)
          const before = target.stats()
          const startedAt = now()
          depth += 1
          try {
            return member.apply(target, args)
          } finally {
            depth -= 1
            const after = target.stats()
            const written = after.checkpointsWritten - before.checkpointsWritten
            // A reason this does not know is left to \`other\`.
            const entry = written > 0 ? counts[triggerOf(args)] : undefined
            if (entry) {
              entry.count += written
              entry.bytes += after.checkpointBytesWritten - before.checkpointBytesWritten
              entry.mainMs += now() - startedAt
            }
          }
        }
        wrapped.set(key, call)
      }
      return call
    }
  })
  return {
    journal: counted,
    snapshot() {
      const stats = journal.stats()
      const result = {} as JournalCheckpointCounts
      let seen = 0
      let seenBytes = 0
      for (const trigger of JOURNAL_CHECKPOINT_TRIGGERS) {
        if (trigger === 'other') continue
        const entry = counts[trigger]!
        result[trigger] = { ...entry }
        seen += entry.count
        seenBytes += entry.bytes
      }
      result.other = {
        count: stats.checkpointsWritten - baseline.checkpointsWritten - seen,
        bytes: stats.checkpointBytesWritten - baseline.checkpointBytesWritten - seenBytes,
        mainMs: 0
      }
      return result
    }
  }
}
