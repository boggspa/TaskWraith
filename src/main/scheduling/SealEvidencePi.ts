import { isAbsolute, resolve } from 'node:path'
import type {
  CliRuntimeIdentityAuthority,
  ProviderLaunchCommonAuthority
} from '../ProviderLaunchAuthorityDigest'
import type { ScheduledOccurrenceAuthorityRoot } from '../ScheduledOccurrenceAuthorityRootStore'
import { sanitizeTaskWraithMcpPromptClaims } from '../PromptComposition'
import { resolveContextWindow } from '../../shared/contextWindows'
import {
  buildPiProcessEnv,
  buildPiRpcArgs,
  PI_READ_ONLY_TOOLS,
  PI_WRITE_TOOLS
} from '../pi/PiCliArgs'
import { verifyPiIsolatedHome, type PiIsolatedHomeLease } from '../pi/PiIsolatedHome'
import {
  PI_LAUNCH_AUTHORITY_PROVIDER,
  type PiProviderLaunchAuthorityInput
} from '../pi/PiLaunchAuthority'
import {
  resolvePiNativeToolPosture,
  type PiNativeToolEffectivePermissions
} from '../pi/PiNativeToolPosture'
import {
  PI_ALLOWED_UPSTREAMS,
  PI_UPSTREAM_KEY_ENV,
  buildPiCredentialEnv,
  isPiUpstreamAllowed,
  piModelPolicyVerdict
} from '../pi/PiModelPolicy'
import { findPiStaticModel, splitPiWireModelId } from '../pi/PiModels'
import { piPromptCommand } from '../pi/PiRpc'
import { normalizeCliProviderModel } from '../providers/StaticProviderModels'
import {
  SEAL_EVIDENCE_ARGV_PROMPT_PLACEHOLDER,
  SEAL_EVIDENCE_ARGV_ROUTE_PLACEHOLDER,
  SealEvidenceError,
  canonicalEvidenceEncode,
  interpreterRuntimeAttestationSha256,
  launchArgsTemplateSha256,
  nearestPackageManifestPath,
  sha256HexOfCanonicalJson,
  type CanonicalEvidenceValue,
  type SealEvidenceFileHasher
} from './SealEvidenceCore'
import { buildToolSurfaceAuthority, type SealEvidenceVersionProbe } from './SealEvidenceCommon'

export interface PiSealEvidenceDeps {
  readonly hasher: SealEvidenceFileHasher
  readonly versionProbe: SealEvidenceVersionProbe
  readonly appVersion: string
  readonly thinkingLevel?: import('../pi/PiCliArgs').PiThinkingLevel
  /**
   * The root capability retains the provider parameter. Evidence code supplies
   * the literal `pi` internally, so a caller cannot hand in a closure already
   * bound to another provider domain.
   */
  readonly authorityRoot: Pick<ScheduledOccurrenceAuthorityRoot, 'providerLaunchHmac'>
}

export interface PiSealEvidenceFacts {
  /** Requested model before the same normalizer production dispatch uses. */
  readonly model: string
  readonly promptEnvelope: Readonly<{
    readonly contextualPrompt: string
    readonly finalPrompt: string
    readonly runtimePreambleVersion: string | null
  }>
  readonly binaryPath: string
  /**
   * Exact createCliProviderRunEnv output before Pi's credential firewall and
   * PI_* containment switches are applied.
   */
  readonly baseSpawnEnv: Readonly<Record<string, string>>
  /** Raw selected BYOK value. It is HMAC-consumed and never enters evidence. */
  readonly upstreamApiKey: string
  readonly approvalMode: string
  /**
   * Main-verified signed posture. These fields may only remove Pi native tools;
   * they can never make a non-default approval mode write-capable.
   */
  readonly effectivePermissions?: PiNativeToolEffectivePermissions | null
  readonly chatId: string
  readonly sessionDir: string
  /** Main-issued mkdtemp lease that dispatch must consume unchanged. */
  readonly isolatedHome: PiIsolatedHomeLease
  readonly ephemeralSession: boolean
  readonly capabilityContract: CanonicalEvidenceValue
  readonly userMcpConfiguration: CanonicalEvidenceValue
}

export interface PiResolvedSealEvidence {
  readonly authority: PiProviderLaunchAuthorityInput
  /** Secret-bearing exact env to hand to spawn; never persist this object. */
  readonly resolvedEnv: Readonly<Record<string, string>>
  /** Exact production argv. Pi receives prompt bytes over stdin, not argv. */
  readonly args: readonly string[]
  /** Null for `--no-session`; otherwise the deterministic per-chat id. */
  readonly sessionId: string | null
  /** Post-defusal prompt line that production writes to stdin. */
  readonly stdinInitialLine: string
}

