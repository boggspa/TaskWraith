/**
 * Electron-free executor for the closed Host setup command family.
 *
 * It receives only narrow injected domain ports and current read projections;
 * it neither imports nor constructs Desktop services, providers, credentials,
 * Browser auth URLs, or Bridge command adapters. Every selection is checked
 * against a fresh offer/flow read immediately before the port invocation.
 */

import type { HostCommand, HostResultRef } from '../shared/hostProtocol'
import type {
  HostProviderAuthFlowProjection,
  HostProviderOffersProjection
} from '../shared/hostSetupProtocol'
import { validateHostCommandArguments } from './HostCommandArguments'
import type { HostCommandExecutionResult } from './HostCommandExecutionResult'
import { isExactHostActorIdentity, type HostAuthorityCallContext } from './HostAuthority'
import { isHostSetupCommand } from './HostSetupCommand'

export interface HostSetupWorkspacePort {
  register(input: {
    readonly path: string
    readonly displayName?: string
    readonly pinned?: boolean
  }): { readonly workspaceId: string } | Promise<{ readonly workspaceId: string }>
}

export interface HostSetupThreadPort {
  create(input: {
    readonly scope: 'global' | 'workspace'
    readonly workspaceId?: string
    readonly title?: string
  }): { readonly threadId: string } | Promise<{ readonly threadId: string }>
  configure(input: {
    readonly threadId: string
    readonly providerId?: string
    readonly modelId?: string
    readonly reasoningId?: string
    readonly postureId?: string
    readonly offerRevision?: string
    readonly postureConsent?: true
    readonly title?: string
  }): { readonly threadId: string } | Promise<{ readonly threadId: string }>
  archive(input: {
    readonly threadId: string
    readonly archived: boolean
  }): { readonly threadId: string } | Promise<{ readonly threadId: string }>
}

export interface HostSetupProviderAuthPort {
  begin(input: {
    readonly providerId: string
    readonly flowId: string
    /** Deterministic request identity; caller supplies Host commandId. */
    readonly operationId: string
  }):
    | { readonly providerId: string; readonly operationId: string }
    | Promise<{
        readonly providerId: string
        readonly operationId: string
      }>
  cancel(input: { readonly providerId: string; readonly operationId: string }):
    | {
        readonly providerId: string
        readonly operationId: string
        readonly outcome: 'cancelled' | 'not_found' | 'not_cancellable'
      }
    | Promise<{
        readonly providerId: string
        readonly operationId: string
        readonly outcome: 'cancelled' | 'not_found' | 'not_cancellable'
      }>
}

export interface HostSetupOfferReader {
  read(providerId: string): HostProviderOffersProjection | Promise<HostProviderOffersProjection>
}

export interface HostSetupAuthFlowReader {
  read(
    providerId: string
  ): readonly HostProviderAuthFlowProjection[] | Promise<readonly HostProviderAuthFlowProjection[]>
}

export interface HostSetupCommandExecutorPorts {
  readonly workspace: HostSetupWorkspacePort
  readonly thread: HostSetupThreadPort
  readonly providerAuth: HostSetupProviderAuthPort
  readonly currentOffers: HostSetupOfferReader
  readonly currentAuthFlows: HostSetupAuthFlowReader
}

const LOCAL_SETUP_CLIENT_CLASSES = new Set(['desktop', 'tui', 'test'])

class HostSetupConsentRequiredError extends Error {}

function isSafeResultId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    // eslint-disable-next-line no-control-regex -- result IDs cannot carry terminal controls.
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function failed(
  code:
    | 'setup_invalid'
    | 'setup_forbidden'
    | 'setup_stale_offer'
    | 'setup_consent_required'
    | 'setup_auth_not_found'
    | 'setup_auth_not_cancellable'
    | 'setup_execution_failed'
) {
  return { status: 'failed' as const, errorCode: code }
}

function succeeded(resultRef: HostResultRef): HostCommandExecutionResult {
  return { status: 'succeeded', resultRef }
}

/**
 * Closed executor for `setup-mutation` only. It validates independently from
 * HostLocalServer/AppStore authority so an accidental direct caller still
 * cannot send unvalidated data to an injected port.
 */
export class HostSetupCommandExecutor {
  private readonly ports: HostSetupCommandExecutorPorts

