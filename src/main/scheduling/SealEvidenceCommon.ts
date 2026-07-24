import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveEffectiveRunPermissions } from '../EffectiveRunPermissions'
import {
  resolveUnattendedApprovalMode,
  unattendedElevationPresetId,
  type UnattendedElevationAck
} from '../UnattendedPostureGate'
import { isPreviewRiskModel } from '../../shared/previewModelCatalog'
import { getStaticProviderModels } from '../providers/StaticProviderModels'
import { resolveContextWindow } from '../../shared/contextWindows'
import { taskWraithMcpAdvertisedToolNamesForProfile } from '../mcp/McpToolProfiles'
import type {
  ScheduledOccurrenceAuthorityRoot,
  ScheduledOccurrenceLaunchProvider
} from '../ScheduledOccurrenceAuthorityRootStore'
import type {
  ProviderLaunchCommonAuthority,
  ProviderToolSurfaceAuthority,
  CliRuntimeIdentityAuthority,
  LiveProviderLaunchId
} from '../ProviderLaunchAuthorityDigest'
import type {
  AppSettings,
  EffectiveRunPermissions,
  PermissionPresetId,
  ProviderId,
  TaskWraithMcpProfileId
} from '../store/types'
import {
  SealEvidenceError,
  SealEvidenceFileHasher,
  interpreterRuntimeAttestationSha256,
  launchArgsTemplateSha256,
  nearestPackageManifestPath,
  providerLaunchHmacOfCanonicalJson,
  sha256HexOfCanonicalJson,
  type CanonicalEvidenceValue
} from './SealEvidenceCore'

/**
 * Shared evidence builders for the per-provider scheduled-launch producers.
 *
 * Everything here derives from the same modules live dispatch consumes
 * (StaticProviderModels, McpToolProfiles, EffectiveRunPermissions,
 * UnattendedPostureGate) or from explicit dispatch-time facts handed in by
 * the wiring. Fields that cannot be derived honestly throw SealEvidenceError.
 */

export interface SealEvidenceDeps {
  readonly authorityRoot: ScheduledOccurrenceAuthorityRoot
  readonly hasher: SealEvidenceFileHasher
  readonly versionProbe: SealEvidenceVersionProbe
  /** app.getVersion() — the adapter code ships with the app bundle. */
  readonly appVersion: string
}

/** Session identity facts for one seat, as dispatch will actually launch it. */
export interface SeatSessionFacts {
  readonly sessionMode: 'fresh' | 'resume' | 'reusable'
  /** Required for resume/reusable; must be null for fresh. */
  readonly providerSessionId: string | null
  /**
   * Main-owned seat generation record for a resumed/reusable seat, or null
   * when main tracks no generation for this seat. Ignored for fresh seats.
   */
  readonly seatGeneration: CanonicalEvidenceValue | null
}

export interface CommonLaunchFacts {
  readonly provider: LiveProviderLaunchId
  /** The exact wire model dispatch passes to the adapter. */
  readonly model: string
  readonly promptEnvelope: Readonly<{
    /** composed.prompt — the full provider-visible contextual prompt. */
    contextualPrompt: string
    /** composer.finalPrompt — the user-facing prompt before context turns. */
    finalPrompt: string
    /** Runtime preamble version applied by prompt composition, if any. */
    runtimePreambleVersion: string | null
  }>
  readonly session: SeatSessionFacts
  /** The complete resolved spawn/request environment for this seat. */
  readonly resolvedEnv: Readonly<Record<string, string>>
  /** Secret-free credential state descriptor (HMAC-consumed only). */
  readonly credentialState: CanonicalEvidenceValue
  /** Secret-redacted provider configuration evidence object. */
  readonly providerConfiguration: CanonicalEvidenceValue
  /** The live capability contract snapshot used to choose this launch path. */
  readonly capabilityContract: CanonicalEvidenceValue
}

