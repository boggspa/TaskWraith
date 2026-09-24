import { randomUUID } from 'node:crypto'

import type {
  HostActorIdentity,
  HostCapability,
  HostCommand,
  HostCommandReceipt
} from '../../shared/hostProtocol'
import { HOST_PROTOCOL_VERSION, TASKWRAITH_DESKTOP_HOST_ACTOR } from '../../shared/hostProtocol'
import type { ChatRecord, ProviderId } from '../store/types'
import type {
  HostProjectionCommandResult,
  HostProjectionReceiptLookupResult
} from './HostProjectionBroker'
import { createHostProjectionBroker } from './HostProjectionBroker'

const THREAD_KIND_HOST_CLIENT_ID = 'taskwraith-desktop-thread-kind'
const THREAD_KIND_HOST_ACTOR = {
  actorId: THREAD_KIND_HOST_CLIENT_ID,
  clientId: THREAD_KIND_HOST_CLIENT_ID,
  clientClass: 'desktop'
} as const satisfies HostActorIdentity
const THREAD_KIND_HOST_CAPABILITIES = [
  'bootstrap',
  'commands',
  'receipts',
  'setup'
] as const satisfies readonly HostCapability[]

export interface HostThreadKindCommandBrokerPort {
  submitCommand(command: HostCommand): Promise<HostProjectionCommandResult>
  lookupReceipt(commandId: string): Promise<HostProjectionReceiptLookupResult>
}

export type HostThreadKindCommandResult =
  | { readonly ok: true; readonly receipt: HostCommandReceipt }
  | {
      readonly ok: false
      readonly code: string
      readonly message: string
      readonly receipt?: HostCommandReceipt
    }

export interface HostThreadKindCommandClientOptions {
  readonly broker: HostThreadKindCommandBrokerPort
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

function terminalResult(
  command: HostCommand,
  receipt: HostCommandReceipt,
  actor: HostActorIdentity
): HostThreadKindCommandResult | null {
  if (!receiptMatches(command, receipt, actor)) {
    return {
      ok: false,
      code: 'invalid_host_receipt',
      message: 'Host receipt did not match the thread-kind command.'
    }
  }
  if (receipt.status === 'pending') return null
  if (receipt.status === 'succeeded') return { ok: true, receipt }
  return {
    ok: false,
    code: receipt.errorCode ?? `host_${receipt.status}`,
    message: receipt.errorMessage ?? `Host thread configuration ended with ${receipt.status}.`,
    receipt
  }
}

export class HostThreadKindCommandClient {
  private readonly nowMs: () => number
  private readonly actor: HostActorIdentity
  private readonly createId: () => string
  private readonly wait: (milliseconds: number) => Promise<void>
  private readonly pollIntervalMs: number
  private readonly timeoutMs: number

  constructor(private readonly options: HostThreadKindCommandClientOptions) {
    if (
      !options?.broker ||
      typeof options.broker.submitCommand !== 'function' ||
      typeof options.broker.lookupReceipt !== 'function'
    ) {
      throw new Error('HostThreadKindCommandClient requires a Host broker.')
    }
    this.nowMs = options.nowMs ?? Date.now
    this.actor = options.actor ?? { ...TASKWRAITH_DESKTOP_HOST_ACTOR }
    this.createId = options.createId ?? randomUUID
    this.wait = options.wait ?? defaultWait
    this.pollIntervalMs = Math.max(25, options.pollIntervalMs ?? 250)
    this.timeoutMs = Math.max(this.pollIntervalMs, options.timeoutMs ?? 30_000)
  }

