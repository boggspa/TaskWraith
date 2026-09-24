import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  resetAntigravityAgyOptInEnabledProbeForTests,
  setAntigravityAgyOptInEnabledProbe
} from './AntigravityAgyOptInEnabledSignal'
import {
  fetchAntigravityCliQuotaSummary,
  parseAntigravityOAuthSession,
  parseAntigravityQuotaSummary
} from './AntigravityQuotaSummary'

describe('parseAntigravityOAuthSession', () => {
  it('parses the official CLI token envelope without exposing unrelated fields', () => {
    expect(
      parseAntigravityOAuthSession({
        token: {
          access_token: ' access ',
          refresh_token: ' refresh ',
          expiry: '2026-08-25T21:00:00Z',
          ignored: 'value'
        }
      })
    ).toEqual({
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: '2026-08-25T21:00:00.000Z'
    })
  })

  it('rejects envelopes without an access token', () => {
    expect(parseAntigravityOAuthSession({ token: { refresh_token: 'refresh' } })).toBeNull()
  })
})

describe('parseAntigravityQuotaSummary', () => {
  it('surfaces the combined Claude/GPT 5H and weekly buckets', () => {
    const snapshot = parseAntigravityQuotaSummary(
      {
        groups: [
          {
            buckets: [
              { bucketId: 'gemini-5h', remainingFraction: 1, resetTime: '2026-08-25T22:00:00Z' },
              {
                bucketId: 'gemini-weekly',
                remainingFraction: 0.97,
                resetTime: '2026-09-01T20:00:00Z'
              },
              { bucketId: '3p-5h', remainingFraction: 0.88, resetTime: '2026-08-25T22:00:00Z' },
              { bucketId: '3p-weekly', remainingFraction: 0.95, resetTime: '2026-09-01T20:00:00Z' }
            ]
          }
        ]
      },
      { planName: 'Google AI Ultra', fetchedAt: '2026-08-25T20:00:00Z' }
    )

    expect(snapshot?.planType).toBe('Google AI Ultra')
    expect(snapshot?.windows?.map((window) => window.label)).toEqual([
      'Gemini 5H',
      'Gemini Weekly',
      'Claude/GPT 5H',
      'Claude/GPT Weekly'
    ])
    expect(snapshot?.windows?.[2]).toMatchObject({
      id: 'agy-3p-5h',
      usedPercent: 12,
      remainingPercent: 88,
      windowKind: 'session'
    })
  })

  it('prefers dedicated Claude and GPT buckets over duplicate combined buckets', () => {
    const snapshot = parseAntigravityQuotaSummary({
      groups: [
        {
          buckets: [
            { bucketId: 'gemini-5h', remainingFraction: 1 },
            { bucketId: 'gemini-weekly', remainingFraction: 0.9 },
            { bucketId: '3p-5h', remainingFraction: 0.8 },
            { bucketId: 'claude-5h', remainingFraction: 0.6 },
            { bucketId: 'claude-weekly', remainingFraction: 0.3 },
            { bucketId: 'gpt-5h', remainingFraction: 0.7 },
            { bucketId: 'gpt-weekly', remainingFraction: 0.85 }
          ]
        }
      ]
    })

    expect(snapshot?.windows?.map((window) => window.label)).toEqual([
      'Gemini 5H',
      'Gemini Weekly',
      'Claude 5H',
      'Claude Weekly',
      'GPT 5H',
      'GPT Weekly'
    ])
  })

  it('fails closed when no Gemini quota family is present', () => {
    expect(
      parseAntigravityQuotaSummary({
        groups: [{ buckets: [{ bucketId: '3p-5h', remainingFraction: 1 }] }]
      })
    ).toBeNull()
  })
})

