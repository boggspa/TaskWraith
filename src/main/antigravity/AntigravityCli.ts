// Transport primitives for the user-installed official Antigravity CLI (`agy`).
//
// This module intentionally has no provider registration, Electron, IPC, or
// runtime-launch wiring. It establishes a small, testable foundation for a
// later, separately reviewed runtime slice. In particular, it never resolves
// credential files/keyrings, calls private endpoints, installs plugins, or
// enables the CLI's permission-bypass flag.

import { promises as fs } from 'fs'
import { delimiter, join } from 'path'
import { cliBinaryNameCandidates, getCliSearchDirs } from '../providers/CliSearchDirs'
import {
  TASKWRAITH_LOCK_OWNER_ENV_KEY,
  withExactWorkspaceLockOwnerEnv
} from '../WorkspaceLockExecutionIdentity'

export const AGY_BINARY_NAME = 'agy'
export const AGY_MODEL_DISCOVERY_ARGS = ['models'] as const
export const AGY_READ_ONLY_PRINT_TIMEOUT = '30m'

/**
 * These variables select API-key, service-account, or bearer-token flows in
 * Google tooling. TaskWraith's AntiGravity path must use only the user's
 * official agy keyring/browser session, so they are removed case-insensitively
 * immediately before an agy child process is spawned.
 */
export const AGY_STRIPPED_CREDENTIAL_ENV_KEYS = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_OAUTH_ACCESS_TOKEN',
  'GOOGLE_ACCESS_TOKEN',
  'GOOGLE_CLOUD_ACCESS_TOKEN',
  'CLOUDSDK_AUTH_ACCESS_TOKEN'
] as const

const AGY_STRIPPED_CREDENTIAL_ENV_KEY_SET = new Set<string>(AGY_STRIPPED_CREDENTIAL_ENV_KEYS)
const AGY_REASONING_EFFORTS = new Set(['low', 'medium', 'high'])
/** agy's canonical conversation id form; matching is case-insensitive. */
const AGY_CONVERSATION_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_MODEL_VALUE_LENGTH = 512
const MAX_DISCOVERED_MODELS = 128
const CONTROL_CHARACTERS_RE = new RegExp(String.raw`[\u0000-\u001F\u007F]`)
const CONTROL_CHARACTERS_GLOBAL_RE = new RegExp(String.raw`[\u0000-\u001F\u007F]`, 'g')
const ANSI_ESCAPE_RE = new RegExp(String.raw`\u001b\[[0-?]*[ -/]*[@-~]`, 'g')

export type AgyBinarySource = 'path' | 'common' | 'missing'

export interface ResolvedAgyCliBinary {
  binaryPath: string | null
  source: AgyBinarySource
  error?: string
}

export interface AgyCliResolverDependencies {
  env?: Readonly<Record<string, string | undefined>>
  getSearchDirs?: (env: Readonly<Record<string, string | undefined>>) => readonly string[]
  getBinaryCandidates?: (binaryName: string) => readonly string[]
  fileExists?: (candidate: string) => Promise<boolean>
}

export interface BuildAgyReadOnlyPrintArgsInput {
  prompt: string
  model?: string | null
  reasoningEffort?: string | null
  conversationId?: string | null
  /** Create and bind a real agy project for a fresh TaskWraith conversation. */
  newProject?: boolean
}

export interface BuildAgyWriteCapablePrintArgsInput extends BuildAgyReadOnlyPrintArgsInput {}

export interface AgyModel {
  /** Exact CLI-selectable value. Never synthesize or rewrite this string. */
  id: string
  label: string
}

export interface AgyProcessCaptureResult {
  stdout: string
  stderr: string
  code: number | null
  error?: string
  timedOut?: boolean
}

export interface AgyModelProbeDependencies {
  resolveBinary: () => Promise<ResolvedAgyCliBinary>
  capture: (
    command: string,
    args: readonly string[],
    options: { env: Record<string, string>; timeoutMs: number }
  ) => Promise<AgyProcessCaptureResult>
  env?: Readonly<Record<string, string | undefined>>
  timeoutMs?: number
}

