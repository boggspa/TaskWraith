import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { isAbsolute, join, parse, resolve } from 'node:path'

import {
  ANTIGRAVITY_EFFORT_ORDER,
  antigravityEffortForModelId,
  groupAntigravityModelRows
} from '../../shared/antigravityAgyModelGrouping'
import { ANTIGRAVITY_PROVIDER_ID, isAntigravityOptInEnabled } from '../../shared/retiredProviders'
import type {
  HostPermissionPostureOffer,
  HostProviderModelOffer,
  HostProviderOffersProjection,
  HostProviderReasoningOffer
} from '../../shared/hostSetupProtocol'

export const HOST_ANTIGRAVITY_SETTINGS_FILENAME = 'settings.json'
export const HOST_AGY_MODEL_DISCOVERY_ARGS = ['models'] as const

const MAX_SETTINGS_BYTES = 512 * 1024
const MAX_PROBE_OUTPUT_BYTES = 256 * 1024
const MAX_MODEL_CHARS = 512
const MAX_MODELS = 128
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/
// eslint-disable-next-line no-control-regex -- profile paths and model ids reject C0 controls.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
// eslint-disable-next-line no-control-regex -- probe output strips C0 controls before parsing.
const CONTROL_CHARACTERS_GLOBAL = /[\u0000-\u001f\u007f]/g
// eslint-disable-next-line no-control-regex -- PTY output may contain ANSI escape sequences.
const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g
const SAFE_REASONING_LABELS: Readonly<Record<string, string>> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  on: 'On'
}

export const HOST_AGY_STRIPPED_CREDENTIAL_ENV_KEYS = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_OAUTH_ACCESS_TOKEN',
  'GOOGLE_ACCESS_TOKEN',
  'GOOGLE_CLOUD_ACCESS_TOKEN',
  'CLOUDSDK_AUTH_ACCESS_TOKEN'
] as const

const STRIPPED_ENV_KEYS = new Set<string>([
  ...HOST_AGY_STRIPPED_CREDENTIAL_ENV_KEYS,
  'TASKWRAITH_LOCK_OWNER_ID'
])

const ANTIGRAVITY_POSTURES: readonly HostPermissionPostureOffer[] = [
  {
    postureId: 'plan',
    label: 'Plan',
    available: true,
    requiresExplicitConsent: false,
    ceiling: 'read'
  },
  {
    postureId: 'read_only',
    label: 'Ask',
    available: false,
    requiresExplicitConsent: false,
    ceiling: 'read',
    detail: 'The standalone agy transport cannot resume a per-action permission prompt.'
  },
  {
    postureId: 'default',
    label: 'Accept Edits',
    available: false,
    requiresExplicitConsent: false,
    ceiling: 'workspace_write',
    detail: 'The standalone Host has not yet proved the agy write-approval bridge.'
  },
  {
    postureId: 'workspace_write',
    label: 'Full WS Access',
    available: false,
    requiresExplicitConsent: true,
    ceiling: 'workspace_write',
    detail: 'The standalone Host has not yet proved the agy write-approval bridge.'
  },
  {
    postureId: 'full_access',
    label: 'Full Access (YOLO)',
    available: false,
    requiresExplicitConsent: true,
    ceiling: 'full_access',
    detail: 'The official agy lane remains sandboxed; unrestricted Full Access is unavailable.'
  }
]

export interface HostStandaloneAntigravityConsent {
  readonly accepted: boolean
  readonly acceptedAt: number | null
  readonly status: 'accepted' | 'missing' | 'invalid'
}

export interface HostStandaloneAgyModel {
  readonly id: string
  readonly label: string
}

export interface HostStandaloneAgyResolvedBinary {
  readonly binaryPath: string | null
  readonly error?: string
}

export interface HostStandaloneAgyCaptureResult {
  readonly stdout: string
  readonly stderr: string
  readonly code: number | null
  readonly timedOut?: boolean
  readonly error?: string
}

