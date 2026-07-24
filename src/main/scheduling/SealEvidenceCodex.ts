import { join } from 'node:path'
import { buildCodexTaskWraithMcpArgs, type CodexMcpTaskWraithConfig } from '../CodexAppServerClient'
import {
  ensureTaskWraithCodexHomeForProtectedRead,
  requireAbsoluteCodexHome
} from '../codex/CodexHome'
import { codexSandboxForMode } from '../codex/CodexRunPolicy'
import { resolveCodexOutboundReasoning } from '../codex/CodexOutboundReasoning'
import { normalizeCodexModel } from '../providers/StaticProviderModels'
import { isFullShellAccessGranted } from '../EffectiveRunPermissions'
import type { ProviderLaunchAuthorityInputByProvider } from '../ProviderLaunchAuthorityDigest'
import type {
  AppSettings,
  EffectiveRunPermissions,
  TaskWraithMcpProfileId
} from '../store/types'
import {
  SealEvidenceError,
  placeholdRecordValues,
  placeholdTokenFlagValues,
  sha256HexOfCanonicalJson,
  type CanonicalEvidenceValue
} from './SealEvidenceCore'
import {
  buildCliRuntimeIdentity,
  buildCommonLaunchAuthority,
  buildToolSurfaceAuthority,
  codexCredentialStateEvidence,
  fileContentHmacEvidence,
  type CommonLaunchFacts,
  type SealEvidenceDeps,
  type SeatSessionFacts
} from './SealEvidenceCommon'

/**
 * Scheduled-launch evidence for Codex on the app-server transport.
 *
 * The app-server daemon is spawned with `[...taskwraithMcpConfigArgs,
 * 'app-server']` (CodexAppServerClient.start) and a run becomes a
 * thread/start request whose parameters are assembled at the dispatch site:
 * `{cwd, model, config: reasoning.threadConfig, serviceTier?, approvalPolicy,
 * sandbox, experimentalRawEvents: false, persistExtendedHistory: true}`.
 * This producer rebuilds that exact record from the same policy modules and
 * from index.ts's own policy closures, injected so a policy change there is
 * automatically a seal-evidence change here.
 */
export interface CodexSealEvidenceDispatchPolicy {
  /** index.ts codexApprovalPolicyForMode — the exact dispatch closure. */
  approvalPolicyForMode(
    approvalMode: string | undefined,
    settings: AppSettings
  ): 'never' | 'on-request'
  /** index.ts codexSandboxPolicyForMode — the exact dispatch closure. */
  sandboxPolicyForMode(
    approvalMode: string | undefined,
    workspace: string,
    settings: AppSettings,
    fullAccessGranted: boolean
  ): CanonicalEvidenceValue
}

export interface CodexSealEvidenceFacts {
  readonly model: string
  readonly promptEnvelope: CommonLaunchFacts['promptEnvelope']
  readonly session: SeatSessionFacts
  readonly resolvedEnv: Readonly<Record<string, string>>
  readonly binaryPath: string
  readonly workspacePath: string
  readonly approvalMode: string
  readonly effectivePermissions: EffectiveRunPermissions
  readonly reasoningEffort: string | null
  readonly serviceTier: string | null
  /** runtimeSettings(AppStore.getSettings(), runtimeProfile) at dispatch. */
  readonly settings: AppSettings
  /** The exact MCP config the app-server accessor computed, or null. */
  readonly codexMcpConfig: CodexMcpTaskWraithConfig | null
  readonly taskWraithMcpAdvertised: boolean
  readonly taskWraithMcpProfileId: TaskWraithMcpProfileId | null
  readonly capabilityContract: CanonicalEvidenceValue
  readonly userMcpConfiguration: CanonicalEvidenceValue
  readonly policy: CodexSealEvidenceDispatchPolicy
}

