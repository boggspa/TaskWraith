import { describe, it, expect } from 'vitest'
import { classifyProviderQuotaWall, extractResetHint } from './ProviderQuotaWallClassifier'

const NOW = Date.parse('2026-06-21T12:00:00.000Z')

describe('classifyProviderQuotaWall — real provider 429/quota bodies', () => {
  it('claude rate_limit_error 429 body', () => {
    const body =
      '{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}'
    expect(classifyProviderQuotaWall('claude', body).hit).toBe(true)
  })

  it('claude 529 overloaded_error', () => {
    expect(classifyProviderQuotaWall('claude', '{"error":{"type":"overloaded_error"}}').hit).toBe(true)
  })

  it('claude stdout usage-limit form with epoch reset', () => {
    const futureEpoch = Math.floor(NOW / 1000) + 3600 // one hour ahead of NOW
    const v = classifyProviderQuotaWall('claude', `Claude AI usage limit reached|${futureEpoch}`, { now: NOW })
    expect(v.hit).toBe(true)
    expect(v.resetHintAt).toBe(new Date(futureEpoch * 1000).toISOString())
  })

  it('claude subscription/Fable weekly wall ("You\'ve hit your limit · resets <date>")', () => {
    // The lived General/Boss wall this whole control-plane goal exists to catch.
    expect(classifyProviderQuotaWall('claude', "You've hit your limit · resets Jul 14").hit).toBe(true)
    // Curly-apostrophe variant (subscription UIs routinely render U+2019).
    expect(classifyProviderQuotaWall('claude', 'You’ve hit your limit — resets on Monday').hit).toBe(true)
  })

  it('claude Fable dedicated usage-credit wall', () => {
    const body =
      "You're out of usage credits. Run /usage-credits to keep using Fable 5 or /model to switch models."
    expect(classifyProviderQuotaWall('claude', body).hit).toBe(true)
  })

  it('codex insufficient_quota (billing wall)', () => {
    const body =
      '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}'
    expect(classifyProviderQuotaWall('codex', body).hit).toBe(true)
  })

  it('codex rate_limit_exceeded with "try again in Ns" reset', () => {
    const body =
      "You've exceeded the rate limit, please slow down and try again in 6.514s. code: rate_limit_exceeded"
    const v = classifyProviderQuotaWall('codex', body, { now: NOW })
    expect(v.hit).toBe(true)
    expect(v.resetHintAt).toBe(new Date(NOW + 6514).toISOString())
  })

  it('codex subscription cap', () => {
    expect(classifyProviderQuotaWall('codex', "You've hit your usage limit. Upgrade to Pro").hit).toBe(true)
  })

  it('kimi rate_limit_reached_error + "after N seconds" reset', () => {
    const body =
      '{"error":{"message":"Organization Rate limit exceeded, please try again after 12 seconds","type":"rate_limit_reached_error"}}'
    const v = classifyProviderQuotaWall('kimi', body, { now: NOW })
    expect(v.hit).toBe(true)
    expect(v.resetHintAt).toBe(new Date(NOW + 12000).toISOString())
  })

  it('kimi exceeded_current_quota_error (suspended/balance)', () => {
    const body =
      '{"error":{"message":"Your account org-x <ak-y> is suspended due to insufficient balance","type":"exceeded_current_quota_error"}}'
    expect(classifyProviderQuotaWall('kimi', body).hit).toBe(true)
  })

  it('grok flat credits-exhausted body (even at 403)', () => {
    const body =
      '{"code":"permission-denied","error":"Your team 1fd7 has either used all available credits or reached its monthly spending limit."}'
    expect(classifyProviderQuotaWall('grok', body).hit).toBe(true)
  })

  it('grok TPM wall', () => {
    expect(classifyProviderQuotaWall('grok', 'Too many tokens for team e9fe and model grok-4-0709.').hit).toBe(true)
  })

  it('cursor usage limit + resource_exhausted', () => {
    expect(classifyProviderQuotaWall('cursor', "You've hit your usage limit. Upgrade for more usage.").hit).toBe(true)
    expect(classifyProviderQuotaWall('cursor', 'ERROR_RESOURCE_EXHAUSTED').hit).toBe(true)
  })
})

describe('classifyProviderQuotaWall — fails closed (no false positives)', () => {
  it('ollama always returns hit:false (local has no quota wall)', () => {
    expect(classifyProviderQuotaWall('ollama', 'server busy, please try again.  maximum pending requests exceeded').hit).toBe(false)
    expect(classifyProviderQuotaWall('ollama', 'HTTP 429').hit).toBe(false)
  })

  it('does not fire on tool-emitted 429s reaching the wrong provider channel', () => {
    // AWS / Docker / GitHub / curl strings an agent tool emits — none are
    // provider-transport tokens, so they must not trigger.
    const traps = [
      'An error occurred (ThrottlingException) when calling the DescribeInstances operation: Rate exceeded.',
      'You have exceeded a secondary rate limit. (GitHub)',
      'toomanyrequests: Too many requests. (Docker Hub pull rate limit)',
      '< HTTP/1.1 429 Too Many Requests',
      '429 Client Error: Too Many Requests for url: https://example.com'
    ]
    for (const t of traps) {
      expect(classifyProviderQuotaWall('claude', t).hit).toBe(false)
      expect(classifyProviderQuotaWall('codex', t).hit).toBe(false)
      expect(classifyProviderQuotaWall('grok', t).hit).toBe(false)
    }
  })

  it('empty / non-quota errors return false', () => {
    expect(classifyProviderQuotaWall('claude', '').hit).toBe(false)
    expect(classifyProviderQuotaWall('claude', undefined).hit).toBe(false)
    expect(classifyProviderQuotaWall('codex', 'ENOENT: command not found: codex').hit).toBe(false)
  })

  it('C1 G1 — bare "quota"/"resets"/"limit" prose does NOT flip (no bare-substring match)', () => {
    // Ordinary Boss prose that merely mentions the words — the exact false
    // positive Captain G1 forbids, and this transcript is full of it.
    for (const prose of [
      'Let me check when the team quota resets before we continue.',
      "You've hit your limit of patience with this flaky test", // opener but no reset envelope
      'The required gate is a blocker; it resets nothing on its own.',
      'We should watch the weekly limit and quota so nobody walls.'
    ]) {
      expect(classifyProviderQuotaWall('claude', prose).hit).toBe(false)
    }
  })
})

describe('extractResetHint', () => {
  it('returns undefined when no reset is embedded', () => {
    expect(extractResetHint('grok', 'used all available credits', NOW)).toBeUndefined()
  })
  it('ignores a past epoch', () => {
    expect(extractResetHint('claude', 'Claude AI usage limit reached|1000000000', NOW)).toBeUndefined()
  })
})