export interface HostStandaloneAntigravityAdmission {
  readonly providerId: typeof ANTIGRAVITY_PROVIDER_ID
  readonly consentAcceptedAt: number
  readonly binaryPath: string
  readonly models: readonly HostStandaloneAgyModel[]
  readonly offers: HostProviderOffersProjection
}

export type HostStandaloneAntigravityProbe =
  | {
      readonly status: 'ready'
      readonly admission: HostStandaloneAntigravityAdmission
      readonly detail: string
    }
  | {
      readonly status: 'consent_required' | 'unavailable' | 'auth_required'
      readonly admission: null
      readonly detail: string
    }

export interface DiscoverHostStandaloneAntigravityInput {
  readonly profilePath: string
  readonly resolveBinary: () =>
    | HostStandaloneAgyResolvedBinary
    | Promise<HostStandaloneAgyResolvedBinary>
  readonly capture: (
    command: string,
    args: readonly string[],
    options: { readonly env: Record<string, string>; readonly timeoutMs: number }
  ) => HostStandaloneAgyCaptureResult | Promise<HostStandaloneAgyCaptureResult>
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly timeoutMs?: number
}

function canonicalProfilePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4_096 &&
    value.trim() === value &&
    isAbsolute(value) &&
    resolve(value) === value &&
    value !== parse(value).root &&
    !CONTROL_CHARACTERS.test(value)
  )
}

function acceptedAt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Bounded, no-follow read of the existing profile's AntiGravity consent bits.
 * No other setting and no secret is returned to the caller.
 */
export function readHostStandaloneAntigravityConsent(
  profilePath: string
): HostStandaloneAntigravityConsent {
  if (!canonicalProfilePath(profilePath)) {
    return { accepted: false, acceptedAt: null, status: 'invalid' }
  }
  const settingsPath = join(profilePath, HOST_ANTIGRAVITY_SETTINGS_FILENAME)
  let descriptor: number | null = null
  try {
    const before = lstatSync(settingsPath)
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_SETTINGS_BYTES) {
      return { accepted: false, acceptedAt: null, status: 'invalid' }
    }
    descriptor = openSync(
      settingsPath,
      constants.O_RDONLY | ((constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0)
    )
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_SETTINGS_BYTES) {
      return { accepted: false, acceptedAt: null, status: 'invalid' }
    }
    const parsed = JSON.parse(readFileSync(descriptor, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { accepted: false, acceptedAt: null, status: 'invalid' }
    }
    const settings = parsed as Record<string, unknown>
    const timestamp = acceptedAt(settings.antigravityOptInAcceptedAt)
    const accepted = isAntigravityOptInEnabled({
      antigravityEnabled: settings.antigravityEnabled === true,
      antigravityOptInAcceptedAt: timestamp
    })
    return {
      accepted,
      acceptedAt: accepted ? timestamp : null,
      status: accepted ? 'accepted' : 'missing'
    }
  } catch (error) {
    return {
      accepted: false,
      acceptedAt: null,
      status:
        (error as NodeJS.ErrnoException)?.code === 'ENOENT'
          ? ('missing' as const)
          : ('invalid' as const)
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor)
  }
}

/** Build the credential-stripped environment used only for `agy models`. */
export function hostStandaloneAgyProbeEnvironment(
  inherited: Readonly<Record<string, string | undefined>> = process.env
): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(inherited)) {
    if (typeof value !== 'string' || STRIPPED_ENV_KEYS.has(key.toUpperCase())) continue
    environment[key] = value
  }
  environment.FORCE_COLOR = '0'
  environment.NO_COLOR = '1'
  return environment
}

function clean(value: string): string {
  return value.replace(ANSI_ESCAPE, '').replace(CONTROL_CHARACTERS_GLOBAL, '').trim()
}

function model(idValue: unknown, labelValue?: unknown): HostStandaloneAgyModel | null {
  if (typeof idValue !== 'string' && typeof idValue !== 'number') return null
  const id = clean(String(idValue)).slice(0, MAX_MODEL_CHARS)
  if (!id || !SAFE_MODEL_ID.test(id)) return null
  const label =
    typeof labelValue === 'string' || typeof labelValue === 'number'
      ? clean(String(labelValue)).slice(0, MAX_MODEL_CHARS) || id
      : id
  return { id, label }
}

