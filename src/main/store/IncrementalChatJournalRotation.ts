interface Segment {
  base: number
  end: number
  durable: number
  forgotten: boolean
}

interface Names {
  active: number | null
  sealed: number | null
  checkpoint: number
}

/**
 * Unwired M5 slice 3: revision-only durability/namespace state machine.
 * No filesystem effects or retained chat payload. flushFile also represents
 * independent OS writeback; acknowledge enforces the flusher dependencies.
 * Recovery models a durable re-anchor, not the production recovery writer.
 */
export class IncrementalChatJournalRotation {
  private visible: Names
  private durableNames: Names
  private segments = new Map<number, Segment>()
  private nextInode = 1
  private head: number
  private prepared: number | null = null
  private epoch = 0
  private ack: number
  private waiters = new Map<number, number>()
  private nextWaiter = 1

  constructor(readonly baseline = 0) {
    if (!Number.isSafeInteger(baseline) || baseline < 0) throw new Error('Invalid baseline')
    this.head = baseline
    this.ack = baseline
    this.visible = { active: null, sealed: null, checkpoint: baseline }
    this.durableNames = { ...this.visible }
  }

  append(): number {
    if (this.visible.active === null) {
      const inode = this.nextInode++
      this.segments.set(inode, {
        base: this.head,
        end: this.head,
        durable: this.head,
        forgotten: false
      })
      // The old directory flush cannot cover this lazy create.
      this.visible.active = inode
    }
    this.segment(this.visible.active).end = ++this.head
    return this.head
  }

  rotate(): void {
    if (this.sealed !== null || this.active === null) throw new Error('Rotation unavailable')
    this.visible.sealed = this.active
    this.visible.active = null
    // Rotation alone does not invalidate a capture pinned to the old inode.
  }

  flushFile(inode: number): void {
    const segment = this.segment(inode)
    if (segment.forgotten) throw new Error('Inode forgotten')
    segment.durable = segment.end
  }

  flushDirectory(): void {
    this.durableNames = { ...this.visible }
  }

  acknowledge(): boolean {
    if (this.active === null) {
      if (this.durableNames.checkpoint < this.head) return false
      this.ack = this.head
      return true
    }
    if (this.durableNames.active !== this.active) return false
    const active = this.segment(this.active)
    if (active.durable < active.end) return false
    if (this.sealed !== null) {
      const sealed = this.segment(this.sealed)
      if (
        !sealed.forgotten &&
        (this.durableNames.sealed !== this.sealed || sealed.durable < sealed.end)
      )
        return false
    }
    this.ack = this.head
    return true
  }

  prepare(): void {
    if (this.sealed === null) throw new Error('No sealed source')
    // Worker output is content-fsynced before its rename.
    this.prepared = this.segment(this.sealed).end
  }

  renameCheckpoint(): void {
    if (this.prepared === null) throw new Error('No prepared checkpoint')
    this.visible.checkpoint = this.prepared
    this.prepared = null
    this.epoch++
  }

  forgetSealed(): number[] {
    if (this.sealed === null) throw new Error('No sealed source')
    const segment = this.segment(this.sealed)
    if (this.durableNames.checkpoint < segment.end) throw new Error('Checkpoint not durable')
    // Durable coverage discharges the predecessor dependency, depth one.
    segment.forgotten = true
    const settled: number[] = []
    for (const [waiter, inode] of this.waiters) {
      if (inode === this.sealed) {
        settled.push(waiter)
        this.waiters.delete(waiter)
      }
    }
    return settled
  }

  unlinkSealed(): void {
    if (this.sealed === null || !this.segment(this.sealed).forgotten) {
      throw new Error('Forget must complete before unlink')
    }
    // Keep the inode in the disk model: before directory fsync its old name
    // can reappear after power loss, safely covered by the checkpoint.
    this.visible.sealed = null
  }

  recover(
    persisted: Readonly<Record<number, number>> = {},
    crash: 'power-loss' | 'process-crash' = 'power-loss'
  ): { revision: number; gap: boolean } {
    const names = crash === 'process-crash' ? this.visible : this.durableNames
    let revision = names.checkpoint
    let gap = false
    for (const inode of [names.sealed, names.active]) {
      if (inode === null) continue
      const segment = this.segment(inode)
      const count =
        crash === 'process-crash'
          ? segment.end - segment.base
          : (persisted[inode] ?? segment.durable - segment.base)
      if (
        !Number.isSafeInteger(count) ||
        count < segment.durable - segment.base ||
        count > segment.end - segment.base
      )
        throw new Error('Invalid persisted prefix')
      const end = segment.base + count
      if (end <= revision) continue // checkpoint covers duplicate batches
      if (segment.base > revision) {
        gap = true
        break
      }
      revision = end
    }
    if (revision < this.ack) throw new Error('Acknowledged state lost')
    // A counted gap repair publishes the longest contiguous prefix once.
    if (gap) this.epoch++
    this.head = revision
    this.visible = { active: null, sealed: null, checkpoint: revision }
    this.durableNames = { ...this.visible }
    this.waiters.clear()
    return { revision, gap }
  }

  get active(): number | null {
    return this.visible.active
  }
  get sealed(): number | null {
    return this.visible.sealed
  }
  get generation(): number {
    return this.epoch
  }
  get acknowledged(): number {
    return this.ack
  }

  wait(inode: number): number {
    this.segment(inode)
    const waiter = this.nextWaiter++
    this.waiters.set(waiter, inode)
    return waiter
  }

  get pendingWaiters(): number[] {
    return [...this.waiters.keys()]
  }

  private segment(inode: number): Segment {
    const segment = this.segments.get(inode)
    if (!segment) throw new Error('Unknown inode')
    return segment
  }
}
