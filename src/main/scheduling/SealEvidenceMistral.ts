import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import {
  MISTRAL_BINARY_NAME,
  MISTRAL_CREDENTIAL_ENV_VARS,
  MISTRAL_NATIVE_TOOL_POLICY,
  MISTRAL_READ_ONLY_PROMPT_PREAMBLE,
  MISTRAL_WRITE_MODE_PROMPT_PREAMBLE,
  buildMistralAcpCliArgs,
  mistralCredentialEnvScrubbed,
  mistralSessionModeForSeat,
  mistralSessionModeIsGated,
  mistralWriteCapable,
  normalizeMistralModel,
  normalizeMistralThinkingLevel
} from '../mistral/MistralCliArgs'
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
  type CommonLaunchFacts,
  type SealEvidenceDeps
} from './SealEvidenceCommon'

/**
 * Candidate scheduled-launch evidence for the Mistral Vibe ACP seat
 * (`vibe-acp` over stdio) — the only managed Mistral transport.
 *
 * ── WHY THIS PRODUCER LOOKS UNLIKE ITS ACP SIBLING ────────────────────────
 * Grok is the closest structural relative (joined one-shot ACP, direct stdio
 * MCP attachment, host-gated permissions), but three facts diverge and this
 * file exists to bind them rather than smooth them over:
 *
 *  1. THERE IS NO ARGV. `vibe-acp`'s entire command line is `[-h] [-v]
 *     [--setup]` — no model flag, no mode flag, no tool or deny flag, no
 *     sandbox flag. `buildMistralAcpCliArgs()` returns an EMPTY array and this
 *     producer binds that empty template deliberately. An argv digest over
 *     nothing is not a gap in the evidence; it is the accurate statement that
 *     this seat's containment does not live at the argv boundary at all.
 *
 *  2. CONTAINMENT IS THE ACP SESSION MODE. Where Grok digests a deny-rule list
 *     into `nativeDenyRulesSha256`, this seat digests MISTRAL_NATIVE_TOOL_POLICY
 *     plus the mode actually selected. The field keeps its cross-provider name
 *     for schema symmetry; its CONTENT is the session-mode policy. `plan` is
 *     the read-only tier, `default` is the write tier, and both raise
 *     `session/request_permission` for every tool call so the host gate stays
 *     the enforcement floor.
 *
 *  3. THE CREDENTIAL LANE IS THE SECURITY FACT. Vibe resolves auth
 *     API-KEY-FIRST: an inherited `MISTRAL_API_KEY` (which is also Pi's
 *     upstream key env — PiModelPolicy.PI_UPSTREAM_KEY_ENV.mistral) silently
 *     moves the run onto the user's metered BYOK billing line and the plan
 *     subscription is never consulted. No error, no warning, just a different
 *     bill. `apiKeyEnvScrubbed` is therefore derived from the ACTUAL resolved
 *     env rather than asserted, and an unscrubbed env refuses to seal.
 *
 * This producer is deliberately not production-wired: there is no Mistral
 * dispatch function yet, so no launch consumes this authority. See
 * MISTRAL_SCHEDULED_SEAL_READINESS for the honest blocker list.
 */
export const MISTRAL_SCHEDULED_SEAL_READINESS = {
  provider: 'mistral',
  productionWiring: 'blocked',
  blockers: [
    // NOTE: two earlier blockers are now resolved and deliberately removed
    // rather than left to rot — a stale blocker list is worse than none,
    // because it makes a producer look less ready than it is and invites the
    // next reader to re-solve a solved problem. `runMistralProvider` /
    // `runMistralAcpProvider` now exist in index.ts, and
    // `providerBinaryName('mistral')` now resolves to `vibe-acp`.
    //
    // The session mode is selected AFTER session/new via
    // session/set_config_option. The seal binds the INTENDED mode; nothing yet
    // observes the agent's acknowledgement, so a rejected set_config_option
    // would silently leave the session on Vibe's own default — which for a
    // read-only seat means running write-capable. This is the most
    // consequential remaining gap.
    'session-mode-selection-not-observed-post-handshake',
    // The steered prompt preamble is digested here, but the dispatch path does
    // not yet fix the boundary at which the provider-visible prompt is final.
    'provider-visible-steered-prompt-not-bound'
  ]
} as const

/**
 * Secret-free credential descriptor for the Vibe plan-backed sign-in.
 *
 * PRESENCE-ONLY, for the same reason kimiCredentialStateEvidence is: the file
 * holds a rotating OAuth credential (0600, rewritten whenever Vibe refreshes),
 * so binding its content would fail concurrent-dispatch verification spuriously
 * while adding no authority the presence bit does not already carry. The bytes
 * are never read here — not hashed, not HMAC'd, not opened.
 *
 * `home` is a parameter (not a direct homedir() call) so this is testable, and
 * `vibeHomeOverride` carries the child's own `VIBE_HOME` when the resolved
 * launch env sets one: the credential that matters is the one the CHILD will
 * read, not the one this process happens to sit next to.
 */