/**
 * Build Pi's exact spawn plan and its signable evidence together.
 *
 * This intentionally returns the secret-bearing resolved env beside the
 * digest-only authority. Future service wiring should hand that exact env and
 * argv to dispatch rather than asking dispatch to independently rebuild them;
 * until that single-plan handoff exists, Pi remains an additive evidence
 * producer and ScheduledOccurrenceSealService must continue returning
 * `ok: "skipped"` for Pi.
 */
export async function resolvePiSealEvidence(
  deps: PiSealEvidenceDeps,
  facts: PiSealEvidenceFacts
): Promise<PiResolvedSealEvidence> {
  const model = normalizeCliProviderModel('pi', facts.model)
  const split = splitPiWireModelId(model)
  if (!split) {
    throw new SealEvidenceError(`Pi model id '${model}' is not a recognized wire id.`)
  }
  const verdict = piModelPolicyVerdict(split.upstream, split.modelId)
  if (!verdict.allowed) {
    throw new SealEvidenceError(verdict.reason || 'Pi model refused by policy.')
  }
  if (!isPiUpstreamAllowed(split.upstream)) {
    throw new SealEvidenceError(`Pi upstream '${split.upstream}' is not allowlisted.`)
  }
  const upstreamKey = facts.upstreamApiKey.trim()
  if (!upstreamKey)
    throw new SealEvidenceError('Pi launch evidence requires its selected BYOK key.')
  requireCanonicalAbsolutePath(facts.sessionDir, 'Pi session directory')
  const isolatedHomeAuthority = verifyPiIsolatedHome(facts.isolatedHome)
  const isolatedHomeDir = facts.isolatedHome.path

  const sanitizedContextualPrompt = sanitizeTaskWraithMcpPromptClaims(
    facts.promptEnvelope.contextualPrompt,
    { advertised: false, coreProfile: false }
  )
  const { writeCapable } = resolvePiNativeToolPosture({
    approvalMode: facts.approvalMode,
    effectivePermissions: facts.effectivePermissions
  })
  const sessionId = facts.ephemeralSession ? null : `taskwraith-${facts.chatId || 'chat'}`
  const args = Object.freeze(
    buildPiRpcArgs({
      upstream: split.upstream,
      modelId: split.modelId,
      writeCapable,
      sessionDir: facts.sessionDir,
      ...(facts.ephemeralSession ? { ephemeralSession: true } : { sessionId: sessionId as string })
    })
  )
  const argvTemplate = placeholdPiRouteArgs(args)

  const firewalled = buildPiCredentialEnv(facts.baseSpawnEnv, {
    [split.upstream]: upstreamKey
  })
  const processEnv = buildPiProcessEnv({
    credentialEnv: firewalled,
    isolatedHomeDir
  })
  const mutableResolvedEnv: Record<string, string> = {}
  for (const [name, value] of Object.entries(processEnv)) {
    if (typeof value === 'string') mutableResolvedEnv[name] = value
  }
  const resolvedEnv = Object.freeze(mutableResolvedEnv)
  assertSelectedCredentialOnly(resolvedEnv, split.upstream)

  const session =
    sessionId === null
      ? ({
          sessionMode: 'fresh',
          resumeSessionHmac: null,
          providerSessionGenerationSha256: null
        } as const)
      : ({
          sessionMode: 'resume',
          resumeSessionHmac: hmacEvidence(deps, {
            schemaVersion: 1,
            kind: 'pi-deterministic-session-id',
            sessionId
          }),
          providerSessionGenerationSha256: sha256HexOfCanonicalJson({
            schemaVersion: 1,
            kind: 'pi-deterministic-session-route-generation',
            sessionId: SEAL_EVIDENCE_ARGV_ROUTE_PLACEHOLDER,
            sessionDirectory: SEAL_EVIDENCE_ARGV_ROUTE_PLACEHOLDER
          })
        } as const)

  const common: ProviderLaunchCommonAuthority = {
    adapterRevision: `taskwraith-pi-adapter@${deps.appVersion}`,
    model,
    modelCapabilitySha256: piModelCapabilitySha256(model),
    promptEnvelopeSha256: sha256HexOfCanonicalJson({
      schemaVersion: 1,
      contextualPrompt: sanitizedContextualPrompt,
      finalPrompt: facts.promptEnvelope.finalPrompt,
      runtimePreambleVersion: facts.promptEnvelope.runtimePreambleVersion
    }),
    sessionMode: session.sessionMode,
    resumeSessionHmac: session.resumeSessionHmac,
    providerSessionGenerationSha256: session.providerSessionGenerationSha256,
    launchEnvironmentHmac: hmacEvidence(deps, {
      schemaVersion: 1,
      kind: 'resolved-launch-environment',
      env: resolvedEnv
    }),
    credentialStateHmac: hmacEvidence(deps, {
      schemaVersion: 1,
      kind: 'credential-state',
      state: {
        mode: 'pi-upstream-byok',
        upstream: split.upstream,
        envVar: PI_UPSTREAM_KEY_ENV[split.upstream],
        apiKey: upstreamKey
      }
    }),
    providerConfigurationSha256: sha256HexOfCanonicalJson({
      schemaVersion: 1,
      configuration: {
        kind: 'pi-rpc-contained',
        projectConfigurationDiscovery: 'disabled',
        isolatedHome: {
          mode: 'per-run-mkdtemp-verified-v1',
          authority: isolatedHomeAuthority,
          path: SEAL_EVIDENCE_ARGV_ROUTE_PLACEHOLDER
        },
        session: {
          persistence: facts.ephemeralSession ? 'ephemeral-ensemble' : 'durable-per-chat',
          directory: sessionId === null ? null : SEAL_EVIDENCE_ARGV_ROUTE_PLACEHOLDER,
          id: sessionId === null ? null : SEAL_EVIDENCE_ARGV_ROUTE_PLACEHOLDER
        },
        startup: {
          offlineFlag: true,
          offlineEnv: true,
          skipVersionCheck: true,
          telemetry: false
        }
      }
    }),
    capabilityContractSha256: sha256HexOfCanonicalJson({
      schemaVersion: 1,
      contract: facts.capabilityContract
    })
  }

  const nativeTools = writeCapable ? PI_WRITE_TOOLS : PI_READ_ONLY_TOOLS
  const tools = buildToolSurfaceAuthority({
    taskWraithMcpAdvertised: false,
    taskWraithMcpProfileId: null,
    providerMcpConfiguration: { attachment: 'none', transportSupport: 'absent' },
    userMcpConfiguration: facts.userMcpConfiguration,
    nativeToolPolicy: {
      kind: 'pi-native-tool-allowlist',
      tools: [...nativeTools],
      providerApprovalMode: 'disabled',
      projectConfigurationDiscovery: 'disabled'
    },
    brokerPolicy: { kind: 'none' }
  })

  const stdinInitialLine = piPromptCommand(sanitizedContextualPrompt)
  const authority: PiProviderLaunchAuthorityInput = {
    schemaVersion: 1,
    provider: PI_LAUNCH_AUTHORITY_PROVIDER,
    common,
    runtime: await buildPiCliRuntimeIdentity(deps, {
      binaryPath: facts.binaryPath,
      spawnEnvPath: resolvedEnv.PATH,
      argvTemplate
    }),
    tools,
    controls: {
      transport: 'rpc',
      upstream: split.upstream,
      modelId: split.modelId,
      thinkingMode: facts.thinkingLevel ?? 'provider-default',
      writeCapable,
      nativeToolPolicySha256: tools.nativeToolPolicySha256,
      providerApprovalMode: 'disabled',
      taskWraithMcpAttachmentMode: 'none',
      projectConfigurationDiscovery: 'disabled',
      isolatedHomeMode: 'per-run-mkdtemp-verified-v1',
      isolatedHomeAuthoritySha256: sha256HexOfCanonicalJson({
        schemaVersion: 1,
        authority: isolatedHomeAuthority
      }),
      sessionPersistence: facts.ephemeralSession ? 'ephemeral-ensemble' : 'durable-per-chat',
      sessionDirectoryHmac:
        sessionId === null
          ? null
          : hmacEvidence(deps, {
              schemaVersion: 1,
              kind: 'pi-session-directory',
              path: facts.sessionDir
            }),
      promptTransport: 'stdin-jsonl',
      stdinCommandTemplateSha256: sha256HexOfCanonicalJson({
        schemaVersion: 1,
        line: piPromptCommand(SEAL_EVIDENCE_ARGV_PROMPT_PLACEHOLDER)
      }),
      shutdownPolicySha256: sha256HexOfCanonicalJson({
        schemaVersion: 1,
        terminalEvent: 'agent_settled',
        gracefulShutdown: 'stdin-eof',
        killBackstop: { signal: 'SIGKILL', delayMs: 4_000 }
      }),
      credentialFirewallSha256: credentialFirewallSha256(resolvedEnv, split.upstream),
      offlineStartup: true,
      telemetryEnabled: false,
      fallbackPolicy: 'forbid'
    }
  }

  return {
    authority,
    resolvedEnv,
    args,
    sessionId,
    stdinInitialLine
  }
}

