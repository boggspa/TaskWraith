import fs from 'node:fs'
import { ChatPreparationLane, type ChatPreparationTicket } from './ChatPreparationLane'
import {
  JournalPublicationCapacity,
  startJournalPublicationPreparation
} from './JournalPublicationPreparation'
import {
  checkpointFileReference,
  type JournalPublicationArtifact,
  type CheckpointPreparationPort,
  type CheckpointPreparationJob,
  type PreparedCheckpoint
} from './CheckpointPreparationProtocol'
import type { JournalCaptureLease } from './IncrementalChatJournal'
import type { HostThreadRecordReferenceStagingPort } from '../host/HostThreadRecordTransferTransport'
import {
  hostThreadRecordTransferDirectory,
  hostThreadRecordTransferPath,
  removeHostThreadRecordTransfer
} from '../../host-runtime/HostThreadRecordTransfer'

interface Request {
  input: Parameters<HostThreadRecordReferenceStagingPort['stage']>[0]
  resolve(value: Awaited<ReturnType<HostThreadRecordReferenceStagingPort['stage']>>): void
  reject(error: unknown): void
  timer?: ReturnType<typeof setTimeout>
  lineage?: { isCurrent(): boolean }
  cancelled?: boolean
}

/** One shared scalar lane. Artifact custody survives Host transport uncertainty. */
export class JournalHostReferenceConnector implements HostThreadRecordReferenceStagingPort {
  readonly lane = new ChatPreparationLane()
  readonly counters = { admitted: 0, unavailable: 0, artifacts: 0, retained: 0 }
  // Execution concurrency belongs to the single lane. Retained artifacts use
  // separate bounded credits so one slow Host receipt does not pin execution.
  private readonly capacity = new JournalPublicationCapacity(8, 256 * 1024 * 1024)
  private readonly held = new Map<
    string,
    { artifact: JournalPublicationArtifact; release(): void; id: number; attempt: number }
  >()
  private readonly requests = new Map<number, Request>()
  private active = false
  private activeJob: { id: number; chatId: string; cancel(): void } | undefined
  private readonly cancelling = new Set<number>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly uncertain = new Map<
    string,
    {
      job: NonNullable<ReturnType<typeof startJournalPublicationPreparation>>
      id: number
      attempt: number
    }
  >()
  private readonly maintenance = new Set<number>()
  private readonly checkpointJobs = new Map<
    number,
    {
      start(): CheckpointPreparationJob | null
      resolve(prepared: PreparedCheckpoint): void
      reject(error: unknown): void
      job?: CheckpointPreparationJob
      cancelled: boolean
      chatId: string
      exited: boolean
      releaseRequested: boolean
      finish?: () => void
    }
  >()
  constructor(
    private readonly ports: {
      workerEntryPath: string
      capture(chatId: string, revision: number): JournalCaptureLease | null
      owns(chatId: string, revision: number): boolean
      lineage?(chatId: string, revision: number): { isCurrent(): boolean } | null
      runMaintenance?(ticket: ChatPreparationTicket): Promise<void>
      now?: () => number
    }
  ) {}

  stage(input: Parameters<HostThreadRecordReferenceStagingPort['stage']>[0]) {
    const revision = input.persist.revision
    if (
      !Number.isSafeInteger(revision) ||
      revision! < 0 ||
      !this.ports.owns(input.persist.chatId, revision!)
    ) {
      this.counters.unavailable++
      return null
    }
    return new Promise<Awaited<ReturnType<HostThreadRecordReferenceStagingPort['stage']>>>(
      (resolve, reject) => {
        try {
          const lineage = this.ports.lineage?.(input.persist.chatId, revision!)
          if (this.ports.lineage && !lineage) {
            this.counters.unavailable++
            resolve(null)
            return
          }
          const id = this.lane.enqueue(
            {
              chatId: input.persist.chatId,
              revision: revision!,
              generation: 0,
              purpose: 'publication'
            },
            this.now()
          )
          const superseded = this.requests.get(id)
          if (superseded) {
            if (superseded.timer) clearTimeout(superseded.timer)
            superseded.resolve(null)
          }
          const maintenance = this.checkpointJobs.get(id)
          if (maintenance && !maintenance.job) {
            maintenance.reject(new Error('Maintenance superseded by publication'))
            this.checkpointJobs.delete(id)
          }
          const request: Request = { input, resolve, reject, lineage: lineage ?? undefined }
          request.timer = setTimeout(() => {
            if (this.requests.get(id) !== request || this.activeJob?.id === id) return
            this.requests.delete(id)
            this.counters.unavailable++
            resolve(null)
          }, 300)
          this.requests.set(id, request)
          this.pump()
        } catch (error) {
          reject(error)
        }
      }
    )
  }

