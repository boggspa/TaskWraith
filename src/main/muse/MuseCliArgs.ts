// Pure builders for the Muse Code CLI argv (`muse exec --json …`). No Electron
// imports — unit-testable. Mirrors CursorCliArgs / MistralCliArgs.
//
// LOAD-BEARING SAFETY (wave1-C):
//   * Never emit `--yolo` or `--disable-sandbox`. Contained seats keep Muse's
//     default sandbox ON and pin `--sandbox-network`.
//   * Read-only seats always add `--disable-write` + `--disable-shell`.
//   * Never emit `--reasoning-effort none` for `--provider meta` (CLI rejects it);
//     TaskWraith `none` maps to `minimal`.
//   * Never emit `--no-session-log` when TaskWraith needs metering (usage lives
//     on durable session.jsonl).
//   * Secrets: `--api-key-stdin` only — never put META_API_KEY on argv.
//   * Env helpers relocate XDG_* (+ optional HOME/MUSE_AUTH_PATH) and stamp
//     MUSE_NO_AUTO_UPDATE=1. Home lease / skill pin are out of this module.

/** Launcher on PATH; resolves/execs muse-bin-* beside itself. */
export const MUSE_BINARY_NAME = 'muse'

export const MUSE_DEFAULT_PROVIDER = 'meta'

/** Pin after catalog probe; observed model_id on meta probes. */
export const MUSE_DEFAULT_MODEL = 'muse-spark-1.2'

export const MUSE_TOOL_SURFACE_VERSION_PIN = '2'

/** Refresh when qualifying a new binary (build.sha from session metadata). */
export const MUSE_BUILD_SHA_PIN = '427a430436'

/**
 * Env var that overrides Meta account login. Prefer `--api-key-stdin` or a
 * seat-local auth.json under relocated config; scrub from inherited env unless
 * intentionally BYOK.
 */
export const MUSE_META_API_KEY_ENV = 'META_API_KEY'

/** Intentionally no `none` — meta/Spark rejects it. */
export const MUSE_REASONING_EFFORTS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'ultra'
] as const

export type MuseReasoningEffort = (typeof MUSE_REASONING_EFFORTS)[number]

export type MuseSandboxNetworkMode = 'restricted' | 'enabled' | 'proxy-only'

export const MUSE_DEFAULT_SANDBOX_NETWORK: MuseSandboxNetworkMode = 'proxy-only'

import { randomUUID } from 'node:crypto'

/** Muse `--session-id` must be a UUID; TaskWraith appRunIds are not. */
const MUSE_SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isMuseSessionUuid(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return trimmed.length > 0 && MUSE_SESSION_UUID_RE.test(trimmed)
}

/** Prefer a resumable Muse UUID; never fall back to TaskWraith appRunId. */
export function resolveMuseExecSessionId(
  providerSessionId: string | null | undefined,
  createSessionId: () => string = randomUUID
): string {
  if (isMuseSessionUuid(providerSessionId)) return String(providerSessionId).trim()
  return createSessionId()
}

export const MUSE_DEFAULT_REASONING_EFFORT: MuseReasoningEffort = 'high'

export interface MuseSeatHomes {
  xdgConfigHome: string
  xdgDataHome: string
  xdgStateHome: string
  xdgCacheHome: string
  /** Fake HOME recommended so Muse cannot load ~/.codex etc. via bare HOME. */
  home?: string
  /** Optional absolute path for MUSE_AUTH_PATH. */
  museAuthPath?: string
}

export interface BuildMuseExecArgvInput {
  prompt: string
  workspace: string
  /** TaskWraith-owned durable session id (resume via `--session-id`). */
  sessionId: string
  model?: string | null
  /** Normalize; never emit `none`. */
  reasoningEffort?: string | null
  readOnlySeat: boolean
  maxModelSteps?: number
  maxToolOutputBytes?: number
  /** Default `proxy-only` (Muse CLI default; pinned explicitly). */
  sandboxNetwork?: MuseSandboxNetworkMode
  /** Default true for v1 seat — emit `--disable-web-tools`. */
  disableWebTools?: boolean
  /** Default false — omit `--trust-workspace`. */
  trustWorkspace?: boolean
  /** When true, emit `--api-key-stdin` (caller pipes the key; never on argv). */
  apiKeyStdin?: boolean
  /** If set, emit `--prompt-file` and omit the positional prompt. */
  promptFile?: string
  // NEVER: yolo, disableSandbox, noSessionLog when metering required
}

/**
 * Native tool policy document for this seat — hashed into the launch seal in
 * place of Cursor's sandbox argv list. Changing containment changes this hash.
 */
export const MUSE_NATIVE_TOOL_POLICY = {
  kind: 'muse-cli-exec',
  containment: 'argv-sandbox-plus-disable-write-shell',
  forbiddenFlags: ['--yolo', '--disable-sandbox', '--no-session-log'],
  readOnlyFlags: ['--disable-write', '--disable-shell'],
  headlessFlags: ['--disable-approval', '--user-input-auto-resolve'],
  meteringRequiresSessionLog: true
} as const

/**
 * Read-only vs write tier from TaskWraith's approval mode.
 *
 * Trim before the 'plan' compare (same as Grok/Mistral): a stray-whitespace
 * `'plan '` must still read as READ-ONLY.
 */
export function museWriteCapable(approvalMode: string | null | undefined): boolean {
  return (
    typeof approvalMode === 'string' && approvalMode.trim() !== '' && approvalMode.trim() !== 'plan'
  )
}

/**
 * Map TaskWraith reasoning effort onto Muse's meta-compatible ladder.
 *
 * `none` is invalid for `--provider meta` — map to `minimal`. Unknown values
 * fall through to the CLI default (`high`) rather than being forwarded (an
 * unsupported effort aborts the turn).
 */
