import { claudeSdkThinkingConfigForEffort } from '../providers/ClaudeThinkingConfig'
import { normalizeClaudeEffortFlagForModel } from '../ClaudeCliArgs'
import { claudePermissionModeForApproval } from '../providers/StaticProviderModels'
import { isReconRunPosture } from '../ReconPosture'
import type { ProviderLaunchAuthorityInputByProvider } from '../ProviderLaunchAuthorityDigest'
import type { EffectiveRunPermissions, TaskWraithMcpProfileId } from '../store/types'
import {
  SEAL_EVIDENCE_ARGV_ROUTE_PLACEHOLDER,
  SealEvidenceError,
  canonicalEvidenceEncode,
  sha256HexOfCanonicalJson,
  type CanonicalEvidenceValue
} from './SealEvidenceCore'
import {
  buildCliRuntimeIdentity,
  buildCommonLaunchAuthority,
  buildToolSurfaceAuthority,
  claudeCredentialStateEvidence,
  type CommonLaunchFacts,
  type SealEvidenceDeps,
  type SeatSessionFacts
} from './SealEvidenceCommon'

/**
 * Candidate scheduled-launch evidence for Claude on the Agent SDK transport.
 *
 * Reconstructs the intended Agent SDK invocation: `query({prompt,
 * options})` with tools: [] (built-ins disabled), includePartialMessages:
 * true, permissionMode from the recon rule + claudePermissionModeForApproval,
 * effort/thinking from the shared normalizers, TaskWraith MCP servers from
 * buildClaudeTaskWraithMcpServers, and the environment authority's env. The
 * executable identity binds pathToClaudeCodeExecutable when the dispatch
 * environment authority resolved a CLI binary, else the SDK's own bundled
 * CLI entry — the same fallback the SDK itself uses.
 *
 * This producer is deliberately not production-wired yet. Production chooses
 * SDK availability at dispatch, may rewrite MCP prompt claims if broker
 * startup fails, and may fall back to the CLI-print transport after an SDK
 * failure. Those post-seal choices are not represented by this single-lane
 * evidence object.
 */
export const CLAUDE_SCHEDULED_SEAL_READINESS = {
  provider: 'claude',
  productionWiring: 'blocked',
  blockers: [
    'sdk-or-cli-transport-selected-after-seal',
    'post-seal-mcp-prompt-rewrite',
    'post-seal-cli-print-fallback'
  ]
} as const

export interface ClaudeSealEvidenceFacts {
  readonly model: string
  readonly promptEnvelope: CommonLaunchFacts['promptEnvelope']
  readonly session: SeatSessionFacts
  /** environmentAuthority.env — the exact SDK spawn env. */
  readonly resolvedEnv: Readonly<Record<string, string>>
  /** environmentAuthority.binaryPath (pathToClaudeCodeExecutable), if any. */
  readonly binaryPath: string | null
  /** Absolute path of @anthropic-ai/claude-agent-sdk/package.json. */
  readonly sdkPackageJsonPath: string
  /** SDK-bundled CLI entry used when no external binary resolved. */
  readonly sdkBundledCliPath: string
  readonly approvalMode: string
  readonly workflowMode: 'normal' | 'plan'
  readonly effectivePermissions: EffectiveRunPermissions
  readonly claudeReasoningEffort: string | null
  readonly claudeFastMode: boolean | null
  readonly imageCount: number
  readonly taskWraithMcpAdvertised: boolean
  readonly taskWraithMcpProfileId: TaskWraithMcpProfileId | null
  /**
   * The exact SDK mcpServers map dispatch builds
   * (buildClaudeTaskWraithMcpServers output) — placeholded here before it
   * enters any unkeyed digest.
   */
  readonly mcpServers: Readonly<Record<string, unknown>> | null
  /** Pre-approved TaskWraith tool names passed as allowedTools, if any. */
  readonly allowedTools: readonly string[] | null
  readonly capabilityContract: CanonicalEvidenceValue
  readonly userMcpConfiguration: CanonicalEvidenceValue
  readonly storedApiKeyConfigured: boolean
}

