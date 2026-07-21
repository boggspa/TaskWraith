import EMBEDDED_KIMI_RUNTIME_QUALIFICATIONS from '../kimi/KimiRuntimeQualifications.generated.json'
import { KIMI_ACP_DENY_TOOLS } from '../kimi/KimiAcpContainment'
import {
  buildKimiContainedProcessEnv,
  buildKimiProductionInitializeParams,
  buildKimiProductionSessionPlan
} from '../kimi/KimiProductionContainment'
import { KIMI_ACP_PRODUCTION_POSTURE_VERSION } from '../../shared/kimiAcpPosture'
import { appendKimiModelArgs, kimiAcpThinkingConfigValue } from '../providers/StaticProviderModels'
import type { ProviderLaunchAuthorityInputByProvider } from '../ProviderLaunchAuthorityDigest'
import type { TaskWraithMcpProfileId } from '../store/types'
import {
  SEAL_EVIDENCE_ARGV_ROUTE_PLACEHOLDER,
  SealEvidenceError,
  sha256HexOfCanonicalJson,
  type CanonicalEvidenceValue
} from './SealEvidenceCore'
import {
  buildCliRuntimeIdentity,
  buildCommonLaunchAuthority,
  buildToolSurfaceAuthority,
  kimiCredentialStateEvidence,
  type CommonLaunchFacts,
  type SealEvidenceDeps
} from './SealEvidenceCommon'

/**
 * Scheduled-launch evidence for Kimi Code on the production ACP transport.
 *
 * Mirrors launchKimiProductionAcp: argv is `[...modelArgs, 'acp']` from
 * appendKimiModelArgs; the process env is the exact
 * buildKimiContainedProcessEnv allowlist projection (the per-run private
 * synthetic cwd and seat home do not exist yet at seal time, so they enter
 * the template as route placeholders — the allowlist SHAPE and stable values
 * are produced by the real containment function, not re-implemented); the
 * governed loopback HTTP gateway is mandatory; native fs/shell tools are
 * deny-walled; resume follows buildKimiProductionSessionPlan exactly.
 */
export interface KimiSealEvidenceFacts {
  readonly model: string
  readonly promptEnvelope: CommonLaunchFacts['promptEnvelope']
  /** composed.serviceTier for kimi ('fast' | 'standard'). */
  readonly serviceTier: string | null
  readonly reasoningEffort: string | null
  /** The admitted executable path (admission.binaryPath realpath). */
  readonly binaryPath: string
  /** admitKimiRuntime(...).mode for the exact binary this dispatch will spawn. */
  readonly runtimeAdmissionMode: 'reviewed' | 'unattested-development'
  /** composed.providerSessionId (chat.linkedProviderSessionId). */
  readonly requestedResumeSessionId: string | null
  /** chat.providerMetadata.kimiAcpPostureVersion at dispatch. */
  readonly persistedPostureVersion: string | null
  /**
   * Base spawn environment BEFORE containment: createCliEnv output with the
   * stable TaskWraith stamps. Route-only values (run/chat ids are stable
   * within the occurrence and stay; private home/cwd paths must already be
   * the route placeholder).
   */
  readonly baseSpawnEnv: Readonly<Record<string, string>>
  readonly taskWraithMcpProfileId: TaskWraithMcpProfileId | null
  readonly capabilityContract: CanonicalEvidenceValue
  readonly userMcpConfiguration: CanonicalEvidenceValue
  readonly appVersion: string
}

