import {
  WebSessionCookieStore,
  type WebSessionMutationResult,
  type WebSessionSafeStorage,
  type WebSessionStatus,
  type WebSessionStoreIdentity
} from './WebSessionCookieStore'
import type {
  UsageWebSessionProviderId,
  UsageWebSessionReading
} from '../../shared/usageWebSession'

export interface StoredUsageWebSession {
  cookieHeader: string
  reading: UsageWebSessionReading
}

const IDENTITIES: Record<UsageWebSessionProviderId, WebSessionStoreIdentity> = {
  meta: {
    filename: 'meta-usage-web-session.json',
    secretPurpose: 'taskwraith:meta-usage-web-session:v1',
    envelopePurpose: 'taskwraith:meta-usage-web-session-envelope:v1',
    providerLabel: 'Meta'
  },
  muse: {
    filename: 'muse-subscription-web-session.json',
    secretPurpose: 'taskwraith:muse-subscription-web-session:v1',
    envelopePurpose: 'taskwraith:muse-subscription-web-session-envelope:v1',
    providerLabel: 'Meta Muse Code'
  },
  cerebras: {
    filename: 'cerebras-usage-web-session.json',
    secretPurpose: 'taskwraith:cerebras-usage-web-session:v1',
    envelopePurpose: 'taskwraith:cerebras-usage-web-session-envelope:v1',
    providerLabel: 'Cerebras'
  },
  qwen: {
    filename: 'qwen-token-plan-web-session.json',
    secretPurpose: 'taskwraith:qwen-token-plan-web-session:v1',
    envelopePurpose: 'taskwraith:qwen-token-plan-web-session-envelope:v1',
    providerLabel: 'Qwen'
  },
  mimo: {
    filename: 'mimo-token-plan-web-session.json',
    secretPurpose: 'taskwraith:mimo-token-plan-web-session:v1',
    envelopePurpose: 'taskwraith:mimo-token-plan-web-session-envelope:v1',
    providerLabel: 'Xiaomi MiMo'
  }
}

function canonicalReading(value: unknown): UsageWebSessionReading | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  const capturedAt = typeof input.capturedAt === 'string' ? input.capturedAt.trim() : ''
  if (!capturedAt || Number.isNaN(Date.parse(capturedAt))) return null
  const number = (candidate: unknown): number | undefined =>
    typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0
      ? candidate
      : undefined
  const string = (candidate: unknown): string | undefined =>
    typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined
  const quotaUsedPercent = number(input.quotaUsedPercent)
  const currentUsedPercent = number(input.currentUsedPercent)
  const weeklyUsedPercent = number(input.weeklyUsedPercent)
  const remainingDays = number(input.remainingDays)
  const resetAt = string(input.resetAt)
  return {
    ...(number(input.balance) !== undefined ? { balance: number(input.balance) } : {}),
    ...(number(input.spend) !== undefined ? { spend: number(input.spend) } : {}),
    ...(string(input.currency) ? { currency: string(input.currency) } : {}),
    ...(quotaUsedPercent !== undefined && quotaUsedPercent <= 100 ? { quotaUsedPercent } : {}),
    ...(currentUsedPercent !== undefined && currentUsedPercent <= 100
      ? { currentUsedPercent }
      : {}),
    ...(weeklyUsedPercent !== undefined && weeklyUsedPercent <= 100 ? { weeklyUsedPercent } : {}),
    ...(string(input.planName) ? { planName: string(input.planName) } : {}),
    ...(remainingDays !== undefined && Number.isInteger(remainingDays) ? { remainingDays } : {}),
    ...(resetAt && !Number.isNaN(Date.parse(resetAt))
      ? { resetAt: new Date(resetAt).toISOString() }
      : {}),
    capturedAt: new Date(capturedAt).toISOString()
  }
}

function serializeSession(session: StoredUsageWebSession): string | null {
  const cookieHeader = String(session.cookieHeader || '').trim()
  const reading = canonicalReading(session.reading)
  if (!cookieHeader || !reading) return null
  return JSON.stringify({ schemaVersion: 1, cookieHeader, reading })
}

function parseSession(value: string): StoredUsageWebSession | null {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const envelope = parsed as Record<string, unknown>
    if (envelope.schemaVersion !== 1 || typeof envelope.cookieHeader !== 'string') return null
    const cookieHeader = envelope.cookieHeader.trim()
    const reading = canonicalReading(envelope.reading)
    return cookieHeader && reading ? { cookieHeader, reading } : null
  } catch {
    return null
  }
}

export class UsageWebSessionStore {
  constructor(private readonly store: WebSessionCookieStore) {}

  getStatus(): WebSessionStatus {
    return this.store.getStatus()
  }

  setSession(session: StoredUsageWebSession): WebSessionMutationResult {
    const serialized = serializeSession(session)
    return serialized
      ? this.store.setCookie(serialized)
      : { ok: false, error: 'invalidCookie', status: this.store.getStatus() }
  }

  loadSession(): StoredUsageWebSession | null {
    const loaded = this.store.loadCookie()
    return loaded.status === 'ok' ? parseSession(loaded.value) : null
  }

  clear(): WebSessionMutationResult {
    return this.store.clear()
  }
}

let stores: Partial<Record<UsageWebSessionProviderId, UsageWebSessionStore>> = {}

export function configureUsageWebSessionStores(options: {
  userDataPath: string
  safeStorage: WebSessionSafeStorage
}): void {
  stores = Object.fromEntries(
    (Object.keys(IDENTITIES) as UsageWebSessionProviderId[]).map((provider) => [
      provider,
      new UsageWebSessionStore(
        new WebSessionCookieStore({
          identity: IDENTITIES[provider],
          userDataPath: options.userDataPath,
          safeStorage: options.safeStorage
        })
      )
    ])
  )
}

export function usageWebSessionStore(
  provider: UsageWebSessionProviderId
): UsageWebSessionStore | null {
  return stores[provider] ?? null
}
