import {
  buildContainedCursorReadOnlyArgv,
  buildContainedCursorWriteArgv
} from '../cursor/CursorCliArgs'
import type { ProviderLaunchAuthorityInputByProvider } from '../ProviderLaunchAuthorityDigest'
import {
  SEAL_EVIDENCE_ARGV_PROMPT_PLACEHOLDER,
  sha256HexOfCanonicalJson,
  type CanonicalEvidenceValue
} from './SealEvidenceCore'
import {
  buildCliRuntimeIdentity,
  buildCommonLaunchAuthority,
  buildToolSurfaceAuthority,
  cursorCredentialStateEvidence,
  type CommonLaunchFacts,
  type SealEvidenceDeps
} from './SealEvidenceCommon'

/**
 * Scheduled-launch evidence for managed Path-B Cursor.
 *
 * Mirrors runCursorProvider exactly: containment is the hard-pinned
 * `--sandbox enabled` argv (write tier = Cursor's contained default; read-only
 * tier adds a non-mutating `--mode ask`), no TaskWraith MCP bridge is written,
 * no broker registration exists, and no provider session is ever resumed
 * (dispatch forces providerSessionId = null). Path B runs against the user's
 * real ~/.cursor account state, which TaskWraith does not manage — the
 * provider-configuration evidence records that fact explicitly instead of
 * hashing account-owned mutable state.
 */
export interface CursorSealEvidenceFacts {
  readonly model: string
  readonly promptEnvelope: CommonLaunchFacts['promptEnvelope']
  readonly resolvedEnv: Readonly<Record<string, string>>
  readonly binaryPath: string
  readonly workspacePath: string
  /** The dispatch write-capability verdict for this seat (cursorWriteCapable). */
  readonly writeCapable: boolean
  /** permissions.readOnly from the seat's signed posture. */
  readonly readOnlySeat: boolean
  readonly cursorReasoningEffort: string | null
  readonly cursorFastMode: boolean
  readonly capabilityContract: CanonicalEvidenceValue
  readonly userMcpConfiguration: CanonicalEvidenceValue
}

export async function buildCursorSealEvidence(
  deps: SealEvidenceDeps,
  facts: CursorSealEvidenceFacts
): Promise<ProviderLaunchAuthorityInputByProvider['cursor']> {
  if (facts.writeCapable !== !facts.readOnlySeat) {
    throw new Error(
      'Cursor seat write capability contradicts the signed read-only posture; refusing to seal.'
    )
  }
  const argvTemplate = facts.writeCapable
    ? buildContainedCursorWriteArgv({
        workspace: facts.workspacePath,
        prompt: SEAL_EVIDENCE_ARGV_PROMPT_PLACEHOLDER,
        model: facts.model
      })
    : buildContainedCursorReadOnlyArgv({
        workspace: facts.workspacePath,
        prompt: SEAL_EVIDENCE_ARGV_PROMPT_PLACEHOLDER,
        model: facts.model,
        mode: 'ask'
      })

  const common = buildCommonLaunchAuthority(deps, {
    provider: 'cursor',
    model: facts.model,
    promptEnvelope: facts.promptEnvelope,
    // runCursorProvider pins payload.providerSessionId = null before spawn.
    session: { sessionMode: 'fresh', providerSessionId: null, seatGeneration: null },
    resolvedEnv: facts.resolvedEnv,
    credentialState: cursorCredentialStateEvidence(),
    providerConfiguration: {
      kind: 'cursor-path-b-account-owned',
      taskWraithManagedConfigWrites: 'none',
      realCursorHomeInherited: true
    },
    capabilityContract: facts.capabilityContract
  })

  const tools = buildToolSurfaceAuthority({
    // Defusal: the contained launch writes no bridge and advertises nothing,
    // regardless of the composer's generic advertisement flag.
    taskWraithMcpAdvertised: false,
    taskWraithMcpProfileId: null,
    providerMcpConfiguration: { attachment: 'none' },
    userMcpConfiguration: facts.userMcpConfiguration,
    nativeToolPolicy: {
      kind: 'cursor-native-under-os-sandbox',
      sandbox: 'enabled',
      mode: facts.writeCapable ? 'contained-default' : 'ask'
    },
    brokerPolicy: { kind: 'none' }
  })

  return {
    schemaVersion: 1,
    provider: 'cursor',
    common,
    runtime: await buildCliRuntimeIdentity(deps, {
      binaryPath: facts.binaryPath,
      spawnEnvPath: facts.resolvedEnv.PATH,
      argvTemplate
    }),
    tools,
    controls: {
      transport: 'cursor-agent-stream-json',
      reasoningEffort: facts.cursorReasoningEffort,
      fastMode: facts.cursorFastMode,
      executionMode: facts.readOnlySeat ? 'plan' : 'contained-default',
      bridgeMode: 'none',
      brokerRegistration: 'none',
      forceMcpTools: false,
      approveMcpServers: false,
      nativeContainmentConfigurationSha256: nativeContainmentConfigurationSha256(argvTemplate),
      fallbackPolicy: 'forbid'
    }
  }
}

function nativeContainmentConfigurationSha256(argvTemplate: readonly string[]): string {
  // The containment configuration IS the contained argv shape: --sandbox
  // enabled pinned, seat-tier --mode, no force/yolo/resume flags. Digest the
  // full template so any argv drift re-derives a different launch authority.
  return sha256HexOfCanonicalJson({
    schemaVersion: 1,
    kind: 'cursor-contained-argv',
    argv: [...argvTemplate]
  })
}