export async function buildKimiSealEvidence(
  deps: SealEvidenceDeps,
  facts: KimiSealEvidenceFacts
): Promise<ProviderLaunchAuthorityInputByProvider['kimi']> {
  if (facts.taskWraithMcpProfileId === null) {
    throw new SealEvidenceError(
      'Kimi ACP requires the governed TaskWraith MCP gateway profile; none was resolved.'
    )
  }
  const modelArgs: string[] = []
  appendKimiModelArgs(modelArgs, facts.model, facts.serviceTier)
  const argvTemplate = [...modelArgs, 'acp']

  const sessionPlan = buildKimiProductionSessionPlan({
    prompt: facts.promptEnvelope.contextualPrompt,
    resumeFallbackPrompt: facts.promptEnvelope.contextualPrompt,
    requestedResumeSessionId: facts.requestedResumeSessionId,
    persistedPostureVersion: facts.persistedPostureVersion
  })
  const sessionMode = sessionPlan.resumeSessionId ? 'resume' : 'fresh'

  // The exact containment projection, with the not-yet-created private cwd
  // represented by the route placeholder. HOME/USERPROFILE and the XDG/tmp
  // family are all derived from that placeholder by the real function.
  const containedEnv = buildKimiContainedProcessEnv(
    { ...facts.baseSpawnEnv },
    SEAL_EVIDENCE_ARGV_ROUTE_PLACEHOLDER
  )

  const thinkingConfig = kimiAcpThinkingConfigValue(facts.model, facts.reasoningEffort)

  const common = buildCommonLaunchAuthority(deps, {
    provider: 'kimi',
    model: facts.model,
    promptEnvelope: facts.promptEnvelope,
    session: {
      sessionMode,
      providerSessionId: sessionPlan.resumeSessionId,
      // Kimi seat continuity is governed by the posture-matched session plan,
      // not a main-owned generation record; digest that fact explicitly.
      seatGeneration:
        sessionMode === 'fresh'
          ? null
          : {
              kind: 'kimi-acp-posture-matched-resume',
              postureVersion: KIMI_ACP_PRODUCTION_POSTURE_VERSION
            }
    },
    resolvedEnv: containedEnv,
    credentialState: kimiCredentialStateEvidence(),
    providerConfiguration: {
      kind: 'kimi-acp-production',
      thinkingEnabled: true,
      thinkingConfig,
      serviceTier: facts.serviceTier,
      initializeParams: buildKimiProductionInitializeParams(
        facts.appVersion
      ) as CanonicalEvidenceValue,
      legacyResumeRejected: sessionPlan.legacyResumeRejected
    },
    capabilityContract: facts.capabilityContract
  })

  const tools = buildToolSurfaceAuthority({
    taskWraithMcpAdvertised: true,
    taskWraithMcpProfileId: facts.taskWraithMcpProfileId,
    providerMcpConfiguration: {
      attachment: 'authenticated-loopback-http-gateway',
      server: {
        name: 'taskwraith',
        type: 'http',
        url: SEAL_EVIDENCE_ARGV_ROUTE_PLACEHOLDER,
        authHeaderPresent: true
      }
    },
    userMcpConfiguration: facts.userMcpConfiguration,
    nativeToolPolicy: {
      kind: 'kimi-acp-deny-wall',
      deniedNativeTools: [...KIMI_ACP_DENY_TOOLS],
      clientFsCapability: 'none'
    },
    brokerPolicy: {
      kind: 'taskwraith-gateway-broker',
      approvalGate: 'signed-run-posture'
    }
  })

  return {
    schemaVersion: 1,
    provider: 'kimi',
    common,
    runtime: await buildCliRuntimeIdentity(deps, {
      binaryPath: facts.binaryPath,
      spawnEnvPath: containedEnv.PATH,
      argvTemplate
    }),
    tools,
    controls: {
      transport: 'acp',
      acpPostureVersion: 'synthetic-cwd-gateway-v1',
      workspaceCwdExposure: 'private-synthetic',
      clientFsCapability: 'none',
      taskWraithMcpAttachmentMode: 'authenticated-loopback-http-gateway',
      runtimeAdmissionRosterSha256: sha256HexOfCanonicalJson({
        schemaVersion: 1,
        roster: EMBEDDED_KIMI_RUNTIME_QUALIFICATIONS as CanonicalEvidenceValue
      }),
      runtimeAdmissionMode: facts.runtimeAdmissionMode,
      thinking: true,
      fallbackPolicy: 'forbid'
    }
  }
}
