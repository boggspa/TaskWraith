import { join } from 'node:path'
import { buildCodexTaskWraithMcpArgs, type CodexMcpTaskWraithConfig } from '../CodexAppServerClient'
import type { CodexAppServerProcessLaunchPlan } from '../codex/CodexAppServerProcessLaunchPlan'
import {
  ensureTaskWraithCodexHomeForProtectedRead,
  requireAbsoluteCodexHome
} from '../codex/CodexHome'
import { buildCodexAppServerThreadLaunchPlan } from '../codex/CodexAppServerThreadLaunchPlan'
import { codexSandboxForMode } from '../codex/CodexRunPolicy'
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
 * Candidate scheduled-launch evidence for Codex on the app-server transport.
 *
 * The app-server daemon process plan is shared directly with
 * CodexAppServerClient.start. The per-run thread/start-or-resume request is
 * built by the same immutable request-plan helper intended for the dispatch
 * site. Index-owned approval/sandbox closures remain injected so a host policy
 * change is automatically an evidence change here.
 *
 * This producer is deliberately not production-wired yet. The live adapter
 * can rewrite private-home continuity and MCP prompt claims after the
 * occurrence seal is minted, then choose the one-shot exec transport if the
 * app-server path fails. A signable scheduled lane must select and retain one
 * final transport and prompt before this evidence is treated as parity proof.
 */
export const CODEX_SCHEDULED_SEAL_READINESS = {
  provider: 'codex',
  productionWiring: 'blocked',
  blockers: [
    'post-seal-exec-fallback',
    'post-seal-private-home-continuity-rewrite',
    'post-seal-mcp-prompt-rewrite',
    'reusable-daemon-launch-generation-not-bound',
    'runtime-profile-posture-applied-after-seal',
    'full-access-native-sandbox-verifier-mismatch'
  ]
} as const

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
  /** Exact immutable daemon process plan also consumed by production spawn. */
  readonly processLaunchPlan: CodexAppServerProcessLaunchPlan
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
  const codexHome = requireAbsoluteCodexHome(facts.processLaunchPlan.env.CODEX_HOME)
  await ensureTaskWraithCodexHomeForProtectedRead(codexHome, ['auth.json', 'config.toml'])
  const fullAccessGranted = isFullShellAccessGranted(facts.effectivePermissions)
  const approvalPolicy = facts.policy.approvalPolicyForMode(facts.approvalMode, facts.settings)
  const sandboxMode = codexSandboxForMode(facts.approvalMode, fullAccessGranted)
  const sandboxPolicy = facts.policy.sandboxPolicyForMode(
    facts.approvalMode,
    facts.workspacePath,
    facts.settings,
    fullAccessGranted
  )
  const threadLaunchPlan = buildCodexAppServerThreadLaunchPlan({
    model: facts.model,
    reasoningEffort: facts.reasoningEffort,
    serviceTier: facts.serviceTier,
    workspacePath: facts.workspacePath,
    approvalPolicy,
    sandbox: sandboxMode,
    resumableThreadId:
      facts.session.sessionMode === 'fresh' ? null : facts.session.providerSessionId
  })
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
  const expectedProcessArgs = [
    ...(facts.codexMcpConfig ? buildCodexTaskWraithMcpArgs(facts.codexMcpConfig) : []),
    'app-server'
  ]
  if (
    facts.processLaunchPlan.transport !== 'app-server' ||
    facts.processLaunchPlan.startupCompatibility !== 'configured' ||
    !sameStringArray(facts.processLaunchPlan.args, expectedProcessArgs)
  ) {
    throw new SealEvidenceError(
      'Codex seal evidence does not match the immutable app-server process launch plan.'
    )
  }

  const common = buildCommonLaunchAuthority(deps, {
    provider: 'codex',
    model: threadLaunchPlan.model,
    promptEnvelope: facts.promptEnvelope,
    session: facts.session,
    resolvedEnv: facts.processLaunchPlan.env,
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
      binaryPath: facts.processLaunchPlan.command,
      spawnEnvPath: facts.processLaunchPlan.env.PATH,
      argvTemplate
    }),
    tools,
    controls: {
      transport: 'app-server',
      reasoningEffort: threadLaunchPlan.reasoningEffort,
      reasoningConfigurationSha256: sha256HexOfCanonicalJson({
        schemaVersion: 1,
        effort: threadLaunchPlan.reasoningEffort,
        threadConfig: threadLaunchPlan.threadConfig as CanonicalEvidenceValue,
        summary: threadLaunchPlan.reasoningSummary
      }),
      serviceTier: threadLaunchPlan.serviceTier,
      approvalPolicy,
      sandboxMode,
      sandboxPolicySha256: sha256HexOfCanonicalJson({
        schemaVersion: 1,
        policy: sandboxPolicy
      }),
      appServerConfigurationSha256: sha256HexOfCanonicalJson({
        schemaVersion: 1,
        method: threadLaunchPlan.request.method,
        params: threadLaunchPlan.request.params as CanonicalEvidenceValue
      }),
      taskWraithMcpAttachmentMode: attachmentMode,
      persistExtendedHistory: true,
      experimentalRawEvents: false,
      fallbackPolicy: threadLaunchPlan.fallbackPolicy
    }
  }
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
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
