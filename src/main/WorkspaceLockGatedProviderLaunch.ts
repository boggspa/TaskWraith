import type { ChildProcess } from 'node:child_process'

import {
  spawnWorkspaceLockGatedProcess,
  type WorkspaceLockGatedProcess,
  type WorkspaceLockGatedProcessSpec
} from './WorkspaceLockGatedProcess'
import type {
  WorkspaceLockProviderAdmission,
  WorkspaceLockProviderAdmissionKey
} from './WorkspaceLockProviderCoordinator'
import { waitForWorkspaceLockProcessTreeExit } from './WorkspaceLockProcessTree'
import type { WorkspaceLockRunLifecycleOperation } from './WorkspaceLockRunLifecycle'

export interface WorkspaceLockGatedProviderLaunchDependencies {
  getAdmission: (key: WorkspaceLockProviderAdmissionKey) => WorkspaceLockProviderAdmission | null
  beginLifecycleOperation: (runId: string) => WorkspaceLockRunLifecycleOperation
  transferToChild: (
    key: WorkspaceLockProviderAdmissionKey,
    executionPid: number
  ) => Promise<WorkspaceLockProviderAdmission>
  releaseSetupFailure: (
    key: WorkspaceLockProviderAdmissionKey,
    admission: WorkspaceLockProviderAdmission
  ) => Promise<void>
  releaseChild: (
    key: WorkspaceLockProviderAdmissionKey,
    admission: WorkspaceLockProviderAdmission
  ) => Promise<void>
  quarantineChildForRecovery: (
    key: WorkspaceLockProviderAdmissionKey,
    admission: WorkspaceLockProviderAdmission
  ) => Promise<void>
  onIntegrityFailure: (reason: string) => void
  spawnGatedProcess?: typeof spawnWorkspaceLockGatedProcess
  waitForProcessTreeExit?: typeof waitForWorkspaceLockProcessTreeExit
}

/**
 * Owns one provider's pre-spawn guardian from final main admission through the
 * exact gated child close. The target executable cannot run until durable
 * authority has transferred to the inert gate's PID; execve then preserves
 * that identity for the provider process itself.
 */
export class WorkspaceLockGatedProviderLaunch {
  private readonly admission: WorkspaceLockProviderAdmission
  private lifecycleOperation: WorkspaceLockRunLifecycleOperation | null
  private gatedProcess: WorkspaceLockGatedProcess | null = null
  private childAdmission: WorkspaceLockProviderAdmission | null = null
  private transferOperation: Promise<WorkspaceLockProviderAdmission> | null = null
  private childSettlement: Promise<void> | null = null
  private setupRelease: Promise<void> | null = null
  private childClosed = false
  private targetStarted = false
  private isolatedProcessGroup = false

  constructor(
    private readonly key: WorkspaceLockProviderAdmissionKey,
    private readonly providerLabel: string,
    private readonly deps: WorkspaceLockGatedProviderLaunchDependencies
  ) {
    const admission = deps.getAdmission(key)
    if (!admission || admission.owner.lifecycle !== 'launching-child') {
      throw new Error(
        `${providerLabel} gated launch requires its exact pre-spawn workspace-lock guardian.`
      )
    }
    this.admission = admission
    this.lifecycleOperation = deps.beginLifecycleOperation(key.runId)
  }

