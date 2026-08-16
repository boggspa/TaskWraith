// AntiGravity launch preparation for the official, user-installed `agy` CLI.
//
// This module deliberately owns no Electron, IPC, provider registration, or
// child-process lifecycle code. The common TaskWraith CLI runner owns stream,
// cancellation, terminal event, and audit semantics; this module makes sure it
// can receive an opted-in, sandboxed, credential-sanitized launch plan only.

import type { AgenticServicesSettings, AppSettings, EffectiveRunPermissions } from '../store/types'
import { agenticServicesDenyWrites } from '../AgenticServiceWriteClamp'
import { isReconRunPosture } from '../ReconPosture'
import { isAntigravityOptInEnabled } from '../../shared/retiredProviders'
import { isAntigravityGeminiApiKeyConfigured } from './AntigravityGeminiApiKeyConfiguredSignal'
import { verifyAgyBinaryProvenance, type AgyBinaryProvenance } from './AntigravityBinaryProvenance'
import {
  AGY_BINARY_NAME,
  buildAgyReadOnlyPrintArgs,
  buildAgyWriteCapablePrintArgs,
  createAgyCliEnv,
  resolveAgyCliBinary,
  type ResolvedAgyCliBinary
} from './AntigravityCli'
import { parseAgyProjectBoundSessionId } from './AntigravityConversationReceipt'
import { withAntigravityLongTurnProgress } from './AntigravityLongTurnProgress'

export interface PrepareAntigravityProviderLaunchInput {
  settings:
    | Pick<AppSettings, 'antigravityEnabled' | 'antigravityOptInAcceptedAt'>
    | null
    | undefined
  prompt: string
  model?: string | null
  reasoningEffort?: string | null
  approvalMode?: string | null
  /**
   * Post-clamp workflow discriminator. Ask and Plan share `approvalMode: plan`
   * and `readOnly: true`; only the signed normal/read_only tuple identifies an
   * attended Ask turn whose native writes may be opened behind the live hook.
   */
  workflowMode?: string | null
  effectivePermissions?:
    | (Pick<EffectiveRunPermissions, 'readOnly'> &
        Partial<Pick<EffectiveRunPermissions, 'presetId'>>)
    | null
  /**
   * The user's shell/file service policy. Required for a write-capable turn to
   * be honest: agy has no per-tool approval bridge, so a `deny` can only be
   * enforced by launching read-only. Omitting it does NOT deny — callers that
   * genuinely have no settings context keep the previous behaviour.
   */
  agenticServices?: Pick<AgenticServicesSettings, 'shellCommands' | 'fileChanges'> | null
  /**
   * Main-owned proof that agy is writing in a separate selected worktree,
   * where its writes cannot race the base checkout.
   */
  isolatedMutationWorkspace?: boolean
  /**
   * Main-owned proof that the PreToolUse approval bridge is live for this run,
   * so every native tool call — including each mutation — is arbitrated by the
   * ordinary TaskWraith approval gate before agy performs it.
   *
   * This is the OTHER way to earn write capability. Shared checkouts were
   * plan-only for one stated reason: agy had no per-tool approval seam, so a
   * denied file change could only be honoured by refusing write capability
   * before the child started. The documented lifecycle hook is that seam, and
   * it is verified loading in agy's own log, so the premise no longer holds.
   * Callers that cannot stand up the bridge must leave this false: the run
   * then stays plan-only exactly as before.
   */
  perToolApprovalBridge?: boolean
  inheritedEnv?: Readonly<Record<string, string | undefined>>
  /** Exact opaque owner issued for this seat by workspace-lock admission. */
  workspaceLockOwnerId?: string | null
  /**
   * Prior TaskWraith-tagged agy conversation to resume. Bare legacy UUIDs are
   * intentionally dropped because they may belong to `default-cli-project`,
   * whose headless read prompts cannot be serviced.
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
    inheritedEnv?: Readonly<Record<string, string | undefined>>,
    extraEnv?: Readonly<Record<string, string | undefined>>
  ) => Record<string, string>
}

export interface AntigravityProviderStatusInput {
  settings:
    | Pick<AppSettings, 'antigravityEnabled' | 'antigravityOptInAcceptedAt'>
    | null
    | undefined
}

export interface AntigravityProviderStatusDependencies {
  resolveBinary?: () => Promise<ResolvedAgyCliBinary>
  /** Test seam; production reads the shared nonsecret configured-key signal. */
  isGeminiApiKeyConfigured?: () => boolean
  /** Test seam; production inspects the resolved binary's code signature. */
  verifyBinaryProvenance?: (binaryPath: string | null) => Promise<AgyBinaryProvenance>
}

