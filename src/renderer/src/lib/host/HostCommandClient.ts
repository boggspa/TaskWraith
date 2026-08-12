/**
 * Wave 4.3b — Desktop Host command client over the IPC projection bridge.
 *
 * Receipt mechanism (same contract as TUI 4.2b):
 * - submitCommand returns the initial receipt
 * - pending / authority.ask is NEVER treated as success
 * - poll lookupReceipt with bounded backoff (200ms → 1.5s, 60s cap)
 * - optional snapshot refresh after first pending so approval cards can bind
 * - approval.decide is a Host command submitted through the same submit path
 */

import type {
  HostActorIdentity,
  HostApprovalDecideDecision,
  HostCommand,
  HostCommandName,
  HostCommandReceipt,
  HostSnapshot
} from '../../../../shared/hostProtocol'
import {
  buildHostCommand,
  describeHostReceipt,
  isTerminalHostReceiptStatus,
  pollHostReceiptUntilTerminal
} from './hostCommandFlow'

export type HostCommandBridgeResult =
  | { readonly ok: true; readonly receipt: HostCommandReceipt }
  | { readonly ok: false; readonly error: string }

export interface HostCommandBridge {
  hostProjectionCommandSubmit(command: HostCommand): Promise<HostCommandBridgeResult>
  hostProjectionReceiptLookup(params: { commandId: string }): Promise<HostCommandBridgeResult>
}

export interface HostCommandClientOptions {
  /** IPC bridge; omit to read `window.api`. */
  bridge?: HostCommandBridge | null
  /** Actor stamped on every command this client mints. */
  actor: HostActorIdentity
  /**
   * Optional snapshot refresh after the first pending receipt so approval
   * projections can bind commandId → approvalId (Wave 4.2c join key).
   */
  refreshSnapshot?: () => Promise<HostSnapshot>
  /** Poll timeout (default 60s). */
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  shouldAbort?: () => boolean
}

export type HostCommandRunOutcome =
  | {
      readonly kind: 'terminal'
      readonly receipt: HostCommandReceipt
      readonly description: ReturnType<typeof describeHostReceipt>
    }
  | {
      readonly kind: 'pending-timeout'
      readonly receipt: HostCommandReceipt
      readonly description: ReturnType<typeof describeHostReceipt>
    }
  | {
      readonly kind: 'error'
      readonly error: string
    }

export const HOST_COMMAND_BRIDGE_UNAVAILABLE = 'host command bridge unavailable'
export const HOST_COMMAND_BRIDGE_MALFORMED = 'host command bridge returned an invalid result'

export interface HostCommandSubmitInput {
  name: HostCommandName
  target: Record<string, string>
  arguments?: Record<string, unknown>
  commandId?: string
  idempotencyKey?: string
}

export interface HostCommandSubmitHooks {
  onPending?: (receipt: HostCommandReceipt, approvalId?: string) => void
  onTick?: (receipt: HostCommandReceipt) => void
}

function defaultBridge(): HostCommandBridge | null {
  const api = (globalThis as { window?: { api?: unknown } }).window?.api as
    | Partial<HostCommandBridge>
    | undefined
  if (
    !api ||
    typeof api.hostProjectionCommandSubmit !== 'function' ||
    typeof api.hostProjectionReceiptLookup !== 'function'
  ) {
    return null
  }
  return api as HostCommandBridge
}

function unwrapReceipt(result: HostCommandBridgeResult | null | undefined): HostCommandReceipt {
  if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
    throw new Error(HOST_COMMAND_BRIDGE_MALFORMED)
  }
  if (!result.ok) {
    throw new Error(result.error || HOST_COMMAND_BRIDGE_MALFORMED)
  }
  if (!result.receipt || typeof result.receipt !== 'object') {
    throw new Error(HOST_COMMAND_BRIDGE_MALFORMED)
  }
  return result.receipt
}

/**
 * Find a pending approval whose `commandId` matches (Wave 4.2c join key).
 * Returns undefined when the snapshot has no matching card — callers must not
 * invent a correlation.
 */
export function findPendingApprovalId(
  snapshot: HostSnapshot | null | undefined,
  commandId: string
): string | undefined {
  if (!snapshot || typeof commandId !== 'string' || commandId.length === 0) return undefined
  const approvals = snapshot.approvals
  if (!Array.isArray(approvals)) return undefined
  for (const approval of approvals) {
    if (
      approval &&
      typeof approval === 'object' &&
      approval.status === 'pending' &&
      approval.commandId === commandId &&
      typeof approval.approvalId === 'string' &&
      approval.approvalId.length > 0
    ) {
      return approval.approvalId
    }
  }
  return undefined
}

