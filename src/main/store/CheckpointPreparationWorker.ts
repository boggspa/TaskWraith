import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { electronUtilityProcess } from '../host/HostThreadRecordTransferTransport'
import {
  activePreparedCheckpointPaths,
  checkpointFileReference,
  type CheckpointPreparationJob,
  type CheckpointPreparationPort,
  type CheckpointPreparationReply,
  type CheckpointPreparationRequest,
  type CheckpointPreparationSource,
  type PreparedCheckpoint
} from './CheckpointPreparationProtocol'

export function isCheckpointPreparationWorkerEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.TASKWRAITH_CHECKPOINT_WORKER === '1'
}

export interface CheckpointPreparationProcess {
  post(request: CheckpointPreparationRequest): void
  onMessage(listener: (reply: CheckpointPreparationReply) => void): void
  onExit(listener: () => void): void
  onError(listener: (error: Error) => void): void
  kill(): void
}

function spawnPreparationProcess(entryPath: string): CheckpointPreparationProcess {
  const utility = electronUtilityProcess()
  if (utility) {
    const child = utility.fork(entryPath, [], { serviceName: 'taskwraith-checkpoint-preparation' })
    let killRequested = false
    // Electron cannot kill a utility process before it has a PID. Retain
    // cancellation/deadline intent and retire it as soon as spawning finishes.
    child.on('spawn', () => {
      if (killRequested) child.kill()
    })
    return {
      post: (request) => child.postMessage(request),
      onMessage: (listener) => {
        child.on('message', (reply) => listener(reply as CheckpointPreparationReply))
      },
      onExit: (listener) => {
        child.on('exit', listener)
      },
      onError: () => {},
      kill: () => {
        killRequested = true
        child.kill()
      }
    }
  }
  if (process.versions.electron)
    throw new Error('Checkpoint preparation requires an Electron utility process')
  const child = fork(entryPath, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] })
  return {
    post: (request) => {
      child.send(request)
    },
    onMessage: (listener) => {
      child.on('message', (reply) => listener(reply as CheckpointPreparationReply))
    },
    onExit: (listener) => {
      child.once('close', listener)
    },
    onError: (listener) => {
      child.once('error', listener)
    },
    kill: () => {
      child.kill()
    }
  }
}

/** Bounded, payload-free admission. Rejection leaves the durable journal for a later idle pass. */
export class CheckpointPreparationWorker implements CheckpointPreparationPort {
  private active = 0
  private bytes = 0

  constructor(
    private readonly options: {
      entryPath?: string
      maxJobs?: number
      maxReservedBytes?: number
      deadlineMs?: number
      spawn?: (entryPath: string) => CheckpointPreparationProcess
    } = {}
  ) {}

  stats(): { activeJobs: number; reservedBytes: number } {
    return { activeJobs: this.active, reservedBytes: this.bytes }
  }

  start(source: CheckpointPreparationSource): CheckpointPreparationJob | null {
    const sourceBytes = source.checkpoint.identity.size + source.journal.identity.size
    const maxOutputBytes = Math.min(128 * 1024 * 1024, sourceBytes * 2 + 4096)
    const reserved = sourceBytes + maxOutputBytes
    if (
      !/^[A-Za-z0-9_-]{1,256}$/.test(source.chatId) ||
      !Number.isSafeInteger(sourceBytes) ||
      sourceBytes <= 0 ||
      sourceBytes > 64 * 1024 * 1024 ||
      this.active >= (this.options.maxJobs ?? 2) ||
      this.bytes + reserved > (this.options.maxReservedBytes ?? 256 * 1024 * 1024)
    )
      return null

    // Reserve before retaining any output bytes or launching a child. Sources
    // are optimistic references: a concurrent rewrite may make this job stale.
    this.active += 1
    this.bytes += reserved
    const outputPath = path.join(
      path.dirname(source.checkpoint.path),
      `.${source.chatId}.checkpoint-prepared-${process.pid}-${randomUUID()}.tmp`
    )
    let child: CheckpointPreparationProcess
    let output: CheckpointPreparationJob['output']
    try {
      const fd = fs.openSync(outputPath, 'wx', 0o600)
      fs.closeSync(fd)
      output = checkpointFileReference(outputPath)
      activePreparedCheckpointPaths.add(outputPath)
      child = (this.options.spawn ?? spawnPreparationProcess)(
        this.options.entryPath ?? path.join(__dirname, 'checkpointPreparationWorker.js')
      )
    } catch (error) {
      fs.rmSync(outputPath, { force: true })
      activePreparedCheckpointPaths.delete(outputPath)
      this.active -= 1
      this.bytes -= reserved
      throw error
    }

    let exited = false
    let released = false
    let releaseRequested = false
    let credited = false
    let settled = false
    let reply: CheckpointPreparationReply | undefined
    let resolve!: (prepared: PreparedCheckpoint) => void
    let reject!: (error: Error) => void
    const result = new Promise<PreparedCheckpoint>((ok, fail) => {
      resolve = ok
      reject = fail
    })
    const removeOutput = (): void => {
      try {
        const current = checkpointFileReference(output.path).identity
        if (current.dev === output.identity.dev && current.ino === output.identity.ino)
          fs.unlinkSync(output.path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const credit = (): void => {
      if (exited && released && !credited) {
        credited = true
        this.active -= 1
        this.bytes -= reserved
        activePreparedCheckpointPaths.delete(outputPath)
      }
    }
    const fail = (error: Error): void => {
      if (!settled) {
        settled = true
        reject(error)
      }
      child.kill()
    }
    const timer = setTimeout(
      () => fail(new Error('Checkpoint preparation deadline exceeded')),
      this.options.deadlineMs ?? 30_000
    )
    timer.unref()
    child.onMessage((value) => {
      if (settled || reply) return
      reply = value
      child.kill()
    })
    child.onError(fail)
    child.onExit(() => {
      exited = true
      clearTimeout(timer)
      if (!settled) {
        settled = true
        if (reply?.ok) resolve(reply.prepared)
        else
          reject(
            new Error(reply?.error ?? 'Checkpoint preparation process exited without a result')
          )
      }
      // Windows may refuse to unlink an open output. The synchronous caller
      // observes that failure; once the child closes, finish custody cleanup.
      if (releaseRequested && !released) {
        try {
          removeOutput()
          released = true
        } catch {
          /* custody and credit remain held */
        }
      }
      credit()
    })
    const release = (): void => {
      releaseRequested = true
      removeOutput()
      released = true
      credit()
    }
    const cancel = (): void => {
      fail(new Error('Checkpoint preparation cancelled'))
      release()
    }
    try {
      child.post({ ...source, output, maxOutputBytes })
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
    return { output, result, cancel, release }
  }
}
