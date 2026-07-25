import { describe, expect, it, vi } from 'vitest'
import { OutlookConnectorService } from './OutlookConnectorService'
import type { OutlookCredentialStore, OutlookCredentials } from './OutlookCredentialStore'

const NOW = 1_800_000_000_000

const CREDENTIALS: OutlookCredentials = {
  clientId: '11111111-2222-3333-4444-555555555555',
  tenant: 'common',
  scopeMode: 'read',
  account: 'alice@example.com',
  tokens: {
    accessToken: 'ACCESS',
    refreshToken: 'REFRESH',
    expiresAtMs: NOW + 3_600_000,
    scopes: ['Mail.Read'],
    account: 'alice@example.com'
  }
}

interface StubResponse {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

function stubStore(
  credentials: OutlookCredentials | null,
  status: 'ok' | 'missing' | 'corrupt' = credentials ? 'ok' : 'missing'
): { store: OutlookCredentialStore; saved: OutlookCredentials[] } {
  const saved: OutlookCredentials[] = []
  const store = {
    load: () => (status === 'ok' && credentials ? { status, credentials } : { status }),
    save: (next: OutlookCredentials) => {
      saved.push(next)
      return { ok: true, status: { connected: true, encryptionAvailable: true } }
    }
  } as unknown as OutlookCredentialStore
  return { store, saved }
}

function stubFetch(responses: StubResponse[]): {
  fetchImpl: typeof globalThis.fetch
  calls: { url: string; headers: Record<string, string> }[]
} {
  const calls: { url: string; headers: Record<string, string> }[] = []
  let index = 0
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: (init.headers ?? {}) as Record<string, string> })
    const next = responses[Math.min(index, responses.length - 1)]
    index += 1
    const status = next.status ?? 200
    return {
      ok: status < 400,
      status,
      headers: { get: (name: string) => next.headers?.[name.toLowerCase()] ?? null },
      json: async () => next.body ?? {}
    }
  }) as unknown as typeof globalThis.fetch
  return { fetchImpl, calls }
}

const MESSAGE_PAGE = {
  value: [
    {
      id: 'msg-1',
      subject: 'Q3 planning',
      from: { emailAddress: { name: 'Alice', address: 'alice@example.com' } },
      receivedDateTime: '2026-08-01T09:30:00Z',
      bodyPreview: 'Kickoff Monday',
      isRead: false,
      hasAttachments: false
    },
    { id: 'msg-2', subject: 'Lunch?', receivedDateTime: '2026-08-01T08:00:00Z' }
  ]
}

describe('listMessages', () => {
  it('requests a bounded, body-free page and maps summaries', async () => {
    const { store } = stubStore(CREDENTIALS)
    const { fetchImpl, calls } = stubFetch([{ body: MESSAGE_PAGE }])
    const service = new OutlookConnectorService({ store, fetchImpl, nowMs: () => NOW })

    const result = await service.listMessages({ limit: 5 })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.messages).toHaveLength(2)
      expect(result.messages[0]).toMatchObject({ id: 'msg-1', subject: 'Q3 planning' })
    }
    expect(calls[0].url).toContain('/me/mailFolders/inbox/messages')
    expect(calls[0].url).toContain('%24top=5')
    // Full bodies are never requested by the list endpoint — only the
    // short bodyPreview Graph already returns for list views.
    const selected = (new URL(calls[0].url).searchParams.get('$select') ?? '').split(',')
    expect(selected).toContain('bodyPreview')
    expect(selected).not.toContain('body')
    expect(calls[0].headers.authorization).toBe('Bearer ACCESS')
  })

  it('clamps the page size and rejects an injected folder name', async () => {
    const { store } = stubStore(CREDENTIALS)
    const { fetchImpl, calls } = stubFetch([{ body: { value: [] } }])
    const service = new OutlookConnectorService({ store, fetchImpl, nowMs: () => NOW })
    await service.listMessages({ limit: 5_000, folder: '../../users' })
    expect(calls[0].url).toContain('%24top=50')
    expect(calls[0].url).toContain('/me/mailFolders/inbox/messages')
  })
})

