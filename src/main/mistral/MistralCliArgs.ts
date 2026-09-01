// Launch policy for the Mistral Vibe ACP seat.
//
// ── WHY THIS FILE LOOKS UNLIKE ITS SIBLINGS ────────────────────────────────
// Every other CLI seat contains its provider at the argv boundary: Grok passes
// `--deny 'Bash(*)'`, Cursor passes an execution mode, Codex passes a sandbox
// flag. `vibe-acp` has NO SUCH SURFACE. Its entire command line is:
//
//   usage: vibe-acp [-h] [-v] [--setup]
//
// (verified against vibe-acp 2.22.0 and 2.24.3). There is no model flag, no
// mode flag, no tool/deny flag, no sandbox flag. `buildMistralAcpCliArgs`
// therefore returns an EMPTY argv, and it exists precisely so that fact is
// explicit, single-sourced and bound into the launch seal rather than being an
// undocumented absence someone later "fixes" by inventing flags that do not
// exist.
//
// Containment for this seat is consequently NOT argv-shaped. It is the ACP
// session mode, selected after `session/new` via `session/set_config_option`
// with `configId: 'mode'`. That is the whole safety story, so the mode we pick
// per tier is the security decision this module encodes.
//
// ── THE MODE LADDER ───────────────────────────────────────────────────────
// `session/new` advertises gated and ungated modes. Two are traps:
//
//   ask             Requires approval for tool executions   ← WRITE tier (Vibe 2.24+)
//   default         Same gated mode id on Vibe <=2.23        ← legacy fallback
//   plan           Read-only agent for exploration          ← READ-ONLY tier
//   accept-edits   Auto-approves file edits only            ← NEVER
//   auto-approve   Auto-approves ALL tool executions        ← NEVER
//   chat           Read-only conversational mode            ← never selected
//
// `accept-edits` and `auto-approve` auto-approve inside the agent, which means
// the tool never reaches `session/request_permission` and therefore never
// reaches TaskWraith's host gate. Selecting either would silently delete the
// approval boundary for this seat while every TaskWraith-side control still
// rendered as if it were armed. They are unreachable through
// `mistralSessionModeForSeat`, and `ScheduledOccurrenceSeal` refuses a sealed
// occurrence that claims one.
//
// `ask`/legacy `default` is the write tier BECAUSE it gates: every tool
// execution raises `session/request_permission`, which the host answers.
// `plan` is the read-only tier and is defence-in-depth — the host gate still auto-denies
// mutations underneath it.

import type { MistralPlanId } from './MistralQuotaEstimate'

/**
 * The binary. NOT `mistral` and NOT `vibe` — `vibe` is the interactive TUI and
 * will hang a run waiting on a terminal that is not there. The Vibe installer
 * puts both on PATH side by side, which makes the wrong one very easy to pick.
 */
export const MISTRAL_BINARY_NAME = 'vibe-acp'

/**
 * The env var Vibe reads a BYOK key from — and the same var Pi exports for its
 * `mistral` upstream (PiModelPolicy.PI_UPSTREAM_KEY_ENV.mistral).
 *
 * Vibe resolves credentials API-KEY-FIRST: if this is set, the child bills the
 * user's metered API account and the plan subscription is never consulted. No
 * error, no warning — just a different bill. Scrubbing it is what makes a
 * Vibe-capable model use the subscription lane rather than the key-marked BYOK
 * lane. `MistralCredentialLane` owns that model-to-lane decision.
 */
export const MISTRAL_API_KEY_ENV = 'MISTRAL_API_KEY'

/** Vibe also accepts this as a credential source; scrub both or neither. */
export const MISTRAL_TOKEN_ENV = 'MISTRAL_TOKEN'

export const MISTRAL_CREDENTIAL_ENV_VARS = [MISTRAL_API_KEY_ENV, MISTRAL_TOKEN_ENV] as const

export type MistralSessionMode =
  | 'ask'
  | 'default'
  | 'plan'
  | 'accept-edits'
  | 'auto-approve'
  | 'chat'

/** Modes that auto-approve inside the agent, bypassing the host gate entirely. */
export const MISTRAL_UNGATED_SESSION_MODES: readonly MistralSessionMode[] = [
  'accept-edits',
  'auto-approve'
]

export function mistralSessionModeIsGated(mode: MistralSessionMode): boolean {
  return !MISTRAL_UNGATED_SESSION_MODES.includes(mode)
}

/**
 * Read-only vs write tier, from TaskWraith's approval mode.
 *
 * Trimmed before the 'plan' compare for the same reason Grok trims: a
 * stray-whitespace `'plan '` must still read as READ-ONLY rather than falling
 * through to write-capable and silently dropping the posture.
 */
export function mistralWriteCapable(approvalMode: string | null | undefined): boolean {
  return (
    typeof approvalMode === 'string' && approvalMode.trim() !== '' && approvalMode.trim() !== 'plan'
  )
}

