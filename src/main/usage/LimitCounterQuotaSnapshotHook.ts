import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  QUOTA_SNAPSHOT_HOOK_PROVIDER_IDS,
  QUOTA_SNAPSHOT_HOOK_STALE_AFTER_MS,
  type QuotaSnapshotHookBalance,
  type QuotaSnapshotHookProviderId,
  type QuotaSnapshotHookSnapshot,
  type QuotaSnapshotHookWindow
} from '../../shared/quotaSnapshotHook'

const LIMIT_COUNTER_APP_GROUP = 'group.com.chrisizatt.LLMUsageCounter'
const LIMIT_COUNTER_SNAPSHOT_KEY = 'cachedQuotaSnapshots'
const PLUTIL_PATH = '/usr/bin/plutil'
const MAX_PLUTIL_OUTPUT_BYTES = 12 * 1024 * 1024
const MAX_DECODED_SNAPSHOT_BYTES = 8 * 1024 * 1024
const MAX_SNAPSHOTS = 64
const MAX_WINDOWS_PER_PROVIDER = 12
const MAX_BALANCES_PER_PROVIDER = 16
const MAX_TEXT_LENGTH = 160
const MAX_METRIC_VALUE = 1_000_000_000_000_000
const PROVIDER_ORDER = new Map(
  QUOTA_SNAPSHOT_HOOK_PROVIDER_IDS.map((provider, index) => [provider, index])
)
const PROVIDER_IDS = new Set<string>(QUOTA_SNAPSHOT_HOOK_PROVIDER_IDS)
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export interface LimitCounterQuotaSnapshotHookDependencies {
  platform?: NodeJS.Platform
  homeDirectory?: string
  now?: () => number
  runPlutil?: (plistPath: string) => Promise<string>
}

export function limitCounterQuotaSnapshotPlistPath(homeDirectory = homedir()): string {
  return join(
    homeDirectory,
    'Library',
    'Group Containers',
    LIMIT_COUNTER_APP_GROUP,
    'Library',
    'Preferences',
    `${LIMIT_COUNTER_APP_GROUP}.plist`
  )
}

function runPlutil(plistPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      PLUTIL_PATH,
      ['-extract', LIMIT_COUNTER_SNAPSHOT_KEY, 'raw', '-o', '-', plistPath],
      {
        encoding: 'utf8',
        maxBuffer: MAX_PLUTIL_OUTPUT_BYTES,
        timeout: 3_000,
        windowsHide: true
      },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(stdout)
      }
    )
  })
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function safeText(value: unknown, maximumLength = MAX_TEXT_LENGTH): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized || normalized.length > maximumLength) return undefined
  for (const character of normalized) {
    const codePoint = character.codePointAt(0) ?? 0
    if (
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      return undefined
    }
  }
  return normalized
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined
  if (typeof value === 'string' && !value.trim()) return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && Math.abs(parsed) <= MAX_METRIC_VALUE ? parsed : undefined
}

function canonicalIsoDate(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 64) return undefined
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return undefined
  return new Date(parsed).toISOString()
}

function compactNumber(value: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  })
}

function isCurrencyUnit(unit: string): boolean {
  return unit === 'USD' || unit === 'GBP' || unit === 'EUR'
}

function formatMetric(value: number, unit: string): string {
  if (unit === 'USD') return `$${value.toFixed(2)}`
  if (unit === 'GBP') return `£${value.toFixed(2)}`
  if (unit === 'EUR') return `€${value.toFixed(2)}`
  if (unit === '%') return `${compactNumber(value)}%`
  return unit ? `${compactNumber(value)} ${unit}` : compactNumber(value)
}

function inferredWindowSeconds(windowKind: string | undefined, label: string): number | undefined {
  const descriptor = `${windowKind || ''} ${label}`.toLowerCase()
  if (descriptor.includes('5h') || descriptor.includes('5-hour')) return 5 * 60 * 60
  if (descriptor.includes('weekly')) return 7 * 24 * 60 * 60
  if (descriptor.includes('monthly')) return 30 * 24 * 60 * 60
  return undefined
}

function parseWindow(value: unknown, index: number): QuotaSnapshotHookWindow | null {
  const raw = record(value)
  if (!raw) return null
  const label = safeText(raw.label)
  const used = finiteNumber(raw.used)
  if (!label || used === undefined || used < 0) return null
  const totalCandidate = finiteNumber(raw.total)
  const total = totalCandidate !== undefined && totalCandidate > 0 ? totalCandidate : undefined
  const unit = safeText(raw.unit, 24) || ''
  const subtitle = safeText(raw.subtitle)
  const usedPercent = total === undefined ? 0 : Math.max(0, Math.min(100, (used / total) * 100))
  const remainingPercent = Math.max(0, Math.min(100, 100 - usedPercent))
  const valueText = formatMetric(used, unit)
  const limitLabel =
    unit === '%' && subtitle
      ? subtitle
      : total !== undefined
        ? `${valueText} of ${formatMetric(total, unit)}`
        : subtitle || valueText
  const id = safeText(raw.id, 96) || `hook-window-${index}`
  const resetAt = canonicalIsoDate(raw.resetDate)
  const windowKind = safeText(raw.windowKind, 32)
  const limitWindowSeconds = inferredWindowSeconds(windowKind, label)
  return {
    id,
    label,
    usedPercent,
    remainingPercent,
    limitLabel,
    ...(isCurrencyUnit(unit) ? { valueText } : {}),
    ...(resetAt ? { resetAt } : {}),
    ...(unit ? { unit } : {}),
    ...(windowKind ? { windowKind } : {}),
    ...(limitWindowSeconds ? { limitWindowSeconds } : {})
  }
}

