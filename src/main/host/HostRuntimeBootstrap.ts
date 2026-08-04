import {
  HostCommandReceiptStore,
  type HostCommandReceiptStoreOptions
} from './HostCommandReceiptStore'
import { HostDeltaStore, type HostDeltaStoreOptions } from './HostDeltaStore'
import {
  HostDeferredCommandEnvelopeStore,
  type HostDeferredCommandEnvelopeRecoverySummary,
  type HostDeferredCommandEnvelopeStoreOptions
} from './HostDeferredCommandEnvelopeStore'

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
  envelopes?: Omit<HostDeferredCommandEnvelopeStoreOptions, 'dataDir'>
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
  /**
   * Body-free envelope-store recovery owned by bootstrap. Always present on
   * summaries returned by HostRuntimeBootstrap; optional for legacy consumers.
   */
  envelopes?: HostDeferredCommandEnvelopeRecoverySummary
}

export type HostRuntimeRecoverySummaryWithDeferred = HostRuntimeRecoverySummary & {
  deferred: HostRuntimeDeferredRecoverySummary
  envelopes: HostDeferredCommandEnvelopeRecoverySummary
}

/**
 * Electron-free composition boundary for the durable Host stores.
 *
 * This class owns no domain state or position counters: generation/cursor are
 * always read from HostDeltaStore, while receipts remain independently durable.
 * Receipt minting receives position only through the delta-backed getPosition
 * callback — never a second journal.
 *
 * HostDeferredCommandEnvelopeStore is constructed here for restart-safe deferred
 * command bodies. Bridge / resolver / pipelines / Authority are NOT constructed
 * by bootstrap — the bridge half of deferred recovery remains adapter-supplied.
 */
export class HostRuntimeBootstrap {
  readonly deltaStore: HostDeltaStore
  readonly receiptStore: HostCommandReceiptStore
  readonly envelopeStore: HostDeferredCommandEnvelopeStore
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
    this.envelopeStore = new HostDeferredCommandEnvelopeStore({
      ...options.envelopes,
      dataDir: options.hostDataDir
    })
  }

  getPosition(): ReturnType<HostDeltaStore['getPosition']> {
    return this.deltaStore.getPosition()
  }

  getRecoverySummary(): HostRuntimeRecoverySummaryWithDeferred {
    const receipts = this.receiptStore.list()
    const receiptIndeterminate = receipts.filter((receipt) => receipt.status === 'indeterminate')
    const envelopes = this.envelopeStore.getRecoverySummary()
    const deferred = summarizeDeferredRecoveryForBootstrap(
      envelopes,
      this.deferredRecovery,
      receiptIndeterminate
    )
    return {
      position: this.deltaStore.getPosition(),
      delta: this.deltaStore.getRecoveryState(),
      receipts: {
        size: receipts.length,
        indeterminate: receiptIndeterminate.length
      },
      deferred,
      envelopes
    }
  }

  /** Flush durable journals into their durable checkpoints. */
  flush(): void {
    this.deltaStore.compact()
    this.receiptStore.compact()
    this.envelopeStore.compact()
  }
}

const UNAVAILABLE_DEFERRED: HostRuntimeDeferredRecoverySummary = {
  availability: 'unavailable',
  size: null,
  indeterminate: null,
  uniqueIndeterminateCommandCount: null
}

/**
 * Deferred recovery composition:
 * - Envelope store unavailable ⇒ deferred unavailable (fail closed; never heal/hide).
 * - Bridge adapter present ⇒ existing adapter summarizer (bridge half stays supplied).
 * - Otherwise ⇒ body-free envelope recovery mapped into the deferred summary shape.
 */
function summarizeDeferredRecoveryForBootstrap(
  envelopes: HostDeferredCommandEnvelopeRecoverySummary,
  source: HostRuntimeDeferredRecoverySource | undefined,
  receiptIndeterminate: readonly { commandId: string }[]
): HostRuntimeDeferredRecoverySummary {
  if (envelopes.availability === 'unavailable') {
    return UNAVAILABLE_DEFERRED
  }

  if (source) {
    return summarizeDeferredRecovery(source, receiptIndeterminate).summary
  }

  return summarizeEnvelopeAsDeferred(envelopes, receiptIndeterminate)
}

function summarizeEnvelopeAsDeferred(
  envelopes: Extract<HostDeferredCommandEnvelopeRecoverySummary, { availability: 'available' }>,
  receiptIndeterminate: readonly { commandId: string }[]
): HostRuntimeDeferredRecoverySummary {
  const uniqueIndeterminateCommandIds = new Set<string>()
  for (const receipt of receiptIndeterminate) {
    if (typeof receipt.commandId === 'string' && receipt.commandId.length > 0) {
      uniqueIndeterminateCommandIds.add(receipt.commandId)
    }
  }
  for (const commandId of envelopes.quarantinedCommandIds) {
    uniqueIndeterminateCommandIds.add(commandId)
  }

  return {
    availability: 'available',
    size: envelopes.size,
    indeterminate: envelopes.quarantined,
    uniqueIndeterminateCommandCount: uniqueIndeterminateCommandIds.size
  }
}

function summarizeDeferredRecovery(
  source: HostRuntimeDeferredRecoverySource | undefined,
  receiptIndeterminate: readonly { commandId: string }[]
): { summary: HostRuntimeDeferredRecoverySummary } {
  if (!source || typeof source !== 'object' || typeof source.list !== 'function') {
    return { summary: UNAVAILABLE_DEFERRED }
  }

  let records: readonly HostRuntimeDeferredRecoveryRecord[]
  try {
    records = source.list()
  } catch {
    return { summary: UNAVAILABLE_DEFERRED }
  }

  if (!Array.isArray(records) || records.length > MAX_DEFERRED_RECOVERY_RECORDS) {
    return { summary: UNAVAILABLE_DEFERRED }
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
      return { summary: UNAVAILABLE_DEFERRED }
    }
    if (
      typeof record.commandId !== 'string' ||
      record.commandId.length === 0 ||
      record.commandId.length > MAX_DEFERRED_RECOVERY_COMMAND_ID_CHARS ||
      typeof record.state !== 'string'
    ) {
      return { summary: UNAVAILABLE_DEFERRED }
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
