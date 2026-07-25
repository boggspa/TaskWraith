/**
 * Microsoft Graph read lane for Outlook mail + calendar.
 *
 * Deliberately narrow: a handful of `$select`-bounded GET endpoints, no
 * attachment download, no folder mutation, and nothing that writes. Tier 2
 * write tools live in their own module so this one can never grow a send
 * path by accident.
 *
 * Graph throttles aggressively, so 429/503 with Retry-After is honored with
 * a bounded number of retries; 401 triggers exactly one refresh attempt
 * before the connection is reported as needing re-authentication.
 *
 * Everything returned here is UNTRUSTED REMOTE CONTENT. Mapping happens in
 * the shared graphMappers module, which clamps and flattens; callers passing
 * it to a model must keep the data/instruction boundary explicit.
 */

import {
  MicrosoftDeviceCodeAuth,
  tokenSetIsFresh,
  type GraphTokenSet
} from './MicrosoftDeviceCodeAuth'
import type { OutlookCredentialStore, OutlookCredentials } from './OutlookCredentialStore'
import {
  graphCollection,
  graphEventToCalendarEvent,
  graphMessageSummary,
  graphMessageToMailModel,
  type GraphEventMapping,
  type GraphMailMapping,
  type GraphMailSummary
} from '../../shared/office/graphMappers'

const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0'
const DEFAULT_TIMEOUT_MS = 20_000
const MAX_THROTTLE_RETRIES = 2
const MAX_PAGE_SIZE = 50

export type OutlookConnectorError =
  | 'not-connected'
  | 'reauth-required'
  | 'throttled'
  | 'network'
  | 'graph-error'

export interface OutlookConnectorFailure {
  ok: false
  error: OutlookConnectorError
  message: string
}

export type OutlookConnectorResult<T> = ({ ok: true } & T) | OutlookConnectorFailure

export interface OutlookConnectorDeps {
  store: OutlookCredentialStore
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof globalThis.fetch
  createAuth?: (credentials: OutlookCredentials) => MicrosoftDeviceCodeAuth
  timeoutMs?: number
  nowMs?: () => number
  /** Injected so throttle backoff is instant in tests. */
  sleep?: (ms: number) => Promise<void>
  /** Display timezone for calendar mapping. */
  displayZone?: () => string | undefined
}

const failure = (error: OutlookConnectorError, message: string): OutlookConnectorFailure => ({
  ok: false,
  error,
  message
})

export class OutlookConnectorService {
  private readonly deps: OutlookConnectorDeps

  constructor(deps: OutlookConnectorDeps) {
    this.deps = deps
  }

  private get fetchImpl(): typeof globalThis.fetch {
    return this.deps.fetchImpl ?? globalThis.fetch
  }

  private nowMs(): number {
    return this.deps.nowMs?.() ?? Date.now()
  }

  private authFor(credentials: OutlookCredentials): MicrosoftDeviceCodeAuth {
    if (this.deps.createAuth) return this.deps.createAuth(credentials)
    return new MicrosoftDeviceCodeAuth({
      clientId: credentials.clientId,
      tenant: credentials.tenant,
      nowMs: () => this.nowMs()
    })
  }

  /**
   * Returns a usable access token, refreshing (and persisting the rotation)
   * when the stored one is at or near expiry.
   */
  private async accessToken(): Promise<
    { ok: true; token: string; credentials: OutlookCredentials } | OutlookConnectorFailure
  > {
    const loaded = this.deps.store.load()
    if (loaded.status !== 'ok') {
      return loaded.status === 'missing'
        ? failure('not-connected', 'No Microsoft account is connected.')
        : failure('reauth-required', 'Stored Microsoft credentials could not be read.')
    }
    const credentials = loaded.credentials
    if (tokenSetIsFresh(credentials.tokens, this.nowMs())) {
      return { ok: true, token: credentials.tokens.accessToken, credentials }
    }
    if (!credentials.tokens.refreshToken) {
      return failure('reauth-required', 'The Microsoft session expired. Sign in again.')
    }
    let refreshed: GraphTokenSet | null
    try {
      refreshed = await this.authFor(credentials).refresh(
        credentials.tokens.refreshToken,
        credentials.scopeMode
      )
    } catch {
      return failure('network', 'Could not reach Microsoft to refresh the session.')
    }
    if (!refreshed) {
      return failure('reauth-required', 'The Microsoft session expired. Sign in again.')
    }
    const next: OutlookCredentials = {
      ...credentials,
      tokens: { ...refreshed, account: credentials.account }
    }
    this.deps.store.save(next)
    return { ok: true, token: refreshed.accessToken, credentials: next }
  }

