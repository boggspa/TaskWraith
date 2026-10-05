/**
 * Barrier durability, put together for one app process: a record of what
 * every thread owes the disk, the port that pays it off the event loop, and
 * the tickets that the moments reporting "done" take on it.
 *
 * The store builds one only while its switch is on, and hands the thread
 * stores the debt's `note`. The journal, the run-event ledger and a save's
 * tool-detail writer then write without a sync and say what they owe; a
 * barrier raised for a thread pays it. Building one starts no timer, opens no
 * file and syncs nothing, and nothing here can sync on the calling thread.
 */
import { ChatDurabilityTickets, type ChatDurabilityTicketsSnapshot } from './ChatDurabilityTickets'
import {
  createThreadDurabilityDebt,
  type NoteThreadDurabilityDebt,
  type ThreadDurabilityDebt,
  type ThreadDurabilityDebtSnapshot,
  type ThreadDurabilityPort
} from './ThreadDurabilityDebt'
import {
  createThreadDurabilityDebtFs,
  type ThreadDurabilityDebtFsSnapshot
} from './ThreadDurabilityDebtFs'
import type { ToolActivityDetailDebt } from './ToolActivityDetailLedger'

export interface ThreadBarrierDurabilitySnapshot {
  debt: ThreadDurabilityDebtSnapshot
  /** Null when the port was supplied from outside and keeps no counters here. */
  port: ThreadDurabilityDebtFsSnapshot | null
  tickets: ChatDurabilityTicketsSnapshot
}

export interface ThreadBarrierDurability {
  /** What every thread store is given in place of a sync. */
  readonly note: NoteThreadDurabilityDebt
  readonly debt: ThreadDurabilityDebt
  readonly tickets: ChatDurabilityTickets
  /**
   * The journal's options in this mode. A line written without a sync can be
   * torn by a power cut, and the next append must not be glued to the
   * fragment, so the journal cuts it first.
   */
  readonly journal: {
    readonly noteDurabilityDebt: NoteThreadDurabilityDebt
    readonly repairTornTailBeforeAppend: true
  }
  /** What one save's tool-detail writer is given, for that save's thread. */
  detail(chatId: string): ToolActivityDetailDebt
  snapshot(): ThreadBarrierDurabilitySnapshot
}

export interface ThreadBarrierDurabilityOptions {
  /** Pays the debt; the production port when omitted. */
  port?: ThreadDurabilityPort
  /** Milliseconds, for timing barriers and tickets. */
  now?: () => number
}

export function createThreadBarrierDurability(
  options: ThreadBarrierDurabilityOptions = {}
): ThreadBarrierDurability {
  const now = options.now ?? Date.now
  const built = options.port ? null : createThreadDurabilityDebtFs()
  const debt = createThreadDurabilityDebt({ port: options.port ?? built!, now })
  const tickets = new ChatDurabilityTickets({ now })
  const note = debt.note
  return {
    note,
    debt,
    tickets,
    journal: { noteDurabilityDebt: note, repairTornTailBeforeAppend: true },
    detail: (chatId) => ({ chatId, note }),
    snapshot: () => ({
      debt: debt.snapshot(),
      port: built?.snapshot() ?? null,
      tickets: tickets.snapshot()
    })
  }
}
