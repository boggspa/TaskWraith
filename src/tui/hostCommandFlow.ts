/**
 * Wave 4.2b — Host command builders + deferred-receipt resolution helpers.
 *
 * Production mutations return pending receipts (authority ask). The TUI must
 * never treat pending as succeeded; it polls lookupReceipt until a terminal
 * status, and may answer the Host ask via approval.decide.
 */

import { mintHostCommandIdentity } from '../host-shared/HostCommandIdentity'
import {
  HOST_PROTOCOL_VERSION,
  type HostActorIdentity,
  type HostCommand,
  type HostCommandName,
  type HostCommandReceipt,
  type HostResultRef,
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

export function buildWorkspaceRegisterCommand(input: {
  actor: HostActorIdentity
  path: string
  displayName?: string
  pinned?: boolean
  commandId?: string
  idempotencyKey?: string
}): HostCommand {
  return buildHostCommand({
    name: 'workspace.register',
    actor: input.actor,
    target: {},
    arguments: {
      path: input.path,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(typeof input.pinned === 'boolean' ? { pinned: input.pinned } : {})
    },
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey
  })
}

export function buildThreadCreateCommand(input: {
  actor: HostActorIdentity
  scope: 'global' | 'workspace'
  workspaceId?: string
  title?: string
  commandId?: string
  idempotencyKey?: string
}): HostCommand {
  if (input.scope === 'workspace' && !input.workspaceId) {
    throw new Error('Workspace thread creation requires workspaceId.')
  }
  return buildHostCommand({
    name: 'thread.create',
    actor: input.actor,
    target: {},
    arguments: {
      scope: input.scope,
      ...(input.scope === 'workspace' ? { workspaceId: input.workspaceId! } : {}),
      ...(input.title ? { title: input.title } : {})
    },
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey
  })
}

export type ThreadConfigureOfferSelection = {
  readonly threadId: string
  readonly providerId: string
  readonly modelId: string
  readonly postureId: string
  readonly offerRevision: string
  readonly reasoningId?: string
  readonly title?: string
  readonly postureConsent?: true
}

export type ThreadConfigureTitleSelection = {
  readonly threadId: string
  readonly title: string
}

/** Full offer-bound selection or a title-only edit; no partial provider patch exists. */
export type ThreadConfigureSelection = ThreadConfigureOfferSelection | ThreadConfigureTitleSelection

export function buildThreadConfigureCommand(input: {
  actor: HostActorIdentity
  selection: ThreadConfigureSelection
  commandId?: string
  idempotencyKey?: string
}): HostCommand {
  const selection = input.selection
  const offerSelection = 'providerId' in selection
  return buildHostCommand({
    name: 'thread.configure',
    actor: input.actor,
    target: { threadId: selection.threadId },
    arguments: offerSelection
      ? {
          providerId: selection.providerId,
          modelId: selection.modelId,
          postureId: selection.postureId,
          offerRevision: selection.offerRevision,
          ...(selection.reasoningId ? { reasoningId: selection.reasoningId } : {}),
          ...(selection.title ? { title: selection.title } : {}),
          ...(selection.postureConsent === true ? { postureConsent: true } : {})
        }
      : { title: selection.title },
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey
  })
}

export function buildThreadArchiveCommand(input: {
  actor: HostActorIdentity
  threadId: string
  archived: boolean
  commandId?: string
  idempotencyKey?: string
}): HostCommand {
  return buildHostCommand({
    name: 'thread.archive',
    actor: input.actor,
    target: { threadId: input.threadId },
    arguments: { archived: input.archived },
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey
  })
}

export function buildProviderAuthBeginCommand(input: {
  actor: HostActorIdentity
  providerId: string
  flowId: string
  commandId?: string
  idempotencyKey?: string
}): HostCommand {
  return buildHostCommand({
    name: 'provider.auth.begin',
    actor: input.actor,
    target: { providerId: input.providerId },
    arguments: { flowId: input.flowId },
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey
  })
}

export function buildProviderAuthCancelCommand(input: {
  actor: HostActorIdentity
  providerId: string
  operationId: string
  commandId?: string
  idempotencyKey?: string
}): HostCommand {
  return buildHostCommand({
    name: 'provider.auth.cancel',
    actor: input.actor,
    target: { providerId: input.providerId, operationId: input.operationId },
    arguments: {},
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey
  })
}

/** Locator-only success result; callers must never infer an operation id. */
export function hostReceiptResultRef(receipt: HostCommandReceipt): HostResultRef | undefined {
  return receipt.status === 'succeeded' ? receipt.resultRef : undefined
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