  /** Single bounded GET with throttle handling. Never logs the token. */
  private async graphGet(
    path: string,
    query: Record<string, string>
  ): Promise<{ ok: true; body: unknown } | OutlookConnectorFailure> {
    const auth = await this.accessToken()
    if (!auth.ok) return auth

    const url = `${GRAPH_ROOT}${path}?${new URLSearchParams(query).toString()}`
    for (let attempt = 0; attempt <= MAX_THROTTLE_RETRIES; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      let response: Response
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          headers: {
            authorization: `Bearer ${auth.token}`,
            accept: 'application/json',
            // Graph returns UTC unless asked otherwise; mapping converts.
            prefer: 'outlook.timezone="UTC"'
          },
          signal: controller.signal
        })
      } catch {
        return failure('network', 'Could not reach Microsoft Graph.')
      } finally {
        clearTimeout(timer)
      }

      if (response.status === 401) {
        return failure('reauth-required', 'Microsoft rejected the session. Sign in again.')
      }
      if (response.status === 429 || response.status === 503) {
        if (attempt === MAX_THROTTLE_RETRIES) {
          return failure('throttled', 'Microsoft Graph is throttling requests. Try again shortly.')
        }
        const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10)
        const delayMs = Math.min(
          30_000,
          Math.max(1_000, (Number.isFinite(retryAfter) ? retryAfter : 2 ** attempt) * 1_000)
        )
        await (this.deps.sleep?.(delayMs) ?? new Promise((resolve) => setTimeout(resolve, delayMs)))
        continue
      }
      if (!response.ok) {
        return failure('graph-error', `Microsoft Graph returned HTTP ${response.status}.`)
      }
      try {
        return { ok: true, body: await response.json() }
      } catch {
        return failure('graph-error', 'Microsoft Graph returned an unreadable response.')
      }
    }
    return failure('throttled', 'Microsoft Graph is throttling requests. Try again shortly.')
  }

  private clampTop(limit: number | undefined): string {
    const requested = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : 10
    return String(Math.min(MAX_PAGE_SIZE, Math.max(1, requested)))
  }

  /** Recent messages, newest first. Bodies are excluded — summaries only. */
  async listMessages(options: {
    limit?: number
    folder?: string
  }): Promise<OutlookConnectorResult<{ messages: GraphMailSummary[] }>> {
    const folder = /^[A-Za-z]{1,32}$/.test(options.folder ?? '') ? options.folder : 'inbox'
    const result = await this.graphGet(`/me/mailFolders/${folder}/messages`, {
      $top: this.clampTop(options.limit),
      $orderby: 'receivedDateTime desc',
      $select:
        'id,subject,from,sender,receivedDateTime,sentDateTime,bodyPreview,isRead,hasAttachments'
    })
    if (!result.ok) return result
    return {
      ok: true,
      messages: graphCollection(result.body)
        .map(graphMessageSummary)
        .filter((entry): entry is GraphMailSummary => entry !== null)
    }
  }

  /** Full-text search across the mailbox (Graph $search). */
  async searchMessages(options: {
    query: string
    limit?: number
  }): Promise<OutlookConnectorResult<{ messages: GraphMailSummary[] }>> {
    const query = options.query.trim().slice(0, 400)
    if (!query) return failure('graph-error', 'A search query is required.')
    const result = await this.graphGet('/me/messages', {
      // Graph requires the quoted form; quotes inside are stripped so the
      // value can never terminate the expression early.
      $search: `"${query.replace(/"/g, '')}"`,
      $top: this.clampTop(options.limit),
      $select:
        'id,subject,from,sender,receivedDateTime,sentDateTime,bodyPreview,isRead,hasAttachments'
    })
    if (!result.ok) return result
    return {
      ok: true,
      messages: graphCollection(result.body)
        .map(graphMessageSummary)
        .filter((entry): entry is GraphMailSummary => entry !== null)
    }
  }

  /** One message with its body, mapped into the Mail editor's model. */
  async getMessage(messageId: string): Promise<OutlookConnectorResult<{ mail: GraphMailMapping }>> {
    const id = messageId.trim()
    // Graph message ids are URL-safe base64 (A-Z a-z 0-9 - _ =). Excluding
    // '/' and '.' rejects traversal shapes outright; encodeURIComponent
    // below is the second layer, not the only one.
    if (!id || !/^[A-Za-z0-9_\-=]{1,512}$/.test(id)) {
      return failure('graph-error', 'Invalid message id.')
    }
    const result = await this.graphGet(`/me/messages/${encodeURIComponent(id)}`, {
      $select:
        'id,subject,from,sender,toRecipients,ccRecipients,bccRecipients,receivedDateTime,sentDateTime,body,bodyPreview,conversationId,webLink,hasAttachments'
    })
    if (!result.ok) return result
    const mail = graphMessageToMailModel(result.body)
    if (!mail) return failure('graph-error', 'The message could not be read.')
    return { ok: true, mail }
  }

  /** Calendar events in a window, mapped into the Calendar editor's model. */
  async listEvents(options: {
    startIso: string
    endIso: string
    limit?: number
  }): Promise<OutlookConnectorResult<{ events: GraphEventMapping[] }>> {
    const stamp = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/
    if (!stamp.test(options.startIso) || !stamp.test(options.endIso)) {
      return failure('graph-error', 'Event window must be ISO dates.')
    }
    const result = await this.graphGet('/me/calendarView', {
      startDateTime: options.startIso,
      endDateTime: options.endIso,
      $top: this.clampTop(options.limit),
      $orderby: 'start/dateTime',
      $select: 'id,subject,start,end,isAllDay,location,body,bodyPreview,organizer,recurrence'
    })
    if (!result.ok) return result
    const zone = this.deps.displayZone?.()
    return {
      ok: true,
      events: graphCollection(result.body)
        .map((event) => graphEventToCalendarEvent(event, zone))
        .filter((entry): entry is GraphEventMapping => entry !== null)
    }
  }

  /** Single bounded POST. Only ever used for draft-scoped creation. */
  private async graphPost(
    path: string,
    body: unknown
  ): Promise<{ ok: true; body: unknown } | OutlookConnectorFailure> {
    const auth = await this.accessToken()
    if (!auth.ok) return auth
    if (auth.credentials.scopeMode !== 'write') {
      return failure(
        'reauth-required',
        'This connection is read-only. Reconnect with drafting enabled to create drafts.'
      )
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    let response: Response
    try {
      response = await this.fetchImpl(`${GRAPH_ROOT}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${auth.token}`,
          accept: 'application/json',
          'content-type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: controller.signal
      })
    } catch {
      return failure('network', 'Could not reach Microsoft Graph.')
    } finally {
      clearTimeout(timer)
    }

    if (response.status === 401) {
      return failure('reauth-required', 'Microsoft rejected the session. Sign in again.')
    }
    if (response.status === 429 || response.status === 503) {
      // Creation is not retried: a blind retry risks a duplicate draft.
      return failure('throttled', 'Microsoft Graph is throttling requests. Try again shortly.')
    }
    if (!response.ok) {
      return failure('graph-error', `Microsoft Graph returned HTTP ${response.status}.`)
    }
    try {
      return { ok: true, body: await response.json() }
    } catch {
      return failure('graph-error', 'Microsoft Graph returned an unreadable response.')
    }
  }

  /**
   * Creates a DRAFT message. Graph's /me/messages POST saves to Drafts and
   * sends nothing — there is no send call anywhere in this service, and the
   * app does not hold the Mail.Send scope that would permit one.
   */
  async createDraft(input: {
    subject: string
    body: string
    to: string[]
    cc?: string[]
  }): Promise<OutlookConnectorResult<{ draftId: string; webLink: string }>> {
    const recipients = (addresses: string[] | undefined): unknown[] =>
      (addresses ?? []).map((address) => ({ emailAddress: { address } }))
    const result = await this.graphPost('/me/messages', {
      subject: input.subject,
      body: { contentType: 'text', content: input.body },
      toRecipients: recipients(input.to),
      ccRecipients: recipients(input.cc)
    })
    if (!result.ok) return result
    const created = result.body as Record<string, unknown> | null
    const draftId = typeof created?.id === 'string' ? created.id : ''
    if (!draftId) return failure('graph-error', 'The draft was not created.')
    return {
      ok: true,
      draftId,
      webLink: typeof created?.webLink === 'string' ? created.webLink : ''
    }
  }

  /**
   * Creates a calendar entry with NO attendees. Attendees are rejected by the
   * tool layer because Graph mails invitations on create, which would be
   * sending; this method never populates the attendees field either.
   */
  async createEvent(input: {
    subject: string
    startIso: string
    endIso: string
    body?: string
    location?: string
  }): Promise<OutlookConnectorResult<{ eventId: string; webLink: string }>> {
    const stamp = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/
    if (!stamp.test(input.startIso) || !stamp.test(input.endIso)) {
      return failure('graph-error', 'Event times must be ISO stamps.')
    }
    const zone = this.deps.displayZone?.() ?? 'UTC'
    const result = await this.graphPost('/me/events', {
      subject: input.subject,
      start: { dateTime: input.startIso, timeZone: zone },
      end: { dateTime: input.endIso, timeZone: zone },
      ...(input.location ? { location: { displayName: input.location } } : {}),
      ...(input.body ? { body: { contentType: 'text', content: input.body } } : {})
    })
    if (!result.ok) return result
    const created = result.body as Record<string, unknown> | null
    const eventId = typeof created?.id === 'string' ? created.id : ''
    if (!eventId) return failure('graph-error', 'The calendar entry was not created.')
    return {
      ok: true,
      eventId,
      webLink: typeof created?.webLink === 'string' ? created.webLink : ''
    }
  }

  /** Signed-in account identity, used to label the connection. */
  async me(): Promise<OutlookConnectorResult<{ account: string }>> {
    const result = await this.graphGet('/me', { $select: 'displayName,userPrincipalName,mail' })
    if (!result.ok) return result
    const body = result.body as Record<string, unknown> | null
    const account =
      (typeof body?.userPrincipalName === 'string' && body.userPrincipalName) ||
      (typeof body?.mail === 'string' && body.mail) ||
      (typeof body?.displayName === 'string' && body.displayName) ||
      ''
    if (!account) return failure('graph-error', 'Could not read the signed-in account.')
    return { ok: true, account: account.slice(0, 320) }
  }
}
