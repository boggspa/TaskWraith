import path from 'node:path'
import fs from 'node:fs'
import { Worker } from 'node:worker_threads'
import type { JournalCaptureLease } from './IncrementalChatJournal'
import type {
  CheckpointFileReference,
  JournalPublicationArtifact,
  JournalPublicationRequest
} from './CheckpointPreparationProtocol'
import { checkpointFileIdentity, sameCheckpointFile } from './CheckpointPreparationProtocol'

/** Scalar reservation only. Successful artifacts retain credit until adoption/discard. */
export class JournalPublicationCapacity {
  private jobs = 0
  private bytes = 0
  constructor(
    readonly maxJobs = 1,
    readonly maxBytes = 256 * 1024 * 1024
  ) {
    if (
      !Number.isSafeInteger(maxJobs) ||
      maxJobs < 1 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1
    )
      throw new Error('Invalid publication capacity')
  }
  reserve(bytes: number): (() => void) | null {
    if (!Number.isSafeInteger(bytes) || bytes < 1)
      throw new Error('Invalid publication reservation')
    if (this.jobs >= this.maxJobs || this.bytes + bytes > this.maxBytes) return null
    this.jobs++
    this.bytes += bytes
    let released = false
    return () => {
      if (!released) {
        released = true
        this.jobs--
        this.bytes -= bytes
      }
    }
  }
  snapshot(): { jobs: number; bytes: number } {
    return { jobs: this.jobs, bytes: this.bytes }
  }
}