function appendModel(
  models: HostStandaloneAgyModel[],
  seen: Set<string>,
  candidate: HostStandaloneAgyModel | null
): void {
  if (!candidate || models.length >= MAX_MODELS) return
  const key = candidate.id.toLowerCase()
  if (seen.has(key)) return
  seen.add(key)
  models.push(candidate)
}

function parseJsonModels(value: string): HostStandaloneAgyModel[] | null {
  const text = value.trim()
  if (!text || !/^[{[]/.test(text)) return null
  try {
    const parsed = JSON.parse(text) as unknown
    const rows = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object'
        ? ((parsed as { models?: unknown; data?: unknown }).models ??
          (parsed as { data?: unknown }).data)
        : null
    if (!Array.isArray(rows)) return []
    const models: HostStandaloneAgyModel[] = []
    const seen = new Set<string>()
    for (const row of rows) {
      if (typeof row === 'string' || typeof row === 'number') {
        appendModel(models, seen, model(row))
      } else if (row && typeof row === 'object') {
        const record = row as Record<string, unknown>
        appendModel(
          models,
          seen,
          model(
            record.id ?? record.modelId ?? record.model ?? record.name,
            record.label ?? record.displayName ?? record.name
          )
        )
      }
    }
    return models
  } catch {
    return null
  }
}

function parsePlainModel(line: string): HostStandaloneAgyModel | null {
  const text = clean(line.replace(/\t+/g, '  ')).replace(/^(?:[-*•]\s*)+/, '')
  if (!text) return null
  if (
    /^(?:fetching|available\s+models?|models?|no\s+models?|not\s+(?:logged|authenticated)|please\s+(?:log|sign)|authenticate|error|failed|usage:|warning:)/i.test(
      text
    ) ||
    /\b(?:error|failed|not\s+(?:logged|authenticated)|log\s*in|authentication\s+required)\b/i.test(
      text
    )
  ) {
    return null
  }
  const dashed = text.match(/^([A-Za-z0-9][A-Za-z0-9._:/-]*)\s+-\s+(.+)$/)
  if (dashed) return model(dashed[1], dashed[2])
  const columns = text.match(/^([A-Za-z0-9][A-Za-z0-9._:/-]*)\s{2,}(.+)$/)
  if (columns) return model(columns[1], columns[2])
  return /\b(?:gemini|claude|gpt|flash|pro)\b/i.test(text) ? model(text) : null
}

/** Parse only real model rows; errors and unauthenticated prose yield none. */
export function parseHostStandaloneAgyModels(value: string): HostStandaloneAgyModel[] {
  const structured = parseJsonModels(value)
  if (structured) return structured
  const models: HostStandaloneAgyModel[] = []
  const seen = new Set<string>()
  for (const line of value.split(/\r\n|\r|\n/)) {
    appendModel(models, seen, parsePlainModel(line))
  }
  return models
}

function reasoning(reasoningId: string): HostProviderReasoningOffer {
  return {
    reasoningId,
    label: SAFE_REASONING_LABELS[reasoningId] ?? reasoningId,
    available: true
  }
}

function offerRows(models: readonly HostStandaloneAgyModel[]): HostProviderModelOffer[] {
  const grouped = groupAntigravityModelRows(models)
  let defaultAssigned = false
  return grouped.map((row) => {
    const variantEfforts = row.antigravityVariants?.map((variant) => variant.effort) ?? []
    const fixedEffort = antigravityEffortForModelId(row.id)
    const effortIds =
      variantEfforts.length > 0
        ? ANTIGRAVITY_EFFORT_ORDER.filter((effort) => variantEfforts.includes(effort))
        : fixedEffort
          ? [fixedEffort]
          : []
    const preferred =
      row.label.toLowerCase() === 'gemini 3.7 flash' || row.id.toLowerCase() === 'flash-3.7'
    const isDefault = preferred && !defaultAssigned
    if (isDefault) defaultAssigned = true
    return {
      modelId: row.id,
      label: row.label,
      available: true,
      ...(isDefault ? { default: true } : {}),
      reasoning: effortIds.map(reasoning),
      detail: 'Official agy CLI · live authenticated discovery'
    }
  })
}

/** Exact dynamic offers derived only from a successful live probe. */
export function hostStandaloneAntigravityOffers(
  models: readonly HostStandaloneAgyModel[]
): HostProviderOffersProjection {
  const projectedModels = offerRows(models)
  if (projectedModels.length > 0 && !projectedModels.some((entry) => entry.default)) {
    projectedModels[0] = { ...projectedModels[0], default: true }
  }
  const postures = ANTIGRAVITY_POSTURES.map((posture) => ({ ...posture }))
  const offerRevision = createHash('sha256')
    .update(JSON.stringify({ models: projectedModels, postures }))
    .digest('hex')
  return {
    providerId: ANTIGRAVITY_PROVIDER_ID,
    offerRevision,
    models: projectedModels,
    postures
  }
}

function canonicalBinaryPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4_096 &&
    value.trim() === value &&
    isAbsolute(value) &&
    resolve(value) === value &&
    value !== parse(value).root &&
    !CONTROL_CHARACTERS.test(value)
  )
}