export function normalizeMuseReasoningEffort(
  effort: string | null | undefined
): MuseReasoningEffort {
  const raw = typeof effort === 'string' ? effort.trim().toLowerCase() : ''
  if (!raw) return MUSE_DEFAULT_REASONING_EFFORT
  if (raw === 'none' || raw === 'off') return 'minimal'
  if ((MUSE_REASONING_EFFORTS as readonly string[]).includes(raw)) {
    return raw as MuseReasoningEffort
  }
  return MUSE_DEFAULT_REASONING_EFFORT
}

function resolveSandboxNetwork(mode: MuseSandboxNetworkMode | undefined): MuseSandboxNetworkMode {
  if (mode === 'restricted' || mode === 'enabled' || mode === 'proxy-only') return mode
  return MUSE_DEFAULT_SANDBOX_NETWORK
}

function resolveModelArg(model: string | null | undefined): string | null {
  if (typeof model !== 'string') return null
  const trimmed = model.trim()
  if (!trimmed || trimmed === 'cli-default') return null
  return trimmed
}

/**
 * Production Muse exec argv. Always starts with
 * `exec --json --provider meta --workspace …`. Never emits forbidden flags.
 */
export function buildMuseExecArgv(input: BuildMuseExecArgvInput): string[] {
  const workspace = typeof input.workspace === 'string' ? input.workspace.trim() : ''
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
  if (!workspace) {
    throw new Error('buildMuseExecArgv requires a non-empty workspace path')
  }
  if (!sessionId) {
    throw new Error('buildMuseExecArgv requires a non-empty sessionId')
  }
  if (!isMuseSessionUuid(sessionId)) {
    throw new Error(
      `buildMuseExecArgv requires a UUID --session-id (got ${JSON.stringify(sessionId)}; Muse rejects TaskWraith appRunId-shaped ids)`
    )
  }

  const args: string[] = [
    'exec',
    '--json',
    '--provider',
    MUSE_DEFAULT_PROVIDER,
    '--workspace',
    workspace,
    '--no-foreign-personal-context',
    // Headless: avoid interactive approval UI / request_user_input stalls.
    '--disable-approval',
    '--user-input-auto-resolve',
    '--session-id',
    sessionId,
    '--reasoning-effort',
    normalizeMuseReasoningEffort(input.reasoningEffort),
    '--sandbox-network',
    resolveSandboxNetwork(input.sandboxNetwork)
  ]

  if (input.disableWebTools !== false) {
    args.push('--disable-web-tools')
  }

  if (input.readOnlySeat) {
    args.push('--disable-write', '--disable-shell')
  }

  if (input.trustWorkspace === true) {
    args.push('--trust-workspace')
  }

  if (typeof input.maxModelSteps === 'number' && Number.isFinite(input.maxModelSteps)) {
    args.push('--max-model-steps', String(Math.max(0, Math.trunc(input.maxModelSteps))))
  }

  if (typeof input.maxToolOutputBytes === 'number' && Number.isFinite(input.maxToolOutputBytes)) {
    args.push('--max-tool-output-bytes', String(Math.max(0, Math.trunc(input.maxToolOutputBytes))))
  }

  const modelArg = resolveModelArg(input.model)
  if (modelArg) {
    args.push('--model', modelArg)
  }

  if (input.apiKeyStdin === true) {
    args.push('--api-key-stdin')
  }

  const promptFile = typeof input.promptFile === 'string' ? input.promptFile.trim() : ''
  if (promptFile) {
    args.push('--prompt-file', promptFile)
  } else {
    // Prefer --prompt-file for flag-shaped prompts (Muse has no documented `--`
    // end-of-options guard on exec). Positional is fine for ordinary text.
    args.push(input.prompt)
  }

  return args
}

export interface BuildMuseSeatEnvOptions {
  /** Drop META_API_KEY from the child env (default true). */
  scrubMetaApiKey?: boolean
  /** Stamp MUSE_NO_AUTO_UPDATE=1 (default true). */
  museNoAutoUpdate?: boolean
}

/**
 * Child env for a Muse seat: relocate XDG_* (+ optional HOME / MUSE_AUTH_PATH),
 * stamp MUSE_NO_AUTO_UPDATE, optionally scrub META_API_KEY.
 *
 * Returns a NEW object; never mutates the input (shared resolved-env).
 * Home directory creation / skill pin / cron assert live in MuseSeatHome
 * (another module).
 */
export function buildMuseSeatEnv(
  baseEnv: Record<string, string | undefined>,
  homes: MuseSeatHomes,
  opts?: BuildMuseSeatEnvOptions
): Record<string, string | undefined> {
  const next: Record<string, string | undefined> = { ...baseEnv }

  next.XDG_CONFIG_HOME = homes.xdgConfigHome
  next.XDG_DATA_HOME = homes.xdgDataHome
  next.XDG_STATE_HOME = homes.xdgStateHome
  next.XDG_CACHE_HOME = homes.xdgCacheHome

  if (typeof homes.home === 'string' && homes.home.trim()) {
    next.HOME = homes.home.trim()
  }

  if (typeof homes.museAuthPath === 'string' && homes.museAuthPath.trim()) {
    next.MUSE_AUTH_PATH = homes.museAuthPath.trim()
  }

  if (opts?.museNoAutoUpdate !== false) {
    next.MUSE_NO_AUTO_UPDATE = '1'
  }

  if (opts?.scrubMetaApiKey !== false) {
    delete next[MUSE_META_API_KEY_ENV]
  }

  return next
}

/** True when META_API_KEY is absent or empty in the given environment. */
export function museMetaApiKeyScrubbed(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env[MUSE_META_API_KEY_ENV]
  return value === undefined || value === ''
}
