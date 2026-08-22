import type { RawLogEntry } from './rawLogEntry'

export const RAW_LOG_RING_CAPACITY = 1_000

/** Fixed-capacity FIFO with O(1) append and no per-event array copy. */
export class RawLogRingBuffer {
  private readonly entries: Array<RawLogEntry | undefined>
  private start = 0
  private countValue = 0

  constructor(readonly capacity = RAW_LOG_RING_CAPACITY) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new Error('Raw log ring capacity must be a positive safe integer')
    }
    this.entries = new Array(capacity)
  }

  get size(): number {
    return this.countValue
  }

  append(entry: RawLogEntry): void {
    if (this.countValue < this.capacity) {
      this.entries[(this.start + this.countValue) % this.capacity] = entry
      this.countValue += 1
      return
    }
    this.entries[this.start] = entry
    this.start = (this.start + 1) % this.capacity
  }

  replace(entries: readonly RawLogEntry[]): void {
    this.clear()
    const start = Math.max(0, entries.length - this.capacity)
    for (let index = start; index < entries.length; index += 1) {
      this.append(entries[index])
    }
  }

  snapshot(): RawLogEntry[] {
    const snapshot = new Array<RawLogEntry>(this.countValue)
    for (let index = 0; index < this.countValue; index += 1) {
      snapshot[index] = this.entries[(this.start + index) % this.capacity]!
    }
    return snapshot
  }

  clear(): void {
    this.entries.fill(undefined)
    this.start = 0
    this.countValue = 0
  }
}
