/**
 * Desktop-side transport for the shared thread-record transfer worker.
 *
 * Every `thread.record.persist` hands the full chat record to that worker by
 * structured clone, and the worker stringifies, hashes and fsyncs it. As a
 * `worker_threads` Worker it shares Electron main's process and V8 pointer
 * cage, so a fatal V8 allocation failure on a large record aborts the whole
 * app: release 1.9.8 died that way on 2026-09-22 (`WorkerThread`,
 * `node::OOMErrorHandler`, 265 full-record persists of a 20.6 MB thread in
 * 30 minutes). Run as an Electron utility process the same failure ends only
 * that child; its pending jobs reject and the next persist starts a fresh one.
 *
 * `src/host-runtime` never references Electron (the standalone Host import
 * audit forbids it), so the choice is made here and installed from the Desktop
 * persist-client factory before the first persist. The standalone Host keeps
 * the default worker thread. `TASKWRAITH_THREAD_RECORD_TRANSFER_WORKER_THREAD=1`
 * restores the in-process worker without a rebuild.
 */
import {
  configureHostThreadRecordTransferChannel,
  createHostThreadRecordTransferChannel,
  type HostThreadRecordTransferChannelFactory,
  type UtilityProcessLike
} from '../../host-runtime/HostThreadRecordTransferWorker'
import type { HostThreadRecordTransferDescriptor } from '../../host-runtime/HostThreadRecordTransfer'
import type {
  HostThreadRecordPersistInput,
  HostThreadRecordTransferPort
} from './HostThreadRecordPersistCommand'

export interface HostThreadRecordReferenceStagingPort {
  /** Called only after a matched successful receipt for this exact descriptor. */
  acknowledgeTransfer?(transferId: string): void
  /** Called only after a matched authority denial proves no consumption. */
  discard?(transferId: string): boolean
  /** Null means ineligible: retain the existing record publication route.
   * Rejection fails staging; it never licenses an implicit record fallback.
   * The port owns capture custody and must return the requested transfer ID.
   */
  stage(input: {
    profilePath: string
    transferId: string
    persist: Pick<HostThreadRecordPersistInput, 'chatId' | 'expectedRevision'> & {
      revision: number | undefined
    }
  }): HostThreadRecordTransferDescriptor | null | Promise<HostThreadRecordTransferDescriptor | null>
}

export interface HostThreadRecordStagingCounters {
  referenceArtifacts: number
  recordArtifacts: number
  referenceDeclines: number
  referenceFailures: number
}

export async function stageHostThreadRecordTransfer(input: {
  profilePath: string
  transferId: string
  persist: HostThreadRecordPersistInput
  reference?: HostThreadRecordReferenceStagingPort
  transfer: HostThreadRecordTransferPort
  counters: HostThreadRecordStagingCounters
}): Promise<HostThreadRecordTransferDescriptor> {
  if (input.reference) {
    try {
      const descriptor = await input.reference.stage({
        profilePath: input.profilePath,
        transferId: input.transferId,
        persist: {
          chatId: input.persist.chatId,
          expectedRevision: input.persist.expectedRevision,
          revision: input.persist.record.persistenceRevision
        }
      })
      if (descriptor) {
        if (
          descriptor.transferId !== input.transferId ||
          !/^[a-f0-9]{64}$/.test(descriptor.sha256) ||
          !Number.isSafeInteger(descriptor.byteLength) ||
          descriptor.byteLength < 1
        ) {
          throw new Error('Invalid reference staging descriptor')
        }
        input.counters.referenceArtifacts++
        return descriptor
      }
      input.counters.referenceDeclines++
    } catch (error) {
      input.counters.referenceFailures++
      throw error
    }
  }
  const descriptor = await input.transfer.publish({
    profilePath: input.profilePath,
    transferId: input.transferId,
    record: input.persist.record
  })
  input.counters.recordArtifacts++
  return descriptor
}

export const HOST_THREAD_RECORD_TRANSFER_WORKER_THREAD_ENV =
  'TASKWRAITH_THREAD_RECORD_TRANSFER_WORKER_THREAD'

export type HostThreadRecordTransferTransportKind = 'utility-process' | 'worker-thread'

/**
 * Electron main only. A utility process, a renderer, the standalone Host and
 * tests all report nothing and keep `worker_threads`. `electron` is required
 * lazily so this module stays importable from plain Node.
 */
export function electronUtilityProcess(
  env: { versions: { electron?: string }; type?: string } = process as never,
  load: () => { utilityProcess?: UtilityProcessLike } = () =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('electron') as typeof import('electron')
): UtilityProcessLike | undefined {
  if (!env.versions.electron || env.type !== 'browser') return undefined
  try {
    const utility = load().utilityProcess
    return typeof utility?.fork === 'function' ? utility : undefined
  } catch {
    return undefined
  }
}

let installed:
  | { utility: UtilityProcessLike | undefined; factory: HostThreadRecordTransferChannelFactory }
  | undefined

/**
 * Installs the transport the process-wide off-loop worker will use. Idempotent
 * for the same resolved utility process, so repeated client construction never
 * retires a healthy worker.
 */
export function installHostThreadRecordTransferTransport(
  options: { utility?: UtilityProcessLike; env?: NodeJS.ProcessEnv } = {}
): HostThreadRecordTransferTransportKind {
  const env = options.env ?? process.env
  const forcedWorkerThread = env[HOST_THREAD_RECORD_TRANSFER_WORKER_THREAD_ENV] === '1'
  const utility = forcedWorkerThread ? undefined : (options.utility ?? electronUtilityProcess())
  if (!installed || installed.utility !== utility) {
    installed = {
      utility,
      factory: (entryPath) => createHostThreadRecordTransferChannel(entryPath, utility)
    }
  }
  configureHostThreadRecordTransferChannel(installed.factory)
  return utility ? 'utility-process' : 'worker-thread'
}
