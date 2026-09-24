/**
 * Runtime Profile form helpers for the Settings panel — extracted from
 * `../SettingsPanel.tsx` (behavior-preserving move). Type-only imports from
 * `main/` are erased at emit; runtime helpers come from the sibling
 * `userMcpServerUtils` module, so no renderer→main runtime edge is added.
 */
import type { ProviderId, RuntimeProfile } from '../../../../main/store/types'
import {
  formatUserMcpServerEnv,
  formatUserMcpServerSecretRefs,
  omitSecretBackedFields
} from './userMcpServerUtils'

export type RuntimeProfileFormState = {
  id: string
  name: string
  provider: ProviderId
  scope: 'workspace' | 'global'
  workspaceMode: 'local' | 'worktree' | 'container'
  binaryPath: string
  envText: string
  envSecretText: string
  approvalMode: string
  networkPolicy: 'inherit' | 'allow' | 'deny'
  persistence: 'reusable' | 'ephemeral'
}

export type RuntimeProfileSecretValues = {
  env: Record<string, string>
}

export function emptyRuntimeProfileForm(provider: ProviderId = 'codex'): RuntimeProfileFormState {
  return {
    id: '',
    name: '',
    provider,
    scope: 'workspace',
    workspaceMode: 'local',
    binaryPath: '',
    envText: '',
    envSecretText: '',
    approvalMode: 'default',
    networkPolicy: 'inherit',
    persistence: 'reusable'
  }
}

export function formatRuntimeProfileSecretRefs(names?: string[]): string {
  return formatUserMcpServerSecretRefs(names)
}

export function formFromRuntimeProfile(profile: RuntimeProfile): RuntimeProfileFormState {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    scope: profile.scope,
    workspaceMode: profile.workspaceMode,
    binaryPath: profile.binaryPath || '',
    envText: formatUserMcpServerEnv(omitSecretBackedFields(profile.env, profile.secretRefs?.env)),
    envSecretText: formatRuntimeProfileSecretRefs(profile.secretRefs?.env),
    approvalMode: profile.approvalMode || 'default',
    networkPolicy: profile.networkPolicy,
    persistence: profile.persistence
  }
}
