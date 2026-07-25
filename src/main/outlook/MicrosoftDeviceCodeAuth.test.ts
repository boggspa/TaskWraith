import { describe, expect, it, vi } from 'vitest'
import {
  GRAPH_READ_SCOPES,
  GRAPH_WRITE_SCOPES,
  MICROSOFT_DEVICE_CODE_GRANT,
  MicrosoftDeviceCodeAuth,
  classifyPollError,
  isValidClientId,
  isValidTenant,
  parseTokenResponse,
  scopesForMode,
  tokenSetIsFresh,
  type FetchLike
} from './MicrosoftDeviceCodeAuth'

const CLIENT_ID = '11111111-2222-3333-4444-555555555555'
const NOW = 1_800_000_000_000

/** Records requests and replays queued JSON responses. */
function stubFetch(responses: { status?: number; body: unknown }[]): {
  fetchImpl: FetchLike
  calls: { url: string; form: URLSearchParams }[]
} {
  const calls: { url: string; form: URLSearchParams }[] = []
  let index = 0
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, form: new URLSearchParams(init.body) })
    const next = responses[Math.min(index, responses.length - 1)]
    index += 1
    return {
      ok: (next.status ?? 200) < 400,
      status: next.status ?? 200,
      json: async () => next.body,
      text: async () => JSON.stringify(next.body)
    }
  }
  return { fetchImpl, calls }
}

describe('validation', () => {
  it('requires a GUID client id and a safe tenant segment', () => {
    expect(isValidClientId(CLIENT_ID)).toBe(true)
    expect(isValidClientId('not-a-guid')).toBe(false)
    expect(isValidTenant('common')).toBe(true)
    expect(isValidTenant('contoso.onmicrosoft.com')).toBe(true)
    // A tenant must never be able to redirect the request host or path.
    expect(isValidTenant('common/../../evil')).toBe(false)
    expect(isValidTenant('evil.com/x')).toBe(false)
    expect(isValidTenant('')).toBe(false)
  })

  it('rejects construction without a valid client id', () => {
    expect(() => new MicrosoftDeviceCodeAuth({ clientId: 'nope' })).toThrow(/client\) ID/)
    expect(() => new MicrosoftDeviceCodeAuth({ clientId: CLIENT_ID, tenant: '../evil' })).toThrow(
      /Invalid Microsoft tenant/
    )
  })
})

describe('scopes', () => {
  it('never requests permission to send mail, in either mode', () => {
    // There is no send tool, so the app must not hold Mail.Send at all —
    // drafts are created and the user sends them from Outlook.
    expect(scopesForMode('read')).not.toContain('Mail.Send')
    expect(scopesForMode('write')).not.toContain('Mail.Send')
    expect(scopesForMode('write')).toContain('Mail.ReadWrite')
  })

  it('requests read-only scopes by default and never a client secret', () => {
    expect(scopesForMode('read')).toEqual([...GRAPH_READ_SCOPES])
    expect(scopesForMode('write')).toEqual([...GRAPH_WRITE_SCOPES])
    // offline_access is what yields a refresh token in both modes.
    expect(scopesForMode('read')).toContain('offline_access')
  })
})

describe('startDeviceCode', () => {
  it('posts the client id and scopes, returning the user-facing code', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        body: {
          device_code: 'DEV-CODE',
          user_code: 'ABCD-EFGH',
          verification_uri: 'https://microsoft.com/devicelogin',
          message: 'Go to the page and enter ABCD-EFGH',
          expires_in: 900,
          interval: 5
        }
      }
    ])
    const auth = new MicrosoftDeviceCodeAuth({ clientId: CLIENT_ID, fetchImpl, nowMs: () => NOW })
    const start = await auth.startDeviceCode('read')

    expect(calls[0].url).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/devicecode')
    expect(calls[0].form.get('client_id')).toBe(CLIENT_ID)
    expect(calls[0].form.get('scope')).toContain('Mail.Read')
    expect(calls[0].form.has('client_secret')).toBe(false)
    expect(start).toMatchObject({
      deviceCode: 'DEV-CODE',
      userCode: 'ABCD-EFGH',
      pollIntervalSeconds: 5
    })
  })

  it('surfaces the first line of a Microsoft error', async () => {
    const { fetchImpl } = stubFetch([
      {
        status: 400,
        body: {
          error: 'invalid_client',
          error_description: 'AADSTS7000218: bad client\r\nTrace ID: x\r\nCorrelation ID: y'
        }
      }
    ])
    const auth = new MicrosoftDeviceCodeAuth({ clientId: CLIENT_ID, fetchImpl })
    await expect(auth.startDeviceCode('read')).rejects.toThrow(/AADSTS7000218/)
  })

  it('honors a custom tenant in the URL', async () => {
    const { fetchImpl, calls } = stubFetch([
      { body: { device_code: 'd', user_code: 'u', interval: 5 } }
    ])
    const auth = new MicrosoftDeviceCodeAuth({
      clientId: CLIENT_ID,
      tenant: 'contoso.onmicrosoft.com',
      fetchImpl
    })
    await auth.startDeviceCode('read')
    expect(calls[0].url).toBe(
      'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/devicecode'
    )
  })
})

