import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  CHANNEL_AGENT_IPC_CHANNELS,
  type ChannelAgentIpcApplied,
  type ChannelAgentIpcAppliedMember,
  type ChannelAgentIpcEnrollInput,
  type ChannelAgentIpcErrorCode,
  type ChannelAgentIpcGrantInput,
  type ChannelAgentIpcMembership,
  type ChannelAgentIpcOutcome,
  type ChannelAgentIpcOverview,
  type ChannelAgentIpcOverviewInput,
  type ChannelAgentIpcPermissionPresetId,
  type ChannelAgentIpcResult,
  type ChannelAgentIpcRevokeInput,
  type ChannelAgentIpcRotateInput,
  type ChannelAgentIpcSeat
} from '../../shared/collaboration/ChannelAgentIpc'
import { redactSecrets } from '../../shared/secretRedaction'
import type {
  ChannelAgentAppliedMemberView,
  ChannelAgentManagementController,
  ChannelAgentManagementOutcome,
  ChannelAgentManagementOverview
} from '../collaboration/ChannelAgentManagementController'
import {
  CHANNEL_AGENT_MANAGED_MAX_DISPATCHES,
  CHANNEL_AGENT_MAX_GRANT_TTL_MS,
  CHANNEL_AGENT_MIN_GRANT_TTL_MS,
  ChannelAgentManagementError
} from '../collaboration/ChannelAgentManagementService'
import { CHANNEL_AGENT_GRANT_PERMISSION_PRESETS } from '../collaboration/ChannelAgentSeatAuthority'
import { ChannelError } from '../collaboration/ChannelStore'

const MAX_IDENTIFIER_LENGTH = 512
const MAX_ERROR_MESSAGE_LENGTH = 240
const MAX_MENTIONERS = 8
const MAX_ROTATION_CHANNELS = 64

const HANDLED_CHANNELS = Object.values(CHANNEL_AGENT_IPC_CHANNELS)

export interface ChannelAgentHandlersDeps {
  readonly controller: Pick<
    ChannelAgentManagementController,
    'describeChannel' | 'enroll' | 'grant' | 'revoke' | 'rotate'
  >
  readonly isMainSender: (event: IpcMainInvokeEvent) => boolean
  readonly getOwnerWindow: (event: IpcMainInvokeEvent) => BrowserWindow | null
}

export interface ChannelAgentHandlersRegistration {
  dispose(): void
}

class ChannelAgentIpcBoundaryError extends Error {
  constructor(
    readonly code: Extract<ChannelAgentIpcErrorCode, 'not_authorized'>,
    message: string
  ) {
    super(message)
    this.name = 'ChannelAgentIpcBoundaryError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ChannelError('protocol_unsupported', `${label} must be an object`)
  return value
}

function requireOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const known = new Set(allowed)
  if (Object.keys(value).some((key) => !known.has(key))) {
    throw new ChannelError('protocol_unsupported', `${label} contains an unknown field`)
  }
}

function requireIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.trim() !== value
  ) {
    throw new ChannelError('protocol_unsupported', `${label} is invalid`)
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) {
      throw new ChannelError('protocol_unsupported', `${label} is invalid`)
    }
  }
  return value
}

function optionalInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string
): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new ChannelError('protocol_unsupported', `${label} is invalid`)
  }
  return Number(value)
}

function optionalIdentifierSet(
  value: unknown,
  maximum: number,
  label: string,
  allowEmpty: boolean
): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > maximum || (!allowEmpty && value.length === 0)) {
    throw new ChannelError('protocol_unsupported', `${label} is invalid`)
  }
  const values = value.map((entry) => requireIdentifier(entry, label))
  if (new Set(values).size !== values.length) {
    throw new ChannelError('protocol_unsupported', `${label} contains a duplicate`)
  }
  return values.sort()
}

function baseInput(value: unknown, label: string, extraKeys: readonly string[] = []) {
  const input = requireRecord(value, label)
  requireOnlyKeys(input, ['requestId', 'channelId', 'agentSeatId', ...extraKeys], label)
  return {
    requestId: requireIdentifier(input.requestId, 'Request id'),
    channelId: requireIdentifier(input.channelId, 'Channel id'),
    agentSeatId: requireIdentifier(input.agentSeatId, 'Agent seat id'),
    raw: input
  }
}

function parseOverview(value: unknown): ChannelAgentIpcOverviewInput {
  const input = requireRecord(value, 'Channel agent overview')
  requireOnlyKeys(input, ['channelId'], 'Channel agent overview')
  return { channelId: requireIdentifier(input.channelId, 'Channel id') }
}

function parseEnroll(value: unknown): ChannelAgentIpcEnrollInput {
  const input = baseInput(value, 'Channel agent enrollment')
  return {
    requestId: input.requestId,
    channelId: input.channelId,
    agentSeatId: input.agentSeatId
  }
}

