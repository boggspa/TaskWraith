import type { JournalSourceCapture } from './JournalSourceCapture'
import type { CheckpointPreparationJob } from './CheckpointPreparationProtocol'
import { observeResidual, type ResidualObserver } from './MainDurabilityResiduals'

export type ChatPreparationTicket = Pick<
  JournalSourceCapture,
  'chatId' | 'revision' | 'generation'
> & {
  purpose: 'maintenance' | 'publication'
}

export type ChatPreparationCommand =
  | (ChatPreparationTicket & { type: 'start'; id: number; attempt: number })
  | { type: 'cancel'; id: number; reason: 'deadline' | 'erased' }
  | { type: 'release'; id: number }
  | { type: 'ready'; id: number }
  | { type: 'refused'; id: number; reason: 'deadline' | 'attempts' | 'saturated' }

interface Entry {
  id: number
  ticket: ChatPreparationTicket
  deadline: number
  attempt: number
}

/** Adapter custody uses the existing worker lifecycle; payloads stay outside this model. */
export type ChatPreparationJobCustody = Pick<CheckpointPreparationJob, 'cancel' | 'release'>

/**
 * Unwired slice 5, virtual-clock scheduler. A single preparation slot bounds
 * maintenance interference to one hold. Publications use FIFO ahead of waiting
 * maintenance, with one coalesced waiter per chat. Only scalar identities are
 * retained; the adapter re-captures when start is emitted. No fallback executes.
 * Completion means worker exit/credit release is observed, not just its reply.
 * Cancellation keeps the slot until finishCancellation confirms that fence.
 */
export class ChatPreparationLane {
  constructor(private readonly residualObserver?: ResidualObserver) {}
  private refuse(): void {
    this.refusals++
    observeResidual(this.residualObserver, 'preparationRefusals')
  }
  private waiting = new Map<string, Entry>()
  private active: Entry | null = null
  private cancelling = false
  private erased = new Set<string>()
  private nextId = 1
  private clock = 0
  private retries = 0
  private timeouts = 0
  private refusals = 0

  enqueue(request: ChatPreparationTicket, now: number): number {
    this.time(now)
    if (this.erased.has(request.chatId)) throw new Error('Chat erased')
    if (
      !/^[A-Za-z0-9_-]{1,256}$/.test(request.chatId) ||
      !Number.isSafeInteger(request.revision) ||
      request.revision < 0 ||
      !Number.isSafeInteger(request.generation) ||
      request.generation < 0 ||
      !['maintenance', 'publication'].includes(request.purpose)
    )
      throw new Error('Invalid ticket')
    // Explicit copying ensures accidental record/capture fields are never retained.
    const ticket = {
      chatId: request.chatId,
      revision: request.revision,
      generation: request.generation,
      purpose: request.purpose
    }
    const previous = this.waiting.get(ticket.chatId)
    if (previous) {
      if (
        ticket.generation < previous.ticket.generation ||
        (ticket.generation === previous.ticket.generation &&
          ticket.revision < previous.ticket.revision)
      ) {
        return previous.id
      }
      if (previous.ticket.purpose === 'publication') ticket.purpose = 'publication'
      previous.ticket = ticket // preserve FIFO position and original deadline
      return previous.id
    }
    if (this.waiting.size >= 128) {
      this.refuse()
      throw new Error('Preparation admission saturated')
    }
    const entry = { id: this.nextId++, ticket, deadline: now + 300, attempt: 0 }
    this.waiting.set(ticket.chatId, entry)
    return entry.id
  }

  advance(now: number): ChatPreparationCommand[] {
    this.time(now)
    const commands: ChatPreparationCommand[] = []
    if (this.active && !this.cancelling && now >= this.active.deadline) {
      this.cancelling = true
      this.timeouts++
      this.refuse()
      commands.push(
        { type: 'cancel', id: this.active.id, reason: 'deadline' },
        { type: 'refused', id: this.active.id, reason: 'deadline' }
      )
    }
    for (const [chatId, entry] of this.waiting) {
      if (now >= entry.deadline) {
        this.waiting.delete(chatId)
        this.timeouts++
        this.refuse()
        commands.push({ type: 'refused', id: entry.id, reason: 'deadline' })
      }
    }
    if (this.active) return commands
    const entries = [...this.waiting.values()]
    const next = entries.find((entry) => entry.ticket.purpose === 'publication') ?? entries[0]
    if (next) {
      this.waiting.delete(next.ticket.chatId)
      this.active = next
      next.attempt++
      commands.push({ type: 'start', id: next.id, attempt: next.attempt, ...next.ticket })
    }
    return commands
  }

  complete(id: number, success: boolean, now: number, attempt = 1): ChatPreparationCommand[] {
    this.time(now)
    const entry = this.active
    if (!entry || entry.id !== id || entry.attempt !== attempt || this.cancelling) return []
    this.active = null
    const commands: ChatPreparationCommand[] = [{ type: 'release', id }]
    if (now >= entry.deadline) {
      this.timeouts++
      this.refuse()
      commands.push({ type: 'refused', id, reason: 'deadline' })
    } else if (success) commands.push({ type: 'ready', id })
    else if (entry.attempt >= 3) {
      this.refuse()
      commands.push({ type: 'refused', id, reason: 'attempts' })
    } else if (!this.waiting.has(entry.ticket.chatId)) {
      if (this.waiting.size >= 128) {
        this.refuse()
        commands.push({ type: 'refused', id, reason: 'saturated' })
      } else {
        this.retries++
        this.waiting.set(entry.ticket.chatId, entry)
      }
    }
    return commands
  }

  erase(chatId: string): ChatPreparationCommand[] {
    this.erased.add(chatId)
    this.waiting.delete(chatId)
    if (this.active?.ticket.chatId !== chatId || this.cancelling) return []
    this.cancelling = true
    return [{ type: 'cancel', id: this.active.id, reason: 'erased' }]
  }

  finishCancellation(id: number): ChatPreparationCommand[] {
    if (!this.active || this.active.id !== id || !this.cancelling) return []
    this.active = null
    this.cancelling = false
    return [{ type: 'release', id }]
  }

  stats(): { queued: number; active: number; retries: number; timeouts: number; refusals: number } {
    return {
      queued: this.waiting.size,
      active: this.active ? 1 : 0,
      retries: this.retries,
      timeouts: this.timeouts,
      refusals: this.refusals
    }
  }

  private time(now: number): void {
    if (!Number.isFinite(now) || now < this.clock) throw new Error('Clock must be monotonic')
    this.clock = now
  }
}
