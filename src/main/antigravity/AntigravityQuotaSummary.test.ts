import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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
})
