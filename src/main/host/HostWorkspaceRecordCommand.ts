/**
 * Desktop -> Host outbound client for the workspaces family.
 *
 * WHY THIS EXISTS: `workspaces.json` is the second file the cutover had to move.
 * Once the legacy writer gate is Host-owned, `AppStore` can no longer write it,
 * so adding, pinning, removing and clearing a workspace all fail. These three
 * commands are the Desktop side of the Host primitives landed in 379e2dd2e.
 *
 * IDENTITY IS LOAD-BEARING — this client uses TASKWRAITH_DESKTOP_HOST_ACTOR and
 * TASKWRAITH_DESKTOP_HOST_CLIENT_ID and must never mint a per-command client id.
 * All three commands sit behind the same exact-actor gate as thread.record.*,
 * which compares the authenticated socket client, the call-context actor AND
 * command.actor. A bespoke id is denied in production while every unit test that
 * injects its own actor still passes — that exact mistake was the blocker in
 * 9dcd59d16 that 257 green tests missed. The factory tests pin it.
 *
 * NO QUEUE HERE, DELIBERATELY. These are awaited one-shot mutations with few
 * callers, unlike the coalescing persist path that exists only because
 * AppStore.saveChat has 86 synchronous call sites.
 */

import { randomUUID } from 'node:crypto'

import type {
  HostActorIdentity,
  HostCapability,
  HostCommand,
  HostCommandName,
  HostCommandReceipt
} from '../../shared/hostProtocol'
import {
  HOST_PROTOCOL_VERSION,
  TASKWRAITH_DESKTOP_HOST_ACTOR,
  TASKWRAITH_DESKTOP_HOST_CLIENT_ID
} from '../../shared/hostProtocol'
import type {
  HostProjectionCommandResult,
  HostProjectionReceiptLookupResult
} from './HostProjectionBroker'
import { createHostProjectionBroker } from './HostProjectionBroker'

/** Mirrors the persist client exactly: a proven submit + receipt-poll capability set. */
const WORKSPACE_HOST_CAPABILITIES = [
  'bootstrap',
  'commands',
  'receipts',
  'setup'
] as const satisfies readonly HostCapability[]

export type HostWorkspaceRecordErrorCode =
  | 'invalid_input'
  | 'host_unavailable'
  | 'host_timeout'
  | 'invalid_host_receipt'
  | 'host_rejected'

export class HostWorkspaceRecordError extends Error {
  readonly code: HostWorkspaceRecordErrorCode
  /** Raw Host error code when the Host rejected the command; preserved, never swallowed. */
  readonly hostErrorCode?: string
  readonly receipt?: HostCommandReceipt

  constructor(
    code: HostWorkspaceRecordErrorCode,
    message: string,
    options?: { hostErrorCode?: string; receipt?: HostCommandReceipt; cause?: unknown }
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'HostWorkspaceRecordError'
    this.code = code
    if (options?.hostErrorCode !== undefined) this.hostErrorCode = options.hostErrorCode
    if (options?.receipt !== undefined) this.receipt = options.receipt
  }
}

export interface HostWorkspaceRecordBrokerPort {
  submitCommand(command: HostCommand): Promise<HostProjectionCommandResult>
  lookupReceipt(commandId: string): Promise<HostProjectionReceiptLookupResult>
}

/**
 * Exactly the fields workspace.record.upsert accepts.
 *
 * `realPath` is DELIBERATELY ABSENT: the wire forbids a caller-asserted real
 * path and the Host canonicalizes the selected path itself. On macOS that is not
 * cosmetic — /var canonicalizes to /private/var — so a Desktop-computed value
 * could legitimately disagree with the Host's.
 */
export interface HostWorkspaceRecordUpsertInput {
  readonly workspaceId: string
  readonly path: string
  readonly displayName: string
  readonly createdAt: number
  readonly lastOpenedAt: number
  readonly pinned: boolean
  readonly branch?: string
  readonly geminiWorktree?: { readonly enabled: boolean; readonly name?: string }
}

export interface HostWorkspaceRecordRemoveResult {
  /** False when the record was already absent — the Host treats that as success. */
  readonly removed: boolean
  readonly receipt: HostCommandReceipt
}

export interface HostWorkspaceRecordsClearResult {
  /** False when the file was already empty — the Host treats that as success. */
  readonly cleared: boolean
  readonly receipt: HostCommandReceipt
}

/** The seam the store/service wiring depends on. */
export interface HostWorkspaceRecordPort {
  upsertWorkspaceRecord(input: HostWorkspaceRecordUpsertInput): Promise<HostCommandReceipt>
  removeWorkspaceRecord(workspaceId: string): Promise<HostWorkspaceRecordRemoveResult>
  clearWorkspaceRecords(): Promise<HostWorkspaceRecordsClearResult>
}