describe('searchMessages', () => {
  it('quotes the search term and strips embedded quotes', async () => {
    const { store } = stubStore(CREDENTIALS)
    const { fetchImpl, calls } = stubFetch([{ body: MESSAGE_PAGE }])
    const service = new OutlookConnectorService({ store, fetchImpl, nowMs: () => NOW })
    await service.searchMessages({ query: 'budget" OR x' })
    const search = new URL(calls[0].url).searchParams.get('$search')
    expect(search).toBe('"budget OR x"')
  })

  it('requires a non-empty query', async () => {
    const { store } = stubStore(CREDENTIALS)
    const { fetchImpl } = stubFetch([{ body: {} }])
    const service = new OutlookConnectorService({ store, fetchImpl, nowMs: () => NOW })
    expect(await service.searchMessages({ query: '   ' })).toMatchObject({ ok: false })
  })
})

describe('getMessage', () => {
  it('maps a full message into the mail model', async () => {
    const { store } = stubStore(CREDENTIALS)
    const { fetchImpl } = stubFetch([
      {
        body: {
          id: 'msg-1',
          subject: 'Q3 planning',
          from: { emailAddress: { address: 'alice@example.com' } },
          toRecipients: [{ emailAddress: { address: 'bob@example.com' } }],
          body: { contentType: 'text', content: 'Body here' }
        }
      }
    ])
    const service = new OutlookConnectorService({ store, fetchImpl, nowMs: () => NOW })
    const result = await service.getMessage('msg-1')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.mail.model).toMatchObject({ kind: 'mail', body: 'Body here' })
    }
  })

  it('rejects ids that could alter the request path', async () => {
    const { store } = stubStore(CREDENTIALS)
    const { fetchImpl, calls } = stubFetch([{ body: {} }])
    const service = new OutlookConnectorService({ store, fetchImpl, nowMs: () => NOW })
    expect(await service.getMessage('../../me/messages')).toMatchObject({ ok: false })
    expect(calls).toHaveLength(0)
  })
})

describe('listEvents', () => {
  it('maps calendar view entries and validates the window', async () => {
    const { store } = stubStore(CREDENTIALS)
    const { fetchImpl, calls } = stubFetch([
      {
        body: {
          value: [
            {
              id: 'event-1',
              subject: 'Standup',
              start: { dateTime: '2026-08-01T09:00:00.0000000', timeZone: 'UTC' },
              end: { dateTime: '2026-08-01T09:15:00.0000000', timeZone: 'UTC' },
              isAllDay: false
            }
          ]
        }
      }
    ])
    const service = new OutlookConnectorService({
      store,
      fetchImpl,
      nowMs: () => NOW,
      displayZone: () => 'Europe/London'
    })
    const result = await service.listEvents({
      startIso: '2026-08-01',
      endIso: '2026-08-02'
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.events[0].event).toMatchObject({ title: 'Standup', start: '2026-08-01T10:00' })
    }
    expect(calls[0].url).toContain('/me/calendarView')

    expect(await service.listEvents({ startIso: 'yesterday', endIso: 'tomorrow' })).toMatchObject({
      ok: false
    })
  })
})