export async function buildPiSealEvidence(
  deps: PiSealEvidenceDeps,
  facts: PiSealEvidenceFacts
): Promise<PiProviderLaunchAuthorityInput> {
  return (await resolvePiSealEvidence(deps, facts)).authority
}

function placeholdPiRouteArgs(args: readonly string[]): string[] {
  const result = [...args]
  for (const flag of ['--session-dir', '--session-id']) {
    const index = result.indexOf(flag)
    if (index !== -1) result[index + 1] = SEAL_EVIDENCE_ARGV_ROUTE_PLACEHOLDER
  }
  return result
}

function hmacEvidence(deps: PiSealEvidenceDeps, value: unknown): string {
  return deps.authorityRoot.providerLaunchHmac(
    'pi',
    Buffer.from(canonicalEvidenceEncode(value), 'utf8')
  )
}

function piModelCapabilitySha256(model: string): string {
  const row = findPiStaticModel(model) ?? null
  let contextWindow: number | null = null
  try {
    const resolvedWindow = resolveContextWindow('pi', model)
    contextWindow =
      typeof resolvedWindow === 'number' && Number.isFinite(resolvedWindow) ? resolvedWindow : null
  } catch {
    contextWindow = null
  }
  return sha256HexOfCanonicalJson({
    schemaVersion: 1,
    provider: 'pi',
    model,
    catalogRow: (row ? JSON.parse(JSON.stringify(row)) : null) as CanonicalEvidenceValue,
    contextWindow
  })
}