/**
 * Resolve conditional standalone admission. Consent is checked before any
 * process action, and only a current successful nonempty `agy models` probe
 * produces an admission object.
 */
export async function discoverHostStandaloneAntigravity(
  input: DiscoverHostStandaloneAntigravityInput
): Promise<HostStandaloneAntigravityProbe> {
  const consent = readHostStandaloneAntigravityConsent(input.profilePath)
  if (!consent.accepted || consent.acceptedAt === null) {
    return {
      status: 'consent_required',
      admission: null,
      detail: 'Accept the AntiGravity account/ToS ban-risk disclosure in TaskWraith first.'
    }
  }
  let binary: HostStandaloneAgyResolvedBinary
  try {
    binary = await input.resolveBinary()
  } catch {
    return {
      status: 'unavailable',
      admission: null,
      detail: 'The official agy CLI could not be resolved.'
    }
  }
  if (!canonicalBinaryPath(binary.binaryPath)) {
    return {
      status: 'unavailable',
      admission: null,
      detail: 'The official agy CLI is not installed or its path is invalid.'
    }
  }
  let captured: HostStandaloneAgyCaptureResult
  try {
    captured = await input.capture(binary.binaryPath, HOST_AGY_MODEL_DISCOVERY_ARGS, {
      env: hostStandaloneAgyProbeEnvironment(input.env),
      timeoutMs: input.timeoutMs ?? 8_000
    })
  } catch {
    return {
      status: 'auth_required',
      admission: null,
      detail: 'A live agy account could not be verified; sign in and retry.'
    }
  }
  if (
    Buffer.byteLength(captured.stdout || '', 'utf8') +
      Buffer.byteLength(captured.stderr || '', 'utf8') >
    MAX_PROBE_OUTPUT_BYTES
  ) {
    return {
      status: 'auth_required',
      admission: null,
      detail: 'The agy account probe exceeded its bounded output limit.'
    }
  }
  if (captured.error || captured.timedOut || captured.code !== 0) {
    return {
      status: 'auth_required',
      admission: null,
      detail: 'A live agy account could not be verified; sign in and retry.'
    }
  }
  const models = parseHostStandaloneAgyModels(captured.stdout || captured.stderr || '')
  if (models.length === 0) {
    return {
      status: 'auth_required',
      admission: null,
      detail: 'agy returned no live authenticated models; sign in and retry.'
    }
  }
  return {
    status: 'ready',
    admission: {
      providerId: ANTIGRAVITY_PROVIDER_ID,
      consentAcceptedAt: consent.acceptedAt,
      binaryPath: binary.binaryPath,
      models,
      offers: hostStandaloneAntigravityOffers(models)
    },
    detail: 'AntiGravity consent and live agy account were verified.'
  }
}