export async function buildCodexSealEvidence(
  deps: SealEvidenceDeps,
  facts: CodexSealEvidenceFacts
): Promise<ProviderLaunchAuthorityInputByProvider['codex']> {
  const codexHome = requireAbsoluteCodexHome(facts.resolvedEnv.CODEX_HOME)
  await ensureTaskWraithCodexHomeForProtectedRead(codexHome, ['auth.json', 'config.toml'])
  const model = normalizeCodexModel(facts.model)
  const reasoning = resolveCodexOutboundReasoning(model, facts.reasoningEffort)
  const fullAccessGranted = isFullShellAccessGranted(facts.effectivePermissions)
  const approvalPolicy = facts.policy.approvalPolicyForMode(facts.approvalMode, facts.settings)
  const sandboxMode = codexSandboxForMode(facts.approvalMode, fullAccessGranted)
  const sandboxPolicy = facts.policy.sandboxPolicyForMode(
    facts.approvalMode,
    facts.workspacePath,
    facts.settings,
    fullAccessGranted
  )
  const attachmentMode = facts.taskWraithMcpAdvertised ? 'app-server-config' : 'none'
  if (facts.taskWraithMcpAdvertised !== Boolean(facts.codexMcpConfig?.enabled)) {
    throw new SealEvidenceError(
      'Codex TaskWraith MCP advertisement does not match the app-server MCP configuration.'
    )
  }

  const mcpConfigTemplate = placeheldCodexMcpConfig(facts.codexMcpConfig)
  const argvTemplate = [
    ...(mcpConfigTemplate ? buildCodexTaskWraithMcpArgs(mcpConfigTemplate) : []),
    'app-server'
  ]

  const common = buildCommonLaunchAuthority(deps, {
    provider: 'codex',
    model,
    promptEnvelope: facts.promptEnvelope,
    session: facts.session,
    resolvedEnv: facts.resolvedEnv,
    credentialState: await codexCredentialStateEvidence(codexHome),
    providerConfiguration: {
      kind: 'codex-home-config',
      configToml: await fileContentHmacEvidence(
        deps.authorityRoot,
        'codex',
        join(codexHome, 'config.toml')
      ),
      persistExtendedHistory: true,
      experimentalRawEvents: false
    },
    capabilityContract: facts.capabilityContract
  })

  const tools = buildToolSurfaceAuthority({
    taskWraithMcpAdvertised: facts.taskWraithMcpAdvertised,
    taskWraithMcpProfileId: facts.taskWraithMcpProfileId,
    providerMcpConfiguration: {
      attachment: attachmentMode,
      // The provider-facing MCP document is the config-override arg list the
      // app-server is spawned with, with per-occurrence route values already
      // replaced by structural placeholders.
      configArgs: mcpConfigTemplate ? buildCodexTaskWraithMcpArgs(mcpConfigTemplate) : []
    },
    userMcpConfiguration: facts.userMcpConfiguration,
    nativeToolPolicy: {
      kind: 'codex-native-sandboxed',
      approvalPolicy,
      sandboxMode,
      sandboxPolicy
    },
    brokerPolicy: {
      kind: facts.taskWraithMcpAdvertised ? 'taskwraith-bridge-broker' : 'none',
      approvalGate: 'signed-run-posture'
    }
  })

  return {
    schemaVersion: 1,
    provider: 'codex',
    common,
    runtime: await buildCliRuntimeIdentity(deps, {
      binaryPath: facts.binaryPath,
      spawnEnvPath: facts.resolvedEnv.PATH,
      argvTemplate
    }),
    tools,
    controls: {
      transport: 'app-server',
      reasoningEffort: reasoning.effort ?? null,
      reasoningConfigurationSha256: sha256HexOfCanonicalJson({
        schemaVersion: 1,
        effort: reasoning.effort ?? null,
        threadConfig: (reasoning.threadConfig ?? null) as CanonicalEvidenceValue,
        summary: reasoningSummaryEvidence(reasoning)
      }),
      serviceTier: facts.serviceTier,
      approvalPolicy,
      sandboxMode,
      sandboxPolicySha256: sha256HexOfCanonicalJson({
        schemaVersion: 1,
        policy: sandboxPolicy
      }),
      appServerConfigurationSha256: sha256HexOfCanonicalJson({
        schemaVersion: 1,
        // Mirrors the thread/start `startOrResumeParams` record at the
        // dispatch site, field for field.
        cwd: facts.workspacePath,
        model,
        config: (reasoning.threadConfig ?? null) as CanonicalEvidenceValue,
        serviceTier: facts.serviceTier,
        approvalPolicy,
        sandbox: sandboxMode,
        experimentalRawEvents: false,
        persistExtendedHistory: true
      }),
      taskWraithMcpAttachmentMode: attachmentMode,
      persistExtendedHistory: true,
      experimentalRawEvents: false,
      fallbackPolicy: 'forbid'
    }
  }
}

function reasoningSummaryEvidence(
  reasoning: ReturnType<typeof resolveCodexOutboundReasoning>
): CanonicalEvidenceValue {
  const record = reasoning as unknown as Record<string, unknown>
  const summary = record.summary
  return typeof summary === 'string' ? summary : null
}

/**
 * Replace secret and per-occurrence route values with the canonical route
 * placeholder before the config is rendered into the UNKEYED argv-template
 * digest: token-like flag values in the bridge args, and every user MCP
 * server env/header VALUE (buildUserMcpLaunchServers resolves real secret
 * refs into those values). Structural flags, names and stable per-install
 * paths stay intact so the template still pins the launch shape.
 */
function placeheldCodexMcpConfig(
  config: CodexMcpTaskWraithConfig | null
): CodexMcpTaskWraithConfig | null {
  if (!config) return null
  return {
    enabled: config.enabled,
    bridgeBinaryPath: config.bridgeBinaryPath,
    bridgeArgs: placeholdTokenFlagValues(config.bridgeArgs),
    parentProvider: config.parentProvider,
    userMcpServers: (config.userMcpServers ?? []).map((server) => ({
      ...server,
      ...('args' in server && Array.isArray(server.args)
        ? { args: placeholdTokenFlagValues(server.args) }
        : {}),
      ...('env' in server && server.env
        ? { env: placeholdRecordValues(server.env) }
        : {}),
      ...('headers' in server && server.headers
        ? { headers: placeholdRecordValues(server.headers) }
        : {})
    }))
  }
}
