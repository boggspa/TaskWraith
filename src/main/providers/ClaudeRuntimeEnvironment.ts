import {
  createResolvedProviderEnv,
  RuntimeProfileEnvironmentResolutionError,
  type CliProviderRuntimeDependencies
} from './CliProviderRuntime'
import type { AuditToolContext } from '../mcp/AuditToolExecutors'
import type { AgentRunPayload, AgentRunRoute } from '../run/AgentRunTypes'
import type { AuditRunIdentity, ChatScope, RuntimeProfile } from '../store/types'

export interface ClaudeRuntimeRouteEnvironmentInput {
  readonly scope: ChatScope
  readonly workspace?: string | null
  readonly runId?: string | null
  readonly chatId?: string | null
  readonly apiKey?: string | null
  readonly auditRun?: boolean
}

export interface ClaudeEnvironmentAuthorityInput extends ClaudeRuntimeRouteEnvironmentInput {
  readonly runtimeProfile: RuntimeProfile
  readonly binaryPath?: string | null
}

export interface ClaudeEnvironmentAuthoritySnapshot {
  readonly env: Readonly<Record<string, string>>
  readonly runtimeProfileId: string
  readonly binaryPath: string | null
  readonly hasAnthropicApiKey: boolean
}

export class ClaudeEnvironmentAuthorityError extends Error {
  readonly phase = 'environment-authority' as const
  readonly terminal = true as const
  readonly fallbackAllowed = false as const

  constructor(message: string) {
    super(message)
    this.name = 'ClaudeEnvironmentAuthorityError'
  }
}

function normalizedOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/**
 * Canonicalize Claude's default profile while the coordinator still owns the
 * dispatch payload. Downstream launch preparation consumes this exact object;
 * it must never infer a different profile from later mutable store state.
 */
export function canonicalizeClaudeRuntimeProfilePayload(
  payload: AgentRunPayload,
  profiles: readonly RuntimeProfile[]
): RuntimeProfile {
  if (payload.provider !== 'claude') {
    throw new ClaudeEnvironmentAuthorityError(
      'Claude runtime-profile authority cannot prepare another provider.'
    )
  }
  if (
    payload.runtimeProfile &&
    payload.runtimeProfileId &&
    payload.runtimeProfile.id !== payload.runtimeProfileId
  ) {
    throw new ClaudeEnvironmentAuthorityError(
      'The prepared Claude runtime profile does not match its selected identity.'
    )
  }
  const profile = resolveClaudeRuntimeProfile({
    scope: payload.scope,
    runtimeProfileId: payload.runtimeProfileId,
    profiles
  })
  payload.runtimeProfileId = profile.id
  payload.runtimeProfile = profile
  return profile
}

export function resolveClaudeAuditEnvironmentAuthority(input: {
  readonly route: AgentRunRoute
  readonly payloadAudit?: AuditRunIdentity
  readonly registryAudit?: AuditToolContext | null
}): boolean {
  const appRunId = normalizedOptionalString(input.route.appRunId)
  if (!appRunId) {
    throw new ClaudeEnvironmentAuthorityError(
      'Claude audit authority requires the coordinator-assigned run identity.'
    )
  }
  if (!input.payloadAudit && !input.registryAudit) return false
  if (!input.payloadAudit || !input.registryAudit) {
    throw new ClaudeEnvironmentAuthorityError(
      'Claude audit identity is not registered for this exact run.'
    )
  }
  if (
    input.registryAudit.provider !== 'claude' ||
    input.registryAudit.runId !== appRunId ||
    input.registryAudit.auditRunId !== input.payloadAudit.auditRunId ||
    input.registryAudit.role !== input.payloadAudit.role ||
    input.registryAudit.dimension !== input.payloadAudit.dimension
  ) {
    throw new ClaudeEnvironmentAuthorityError(
      'Claude audit identity does not match the live audit registry.'
    )
  }
  return true
}

