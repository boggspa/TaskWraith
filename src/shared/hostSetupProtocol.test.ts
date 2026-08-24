import { describe, expect, it } from 'vitest'

import {
  decodeHostProviderAuthFlows,
  decodeHostProviderAuthStatusProjection,
  decodeHostProviderOffersProjection,
  decodeHostProviderStatuses
} from './hostSetupProtocol'

const STATUS = { providerId: 'codex', status: 'auth_required', label: 'Codex' }
const OFFERS = {
  providerId: 'codex',
  offerRevision: 'catalog-r1',
  models: [
    {
      modelId: 'gpt-5.6',
      label: 'GPT-5.6',
      available: true,
      default: true,
      reasoning: [{ reasoningId: 'high', label: 'High', available: true }]
    }
  ],
  postures: [
    {
      postureId: 'plan',
      label: 'Plan',
      available: true,
      requiresExplicitConsent: true,
      ceiling: 'workspace_write'
    }
  ]
}

describe('host setup protocol', () => {
  it('decodes bounded provider/model/reasoning/posture metadata', () => {
    expect(decodeHostProviderStatuses([STATUS])).toEqual({ ok: true, value: [STATUS] })
    expect(decodeHostProviderOffersProjection(OFFERS)).toEqual({ ok: true, value: OFFERS })
  })

  it('decodes auth metadata without accepting credential or path-shaped fields', () => {
    expect(
      decodeHostProviderAuthFlows([
        { flowId: 'browser', kind: 'browser', label: 'Browser sign-in', available: true }
      ])
    ).toMatchObject({ ok: true })
    expect(
      decodeHostProviderAuthStatusProjection({ providerId: 'codex', state: 'unauthenticated' })
    ).toMatchObject({ ok: true })
    expect(
      decodeHostProviderAuthFlows([
        {
          flowId: 'browser',
          kind: 'browser',
          label: 'Browser sign-in',
          available: true,
          authorizationUrl: 'https://example.test/token'
        }
      ])
    ).toEqual({ ok: false, error: 'provider auth flows are invalid' })
  })

  it('rejects duplicate ids, unknown fields, and noncanonical values', () => {
    expect(decodeHostProviderStatuses([STATUS, STATUS])).toEqual({
      ok: false,
      error: 'provider statuses are invalid'
    })
    expect(decodeHostProviderOffersProjection({ ...OFFERS, path: '/secret' })).toEqual({
      ok: false,
      error: 'provider offers have unknown fields'
    })
    expect(
      decodeHostProviderAuthStatusProjection({ providerId: ' codex', state: 'unknown' })
    ).toEqual({ ok: false, error: 'provider auth status providerId is invalid' })
    expect(
      decodeHostProviderOffersProjection({
        ...OFFERS,
        offerRevision: '',
        postures: [{ postureId: 'plan', label: 'Plan', available: true }]
      })
    ).toEqual({ ok: false, error: 'provider offers offerRevision is invalid' })
    expect(
      decodeHostProviderOffersProjection({
        ...OFFERS,
        postures: [
          {
            postureId: 'plan',
            label: 'Plan',
            available: true,
            requiresExplicitConsent: false,
            ceiling: 'all_permissions'
          }
        ]
      })
    ).toEqual({ ok: false, error: 'provider offers postures are invalid' })
  })
})