export function buildCommonLaunchAuthority(
  deps: SealEvidenceDeps,
  facts: CommonLaunchFacts
): ProviderLaunchCommonAuthority {
  const { session } = facts
  if (session.sessionMode === 'fresh') {
    if (session.providerSessionId !== null) {
      throw new SealEvidenceError('A fresh seat cannot carry a provider session id.')
    }
  } else if (typeof session.providerSessionId !== 'string' || !session.providerSessionId) {
    throw new SealEvidenceError('A resumed or reusable seat requires its provider session id.')
  }
  return {
    adapterRevision: `taskwraith-${facts.provider}-adapter@${deps.appVersion}`,
    model: facts.model,
    modelCapabilitySha256: modelCapabilitySha256(facts.provider, facts.model),
    promptEnvelopeSha256: sha256HexOfCanonicalJson({
      schemaVersion: 1,
      contextualPrompt: facts.promptEnvelope.contextualPrompt,
      finalPrompt: facts.promptEnvelope.finalPrompt,
      runtimePreambleVersion: facts.promptEnvelope.runtimePreambleVersion
    }),
    sessionMode: session.sessionMode,
    resumeSessionHmac:
      session.sessionMode === 'fresh'
        ? null
        : providerLaunchHmacOfCanonicalJson(deps.authorityRoot, facts.provider, {
            schemaVersion: 1,
            kind: 'provider-session-id',
            sessionId: session.providerSessionId
          }),
    providerSessionGenerationSha256:
      session.sessionMode === 'fresh'
        ? null
        : sha256HexOfCanonicalJson({
            schemaVersion: 1,
            kind: 'provider-seat-generation',
            seatGeneration: session.seatGeneration
          }),
    launchEnvironmentHmac: providerLaunchHmacOfCanonicalJson(
      deps.authorityRoot,
      facts.provider,
      { schemaVersion: 1, kind: 'resolved-launch-environment', env: facts.resolvedEnv }
    ),
    credentialStateHmac: providerLaunchHmacOfCanonicalJson(
      deps.authorityRoot,
      facts.provider,
      { schemaVersion: 1, kind: 'credential-state', state: facts.credentialState }
    ),
    providerConfigurationSha256: sha256HexOfCanonicalJson({
      schemaVersion: 1,
      configuration: facts.providerConfiguration
    }),
    capabilityContractSha256: sha256HexOfCanonicalJson({
      schemaVersion: 1,
      contract: facts.capabilityContract
    })
  }
}

/**
 * The normalized catalog row the adapter's model handling is driven by, plus
 * the resolved context window. An unknown model digests an explicit null row
 * rather than being unrepresentable.
 */
function modelCapabilitySha256(provider: LiveProviderLaunchId, model: string): string {
  const rows = getStaticProviderModels(provider, { includePreviewModels: true }) as ReadonlyArray<
    Record<string, unknown>
  >
  const key = model.trim().toLowerCase()
  const row =
    rows.find((candidate) => {
      if (!candidate || typeof candidate !== 'object') return false
      for (const field of ['type', 'id', 'model', 'value']) {
        const value = candidate[field]
        if (typeof value === 'string' && value.trim().toLowerCase() === key) return true
      }
      return false
    }) ?? null
  let contextWindow: number | null = null
  try {
    const resolved = resolveContextWindow(
      provider as Parameters<typeof resolveContextWindow>[0],
      model
    )
    contextWindow = typeof resolved === 'number' && Number.isFinite(resolved) ? resolved : null
  } catch {
    contextWindow = null
  }
  return sha256HexOfCanonicalJson({
    schemaVersion: 1,
    provider,
    model,
    catalogRow: (row ? JSON.parse(JSON.stringify(row)) : null) as CanonicalEvidenceValue,
    contextWindow
  })
}

export interface ToolSurfaceFacts {
  readonly taskWraithMcpAdvertised: boolean
  readonly taskWraithMcpProfileId: TaskWraithMcpProfileId | null
  /** Exact provider-facing MCP document with route placeholders applied. */
  readonly providerMcpConfiguration: CanonicalEvidenceValue
  /** User-authored MCP configuration advertised to the provider, if any. */
  readonly userMcpConfiguration: CanonicalEvidenceValue
  /** Provider-native tool policy actually applied at launch. */
  readonly nativeToolPolicy: CanonicalEvidenceValue
  /** TaskWraith broker gating policy applied to brokered tool calls. */
  readonly brokerPolicy: CanonicalEvidenceValue
}

export function buildToolSurfaceAuthority(facts: ToolSurfaceFacts): ProviderToolSurfaceAuthority {
  if (facts.taskWraithMcpAdvertised !== (facts.taskWraithMcpProfileId !== null)) {
    throw new SealEvidenceError('TaskWraith MCP profile presence must match advertised state.')
  }
  const advertisedTools = facts.taskWraithMcpProfileId
    ? taskWraithMcpAdvertisedToolNamesForProfile(facts.taskWraithMcpProfileId)
    : []
  return {
    taskWraithMcpAdvertised: facts.taskWraithMcpAdvertised,
    taskWraithMcpProfileId: facts.taskWraithMcpProfileId,
    taskWraithMcpCatalogSha256: sha256HexOfCanonicalJson({
      schemaVersion: 1,
      profileId: facts.taskWraithMcpProfileId,
      tools: [...advertisedTools]
    }),
    providerMcpConfigurationSha256: sha256HexOfCanonicalJson({
      schemaVersion: 1,
      configuration: facts.providerMcpConfiguration
    }),
    userMcpConfigurationSha256: sha256HexOfCanonicalJson({
      schemaVersion: 1,
      configuration: facts.userMcpConfiguration
    }),
    nativeToolPolicySha256: sha256HexOfCanonicalJson({
      schemaVersion: 1,
      policy: facts.nativeToolPolicy
    }),
    brokerPolicySha256: sha256HexOfCanonicalJson({
      schemaVersion: 1,
      policy: facts.brokerPolicy
    })
  }
}