/**
 * The ONLY sanctioned way to choose a Vibe session mode. Returns a gated mode
 * for both tiers; the ungated modes are not reachable from here by design.
 */
export function mistralSessionModeForSeat(readOnlySeat: boolean): MistralSessionMode {
  return readOnlySeat ? 'plan' : 'ask'
}

/** Equivalent older Vibe mode ids accepted when the preferred id is absent. */
export function mistralSessionModeFallbacksForSeat(
  readOnlySeat: boolean
): readonly MistralSessionMode[] {
  return readOnlySeat ? [] : ['default']
}

/**
 * The native tool policy document for this seat, hashed into the launch seal in
 * place of the argv deny-rule list every other CLI seat binds. Changing how
 * this seat is contained changes this hash, which is the point.
 */
export const MISTRAL_NATIVE_TOOL_POLICY = {
  kind: 'mistral-acp-session-mode',
  containment: 'acp-session-mode',
  argvContainment: 'none-available',
  readOnlyModeId: 'plan',
  writeModeId: 'ask',
  legacyWriteModeIds: ['default'],
  ungatedModesNeverSelected: [...MISTRAL_UNGATED_SESSION_MODES],
  allToolCallsRaisePermissionRequest: true,
  clientFsCapabilityAdvertised: false
} as const

/**
 * The argv for a Vibe ACP launch: EMPTY, always. See the header — `vibe-acp`
 * accepts only -h/-v/--setup, none of which belong in a managed run. Kept as a
 * function so the seal binds an argv template like every other seat and so the
 * emptiness is asserted by a test rather than assumed.
 */
export function buildMistralAcpCliArgs(): string[] {
  return []
}

// ── Models ────────────────────────────────────────────────────────────────
// Sourced from the CLI's own bundled catalogue
// (vibe/core/config/vibe_schema.py DEFAULT_MODELS, v2.22.0). Vibe exposes each
// model under an ALIAS in the ACP `model` config option while its own config
// stores the canonical `name`; the ACP surface speaks aliases, so aliases are
// what this seat uses as model ids.

/** Flagship. Alias of `mistral-vibe-cli-latest`. Available on the FREE plan. */
export const MISTRAL_MODEL_MEDIUM = 'mistral-medium-3.5'
/** Cheap coding model. Alias of `devstral-small-latest`. ~26x cheaper. */
export const MISTRAL_MODEL_DEVSTRAL_SMALL = 'devstral-small'
/**
 * Vibe's third catalogue entry is `local` — a llamacpp backend pointed at
 * 127.0.0.1:8080. It is not a Mistral cloud model, needs a llama-server the
 * user runs themselves, and bills nothing. Deliberately NOT offered by this
 * seat: local inference is Ollama's lane in TaskWraith, and surfacing it here
 * would put a silently-dead model in the picker for every user without a local
 * server.
 */
export const MISTRAL_LOCAL_ALIAS_EXCLUDED = 'local'

export const MISTRAL_SEAT_MODELS = [
  MISTRAL_MODEL_DEVSTRAL_SMALL,
  MISTRAL_MODEL_MEDIUM,
  'glm-5-2',
  'mistral-large-2512',
  'zai-glm-5-2',
  'codestral-2508',
  'mistral-small-2603',
  'devstral-2512',
  'labs-leanstral-1-5',
  'mistral-medium-latest',
  'mistral-medium-2508',
  'mistral-medium-2505',
  'ministral-14b-2512',
  'ministral-8b-2512',
  'ministral-3b-2512'
] as const

/**
 * Default model for a new Mistral seat.
 *
 * devstral-small, not the flagship: graded head-to-head on an identical task
 * with a known-correct answer (2026-07-26), devstral-small was 26x cheaper,
 * used fewer turns, AND got the answer right where medium-3.5 did not. It is
 * also the model whose price makes the heuristic quota meter forgiving rather
 * than alarming.
 */
export const MISTRAL_DEFAULT_MODEL = MISTRAL_MODEL_DEVSTRAL_SMALL

/**
 * Clamp an arbitrary stored model id onto this seat's catalogue.
 *
 * Accepts Vibe's canonical names as well as aliases, because a model id can
 * reach here from a stale thread, an imported chat, or the user's own
 * `~/.vibe/config.toml`. Anything unrecognised — including a Pi-style
 * `mistral/<model>` wire id, which belongs to a DIFFERENT provider seat that
 * merely shares the string 'mistral' — clamps to the default rather than being
 * forwarded to Vibe, which would reject it mid-turn.
 */
export function normalizeMistralModel(model: string | null | undefined): string {
  const raw = typeof model === 'string' ? model.trim() : ''
  if (!raw) return MISTRAL_DEFAULT_MODEL
  // A slash means this is a Pi upstream wire id (`mistral/devstral-2512`), not
  // a seat model. Never forward it; the two identities are distinct providers.
  if (raw.includes('/')) return MISTRAL_DEFAULT_MODEL
  const lowered = raw.toLowerCase()
  if (lowered === MISTRAL_MODEL_MEDIUM || lowered === 'mistral-vibe-cli-latest') {
    return MISTRAL_MODEL_MEDIUM
  }
  if (lowered === MISTRAL_MODEL_DEVSTRAL_SMALL || lowered === 'devstral-small-latest') {
    return MISTRAL_MODEL_DEVSTRAL_SMALL
  }
  const match = MISTRAL_SEAT_MODELS.find((m) => m.toLowerCase() === lowered)
  if (match) return match
  return MISTRAL_DEFAULT_MODEL
}

