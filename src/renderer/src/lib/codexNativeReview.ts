import type { AgentRunPayload } from '../../../main/run/AgentRunTypes'
import type { EffectiveRunPermissions } from '../../../main/store/types'

export type CodexNativeReviewSignedRunPayload = Pick<
  AgentRunPayload,
  | 'provider'
  | 'scope'
  | 'prompt'
  | 'resumeFallbackPrompt'
  | 'appRunId'
  | 'appChatId'
  | 'approvalMode'
  | 'workflowMode'
  | 'externalPathGrants'
  | 'runtimeProfileId'
  | 'effectivePermissions'
  | 'effectivePermissionsSignature'
  | 'projectReferenceContext'
>

export type CodexNativeReviewComposedPayload = Pick<AgentRunPayload, 'prompt'> &
  Partial<Omit<AgentRunPayload, 'prompt'>>

export interface CodexNativeReviewInvocationParams {
  readonly model?: string | null
  readonly target: { readonly type: 'uncommittedChanges' }
  readonly delivery: 'inline'
  readonly cwd: string
  readonly appRunId: string
  readonly appChatId: string
  readonly usagePromptText?: string
  /**
   * Exact posture-bearing fields returned by main's `compose-run`. The
   * renderer transports this envelope but never creates or repairs its HMAC.
   */
  readonly signedRunPayload: CodexNativeReviewSignedRunPayload
}

function requiredString(value: unknown, label: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) throw new Error(`Native Codex review requires ${label}.`)
  return normalized
}

function cloneEffectivePermissions(permissions: EffectiveRunPermissions): EffectiveRunPermissions {
  return {
    ...permissions,
    agenticServices: { ...permissions.agenticServices },
    externalPathGrants: permissions.externalPathGrants.map((grant) => ({ ...grant })),
    workspaceGrantServiceIds: [...permissions.workspaceGrantServiceIds]
  }
}

/**
 * Build native-review IPC params from a payload already composed and signed by
 * main. Native review is intentionally read-only; a missing, writable, or
 * unsigned payload fails closed instead of asking the renderer to mint trust.
 */
export function buildCodexNativeReviewInvocationParams(input: {
  readonly composedPayload: CodexNativeReviewComposedPayload
  readonly cwd: string
  readonly model?: string | null
  readonly usagePromptText?: string
}): CodexNativeReviewInvocationParams {
  const payload = input.composedPayload
  const cwd = requiredString(input.cwd, 'an exact workspace')
  const appRunId = requiredString(payload.appRunId, 'an exact run id')
  const appChatId = requiredString(payload.appChatId, 'an exact chat id')
  const signature = requiredString(
    payload.effectivePermissionsSignature,
    'a main-signed permission posture'
  )
  const permissions = payload.effectivePermissions

  if (payload.provider !== 'codex' || payload.scope !== 'workspace') {
    throw new Error('Native review requires a main-composed workspace Codex payload.')
  }
  if (
    payload.approvalMode !== 'plan' ||
    payload.workflowMode !== 'normal' ||
    !permissions ||
    permissions.readOnly !== true ||
    permissions.approvalMode !== 'plan'
  ) {
    throw new Error('Native Codex review requires a signed read-only permission posture.')
  }

  const signedRunPayload: CodexNativeReviewSignedRunPayload = {
    provider: 'codex',
    scope: 'workspace',
    prompt: payload.prompt,
    appRunId,
    appChatId,
    approvalMode: 'plan',
    workflowMode: 'normal',
    effectivePermissions: cloneEffectivePermissions(permissions),
    effectivePermissionsSignature: signature,
    ...(payload.resumeFallbackPrompt ? { resumeFallbackPrompt: payload.resumeFallbackPrompt } : {}),
    ...(payload.externalPathGrants
      ? { externalPathGrants: payload.externalPathGrants.map((grant) => ({ ...grant })) }
      : {}),
    ...(payload.runtimeProfileId ? { runtimeProfileId: payload.runtimeProfileId } : {}),
    ...(payload.projectReferenceContext
      ? { projectReferenceContext: payload.projectReferenceContext }
      : {})
  }

  return {
    model: input.model,
    target: { type: 'uncommittedChanges' },
    delivery: 'inline',
    cwd,
    appRunId,
    appChatId,
    ...(input.usagePromptText ? { usagePromptText: input.usagePromptText } : {}),
    signedRunPayload
  }
}
