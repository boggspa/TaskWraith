import { createHash } from 'crypto'
import { resolveEffectiveRunPermissions } from '../EffectiveRunPermissions'
import { canonicalRunPermissionPosture } from '../RunPermissionPosture'
import type {
  AppSettings,
  ChatRecord,
  EffectiveRunPermissions,
  EnsembleParticipant,
  PermissionPresetId,
  ProviderId
} from '../store/types'

const WORKSPACE_PRINCIPAL_DOMAIN = 'taskwraith.channel.agent-workspace-principal.v1'
const PERMISSION_POSTURE_DOMAIN = 'taskwraith.channel.agent-permission-posture.v1'
const MAX_AGENT_SEAT_ID_LENGTH = 512
const MAX_DISPLAY_NAME_LENGTH = 120
const MAX_PARTICIPANT_ID_LENGTH = 512
const MAX_INSTRUCTIONS_BYTES = 64 * 1024

const KNOWN_PROVIDER_IDS: ReadonlySet<string> = new Set([
  'gemini',
  'codex',
  'claude',
  'kimi',
  'grok',
  'cursor',
  'ollama',
  'antigravity',
  'pi',
  'mistral'
])

export const CHANNEL_AGENT_GRANT_PERMISSION_PRESETS = [
  'read_only',
  'plan',
  'default',
  'workspace_write',
  'full_access'
] as const satisfies readonly PermissionPresetId[]

export type ChannelAgentGrantPermissionPresetId =
  (typeof CHANNEL_AGENT_GRANT_PERMISSION_PRESETS)[number]

export type ChannelAgentWorkspacePrincipal =
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'global'; readonly chatId: string }

export interface ChannelAgentSeatCandidate {
  readonly agentSeatId: string
  readonly participantId: string
  readonly displayName: string
  readonly provider: ProviderId
  readonly role: string
  readonly instructions: string
  readonly configuredPermissionPresetId: PermissionPresetId
  readonly model?: string
  readonly runtimeProfileId?: string
  readonly geminiAuthProfileId?: string | null
  readonly reasoningEffort?: string
  readonly fastModeEnabled?: boolean
  readonly thinkingEnabled?: boolean
  readonly serviceTier?: string
}

export interface ChannelAgentGrantAuthority {
  readonly seat: ChannelAgentSeatCandidate
  readonly permissionPresetId: ChannelAgentGrantPermissionPresetId
  readonly effectivePermissions: EffectiveRunPermissions
  readonly workspaceIdentityHash: string
  readonly permissionPostureHash: string
}

export interface ResolveChannelAgentGrantAuthorityInput {
  readonly chat: ChatRecord
  readonly agentSeatId: string
  readonly permissionPresetId: ChannelAgentGrantPermissionPresetId
  readonly workspacePrincipal: ChannelAgentWorkspacePrincipal
  readonly settings: Pick<AppSettings, 'agenticServices' | 'agenticWorkspaceGrants'>
  readonly providerAllowed: (provider: ProviderId) => boolean
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function safeIdentifier(value: unknown, maximum: number): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value
  ) {
    return false
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

function pooledAgentSeatId(value: unknown): value is string {
  return (
    safeIdentifier(value, MAX_AGENT_SEAT_ID_LENGTH) &&
    value.startsWith('pooled-agent-') &&
    value.length > 'pooled-agent-'.length
  )
}

function safeDisplayName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let normalized = ''
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    const disguised =
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x00ad ||
      codePoint === 0x034f ||
      codePoint === 0x061c ||
      codePoint === 0x180e ||
      (codePoint >= 0x200b && codePoint <= 0x200f) ||
      (codePoint >= 0x2028 && codePoint <= 0x202e) ||
      codePoint === 0x2060 ||
      (codePoint >= 0x2066 && codePoint <= 0x2069) ||
      codePoint === 0xfeff
    normalized += disguised ? ' ' : character
  }
  normalized = normalized.replace(/\s+/g, ' ').trim()
  if (!normalized || Array.from(normalized).length > MAX_DISPLAY_NAME_LENGTH) return null
  return normalized
}

function knownProvider(value: unknown): value is ProviderId {
  return typeof value === 'string' && KNOWN_PROVIDER_IDS.has(value)
}

