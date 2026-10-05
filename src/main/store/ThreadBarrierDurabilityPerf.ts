/**
 * The `threadBarrierDurability` section of main's perf snapshot: barrier
 * durability as this process runs it, for the harness to read at a measured
 * window's fences.
 *
 * - `enabled` and `ignored`: the switch as this process resolved it, and why
 *   it was set but not honoured.
 * - `debt`, `port`, `tickets`, `gates`, `starts`, `threads` and `staging`:
 *   the layer's own counters, each its module's whole snapshot. Null with the
 *   switch off, when none of them exists.
 * - `usageLog`: the usage log's appends written without a sync, the rounds
 *   that sync them, and its compactions off the event loop. Null with the
 *   switch off, when every append syncs where it is made.
 * - `runQueue`: the run queue's changes, the whole-file writes that follow
 *   them off the event loop and their syncs, and `userWaits`, the bounded
 *   waits of the changes a person made. Null with the switch off, when every
 *   change writes and syncs the file where it is made.
 * - `checkpoints`: the journal's checkpoints by what triggered them, counted
 *   whatever the switch, so the pair off against on compares like with like.
 * - `tornTailsRepaired`: torn journal tails cut before an append, each with
 *   its one synchronous sync.
 *
 * A read only: nothing here starts, settles or resets anything.
 */
import type { ChatDurabilityTicketsSnapshot } from './ChatDurabilityTickets'
import type { JournalCheckpointCounts } from './JournalCheckpointCounts'
import type { ThreadBarrierDurability } from './ThreadBarrierDurability'
import type { ThreadDurabilitySwitches } from './ThreadBarrierDurabilitySwitch'
import type { ThreadDebtTrackerSnapshot } from './ThreadDebtTracker'
import type { ThreadDurabilityDebtSnapshot } from './ThreadDurabilityDebt'
import type { ThreadDurabilityDebtFsSnapshot } from './ThreadDurabilityDebtFs'
import type { ToolActivityDetailStagingSnapshot } from './ToolActivityDetailStaging'
import type { RunQueueFile, RunQueueFileSnapshot } from './RunQueueFile'
import type { UsageJournalUnsyncedSnapshot } from './UsageJournalStore'
import type { DurableMomentGate, DurableMomentGateSnapshot } from '../run/DurableMomentGate'

export interface ThreadBarrierDurabilityPerfSection {
  /** The switch as this process resolved it. */
  enabled: boolean
  /** Why it was set but not honoured, else null. */
  ignored: string | null
  debt: ThreadDurabilityDebtSnapshot | null
  /** Null too when the layer's port was supplied from outside and keeps no counters. */
  port: ThreadDurabilityDebtFsSnapshot | null
  tickets: ChatDurabilityTicketsSnapshot | null
  gates: DurableMomentGateSnapshot | null
  /** The bounded barriers queued starts waited for before claiming their run row durable. */
  starts: DurableMomentGateSnapshot | null
  /** Threads that may still owe something, and the idle and quit barriers. */
  threads: ThreadDebtTrackerSnapshot | null
  /** Tool detail staged off the save path and synced at the port's background class. */
  staging: ToolActivityDetailStagingSnapshot | null
  /** The usage log: appends and spills written without a sync, its background rounds and compactions. */
  usageLog: UsageJournalUnsyncedSnapshot | null
  /** The run queue: its changes, writes and syncs, and the waits of a person's changes. */
  runQueue: (RunQueueFileSnapshot & { userWaits: DurableMomentGateSnapshot }) | null
  /** Counted with the switch off too. */
  checkpoints: JournalCheckpointCounts
  tornTailsRepaired: number
}

export interface ThreadBarrierDurabilityPerfSources {
  switches: Pick<ThreadDurabilitySwitches, 'barrierDurability' | 'barrierDurabilityIgnored'>
  /** Null with the switch off. */
  layer: Pick<ThreadBarrierDurability, 'snapshot'> | null
  /** Null with the switch off. */
  gate: Pick<DurableMomentGate, 'snapshot'> | null
  /** The gate a queued start's barrier is bounded by; null with the switch off. */
  startGate: Pick<DurableMomentGate, 'snapshot'> | null
  /** The usage log, whose counters are null with the switch off. */
  usage: { unsyncedSnapshot(): UsageJournalUnsyncedSnapshot | null }
  /** The run queue's file and the gate a person's change waits at; null with the switch off. */
  runQueue: {
    file: Pick<RunQueueFile, 'snapshot'>
    userGate: Pick<DurableMomentGate, 'snapshot'>
  } | null
  checkpoints: () => JournalCheckpointCounts
  /** The journal's count of torn tails it cut before an append. */
  tornTailsTruncated: () => number
}

export function readThreadBarrierDurabilityPerf(
  sources: ThreadBarrierDurabilityPerfSources
): ThreadBarrierDurabilityPerfSection {
  const layer = sources.layer?.snapshot() ?? null
  return {
    enabled: sources.switches.barrierDurability,
    ignored: sources.switches.barrierDurabilityIgnored,
    debt: layer?.debt ?? null,
    port: layer?.port ?? null,
    tickets: layer?.tickets ?? null,
    gates: sources.gate?.snapshot() ?? null,
    starts: sources.startGate?.snapshot() ?? null,
    threads: layer?.threads ?? null,
    staging: layer?.staging ?? null,
    usageLog: sources.usage.unsyncedSnapshot(),
    runQueue: sources.runQueue
      ? { ...sources.runQueue.file.snapshot(), userWaits: sources.runQueue.userGate.snapshot() }
      : null,
    checkpoints: sources.checkpoints(),
    tornTailsRepaired: sources.tornTailsTruncated()
  }
}
