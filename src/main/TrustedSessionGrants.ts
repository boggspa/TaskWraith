import type { ProviderId } from './store/types'

export interface TrustedSessionScope {
  chatId: string
  provider: ProviderId
  workspacePath?: string | null
  ensembleParticipantId?: string | null
  ensembleLaneId?: string | null
  runtimeProfileId?: string | null
}

export interface TrustedSessionGrant extends TrustedSessionScope {
  grantedAt: string
}

export interface TrustedSessionSetResult {
  enabled: boolean
  grant?: TrustedSessionGrant
  error?: string
}

function clean(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizePath(value: string | null | undefined): string {
  return clean(value).replace(/\/+$/, '')
}

function normalizeScope(scope: TrustedSessionScope): TrustedSessionScope {
  return {
    chatId: clean(scope.chatId),
    provider: scope.provider,
    workspacePath: normalizePath(scope.workspacePath),
    ensembleParticipantId: clean(scope.ensembleParticipantId),
    ensembleLaneId: clean(scope.ensembleLaneId),
    runtimeProfileId: clean(scope.runtimeProfileId)
  }
}

function sameBase(a: TrustedSessionScope, b: TrustedSessionScope): boolean {
  return (
    a.chatId === b.chatId &&
    a.provider === b.provider &&
    normalizePath(a.workspacePath) === normalizePath(b.workspacePath) &&
    clean(a.ensembleParticipantId) === clean(b.ensembleParticipantId) &&
    clean(a.runtimeProfileId) === clean(b.runtimeProfileId)
  )
}

function grantMatches(grant: TrustedSessionGrant, scope: TrustedSessionScope): boolean {
  const normalized = normalizeScope(scope)
  if (!sameBase(grant, normalized)) return false
  const grantLaneId = clean(grant.ensembleLaneId)
  const scopeLaneId = clean(normalized.ensembleLaneId)
  return !grantLaneId || grantLaneId === scopeLaneId
}

export class TrustedSessionGrantStore {
  private grants = new Map<string, TrustedSessionGrant>()

  constructor(private readonly nowIso: () => string = () => new Date().toISOString()) {}

  grant(scope: TrustedSessionScope): TrustedSessionSetResult {
    const normalized = normalizeScope(scope)
    if (!normalized.chatId) {
      return { enabled: false, error: 'Trusted Session needs a chat id.' }
    }
    if (!normalized.provider) {
      return { enabled: false, error: 'Trusted Session needs a provider.' }
    }
    const grant: TrustedSessionGrant = {
      ...normalized,
      grantedAt: this.nowIso()
    }
    this.grants.set(this.keyFor(normalized), grant)
    return { enabled: true, grant }
  }

  revoke(scope: TrustedSessionScope): TrustedSessionSetResult {
    const normalized = normalizeScope(scope)
    for (const [key, grant] of this.grants.entries()) {
      if (sameBase(grant, normalized)) {
        this.grants.delete(key)
      }
    }
    return { enabled: false }
  }

  isGranted(scope: TrustedSessionScope): boolean {
    for (const grant of this.grants.values()) {
      if (grantMatches(grant, scope)) return true
    }
    return false
  }

  get(scope: TrustedSessionScope): TrustedSessionSetResult {
    for (const grant of this.grants.values()) {
      if (grantMatches(grant, scope)) return { enabled: true, grant }
    }
    return { enabled: false }
  }

  clear(): void {
    this.grants.clear()
  }

  snapshot(): TrustedSessionGrant[] {
    return [...this.grants.values()].map((grant) => ({ ...grant }))
  }

  private keyFor(scope: TrustedSessionScope): string {
    return [
      scope.chatId,
      scope.provider,
      normalizePath(scope.workspacePath),
      clean(scope.ensembleParticipantId),
      clean(scope.ensembleLaneId),
      clean(scope.runtimeProfileId)
    ].join('\0')
  }
}