  /** Maintenance uses this same lane; caller drives its admitted start command. */
  enqueueMaintenance(ticket: Omit<ChatPreparationTicket, 'purpose'>): number {
    if (!this.ports.runMaintenance) throw new Error('Maintenance executor unavailable')
    const id = this.lane.enqueue({ ...ticket, purpose: 'maintenance' }, this.now())
    this.maintenance.add(id)
    this.pump()
    return id
  }

  checkpointPort(base: CheckpointPreparationPort): CheckpointPreparationPort {
    return {
      start: (source) => {
        if (
          [...this.requests.values()].some(
            (request) => request.input.persist.chatId === source.chatId
          )
        )
          return null
        // The source contains only path/identity scalars, never a ChatRecord.
        const id = this.lane.enqueue(
          {
            chatId: source.chatId,
            revision: source.revision,
            generation: 0,
            purpose: 'maintenance'
          },
          this.now()
        )
        let resolve!: (value: PreparedCheckpoint) => void
        let reject!: (error: unknown) => void
        const result = new Promise<PreparedCheckpoint>((ok, fail) => {
          resolve = ok
          reject = fail
        })
        const held = {
          start: () => base.start(source),
          resolve,
          reject,
          cancelled: false,
          chatId: source.chatId,
          exited: false,
          releaseRequested: false,
          finish: undefined as (() => void) | undefined,
          job: undefined as CheckpointPreparationJob | undefined
        }
        const prior = this.checkpointJobs.get(id)
        prior?.reject(new Error('Maintenance ticket superseded'))
        this.checkpointJobs.set(id, held)
        const wrapper: CheckpointPreparationJob = {
          get output() {
            if (!held.job) throw new Error('Maintenance output unavailable before admission')
            return held.job.output
          },
          result,
          cancel: () => {
            held.cancelled = true
            held.job?.cancel()
          },
          release: () => {
            held.releaseRequested = true
            if (held.exited) held.finish?.()
          }
        }
        this.pump()
        return wrapper
      }
    }
  }

  acknowledgeTransfer(transferId: string): void {
    const held = this.held.get(transferId)
    if (!held) return
    held.release()
    this.held.delete(transferId)
  }

  erase(chatId: string): void {
    this.cancelChat(chatId, true)
  }

  cancelAll(): void {
    const chatIds = new Set([
      ...[...this.requests.values()].map((request) => request.input.persist.chatId),
      ...[...this.checkpointJobs.values()].map((job) => job.chatId),
      ...(this.activeJob ? [this.activeJob.chatId] : [])
    ])
    for (const chatId of chatIds) this.cancelChat(chatId)
  }