describe('pollForToken', () => {
  it('returns pending while the user has not finished signing in', async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 400, body: { error: 'authorization_pending' } }
    ])
    const auth = new MicrosoftDeviceCodeAuth({ clientId: CLIENT_ID, fetchImpl })
    expect(await auth.pollForToken('DEV-CODE', 5)).toEqual({ status: 'pending' })
    expect(calls[0].form.get('grant_type')).toBe(MICROSOFT_DEVICE_CODE_GRANT)
    expect(calls[0].form.get('device_code')).toBe('DEV-CODE')
  })

  it('backs off on slow_down and reports declined/expired distinctly', async () => {
    expect(classifyPollError({ error: 'slow_down' }, 5)).toEqual({
      status: 'slow-down',
      nextIntervalSeconds: 10
    })
    expect(classifyPollError({ error: 'authorization_declined' }, 5)).toEqual({
      status: 'declined'
    })
    expect(classifyPollError({ error: 'expired_token' }, 5)).toEqual({ status: 'expired' })
    expect(classifyPollError({ error: 'weird', error_description: 'Boom\nTrace' }, 5)).toEqual({
      status: 'error',
      message: 'Boom'
    })
  })

  it('returns the token set once the user approves', async () => {
    const { fetchImpl } = stubFetch([
      {
        body: {
          access_token: 'ACCESS',
          refresh_token: 'REFRESH',
          expires_in: 3600,
          scope: 'Mail.Read Calendars.Read'
        }
      }
    ])
    const auth = new MicrosoftDeviceCodeAuth({ clientId: CLIENT_ID, fetchImpl, nowMs: () => NOW })
    const outcome = await auth.pollForToken('DEV-CODE', 5)
    expect(outcome).toEqual({
      status: 'granted',
      tokens: {
        accessToken: 'ACCESS',
        refreshToken: 'REFRESH',
        expiresAtMs: NOW + 3_600_000,
        scopes: ['Mail.Read', 'Calendars.Read'],
        account: null
      }
    })
  })
})

describe('refresh', () => {
  it('exchanges a refresh token and keeps the old one when not rotated', async () => {
    const { fetchImpl, calls } = stubFetch([
      { body: { access_token: 'NEW-ACCESS', expires_in: 3600, scope: 'Mail.Read' } }
    ])
    const auth = new MicrosoftDeviceCodeAuth({ clientId: CLIENT_ID, fetchImpl, nowMs: () => NOW })
    const tokens = await auth.refresh('OLD-REFRESH', 'read')
    expect(calls[0].form.get('grant_type')).toBe('refresh_token')
    expect(calls[0].form.get('refresh_token')).toBe('OLD-REFRESH')
    expect(tokens).toMatchObject({ accessToken: 'NEW-ACCESS', refreshToken: 'OLD-REFRESH' })
  })

  it('returns null when the refresh is rejected', async () => {
    const { fetchImpl } = stubFetch([{ status: 400, body: { error: 'invalid_grant' } }])
    const auth = new MicrosoftDeviceCodeAuth({ clientId: CLIENT_ID, fetchImpl })
    expect(await auth.refresh('DEAD', 'read')).toBeNull()
  })
})

describe('token freshness', () => {
  it('treats tokens inside the safety margin as stale', () => {
    const tokens = parseTokenResponse({ access_token: 'a', expires_in: 3600 }, NOW)!
    expect(tokenSetIsFresh(tokens, NOW)).toBe(true)
    // 60s before expiry is inside the 120s margin.
    expect(tokenSetIsFresh(tokens, NOW + 3_540_000)).toBe(false)
  })

  it('rejects payloads without an access token', () => {
    expect(parseTokenResponse({ error: 'nope' }, NOW)).toBeNull()
    expect(parseTokenResponse(null, NOW)).toBeNull()
  })
})

describe('timeouts', () => {
  it('aborts a hung request', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    ) as unknown as FetchLike
    const auth = new MicrosoftDeviceCodeAuth({ clientId: CLIENT_ID, fetchImpl, timeoutMs: 5 })
    await expect(auth.startDeviceCode('read')).rejects.toThrow(/aborted/)
  })
})