  setKind(input: {
    chatId: string
    targetKind: 'single' | 'ensemble'
    canonicalProvider?: ProviderId
  }): Promise<HostThreadKindCommandResult> {
    if (!input?.chatId) {
      return Promise.resolve({
        ok: false,
        code: 'invalid_chat_id',
        message: 'A chat id is required for a Host mode change.'
      })
    }
    if (input.targetKind === 'single' && !input.canonicalProvider) {
      return Promise.resolve({
        ok: false,
        code: 'canonical_provider_required',
        message: 'Choose the provider that should keep this thread.'
      })
    }
    const commandId = this.createId()
    const command: HostCommand = {
      type: 'host.command',
      protocolVersion: HOST_PROTOCOL_VERSION,
      commandId,
      idempotencyKey: `thread:configure-kind:${commandId}`,
      actor: { ...this.actor },
      name: 'thread.configure',
      target: { threadId: input.chatId },
      arguments:
        input.targetKind === 'ensemble'
          ? { chatKind: 'ensemble' }
          : { chatKind: 'single', canonicalProviderId: input.canonicalProvider },
      issuedAt: new Date(this.nowMs()).toISOString()
    }
    return this.execute(command)
  }

  private async execute(command: HostCommand): Promise<HostThreadKindCommandResult> {
    const submitted = await this.options.broker.submitCommand(command)
    let initialReceipt: HostCommandReceipt
    if (submitted.ok) {
      initialReceipt = submitted.receipt
    } else {
      const recovered = await this.options.broker.lookupReceipt(command.commandId)
      if (!recovered.ok) {
        return {
          ok: false,
          code: 'host_unavailable',
          message: submitted.error.slice(0, 200)
        }
      }
      initialReceipt = recovered.receipt
    }

    let terminal = terminalResult(command, initialReceipt, this.actor)
    if (terminal) return terminal
    const deadline = this.nowMs() + this.timeoutMs
    while (this.nowMs() < deadline) {
      await this.wait(this.pollIntervalMs)
      const lookup = await this.options.broker.lookupReceipt(command.commandId)
      if (!lookup.ok) {
        return { ok: false, code: 'host_unavailable', message: lookup.error.slice(0, 200) }
      }
      terminal = terminalResult(command, lookup.receipt, this.actor)
      if (terminal) return terminal
    }
    return {
      ok: false,
      code: 'host_timeout',
      message: 'Host thread configuration did not settle before the timeout.'
    }
  }
}

export function createDesktopHostThreadKindCommandClient(input: {
  userDataPath: string
  appVersion: string
}): HostThreadKindCommandClient {
  const broker = createHostProjectionBroker({
    userDataPath: input.userDataPath,
    appVersion: input.appVersion,
    client: {
      clientId: THREAD_KIND_HOST_CLIENT_ID,
      clientClass: 'desktop',
      clientVersion: input.appVersion
    },
    actor: { ...THREAD_KIND_HOST_ACTOR },
    capabilities: THREAD_KIND_HOST_CAPABILITIES
  })
  return new HostThreadKindCommandClient({ broker, actor: { ...THREAD_KIND_HOST_ACTOR } })
}

function fallbackCanonicalProvider(chat: ChatRecord): ProviderId | undefined {
  const participants = Array.isArray(chat.ensemble?.participants)
    ? [...chat.ensemble.participants].sort((left, right) => left.order - right.order)
    : []
  const bossId = chat.ensemble?.bossmanParticipantId
  const participant =
    (bossId ? participants.find((candidate) => candidate.id === bossId) : undefined) ??
    participants.find((candidate) => candidate.enabled !== false)
  return participant?.provider ?? chat.provider
}

export function createHostThreadKindMutation(options: {
  client: Pick<HostThreadKindCommandClient, 'setKind'>
  getChat: (chatId: string) => ChatRecord | null
}): (input: {
  chatId: string
  targetKind: 'single' | 'ensemble'
  canonicalProvider?: ProviderId
}) => Promise<ChatRecord> {
  return async (input) => {
    const before = options.getChat(input.chatId)
    if (!before) throw new Error('Chat not found.')
    const canonicalProvider =
      input.targetKind === 'single'
        ? (input.canonicalProvider ?? fallbackCanonicalProvider(before))
        : undefined
    const result = await options.client.setKind({
      chatId: input.chatId,
      targetKind: input.targetKind,
      ...(canonicalProvider ? { canonicalProvider } : {})
    })
    if (!result.ok) throw new Error(result.message)
    const updated = options.getChat(input.chatId)
    if (!updated || (updated.chatKind === 'ensemble') !== (input.targetKind === 'ensemble')) {
      throw new Error('Host mode change completed without a matching canonical chat record.')
    }
    return updated
  }
}