  cancelChat(chatId: string, permanent = false): void {
    if (permanent) {
      for (const command of this.lane.erase(chatId)) {
        if (command.type === 'cancel') {
          this.cancelling.add(command.id)
          if (this.activeJob?.id === command.id) this.activeJob.cancel()
        }
      }
    }
    for (const [id, checkpoint] of this.checkpointJobs) {
      if (checkpoint.chatId !== chatId) continue
      checkpoint.cancelled = true
      if (!checkpoint.job) {
        checkpoint.reject(new Error('Maintenance cancelled before admission'))
        this.checkpointJobs.delete(id)
      }
    }
    for (const [id, request] of this.requests) {
      if (request.input.persist.chatId !== chatId) continue
      request.cancelled = true
      if (this.activeJob?.id === id) continue
      if (request.timer) clearTimeout(request.timer)
      request.reject(new Error('Journal staging cancelled by chat lifecycle fence'))
      this.requests.delete(id)
    }
    if (this.activeJob?.chatId === chatId) {
      if (permanent) this.cancelling.add(this.activeJob.id)
      this.activeJob.cancel()
    }
    // Submitted Host artifacts remain in exact-transfer custody until a
    // matched receipt or definitive discard; erasure is not Host evidence.
  }

  snapshot() {
    return {
      counters: { ...this.counters },
      active: this.active,
      queued: this.requests.size + this.checkpointJobs.size,
      retainedArtifacts: this.held.size + this.uncertain.size,
      credits: this.capacity.snapshot()
    }
  }

  /** Only call after Host custody is definitively absent or denied. */
  discard(transferId: string): boolean {
    const held = this.held.get(transferId)
    const uncertain = this.uncertain.get(transferId)
    if (uncertain) {
      uncertain.job.cancel()
      uncertain.job.release()
      this.uncertain.delete(transferId)
    } else if (held) {
      const requestPath = held.artifact.artifactPath
      const current = fs.lstatSync(requestPath, { bigint: true, throwIfNoEntry: false })
      if (
        current &&
        (String(current.dev) !== held.artifact.identity.dev ||
          String(current.ino) !== held.artifact.identity.ino)
      ) {
        throw new Error('Definitive discard refused replacement inode')
      }
      if (current) fs.unlinkSync(requestPath)
      held.release()
      this.held.delete(transferId)
    } else return false
    this.pump()
    return true
  }