export function mistralCredentialStateEvidence(
  home: string = homedir(),
  vibeHomeOverride: string | null = null
): CanonicalEvidenceValue {
  const vibeHome =
    typeof vibeHomeOverride === 'string' && vibeHomeOverride.trim()
      ? vibeHomeOverride.trim()
      : join(home, '.vibe')
  return {
    mode: 'vibe-plan-oauth',
    vibeHome,
    vibeHomePresent: existsSync(vibeHome),
    configPresent: existsSync(join(vibeHome, 'config.toml'))
  }
}

export interface MistralSealEvidenceFacts {
  readonly model: string
  readonly promptEnvelope: CommonLaunchFacts['promptEnvelope']
  /**
   * TaskWraith's reasoning-effort vocabulary, clamped onto Vibe's thinking
   * ladder before it is bound. MistralLaunchControls has no field for it (see
   * the note in buildMistralSealEvidence), so it rides the provider
   * configuration digest rather than a control.
   */
  readonly thinkingLevel: string | null
  /** The resolved `vibe-acp` executable — NOT `mistral` and NOT `vibe`. */
  readonly binaryPath: string
  /** The child env AFTER scrubMistralCredentialEnv has run over it. */
  readonly resolvedEnv: Readonly<Record<string, string>>
  readonly approvalMode: string
  readonly effectivePermissions: EffectiveRunPermissions
  readonly taskWraithMcpAdvertised: boolean
  readonly taskWraithMcpProfileId: TaskWraithMcpProfileId | null
  /**
   * The exact session/new MCP server entry dispatch will attach (name,
   * command, args, env pairs), or null when not advertised. Placeholded here
   * before entering unkeyed digests.
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

export async function buildMistralSealEvidence(
  deps: SealEvidenceDeps,
  facts: MistralSealEvidenceFacts
): Promise<ProviderLaunchAuthorityInputByProvider['mistral']> {
  // The Vibe installer puts `vibe` (interactive TUI) and `vibe-acp` on PATH
  // side by side, and the shared CLI resolver currently derives the binary name
  // from the provider id, which yields `mistral`. Binding the wrong executable
  // would seal authority for a process that either does not exist or hangs a
  // scheduled run forever waiting on a terminal. Refuse rather than seal it.
  const resolvedBinaryName = basename(facts.binaryPath, extname(facts.binaryPath))
  if (resolvedBinaryName !== MISTRAL_BINARY_NAME) {
    throw new SealEvidenceError(
      `Mistral launch evidence requires the ${MISTRAL_BINARY_NAME} executable; the resolved binary is '${resolvedBinaryName}'. \`vibe\` is the interactive TUI and will hang an unattended run.`
    )
  }

  // Two independent signals for the same seat tier: the approval mode dispatch
  // would branch on, and the read-only bit in the signed posture. The seal
  // validator in ScheduledOccurrenceSeal compares controls.readOnlySeat against
  // the POSTURE, so a divergence between the two would surface there as an
  // opaque verification failure long after minting. Cross-check them here so it
  // reads as what it is.
  const writeCapable = mistralWriteCapable(facts.approvalMode)
  const readOnlySeat = facts.effectivePermissions.readOnly === true
  if (writeCapable === readOnlySeat) {
    throw new SealEvidenceError(
      'Mistral seat write capability contradicts the signed read-only posture; refusing to seal.'
    )
  }

  const sessionMode = mistralSessionModeForSeat(readOnlySeat)
  // Producer side of the invariant ScheduledOccurrenceSeal enforces on decode.
  // `accept-edits` and `auto-approve` auto-approve INSIDE the agent, so the
  // tool call never raises session/request_permission and never reaches
  // TaskWraith's host gate — the approval boundary would be gone while every
  // TaskWraith-side control still rendered as armed. Unattended scheduled
  // occurrences are exactly the context where that must be unreachable.
  if (!mistralSessionModeIsGated(sessionMode)) {
    throw new SealEvidenceError(
      `Scheduled Mistral launches cannot use the ungated '${sessionMode}' session mode: it auto-approves tool executions inside the agent, so nothing reaches the TaskWraith host gate.`
    )
  }

  // Derived from the ACTUAL env, never asserted. `scrubCliEnv` does not know
  // about Mistral credential vars, so this is the only thing standing between a
  // scheduled subscription run and the user's metered BYOK billing line —
  // and Vibe reports no error either way, so an unscrubbed env is silent.
  const apiKeyEnvScrubbed = mistralCredentialEnvScrubbed(facts.resolvedEnv)
  if (!apiKeyEnvScrubbed) {
    throw new SealEvidenceError(
      `Mistral launch environment still carries a credential variable (${MISTRAL_CREDENTIAL_ENV_VARS.join(', ')}). Vibe resolves credentials API-key-first, so this launch would silently bill the user's metered Pi BYOK line instead of their plan subscription — a different credential and a different bill, with no error reported. Scrub the env with scrubMistralCredentialEnv before sealing.`
    )
  }

  if (facts.taskWraithMcpAdvertised !== (facts.mcpServerEntry !== null)) {
    throw new SealEvidenceError(
      'Mistral TaskWraith MCP advertisement does not match the ACP session server entry.'
    )
  }

  // EMPTY, always — `vibe-acp` accepts only -h/-v/--setup. Bound anyway so the
  // seal carries an argv template like every other CLI seat, and so a future
  // change that invents flags re-derives a different launch authority.
  const argvTemplate = buildMistralAcpCliArgs()
  const preamble = writeCapable
    ? MISTRAL_WRITE_MODE_PROMPT_PREAMBLE
    : MISTRAL_READ_ONLY_PROMPT_PREAMBLE
  // The wire model is the clamped one: normalizeMistralModel is what stands
  // between a stale/imported id (or a Pi-style `mistral/<model>` wire id, which
  // belongs to a different provider seat entirely) and a mid-turn rejection.
  // Sealing the raw request would bind a model the launch never used.
  const model = normalizeMistralModel(facts.model)
  const thinkingLevel = normalizeMistralThinkingLevel(facts.thinkingLevel)

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
    provider: 'mistral',
    model,
    promptEnvelope: facts.promptEnvelope,
    // Vibe DOES advertise `loadSession: true` and implements
    // session/load / resume / fork — unlike Grok, which has no session reuse at
    // all. This seat nevertheless opens a fresh `session/new` every turn. That
    // is OUR LANE'S CHOICE, not a protocol limitation: a reader who sees
    // `loadSession: true` in the handshake and expects resume evidence here
    // should look no further than this comment. mistralSeatSessionsEnabled()
    // is hard-disabled until a persistent child has durable PID/birth identity
    // and a joined close receipt, so no Vibe session id exists to bind.
    session: { sessionMode: 'fresh', providerSessionId: null, seatGeneration: null },
    resolvedEnv: facts.resolvedEnv,
    credentialState: mistralCredentialStateEvidence(undefined, facts.resolvedEnv.VIBE_HOME ?? null),
    providerConfiguration: {
      kind: 'mistral-vibe-acp-managed',
      // Restated here, not merely in controls, because the configuration digest
      // is what a reader diffs when asking "how was this seat contained?".
      containment: 'acp-session-mode',
      argvContainment: 'none-available',
      argvTemplate: [...argvTemplate],
      sessionMode,
      // MistralLaunchControls has no thinking/reasoning field, so the ladder
      // position rides here rather than being invented as a control. Unbound it
      // would let a scheduled run silently change reasoning depth without
      // re-deriving launch authority.
      thinkingLevel,
      credentialLane: 'plan-oauth',
      credentialEnvScrubbed: [...MISTRAL_CREDENTIAL_ENV_VARS],
      clientFsCapability: 'none'
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
    nativeToolPolicy: { ...MISTRAL_NATIVE_TOOL_POLICY, selectedSessionMode: sessionMode },
    brokerPolicy: {
      kind: facts.taskWraithMcpAdvertised ? 'taskwraith-bridge-broker' : 'none',
      approvalGate: 'signed-run-posture'
    }
  })

  return {
    schemaVersion: 1,
    provider: 'mistral',
    common,
    runtime: await buildCliRuntimeIdentity(deps, {
      binaryPath: facts.binaryPath,
      spawnEnvPath: facts.resolvedEnv.PATH,
      argvTemplate
    }),
    tools,
    controls: {
      transport: 'acp',
      sessionMode,
      readOnlySeat,
      // `initialize` never advertises clientCapabilities.fs: the ACP core never
      // wires onInboundRequest, so an advertised fs capability would be answered
      // -32601 and the agent would believe it had a host filesystem it does not.
      clientFsCapability: 'none',
      taskWraithMcpAttachmentMode: facts.taskWraithMcpAdvertised ? 'acp-session' : 'none',
      credentialLane: 'plan-oauth',
      apiKeyEnvScrubbed,
      model,
      // Named for cross-provider schema symmetry; the DOCUMENT is the session
      // mode policy, because this seat has no deny rules to name. The selected
      // mode joins the digest so re-tiering the seat re-derives the hash rather
      // than leaving a stale "how was it contained" answer behind.
      nativeDenyRulesSha256: sha256HexOfCanonicalJson({
        schemaVersion: 1,
        policy: MISTRAL_NATIVE_TOOL_POLICY,
        selectedSessionMode: sessionMode
      }),
      promptPreambleSha256: sha256HexOfCanonicalJson({
        schemaVersion: 1,
        preamble
      }),
      fallbackPolicy: 'forbid'
    }
  }
}