function parseGrant(value: unknown): ChannelAgentIpcGrantInput {
  const input = baseInput(value, 'Channel agent grant', [
    'permissionPresetId',
    'allowedMentionerMemberIds',
    'ttlMs',
    'maxDispatches'
  ])
  if (
    !(CHANNEL_AGENT_GRANT_PERMISSION_PRESETS as readonly unknown[]).includes(
      input.raw.permissionPresetId
    )
  ) {
    throw new ChannelError('protocol_unsupported', 'Channel agent permission preset is invalid')
  }
  const permissionPresetId = input.raw.permissionPresetId as ChannelAgentIpcPermissionPresetId
  const allowedMentionerMemberIds = optionalIdentifierSet(
    input.raw.allowedMentionerMemberIds,
    MAX_MENTIONERS,
    'Allowed mentioner member ids',
    false
  )
  const ttlMs = optionalInteger(
    input.raw.ttlMs,
    CHANNEL_AGENT_MIN_GRANT_TTL_MS,
    CHANNEL_AGENT_MAX_GRANT_TTL_MS,
    'Grant lifetime'
  )
  const maxDispatches = optionalInteger(
    input.raw.maxDispatches,
    1,
    CHANNEL_AGENT_MANAGED_MAX_DISPATCHES,
    'Grant dispatch budget'
  )
  return {
    requestId: input.requestId,
    channelId: input.channelId,
    agentSeatId: input.agentSeatId,
    permissionPresetId,
    ...(allowedMentionerMemberIds ? { allowedMentionerMemberIds } : {}),
    ...(ttlMs === undefined ? {} : { ttlMs }),
    ...(maxDispatches === undefined ? {} : { maxDispatches })
  }
}

function parseRevoke(value: unknown): ChannelAgentIpcRevokeInput {
  const input = baseInput(value, 'Channel agent revocation')
  return {
    requestId: input.requestId,
    channelId: input.channelId,
    agentSeatId: input.agentSeatId
  }
}

function parseRotate(value: unknown): ChannelAgentIpcRotateInput {
  const input = baseInput(value, 'Channel agent rotation', ['reEnrollChannelIds'])
  const reEnrollChannelIds = optionalIdentifierSet(
    input.raw.reEnrollChannelIds,
    MAX_ROTATION_CHANNELS,
    'Re-enrollment Channel ids',
    true
  )
  return {
    requestId: input.requestId,
    channelId: input.channelId,
    agentSeatId: input.agentSeatId,
    ...(reEnrollChannelIds ? { reEnrollChannelIds } : {})
  }
}

function projectSeat(
  value: ChannelAgentManagementOverview['seats'][number]['seat']
): ChannelAgentIpcSeat {
  return {
    agentSeatId: value.agentSeatId,
    displayName: value.displayName,
    provider: value.provider,
    model: value.model,
    role: value.role
  }
}

function projectMembership(
  value: NonNullable<ChannelAgentManagementOverview['seats'][number]['membership']>
): ChannelAgentIpcMembership {
  return {
    channelId: value.channelId,
    memberId: value.memberId,
    displayName: value.displayName,
    keyGeneration: value.keyGeneration,
    status: value.status
  }
}

function projectOverview(value: ChannelAgentManagementOverview): ChannelAgentIpcOverview {
  return {
    channelId: value.channelId,
    seats: value.seats.map((entry) => ({
      seat: projectSeat(entry.seat),
      currentKeyGeneration: entry.currentKeyGeneration,
      ...(entry.membership ? { membership: projectMembership(entry.membership) } : {})
    })),
    allowedMentioners: value.allowedMentioners.map((member) => ({
      memberId: member.memberId,
      displayName: member.displayName
    })),
    permissionPresetIds: [...value.permissionPresetIds],
    grantLimits: {
      defaultTtlMs: value.grantLimits.defaultTtlMs,
      minimumTtlMs: value.grantLimits.minimumTtlMs,
      maximumTtlMs: value.grantLimits.maximumTtlMs,
      defaultMaxDispatches: value.grantLimits.defaultMaxDispatches,
      maximumDispatches: value.grantLimits.maximumDispatches
    }
  }
}

function projectMember(value: ChannelAgentAppliedMemberView): ChannelAgentIpcAppliedMember {
  return {
    channelId: value.channelId,
    memberId: value.memberId,
    status: value.status,
    keyGeneration: value.keyGeneration
  }
}

