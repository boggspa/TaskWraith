/**
 * Wave 4.2b — Host command builders + deferred-receipt resolution helpers.
 *
 * Production mutations return pending receipts (authority ask). The TUI must
 * never treat pending as succeeded; it polls lookupReceipt until a terminal
 * status, and may answer the Host ask via approval.decide.
 */

import { mintHostCommandIdentity } from '../main/host/HostCommandIdentity'
import {
  HOST_PROTOCOL_VERSION,
  type HostActorIdentity,
  type HostCommand,
  type HostCommandName,
  type HostCommandReceipt,
  type HostReceiptStatus
} from '../shared/hostProtocol'

export const HOST_RECEIPT_TERMINAL_STATUSES: ReadonlySet<HostReceiptStatus> = new Set([
  'succeeded',
  'failed',
  'denied',
  'cancelled',
  'indeterminate',
  'conflict'
])

export function isTerminalHostReceiptStatus(status: HostReceiptStatus): boolean {
  return HOST_RECEIPT_TERMINAL_STATUSES.has(status)
}

export function mintHostCommandIds(actor: HostActorIdentity): {
  commandId: string
  idempotencyKey: string
} {
  const identity = mintHostCommandIdentity({
    actorId: actor.actorId,
    clientId: actor.clientId,
    clientClass: actor.clientClass
  })
  if (!identity.ok) {
    throw new Error(`Could not mint Host command identity: ${identity.error}`)
  }
  return {
    commandId: identity.value.commandId,
    idempotencyKey: identity.value.idempotencyKey
  }
}

export function buildHostCommand(input: {
  name: HostCommandName
  actor: HostActorIdentity
  target: Record<string, string>
  arguments?: Record<string, unknown>
  commandId?: string
  idempotencyKey?: string
  issuedAt?: string
}): HostCommand {
  const ids = mintHostCommandIds(input.actor)
  return {
    type: 'host.command',
    protocolVersion: HOST_PROTOCOL_VERSION,
    commandId: input.commandId ?? ids.commandId,
    idempotencyKey: input.idempotencyKey ?? ids.idempotencyKey,
    actor: input.actor,
    name: input.name,
    target: input.target,
    arguments: input.arguments ?? {},
    issuedAt: input.issuedAt ?? new Date().toISOString()
  }
}

/** Human-readable notice for a receipt — never invents success from pending. */
export function describeHostReceipt(receipt: HostCommandReceipt): {
  text: string
  tone: 'neutral' | 'good' | 'warning' | 'error'
} {
  if (receipt.status === 'pending' || receipt.authority.decision === 'ask') {
    return {
      text: `Awaiting Host approval · ${receipt.name} · y accept / n decline`,
      tone: 'warning'
    }
  }
  if (receipt.status === 'succeeded') {
    return { text: `Host accepted ${receipt.name}`, tone: 'good' }
  }
  if (receipt.status === 'denied') {
    return {
      text: receipt.errorMessage?.trim() || `Host denied ${receipt.name}`,
      tone: 'error'
    }
  }
  if (receipt.status === 'cancelled') {
    return { text: `Host cancelled ${receipt.name}`, tone: 'warning' }
  }
  if (receipt.status === 'conflict') {
    return { text: `Host command conflict · ${receipt.name}`, tone: 'error' }
  }
  if (receipt.status === 'indeterminate') {
    return {
      text:
        receipt.errorMessage?.trim() ||
        `Host receipt indeterminate · ${receipt.name}${receipt.errorCode ? ` (${receipt.errorCode})` : ''}`,
      tone: 'error'
    }
  }
  return {
    text: receipt.errorMessage?.trim() || `Host failed ${receipt.name}`,
    tone: 'error'
  }
}

export interface PollHostReceiptOptions {
  lookup: (commandId: string) => Promise<HostCommandReceipt>
  commandId: string
  /** Max wait before giving up (still returns last pending receipt). */
  timeoutMs?: number
  /** Initial delay between polls. */
  initialDelayMs?: number
  /** Cap on exponential backoff. */
  maxDelayMs?: number
  sleep?: (ms: number) => Promise<void>
  /** Abort when true (e.g. TUI stopped). */
  shouldAbort?: () => boolean
  onTick?: (receipt: HostCommandReceipt) => void
}

/**
 * Poll lookupReceipt by commandId until terminal or timeout.
 * Pending is never rewritten as succeeded.
 */
export async function pollHostReceiptUntilTerminal(
  options: PollHostReceiptOptions
): Promise<HostCommandReceipt> {
  const timeoutMs = options.timeoutMs ?? 60_000
  const maxDelayMs = options.maxDelayMs ?? 2_000
  let delayMs = options.initialDelayMs ?? 250
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const started = Date.now()
  let last = await options.lookup(options.commandId)
  options.onTick?.(last)
  while (!isTerminalHostReceiptStatus(last.status)) {
    if (options.shouldAbort?.()) return last
    if (Date.now() - started >= timeoutMs) return last
    await sleep(delayMs)
    if (options.shouldAbort?.()) return last
    last = await options.lookup(options.commandId)
    options.onTick?.(last)
    delayMs = Math.min(maxDelayMs, Math.max(delayMs * 2, delayMs + 50))
  }
  return last
}