/** Vibe's reasoning ladder, from `vibe/core/config/models.py` ThinkingLevel. */
export type MistralThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'max'

const MISTRAL_THINKING_LEVELS: readonly MistralThinkingLevel[] = [
  'off',
  'low',
  'medium',
  'high',
  'max'
]

/**
 * Map TaskWraith's reasoning-effort vocabulary onto Vibe's thinking ladder.
 *
 * TaskWraith's ladder carries `xhigh`/`ultra` tiers that Vibe has no equivalent
 * for; they clamp to `max` rather than being passed through, because an
 * unknown value is rejected by `set_config_option` and leaves the session on
 * whatever the model default was — a silent downgrade.
 */
export function normalizeMistralThinkingLevel(
  effort: string | null | undefined
): MistralThinkingLevel | null {
  const raw = typeof effort === 'string' ? effort.trim().toLowerCase() : ''
  if (!raw) return null
  if ((MISTRAL_THINKING_LEVELS as readonly string[]).includes(raw)) {
    return raw as MistralThinkingLevel
  }
  if (raw === 'xhigh' || raw === 'ultra' || raw === 'maximum' || raw === 'ultratask') return 'max'
  if (raw === 'none' || raw === 'minimal') return 'off'
  return null
}

// ── Prompt steers ─────────────────────────────────────────────────────────
// Same purpose as Grok's: a seat whose tool call is refused by the host gate
// can dead-end with no answer. Steering up front keeps the turn productive.
// The host gate remains the safety floor and is unchanged by any of this.

export const MISTRAL_READ_ONLY_PROMPT_PREAMBLE =
  'You are running in READ-ONLY mode (recon / investigation). You CAN read and ' +
  'inspect freely — read files and run read-only shell commands such as ls, ' +
  'cat, grep, find, and git log / status / diff. An explicit no-tools instruction ' +
  'in the user request or role brief overrides that allowance: do not call read, ' +
  'shell, file, or any other tool. File writes and edits, and MUTATING shell ' +
  'commands (anything that changes files or git state, installs packages, or has ' +
  'other side effects) are refused by the host — do not attempt them; if the task ' +
  'would need one, describe what you would change instead. If a tool call is ' +
  'refused, do NOT end your turn — summarise what you found from the reads you ' +
  'did and answer the user directly.'

export const MISTRAL_WRITE_MODE_PROMPT_PREAMBLE =
  'When the task requests file changes, use your edit tools; each call is ' +
  'reviewed by the host before it runs, so expect an approval round-trip rather ' +
  'than an instant result. An explicit no-tools instruction in the user request ' +
  'or role brief overrides that allowance: do not call shell, file, or any other ' +
  'tool. If a tool call is refused or fails, do not end your turn; retry only the ' +
  'same requested operation with an equivalent allowed tool, and never substitute ' +
  'an unrelated shell or file call for a failed one. Otherwise report the failure ' +
  'and answer in prose.'

export function applyMistralPromptPreamble(prompt: string, writeCapable: boolean): string {
  const preamble = writeCapable
    ? MISTRAL_WRITE_MODE_PROMPT_PREAMBLE
    : MISTRAL_READ_ONLY_PROMPT_PREAMBLE
  return `${preamble}\n\n${prompt}`
}

/**
 * Strip Mistral credential env vars from a child environment.
 *
 * Returns a NEW object; never mutates the input, because the caller's env is
 * usually the shared resolved-env object and deleting from it in place would
 * scrub unrelated concurrent launches.
 */
export function scrubMistralCredentialEnv<T extends Record<string, string | undefined>>(
  env: T
): Record<string, string | undefined> {
  const next: Record<string, string | undefined> = { ...env }
  for (const key of MISTRAL_CREDENTIAL_ENV_VARS) delete next[key]
  return next
}

/** True when no Mistral credential env var survives in the given environment. */
export function mistralCredentialEnvScrubbed(
  env: Readonly<Record<string, string | undefined>>
): boolean {
  return MISTRAL_CREDENTIAL_ENV_VARS.every((key) => {
    const value = env[key]
    return value === undefined || value === ''
  })
}

/**
 * Plan tiers the seat knows how to meter. `unknown` is a first-class value, not
 * an error state: Vibe never reports which plan signed in, so an un-configured
 * seat legitimately sits here. See MistralQuotaEstimate.
 */
export function normalizeMistralPlanId(value: string | null | undefined): MistralPlanId {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (raw === 'free' || raw === 'pro' || raw === 'team') return raw
  return 'unknown'
}
