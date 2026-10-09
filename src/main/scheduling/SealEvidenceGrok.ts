import {
  GROK_ACP_READ_ONLY_DENY_RULES,
  GROK_ACP_WRITE_MODE_DENY_RULES,
  GROK_ACP_WRITE_MODE_NATIVE_TOOLS,
  GROK_READ_ONLY_PROMPT_PREAMBLE,
  GROK_WRITE_MODE_PROMPT_PREAMBLE,
  buildGrokAcpCliArgs,
  grokWriteCapable
} from '../grok/GrokCliArgs'
import { nativeShellPermitted } from '../native-tools/NativeShellApprovalGate'
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
 * Candidate scheduled-launch evidence for Grok on the joined one-shot ACP
 * transport
 * (`grok … agent stdio`) — the only managed Grok transport.
 *
 * Mirrors runGrokAcpProvider: the seat tier comes from
 * grokWriteCapable(approvalMode). A READ-ONLY tier is deny-walled and ships an
 * empty `--tools`, so every action flows through the MCP broker. A
 * WRITE-CAPABLE tier denies nothing at argv and is offered the native reads
 * plus shell that the closed `grok` adapter declares; native writes still flow
 * through the broker, and native shell is admitted only when
 * nativeShellPermitted() says this seat's signed posture allows it, which is
 * sealed below so a scheduled occurrence cannot execute under a different
 * answer than it was minted with;
 * the TaskWraith MCP server attaches to session/new as a stdio bridge
 * subprocess; the ACP argv never enables provider web search and network
 * authority stays host-gated. ACP seats are one-shot: no provider session
 * is ever resumed.
 *
 * This producer is deliberately not production-wired yet. Production builds
 * the final provider-visible goal/tool steering prompt after MCP startup and
 * can rewrite that prompt plus the tool surface when the broker degrades.
 * The sealed prompt and MCP document must be finalized at the same boundary
 * before this becomes parity evidence.
 */
export const GROK_SCHEDULED_SEAL_READINESS = {
  provider: 'grok',
  productionWiring: 'blocked',
  blockers: [
    'provider-visible-steered-prompt-not-bound',
    'post-seal-mcp-prompt-rewrite',
    'runtime-profile-environment-not-shared'
  ]
} as const

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
  const fullAccess =
    facts.effectivePermissions.presetId === 'full_access' &&
    !facts.effectivePermissions.readOnly &&
    facts.effectivePermissions.agenticServices.shellCommands === 'allow'
  // ACP seat, so the ACP rule sets -- not the non-ACP provider ones, which deny
  // reads and were never what `grok ... agent stdio` ships.
  const denyRules: readonly string[] = readOnlySeat
    ? GROK_ACP_READ_ONLY_DENY_RULES
    : GROK_ACP_WRITE_MODE_DENY_RULES
  const toolsFlag = fullAccess
    ? 'provider-default'
    : readOnlySeat
      ? ''
      : GROK_ACP_WRITE_MODE_NATIVE_TOOLS.join(',')
  // Resolved from THE producer, never re-derived here, so a sealed occurrence
  // and the runtime gate cannot answer this differently.
  const grokNativeShellPermitted = nativeShellPermitted({
    readOnlySeat,
    shellPolicy: facts.effectivePermissions.agenticServices.shellCommands
  })
  const preamble = writeCapable ? GROK_WRITE_MODE_PROMPT_PREAMBLE : GROK_READ_ONLY_PROMPT_PREAMBLE
  const argvTemplate = buildGrokAcpCliArgs({
    model: facts.model,
    reasoningEffort: facts.reasoningEffort,
    readOnlySeat
  })
  if (fullAccess) {
    argvTemplate.splice(argvTemplate.indexOf('--tools'), 2)
    argvTemplate.unshift('--permission-mode', 'bypassPermissions')
  }
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
      builtinToolsDisabled: readOnlySeat
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
      toolsFlag,
      nativeShellPermitted: grokNativeShellPermitted
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
      permissionMode: fullAccess ? 'bypassPermissions' : 'host-gated',
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