export class HostCommandClient {
  private readonly resolveBridge: () => HostCommandBridge | null
  private readonly actor: HostActorIdentity
  private readonly refreshSnapshot?: () => Promise<HostSnapshot>
  private readonly timeoutMs: number
  private readonly sleep?: (ms: number) => Promise<void>
  private readonly shouldAbort?: () => boolean
  private mutationInFlight = false
  private activeRequests = 0

  constructor(options: HostCommandClientOptions) {
    if (!options || typeof options !== 'object') {
      throw new Error('HostCommandClient requires options')
    }
    if (!options.actor || typeof options.actor !== 'object') {
      throw new Error('HostCommandClient requires an actor')
    }
    this.actor = options.actor
    this.refreshSnapshot = options.refreshSnapshot
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.sleep = options.sleep
    this.shouldAbort = options.shouldAbort
    const injected = options.bridge
    this.resolveBridge = () => (injected === undefined ? defaultBridge() : injected)
  }

  get busy(): boolean {
    return this.activeRequests > 0
  }

  async submitAndResolve(
    input: HostCommandSubmitInput,
    hooks: HostCommandSubmitHooks = {}
  ): Promise<HostCommandRunOutcome> {
    // Response commands resolve an existing Host ask. They must be allowed
    // while the original mutation is polling its pending receipt; otherwise
    // Desktop can display an approval and can never answer it. Ordinary
    // mutations remain serialized.
    const isResponse = input.name === 'approval.decide' || input.name === 'question.answer'
    if (!isResponse && this.mutationInFlight) {
      return { kind: 'error', error: 'A Host command is already in flight.' }
    }
    const bridge = this.resolveBridge()
    if (!bridge) {
      return { kind: 'error', error: HOST_COMMAND_BRIDGE_UNAVAILABLE }
    }

    const command = buildHostCommand({
      name: input.name,
      actor: this.actor,
      target: input.target,
      arguments: input.arguments,
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey
    })

    if (!isResponse) this.mutationInFlight = true
    this.activeRequests += 1
    try {
      const initial = unwrapReceipt(await bridge.hostProjectionCommandSubmit(command))

      if (initial.status === 'pending' || initial.authority.decision === 'ask') {
        let approvalId: string | undefined
        if (this.refreshSnapshot) {
          try {
            const snapshot = await this.refreshSnapshot()
            approvalId = findPendingApprovalId(snapshot, command.commandId)
          } catch {
            // Snapshot refresh failure must not invent a terminal outcome.
          }
        }
        hooks.onPending?.(initial, approvalId)

        const terminal = await pollHostReceiptUntilTerminal({
          commandId: command.commandId,
          timeoutMs: this.timeoutMs,
          initialDelayMs: 200,
          maxDelayMs: 1_500,
          sleep: this.sleep,
          shouldAbort: this.shouldAbort,
          lookup: async (commandId) =>
            unwrapReceipt(await bridge.hostProjectionReceiptLookup({ commandId })),
          onTick: hooks.onTick
        })

        if (!isTerminalHostReceiptStatus(terminal.status)) {
          return {
            kind: 'pending-timeout',
            receipt: terminal,
            description: describeHostReceipt(terminal)
          }
        }
        return {
          kind: 'terminal',
          receipt: terminal,
          description: describeHostReceipt(terminal)
        }
      }

      return {
        kind: 'terminal',
        receipt: initial,
        description: describeHostReceipt(initial)
      }
    } catch (error) {
      return {
        kind: 'error',
        error: error instanceof Error ? error.message : String(error)
      }
    } finally {
      this.activeRequests = Math.max(0, this.activeRequests - 1)
      if (!isResponse) this.mutationInFlight = false
    }
  }

  /**
   * Answer a Host ask. Uses the Wave 4.2c join: approvalId in target, and the
   * original commandId is the caller's correlation (not rewritten here).
   */
  async decideApproval(input: {
    approvalId: string
    decision: HostApprovalDecideDecision
    message?: string
  }): Promise<HostCommandRunOutcome> {
    return this.submitAndResolve({
      name: 'approval.decide',
      target: { approvalId: input.approvalId },
      arguments: {
        decision: input.decision,
        ...(input.message !== undefined ? { message: input.message } : {})
      }
    })
  }
}
