import { describe, expect, it } from 'vitest'

import type { HostCommandReceipt, HostResultRef } from '../shared/hostProtocol'
import type {
  HostProviderAuthFlowProjection,
  HostProviderOffersProjection,
  HostProviderStatusProjection
} from '../shared/hostSetupProtocol'
import {
  acknowledgeColdStartPosture,
  applyColdStartReceipt,
  beginColdStartProviderAuth,
  coldStartAuthFlows,
  coldStartConfigure,
  coldStartIdle,
  coldStartMayAutoRetry,
  coldStartOffers,
  coldStartPending,
  coldStartSelectProvider,
  coldStartThreadCreated,
  reconnectColdStart,
  selectColdStartConfiguration
} from './coldStartFlow'

const provider: HostProviderStatusProjection = {
  providerId: 'codex',
  status: 'auth_required',
  label: 'Codex'
}

const flows: readonly HostProviderAuthFlowProjection[] = [
  { flowId: 'browser', kind: 'browser', label: 'Browser sign-in', available: true }
]

const offers: HostProviderOffersProjection = {
  providerId: 'codex',
  offerRevision: 'offers-r1',
  models: [
    {
      modelId: 'gpt-5.6',
      label: 'GPT-5.6',
      available: true,
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

function pending(name: Parameters<typeof coldStartPending>[1]['name']) {
  return {
    commandId: `cmd-${name}`,
    idempotencyKey: `key-${name}`,
    name,
    submittedAt: '2026-08-24T00:00:00.000Z'
  } as const
}

function receipt(
  commandId: string,
  status: HostCommandReceipt['status'],
  resultRef?: HostResultRef
): HostCommandReceipt {
  return {
    type: 'host.receipt',
    protocolVersion: 2,
    commandId,
    idempotencyKey: 'key',
    name: 'thread.configure',
    actor: { actorId: 'tui', clientId: 'tui', clientClass: 'tui' },
    authority: { decision: 'allow' },
    status,
    commandFingerprint: 'a'.repeat(64),
    generation: 1,
    cursor: 1,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    ...(resultRef ? { resultRef } : {})
  }
}

describe('coldStartFlow', () => {
  it('validates exact provider/auth/offers and requires explicit posture acknowledgement', () => {
    const selected = coldStartSelectProvider(coldStartIdle(), provider)
    const auth = coldStartAuthFlows(
      selected,
      { providerId: 'codex', state: 'unauthenticated' },
      flows
    )
    const currentOffers = coldStartOffers(auth, offers)
    const thread = coldStartThreadCreated(currentOffers, 'thread-1')
    const configure = coldStartConfigure(thread)

    expect(() =>
      selectColdStartConfiguration(configure, {
        providerId: 'codex',
        modelId: 'gpt-5.6',
        reasoningId: 'high',
        postureId: 'plan',
        offerRevision: 'offers-r1',
        postureConsent: true
      })
    ).toThrow(/explicit acknowledgement/i)

    const acknowledged = acknowledgeColdStartPosture(configure, 'plan')
    const selectedConfig = selectColdStartConfiguration(acknowledged, {
      providerId: 'codex',
      modelId: 'gpt-5.6',
      reasoningId: 'high',
      postureId: 'plan',
      offerRevision: 'offers-r1',
      postureConsent: true
    })
    expect(selectedConfig.kind).toBe('configure')
    if (selectedConfig.kind !== 'configure') throw new Error('Expected configure state.')
    expect(selectedConfig.selection).toMatchObject({
      threadId: 'thread-1',
      offerRevision: 'offers-r1'
    })
  })

  it('retains pending identity across reconnect and never auto-retries provider auth begin', () => {
    const auth = coldStartAuthFlows(
      coldStartSelectProvider(coldStartIdle(), provider),
      {
        providerId: 'codex',
        state: 'unauthenticated'
      },
      flows
    )
    const pendingAuth = beginColdStartProviderAuth(auth, 'browser', pending('provider.auth.begin'))

    expect(reconnectColdStart(pendingAuth)).toBe(pendingAuth)
    expect(coldStartMayAutoRetry(pendingAuth)).toBe(false)
  })

  it('uses terminal locator receipts to transition and stops at indeterminate without replay', () => {
    const state = coldStartConfigure(
      coldStartThreadCreated(
        coldStartOffers(
          coldStartSelectProvider(coldStartIdle(), { ...provider, status: 'ready' }),
          offers
        ),
        'thread-1'
      )
    )
    const pendingConfigure = coldStartPending(state, pending('thread.configure'))
    const ready = applyColdStartReceipt(
      pendingConfigure,
      receipt('cmd-thread.configure', 'succeeded', {
        kind: 'thread',
        threadId: 'thread-1'
      } as HostResultRef)
    )
    expect(ready).toMatchObject({ kind: 'ready', threadId: 'thread-1', providerId: 'codex' })

    const stopped = applyColdStartReceipt(
      coldStartPending(state, pending('thread.configure')),
      receipt('cmd-thread.configure', 'indeterminate')
    )
    expect(stopped).toMatchObject({ kind: 'legacy', reason: 'indeterminate' })
  })
})