describe('authentication lifecycle', () => {
  it('reports not-connected when nothing is stored', async () => {
    const { store } = stubStore(null)
    const { fetchImpl, calls } = stubFetch([{ body: {} }])
    const service = new OutlookConnectorService({ store, fetchImpl, nowMs: () => NOW })
    expect(await service.listMessages({})).toEqual({
      ok: false,
      error: 'not-connected',
      message: 'No Microsoft account is connected.'
    })
    expect(calls).toHaveLength(0)
  })

  it('refreshes an expired token and persists the rotation', async () => {
    const expired: OutlookCredentials = {
      ...CREDENTIALS,
      tokens: { ...CREDENTIALS.tokens, expiresAtMs: NOW - 1_000 }
    }
    const { store, saved } = stubStore(expired)
    const { fetchImpl, calls } = stubFetch([{ body: MESSAGE_PAGE }])
    const refresh = vi.fn(async () => ({
      accessToken: 'FRESH',
      refreshToken: 'ROTATED',
      expiresAtMs: NOW + 3_600_000,
      scopes: ['Mail.Read'],
      account: null
    }))
    const service = new OutlookConnectorService({
      store,
      fetchImpl,
      nowMs: () => NOW,
      createAuth: () => ({ refresh }) as never
    })

    const result = await service.listMessages({})
    expect(result.ok).toBe(true)
    expect(refresh).toHaveBeenCalledWith('REFRESH', 'read')
    expect(saved[0].tokens.accessToken).toBe('FRESH')
    expect(calls[0].headers.authorization).toBe('Bearer FRESH')
  })

  it('asks for re-auth when the refresh is rejected or Graph returns 401', async () => {
    const expired: OutlookCredentials = {
      ...CREDENTIALS,
      tokens: { ...CREDENTIALS.tokens, expiresAtMs: NOW - 1_000 }
    }
    const { store } = stubStore(expired)
    const { fetchImpl } = stubFetch([{ body: {} }])
    const deadRefresh = new OutlookConnectorService({
      store,
      fetchImpl,
      nowMs: () => NOW,
      createAuth: () => ({ refresh: async () => null }) as never
    })
    expect(await deadRefresh.listMessages({})).toMatchObject({ error: 'reauth-required' })

    const { store: freshStore } = stubStore(CREDENTIALS)
    const { fetchImpl: unauthorized } = stubFetch([{ status: 401 }])
    const rejected = new OutlookConnectorService({
      store: freshStore,
      fetchImpl: unauthorized,
      nowMs: () => NOW
    })
    expect(await rejected.listMessages({})).toMatchObject({ error: 'reauth-required' })
  })
})

describe('throttling and errors', () => {
  it('honors Retry-After then succeeds', async () => {
    const { store } = stubStore(CREDENTIALS)
    const { fetchImpl, calls } = stubFetch([
      { status: 429, headers: { 'retry-after': '3' } },
      { body: MESSAGE_PAGE }
    ])
    const sleep = vi.fn(async () => undefined)
    const service = new OutlookConnectorService({ store, fetchImpl, nowMs: () => NOW, sleep })
    const result = await service.listMessages({})
    expect(result.ok).toBe(true)
    expect(sleep).toHaveBeenCalledWith(3_000)
    expect(calls).toHaveLength(2)
  })

  it('gives up with a throttled error after the retry budget', async () => {
    const { store } = stubStore(CREDENTIALS)
    const { fetchImpl, calls } = stubFetch([{ status: 429 }])
    const service = new OutlookConnectorService({
      store,
      fetchImpl,
      nowMs: () => NOW,
      sleep: async () => undefined
    })
    expect(await service.listMessages({})).toMatchObject({ error: 'throttled' })
    expect(calls).toHaveLength(3)
  })

  it('reports network and graph errors distinctly without leaking the token', async () => {
    const { store } = stubStore(CREDENTIALS)
    const failing = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof globalThis.fetch
    const offline = new OutlookConnectorService({ store, fetchImpl: failing, nowMs: () => NOW })
    const networkResult = await offline.listMessages({})
    expect(networkResult).toMatchObject({ error: 'network' })
    expect(JSON.stringify(networkResult)).not.toContain('ACCESS')

    const { fetchImpl: serverError } = stubFetch([{ status: 500 }])
    const broken = new OutlookConnectorService({
      store,
      fetchImpl: serverError,
      nowMs: () => NOW
    })
    expect(await broken.listMessages({})).toMatchObject({ error: 'graph-error' })
  })
})
