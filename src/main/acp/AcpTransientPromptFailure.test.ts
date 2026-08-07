import { describe, it, expect } from 'vitest'
import { acpRpcErrorText, isTransientAcpPromptFailure } from './AcpTransientPromptFailure'

describe('isTransientAcpPromptFailure', () => {
  it('classifies the captured xAI 500 that killed a Grok turn', () => {
    // Verbatim from the 2026-08-07 report: grok wraps the upstream status in a
    // generic JSON-RPC "Internal error" and puts the real body in data.
    expect(
      isTransientAcpPromptFailure({
        message: 'Internal error',
        data: '{"message":"API error (status 500 Internal Server Error): API error (status 500 Internal Server Error): error: Service temporarily unavailable.","http_status":500}'
      })
    ).toBe(true)
  })

  it('reads the status out of a structured (non-string) data payload', () => {
    expect(
      isTransientAcpPromptFailure({ message: 'Internal error', data: { http_status: 503 } })
    ).toBe(true)
    expect(isTransientAcpPromptFailure({ message: 'Internal error', data: { status: 502 } })).toBe(
      true
    )
  })

  it('accepts upstream 5xx prose and transport faults', () => {
    for (const text of [
      'Internal Server Error',
      'Bad Gateway',
      'service unavailable',
      'Service temporarily unavailable.',
      'gateway timeout',
      'gateway time-out',
      'please try again later',
      'socket hang up',
      'connection reset by peer',
      'request timed out',
      'network error',
      'read ECONNRESET',
      'connect ETIMEDOUT 1.2.3.4:443',
      'getaddrinfo EAI_AGAIN api.x.ai'
    ]) {
      expect(isTransientAcpPromptFailure({ message: text }), text).toBe(true)
    }
  })

  it('never retries auth failures — a wait cannot mint a credential', () => {
    for (const text of [
      'Transport channel closed, when Auth(AuthorizationRequired)',
      'API error (status 401 Unauthorized)',
      'API error (status 403 Forbidden)',
      'invalid_api_key',
      'authentication_error'
    ]) {
      expect(isTransientAcpPromptFailure({ message: text }), text).toBe(false)
    }
  })

  it('leaves quota and rate-limit walls to the failover classifier', () => {
    for (const text of [
      'Error code: 429 - {"error":"Too many tokens for team"}',
      '{"http_status":429}',
      'rate_limit_error',
      'overloaded_error',
      '{"status":529}',
      'has either used all available credits or reached its monthly spending limit',
      'You have exceeded your current quota'
    ]) {
      expect(isTransientAcpPromptFailure({ message: text }), text).toBe(false)
    }
  })

  it('fails closed on an unrecognized or empty error', () => {
    expect(isTransientAcpPromptFailure(null)).toBe(false)
    expect(isTransientAcpPromptFailure(undefined)).toBe(false)
    expect(isTransientAcpPromptFailure({})).toBe(false)
    expect(isTransientAcpPromptFailure({ message: '   ' })).toBe(false)
    // The bare JSON-RPC envelope carries no evidence a retry would help.
    expect(isTransientAcpPromptFailure({ message: 'Internal error' })).toBe(false)
    expect(isTransientAcpPromptFailure({ message: 'Invalid params' })).toBe(false)
    expect(isTransientAcpPromptFailure({ message: 'prompt too long' })).toBe(false)
  })

  it('fails closed when a transient status and a quota wall appear together', () => {
    // A 503 page that describes a rate limit is a wall, not a blip.
    expect(
      isTransientAcpPromptFailure({
        message: 'API error (status 503 Service Unavailable): rate_limit_error'
      })
    ).toBe(false)
  })
})

describe('acpRpcErrorText', () => {
  it('serializes an object payload instead of stringifying it to [object Object]', () => {
    const text = acpRpcErrorText({ message: 'Internal error', data: { http_status: 500 } })
    expect(text).toContain('Internal error')
    expect(text).toContain('500')
    expect(text).not.toContain('[object Object]')
  })

  it('survives an unserializable payload without throwing', () => {
    const circular: Record<string, unknown> = { name: 'loop' }
    circular.self = circular
    expect(acpRpcErrorText({ message: 'Internal error', data: circular })).toBe('Internal error')
  })
})