export interface AgyModelProbeResult {
  binary: ResolvedAgyCliBinary
  models: AgyModel[]
  error?: string
}

async function defaultFileExists(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate)
    return stat.isFile() || stat.isSymbolicLink()
  } catch {
    return false
  }
}

function pathDirectories(env: Readonly<Record<string, string | undefined>>): Set<string> {
  return new Set((env.PATH || '').split(delimiter).filter(Boolean))
}

/**
 * Resolve only the official `agy` executable from the user's ordinary PATH or
 * common local install roots. There is deliberately no app-managed binary
 * download, configured API-key path, or provider-runtime profile integration
 * in S2.
 */
export async function resolveAgyCliBinary(
  deps: AgyCliResolverDependencies = {}
): Promise<ResolvedAgyCliBinary> {
  const env = deps.env ?? process.env
  const searchDirs = deps.getSearchDirs
    ? deps.getSearchDirs(env)
    : getCliSearchDirs(null, env)
  const names = deps.getBinaryCandidates
    ? deps.getBinaryCandidates(AGY_BINARY_NAME)
    : cliBinaryNameCandidates(AGY_BINARY_NAME)
  const exists = deps.fileExists ?? defaultFileExists
  const inheritedPathDirectories = pathDirectories(env)
  const seen = new Set<string>()

  for (const directory of searchDirs) {
    for (const name of names) {
      const candidate = join(directory, name)
      if (!candidate || seen.has(candidate)) continue
      seen.add(candidate)
      if (await exists(candidate)) {
        return {
          binaryPath: candidate,
          source: inheritedPathDirectories.has(directory) ? 'path' : 'common'
        }
      }
    }
  }

  return {
    binaryPath: null,
    source: 'missing',
    error: 'The official Antigravity CLI (agy) was not found on PATH or common local install locations.'
  }
}

export function isAgyCredentialEnvironmentKey(key: string): boolean {
  return AGY_STRIPPED_CREDENTIAL_ENV_KEY_SET.has(String(key || '').trim().toUpperCase())
}

/**
 * Build the process environment handed to `agy`. Credentials are stripped
 * after caller additions, so no future call site can accidentally reintroduce
 * an API-key or service-account path through its extra environment.
 */
export function createAgyCliEnv(
  inheritedEnv: Readonly<Record<string, string | undefined>> = process.env,
  extraEnv: Readonly<Record<string, string | undefined>> = {}
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(inheritedEnv)) {
    if (key.toUpperCase() === TASKWRAITH_LOCK_OWNER_ENV_KEY) continue
    if (typeof value !== 'string' || isAgyCredentialEnvironmentKey(key)) continue
    env[key] = value
  }
  for (const [key, value] of Object.entries(extraEnv)) {
    if (key.toUpperCase() === TASKWRAITH_LOCK_OWNER_ENV_KEY) continue
    if (typeof value !== 'string' || isAgyCredentialEnvironmentKey(key)) continue
    env[key] = value
  }
  return withExactWorkspaceLockOwnerEnv(
    env,
    extraEnv[TASKWRAITH_LOCK_OWNER_ENV_KEY]
  ) as Record<string, string>
}

export function buildAgyModelDiscoveryArgs(): string[] {
  return [...AGY_MODEL_DISCOVERY_ARGS]
}

function normalizeAgyArg(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (
    !normalized ||
    normalized.length > MAX_MODEL_VALUE_LENGTH ||
    CONTROL_CHARACTERS_RE.test(normalized)
  ) {
    return null
  }
  return normalized
}

/**
 * Accept only agy's own uuid form for `--conversation`.
 *
 * This is stricter than `normalizeAgyArg` on purpose. Verified 2026-07-25: agy
 * answers an UNKNOWN conversation id by silently allocating a fresh
 * conversation and reporting no error, so a synthesized slug, another provider's
 * session id, or a truncated value would not fail — it would quietly discard the
 * user's context. Rejecting non-uuids here keeps that failure impossible.
 */
