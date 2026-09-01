// Launch policy for the Devin ACP seat.
//
// ── TRANSPORT ─────────────────────────────────────────────────────────────
// Devin speaks ACP over stdio via `devin acp`. Optional `--model <id>` arg.
// No permission-mode flag — permission prompts surface via ACP
// request_permission events, same as Mistral's ask/default mode.
//
// Binary: settings override else bare 'devin' on PATH.
//
// ── AUTH ──────────────────────────────────────────────────────────────────
// Three credential lanes, resolved in order:
//   1. Env keys: WINDSURF_API_KEY (canonical), DEVIN_API_KEY, windsurf_api_key
//   2. Stored credentials: ~/.local/share/devin/credentials.toml
//      (Windows: %APPDATA%\devin\credentials.toml) written by `devin auth login`
//      Contains: windsurf_api_key + api_server_url
//   3. ACP authenticate meta: headless:true + api_key + api_server_url
//
// ── ENDPOINT OVERRIDE ─────────────────────────────────────────────────────
// WINDSURF_API_SERVER_URL / DEVIN_API_SERVER_URL env or stored api_server_url.
// Validation: HTTPS only (HTTP allowed solely on loopback), no credentials
// embedded in URL, hash/query stripped.

/**
 * The binary. `devin` is the CLI; `devin acp` starts the ACP stdio server.
 */
export const DEVIN_BINARY_NAME = 'devin'

/**
 * ACP subcommand to start the stdio server.
 */
export const DEVIN_ACP_SUBCOMMAND = 'acp'

/**
 * Canonical env var for the Devin/Windsurf API key. Devin normalizes this
 * into the child process environment.
 */
export const DEVIN_API_KEY_ENV = 'WINDSURF_API_KEY'

/** Devin also accepts this alias. */
export const DEVIN_API_KEY_ENV_ALT = 'DEVIN_API_KEY'

/** Lowercase alias accepted by some Devin CLI versions. */
export const DEVIN_API_KEY_ENV_LOWER = 'windsurf_api_key'

/**
 * Env vars for the custom API server endpoint override.
 */
export const DEVIN_API_SERVER_URL_ENV = 'WINDSURF_API_SERVER_URL'
export const DEVIN_API_SERVER_URL_ENV_ALT = 'DEVIN_API_SERVER_URL'

/** All credential env vars Devin reads. */
export const DEVIN_CREDENTIAL_ENV_VARS = [
  DEVIN_API_KEY_ENV,
  DEVIN_API_KEY_ENV_ALT,
  DEVIN_API_KEY_ENV_LOWER
] as const

/** All endpoint env vars Devin reads. */
export const DEVIN_ENDPOINT_ENV_VARS = [
  DEVIN_API_SERVER_URL_ENV,
  DEVIN_API_SERVER_URL_ENV_ALT
] as const

/**
 * Returns a NEW object with all Devin credential env vars removed.
 * Never mutates the input, because the caller's env is usually the shared
 * resolved-env object and deleting from it in place would scrub unrelated
 * concurrent launches.
 */
export function scrubDevinCredentialEnv<T extends Record<string, string | undefined>>(
  env: T
): Record<string, string | undefined> {
  const next: Record<string, string | undefined> = { ...env }
  for (const key of DEVIN_CREDENTIAL_ENV_VARS) delete next[key]
  return next
}

/** True when no Devin credential env var survives in the given environment. */
export function devinCredentialEnvScrubbed(
  env: Readonly<Record<string, string | undefined>>
): boolean {
  return DEVIN_CREDENTIAL_ENV_VARS.every((key) => {
    const value = env[key]
    return value === undefined || value === ''
  })
}

/**
 * Build the argv for `devin acp`. Returns `['acp']` plus optional `--model`
 * when a model id is provided.
 */
export function buildDevinAcpCliArgs(model?: string | null): string[] {
  const args = [DEVIN_ACP_SUBCOMMAND]
  if (model && model.trim()) {
    args.push('--model', model.trim())
  }
  return args
}

/**
 * Trimmed before the 'plan' compare for the same reason Mistral trims: a
 * stray-whitespace `'plan '` must still read as READ-ONLY rather than falling
 * through to write-capable and silently dropping the posture.
 */
export function devinWriteCapable(approvalMode: string | null | undefined): boolean {
  return (
    typeof approvalMode === 'string' && approvalMode.trim() !== '' && approvalMode.trim() !== 'plan'
  )
}

// ── Prompt steers ─────────────────────────────────────────────────────────
// Same purpose as Mistral's: a seat whose tool call is refused by the host
// gate can dead-end with no answer. Steering up front keeps the turn
// productive. The host gate remains the safety floor and is unchanged by any
// of this.

export const DEVIN_READ_ONLY_PROMPT_PREAMBLE =
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

export const DEVIN_WRITE_MODE_PROMPT_PREAMBLE =
  'When the task requests file changes, use your edit tools; each call is ' +
  'reviewed by the host before it runs, so expect an approval round-trip rather ' +
  'than an instant result. An explicit no-tools instruction in the user request ' +
  'or role brief overrides that allowance: do not call shell, file, or any other ' +
  'tool. If a tool call is refused or fails, do not end your turn; retry only the ' +
  'same requested operation with an equivalent allowed tool, and never substitute ' +
  'an unrelated shell or file call for a failed one. Otherwise report the failure ' +
  'and answer in prose.'

export function applyDevinPromptPreamble(prompt: string, writeCapable: boolean): string {
  const preamble = writeCapable
    ? DEVIN_WRITE_MODE_PROMPT_PREAMBLE
    : DEVIN_READ_ONLY_PROMPT_PREAMBLE
  return `${preamble}\n\n${prompt}`
}
