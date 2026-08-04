import {
  HostCommandReceiptStore,
  type HostCommandReceiptStoreOptions
} from './HostCommandReceiptStore'
import { HostDeltaStore, type HostDeltaStoreOptions } from './HostDeltaStore'

const MAX_DEFERRED_RECOVERY_RECORDS = 2000
const MAX_DEFERRED_RECOVERY_COMMAND_ID_CHARS = 200

export interface HostRuntimeDeferredRecoveryRecord {
  commandId: string
  state: string
}

export interface HostRuntimeDeferredRecoverySource {
  list: () => readonly HostRuntimeDeferredRecoveryRecord[]
}

export interface HostRuntimeDeferredRecoverySummary {
  availability: 'available' | 'unavailable'
  size: number | null
  indeterminate: number | null
  uniqueIndeterminateCommandCount: number | null
}

export interface HostRuntimeBootstrapOptions {
  /** Durable Host-owned directory shared by both stores. */
  hostDataDir: string
  delta?: Omit<HostDeltaStoreOptions, 'dataDir'>
  receipts?: Omit<HostCommandReceiptStoreOptions, 'dataDir' | 'getPosition'>
  /** Optional narrow adapter for HostDeferredCommandBridge.list(). */
  deferredRecovery?: HostRuntimeDeferredRecoverySource
}

export interface HostRuntimeRecoverySummary {
  position: ReturnType<HostDeltaStore['getPosition']>
  delta: ReturnType<HostDeltaStore['getRecoveryState']>
  receipts: {
    size: number
    indeterminate: number
  }
  /** Present on summaries returned by HostRuntimeBootstrap; optional for legacy consumers. */
  deferred?: HostRuntimeDeferredRecoverySummary
}

export type HostRuntimeRecoverySummaryWithDeferred = HostRuntimeRecoverySummary & {
  deferred: HostRuntimeDeferredRecoverySummary
}

/**
 * Electron-free composition boundary for the durable Host stores.
 *
 * This class owns no domain state or position counters: generation/cursor are
 * always read from HostDeltaStore, while receipts remain independently durable.
 * Receipt minting receives position only through the delta-backed getPosition
 * callback — never a second journal.
 */
export class HostRuntimeBootstrap {
  readonly deltaStore: HostDeltaStore
  readonly receiptStore: HostCommandReceiptStore
  private readonly deferredRecovery?: HostRuntimeDeferredRecoverySource

  constructor(options: HostRuntimeBootstrapOptions) {
    if (!options.hostDataDir) {
      throw new Error('HostRuntimeBootstrap requires an injected hostDataDir')
    }

    this.deferredRecovery = options.deferredRecovery
    this.deltaStore = new HostDeltaStore({
      ...options.delta,
      dataDir: options.hostDataDir
    })
    this.receiptStore = new HostCommandReceiptStore({
      ...options.receipts,
      dataDir: options.hostDataDir,
      getPosition: () => this.deltaStore.getPosition()
    })
  }

  getPosition(): ReturnType<HostDeltaStore['getPosition']> {
    return this.deltaStore.getPosition()
  }

  getRecoverySummary(): HostRuntimeRecoverySummaryWithDeferred {
    const receipts = this.receiptStore.list()
    const receiptIndeterminate = receipts.filter((receipt) => receipt.status === 'indeterminate')
    const deferred = summarizeDeferredRecovery(this.deferredRecovery, receiptIndeterminate)
    return {
      position: this.deltaStore.getPosition(),
      delta: this.deltaStore.getRecoveryState(),
      receipts: {
        size: receipts.length,
        indeterminate: receiptIndeterminate.length
      },
      deferred: deferred.summary
    }
  }

  /** Flush both bounded journals into their durable checkpoints. */
  flush(): void {
    this.deltaStore.compact()
    this.receiptStore.compact()
  }
}

function summarizeDeferredRecovery(
  source: HostRuntimeDeferredRecoverySource | undefined,
  receiptIndeterminate: readonly { commandId: string }[]
): { summary: HostRuntimeDeferredRecoverySummary } {
  const unavailable: HostRuntimeDeferredRecoverySummary = {
    availability: 'unavailable',
    size: null,
    indeterminate: null,
    uniqueIndeterminateCommandCount: null
  }

  if (!source || typeof source !== 'object' || typeof source.list !== 'function') {
    return { summary: unavailable }
  }

  let records: readonly HostRuntimeDeferredRecoveryRecord[]
  try {
    records = source.list()
  } catch {
    return { summary: unavailable }
  }

  if (!Array.isArray(records) || records.length > MAX_DEFERRED_RECOVERY_RECORDS) {
    return { summary: unavailable }
  }

  const uniqueIndeterminateCommandIds = new Set<string>()
  for (const receipt of receiptIndeterminate) {
    if (typeof receipt.commandId === 'string' && receipt.commandId.length > 0) {
      uniqueIndeterminateCommandIds.add(receipt.commandId)
    }
  }

  let indeterminate = 0
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      return { summary: unavailable }
    }
    if (
      typeof record.commandId !== 'string' ||
      record.commandId.length === 0 ||
      record.commandId.length > MAX_DEFERRED_RECOVERY_COMMAND_ID_CHARS ||
      typeof record.state !== 'string'
    ) {
      return { summary: unavailable }
    }
    if (record.state === 'indeterminate') {
      indeterminate += 1
      uniqueIndeterminateCommandIds.add(record.commandId)
    }
  }

  return {
    summary: {
      availability: 'available',
      size: records.length,
      indeterminate,
      uniqueIndeterminateCommandCount: uniqueIndeterminateCommandIds.size
    }
  }
}