export function normalizeAgyConversationId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return AGY_CONVERSATION_UUID_RE.test(normalized) ? normalized : null
}

export function normalizeAgyReasoningEffort(value: string | null | undefined): string | null {
  const normalized = normalizeAgyArg(value)?.toLowerCase() || null
  return normalized && AGY_REASONING_EFFORTS.has(normalized) ? normalized : null
}

/**
 * Construct the only turn argv S2 permits: sandboxed, non-interactive,
 * read-only planning. S3 owns any separately reviewed execution integration.
 */
export function buildAgyReadOnlyPrintArgs(input: BuildAgyReadOnlyPrintArgsInput): string[] {
  return buildAgyPrintArgs(input, 'plan')
}

/**
 * Construct the separately reviewed write-capable turn argv. This is never a
 * permission bypass: the official CLI remains sandboxed and receives its
 * normal `accept-edits` mode, while TaskWraith retains run admission,
 * cancellation, and audit ownership around the child process.
 */
export function buildAgyWriteCapablePrintArgs(
  input: BuildAgyWriteCapablePrintArgsInput
): string[] {
  return buildAgyPrintArgs(input, 'accept-edits')
}

function buildAgyPrintArgs(
  input: BuildAgyReadOnlyPrintArgsInput,
  mode: 'plan' | 'accept-edits'
): string[] {
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
    throw new Error('An Antigravity print-mode prompt is required.')
  }

  const args = [
    '--sandbox',
    '--mode',
    mode,
    '--print-timeout',
    AGY_READ_ONLY_PRINT_TIMEOUT
  ]
  const conversationId = normalizeAgyConversationId(input.conversationId)
  if (conversationId && input.newProject) {
    throw new Error('Antigravity cannot create a new project while resuming a conversation.')
  }
  if (conversationId) args.push('--conversation', conversationId)
  else if (input.newProject) args.push('--new-project')
  const model = normalizeAgyArg(input.model)
  if (model) args.push('--model', model)
  const reasoningEffort = normalizeAgyReasoningEffort(input.reasoningEffort)
  if (reasoningEffort) args.push('--effort', reasoningEffort)
  // `-p <prompt>` is the audited one-shot print-mode form. Passing prompt as a
  // separate argv member means its content is never interpreted by a shell.
  args.push('-p', input.prompt)
  return args
}

function stripAnsiAndControls(value: string): string {
  return value
    .replace(ANSI_ESCAPE_RE, '')
    .replace(CONTROL_CHARACTERS_GLOBAL_RE, '')
    .trim()
}

function modelFromValues(idValue: unknown, labelValue?: unknown): AgyModel | null {
  if (typeof idValue !== 'string' && typeof idValue !== 'number') return null
  const id = stripAnsiAndControls(String(idValue)).slice(0, MAX_MODEL_VALUE_LENGTH)
  if (!id) return null
  const label =
    typeof labelValue === 'string' || typeof labelValue === 'number'
      ? stripAnsiAndControls(String(labelValue)).slice(0, MAX_MODEL_VALUE_LENGTH) || id
      : id
  return { id, label }
}

function appendModel(models: AgyModel[], seen: Set<string>, model: AgyModel | null): void {
  if (!model || models.length >= MAX_DISCOVERED_MODELS) return
  const dedupeKey = model.id.toLowerCase()
  if (seen.has(dedupeKey)) return
  seen.add(dedupeKey)
  models.push(model)
}

