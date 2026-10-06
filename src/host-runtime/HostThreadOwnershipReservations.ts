import {
  ReservationInvalid,
  type ThreadOwnershipReservation
} from '../host-shared/thread-log/ThreadOwnership'
import type {
  ThreadAuthorityFiles,
  ThreadAuthorityRecord,
  ThreadAuthorityWriter,
  ThreadWriterLiveness
} from '../host-shared/thread-log/ThreadAuthorityFile'
import type { ThreadAuthorityRetirementOutcome } from '../host-shared/thread-log/ThreadAuthorityRetirement'

export interface OrphanReservationPorts {
  files: Pick<ThreadAuthorityFiles, 'read' | 'remove'>
  witness(threadId: string): (() => boolean) | undefined
  liveness(writer: ThreadAuthorityWriter): ThreadWriterLiveness
  assertAuthority(): void
  erasing(threadId: string): boolean
  generation(threadId: string): string | null
  fullCopyRevision(threadId: string): number | null
  logRevision(threadId: string): Promise<number | null>
}

interface Custody {
  readonly handle: ThreadOwnershipReservation
  readonly record: ThreadAuthorityRecord
  readonly generation: string | null
  witness: () => boolean
  phase: 'marked' | 'sync-owed' | 'retired'
  removing: boolean
}

/** Registry-local object identity, never a serializable or globally branded permit. */
export class HostThreadOwnershipReservations {
  private readonly byThread = new Map<string, Custody>()
  private readonly byHandle = new WeakMap<ThreadOwnershipReservation, Custody>()

  constructor(private readonly ports: OrphanReservationPorts) {}

  held(threadId: string): boolean {
    return this.byThread.has(threadId)
  }

  /** Caller serializes minting with every other decision on this thread. */
  async reserve(threadId: string): Promise<ThreadOwnershipReservation | null> {
    if (this.held(threadId)) return null
    try {
      this.ports.assertAuthority()
      if (this.ports.erasing(threadId)) return null
      const generation = this.ports.generation(threadId)
      const witness = this.ports.witness(threadId)
      if (!witness) return null
      const read = await this.ports.files.read(threadId)
      this.ports.assertAuthority()
      if (
        !witness() ||
        read.kind !== 'held' ||
        this.ports.erasing(threadId) ||
        this.ports.generation(threadId) !== generation ||
        this.ports.liveness(read.record.writer) !== 'dead'
      )
        return null
      const record = Object.freeze({
        ...read.record,
        writer: Object.freeze({ ...read.record.writer }),
        epoch: Object.freeze({ ...read.record.epoch })
      })
      let custody!: Custody
      const handle: ThreadOwnershipReservation = Object.freeze({
        threadId,
        epoch: record.epoch,
        revalidate: () => this.validate(custody),
        erasing: () => this.ports.erasing(threadId)
      })
      custody = { handle, record, generation, witness, phase: 'marked', removing: false }
      this.byThread.set(threadId, custody)
      this.byHandle.set(handle, custody)
      return handle
    } catch {
      return null
    }
  }

  /** A failed sync retains exact custody. Only its original handle may pay that debt. */
  release(handle: ThreadOwnershipReservation): boolean {
    const custody = this.byHandle.get(handle)
    if (!custody || this.byThread.get(handle.threadId) !== custody) return false
    if (custody.removing || custody.phase === 'sync-owed') return false
    this.byThread.delete(handle.threadId)
    this.byHandle.delete(handle)
    return true
  }