function projectApplied(
  value: Extract<ChannelAgentManagementOutcome, { status: 'applied' }>['value']
): ChannelAgentIpcApplied {
  if (value.kind === 'enroll') {
    return { kind: value.kind, agentSeatId: value.agentSeatId, member: projectMember(value.member) }
  }
  if (value.kind === 'grant') {
    return {
      kind: value.kind,
      agentSeatId: value.agentSeatId,
      member: projectMember(value.member),
      allowedMentionerMemberIds: [...value.allowedMentionerMemberIds],
      permissionPresetId: value.permissionPresetId,
      expiresAt: value.expiresAt,
      maxDispatches: value.maxDispatches
    }
  }
  if (value.kind === 'revoke') {
    return {
      kind: value.kind,
      agentSeatId: value.agentSeatId,
      member: projectMember(value.member),
      alreadyRevoked: value.alreadyRevoked
    }
  }
  return {
    kind: value.kind,
    agentSeatId: value.agentSeatId,
    fromKeyGeneration: value.fromKeyGeneration,
    toKeyGeneration: value.toKeyGeneration,
    members: value.members.map(projectMember),
    resumed: value.resumed
  }
}

function projectOutcome(value: ChannelAgentManagementOutcome): ChannelAgentIpcOutcome {
  if (value.status === 'declined' || value.status === 'stale') return { status: value.status }
  return { status: 'applied', value: projectApplied(value.value) }
}

function errorMessage(value: string): string {
  return redactSecrets(value)
    .replace(/(?:\/Users\/|\/home\/)[^/\s]+(?:\/[^\s]*)?/g, '[redacted-path]')
    .replace(/\/private\/var\/[^\s]+/g, '[redacted-path]')
    .replace(/\/tmp\/[^\s]+/g, '[redacted-path]')
    .replace(/\b[A-Za-z]:\\Users\\[^\\\s]+(?:\\[^\s]*)*/g, '[redacted-path]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ERROR_MESSAGE_LENGTH)
}

async function boundary<T>(operation: () => T | Promise<T>): Promise<ChannelAgentIpcResult<T>> {
  try {
    return { ok: true, value: await operation() }
  } catch (error) {
    if (
      error instanceof ChannelError ||
      error instanceof ChannelAgentManagementError ||
      error instanceof ChannelAgentIpcBoundaryError
    ) {
      return {
        ok: false,
        error: {
          code: error.code,
          message: errorMessage(error.message) || 'Channel agent operation failed.'
        }
      }
    }
    return {
      ok: false,
      error: { code: 'internal_error', message: 'Channel agent operation failed.' }
    }
  }
}

export function registerChannelAgentHandlers(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  deps: ChannelAgentHandlersDeps
): ChannelAgentHandlersRegistration {
  if (!ipc || typeof ipc.handle !== 'function') {
    throw new Error('registerChannelAgentHandlers requires an IPC registrar')
  }
  if (
    !deps ||
    !deps.controller ||
    typeof deps.controller.describeChannel !== 'function' ||
    typeof deps.controller.enroll !== 'function' ||
    typeof deps.controller.grant !== 'function' ||
    typeof deps.controller.revoke !== 'function' ||
    typeof deps.controller.rotate !== 'function' ||
    typeof deps.isMainSender !== 'function' ||
    typeof deps.getOwnerWindow !== 'function'
  ) {
    throw new Error('registerChannelAgentHandlers requires main-owned dependencies')
  }

  const assertMain = (event: IpcMainInvokeEvent): void => {
    let allowed = false
    try {
      allowed = deps.isMainSender(event) === true
    } catch {
      allowed = false
    }
    if (!allowed) {
      throw new ChannelAgentIpcBoundaryError(
        'not_authorized',
        'Only the main renderer may manage Channel agents.'
      )
    }
  }

  const ownerWindow = (event: IpcMainInvokeEvent): BrowserWindow | null => {
    try {
      return deps.getOwnerWindow(event)
    } catch {
      return null
    }
  }

  for (const channel of HANDLED_CHANNELS) ipc.removeHandler?.(channel)

  ipc.handle('channels:agent:overview', (event, value: unknown) =>
    boundary(() => {
      assertMain(event)
      return projectOverview(deps.controller.describeChannel(parseOverview(value).channelId))
    })
  )

  ipc.handle('channels:agent:enroll', (event, value: unknown) =>
    boundary(async () => {
      assertMain(event)
      const input = parseEnroll(value)
      return projectOutcome(await deps.controller.enroll(ownerWindow(event), input))
    })
  )

  ipc.handle('channels:agent:grant', (event, value: unknown) =>
    boundary(async () => {
      assertMain(event)
      const input = parseGrant(value)
      return projectOutcome(await deps.controller.grant(ownerWindow(event), input))
    })
  )

  ipc.handle('channels:agent:revoke', (event, value: unknown) =>
    boundary(async () => {
      assertMain(event)
      const input = parseRevoke(value)
      return projectOutcome(await deps.controller.revoke(ownerWindow(event), input))
    })
  )

  ipc.handle('channels:agent:rotate', (event, value: unknown) =>
    boundary(async () => {
      assertMain(event)
      const input = parseRotate(value)
      return projectOutcome(await deps.controller.rotate(ownerWindow(event), input))
    })
  )

  return {
    dispose: () => {
      for (const channel of HANDLED_CHANNELS) ipc.removeHandler?.(channel)
    }
  }
}
