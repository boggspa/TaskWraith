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
  calls: { url: string; headers: Record<string, string>; body: string }[]
} {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = []
  let index = 0
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? init.body : ''
    })
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

/** A response whose body only settles when the request is aborted. */
function stallingFetch(): typeof globalThis.fetch {
  return (async (_url: string, init: RequestInit) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
  })) as unknown as typeof globalThis.fetch
}

/** A body stream that resolves forever with zero-length chunks. */
function emptyChunkFetch(): typeof globalThis.fetch {
  return (async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => ({ done: false, value: new Uint8Array(0) }),
        cancel: async () => {}
      })
    },
    json: async () => ({})
  })) as unknown as typeof globalThis.fetch
}

/** A response body stream that emits more bytes than the ceiling allows. */
function oversizedFetch(): typeof globalThis.fetch {
  let emitted = 0
  return (async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => {
          if (emitted >= 12_000_000) return { done: true, value: undefined }
          emitted += 1_000_000
          return { done: false, value: new Uint8Array(1_000_000) }
        },
        cancel: async () => {}
      })
    },
    json: async () => ({})
  })) as unknown as typeof globalThis.fetch
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

describe('draft-only writes', () => {
  const WRITE_CREDENTIALS = { ...CREDENTIALS, scopeMode: 'write' as const }

  it('creates a draft via /me/messages, which saves without sending', async () => {
    const { store } = stubStore(WRITE_CREDENTIALS)
    const { fetchImpl, calls } = stubFetch([
      { body: { id: 'draft-1', webLink: 'https://outlook/draft-1' } }
    ])
    const service = new OutlookConnectorService({ store, fetchImpl, nowMs: () => NOW })
    const result = await service.createDraft({
      subject: 'Weekly',
      body: 'Body',
      to: ['bob@example.com']
    })
    expect(result).toMatchObject({ ok: true, draftId: 'draft-1' })
    // /me/messages saves to Drafts; /me/sendMail would send. Assert we never
    // touch a send endpoint.
    expect(calls[0].url).toBe('https://graph.microsoft.com/v1.0/me/messages')
    expect(calls.some((call) => /sendmail|\/send/i.test(call.url))).toBe(false)
  })

  it('refuses to write on a read-only connection', async () => {
    const { store } = stubStore(CREDENTIALS)
    const { fetchImpl, calls } = stubFetch([{ body: {} }])
    const service = new OutlookConnectorService({ store, fetchImpl, nowMs: () => NOW })
    const result = await service.createDraft({ subject: 'S', body: 'B', to: [] })
    expect(result).toMatchObject({ ok: false, error: 'reauth-required' })
    expect(calls).toHaveLength(0)
  })

  it('creates a calendar entry and never populates attendees', async () => {
    const { store } = stubStore(WRITE_CREDENTIALS)
    const { fetchImpl, calls } = stubFetch([{ body: { id: 'event-1' } }])
    const service = new OutlookConnectorService({
      store,
      fetchImpl,
      nowMs: () => NOW,
      displayZone: () => 'Europe/London'
    })
    const result = await service.createEvent({
      subject: 'Focus block',
      startIso: '2026-08-01T09:00',
      endIso: '2026-08-01T10:00'
    })
    expect(result).toMatchObject({ ok: true, eventId: 'event-1' })
    expect(calls[0].url).toBe('https://graph.microsoft.com/v1.0/me/events')
    expect(calls[0].body).not.toContain('attendees')
    expect(calls[0].body).toContain('Europe/London')
  })

  it('validates event stamps before calling Graph', async () => {
    const { store } = stubStore(WRITE_CREDENTIALS)
    const { fetchImpl, calls } = stubFetch([{ body: {} }])
    const service = new OutlookConnectorService({ store, fetchImpl, nowMs: () => NOW })
    expect(
      await service.createEvent({ subject: 'x', startIso: 'soon', endIso: 'later' })
    ).toMatchObject({ ok: false })
    expect(calls).toHaveLength(0)
  })

  it('does not retry creation on throttling, to avoid duplicate drafts', async () => {
    const { store } = stubStore(WRITE_CREDENTIALS)
    const { fetchImpl, calls } = stubFetch([{ status: 429 }])
    const service = new OutlookConnectorService({
      store,
      fetchImpl,
      nowMs: () => NOW,
      sleep: async () => undefined
    })
    expect(await service.createDraft({ subject: 'S', body: 'B', to: [] })).toMatchObject({
      error: 'throttled'
    })
    expect(calls).toHaveLength(1)
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

describe('response reading', () => {
  it('keeps the timeout armed until the body has been read', async () => {
    // fetch resolves on HEADERS. A timer cleared at that point leaves the body
    // read with no deadline, so a server that stalls mid-body hangs the call
    // forever. The stub only settles when the abort fires.
    const { store } = stubStore(CREDENTIALS)
    const service = new OutlookConnectorService({
      store,
      fetchImpl: stallingFetch(),
      timeoutMs: 20,
      nowMs: () => NOW,
      sleep: async () => {}
    })
    const result = await service.listMessages({})
    expect(result).toMatchObject({ ok: false, error: 'graph-error' })
  })

  it('refuses a response body past the size ceiling', async () => {
    const { store } = stubStore(CREDENTIALS)
    const service = new OutlookConnectorService({
      store,
      fetchImpl: oversizedFetch(),
      nowMs: () => NOW,
      sleep: async () => {}
    })
    const result = await service.listMessages({})
    expect(result).toMatchObject({ ok: false, error: 'graph-error' })
  })
})

describe('pathological response bodies', () => {
  it('terminates on a stream of zero-length chunks', async () => {
    // The byte ceiling alone cannot stop this: `total` never advances and the
    // loop never yields, so the abort timer would never get to run.
    const { store } = stubStore(CREDENTIALS)
    const service = new OutlookConnectorService({
      store,
      fetchImpl: emptyChunkFetch(),
      nowMs: () => NOW,
      sleep: async () => {}
    })
    const result = await service.listMessages({})
    expect(result).toMatchObject({ ok: false, error: 'graph-error' })
  })

  it('warns that a POST may have succeeded when its response will not read', async () => {
    // Graph already returned 2xx — the draft can exist. Reporting a flat
    // failure invites a retry that creates a second one.
    const { store } = stubStore({ ...CREDENTIALS, scopeMode: 'write' })
    const service = new OutlookConnectorService({
      store,
      fetchImpl: oversizedFetch(),
      nowMs: () => NOW,
      sleep: async () => {}
    })
    const result = await service.createDraft({ subject: 'S', body: 'B', to: [] })
    expect(result).toMatchObject({ ok: false, error: 'graph-error' })
    expect((result as { message: string }).message).toContain('MAY have been created')
  })

  it('keeps a failed GET body plainly a failure', async () => {
    const { store } = stubStore(CREDENTIALS)
    const service = new OutlookConnectorService({
      store,
      fetchImpl: oversizedFetch(),
      nowMs: () => NOW,
      sleep: async () => {}
    })
    const result = await service.listMessages({})
    expect((result as { message: string }).message).not.toContain('MAY have been created')
  })
})
