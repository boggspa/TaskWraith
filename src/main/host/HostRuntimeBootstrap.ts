import {
  HostCommandReceiptStore,
  type HostCommandReceiptStoreOptions
} from './HostCommandReceiptStore'
import { HostDeltaStore, type HostDeltaStoreOptions } from './HostDeltaStore'

export interface HostRuntimeBootstrapOptions {
  /** Durable Host-owned directory shared by both stores. */
  hostDataDir: string
  delta?: Omit<HostDeltaStoreOptions, 'dataDir'>
  receipts?: Omit<HostCommandReceiptStoreOptions, 'dataDir' | 'getPosition'>
}

export interface HostRuntimeRecoverySummary {
  position: ReturnType<HostDeltaStore['getPosition']>
  delta: ReturnType<HostDeltaStore['getRecoveryState']>
  receipts: {
    size: number
    indeterminate: number
  }
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

  constructor(options: HostRuntimeBootstrapOptions) {
    if (!options.hostDataDir) {
      throw new Error('HostRuntimeBootstrap requires an injected hostDataDir')
    }

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

  getRecoverySummary(): HostRuntimeRecoverySummary {
    const receipts = this.receiptStore.list()
    return {
      position: this.deltaStore.getPosition(),
      delta: this.deltaStore.getRecoveryState(),
      receipts: {
        size: receipts.length,
        indeterminate: receipts.filter((receipt) => receipt.status === 'indeterminate').length
      }
    }
  }

  /** Flush both bounded journals into their durable checkpoints. */
  flush(): void {
    this.deltaStore.compact()
    this.receiptStore.compact()
  }
}