export interface HostWorkspaceRecordClientOptions {
  readonly broker: HostWorkspaceRecordBrokerPort
  readonly actor?: HostActorIdentity
  readonly nowMs?: () => number
  readonly createId?: () => string
  readonly wait?: (milliseconds: number) => Promise<void>
  readonly pollIntervalMs?: number
  readonly timeoutMs?: number
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function receiptMatches(
  command: HostCommand,
  receipt: HostCommandReceipt,
  actor: HostActorIdentity
): boolean {
  return (
    receipt.commandId === command.commandId &&
    receipt.idempotencyKey === command.idempotencyKey &&
    receipt.name === command.name &&
    receipt.actor.actorId === actor.actorId &&
    receipt.actor.clientId === actor.clientId &&
    receipt.actor.clientClass === actor.clientClass
  )
}

export class HostWorkspaceRecordClient implements HostWorkspaceRecordPort {
  private readonly broker: HostWorkspaceRecordBrokerPort
  private readonly actor: HostActorIdentity
  private readonly nowMs: () => number
  private readonly createId: () => string
  private readonly wait: (milliseconds: number) => Promise<void>
  private readonly pollIntervalMs: number
  private readonly timeoutMs: number

  constructor(options: HostWorkspaceRecordClientOptions) {
    if (
      !options?.broker ||
      typeof options.broker.submitCommand !== 'function' ||
      typeof options.broker.lookupReceipt !== 'function'
    ) {
      throw new Error('HostWorkspaceRecordClient requires a Host broker.')
    }
    this.broker = options.broker
    this.actor = options.actor ?? { ...TASKWRAITH_DESKTOP_HOST_ACTOR }
    this.nowMs = options.nowMs ?? Date.now
    this.createId = options.createId ?? randomUUID
    this.wait = options.wait ?? defaultWait
    this.pollIntervalMs = Math.max(25, options.pollIntervalMs ?? 250)
    this.timeoutMs = Math.max(this.pollIntervalMs, options.timeoutMs ?? 30_000)
  }

  /**
   * NOTE FOR THE WIRING SLICE — the Host's canonical record is NOT returned.
   *
   * HostProfileDomainStore.upsertWorkspaceRecord computes `realPath` and returns
   * the full record, but HostNodeDomainPorts collapses it to the constant
   * resultSummary 'workspace_record_upserted', and HostWorkspaceProjection
   * carries no realPath either. So no wire surface exposes it today and this
   * method can only report that the write succeeded. Desktop must keep its own
   * realPath for now; adopting the Host's requires a Host-side change.
   */
  async upsertWorkspaceRecord(input: HostWorkspaceRecordUpsertInput): Promise<HostCommandReceipt> {
    this.assertUpsertInput(input)
    const args: Record<string, unknown> = {
      path: input.path,
      displayName: input.displayName,
      createdAt: input.createdAt,
      lastOpenedAt: input.lastOpenedAt,
      pinned: input.pinned
    }
    // Omitted optional metadata is PRESERVED by the Host on partial updates, so
    // undefined must stay absent rather than being sent as an explicit key.
    if (input.branch !== undefined) args.branch = input.branch
    if (input.geminiWorktree !== undefined) {
      const worktree: Record<string, unknown> = { enabled: input.geminiWorktree.enabled }
      if (input.geminiWorktree.name !== undefined) worktree.name = input.geminiWorktree.name
      args.geminiWorktree = worktree
    }
    return this.execute(
      this.buildCommand('workspace.record.upsert', { workspaceId: input.workspaceId }, args)
    )
  }

  async removeWorkspaceRecord(workspaceId: string): Promise<HostWorkspaceRecordRemoveResult> {
    this.assertId(workspaceId, 'A workspace id is required to remove a workspace record.')
    const receipt = await this.execute(
      this.buildCommand('workspace.record.remove', { workspaceId }, {})
    )
    return { removed: receipt.resultSummary === 'workspace_record_removed', receipt }
  }

  async clearWorkspaceRecords(): Promise<HostWorkspaceRecordsClearResult> {
    // The wire requires BOTH an empty target and empty arguments for this one.
    const receipt = await this.execute(this.buildCommand('workspace.records.clear', {}, {}))
    return { cleared: receipt.resultSummary === 'workspace_records_cleared', receipt }
  }

  private buildCommand(
    name: HostCommandName,
    target: Record<string, string>,
    args: Record<string, unknown>
  ): HostCommand {
    const commandId = this.createId()
    return {
      type: 'host.command',
      protocolVersion: HOST_PROTOCOL_VERSION,
      commandId,
      idempotencyKey: `${name}:${commandId}`,
      actor: { ...this.actor },
      name,
      target,
      arguments: args,
      issuedAt: new Date(this.nowMs()).toISOString()
    }
  }