export interface CliRuntimeIdentityFacts {
  /** The exact executable path dispatch resolved for spawn (pre-realpath). */
  readonly binaryPath: string
  /** PATH from the resolved spawn env, for env-shebang interpreter resolution. */
  readonly spawnEnvPath: string | undefined
  /**
   * Full argv with prompt bytes and per-occurrence route values already
   * replaced by the canonical placeholders from SealEvidenceCore.
   */
  readonly argvTemplate: readonly string[]
}

export async function buildCliRuntimeIdentity(
  deps: SealEvidenceDeps,
  facts: CliRuntimeIdentityFacts
): Promise<CliRuntimeIdentityAuthority> {
  const executable = await deps.hasher.digestFile(facts.binaryPath)
  const interpreter = await interpreterRuntimeAttestationSha256(
    executable.realPath,
    facts.spawnEnvPath,
    deps.hasher
  )
  // The bundle a wrapper/launcher reaches: for packaged script CLIs this is
  // the governing package manifest (name/version/integrity pin); for a
  // standalone native binary the executable itself is the whole bundle.
  const manifestPath = await nearestPackageManifestPath(executable.realPath)
  const runtimeBundleSha256 = manifestPath
    ? (await deps.hasher.digestFile(manifestPath)).sha256
    : executable.sha256
  return {
    kind: 'cli',
    executableRealPath: executable.realPath,
    executableSha256: executable.sha256,
    runtimeBundleSha256,
    interpreterRuntimeAttestationSha256: interpreter.sha256,
    executableVersion: await deps.versionProbe.version(executable.realPath, executable.sha256),
    launchArgsTemplateSha256: launchArgsTemplateSha256(facts.argvTemplate)
  }
}

/**
 * Version probing spawns `<binary> --version` once per distinct executable
 * content hash. A null version (probe failed) is recorded honestly rather
 * than fabricated; CliRuntimeIdentityAuthority.executableVersion is nullable.
 */
export class SealEvidenceVersionProbe {
  private readonly cache = new Map<string, string | null>()

  constructor(
    private readonly probe: (binaryPath: string) => Promise<string | null>
  ) {}

  async version(executableRealPath: string, executableSha256: string): Promise<string | null> {
    const key = `${executableRealPath}\0${executableSha256}`
    if (this.cache.has(key)) return this.cache.get(key) ?? null
    let version: string | null = null
    try {
      const raw = await this.probe(executableRealPath)
      version = typeof raw === 'string' && raw.trim() ? raw.trim() : null
    } catch {
      version = null
    }
    this.cache.set(key, version)
    return version
  }
}

/**
 * Mirror of ComposerService's unattended (scheduled) permission resolution.
 * The Stage-2 wiring asserts this mirror's output equals the composed
 * payload's signed pair at mint time, so a composer change that drifts from
 * this derivation fails the occurrence loudly instead of sealing divergent
 * authority. Verification re-runs this mirror against fresh settings.
 */
export interface ScheduledSeatPostureMirrorInput {
  readonly provider: ProviderId
  readonly workspacePath: string
  readonly requestedModel: string
  readonly taskApprovalMode: string | null | undefined
  readonly workflowMode: 'normal' | 'plan'
  readonly settings: AppSettings
  readonly unattendedElevationAck: UnattendedElevationAck | null
}

export interface ScheduledSeatPostureMirror {
  readonly approvalMode: string
  readonly presetId: PermissionPresetId
  readonly effectivePermissions: EffectiveRunPermissions
}