  /**
   * Caller serializes retirement; custody also remains held while it awaits
   * disk I/O. Revalidation invalidates only on a PROVED-alive writer: an
   * unprobed pid must not mint permission, but it is not a revival either.
   * Retirement admission separately requires the writer to be ended
   * (`dead`): an undecidable writer under attached desktops is held, never
   * retired.
   */
  async retire(
    threadId: string,
    handle: ThreadOwnershipReservation
  ): Promise<ThreadAuthorityRetirementOutcome> {
    const custody = this.byHandle.get(handle)
    if (!custody || handle.threadId !== threadId || this.byThread.get(threadId) !== custody) {
      return { kind: 'busy', reason: 'damaged' }
    }
    try {
      // Phase-aware admission: a sync-owed custody's mark is already unlinked,
      // so its witness is expected to report the change.
      if (custody.phase === 'marked') this.validate(custody)
      else this.validateUnlinked(custody)
      const read = await this.ports.files.read(threadId)
      if (custody.phase === 'marked') this.validate(custody)
      else this.validateUnlinked(custody)
      if (custody.phase === 'marked') {
        if (
          read.kind !== 'held' ||
          JSON.stringify(read.record) !== JSON.stringify(custody.record)
        ) {
          return { kind: 'busy', reason: 'damaged' }
        }
        const logRevision = await this.ports.logRevision(threadId)
        this.validate(custody)
        const full = this.ports.fullCopyRevision(threadId)
        // Missing canonical storage never grants permission to resurrect or retire.
        if (full === null || (logRevision !== null && logRevision > full)) {
          return { kind: 'busy', reason: 'damaged' }
        }
      } else if (read.kind !== 'none') {
        return { kind: 'busy', reason: 'damaged' }
      }
      if (custody.phase === 'retired') return { kind: 'retired' }
      if (custody.phase === 'marked' && this.ports.liveness(custody.record.writer) !== 'dead') {
        return { kind: 'busy', reason: 'live_writer' }
      }
      custody.removing = true
      let synced = false
      try {
        await this.ports.files.remove(threadId, this.removalGuard(custody))
        synced = true
      } catch (error) {
        // A validation failure (revived writer, lost authority, erasure
        // change) decides the outcome; only a plain disk error falls through
        // to the absence check below.
        if (error instanceof ReservationInvalid) throw error
      }
      const after = await this.ports.files.read(threadId)
      // Post-unlink validation: the mark is gone by design, so the witness is
      // exempt; identity, profile authority, liveness and erasure still bind.
      this.validateUnlinked(custody)
      if (after.kind !== 'none') return { kind: 'uncertain', reason: 'witness_changed' }
      custody.phase = synced ? 'retired' : 'sync-owed'
      return synced ? { kind: 'retired' } : { kind: 'uncertain', reason: 'sync_failed' }
    } catch (error) {
      if (error instanceof ReservationInvalid && error.reason === 'erasure_changed') {
        return { kind: 'busy', reason: 'erasing' }
      }
      if (error instanceof ReservationInvalid && error.reason === 'writer_alive') {
        return { kind: 'busy', reason: 'live_writer' }
      }
      return { kind: 'busy', reason: 'damaged' }
    } finally {
      custody.removing = false
    }
  }

  /**
   * Guard threaded into each destructive filesystem step of a removal. While
   * the mark is still linked, every step re-runs the full validation,
   * witness included; once unlinked, later steps (temp sibling, directory
   * sync) validate everything but the witness, which is expected to report
   * the unlink.
   */
  private removalGuard(custody: Custody): { assert(): void; unlinked(): void } {
    return {
      assert: () => {
        if (custody.phase === 'sync-owed') this.validateUnlinked(custody)
        else this.validate(custody)
      },
      unlinked: () => {
        custody.phase = 'sync-owed'
      }
    }
  }

  /** Identity, profile authority, liveness and erasure, without the mark witness. */
  private validateUnlinked(custody: Custody): void {
    this.identity(custody)
    try {
      this.ports.assertAuthority()
    } catch {
      throw new ReservationInvalid('profile_authority_lost')
    }
    if (this.ports.liveness(custody.record.writer) === 'alive') {
      throw new ReservationInvalid('writer_alive')
    }
    if (
      this.ports.erasing(custody.handle.threadId) ||
      this.ports.generation(custody.handle.threadId) !== custody.generation
    ) {
      throw new ReservationInvalid('erasure_changed')
    }
  }

  private identity(custody: Custody): void {
    if (
      this.byHandle.get(custody.handle) !== custody ||
      this.byThread.get(custody.handle.threadId) !== custody
    ) {
      throw new ReservationInvalid('not_minted')
    }
  }

  private validateAuthority(custody: Custody): void {
    this.identity(custody)
    try {
      this.ports.assertAuthority()
    } catch {
      throw new ReservationInvalid('profile_authority_lost')
    }
    // Check these independently of the mark: unlink must not mask a revived
    // writer or erasure. Only a PROVED-alive writer invalidates; an
    // unprobed pid is held, not revived.
    if (this.ports.liveness(custody.record.writer) === 'alive')
      throw new ReservationInvalid('writer_alive')
    if (
      this.ports.erasing(custody.handle.threadId) ||
      this.ports.generation(custody.handle.threadId) !== custody.generation
    ) {
      throw new ReservationInvalid('erasure_changed')
    }
  }

  private validate(custody: Custody): void {
    this.validateAuthority(custody)
    if (!custody.witness()) throw new ReservationInvalid('mark_moved')
  }
}