function credentialFirewallSha256(
  resolvedEnv: Readonly<Record<string, string>>,
  selectedUpstream: keyof typeof PI_UPSTREAM_KEY_ENV
): string {
  const presentPiCredentialEnvVars = PI_ALLOWED_UPSTREAMS.map(
    (upstream) => PI_UPSTREAM_KEY_ENV[upstream]
  ).filter((name) => typeof resolvedEnv[name] === 'string')
  return sha256HexOfCanonicalJson({
    schemaVersion: 1,
    kind: 'pi-credential-firewall',
    allowedUpstreams: [...PI_ALLOWED_UPSTREAMS],
    upstreamKeyEnv: { ...PI_UPSTREAM_KEY_ENV },
    selectedUpstream,
    presentPiCredentialEnvVars
  })
}

function assertSelectedCredentialOnly(
  resolvedEnv: Readonly<Record<string, string>>,
  selectedUpstream: keyof typeof PI_UPSTREAM_KEY_ENV
): void {
  const selectedName = PI_UPSTREAM_KEY_ENV[selectedUpstream]
  for (const upstream of PI_ALLOWED_UPSTREAMS) {
    const name = PI_UPSTREAM_KEY_ENV[upstream]
    const present = typeof resolvedEnv[name] === 'string' && resolvedEnv[name].length > 0
    if (present !== (name === selectedName)) {
      throw new SealEvidenceError(
        'Pi credential firewall did not produce exactly the selected upstream key.'
      )
    }
  }
}

async function buildPiCliRuntimeIdentity(
  deps: PiSealEvidenceDeps,
  facts: {
    readonly binaryPath: string
    readonly spawnEnvPath: string | undefined
    readonly argvTemplate: readonly string[]
  }
): Promise<CliRuntimeIdentityAuthority> {
  const executable = await deps.hasher.digestFile(facts.binaryPath)
  const interpreter = await interpreterRuntimeAttestationSha256(
    executable.realPath,
    facts.spawnEnvPath,
    deps.hasher
  )
  const manifestPath = await nearestPackageManifestPath(executable.realPath)
  return {
    kind: 'cli',
    executableRealPath: executable.realPath,
    executableSha256: executable.sha256,
    runtimeBundleSha256: manifestPath
      ? (await deps.hasher.digestFile(manifestPath)).sha256
      : executable.sha256,
    interpreterRuntimeAttestationSha256: interpreter.sha256,
    executableVersion: await deps.versionProbe.version(executable.realPath, executable.sha256),
    launchArgsTemplateSha256: launchArgsTemplateSha256(facts.argvTemplate)
  }
}

function requireCanonicalAbsolutePath(value: string, label: string): void {
  if (!isAbsolute(value) || resolve(value) !== value) {
    throw new SealEvidenceError(`${label} path must be canonical and absolute.`)
  }
}
