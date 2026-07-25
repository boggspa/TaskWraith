/**
 * Microsoft identity platform OAuth 2.0 device-code flow, by hand.
 *
 * Device code — not authorization-code+PKCE — on purpose: it needs no
 * loopback HTTP server (no new listening socket in the app) and no embedded
 * webview (users must never type Microsoft credentials into a surface this
 * app renders). The user signs in with their own browser, on their own
 * device, and this process only ever holds tokens.
 *
 * A PUBLIC client: `client_id` only, never a client secret, so nothing
 * secret is ever bundled. The client id is supplied by the user from their
 * own Entra app registration ("Allow public client flows" = Yes).
 *
 * Zero dependencies — global fetch and two documented endpoints. `fetchImpl`
 * is injectable so every branch is testable without network access.
 */

export const MICROSOFT_DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

/** Read-only Tier 1 scopes. `offline_access` is what yields a refresh token. */
export const GRAPH_READ_SCOPES = [
  'offline_access',
  'User.Read',
  'Mail.Read',
  'Calendars.Read'
] as const

/** Tier 2 adds send/create. Requested only when the user opts into writes. */
export const GRAPH_WRITE_SCOPES = [
  'offline_access',
  'User.Read',
  'Mail.ReadWrite',
  'Mail.Send',
  'Calendars.ReadWrite'
] as const

export type GraphScopeMode = 'read' | 'write'

export const scopesForMode = (mode: GraphScopeMode): string[] => [
  ...(mode === 'write' ? GRAPH_WRITE_SCOPES : GRAPH_READ_SCOPES)
]

export interface DeviceCodeStart {
  deviceCode: string
  /** Short code the user types into the verification page. */
  userCode: string
  /** Microsoft page the user opens (usually microsoft.com/devicelogin). */
  verificationUri: string
  /** Human message from Microsoft; shown verbatim so instructions stay accurate. */
  message: string
  expiresInSeconds: number
  pollIntervalSeconds: number
}

export interface GraphTokenSet {
  accessToken: string
  refreshToken: string | null
  /** Epoch ms after which the access token must be refreshed. */
  expiresAtMs: number
  scopes: string[]
  account: string | null
}

export type DeviceCodePollOutcome =
  | { status: 'pending' }
  | { status: 'slow-down'; nextIntervalSeconds: number }
  | { status: 'granted'; tokens: GraphTokenSet }
  | { status: 'declined' }
  | { status: 'expired' }
  | { status: 'error'; message: string }

export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }
) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
  text: () => Promise<string>
}>

export interface MicrosoftDeviceCodeAuthOptions {
  clientId: string
  /** 'common' (work + personal), 'organizations', or a tenant id. */
  tenant?: string
  fetchImpl?: FetchLike
  timeoutMs?: number
  /** Injected for deterministic expiry math in tests. */
  nowMs?: () => number
}

const DEFAULT_TIMEOUT_MS = 15_000
/** Refresh a little early so a call never races token expiry. */
const EXPIRY_SAFETY_MARGIN_MS = 120_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** Validates a tenant segment so it can never inject a different host/path. */
export function isValidTenant(tenant: string): boolean {
  return /^[A-Za-z0-9._-]{1,128}$/.test(tenant)
}

/** Validates the user-supplied client id (Entra app ids are GUIDs). */
export function isValidClientId(clientId: string): boolean {
  return /^[0-9a-fA-F-]{36}$/.test(clientId.trim())
}

export function parseTokenResponse(payload: unknown, nowMs: number): GraphTokenSet | null {
  if (!isRecord(payload)) return null
  const accessToken = str(payload.access_token)
  if (!accessToken) return null
  const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 3_600
  const scope = str(payload.scope)
  return {
    accessToken,
    refreshToken: str(payload.refresh_token) || null,
    expiresAtMs: nowMs + Math.max(60, expiresIn) * 1_000,
    scopes: scope ? scope.split(/\s+/).filter(Boolean) : [],
    account: null
  }
}

export function tokenSetIsFresh(tokens: GraphTokenSet, nowMs: number): boolean {
  return tokens.expiresAtMs - EXPIRY_SAFETY_MARGIN_MS > nowMs
}