describe('fetchAntigravityCliQuotaSummary', () => {
  // The live consent read main wires from persisted settings.
  let consentHeld = true
  beforeEach(() => {
    consentHeld = true
    setAntigravityAgyOptInEnabledProbe(() => consentHeld)
  })
  afterEach(() => {
    resetAntigravityAgyOptInEnabledProbeForTests()
  })

  it('uses the official CLI session entirely in main and returns only normalized quota', async () => {
    const root = await mkdtemp(join(tmpdir(), 'taskwraith-agy-quota-'))
    const tokenFilePath = join(root, 'antigravity-oauth-token')
    await writeFile(
      tokenFilePath,
      JSON.stringify({
        token: {
          access_token: 'private-access-token',
          refresh_token: 'private-refresh-token',
          expiry: '2026-08-26T20:00:00Z'
        }
      })
    )
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      requests.push({ url, init })
      if (url.includes('loadCodeAssist')) {
        return new Response(
          JSON.stringify({
            cloudaicompanionProject: 'quota-project',
            paidTier: { name: 'Google AI Ultra' }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      return new Response(
        JSON.stringify({
          groups: [
            {
              buckets: [
                { bucketId: 'gemini-5h', remainingFraction: 1 },
                { bucketId: 'gemini-weekly', remainingFraction: 0.97 },
                { bucketId: '3p-5h', remainingFraction: 0.88 },
                { bucketId: '3p-weekly', remainingFraction: 0.95 }
              ]
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    const snapshot = await fetchAntigravityCliQuotaSummary({
      tokenFilePath,
      fetchImpl,
      now: () => Date.parse('2026-08-25T20:00:00Z')
    })

    expect(requests.map((request) => request.url)).toEqual([
      expect.stringContaining('loadCodeAssist'),
      expect.stringContaining('retrieveUserQuotaSummary')
    ])
    expect(requests[0]?.init?.headers).toEqual(
      expect.objectContaining({ Authorization: 'Bearer private-access-token' })
    )
    expect(requests[1]?.init?.body).toBe(JSON.stringify({ project: 'quota-project' }))
    expect(snapshot).toMatchObject({
      provider: 'antigravity',
      source: 'agy-quota-summary',
      planType: 'Google AI Ultra',
      windows: expect.arrayContaining([expect.objectContaining({ label: 'Claude/GPT 5H' })])
    })
    expect(JSON.stringify(snapshot)).not.toContain('private')
    expect(JSON.stringify(snapshot)).not.toContain(tokenFilePath)
  })

  async function tokenFile(expiry: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'taskwraith-agy-quota-'))
    const tokenFilePath = join(root, 'antigravity-oauth-token')
    await writeFile(
      tokenFilePath,
      JSON.stringify({
        token: {
          access_token: 'private-access-token',
          refresh_token: 'private-refresh-token',
          expiry
        }
      })
    )
    return tokenFilePath
  }

  function json(value: unknown): Response {
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  const loadCodeAssist = () => json({ cloudaicompanionProject: 'quota-project' })
  const quotaSummary = () =>
    json({ groups: [{ buckets: [{ bucketId: 'gemini-5h', remainingFraction: 1 }] }] })

  it('sends no token-bearing request once consent is withdrawn', async () => {
    const tokenFilePath = await tokenFile('2026-08-26T20:00:00Z')
    const requests: string[] = []
    consentHeld = false

    const snapshot = await fetchAntigravityCliQuotaSummary({
      tokenFilePath,
      fetchImpl: async (url) => {
        requests.push(url)
        return url.includes('loadCodeAssist') ? loadCodeAssist() : quotaSummary()
      },
      now: () => Date.parse('2026-08-25T20:00:00Z')
    })

    expect(snapshot).toBeNull()
    expect(requests).toEqual([])
  })

  it('a withdrawal while loadCodeAssist is in flight lets it finish and sends nothing after it', async () => {
    const tokenFilePath = await tokenFile('2026-08-26T20:00:00Z')
    const requests: string[] = []
    let releaseLoad!: () => void
    let loadSignal: AbortSignal | undefined

    const snapshot = fetchAntigravityCliQuotaSummary({
      tokenFilePath,
      fetchImpl: async (url, init) => {
        requests.push(url)
        if (!url.includes('loadCodeAssist')) return quotaSummary()
        loadSignal = init?.signal ?? undefined
        await new Promise<void>((resolve) => {
          releaseLoad = resolve
        })
        return loadCodeAssist()
      },
      now: () => Date.parse('2026-08-25T20:00:00Z')
    })
    for (let attempt = 0; attempt < 50 && !releaseLoad; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    expect(requests).toEqual([expect.stringContaining('loadCodeAssist')])

    consentHeld = false
    releaseLoad()

    await expect(snapshot).resolves.toBeNull()
    // The request already sent is not aborted for the withdrawal; the next one
    // is never sent.
    expect(loadSignal?.aborted).toBe(false)
    expect(requests).toEqual([expect.stringContaining('loadCodeAssist')])
  })

  it('a withdrawal while the token refresh is in flight sends no bearer request after it', async () => {
    // Expires inside the refresh leeway, so the refresh token is used first.
    const tokenFilePath = await tokenFile('2026-08-25T20:01:00Z')
    const requests: string[] = []
    let releaseRefresh!: () => void

    const snapshot = fetchAntigravityCliQuotaSummary({
      tokenFilePath,
      fetchImpl: async (url) => {
        requests.push(url)
        if (url.includes('oauth2')) {
          await new Promise<void>((resolve) => {
            releaseRefresh = resolve
          })
          return json({ access_token: 'refreshed-access-token' })
        }
        return url.includes('loadCodeAssist') ? loadCodeAssist() : quotaSummary()
      },
      now: () => Date.parse('2026-08-25T20:00:00Z')
    })
    for (let attempt = 0; attempt < 50 && !releaseRefresh; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    expect(requests).toEqual([expect.stringContaining('oauth2')])

    consentHeld = false
    releaseRefresh()

    await expect(snapshot).resolves.toBeNull()
    expect(requests).toEqual([expect.stringContaining('oauth2')])
  })
})