  spawn(spec: WorkspaceLockGatedProcessSpec): ChildProcess {
    if (this.gatedProcess) {
      throw new Error(`${this.providerLabel} workspace-lock gate was already spawned.`)
    }
    const spawnGatedProcess = this.deps.spawnGatedProcess ?? spawnWorkspaceLockGatedProcess
    const gatedProcess = spawnGatedProcess(spec, this.admission.owner.lockOwnerId)
    this.gatedProcess = gatedProcess
    this.isolatedProcessGroup = spec.detached === true
    const child = gatedProcess.child
    this.childSettlement = new Promise<void>((resolve, reject) => {
      child.once('close', () => {
        this.childClosed = true
        void this.settleClosedChild().then(resolve, reject)
      })
    })
    void this.childSettlement.catch(() => undefined)

    const executionPid = child.pid
    if (!executionPid) {
      const error = new Error(
        `${this.providerLabel} workspace-lock gate spawned without an exact child process id.`
      )
      this.transferOperation = Promise.reject(error)
      void this.transferOperation.catch(() => undefined)
      this.failTransferAndStopGate(error)
      return child
    }

    this.transferOperation = (async () => {
      try {
        const transferred = await this.deps.transferToChild(this.key, executionPid)
        this.childAdmission = transferred
        if (
          transferred.owner.lifecycle !== 'child' ||
          transferred.owner.pid !== executionPid ||
          transferred.owner.lockOwnerId !== this.admission.owner.lockOwnerId
        ) {
          throw new Error(
            `${this.providerLabel} workspace-lock transfer returned a mismatched child identity.`
          )
        }
        if (!this.childClosed) {
          gatedProcess.start()
          this.targetStarted = true
          this.finishLifecycleOperation()
        }
        return transferred
      } catch (error) {
        this.failTransferAndStopGate(error)
        throw error
      }
    })()
    void this.transferOperation.catch(() => undefined)
    return child
  }

  async releaseIfUnspawned(): Promise<void> {
    if (this.gatedProcess) return
    await this.releaseSetupGuardian()
  }

  async awaitChildSettlement(): Promise<void> {
    await this.childSettlement
  }

  private async settleClosedChild(): Promise<void> {
    let transferError: unknown
    try {
      await this.transferOperation
    } catch (error) {
      transferError = error
    }

    try {
      if (!this.childAdmission) {
        await this.releaseSetupGuardian()
      } else if (!this.targetStarted) {
        // The inert gate closed before execve, so no provider code or
        // descendant could have inherited the transferred authority.
        await this.deps.releaseChild(this.key, this.childAdmission)
      } else {
        const waitForProcessTreeExit =
          this.deps.waitForProcessTreeExit ?? waitForWorkspaceLockProcessTreeExit
        const processTreeStopped = await waitForProcessTreeExit({
          rootPid: this.childAdmission.owner.pid,
          isolatedProcessGroup: this.isolatedProcessGroup
        })
        if (processTreeStopped) {
          await this.deps.releaseChild(this.key, this.childAdmission)
        } else {
          await this.deps.quarantineChildForRecovery(this.key, this.childAdmission)
        }
      }
    } catch (error) {
      this.reportIntegrityFailure(
        `${this.providerLabel} workspace-lock child settlement failed: ${errorMessage(error)}`
      )
      throw error
    } finally {
      this.finishLifecycleOperation()
    }

    if (transferError) throw transferError
  }

  private async releaseSetupGuardian(): Promise<void> {
    if (!this.setupRelease) {
      this.setupRelease = (async () => {
        try {
          await this.deps.releaseSetupFailure(this.key, this.admission)
        } catch (error) {
          this.reportIntegrityFailure(
            `${this.providerLabel} workspace-lock setup release failed: ${errorMessage(error)}`
          )
          throw error
        } finally {
          this.finishLifecycleOperation()
        }
      })()
    }
    await this.setupRelease
  }

  private failTransferAndStopGate(error: unknown): void {
    this.reportIntegrityFailure(
      `${this.providerLabel} workspace-lock child transfer failed: ${errorMessage(error)}`
    )
    try {
      this.gatedProcess?.child.kill('SIGKILL')
    } catch {
      // Exact close settlement retains the guardian if termination fails.
    }
  }

  private reportIntegrityFailure(reason: string): void {
    try {
      this.deps.onIntegrityFailure(reason)
    } catch {
      // The durable acquisition remains authoritative if diagnostics fail.
    }
  }

  private finishLifecycleOperation(): void {
    this.lifecycleOperation?.finish()
    this.lifecycleOperation = null
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