  private now(): number {
    return this.ports.now?.() ?? Date.now()
  }
  private pump(): void {
    if (!this.timer && (this.active || this.requests.size || this.checkpointJobs.size)) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        this.pump()
      }, 25)
      this.timer.unref?.()
    }
    for (const command of this.lane.advance(this.now())) {
      if (command.type === 'cancel') {
        this.cancelling.add(command.id)
        if (this.activeJob?.id === command.id) this.activeJob.cancel()
      }
      if (command.type === 'refused') {
        if (this.activeJob?.id === command.id) continue
        const request = this.requests.get(command.id)
        request?.resolve(null)
        if (request?.timer) clearTimeout(request.timer)
        this.requests.delete(command.id)
        this.checkpointJobs.get(command.id)?.reject(new Error('Maintenance admission refused'))
        this.checkpointJobs.delete(command.id)
      }
      if (command.type !== 'start') continue
      const checkpoint = this.checkpointJobs.get(command.id)
      if (checkpoint) {
        this.active = true
        checkpoint.finish = () => {
          checkpoint.job?.release()
          this.checkpointJobs.delete(command.id)
        }
        void Promise.resolve()
          .then(() => {
            if (checkpoint.cancelled) throw new Error('Maintenance cancelled before admission')
            checkpoint.job = checkpoint.start() ?? undefined
            if (!checkpoint.job) throw new Error('Maintenance worker unavailable')
            this.activeJob = {
              id: command.id,
              chatId: command.chatId,
              cancel: () => checkpoint.job?.cancel()
            }
            return checkpoint.job.result
          })
          .then(
            (prepared) => {
              checkpoint.exited = true
              checkpoint.resolve(prepared)
              if (checkpoint.releaseRequested) checkpoint.finish?.()
            },
            (error) => {
              checkpoint.exited = true
              checkpoint.reject(error)
              try {
                checkpoint.finish?.()
              } catch {
                this.counters.retained++
              }
            }
          )
          .finally(() => {
            this.finishLane(command.id, command.attempt)
          })
          .catch(() => {})
        continue
      }
      if (this.maintenance.delete(command.id)) {
        this.active = true
        void Promise.resolve()
          .then(() => this.ports.runMaintenance!(command))
          .finally(() => {
            this.finishLane(command.id, command.attempt)
          })
          .catch(() => {})
        continue
      }
      const request = this.requests.get(command.id)
      if (!request) {
        this.lane.complete(command.id, true, this.now(), command.attempt)
        continue
      }
      if (request.timer) clearTimeout(request.timer)
      this.active = true
      void this.run(command, request).catch(() => {})
    }
  }

  private async run(
    command: Extract<ReturnType<ChatPreparationLane['advance']>[number], { type: 'start' }>,
    request: Request
  ): Promise<void> {
    let job: ReturnType<typeof startJournalPublicationPreparation> = null
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      if (request.cancelled) throw new Error('Journal staging cancelled by chat lifecycle fence')
      if (
        !this.ports.owns(command.chatId, command.revision) ||
        request.lineage?.isCurrent() === false
      ) {
        request.resolve(null)
        return
      }
      fs.mkdirSync(hostThreadRecordTransferDirectory(request.input.profilePath), {
        recursive: true,
        mode: 0o700
      })
      const outputPath = hostThreadRecordTransferPath(
        request.input.profilePath,
        request.input.transferId
      )
      const fd = fs.openSync(outputPath, 'wx', 0o600)
      fs.closeSync(fd)
      const output = checkpointFileReference(outputPath)
      job = startJournalPublicationPreparation({
        workerEntryPath: this.ports.workerEntryPath,
        capture: () => this.ports.capture(command.chatId, command.revision),
        output,
        maxOutputBytes: 128 * 1024 * 1024,
        capacity: this.capacity,
        reservationBytes: 128 * 1024 * 1024,
        releaseCredit: () => {}
      })
      if (!job) {
        removeHostThreadRecordTransfer({
          profilePath: request.input.profilePath,
          transferId: request.input.transferId,
          expectedIdentity: output.identity
        })
        this.counters.unavailable++
        request.resolve(null)
        return
      }
      this.counters.admitted++
      this.activeJob = { id: command.id, chatId: command.chatId, cancel: () => job?.cancel() }
      deadline = setTimeout(() => job?.cancel(), 300)
      const artifact = await job.result
      if (request.cancelled) throw new Error('Journal staging cancelled by chat lifecycle fence')
      if (
        !job.isCurrent() ||
        !this.ports.owns(command.chatId, command.revision) ||
        request.lineage?.isCurrent() === false
      ) {
        job.cancel()
        throw new Error('Submitted journal lineage changed after worker exit')
      }
      this.held.set(request.input.transferId, {
        artifact,
        release: job.release,
        id: command.id,
        attempt: command.attempt
      })
      this.counters.artifacts++
      request.resolve({
        transferId: request.input.transferId,
        sha256: artifact.sha256,
        byteLength: artifact.byteLength
      })
    } catch (error) {
      this.counters.retained++
      if (job) {
        try {
          job.cancel()
          job.release()
        } catch {
          /* Preserve original failure and uncertain custody. */
        }
      }
      if (job && this.capacity.snapshot().jobs > 0) {
        this.uncertain.set(request.input.transferId, {
          job,
          id: command.id,
          attempt: command.attempt
        })
      }
      request.reject(error)
    } finally {
      if (deadline) clearTimeout(deadline)
      this.requests.delete(command.id)
      // Executor result is exit-qualified. Successful artifact credit remains
      // held separately until matched Host acknowledgement.
      this.finishLane(command.id, command.attempt)
    }
  }

  private finishLane(id: number, attempt: number): void {
    if (this.cancelling.delete(id)) this.lane.finishCancellation(id)
    else this.lane.complete(id, true, this.now(), attempt)
    this.active = false
    this.activeJob = undefined
    this.pump()
  }
}