  constructor(ports: HostSetupCommandExecutorPorts) {
    if (
      !ports ||
      !ports.workspace ||
      typeof ports.workspace.register !== 'function' ||
      !ports.thread ||
      typeof ports.thread.create !== 'function' ||
      typeof ports.thread.configure !== 'function' ||
      typeof ports.thread.archive !== 'function' ||
      !ports.providerAuth ||
      typeof ports.providerAuth.begin !== 'function' ||
      typeof ports.providerAuth.cancel !== 'function' ||
      !ports.currentOffers ||
      typeof ports.currentOffers.read !== 'function' ||
      !ports.currentAuthFlows ||
      typeof ports.currentAuthFlows.read !== 'function'
    ) {
      throw new Error('HostSetupCommandExecutor requires complete injected ports')
    }
    this.ports = ports
  }

  async execute(
    candidate: HostCommand,
    context: HostAuthorityCallContext
  ): Promise<HostCommandExecutionResult> {
    const decoded = validateHostCommandArguments(candidate)
    if (!decoded.ok) return failed('setup_invalid')
    const command = decoded.value
    if (!isHostSetupCommand(command)) return failed('setup_invalid')
    if (!this.isExactLocalActor(command, context)) return failed('setup_forbidden')

    try {
      switch (command.name) {
        case 'workspace.register':
          return await this.registerWorkspace(command)
        case 'thread.create':
          return await this.createThread(command)
        case 'thread.configure':
          return await this.configureThread(command)
        case 'thread.archive':
          return await this.archiveThread(command)
        case 'provider.auth.begin':
          return await this.beginProviderAuth(command)
        case 'provider.auth.cancel':
          return await this.cancelProviderAuth(command)
      }
      return failed('setup_invalid')
    } catch (error) {
      if (error instanceof HostSetupConsentRequiredError) return failed('setup_consent_required')
      return failed('setup_execution_failed')
    }
  }

  private isExactLocalActor(command: HostCommand, context: HostAuthorityCallContext): boolean {
    return (
      isExactHostActorIdentity(context.actor) &&
      LOCAL_SETUP_CLIENT_CLASSES.has(context.client.clientClass) &&
      context.actor.clientId === context.client.clientId &&
      context.actor.clientClass === context.client.clientClass &&
      command.actor.actorId === context.actor.actorId &&
      command.actor.clientId === context.actor.clientId &&
      command.actor.clientClass === context.actor.clientClass
    )
  }

  private async registerWorkspace(command: HostCommand): Promise<HostCommandExecutionResult> {
    const result = await this.ports.workspace.register({
      path: command.arguments.path as string,
      ...(typeof command.arguments.displayName === 'string'
        ? { displayName: command.arguments.displayName }
        : {}),
      ...(typeof command.arguments.pinned === 'boolean' ? { pinned: command.arguments.pinned } : {})
    })
    if (!isSafeResultId(result?.workspaceId)) return failed('setup_execution_failed')
    return succeeded({ kind: 'workspace', workspaceId: result.workspaceId })
  }

  private async createThread(command: HostCommand): Promise<HostCommandExecutionResult> {
    const scope = command.arguments.scope
    if (scope !== 'global' && scope !== 'workspace') return failed('setup_invalid')
    const result = await this.ports.thread.create({
      scope,
      ...(scope === 'workspace' ? { workspaceId: command.arguments.workspaceId as string } : {}),
      ...(typeof command.arguments.title === 'string' ? { title: command.arguments.title } : {})
    })
    if (!isSafeResultId(result?.threadId)) return failed('setup_execution_failed')
    return succeeded({ kind: 'thread', threadId: result.threadId })
  }