export async function buildClaudeSealEvidence(
  deps: SealEvidenceDeps,
  facts: ClaudeSealEvidenceFacts
): Promise<ProviderLaunchAuthorityInputByProvider['claude']> {
  const permissionMode = isReconRunPosture({
    approvalMode: facts.approvalMode,
    workflowMode: facts.workflowMode,
    effectivePermissions: facts.effectivePermissions
  })
    ? 'default'
    : (claudePermissionModeForApproval(facts.approvalMode) as 'plan' | 'acceptEdits')
  const effort = normalizeClaudeEffortFlagForModel(facts.claudeReasoningEffort, facts.model)
  const thinking = claudeSdkThinkingConfigForEffort(effort)
  const attachmentMode = facts.taskWraithMcpAdvertised ? 'sdk-config' : 'none'
  if (facts.taskWraithMcpAdvertised !== (facts.mcpServers !== null)) {
    throw new SealEvidenceError(
      'Claude TaskWraith MCP advertisement does not match the SDK mcpServers configuration.'
    )
  }
  const executablePath = facts.binaryPath ?? facts.sdkBundledCliPath
  const placeheldMcpServers = facts.mcpServers
    ? placeholdClaudeMcpServers(facts.mcpServers)
    : null

  const invocationTemplate: CanonicalEvidenceValue = {
    schemaVersion: 1,
    transport: 'agent-sdk',
    options: {
      model: facts.model === 'default' ? null : facts.model,
      permissionMode,
      tools: [],
      includePartialMessages: true,
      resume: facts.session.sessionMode === 'fresh' ? null : SEAL_EVIDENCE_ARGV_ROUTE_PLACEHOLDER,
      effort: effort ?? null,
      thinking: (thinking ?? null) as CanonicalEvidenceValue,
      settingsFastMode: typeof facts.claudeFastMode === 'boolean' ? facts.claudeFastMode : null,
      imagesIncluded: facts.imageCount > 0,
      pathToClaudeCodeExecutable: facts.binaryPath !== null,
      mcpServers: placeheldMcpServers,
      allowedTools: facts.allowedTools ? [...facts.allowedTools] : null
    }
  }

  const common = buildCommonLaunchAuthority(deps, {
    provider: 'claude',
    model: facts.model,
    promptEnvelope: facts.promptEnvelope,
    session: facts.session,
    resolvedEnv: facts.resolvedEnv,
    credentialState: claudeCredentialStateEvidence(facts.storedApiKeyConfigured),
    providerConfiguration: {
      kind: 'claude-agent-sdk',
      sdkPackageJsonPath: facts.sdkPackageJsonPath,
      externalCliResolved: facts.binaryPath !== null,
      settingsFastMode: typeof facts.claudeFastMode === 'boolean' ? facts.claudeFastMode : null
    },
    capabilityContract: facts.capabilityContract
  })

  const tools = buildToolSurfaceAuthority({
    taskWraithMcpAdvertised: facts.taskWraithMcpAdvertised,
    taskWraithMcpProfileId: facts.taskWraithMcpProfileId,
    providerMcpConfiguration: {
      attachment: attachmentMode,
      mcpServers: placeheldMcpServers,
      allowedTools: facts.allowedTools ? [...facts.allowedTools] : null
    },
    userMcpConfiguration: facts.userMcpConfiguration,
    nativeToolPolicy: {
      kind: 'claude-builtins-disabled',
      tools: [],
      perCallGate: 'canUseTool-signed-posture'
    },
    brokerPolicy: {
      kind: facts.taskWraithMcpAdvertised ? 'taskwraith-bridge-broker' : 'none',
      approvalGate: 'signed-run-posture'
    }
  })

  return {
    schemaVersion: 1,
    provider: 'claude',
    common,
    runtime: await buildCliRuntimeIdentity(deps, {
      binaryPath: executablePath,
      spawnEnvPath: facts.resolvedEnv.PATH,
      argvTemplate: [
        '@anthropic-ai/claude-agent-sdk',
        'query',
        canonicalEvidenceEncode(invocationTemplate)
      ]
    }),
    tools,
    controls: {
      transport: 'agent-sdk',
      reasoningEffort: effort ?? null,
      thinkingConfigurationSha256: thinking
        ? sha256HexOfCanonicalJson({ schemaVersion: 1, thinking })
        : null,
      fastMode: facts.claudeFastMode === true,
      permissionMode,
      sdkPackageSha256: (await deps.hasher.digestFile(facts.sdkPackageJsonPath)).sha256,
      builtinToolMode: 'disabled',
      includePartialMessages: true,
      taskWraithMcpAttachmentMode: attachmentMode,
      imageTransport: facts.imageCount > 0 ? 'sdk-images' : 'none',
      fallbackPolicy: 'forbid'
    }
  }
}

/**
 * Deep-placehold route and secret values in the SDK mcpServers map: any
 * string value under a key matching token/secret/socket/url-ish route names
 * is replaced. Server names, commands and structural flags stay bound.
 */
function placeholdClaudeMcpServers(
  servers: Readonly<Record<string, unknown>>
): CanonicalEvidenceValue {
  return placeholdNode(servers, false) as CanonicalEvidenceValue
}

const CLAUDE_MCP_ROUTE_KEY = /token|secret|auth|key|password|socket|url|header/i

function placeholdNode(value: unknown, routeContext: boolean): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') {
    return routeContext ? SEAL_EVIDENCE_ARGV_ROUTE_PLACEHOLDER : value
  }
  if (typeof value === 'function') {
    // In-process SDK server factories cannot be serialized; bind presence.
    return '{taskwraith:in-process-server}'
  }
  if (Array.isArray(value)) {
    return value.map((entry) => placeholdNode(entry, routeContext))
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const output: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      output[key] = placeholdNode(
        record[key],
        routeContext || CLAUDE_MCP_ROUTE_KEY.test(key)
      )
    }
    return output
  }
  return String(value)
}