  private assertUpsertInput(input: HostWorkspaceRecordUpsertInput): void {
    this.assertId(input?.workspaceId, 'A workspace id is required to upsert a workspace record.')
    if (typeof input.path !== 'string' || input.path.length === 0) {
      throw new HostWorkspaceRecordError('invalid_input', 'A workspace path is required.')
    }
    if (typeof input.displayName !== 'string' || input.displayName.length === 0) {
      throw new HostWorkspaceRecordError('invalid_input', 'A workspace display name is required.')
    }
    for (const [label, value] of [
      ['createdAt', input.createdAt],
      ['lastOpenedAt', input.lastOpenedAt]
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new HostWorkspaceRecordError(
          'invalid_input',
          `Workspace ${label} must be a non-negative integer.`
        )
      }
    }
    if (typeof input.pinned !== 'boolean') {
      throw new HostWorkspaceRecordError('invalid_input', 'Workspace pinned must be a boolean.')
    }
    if (
      input.branch !== undefined &&
      (typeof input.branch !== 'string' || input.branch.length === 0)
    ) {
      throw new HostWorkspaceRecordError(
        'invalid_input',
        'Workspace branch must be a non-empty string.'
      )
    }
    if (input.geminiWorktree !== undefined && typeof input.geminiWorktree.enabled !== 'boolean') {
      throw new HostWorkspaceRecordError(
        'invalid_input',
        'Workspace geminiWorktree.enabled must be a boolean.'
      )
    }
  }

  private assertId(value: unknown, message: string): void {
    if (typeof value !== 'string' || value.length === 0) {
      throw new HostWorkspaceRecordError('invalid_input', message)
    }
  }

  private async execute(command: HostCommand): Promise<HostCommandReceipt> {
    const submitted = await this.broker.submitCommand(command)
    let receipt: HostCommandReceipt
    if (submitted.ok) {
      receipt = submitted.receipt
    } else {
      const recovered = await this.broker.lookupReceipt(command.commandId)
      if (!recovered.ok) {
        throw new HostWorkspaceRecordError(
          'host_unavailable',
          submitted.error.slice(0, 200) || 'The Host did not accept the workspace command.'
        )
      }
      receipt = recovered.receipt
    }

    let settled = this.settle(command, receipt)
    if (settled) return settled
    const deadline = this.nowMs() + this.timeoutMs
    while (this.nowMs() < deadline) {
      await this.wait(this.pollIntervalMs)
      const lookup = await this.broker.lookupReceipt(command.commandId)
      if (!lookup.ok) {
        throw new HostWorkspaceRecordError(
          'host_unavailable',
          lookup.error.slice(0, 200) || 'The Host receipt could not be read.'
        )
      }
      settled = this.settle(command, lookup.receipt)
      if (settled) return settled
    }
    throw new HostWorkspaceRecordError(
      'host_timeout',
      'The Host workspace command did not settle before the timeout.'
    )
  }

  /** Returns the receipt once terminal, null while pending, throws on rejection. */
  private settle(command: HostCommand, receipt: HostCommandReceipt): HostCommandReceipt | null {
    if (!receiptMatches(command, receipt, this.actor)) {
      throw new HostWorkspaceRecordError(
        'invalid_host_receipt',
        'Host receipt did not match the workspace command.',
        { receipt }
      )
    }
    if (receipt.status === 'pending') return null
    if (receipt.status === 'succeeded') return receipt
    const hostErrorCode = typeof receipt.errorCode === 'string' ? receipt.errorCode : undefined
    throw new HostWorkspaceRecordError(
      'host_rejected',
      receipt.errorMessage ?? `The Host workspace command ended with ${receipt.status}.`,
      { ...(hostErrorCode ? { hostErrorCode } : {}), receipt }
    )
  }
}

export function createDesktopHostWorkspaceRecordClient(input: {
  userDataPath: string
  appVersion: string
}): HostWorkspaceRecordClient {
  const broker = createHostProjectionBroker({
    userDataPath: input.userDataPath,
    appVersion: input.appVersion,
    client: {
      clientId: TASKWRAITH_DESKTOP_HOST_CLIENT_ID,
      clientClass: TASKWRAITH_DESKTOP_HOST_ACTOR.clientClass,
      clientVersion: input.appVersion
    },
    actor: { ...TASKWRAITH_DESKTOP_HOST_ACTOR },
    capabilities: WORKSPACE_HOST_CAPABILITIES
  })
  return new HostWorkspaceRecordClient({ broker, actor: { ...TASKWRAITH_DESKTOP_HOST_ACTOR } })
}
