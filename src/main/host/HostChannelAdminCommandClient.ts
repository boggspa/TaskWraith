import { randomUUID } from 'node:crypto'

import type { HostCommand, HostCommandName, HostCommandReceipt } from '../../shared/hostProtocol'
import { HOST_PROTOCOL_VERSION, TASKWRAITH_DESKTOP_HOST_ACTOR } from '../../shared/hostProtocol'
import type {
  HostProjectionCommandResult,
  HostProjectionReceiptLookupResult
} from './HostProjectionBroker'

export interface HostChannelAdminCommandBrokerPort {
  submitCommand(command: HostCommand): Promise<HostProjectionCommandResult>
  lookupReceipt(commandId: string): Promise<HostProjectionReceiptLookupResult>
}

export type HostChannelAdminCommandResult =
  | { readonly ok: true; readonly receipt: HostCommandReceipt }
  | {
      readonly ok: false
      readonly code: string
      readonly message: string
      readonly receipt?: HostCommandReceipt
    }

export interface HostChannelAdminCommandClientOptions {
  readonly broker: HostChannelAdminCommandBrokerPort
  readonly nowMs?: () => number
  readonly createId?: () => string
  readonly wait?: (milliseconds: number) => Promise<void>
  readonly pollIntervalMs?: number
  readonly timeoutMs?: number
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function receiptMatches(command: HostCommand, receipt: HostCommandReceipt): boolean {
  return (
    receipt.commandId === command.commandId &&
    receipt.idempotencyKey === command.idempotencyKey &&
    receipt.name === command.name &&
    receipt.actor.actorId === TASKWRAITH_DESKTOP_HOST_ACTOR.actorId &&
    receipt.actor.clientId === TASKWRAITH_DESKTOP_HOST_ACTOR.clientId &&
    receipt.actor.clientClass === TASKWRAITH_DESKTOP_HOST_ACTOR.clientClass
  )
}

function terminalResult(
  command: HostCommand,
  receipt: HostCommandReceipt
): HostChannelAdminCommandResult | null {
  if (!receiptMatches(command, receipt)) {
    return {
      ok: false,
      code: 'invalid_host_receipt',
      message: 'Host receipt did not match command'
    }
  }
  if (receipt.status === 'pending') return null
  if (receipt.status === 'succeeded') return { ok: true, receipt }
  return {
    ok: false,
    code: receipt.errorCode ?? `host_${receipt.status}`,
    message: receipt.errorMessage ?? `Host command ended with ${receipt.status}`,
    receipt
  }
}

/** Main-side adapter for legacy Channels IPC callers during Host cutover. */
export class HostChannelAdminCommandClient {
  private readonly nowMs: () => number
  private readonly createId: () => string
  private readonly wait: (milliseconds: number) => Promise<void>
  private readonly pollIntervalMs: number
  private readonly timeoutMs: number

  constructor(private readonly options: HostChannelAdminCommandClientOptions) {
    if (
      !options?.broker ||
      typeof options.broker.submitCommand !== 'function' ||
      typeof options.broker.lookupReceipt !== 'function'
    ) {
      throw new Error('HostChannelAdminCommandClient requires a Host broker')
    }
    this.nowMs = options.nowMs ?? Date.now
    this.createId = options.createId ?? randomUUID
    this.wait = options.wait ?? defaultWait
    this.pollIntervalMs = Math.max(25, options.pollIntervalMs ?? 250)
    this.timeoutMs = Math.max(this.pollIntervalMs, options.timeoutMs ?? 120_000)
  }

  revokeMember(input: {
    channelId: string
    memberId: string
  }): Promise<HostChannelAdminCommandResult> {
    return this.execute(
      'channel.member.revoke',
      { channelId: input.channelId },
      {
        memberId: input.memberId
      }
    )
  }

  closeChannel(channelId: string): Promise<HostChannelAdminCommandResult> {
    return this.execute('channel.close', { channelId }, {})
  }

  private async execute(
    name: Extract<HostCommandName, 'channel.member.revoke' | 'channel.close'>,
    target: Record<string, string>,
    args: Record<string, unknown>
  ): Promise<HostChannelAdminCommandResult> {
    const commandId = this.createId()
    const command: HostCommand = {
      type: 'host.command',
      protocolVersion: HOST_PROTOCOL_VERSION,
      commandId,
      idempotencyKey: `channel:${name}:${commandId}`,
      actor: { ...TASKWRAITH_DESKTOP_HOST_ACTOR },
      name,
      target,
      arguments: args,
      issuedAt: new Date(this.nowMs()).toISOString()
    }

    const submitted = await this.options.broker.submitCommand(command)
    let initialReceipt: HostCommandReceipt
    if (submitted.ok) {
      initialReceipt = submitted.receipt
    } else {
      // The socket may drop after Host durably records the command but before
      // Desktop receives its receipt. Resolve that ambiguity by commandId;
      // never mint a second mutation as recovery.
      const recovered = await this.options.broker.lookupReceipt(commandId)
      if (!recovered.ok) {
        return { ok: false, code: 'host_unavailable', message: submitted.error.slice(0, 200) }
      }
      initialReceipt = recovered.receipt
    }
    let terminal = terminalResult(command, initialReceipt)
    if (terminal) return terminal

    const deadline = this.nowMs() + this.timeoutMs
    while (this.nowMs() < deadline) {
      await this.wait(this.pollIntervalMs)
      const lookup = await this.options.broker.lookupReceipt(commandId)
      if (!lookup.ok) {
        return { ok: false, code: 'host_unavailable', message: lookup.error.slice(0, 200) }
      }
      terminal = terminalResult(command, lookup.receipt)
      if (terminal) return terminal
    }
    return {
      ok: false,
      code: 'host_command_pending',
      message: 'Host approval is still pending'
    }
  }
}