/** Call only from a ChatPreparationLane start command. No waiting capture queue. */
export function startJournalPublicationPreparation(options: {
  workerEntryPath: string
  capture(): JournalCaptureLease | null
  output: CheckpointFileReference
  maxOutputBytes: number
  capacity: JournalPublicationCapacity
  /** Conservative scalar source/output budget from admission, never a retained payload. */
  reservationBytes: number
  /** Fault seam for synchronous construction refusal; production uses Worker. */
  createWorker?: (entry: string, options: ConstructorParameters<typeof Worker>[1]) => Worker
  /** Called after exit even when result validation or capture release fails. */
  releaseCredit(): void
}): {
  result: Promise<JournalPublicationArtifact>
  cancel(): void
  isCurrent(): boolean
  release(): void
} | null {
  if (
    !path.isAbsolute(options.workerEntryPath) ||
    !/\.(?:cjs|mjs|js)$/.test(options.workerEntryPath)
  )
    throw new Error('Publication requires emitted absolute worker path')
  const releaseReservation = options.capacity.reserve(options.reservationBytes)
  if (!releaseReservation) return null
  const releaseCredit = (): void => {
    releaseReservation()
    options.releaseCredit()
  }
  const cleanOutput = (): void => {
    let stat: fs.BigIntStats
    try {
      stat = fs.lstatSync(options.output.path, { bigint: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (
      String(stat.dev) !== options.output.identity.dev ||
      String(stat.ino) !== options.output.identity.ino
    )
      throw new Error('Publication output replaced; cleanup refused')
    fs.unlinkSync(options.output.path)
  }
  let captured: JournalCaptureLease | null
  try {
    captured = options.capture()
  } catch (error) {
    releaseReservation()
    throw error
  }
  if (!captured) {
    releaseReservation()
    return null
  }
  const lease = captured
  const directoryPath = path.dirname(options.output.path)
  let directoryStat: fs.BigIntStats
  try {
    directoryStat = fs.lstatSync(directoryPath, { bigint: true })
    if (!directoryStat.isDirectory())
      throw new Error('Publication output parent is not a directory')
  } catch (error) {
    try {
      lease.release()
    } finally {
      releaseCredit()
    }
    throw error
  }
  const reference = (source: JournalCaptureLease['checkpoint']) => ({
    fd: source.fd,
    identity: source.file.identity,
    prefixBytes: source.prefixBytes,
    mutablePrefix: source.mutablePrefix
  })
  const request: JournalPublicationRequest = {
    chatId: lease.chatId,
    revision: lease.revision,
    generation: lease.generation,
    checkpoint: reference(lease.checkpoint),
    sealed: lease.sealed ? reference(lease.sealed) : null,
    active: lease.active ? reference(lease.active) : null,
    output: options.output,
    outputDirectory: {
      path: directoryPath,
      dev: String(directoryStat.dev),
      ino: String(directoryStat.ino)
    },
    maxOutputBytes: options.maxOutputBytes
  }
  let worker: Worker
  try {
    const workerOptions = {
      workerData: request,
      trackUnmanagedFds: false,
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 512 }
    }
    worker = options.createWorker
      ? options.createWorker(options.workerEntryPath, workerOptions)
      : new Worker(options.workerEntryPath, workerOptions)
  } catch (error) {
    let cleanupFailure: unknown
    try {
      cleanOutput()
    } catch (cleanupError) {
      cleanupFailure = cleanupError
    }
    // No worker exists: source descriptors cannot be in flight. Release them
    // even when output custody refuses a replacement inode, reporting both errors.
    try {
      lease.release()
    } finally {
      releaseCredit()
    }
    if (cleanupFailure)
      throw new AggregateError(
        [error, cleanupFailure],
        'Worker construction failed; output cleanup refused'
      )
    throw error
  }
  let cancelled = false
  let exited = false
  let released = false
  let cleanupRequired = false
  const release = (): void => {
    if (!exited) throw new Error('Publication credit remains held until worker exit')
    if (released) return
    if (cleanupRequired) cleanOutput()
    try {
      lease.release()
    } finally {
      released = true
      releaseCredit()
    }
  }
  let reply: { ok: boolean; artifact?: JournalPublicationArtifact; error?: string } | undefined
  let failure: unknown
  const result = new Promise<JournalPublicationArtifact>((resolve, reject) => {
    worker.on('message', (value) => {
      reply = value
    })
    worker.on('error', (error) => {
      failure = error
    })
    worker.once('exit', (code) => {
      exited = true
      try {
        if (cancelled || code !== 0 || failure || !reply?.ok || !reply.artifact)
          throw failure ?? new Error(reply?.error ?? 'Publication worker refused')
        if (!lease.isCurrent()) throw new Error('Publication capture superseded or erased')
        const artifact = reply.artifact
        if (
          artifact.chatId !== lease.chatId ||
          artifact.revision !== lease.revision ||
          artifact.generation !== lease.generation ||
          artifact.artifactPath !== options.output.path
        )
          throw new Error('Publication reply identity mismatch')
        const stat = fs.lstatSync(options.output.path, { bigint: true })
        if (
          !stat.isFile() ||
          String(stat.dev) !== options.output.identity.dev ||
          String(stat.ino) !== options.output.identity.ino ||
          artifact.identity?.dev !== String(stat.dev) ||
          artifact.identity?.ino !== String(stat.ino) ||
          !sameCheckpointFile(artifact.identity, checkpointFileIdentity(stat)) ||
          !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
          !Number.isSafeInteger(artifact.byteLength) ||
          artifact.byteLength <= 0 ||
          artifact.byteLength > options.maxOutputBytes ||
          BigInt(artifact.byteLength) !== stat.size ||
          artifact.identity.size !== artifact.byteLength
        )
          throw new Error('Publication artifact validation failed')
        resolve(artifact)
      } catch (error) {
        cleanupRequired = true
        try {
          release()
          reject(error)
        } catch (cleanupError) {
          reject(new AggregateError([error, cleanupError], 'Publication cleanup retains custody'))
        }
      }
    })
  })
  return {
    result,
    isCurrent: () => !cancelled && !released && lease.isCurrent(),
    release,
    cancel: () => {
      cancelled = true
      cleanupRequired = true
      if (exited) release()
      else void worker.terminate()
    }
  }
}