function configuredPermissionPreset(value: unknown): PermissionPresetId | null {
  if (value === undefined) return 'default'
  return typeof value === 'string' &&
    ([...CHANNEL_AGENT_GRANT_PERMISSION_PRESETS, 'custom'] as const).includes(
      value as PermissionPresetId
    )
    ? (value as PermissionPresetId)
    : null
}

function optionalText(value: unknown, maximum = 512): string | undefined {
  if (!safeIdentifier(value, maximum)) return undefined
  return value
}

function safeInstructions(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !value.includes('\0') &&
    Buffer.byteLength(value, 'utf8') <= MAX_INSTRUCTIONS_BYTES
  )
}

function candidateFromParticipant(
  participant: EnsembleParticipant,
  providerAllowed: (provider: ProviderId) => boolean
): ChannelAgentSeatCandidate | null {
  if (participant.enabled !== true || !pooledAgentSeatId(participant.pooledAgentId)) return null
  if (!safeIdentifier(participant.id, MAX_PARTICIPANT_ID_LENGTH)) return null
  if (!knownProvider(participant.provider) || !providerAllowed(participant.provider)) return null
  const identity = participant.pooledAgentIdentity
  if (
    !identity ||
    identity.schemaVersion !== 1 ||
    identity.agentId !== participant.pooledAgentId ||
    (identity.iconKind !== 'named' &&
      identity.iconKind !== 'seed' &&
      identity.iconKind !== 'asset') ||
    typeof identity.hue !== 'number' ||
    !Number.isFinite(identity.hue)
  ) {
    return null
  }
  const displayName = safeDisplayName(identity.nickname)
  const role = safeDisplayName(participant.role)
  const configuredPreset = configuredPermissionPreset(participant.permissionPresetId)
  const model = optionalText(participant.model)
  const runtimeProfileId = optionalText(participant.runtimeProfileId)
  const reasoningEffort = optionalText(participant.reasoningEffort)
  const serviceTier = optionalText(participant.serviceTier)
  const geminiAuthProfileId =
    participant.geminiAuthProfileId === null ? null : optionalText(participant.geminiAuthProfileId)
  if (
    !displayName ||
    !role ||
    !safeInstructions(participant.instructions) ||
    !configuredPreset ||
    (participant.model !== undefined && !model) ||
    (participant.runtimeProfileId !== undefined && !runtimeProfileId) ||
    (participant.reasoningEffort !== undefined && !reasoningEffort) ||
    (participant.serviceTier !== undefined && !serviceTier) ||
    (participant.geminiAuthProfileId !== undefined &&
      participant.geminiAuthProfileId !== null &&
      !geminiAuthProfileId) ||
    (participant.fastModeEnabled !== undefined &&
      typeof participant.fastModeEnabled !== 'boolean') ||
    (participant.thinkingEnabled !== undefined && typeof participant.thinkingEnabled !== 'boolean')
  ) {
    return null
  }
  return {
    agentSeatId: participant.pooledAgentId,
    participantId: participant.id,
    displayName,
    provider: participant.provider,
    role,
    instructions: participant.instructions,
    configuredPermissionPresetId: configuredPreset,
    ...(model ? { model } : {}),
    ...(runtimeProfileId ? { runtimeProfileId } : {}),
    ...(geminiAuthProfileId !== undefined ? { geminiAuthProfileId } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(typeof participant.fastModeEnabled === 'boolean'
      ? { fastModeEnabled: participant.fastModeEnabled }
      : {}),
    ...(typeof participant.thinkingEnabled === 'boolean'
      ? { thinkingEnabled: participant.thinkingEnabled }
      : {}),
    ...(serviceTier ? { serviceTier } : {})
  }
}

/**
 * Main-verifiable Channel seats come only from the canonical chat snapshot.
 * Renderer-local Agent Pool entries that have not been materialized into this
 * chat are deliberately invisible. Reusing one pooled id in two active lanes
 * is also ambiguous and therefore ineligible for zero-click mention routing.
 */
export function listChannelAgentSeatCandidates(
  chat: ChatRecord,
  providerAllowed: (provider: ProviderId) => boolean
): ChannelAgentSeatCandidate[] {
  const participants = chat.ensemble?.participants ?? []
  const bySeat = new Map<string, ChannelAgentSeatCandidate[]>()
  for (const participant of participants) {
    const candidate = candidateFromParticipant(participant, providerAllowed)
    if (!candidate) continue
    const matches = bySeat.get(candidate.agentSeatId) ?? []
    matches.push(candidate)
    bySeat.set(candidate.agentSeatId, matches)
  }
  return [...bySeat.values()]
    .filter((matches) => matches.length === 1)
    .map((matches) => matches[0])
    .sort(
      (left, right) =>
        compareText(left.displayName.toLowerCase(), right.displayName.toLowerCase()) ||
        compareText(left.agentSeatId, right.agentSeatId)
    )
}

export function resolveChannelAgentSeat(
  chat: ChatRecord,
  agentSeatId: string,
  providerAllowed: (provider: ProviderId) => boolean
): ChannelAgentSeatCandidate | null {
  if (!pooledAgentSeatId(agentSeatId)) return null
  return (
    listChannelAgentSeatCandidates(chat, providerAllowed).find(
      (candidate) => candidate.agentSeatId === agentSeatId
    ) ?? null
  )
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`
}

function domainHash(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(`${domain}\n${stableJson(value)}`, 'utf8')
    .digest('hex')
}

function domainTextHash(domain: string, value: string): string {
  return createHash('sha256').update(`${domain}\n${value}`, 'utf8').digest('hex')
}

function validPrincipalIdentifier(value: string): boolean {
  return safeIdentifier(value, MAX_AGENT_SEAT_ID_LENGTH)
}

export function hashChannelAgentWorkspacePrincipal(
  principal: ChannelAgentWorkspacePrincipal
): string {
  if (
    (principal.kind === 'workspace' && !validPrincipalIdentifier(principal.workspaceId)) ||
    (principal.kind === 'global' && !validPrincipalIdentifier(principal.chatId))
  ) {
    throw new TypeError('Channel agent workspace principal is invalid')
  }
  return domainHash(WORKSPACE_PRINCIPAL_DOMAIN, principal)
}

function assertPrincipalMatchesChat(
  chat: ChatRecord,
  principal: ChannelAgentWorkspacePrincipal
): void {
  if (chat.scope === 'global') {
    if (principal.kind !== 'global' || principal.chatId !== chat.appChatId) {
      throw new TypeError('Channel agent global principal does not match its chat')
    }
    return
  }
  if (
    !chat.workspaceId ||
    principal.kind !== 'workspace' ||
    principal.workspaceId !== chat.workspaceId
  ) {
    throw new TypeError('Channel agent workspace principal is unavailable')
  }
}

function grantPermissionPreset(
  value: PermissionPresetId
): value is ChannelAgentGrantPermissionPresetId {
  return (CHANNEL_AGENT_GRANT_PERMISSION_PRESETS as readonly PermissionPresetId[]).includes(value)
}

/**
 * Derive the exact grant hashes from main-owned chat/settings state. The
 * selected preset is authoritative: renderer-persisted participant overrides
 * cannot silently widen a read-only grant. Provider/model still influence the
 * effective posture through the normal resolver (including preview clamps).
 */
export function resolveChannelAgentGrantAuthority(
  input: ResolveChannelAgentGrantAuthorityInput
): ChannelAgentGrantAuthority {
  if (!grantPermissionPreset(input.permissionPresetId)) {
    throw new TypeError('Channel agent permission preset is unsupported')
  }
  assertPrincipalMatchesChat(input.chat, input.workspacePrincipal)
  const seat = resolveChannelAgentSeat(input.chat, input.agentSeatId, input.providerAllowed)
  if (!seat) throw new TypeError('Channel agent seat is not available in this chat')
  const effectivePermissions = resolveEffectiveRunPermissions({
    provider: seat.provider,
    workspacePath: input.chat.scope === 'global' ? undefined : input.chat.workspacePath,
    model: seat.model,
    settings: input.settings,
    presetId: input.permissionPresetId
  })
  const scope = input.workspacePrincipal.kind === 'workspace' ? 'workspace' : 'global'
  const permissionPostureHash = domainTextHash(
    PERMISSION_POSTURE_DOMAIN,
    canonicalRunPermissionPosture(effectivePermissions.approvalMode, effectivePermissions, {
      provider: seat.provider,
      scope
    })
  )
  return {
    seat,
    permissionPresetId: input.permissionPresetId,
    effectivePermissions: JSON.parse(
      JSON.stringify(effectivePermissions)
    ) as EffectiveRunPermissions,
    workspaceIdentityHash: hashChannelAgentWorkspacePrincipal(input.workspacePrincipal),
    permissionPostureHash
  }
}