/** Maps Microsoft's documented device-flow error codes to poll outcomes. */
export function classifyPollError(
  payload: unknown,
  intervalSeconds: number
): DeviceCodePollOutcome {
  const error = isRecord(payload) ? str(payload.error) : ''
  switch (error) {
    case 'authorization_pending':
      return { status: 'pending' }
    case 'slow_down':
      return { status: 'slow-down', nextIntervalSeconds: intervalSeconds + 5 }
    case 'authorization_declined':
      return { status: 'declined' }
    case 'expired_token':
    case 'code_expired':
      return { status: 'expired' }
    default: {
      const description = isRecord(payload) ? str(payload.error_description) : ''
      return {
        status: 'error',
        // Microsoft descriptions are multi-line with correlation ids; keep
        // the first line so the UI stays readable.
        message: (description.split('\n')[0] || error || 'Sign-in failed').slice(0, 400)
      }
    }
  }
}

export class MicrosoftDeviceCodeAuth {
  private readonly clientId: string
  private readonly tenant: string
  private readonly fetchImpl: FetchLike
  private readonly timeoutMs: number
  private readonly nowMs: () => number

  constructor(options: MicrosoftDeviceCodeAuthOptions) {
    if (!isValidClientId(options.clientId)) {
      throw new Error('A Microsoft application (client) ID is required.')
    }
    const tenant = options.tenant?.trim() || 'common'
    if (!isValidTenant(tenant)) throw new Error('Invalid Microsoft tenant.')
    this.clientId = options.clientId.trim()
    this.tenant = tenant
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.nowMs = options.nowMs ?? (() => Date.now())
  }

  private endpoint(kind: 'devicecode' | 'token'): string {
    return `https://login.microsoftonline.com/${this.tenant}/oauth2/v2.0/${kind}`
  }

  private async post(
    url: string,
    form: Record<string, string>
  ): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
        signal: controller.signal
      })
      let body: unknown = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      return { status: response.status, body }
    } finally {
      clearTimeout(timer)
    }
  }

  /** Step 1: ask Microsoft for a code the user will enter in their browser. */
  async startDeviceCode(mode: GraphScopeMode): Promise<DeviceCodeStart> {
    const { status, body } = await this.post(this.endpoint('devicecode'), {
      client_id: this.clientId,
      scope: scopesForMode(mode).join(' ')
    })
    if (!isRecord(body) || !str(body.device_code) || !str(body.user_code)) {
      const description = isRecord(body) ? str(body.error_description) : ''
      throw new Error(
        (description.split('\n')[0] || `Microsoft sign-in could not start (HTTP ${status}).`).slice(
          0,
          400
        )
      )
    }
    const interval = typeof body.interval === 'number' ? body.interval : 5
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 900
    return {
      deviceCode: str(body.device_code),
      userCode: str(body.user_code),
      verificationUri: str(body.verification_uri) || 'https://microsoft.com/devicelogin',
      message: str(body.message),
      expiresInSeconds: expiresIn,
      pollIntervalSeconds: Math.max(1, interval)
    }
  }

  /** Step 2: one poll. Callers own the sleep between polls. */
  async pollForToken(deviceCode: string, intervalSeconds: number): Promise<DeviceCodePollOutcome> {
    const { body } = await this.post(this.endpoint('token'), {
      grant_type: MICROSOFT_DEVICE_CODE_GRANT,
      client_id: this.clientId,
      device_code: deviceCode
    })
    const tokens = parseTokenResponse(body, this.nowMs())
    if (tokens) return { status: 'granted', tokens }
    return classifyPollError(body, intervalSeconds)
  }

  /** Exchanges a refresh token for a fresh access token. */
  async refresh(refreshToken: string, mode: GraphScopeMode): Promise<GraphTokenSet | null> {
    const { body } = await this.post(this.endpoint('token'), {
      grant_type: 'refresh_token',
      client_id: this.clientId,
      refresh_token: refreshToken,
      scope: scopesForMode(mode).join(' ')
    })
    const tokens = parseTokenResponse(body, this.nowMs())
    if (!tokens) return null
    // Microsoft may omit a rotated refresh token; keep using the old one.
    return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken }
  }
}
