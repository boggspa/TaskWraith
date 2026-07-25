// AntiGravity launch preparation for the official, user-installed `agy` CLI.
//
// This module deliberately owns no Electron, IPC, provider registration, or
// child-process lifecycle code. The common TaskWraith CLI runner owns stream,
// cancellation, terminal event, and audit semantics; this module makes sure it
// can receive an opted-in, sandboxed, credential-sanitized launch plan only.

import type { AgenticServicesSettings, AppSettings, EffectiveRunPermissions } from '../store/types'
import { agenticServicesDenyWrites } from '../AgenticServiceWriteClamp'
import { isAntigravityOptInEnabled } from '../../shared/retiredProviders'
import { isAntigravityGeminiApiKeyConfigured } from './AntigravityGeminiApiKeyConfiguredSignal'
import {
  verifyAgyBinaryProvenance,
  type AgyBinaryProvenance
} from './AntigravityBinaryProvenance'
import {
  AGY_BINARY_NAME,
  buildAgyReadOnlyPrintArgs,
  buildAgyWriteCapablePrintArgs,
  createAgyCliEnv,
  normalizeAgyConversationId,
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
  /**
   * The user's shell/file service policy. Required for a write-capable turn to
   * be honest: agy has no per-tool approval bridge, so a `deny` can only be
   * enforced by launching read-only. Omitting it does NOT deny — callers that
   * genuinely have no settings context keep the previous behaviour.
   */
  agenticServices?: Pick<AgenticServicesSettings, 'shellCommands' | 'fileChanges'> | null
  inheritedEnv?: Readonly<Record<string, string | undefined>>
  /**
   * Prior agy conversation to resume, learned from the CLI's own receipt after a
   * previous turn (never synthesized). Non-uuid values are dropped by
   * `normalizeAgyConversationId` and simply start a fresh conversation.
   */
  conversationId?: string | null
}

export interface AntigravityProviderLaunchPlan {
  binary: ResolvedAgyCliBinary
  args: string[]
  env: Record<string, string>
  mode: 'plan' | 'accept-edits'
  /** The id actually placed on the argv, or null for a fresh conversation. */
  resumedConversationId: string | null
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
  /** Test seam; production reads the shared nonsecret configured-key signal. */
  isGeminiApiKeyConfigured?: () => boolean
  /** Test seam; production inspects the resolved binary's code signature. */
  verifyBinaryProvenance?: (binaryPath: string | null) => Promise<AgyBinaryProvenance>
}

function writeCapableAgyMode(input: PrepareAntigravityProviderLaunchInput): boolean {
  if (input.effectivePermissions?.readOnly === true) return false
  // The official agy CLI exposes no per-tool approval bridge, so a denied
  // shell/file service can only be honoured here, by refusing write capability
  // before the child starts. Same predicate ProviderCapabilities reports with,
  // so the contract cannot claim plan while the argv says accept-edits.
  if (agenticServicesDenyWrites(input.agenticServices)) return false
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
 * Resumption (added 2026-07-25) passes `--conversation <uuid>` when the caller
 * supplies an id the CLI itself previously reported. The earlier note here said
 * no stable structured receipt existed outside the hook/transcript path; that
 * was wrong — `~/.gemini/antigravity-cli/cache/last_conversations.json` is a
 * plain `cwd -> uuid` map, which `AntigravityConversationReceipt` reads. No id
 * is ever invented: agy silently ignores an unknown id and starts a fresh
 * conversation, so only uuids it minted are forwarded.
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
  const resumedConversationId = normalizeAgyConversationId(input.conversationId)
  const argsInput = {
    prompt: input.prompt,
    model: selectedAgyModel(input.model),
    reasoningEffort: input.reasoningEffort,
    ...(resumedConversationId ? { conversationId: resumedConversationId } : {})
  }
  return {
    binary,
    resumedConversationId,
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
 * Status is deliberately non-invasive: it checks the explicit consent gate,
 * official binary presence, and the nonsecret configured-key boolean only.
 * Authentication/model discovery is deferred to S4's post-opt-in
 * configured-provider snapshot, so this helper never starts `agy`, opens a
 * browser, reads a keyring, decrypts the stored key, or probes account state.
 *
 * Availability is a lane union, mirroring every other AntiGravity chokepoint
 * (`selectableProviderIds`, `assertLiveProviderId`, ComposerService): the
 * ban-risk agy opt-in admits the CLI lane, and a configured Gemini API key
 * admits the SDK lane. The key lane never needs the agy binary — its turns
 * run through the official SDK — so a key-only install with no CLI is
 * available, and this status saying "not available" was what blocked key-lane
 * runs at preflight even after dispatch admission was wired.
 */
export async function getAntigravityProviderStatus(
  input: AntigravityProviderStatusInput,
  deps: AntigravityProviderStatusDependencies = {}
): Promise<Record<string, unknown>> {
  let geminiApiKeyConfigured = false
  try {
    geminiApiKeyConfigured =
      (deps.isGeminiApiKeyConfigured ?? isAntigravityGeminiApiKeyConfigured)() === true
  } catch {
    geminiApiKeyConfigured = false
  }

  if (!isAntigravityOptInEnabled(input.settings)) {
    if (geminiApiKeyConfigured) {
      // Key lane only: available without consent to the separate agy ban-risk
      // lane and without any CLI on the machine.
      return {
        provider: 'antigravity',
        label: 'AntiGravity',
        available: true,
        setupRequired: false,
        authState: 'api-key',
        binaryPath: null,
        binarySource: 'gemini-api',
        supportsSessions: false,
        supportsApprovals: false,
        supportsQuota: false,
        supportsMcpStatus: false
      }
    }
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
      error:
        'AntiGravity is disabled until informed risk acceptance is recorded or a Gemini API key is configured in Settings → Providers.'
    }
  }

  const binary = await (deps.resolveBinary ?? resolveAgyCliBinary)()
  if (!binary.binaryPath) {
    if (geminiApiKeyConfigured) {
      // The agy lane is consented but its CLI is missing; the key lane still
      // runs. Dispatch reports the binary error if an agy model is chosen.
      return {
        provider: 'antigravity',
        label: 'AntiGravity',
        available: true,
        setupRequired: false,
        authState: 'api-key',
        binaryPath: null,
        binarySource: binary.source,
        supportsSessions: false,
        supportsApprovals: false,
        supportsQuota: false,
        supportsMcpStatus: false
      }
    }
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

  // Signature inspection only — codesign reads the file and never executes it,
  // so the "never starts agy" invariant above still holds. Reported, not
  // enforced: see AntigravityBinaryProvenance for why this cannot be a gate.
  const provenance = await (deps.verifyBinaryProvenance ?? verifyAgyBinaryProvenance)(
    binary.binaryPath
  )

  return {
    provider: 'antigravity',
    label: 'AntiGravity',
    available: true,
    setupRequired: false,
    authState: geminiApiKeyConfigured ? 'api-key' : 'unknown',
    binaryPath: binary.binaryPath,
    binarySource: binary.source,
    binaryProvenance: provenance.state,
    binaryTeamId: provenance.teamId,
    binaryAuthority: provenance.authority,
    ...(provenance.detail ? { binaryProvenanceDetail: provenance.detail } : {}),
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