function parseJsonModels(raw: string): AgyModel[] | null {
  const text = raw.trim()
  if (!text || !/^[{[]/.test(text)) return null
  try {
    const parsed: unknown = JSON.parse(text)
    const entries = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object'
        ? (parsed as { models?: unknown; data?: unknown }).models ??
          (parsed as { data?: unknown }).data
        : null
    if (!Array.isArray(entries)) return []
    const models: AgyModel[] = []
    const seen = new Set<string>()
    for (const entry of entries) {
      if (typeof entry === 'string' || typeof entry === 'number') {
        appendModel(models, seen, modelFromValues(entry))
        continue
      }
      if (!entry || typeof entry !== 'object') continue
      const record = entry as Record<string, unknown>
      appendModel(
        models,
        seen,
        modelFromValues(
          record.id ?? record.modelId ?? record.model ?? record.name,
          record.label ?? record.displayName ?? record.name
        )
      )
    }
    return models
  } catch {
    return null
  }
}

function parsePlainModelLine(line: string): AgyModel | null {
  const cleaned = stripAnsiAndControls(line).replace(/^(?:[-*•]\s*)+/, '')
  if (!cleaned) return null
  if (
    /^(?:available\s+models?|models?|no\s+models?|not\s+logged|not\s+authenticated|please\s+(?:log|sign)|authenticate|error|failed|usage:|warning:)/i.test(
      cleaned
    )
  ) {
    return null
  }
  if (
    /\b(?:error|failed|not\s+(?:logged|authenticated)|log\s*in|authentication\s+required)\b/i.test(
      cleaned
    )
  ) {
    return null
  }

  // Common CLI list shapes: "id - Label" and "id  Label". For a plain
  // display label, preserve it exactly because `agy --model` accepts the
  // provider-reported value rather than a TaskWraith-generated slug.
  const dashed = cleaned.match(/^([A-Za-z0-9][A-Za-z0-9._:/-]*)\s+-\s+(.+)$/)
  if (dashed) return modelFromValues(dashed[1], dashed[2])
  const columns = cleaned.match(/^([A-Za-z0-9][A-Za-z0-9._:/-]*)\s{2,}(.+)$/)
  if (columns) return modelFromValues(columns[1], columns[2])
  // Plain labels are less structurally distinct from a CLI error. The current
  // official catalogue names Gemini, Claude, or GPT model families; require
  // one of those explicit markers rather than accidentally offering an
  // unauthenticated/error sentence as a selectable model.
  return /\b(?:gemini|claude|gpt|flash|pro)\b/i.test(cleaned)
    ? modelFromValues(cleaned)
    : null
}

/**
 * Parse either structured `agy models` output or its human-readable fallback.
 * Unknown/error prose is intentionally discarded rather than converted into a
 * selectable model. S4 owns exposing any parsed values to the model picker.
 */
export function parseAgyModels(raw: string): AgyModel[] {
  const jsonModels = parseJsonModels(raw)
  if (jsonModels) return jsonModels

  const models: AgyModel[] = []
  const seen = new Set<string>()
  for (const line of raw.split(/\r?\n/)) {
    appendModel(models, seen, parsePlainModelLine(line))
  }
  return models
}

/**
 * Dependency-injected model discovery for a future opt-in-only caller. This
 * module never calls it automatically; the caller must first establish the
 * user's recorded consent and configured-provider eligibility.
 */
export async function probeAgyModels(
  deps: AgyModelProbeDependencies
): Promise<AgyModelProbeResult> {
  const binary = await deps.resolveBinary()
  if (!binary.binaryPath) return { binary, models: [], error: binary.error }

  const result = await deps.capture(binary.binaryPath, buildAgyModelDiscoveryArgs(), {
    env: createAgyCliEnv(deps.env, { FORCE_COLOR: '0', NO_COLOR: '1' }),
    timeoutMs: deps.timeoutMs ?? 8_000
  })
  const output = result.stdout || result.stderr || ''
  const models = parseAgyModels(output)
  const error = result.error
    ? result.error
    : result.timedOut
      ? 'agy models timed out.'
      : result.code !== 0
        ? stripAnsiAndControls(result.stderr) || `agy models exited with code ${result.code ?? 'unknown'}.`
        : undefined
  return { binary, models, error }
}
