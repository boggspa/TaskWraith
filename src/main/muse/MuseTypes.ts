/**
 * Shared Muse seat types (opaque `muse exec --json` transport).
 *
 * No `ProviderId` yet — identity wiring lands in a later wave. These types keep
 * the adapter / probe / sibling modules compilable in isolation.
 */

/** Stable seat key used in Muse-local descriptors until ProviderId lands. */
export const MUSE_PROVIDER_KEY = 'muse' as const
export type MuseProviderKey = typeof MUSE_PROVIDER_KEY

/** Transport id for launch-authority digests / adapter descriptors. */
export const MUSE_TRANSPORT_ID = 'muse-exec-json' as const
export type MuseTransportId = typeof MUSE_TRANSPORT_ID

/** Expected Muse tool-surface schema version (HANDOFF / wave-1 D+C). */
export const MUSE_EXPECTED_TOOL_SURFACE_VERSION = '2' as const

/** Reasoning efforts accepted for `--provider meta` (never `none`). */
export const MUSE_META_REASONING_EFFORTS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'ultra'
] as const
export type MuseMetaReasoningEffort = (typeof MUSE_META_REASONING_EFFORTS)[number]

/**
 * Argv tokens the seat builder must never emit.
 * Aligns with `MUSE_NATIVE_TOOL_POLICY.forbiddenFlags` in MuseCliArgs
 * (`--disable-approval` is intentionally emitted for headless seats).
 */
export const MUSE_FORBIDDEN_ARGV_FLAGS = ['--yolo', '--disable-sandbox'] as const

/** Soft-forbidden in production metering seats (mutually exclusive with jsonl tail). */
export const MUSE_METERING_EXCLUSIVE_ARGV_FLAGS = ['--no-session-log'] as const

export interface MuseTokenUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  estimatedCostUsd?: number
}

/**
 * Normalized events consumed by the opaque-exec run pump (Cursor/Grok family).
 * Produced by a future `MuseExecJson` reducer (W2C).
 */
export interface NormalizedMuseRunEvent {
  type:
    | 'init'
    | 'content'
    | 'thinking'
    | 'tool_use'
    | 'tool_result'
    | 'result'
    | 'usage'
    | 'provider_warning'
  text?: string
  sessionId?: string
  model?: string
  status?: string
  usage?: MuseTokenUsage
  toolId?: string
  toolName?: string
  toolKind?: string
  toolInput?: Record<string, unknown>
  toolStatus?: 'success' | 'error'
  toolOutput?: string
  toolSurfaceVersion?: string
  buildSha?: string
  raw?: unknown
}

export interface MuseIsolatedHomeEnv {
  readonly HOME: string
  readonly USERPROFILE?: string
  readonly TMPDIR: string
  readonly XDG_CONFIG_HOME: string
  readonly XDG_DATA_HOME: string
  readonly XDG_CACHE_HOME: string
  readonly XDG_STATE_HOME: string
  readonly XDG_RUNTIME_DIR?: string
  readonly MUSE_NO_AUTO_UPDATE: '1'
  readonly MUSE_AUTH_PATH?: string
}

export interface MuseIsolatedHomeAuthority {
  readonly schemaVersion: 1
  readonly strategy: 'node-mkdtemp-random-suffix-v1'
  readonly canonicalRealPathVerified: true
  readonly leafType: 'real-directory'
  readonly fileIdentity: Readonly<{
    readonly device: string
    readonly inode: string
  }>
  readonly fileIdentityVerification: 'device-inode-match' | 'device-inode-best-effort'
  readonly ownerVerification: 'process-uid-match' | 'unsupported-platform'
  readonly modeVerification: 'posix-0700' | 'unsupported-platform'
  readonly cleanupPolicy: 'identity-match-recursive-force'
}

export type MuseIsolatedHomeCleanupResult =
  | Readonly<{ ok: true; alreadyAbsent: boolean }>
  | Readonly<{ ok: false; reason: string }>

/** Pi-shaped lease returned by a future `MuseIsolatedHome` module (W2A/B). */
export interface MuseIsolatedHomeLease {
  readonly path: string
  readonly authority: MuseIsolatedHomeAuthority
  readonly env: MuseIsolatedHomeEnv
  verify(): MuseIsolatedHomeAuthority
  cleanup(): MuseIsolatedHomeCleanupResult
}

/**
 * Immutable production spawn plan (Cursor Path-B pattern).
 * Built after home create + skill pin; consumed by the opaque exec runner.
 */
export interface MuseLaunchPlan {
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
  readonly sessionId: string
  readonly isolatedHome: MuseIsolatedHomeLease
  readonly wireModel: string | null
  readonly effort: MuseMetaReasoningEffort
  readonly writeCapable: boolean
  readonly toolSurfaceVersionExpected: typeof MUSE_EXPECTED_TOOL_SURFACE_VERSION
  readonly buildShaExpected: string | null
  readonly skillPinHash: string | null
  readonly nativeToolPolicySha256: string | null
  readonly apiKeyStdin: boolean
}

export interface MuseRunRequest {
  readonly runId: string
  readonly workspacePath: string
  readonly prompt: string
  readonly model?: string | null
  readonly reasoningEffort?: string | null
  readonly approvalMode?: string | null
  readonly writeCapable: boolean
  readonly sessionId?: string | null
  /** Optional BYOK key for `--api-key-stdin` (never placed on argv). */
  readonly apiKey?: string | null
  readonly temporaryRoot: string
  readonly buildShaExpected?: string | null
}

export type MuseRunTerminalStatus = 'success' | 'failed' | 'cancelled'

export interface MuseRunResult {
  readonly status: MuseRunTerminalStatus
  readonly sessionId: string | null
  readonly exitCode: number | null
  readonly assistantText: string
  readonly usage: MuseTokenUsage | null
  readonly warnings: readonly string[]
  readonly toolSurfaceVersion: string | null
  readonly buildSha: string | null
}

export interface MuseCredentialEvidence {
  readonly present: boolean
  readonly source: 'auth-json-meta' | 'meta-api-key-env' | 'injected' | 'none'
  /** Muse-owned credential mechanism; never includes credential bytes. */
  readonly credentialKind: 'api-key' | 'oauth' | null
  /** Length only — never the secret. */
  readonly apiKeyLength: number | null
}

export interface MuseBinaryResolution {
  readonly binaryPath: string | null
  readonly source?: string
  readonly error?: string
}
