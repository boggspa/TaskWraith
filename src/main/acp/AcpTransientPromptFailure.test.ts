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

  it('classifies the bare envelope from stderr evidence on the other channel', () => {
    // The real captured pair: the frame says nothing, stderr says everything.
    const bareEnvelope = { code: -32603, message: 'Internal error' }
    const stderr =
      'ERROR error=Internal error: {\n  "message": "API error (status 500 Internal Server Error): error: Service temporarily unavailable.",\n  "http_status": 500\n}'
    expect(isTransientAcpPromptFailure(bareEnvelope, { evidence: stderr })).toBe(true)
  })

  it('lets stderr evidence VETO a retry the envelope alone would have allowed', () => {
    // Auth arrives as the same bare -32603; only the other channel can tell
    // the two apart, which is the whole point of correlating them.
    const bareEnvelope = { code: -32603, message: 'Internal error' }
    expect(
      isTransientAcpPromptFailure(bareEnvelope, {
        evidence:
          'worker quit with fatal: Transport channel closed, when Auth(AuthorizationRequired)'
      })
    ).toBe(false)
    expect(
      isTransientAcpPromptFailure(bareEnvelope, { evidence: 'Error code: 429 - rate_limit_error' })
    ).toBe(false)
  })

  it('treats an uncorroborated JSON-RPC -32603 as retryable, other codes not', () => {
    // -32603 is reserved for a fault inside the server. A wrong retry costs one
    // bounded backoff; a wrong refusal costs the whole turn.
    expect(isTransientAcpPromptFailure({ code: -32603, message: 'Internal error' })).toBe(true)
    expect(isTransientAcpPromptFailure({ code: -32602, message: 'Invalid params' })).toBe(false)
    expect(isTransientAcpPromptFailure({ code: -32601, message: 'Method not found' })).toBe(false)
    expect(isTransientAcpPromptFailure({ code: -32000, message: 'Server error' })).toBe(false)
  })

  it('never retries a deterministic oversized or malformed request', () => {
    // Re-sending an oversized prompt is the one retry that is not cheap.
    for (const text of [
      'context_length_exceeded',
      "This model's maximum context length is 131072 tokens",
      'prompt is too long',
      'invalid_request_error'
    ]) {
      expect(
        isTransientAcpPromptFailure(
          { code: -32603, message: 'Internal error' },
          { evidence: text }
        ),
        text
      ).toBe(false)
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
