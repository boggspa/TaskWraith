import { isAbsolute, resolve } from 'node:path'
import { buildCursorPathBLaunchPlan } from '../cursor/CursorPathBLaunchPlan'
import type { ProviderLaunchAuthorityInputByProvider } from '../ProviderLaunchAuthorityDigest'
import {
  SEAL_EVIDENCE_ARGV_PROMPT_PLACEHOLDER,
  SealEvidenceError,
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
 * Scheduled-launch evidence for the final native-only Path-B Cursor plan.
 *
 * This producer is deliberately unrepresentative of broker-intended launches:
 * runCursorProvider selects broker-active versus visibly degraded native-only
 * only after its dynamic setup attempt. ScheduledOccurrenceSealService skips
 * those occurrences until preparation moves before sealing. For a genuinely
 * native-only composed run, this mirrors the final dispatch exactly:
 * `--sandbox enabled`; write tier = Cursor's contained default; read-only tier
 * = `--mode ask`; no bridge/config write/force flag; no provider resume; and
 * TaskWraith MCP prompt claims removed by the same sanitizer dispatch uses.
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
  /** Must be false. Broker-intended runs are selected too late to seal here. */
  readonly taskWraithMcpAdvertised: boolean
  readonly cursorReasoningEffort: string | null
  readonly cursorFastMode: boolean
  readonly capabilityContract: CanonicalEvidenceValue
}

export async function buildCursorSealEvidence(
  deps: SealEvidenceDeps,
  facts: CursorSealEvidenceFacts
): Promise<ProviderLaunchAuthorityInputByProvider['cursor']> {
  if (facts.writeCapable !== !facts.readOnlySeat) {
    throw new SealEvidenceError(
      'Cursor seat write capability contradicts the signed read-only posture; refusing to seal.'
    )
  }
  if (facts.taskWraithMcpAdvertised) {
    throw new SealEvidenceError(
      'Cursor broker intent cannot be sealed before the broker-active versus native-only launch plan is selected.'
    )
  }
  if (!isAbsolute(facts.workspacePath) || resolve(facts.workspacePath) !== facts.workspacePath) {
    throw new SealEvidenceError(
      'Cursor launch evidence requires a canonical absolute workspace path.'
    )
  }
  const launchPlanInput = {
    workspacePath: facts.workspacePath,
    model: facts.model,
    reasoningEffort: facts.cursorReasoningEffort,
    fastMode: facts.cursorFastMode,
    writeCapable: facts.writeCapable,
    planSeat: facts.readOnlySeat,
    brokerRequested: false,
    brokerOutcome: 'not-requested' as const,
    taskWraithMcpProfileId: null,
    workspaceMcpAliasesGlobalRegistry: false
  }
  const launchPlan = buildCursorPathBLaunchPlan({
    ...launchPlanInput,
    prompt: facts.promptEnvelope.contextualPrompt
  })
  const argvTemplate = buildCursorPathBLaunchPlan({
    ...launchPlanInput,
    prompt: SEAL_EVIDENCE_ARGV_PROMPT_PLACEHOLDER
  }).argv

  const common = buildCommonLaunchAuthority(deps, {
    provider: 'cursor',
    model: launchPlan.evidenceModel,
    promptEnvelope: {
      ...facts.promptEnvelope,
      contextualPrompt: launchPlan.prompt
    },
    // runCursorProvider pins payload.providerSessionId = null before spawn.
    session: { sessionMode: 'fresh', providerSessionId: null, seatGeneration: null },
    resolvedEnv: facts.resolvedEnv,
    credentialState: cursorCredentialStateEvidence(),
    providerConfiguration: {
      kind: 'cursor-path-b-account-owned',
      taskWraithManagedConfigWrites: 'none',
      realCursorHomeInherited: true,
      brokerOutcome: launchPlan.broker.outcome
    },
    capabilityContract: facts.capabilityContract
  })

  const tools = buildToolSurfaceAuthority({
    // Defusal: the contained launch writes no bridge and advertises nothing,
    // regardless of the composer's generic advertisement flag.
    taskWraithMcpAdvertised: false,
    taskWraithMcpProfileId: null,
    providerMcpConfiguration: { attachment: 'none' },
    // Cursor native-only launches do not attach TaskWraith Settings MCP rows.
    userMcpConfiguration: { attachment: 'none' },
    nativeToolPolicy: {
      kind: 'cursor-native-under-os-sandbox',
      sandbox: 'enabled',
      mode: launchPlan.controls.executionMode,
      skipWorktreeSetup: true
    },
    brokerPolicy: {
      kind: 'none',
      requested: launchPlan.broker.requested,
      outcome: launchPlan.broker.outcome
    }
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
      reasoningEffort: launchPlan.reasoningEffort,
      fastMode: launchPlan.fastMode,
      executionMode: launchPlan.controls.executionMode,
      bridgeMode: launchPlan.controls.bridgeMode,
      brokerRegistration: launchPlan.controls.brokerRegistration,
      forceMcpTools: launchPlan.controls.forceMcpTools,
      approveMcpServers: launchPlan.controls.approveMcpServers,
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
