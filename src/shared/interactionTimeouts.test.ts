import { describe, expect, it } from 'vitest'

import {
  AGENT_QUESTION_TIMEOUT_MS,
  AGENT_QUESTION_TRANSPORT_TIMEOUT_MS,
  APPROVAL_TIMEOUT_DEFAULTS_VERSION,
  APPROVAL_TIMEOUT_MAX_MS,
  APPROVAL_TIMEOUT_PROVIDER_IDS,
  APPROVAL_TRANSPORT_TIMEOUT_MS,
  DEFAULT_APPROVAL_TIMEOUTS_MS,
  DEFAULT_MAIN_AUTHORITY_APPROVAL_TIMEOUT_MS,
  INTERACTION_TRANSPORT_GRACE_MS,
  migrateApprovalTimeoutDefaults
} from './interactionTimeouts'

describe('interactionTimeouts', () => {
  it('keeps transport backstops beyond their user-facing interaction windows', () => {
    expect(AGENT_QUESTION_TIMEOUT_MS).toBe(24 * 60 * 1000)
    expect(AGENT_QUESTION_TRANSPORT_TIMEOUT_MS).toBe(
      AGENT_QUESTION_TIMEOUT_MS + INTERACTION_TRANSPORT_GRACE_MS
    )
    expect(APPROVAL_TRANSPORT_TIMEOUT_MS).toBe(
      APPROVAL_TIMEOUT_MAX_MS + INTERACTION_TRANSPORT_GRACE_MS
    )
  })

  it('defines a timeout for every stable provider identity', () => {
    expect(Object.keys(DEFAULT_APPROVAL_TIMEOUTS_MS)).toEqual(APPROVAL_TIMEOUT_PROVIDER_IDS)
  })

  it('doubles legacy defaults while preserving explicit custom values', () => {
    const migrated = migrateApprovalTimeoutDefaults({
      enabled: false,
      perProviderMs: {
        gemini: 120_000,
        codex: 30_000,
        claude: 120_000,
        kimi: 75_000,
        grok: 120_000,
        cursor: 120_000,
        ollama: 120_000,
        antigravity: 120_000,
        pi: 120_000,
        mistral: 60_000,
        muse: 120_000
      },
      mainAuthorityMs: 60_000
    })

    expect(migrated.changed).toBe(true)
    expect(migrated.value).toMatchObject({
      enabled: false,
      defaultsVersion: APPROVAL_TIMEOUT_DEFAULTS_VERSION,
      perProviderMs: {
        gemini: 240_000,
        codex: 60_000,
        claude: 240_000,
        kimi: 75_000,
        grok: 240_000,
        cursor: 240_000,
        ollama: 240_000,
        antigravity: 240_000,
        pi: 240_000,
        mistral: 120_000,
        muse: 240_000
      },
      mainAuthorityMs: DEFAULT_MAIN_AUTHORITY_APPROVAL_TIMEOUT_MS
    })
  })

  it('does not reapply an already-versioned migration', () => {
    const current = {
      defaultsVersion: APPROVAL_TIMEOUT_DEFAULTS_VERSION,
      perProviderMs: { codex: 30_000 },
      mainAuthorityMs: 60_000
    }
    expect(migrateApprovalTimeoutDefaults(current)).toEqual({
      value: current,
      changed: false
    })
  })
})
