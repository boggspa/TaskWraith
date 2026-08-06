/**
 * Wave 4.3b — Desktop Host command builders + deferred-receipt helpers.
 *
 * Mirrors `src/tui/hostCommandFlow.ts` for the sandboxed renderer. Production
 * mutations return pending receipts (authority ask). Desktop must never treat
 * pending as succeeded; it polls lookupReceipt until a terminal status, and
 * answers the Host ask via `approval.decide` submitted as a normal command.
 */

import {
  HOST_PROTOCOL_VERSION,
  type HostActorIdentity,
  type HostCommand,
  type HostCommandName,
  type HostCommandReceipt,
  type HostReceiptStatus
} from '../../../../shared/hostProtocol'

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

function mintId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  // Fallback for rare test hosts without Web Crypto — still unique enough for
  // local unit pins; production Electron renderer has crypto.randomUUID.
  return `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function mintHostCommandIds(): { commandId: string; idempotencyKey: string } {
  return { commandId: mintId(), idempotencyKey: mintId() }
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
  const ids = mintHostCommandIds()
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
      text: `Awaiting Host approval · ${receipt.name}`,
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
  /** Abort when true (e.g. unmounted). */
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
  const maxDelayMs = options.maxDelayMs ?? 1_500
  let delayMs = options.initialDelayMs ?? 200
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
