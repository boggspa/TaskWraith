import {
  GROK_READ_ONLY_DENY_RULES,
  GROK_READ_ONLY_PROMPT_PREAMBLE,
  GROK_WRITE_MODE_DENY_RULES,
  GROK_WRITE_MODE_PROMPT_PREAMBLE,
  buildGrokAcpCliArgs,
  grokWriteCapable
} from '../grok/GrokCliArgs'
import type { ProviderLaunchAuthorityInputByProvider } from '../ProviderLaunchAuthorityDigest'
import type { EffectiveRunPermissions, TaskWraithMcpProfileId } from '../store/types'
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
  grokCredentialStateEvidence,
  type CommonLaunchFacts,
  type SealEvidenceDeps
} from './SealEvidenceCommon'

/**
 * Scheduled-launch evidence for Grok on the joined one-shot ACP transport
 * (`grok … agent stdio`) — the only managed Grok transport.
 *
 * Mirrors runGrokAcpProvider: the seat tier comes from
 * grokWriteCapable(approvalMode); native shell/fs tools are deny-walled by
 * the shared rule set on BOTH tiers (writes flow through the MCP broker);
 * the TaskWraith MCP server attaches to session/new as a stdio bridge
 * subprocess; the ACP argv never enables provider web search and network
 * authority stays host-gated. ACP seats are one-shot: no provider session
 * is ever resumed.
 */
export interface GrokSealEvidenceFacts {
  readonly model: string
  readonly promptEnvelope: CommonLaunchFacts['promptEnvelope']
  readonly reasoningEffort: string | null
  readonly binaryPath: string
  readonly resolvedEnv: Readonly<Record<string, string>>
  readonly approvalMode: string
  readonly effectivePermissions: EffectiveRunPermissions
  /** grokGate.grokAcpEnabled() at dispatch — ACP is the only managed path. */
  readonly acpEnabled: boolean
  readonly taskWraithMcpAdvertised: boolean
  readonly taskWraithMcpProfileId: TaskWraithMcpProfileId | null
  /**
   * The exact session/new MCP server entry dispatch will attach (name,
   * command, args, env pairs), or null when not advertised. Placeholded
   * here before entering unkeyed digests.
   */
  readonly mcpServerEntry: Readonly<{
    name: string
    command: string
    args: readonly string[]
    env: readonly Readonly<{ name: string; value: string }>[]
  }> | null
  readonly capabilityContract: CanonicalEvidenceValue
  readonly userMcpConfiguration: CanonicalEvidenceValue
}

export async function buildGrokSealEvidence(
  deps: SealEvidenceDeps,
  facts: GrokSealEvidenceFacts
): Promise<ProviderLaunchAuthorityInputByProvider['grok']> {
  if (!facts.acpEnabled) {
    throw new SealEvidenceError(
      'Grok ACP transport is disabled; scheduled Grok launches have no managed transport.'
    )
  }
  const writeCapable = grokWriteCapable(facts.approvalMode)
  const readOnlySeat = !writeCapable
  const denyRules = readOnlySeat ? GROK_READ_ONLY_DENY_RULES : GROK_WRITE_MODE_DENY_RULES
  const preamble = writeCapable ? GROK_WRITE_MODE_PROMPT_PREAMBLE : GROK_READ_ONLY_PROMPT_PREAMBLE
  const argvTemplate = buildGrokAcpCliArgs({
    model: facts.model,
    reasoningEffort: facts.reasoningEffort,
    readOnlySeat
  })
  if (facts.taskWraithMcpAdvertised !== (facts.mcpServerEntry !== null)) {
    throw new SealEvidenceError(
      'Grok TaskWraith MCP advertisement does not match the ACP session server entry.'
    )
  }

  const placeheldServer = facts.mcpServerEntry
    ? {
        name: facts.mcpServerEntry.name,
        command: facts.mcpServerEntry.command,
        args: placeholdTokenFlagValues(facts.mcpServerEntry.args),
        env: placeholdRecordValues(
          Object.fromEntries(facts.mcpServerEntry.env.map((entry) => [entry.name, entry.value]))
        )
      }
    : null

  const common = buildCommonLaunchAuthority(deps, {
    provider: 'grok',
    model: facts.model,
    promptEnvelope: facts.promptEnvelope,
    // The joined one-shot ACP transport starts a fresh provider session per
    // occurrence; reusable seats exist only for interactive tool-less reads.
    session: { sessionMode: 'fresh', providerSessionId: null, seatGeneration: null },
    resolvedEnv: facts.resolvedEnv,
    credentialState: grokCredentialStateEvidence(),
    providerConfiguration: {
      kind: 'grok-acp-managed',
      denyRules: [...denyRules],
      autoUpdateDisabled: true,
      builtinToolsDisabled: true
    },
    capabilityContract: facts.capabilityContract
  })

  const tools = buildToolSurfaceAuthority({
    taskWraithMcpAdvertised: facts.taskWraithMcpAdvertised,
    taskWraithMcpProfileId: facts.taskWraithMcpProfileId,
    providerMcpConfiguration: {
      attachment: facts.taskWraithMcpAdvertised ? 'acp-session' : 'none',
      server: placeheldServer
    },
    userMcpConfiguration: facts.userMcpConfiguration,
    nativeToolPolicy: {
      kind: 'grok-native-deny-wall',
      denyRules: [...denyRules],
      toolsFlag: ''
    },
    brokerPolicy: {
      kind: facts.taskWraithMcpAdvertised ? 'taskwraith-bridge-broker' : 'none',
      approvalGate: 'signed-run-posture'
    }
  })

  return {
    schemaVersion: 1,
    provider: 'grok',
    common,
    runtime: await buildCliRuntimeIdentity(deps, {
      binaryPath: facts.binaryPath,
      spawnEnvPath: facts.resolvedEnv.PATH,
      argvTemplate
    }),
    tools,
    controls: {
      transport: 'acp',
      reasoningEffort: facts.reasoningEffort,
      permissionMode: 'host-gated',
      readOnlySeat,
      taskWraithMcpAttachmentMode: facts.taskWraithMcpAdvertised ? 'acp-session' : 'none',
      persistentSeatMode: 'fresh',
      webSearchEnabled: false,
      nativeDenyRulesSha256: sha256HexOfCanonicalJson({
        schemaVersion: 1,
        denyRules: [...denyRules]
      }),
      promptPreambleSha256: sha256HexOfCanonicalJson({
        schemaVersion: 1,
        preamble
      }),
      fallbackPolicy: 'forbid'
    }
  }
}
