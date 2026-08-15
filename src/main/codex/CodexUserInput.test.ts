import { describe, expect, it } from 'vitest'

import {
  CODEX_USER_INPUT_MAX_TIMEOUT_MS,
  CODEX_USER_INPUT_METHOD,
  buildCodexUserInputResponse,
  isCodexUserInputRequestMethod,
  normalizeCodexUserInputRequest
} from './CodexUserInput'

describe('CodexUserInput', () => {
  it('recognizes only the host JSON-RPC method, not MCP/display aliases', () => {
    expect(isCodexUserInputRequestMethod(CODEX_USER_INPUT_METHOD)).toBe(true)
    expect(isCodexUserInputRequestMethod('request_user_input')).toBe(false)
    expect(isCodexUserInputRequestMethod('TaskWraith__Request_User_Input')).toBe(false)
    expect(isCodexUserInputRequestMethod('mcp/elicitation/request')).toBe(false)
  })

  it('normalizes structured questions, option labels, context, and timeout', () => {
    expect(
      normalizeCodexUserInputRequest({
        questions: [
          {
            id: 'colour',
            header: 'Preference',
            question: 'What is your favourite colour?',
            options: [
              { label: 'red', description: 'warm' },
              { label: 'green', description: 'calm' },
              { label: 'blue', description: 'cool' }
            ]
          },
          { id: 'reason', question: 'Why?' }
        ],
        timeoutMs: 45_000
      })
    ).toEqual({
      ok: true,
      request: {
        questions: [
          {
            id: 'colour',
            context: 'Preference',
            question: 'What is your favourite colour?',
            options: ['red', 'green', 'blue']
          },
          { id: 'reason', question: 'Why?' }
        ],
        timeoutMs: 45_000
      }
    })
  })

  it('clamps provider-requested question timeouts to the shared 24-minute ceiling', () => {
    expect(
      normalizeCodexUserInputRequest({
        questions: [{ id: 'continue', question: 'Continue?' }],
        timeoutMs: 60 * 60 * 1000
      })
    ).toMatchObject({
      ok: true,
      request: { timeoutMs: CODEX_USER_INPUT_MAX_TIMEOUT_MS }
    })
    expect(CODEX_USER_INPUT_MAX_TIMEOUT_MS).toBe(24 * 60 * 1000)
  })

  it('rejects missing, duplicate, over-count, and over-capacity requests', () => {
    expect(normalizeCodexUserInputRequest({})).toMatchObject({ ok: false })
    expect(
      normalizeCodexUserInputRequest({
        questions: [
          { id: 'same', question: 'One' },
          { id: 'same', question: 'Two' }
        ]
      })
    ).toMatchObject({ ok: false, reason: expect.stringContaining('duplicated') })
    expect(
      normalizeCodexUserInputRequest({
        questions: [
          { id: '1', question: 'One' },
          { id: '2', question: 'Two' },
          { id: '3', question: 'Three' },
          { id: '4', question: 'Four' }
        ]
      })
    ).toMatchObject({ ok: false, reason: expect.stringContaining('at most') })
    expect(
      normalizeCodexUserInputRequest({
        questions: [
          {
            id: 'choices',
            question: 'Pick',
            options: ['one', 'two', 'three', 'four', 'five']
          }
        ]
      })
    ).toMatchObject({ ok: false, reason: expect.stringContaining('too many options') })
  })

  it('preserves known question ids and excludes unknown answer keys', () => {
    const normalized = normalizeCodexUserInputRequest({
      questions: [
        { id: 'first', question: 'First?' },
        { id: 'second', question: 'Second?' }
      ]
    })
    expect(normalized.ok).toBe(true)
    if (!normalized.ok) return
    expect(
      buildCodexUserInputResponse(normalized.request.questions, {
        first: 'yes',
        second: 'later',
        forged: 'must not cross the boundary'
      })
    ).toEqual({ answers: { first: 'yes', second: 'later' } })
  })
})
