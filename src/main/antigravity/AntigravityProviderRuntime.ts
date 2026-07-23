// AntiGravity launch preparation for the official, user-installed `agy` CLI.
//
// This module deliberately owns no Electron, IPC, provider registration, or
// child-process lifecycle code. The common TaskWraith CLI runner owns stream,
// cancellation, terminal event, and audit semantics; this module makes sure it
// can receive an opted-in, sandboxed, credential-sanitized launch plan only.

import type { AppSettings, EffectiveRunPermissions } from '../store/types'
import { isAntigravityOptInEnabled } from '../../shared/retiredProviders'
import {
  AGY_BINARY_NAME,
  buildAgyReadOnlyPrintArgs,
  buildAgyWriteCapablePrintArgs,
  createAgyCliEnv,
  resolveAgyCliBinary,
  type ResolvedAgyCliBinary
} from './AntigravityCli'

export interface PrepareAntigravityProviderLaunchInput {
  settings: Pick<AppSettings, 'antigravityEnabled' | 'antigravityOptInAcceptedAt'> | null | undefined
  prompt: string
  model?: string | null
  reasoningEffort?: string | null
  approvalMode?: string | null
  effectivePermissions?: Pick<EffectiveRunPermissions, 'readOnly'> | null
  inheritedEnv?: Readonly<Record<string, string | undefined>>
}

export interface AntigravityProviderLaunchPlan {
  binary: ResolvedAgyCliBinary
  args: string[]
  env: Record<string, string>
  mode: 'plan' | 'accept-edits'
}

export interface AntigravityProviderRuntimeDependencies {
  resolveBinary?: () => Promise<ResolvedAgyCliBinary>
  createEnv?: (
    inheritedEnv?: Readonly<Record<string, string | undefined>>
  ) => Record<string, string>
}

export interface AntigravityProviderStatusInput {
  settings: Pick<AppSettings, 'antigravityEnabled' | 'antigravityOptInAcceptedAt'> | null | undefined
}

export interface AntigravityProviderStatusDependencies {
  resolveBinary?: () => Promise<ResolvedAgyCliBinary>
}

function writeCapableAgyMode(input: PrepareAntigravityProviderLaunchInput): boolean {
  if (input.effectivePermissions?.readOnly === true) return false
  const mode = typeof input.approvalMode === 'string' ? input.approvalMode.trim() : ''
  return Boolean(mode && mode !== 'plan')
}

function selectedAgyModel(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const model = value.trim()
  if (!model || /^(?:cli-default|default|auto)$/i.test(model)) return null
  return model
}

/**
 * Prepare one official-CLI launch. The default is closed: there is no binary
 * resolution, environment construction, or child-process opportunity until
 * the persisted Settings consent gate is true.
 *
 * There is intentionally no `--conversation` input. `agy --print` does not
 * expose a stable, structured conversation receipt without the forbidden
 * hook/transcript path, so S3 starts a fresh official print turn. A later
 * reviewed official session surface may add resumption without inventing IDs.
 */
export async function prepareAntigravityProviderLaunch(
  input: PrepareAntigravityProviderLaunchInput,
  deps: AntigravityProviderRuntimeDependencies = {}
): Promise<AntigravityProviderLaunchPlan> {
  if (!isAntigravityOptInEnabled(input.settings)) {
    throw new Error(
      'AntiGravity is disabled until the user enables it and records informed risk acceptance in Settings → Providers.'
    )
  }

  const binary = await (deps.resolveBinary ?? resolveAgyCliBinary)()
  if (!binary.binaryPath) {
    throw new Error(binary.error || `The official Antigravity CLI (${AGY_BINARY_NAME}) was not found.`)
  }

  const mode = writeCapableAgyMode(input) ? 'accept-edits' : 'plan'
  const argsInput = {
    prompt: input.prompt,
    model: selectedAgyModel(input.model),
    reasoningEffort: input.reasoningEffort
  }
  return {
    binary,
    args:
      mode === 'plan'
        ? buildAgyReadOnlyPrintArgs(argsInput)
        : buildAgyWriteCapablePrintArgs(argsInput),
    // Every launch uses the central S2 sanitizer. No runtime profile, secret,
    // OAuth token, or credential selector is consulted or forwarded here.
    env: (deps.createEnv ?? createAgyCliEnv)(input.inheritedEnv),
    mode
  }
}

/**
 * Status is deliberately non-invasive: it checks the explicit consent gate and
 * official binary presence only. Authentication/model discovery is deferred to
 * S4's post-opt-in configured-provider snapshot, so this helper never starts
 * `agy`, opens a browser, reads a keyring, or probes account state.
 */
export async function getAntigravityProviderStatus(
  input: AntigravityProviderStatusInput,
  deps: AntigravityProviderStatusDependencies = {}
): Promise<Record<string, unknown>> {
  if (!isAntigravityOptInEnabled(input.settings)) {
    return {
      provider: 'antigravity',
      label: 'AntiGravity',
      available: false,
      setupRequired: true,
      authState: 'consent-required',
      binaryPath: null,
      binarySource: 'disabled',
      supportsSessions: false,
      supportsApprovals: false,
      supportsQuota: false,
      supportsMcpStatus: false,
      error: 'AntiGravity is disabled until informed risk acceptance is recorded in Settings → Providers.'
    }
  }

  const binary = await (deps.resolveBinary ?? resolveAgyCliBinary)()
  if (!binary.binaryPath) {
    return {
      provider: 'antigravity',
      label: 'AntiGravity',
      available: false,
      setupRequired: true,
      authState: 'unknown',
      binaryPath: null,
      binarySource: binary.source,
      supportsSessions: false,
      supportsApprovals: false,
      supportsQuota: false,
      supportsMcpStatus: false,
      error: binary.error
    }
  }

  return {
    provider: 'antigravity',
    label: 'AntiGravity',
    available: true,
    setupRequired: false,
    authState: 'unknown',
    binaryPath: binary.binaryPath,
    binarySource: binary.source,
    supportsSessions: false,
    supportsApprovals: false,
    supportsQuota: false,
    supportsMcpStatus: false
  }
}

export function getAntigravityProviderMcpStatus(): Record<string, unknown> {
  return {
    provider: 'antigravity',
    available: false,
    enabled: false,
    source: 'unsupported',
    serverName: null,
    tools: [],
    sections: [],
    message:
      'AntiGravity S3 uses only the official agy print-mode transport; no TaskWraith MCP bridge, plugin, or hook is attached.'
  }
}