  private async configureThread(command: HostCommand): Promise<HostCommandExecutionResult> {
    const threadId = command.target.threadId
    const providerId = command.arguments.providerId
    const isSelection = typeof providerId === 'string'
    if (isSelection) {
      if (!isSafeResultId(providerId) || !(await this.selectionIsCurrent(providerId, command))) {
        return failed('setup_stale_offer')
      }
    }
    const result = await this.ports.thread.configure({
      threadId,
      ...(isSelection ? { providerId } : {}),
      ...(typeof command.arguments.modelId === 'string'
        ? { modelId: command.arguments.modelId }
        : {}),
      ...(typeof command.arguments.reasoningId === 'string'
        ? { reasoningId: command.arguments.reasoningId }
        : {}),
      ...(typeof command.arguments.postureId === 'string'
        ? { postureId: command.arguments.postureId }
        : {}),
      ...(typeof command.arguments.offerRevision === 'string'
        ? { offerRevision: command.arguments.offerRevision }
        : {}),
      ...(command.arguments.postureConsent === true ? { postureConsent: true as const } : {}),
      ...(typeof command.arguments.title === 'string' ? { title: command.arguments.title } : {})
    })
    if (!isSafeResultId(result?.threadId) || result.threadId !== threadId) {
      return failed('setup_execution_failed')
    }
    return succeeded({ kind: 'thread', threadId: result.threadId })
  }

  private async archiveThread(command: HostCommand): Promise<HostCommandExecutionResult> {
    const threadId = command.target.threadId
    const archived = command.arguments.archived
    if (typeof archived !== 'boolean') return failed('setup_invalid')
    const result = await this.ports.thread.archive({ threadId, archived })
    if (!isSafeResultId(result?.threadId) || result.threadId !== threadId) {
      return failed('setup_execution_failed')
    }
    return succeeded({ kind: 'thread', threadId: result.threadId })
  }

  private async beginProviderAuth(command: HostCommand): Promise<HostCommandExecutionResult> {
    const providerId = command.target.providerId
    const flowId = command.arguments.flowId
    if (typeof flowId !== 'string' || !(await this.flowIsCurrent(providerId, flowId))) {
      return failed('setup_stale_offer')
    }
    const result = await this.ports.providerAuth.begin({
      providerId,
      flowId,
      operationId: command.commandId
    })
    if (
      !isSafeResultId(result?.providerId) ||
      result.providerId !== providerId ||
      !isSafeResultId(result.operationId) ||
      result.operationId !== command.commandId
    ) {
      return failed('setup_execution_failed')
    }
    return succeeded({
      kind: 'provider-auth',
      providerId: result.providerId,
      operationId: result.operationId
    })
  }

  private async cancelProviderAuth(command: HostCommand): Promise<HostCommandExecutionResult> {
    const providerId = command.target.providerId
    const operationId = command.target.operationId
    const result = await this.ports.providerAuth.cancel({ providerId, operationId })
    if (
      !isSafeResultId(result?.providerId) ||
      result.providerId !== providerId ||
      !isSafeResultId(result.operationId) ||
      result.operationId !== operationId ||
      result.outcome !== 'cancelled'
    ) {
      return failed(
        result?.outcome === 'not_found'
          ? 'setup_auth_not_found'
          : result?.outcome === 'not_cancellable'
            ? 'setup_auth_not_cancellable'
            : 'setup_execution_failed'
      )
    }
    return succeeded({
      kind: 'provider-auth',
      providerId: result.providerId,
      operationId: result.operationId
    })
  }

  private async selectionIsCurrent(providerId: string, command: HostCommand): Promise<boolean> {
    const offers = await this.ports.currentOffers.read(providerId)
    if (
      !offers ||
      offers.providerId !== providerId ||
      offers.offerRevision !== command.arguments.offerRevision
    ) {
      return false
    }
    const modelId = command.arguments.modelId
    const reasoningId = command.arguments.reasoningId
    const postureId = command.arguments.postureId
    const model =
      typeof modelId === 'string'
        ? offers.models.find((item) => item.modelId === modelId && item.available)
        : undefined
    if (typeof modelId === 'string' && !model) return false
    if (
      typeof reasoningId === 'string' &&
      (!model ||
        !model.reasoning.some((item) => item.reasoningId === reasoningId && item.available))
    ) {
      return false
    }
    if (typeof postureId === 'string') {
      const posture = offers.postures.find((item) => item.postureId === postureId && item.available)
      if (!posture) return false
      if (posture.requiresExplicitConsent && command.arguments.postureConsent !== true) {
        throw new HostSetupConsentRequiredError()
      }
    }
    return true
  }

  private async flowIsCurrent(providerId: string, flowId: string): Promise<boolean> {
    const flows = await this.ports.currentAuthFlows.read(providerId)
    return Array.isArray(flows) && flows.some((flow) => flow.flowId === flowId && flow.available)
  }
}