function parseBalance(value: unknown, index: number): QuotaSnapshotHookBalance | null {
  const raw = record(value)
  if (!raw) return null
  const label = safeText(raw.label)
  const amount = finiteNumber(raw.amount)
  if (!label || amount === undefined || amount < 0) return null
  const unit = safeText(raw.unit, 24) || ''
  const id = safeText(raw.id, 96) || `hook-balance-${index}`
  const subtitle = safeText(raw.subtitle)
  const resetAt = canonicalIsoDate(raw.resetDate)
  return {
    id,
    label,
    amount,
    unit,
    ...(subtitle ? { subtitle } : {}),
    ...(resetAt ? { resetAt } : {})
  }
}

function parseProviderId(value: unknown): QuotaSnapshotHookProviderId | null {
  return typeof value === 'string' && PROVIDER_IDS.has(value)
    ? (value as QuotaSnapshotHookProviderId)
    : null
}

function parseSnapshot(value: unknown, now: number): QuotaSnapshotHookSnapshot | null {
  const raw = record(value)
  if (!raw) return null
  const provider = parseProviderId(raw.providerID)
  const fetchedAt = canonicalIsoDate(raw.fetchedAt)
  if (!provider || !fetchedAt) return null
  if (raw.fetchState !== undefined && raw.fetchState !== 'success') return null
  const windows = (Array.isArray(raw.windows) ? raw.windows : [])
    .slice(0, MAX_WINDOWS_PER_PROVIDER)
    .map(parseWindow)
    .filter((window): window is QuotaSnapshotHookWindow => Boolean(window))
  const balances = (Array.isArray(raw.balances) ? raw.balances : [])
    .slice(0, MAX_BALANCES_PER_PROVIDER)
    .map(parseBalance)
    .filter((balance): balance is QuotaSnapshotHookBalance => Boolean(balance))
  if (windows.length === 0 && balances.length === 0) return null
  const fetchedAtMs = Date.parse(fetchedAt)
  const planType = safeText(raw.planName, 96)
  return {
    provider,
    source: 'limit-counter-sanitized-cache',
    configured: true,
    fetchedAt,
    stale:
      fetchedAtMs > now + 5 * 60 * 1000 || now - fetchedAtMs > QUOTA_SNAPSHOT_HOOK_STALE_AFTER_MS,
    ...(planType ? { planType } : {}),
    windows,
    balances
  }
}

/**
 * Decode Limit Counter's credential-free cached snapshot value and project an
 * allowlisted display-only subset. Unknown fields are ignored, so even a
 * future helper accidentally adding a secret-shaped field cannot cross IPC.
 */
export function parseLimitCounterQuotaSnapshotHook(
  encoded: string,
  now = Date.now()
): QuotaSnapshotHookSnapshot[] {
  const compact = String(encoded || '').replace(/\s+/g, '')
  if (!compact || compact.length > MAX_PLUTIL_OUTPUT_BYTES || !CANONICAL_BASE64.test(compact)) {
    return []
  }
  const decoded = Buffer.from(compact, 'base64')
  if (decoded.length === 0 || decoded.length > MAX_DECODED_SNAPSHOT_BYTES) return []
  if (decoded.toString('base64') !== compact) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(decoded.toString('utf8'))
  } catch {
    return []
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_SNAPSHOTS) return []
  const byProvider = new Map<QuotaSnapshotHookProviderId, QuotaSnapshotHookSnapshot>()
  for (const candidate of parsed) {
    const snapshot = parseSnapshot(candidate, now)
    if (!snapshot) continue
    const previous = byProvider.get(snapshot.provider)
    if (!previous || Date.parse(snapshot.fetchedAt) > Date.parse(previous.fetchedAt)) {
      byProvider.set(snapshot.provider, snapshot)
    }
  }
  return [...byProvider.values()].sort(
    (left, right) =>
      (PROVIDER_ORDER.get(left.provider) ?? Number.MAX_SAFE_INTEGER) -
      (PROVIDER_ORDER.get(right.provider) ?? Number.MAX_SAFE_INTEGER)
  )
}

export async function fetchLimitCounterQuotaSnapshotHook(
  dependencies: LimitCounterQuotaSnapshotHookDependencies = {}
): Promise<QuotaSnapshotHookSnapshot[]> {
  if ((dependencies.platform ?? process.platform) !== 'darwin') return []
  const plistPath = limitCounterQuotaSnapshotPlistPath(dependencies.homeDirectory ?? homedir())
  try {
    const encoded = await (dependencies.runPlutil ?? runPlutil)(plistPath)
    return parseLimitCounterQuotaSnapshotHook(encoded, dependencies.now?.() ?? Date.now())
  } catch {
    return []
  }
}