export function deriveScheduledSeatPostureMirror(
  input: ScheduledSeatPostureMirrorInput
): ScheduledSeatPostureMirror {
  const requestedApprovalMode =
    input.workflowMode === 'plan'
      ? 'plan'
      : typeof input.taskApprovalMode === 'string' && input.taskApprovalMode.trim()
        ? input.taskApprovalMode
        : 'default'
  let approvalMode = resolveUnattendedApprovalMode(
    input.unattendedElevationAck ?? undefined,
    requestedApprovalMode
  )
  if (isPreviewRiskModel(input.provider, input.requestedModel)) {
    approvalMode = 'plan'
  }
  const elevatedPresetId =
    approvalMode !== 'plan' && input.unattendedElevationAck
      ? unattendedElevationPresetId(input.unattendedElevationAck.level)
      : undefined
  const presetId: PermissionPresetId =
    approvalMode === 'plan'
      ? input.workflowMode === 'plan'
        ? 'plan'
        : 'read_only'
      : elevatedPresetId ?? 'read_only'
  if (approvalMode !== 'plan' && !elevatedPresetId) {
    throw new SealEvidenceError(
      'An unattended occurrence cannot hold a non-plan approval mode without a verified elevation.'
    )
  }
  const effectivePermissions = resolveEffectiveRunPermissions({
    provider: input.provider,
    workspacePath: input.workspacePath,
    model: input.requestedModel,
    settings: input.settings,
    presetId,
    ...(elevatedPresetId ? { overrides: { networkAccess: 'deny' as const } } : {})
  })
  return { approvalMode, presetId, effectivePermissions }
}

/**
 * Evidence for a provider-native config file that dispatch consults but does
 * not parse. The whole file is treated as potentially secret-bearing, so the
 * digestible evidence carries only a keyed HMAC of the raw bytes — change
 * sensitivity without ever entering secrets into an unkeyed digest.
 */
export async function fileContentHmacEvidence(
  authorityRoot: ScheduledOccurrenceAuthorityRoot,
  provider: ScheduledOccurrenceLaunchProvider,
  path: string
): Promise<CanonicalEvidenceValue> {
  if (!existsSync(path)) return { path, absent: true }
  try {
    const bytes = await readFile(path)
    return {
      path,
      contentHmac: authorityRoot.providerLaunchHmac(provider, bytes)
    }
  } catch {
    return { path, unreadable: true }
  }
}

/** Secret-free credential descriptors, one per provider family. */

export async function codexCredentialStateEvidence(
  codexHome: string
): Promise<CanonicalEvidenceValue> {
  const authJsonPath = join(codexHome, 'auth.json')
  if (!existsSync(authJsonPath)) return { mode: 'none' }
  try {
    const parsed = JSON.parse(await readFile(authJsonPath, 'utf8')) as Record<string, unknown>
    const tokens =
      parsed && typeof parsed.tokens === 'object' && parsed.tokens !== null
        ? (parsed.tokens as Record<string, unknown>)
        : null
    const accountId =
      tokens && typeof tokens.account_id === 'string' && tokens.account_id.trim()
        ? tokens.account_id
        : null
    return {
      mode: 'chatgpt-auth-file',
      path: authJsonPath,
      accountId,
      hasApiKey: typeof parsed.OPENAI_API_KEY === 'string' && parsed.OPENAI_API_KEY.length > 0
    }
  } catch {
    return { mode: 'unreadable-auth-file', path: authJsonPath }
  }
}

export function kimiCredentialStateEvidence(home: string = homedir()): CanonicalEvidenceValue {
  const candidates = [
    join(home, '.kimi-code', 'credentials', 'kimi-code.json'),
    join(home, '.kimi', 'credentials', 'kimi-code.json')
  ]
  for (const candidate of candidates) {
    // Presence-only by design: the Kimi refresh token ROTATES whenever any
    // Kimi CLI runs, so binding file content would fail concurrent-dispatch
    // verification spuriously without adding authority.
    if (existsSync(candidate)) return { mode: 'kimi-code-oauth-file', path: candidate }
  }
  return { mode: 'none' }
}

export function claudeCredentialStateEvidence(
  storedApiKeyConfigured: boolean
): CanonicalEvidenceValue {
  // The Claude CLI owns its login (keychain/CLI state) outside TaskWraith's
  // authority boundary; TaskWraith's own contribution is the stored API key.
  return { mode: 'cli-owned-external', storedApiKeyConfigured }
}

export function grokCredentialStateEvidence(): CanonicalEvidenceValue {
  return { mode: 'cli-owned-external' }
}

export function cursorCredentialStateEvidence(home: string = homedir()): CanonicalEvidenceValue {
  return {
    mode: 'cursor-account-login',
    cursorHomePresent: existsSync(join(home, '.cursor'))
  }
}

export function ollamaCredentialStateEvidence(): CanonicalEvidenceValue {
  return { mode: 'none' }
}
