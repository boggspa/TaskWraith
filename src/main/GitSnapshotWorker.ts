import { utilityProcess } from 'electron'
import { constants as osConstants, setPriority } from 'node:os'
import type { GitRepositorySnapshot, GitResult } from './services/GitService'

const DEFAULT_REQUEST_TIMEOUT_MS = 45_000

type PendingRequest = {
  resolve: (result: GitResult<GitRepositorySnapshot>) => void
  timeout: ReturnType<typeof setTimeout>
}

type WorkerReply =
  | {
      type: 'snapshot-complete'
      requestId: number
      result: GitResult<GitRepositorySnapshot>
    }
  | { type: 'snapshot-error'; requestId: number; message: string }

function failure(message: string): GitResult<GitRepositorySnapshot> {
  return { ok: false, error: message }
}

/**
 * Long-lived utility-process client for detailed Git snapshots. Status parsing,
 * numstat aggregation and repository probes never execute on Electron main.
 */
export class GitSnapshotWorkerClient {
  private child: Electron.UtilityProcess | null = null
  private readonly pending = new Map<number, PendingRequest>()
  private nextRequestId = 1
  private disposed = false

  constructor(
    private readonly workerModulePath: string,
    private readonly requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
  ) {}

  snapshot(inputPath: string): Promise<GitResult<GitRepositorySnapshot>> {
    if (this.disposed) {
      return Promise.resolve(failure('Git snapshot worker is shutting down.'))
    }
    const child = this.ensureChild()
    if (!child) {
      return Promise.resolve(failure('Git snapshot utility process could not be started.'))
    }
    const requestId = this.nextRequestId++
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.finishRequest(requestId, failure('Git snapshot utility process timed out.'))
        this.resetChild('Git snapshot utility process was restarted after a timeout.')
      }, this.requestTimeoutMs)
      timeout.unref?.()
      this.pending.set(requestId, { resolve, timeout })
      try {
        child.postMessage({ type: 'snapshot', requestId, inputPath })
      } catch (error) {
        this.finishRequest(
          requestId,
          failure(error instanceof Error ? error.message : String(error))
        )
        this.resetChild('Git snapshot utility process transport failed.')
      }
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.resetChild('Git snapshot worker shut down before completing.')
  }

  private ensureChild(): Electron.UtilityProcess | null {
    if (this.child) return this.child
    let child: Electron.UtilityProcess
    try {
      child = utilityProcess.fork(this.workerModulePath, [], {
        serviceName: 'taskwraith-git-snapshot',
        execArgv: ['--max-old-space-size=256']
      })
    } catch {
      return null
    }
    this.child = child
    try {
      if (typeof child.pid === 'number' && child.pid > 0) {
        setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL)
      }
    } catch {
      // Process isolation remains authoritative if priority changes are denied.
    }
    child.on('message', (raw: unknown) => this.handleMessage(raw))
    child.on('error', (error) => {
      this.resetChild(String(error || 'Git snapshot utility process failed.'))
    })
    child.on('exit', (code) => {
      this.resetChild(`Git snapshot utility process exited with code ${code}.`)
    })
    return child
  }

  private handleMessage(raw: unknown): void {
    const message = raw as WorkerReply
    if (!Number.isSafeInteger(message?.requestId)) return
    if (message.type === 'snapshot-complete') {
      this.finishRequest(message.requestId, message.result)
    } else if (message.type === 'snapshot-error') {
      this.finishRequest(message.requestId, failure(message.message))
    }
  }

  private finishRequest(requestId: number, result: GitResult<GitRepositorySnapshot>): void {
    const request = this.pending.get(requestId)
    if (!request) return
    this.pending.delete(requestId)
    clearTimeout(request.timeout)
    request.resolve(result)
  }

  private resetChild(message: string): void {
    const child = this.child
    this.child = null
    if (child) {
      try {
        child.kill()
      } catch {
        // Already exited.
      }
    }
    for (const requestId of [...this.pending.keys()]) {
      this.finishRequest(requestId, failure(message))
    }
  }
}