/** Validate the immutable route/profile/workspace facts prepared upstream. */
export function resolvePreparedClaudeRunAuthority(input: {
  readonly payload: AgentRunPayload
  readonly route: AgentRunRoute
  readonly registryAudit?: AuditToolContext | null
}): { runtimeProfile: RuntimeProfile; auditRun: boolean } {
  const { payload, route } = input
  if (payload.provider !== 'claude') {
    throw new ClaudeEnvironmentAuthorityError('Claude launch received another provider route.')
  }
  if (!route.appRunId || payload.appRunId !== route.appRunId) {
    throw new ClaudeEnvironmentAuthorityError(
      'Claude launch route does not match the coordinator-assigned run identity.'
    )
  }
  if ((payload.appChatId || null) !== (route.appChatId || null)) {
    throw new ClaudeEnvironmentAuthorityError(
      'Claude launch route does not match the coordinator-assigned chat identity.'
    )
  }
  const profile = payload.runtimeProfile
  if (
    !profile ||
    !payload.runtimeProfileId ||
    profile.id !== payload.runtimeProfileId ||
    profile.provider !== 'claude' ||
    profile.scope !== payload.scope
  ) {
    throw new ClaudeEnvironmentAuthorityError(
      'Claude launch did not receive the exact preflight runtime-profile authority.'
    )
  }
  if (profile.workspaceMode === 'container') {
    throw new ClaudeEnvironmentAuthorityError(
      'Claude container runtime profiles are not enabled for this launch path.'
    )
  }
  if (profile.workspaceMode === 'worktree') {
    const intent = payload.runtimeWorktree
    if (
      payload.scope !== 'workspace' ||
      !intent?.requested ||
      intent.status !== 'selected' ||
      !intent.effectiveWorkspacePath ||
      intent.effectiveWorkspacePath !== payload.workspace
    ) {
      throw new ClaudeEnvironmentAuthorityError(
        'Claude worktree runtime authority does not match the preflight workspace.'
      )
    }
  }
  return {
    runtimeProfile: profile,
    auditRun: resolveClaudeAuditEnvironmentAuthority({
      route,
      payloadAudit: payload.auditRun,
      registryAudit: input.registryAudit
    })
  }
}

/** Variables that must follow a Claude run through either transport. */
export function buildClaudeRuntimeRouteEnvironment(
  input: ClaudeRuntimeRouteEnvironmentInput
): Record<string, string> {
  return {
    TASKWRAITH_PARENT_PROVIDER: 'claude',
    TASKWRAITH_RUN_ID: input.runId || '',
    TASKWRAITH_CHAT_ID: input.chatId || '',
    TASKWRAITH_WORKSPACE_PATH: input.scope === 'global' ? '' : input.workspace || '',
    // Always stamp the negative case so a runtime profile cannot self-enrol a
    // normal or maintenance run into TaskWraith's audit-only MCP surface.
    TASKWRAITH_MCP_AUDIT: input.auditRun ? '1' : '0',
    ...(input.apiKey ? { ANTHROPIC_API_KEY: input.apiKey } : {})
  }
}

export function resolveClaudeRuntimeProfile(input: {
  readonly scope: ChatScope
  readonly runtimeProfileId?: string | null
  readonly profiles: readonly RuntimeProfile[]
}): RuntimeProfile {
  const candidates = input.profiles.filter(
    (profile) => profile.provider === 'claude' && profile.scope === input.scope
  )
  const matches = input.runtimeProfileId
    ? candidates.filter((profile) => profile.id === input.runtimeProfileId)
    : candidates.slice(0, 1)
  if (matches.length !== 1) {
    throw new ClaudeEnvironmentAuthorityError(
      input.runtimeProfileId
        ? 'The selected Claude runtime profile is missing, duplicated, or has the wrong scope.'
        : 'No canonical Claude runtime profile is available for this chat scope.'
    )
  }
  return matches[0]
}

/**
 * Resolve one immutable launch-environment authority snapshot before a Claude
 * provider session or abort controller is registered. The same frozen env must
 * be handed to the SDK and any CLI fallback; a later logical run prepares a new
 * snapshot and may therefore observe an intentional secret/profile rotation.
 */
export function prepareClaudeEnvironmentAuthority(
  input: ClaudeEnvironmentAuthorityInput,
  deps?: CliProviderRuntimeDependencies
): ClaudeEnvironmentAuthoritySnapshot {
  if (input.runtimeProfile.provider !== 'claude' || input.runtimeProfile.scope !== input.scope) {
    throw new ClaudeEnvironmentAuthorityError(
      'The resolved Claude runtime profile does not own this chat scope.'
    )
  }
  try {
    const env = Object.freeze(
      createResolvedProviderEnv(
        {
          FORCE_COLOR: '0',
          NO_COLOR: '1',
          TASKWRAITH_RUNTIME_PROFILE_ID: input.runtimeProfile.id,
          ...buildClaudeRuntimeRouteEnvironment(input)
        },
        input.binaryPath,
        deps,
        input.runtimeProfile
      )
    )
    return Object.freeze({
      env,
      runtimeProfileId: input.runtimeProfile.id,
      binaryPath: input.binaryPath || null,
      hasAnthropicApiKey: Boolean(env.ANTHROPIC_API_KEY)
    })
  } catch (error) {
    const message =
      error instanceof RuntimeProfileEnvironmentResolutionError
        ? error.message
        : 'The Claude runtime-profile environment could not be resolved safely.'
    throw new ClaudeEnvironmentAuthorityError(message)
  }
}