function writeCapableAgyMode(input: PrepareAntigravityProviderLaunchInput): boolean {
  const reconPermissions = input.effectivePermissions?.presetId
    ? {
        presetId: input.effectivePermissions.presetId,
        readOnly: input.effectivePermissions.readOnly
      }
    : null
  const bridgeArbitratedAsk =
    input.perToolApprovalBridge === true &&
    isReconRunPosture({
      approvalMode: input.approvalMode,
      workflowMode: input.workflowMode,
      effectivePermissions: reconPermissions
    })
  if (input.effectivePermissions?.readOnly === true && !bridgeArbitratedAsk) return false
  // A service the user set to `deny` is honoured here, before the child
  // starts. Same predicate ProviderCapabilities reports with, so the contract
  // cannot claim plan while the argv says accept-edits.
  if (agenticServicesDenyWrites(input.agenticServices)) return false
  const mode = typeof input.approvalMode === 'string' ? input.approvalMode.trim() : ''
  if (!mode || (mode === 'plan' && !bridgeArbitratedAsk)) return false
  // Either containment is sufficient: writes are isolated from the base
  // checkout, or every individual write is arbitrated by the approval gate.
  // With neither, a shared checkout stays plan-only.
  return input.isolatedMutationWorkspace === true || input.perToolApprovalBridge === true
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
 * Resumption passes `--conversation <uuid>` only for a TaskWraith-tagged receipt
 * created after an explicit agy project launch. The CLI's raw cwd -> uuid cache
 * remains the source of the UUID; TaskWraith's tag records the additional fact
 * that this adapter created the session with `--new-project`. Untagged legacy
 * ids start fresh once so they cannot reopen `default-cli-project` and lose
 * headless workspace-read authority.
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
    throw new Error(
      binary.error || `The official Antigravity CLI (${AGY_BINARY_NAME}) was not found.`
    )
  }

  const mode = writeCapableAgyMode(input) ? 'accept-edits' : 'plan'
  const resumedConversationId = parseAgyProjectBoundSessionId(input.conversationId)
  const argsInput = {
    prompt: withAntigravityLongTurnProgress(input.prompt),
    model: selectedAgyModel(input.model),
    reasoningEffort: input.reasoningEffort,
    ...(resumedConversationId ? { conversationId: resumedConversationId } : { newProject: true })
  }
  const args =
    mode === 'plan'
      ? buildAgyReadOnlyPrintArgs(argsInput)
      : buildAgyWriteCapablePrintArgs(argsInput)
  // Signed Full Access is the one posture where every native capability is
  // already pregranted, so agy's own confirmation layer (fatal under headless
  // print mode) is skipped. This is NOT a general bypass: the terminal
  // sandbox stays on, and the PreToolUse hook bridge still routes every
  // command through TaskWraith's gate, whose universal holds (remote egress,
  // catastrophic deletion) hold at Full Access too.
  if (
    input.effectivePermissions?.presetId === 'full_access' &&
    input.effectivePermissions.readOnly !== true &&
    !agenticServicesDenyWrites(input.agenticServices)
  ) {
    args.unshift('--dangerously-skip-permissions')
  }
  return {
    binary,
    resumedConversationId,
    args,
    // Every launch uses the central S2 sanitizer. No runtime profile, secret,
    // OAuth token, or credential selector is consulted or forwarded here.
    env: (deps.createEnv ?? createAgyCliEnv)(
      input.inheritedEnv,
      input.workspaceLockOwnerId
        ? { TASKWRAITH_LOCK_OWNER_ID: input.workspaceLockOwnerId }
        : undefined
    ),
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
