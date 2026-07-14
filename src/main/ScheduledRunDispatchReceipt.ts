import { createHash } from 'node:crypto'
import type { AgentRunPayload } from './run/AgentRunTypes'

const RECEIPT_ERROR = 'Scheduled run dispatch receipt is missing, stale, or does not match.'
const DEFAULT_TTL_MS = 5 * 60 * 1000
const DEFAULT_MAX_RECEIPTS = 128

interface ScheduledRunDispatchReceipt {
  senderId: number
  scheduledTaskId: string
  appRunId: string
  payload: AgentRunPayload
  payloadHash: string
  expiresAt: number
}

export interface ScheduledRunDispatchReceiptRegistryOptions {
  now?: () => number
  ttlMs?: number
  maxReceipts?: number
}

/**
 * One-shot bridge between `compose-run` and `run-agent` for unattended work.
 * The renderer gets a copy of the composed payload, while main retains the
 * canonical copy and only releases that copy after an exact, same-sender
 * handoff. Renderer-only routing fields are deliberately ignored and then
 * discarded; scheduled dispatch never inherits an interactive worktree pick.
 */
export class ScheduledRunDispatchReceiptRegistry {
  private readonly receipts = new Map<string, ScheduledRunDispatchReceipt>()
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly maxReceipts: number

  constructor(options: ScheduledRunDispatchReceiptRegistryOptions = {}) {
    this.now = options.now ?? Date.now
    this.ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_TTL_MS)
    this.maxReceipts = Math.max(1, options.maxReceipts ?? DEFAULT_MAX_RECEIPTS)
  }

  issue(input: {
    senderId: number
    scheduledTaskId: string
    appRunId: string
    payload: AgentRunPayload
  }): void {
    this.prune()
    const payload = clonePayload(input.payload)
    const receipt: ScheduledRunDispatchReceipt = {
      senderId: input.senderId,
      scheduledTaskId: input.scheduledTaskId,
      appRunId: input.appRunId,
      payload,
      payloadHash: payloadHash(payload),
      expiresAt: this.now() + this.ttlMs
    }
    this.receipts.set(receiptKey(input), receipt)
    while (this.receipts.size > this.maxReceipts) {
      const oldest = this.receipts.keys().next().value
      if (typeof oldest !== 'string') break
      this.receipts.delete(oldest)
    }
  }

  consume(input: {
    senderId: number
    scheduledTaskId: string
    appRunId: string
    payload: AgentRunPayload
  }): AgentRunPayload {
    this.prune()
    const key = receiptKey(input)
    const receipt = this.receipts.get(key)
    if (!receipt || receipt.payloadHash !== payloadHash(input.payload)) {
      throw new Error(RECEIPT_ERROR)
    }
    this.receipts.delete(key)
    return clonePayload(receipt.payload)
  }

  revokeSender(senderId: number): void {
    for (const [key, receipt] of this.receipts) {
      if (receipt.senderId === senderId) this.receipts.delete(key)
    }
  }

  private prune(): void {
    const now = this.now()
    for (const [key, receipt] of this.receipts) {
      if (receipt.expiresAt <= now) this.receipts.delete(key)
    }
  }
}

function receiptKey(input: {
  senderId: number
  scheduledTaskId: string
  appRunId: string
}): string {
  return `${input.senderId}\u0000${input.scheduledTaskId}\u0000${input.appRunId}`
}

function payloadHash(payload: AgentRunPayload): string {
  const comparable = { ...(payload as AgentRunPayload & Record<string, unknown>) }
  delete comparable.scheduledTaskId
  delete comparable.runtimeWorktree
  delete comparable.effectiveWorkspacePath
  return createHash('sha256').update(stableStringify(comparable)).digest('hex')
}

function clonePayload(payload: AgentRunPayload): AgentRunPayload {
  return structuredClone(payload)
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`
}
