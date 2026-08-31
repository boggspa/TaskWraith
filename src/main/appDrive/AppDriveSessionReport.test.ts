import { describe, expect, it } from 'vitest'
import {
  APP_DRIVE_SESSION_REPORT_MAX_ACTIONS,
  AppDriveSessionReportError,
  AppDriveSessionReportStore
} from './AppDriveSessionReport'

function harness() {
  let now = 1_000
  let report = 0
  let action = 0
  let observation = 0
  const store = new AppDriveSessionReportStore({
    now: () => now,
    createReportId: () => `report-${++report}`,
    createActionId: () => `action-${++action}`,
    createObservationId: () => `observation-${++observation}`
  })
  const holder = { runId: 'run-a', provider: 'codex', participantId: 'actor-a' }
  const started = store.start({
    leaseId: 'lease-a',
    surfaceId: 'canvas-a',
    surfaceKind: 'web',
    chatId: 'chat-a',
    holder,
    approvedAt: 900,
    expiresAt: 10_000,
    stepBudget: 3
  })
  return {
    store,
    holder,
    started,
    tick: (value = 1) => {
      now += value
    }
  }
}

describe('AppDriveSessionReportStore', () => {
  it('records a bounded value-free actor/surface-verifier action report', () => {
    const { store, holder, started, tick } = harness()
    const action = store.beginAction({ leaseId: 'lease-a', verb: 'click', actor: holder })
    tick()
    store.updateBudget('lease-a', { stepsUsed: 1, stepsRemaining: 2 })
    const completed = store.completeAction({
      leaseId: 'lease-a',
      actionId: action.actionId,
      actor: holder,
      executed: true,
      surfaceVerification: 'changed'
    })

    expect(completed).toMatchObject({ status: 'verified', executed: true })
    expect(store.query({ chatId: 'chat-a' })).toEqual([
      expect.objectContaining({
        reportId: started.reportId,
        stepsUsed: 1,
        counts: expect.objectContaining({ total: 1, verified: 1 }),
        actions: [
          expect.objectContaining({
            verb: 'click',
            actor: holder,
            surfaceVerifier: expect.objectContaining({ kind: 'surface', verdict: 'confirmed' })
          })
        ]
      })
    ])
    const serialized = JSON.stringify(store.query({ chatId: 'chat-a' }))
    for (const forbidden of ['value', 'label', 'url', 'approvalId', 'pid', 'handle']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
  })

  it('records an emulator surface as a distinct value-free report kind', () => {
    const { store, holder } = harness()
    const emulator = store.start({
      leaseId: 'lease-emulator',
      surfaceId: 'canvas-emulator-a',
      surfaceKind: 'emulator',
      chatId: 'chat-a',
      holder,
      approvedAt: 900,
      expiresAt: 10_000,
      stepBudget: 2
    })
    const action = store.beginAction({
      leaseId: emulator.leaseId,
      verb: 'emulator_step',
      actor: holder
    })
    store.completeAction({
      leaseId: emulator.leaseId,
      actionId: action.actionId,
      actor: holder,
      executed: true,
      surfaceVerification: 'changed'
    })

    expect(store.query({ chatId: 'chat-a', surfaceId: 'canvas-emulator-a' })).toMatchObject([
      {
        surfaceKind: 'emulator',
        actions: [expect.objectContaining({ verb: 'emulator_step', status: 'verified' })]
      }
    ])
  })

  it('requires a distinct Ensemble participant when independent verification is requested', () => {
    const { store, holder, started } = harness()
    const action = store.beginAction({
      leaseId: 'lease-a',
      verb: 'select',
      actor: holder,
      independentVerificationRequired: true
    })
    store.completeAction({
      leaseId: 'lease-a',
      actionId: action.actionId,
      actor: holder,
      executed: true,
      surfaceVerification: 'changed'
    })
    expect(store.query({ chatId: 'chat-a' })[0].counts.awaitingVerification).toBe(1)
    const actorObservation = store.recordObservation({
      chatId: 'chat-a',
      surfaceId: 'canvas-a',
      observer: holder
    })!

    let verificationError: unknown
    try {
      store.verifyAction({
        reportId: started.reportId,
        actionId: action.actionId,
        surfaceId: 'canvas-a',
        observationId: actorObservation.observationId,
        chatId: 'chat-a',
        verifier: holder,
        verdict: 'confirmed'
      })
    } catch (error) {
      verificationError = error
    }
    expect(verificationError).toBeInstanceOf(AppDriveSessionReportError)
    expect((verificationError as AppDriveSessionReportError).code).toBe(
      'independent-verifier-required'
    )

    const reviewer = { runId: 'run-b', provider: 'claude', participantId: 'reviewer-b' }
    expect(() =>
      store.verifyAction({
        reportId: started.reportId,
        actionId: action.actionId,
        surfaceId: 'canvas-a',
        observationId: actorObservation.observationId,
        chatId: 'chat-a',
        verifier: reviewer,
        verdict: 'confirmed'
      })
    ).toThrow(/trusted post-action observation receipt/i)
    const reviewerObservation = store.recordObservation({
      chatId: 'chat-a',
      surfaceId: 'canvas-a',
      observer: reviewer
    })!
    expect(
      store.verifyAction({
        reportId: started.reportId,
        actionId: action.actionId,
        surfaceId: 'canvas-a',
        observationId: reviewerObservation.observationId,
        chatId: 'chat-a',
        verifier: reviewer,
        verdict: 'not-confirmed'
      })
    ).toMatchObject({
      status: 'not-verified',
      participantVerifier: {
        kind: 'participant',
        participantId: 'reviewer-b',
        verdict: 'not-confirmed'
      }
    })
  })

  it('allows an ordinary actor to attest after an inconclusive surface check', () => {
    const { store, holder, started } = harness()
    const action = store.beginAction({ leaseId: 'lease-a', verb: 'fill', actor: holder })
    store.completeAction({
      leaseId: 'lease-a',
      actionId: action.actionId,
      actor: holder,
      executed: true,
      surfaceVerification: 'unchanged'
    })
    expect(store.query({ chatId: 'chat-a' })[0].counts.notVerified).toBe(1)
    const observation = store.recordObservation({
      chatId: 'chat-a',
      surfaceId: 'canvas-a',
      observer: holder
    })!
    expect(
      store.verifyAction({
        reportId: started.reportId,
        actionId: action.actionId,
        surfaceId: 'canvas-a',
        observationId: observation.observationId,
        chatId: 'chat-a',
        verifier: holder,
        verdict: 'confirmed'
      })
    ).toMatchObject({ status: 'verified' })
  })

  it('issues an observation receipt for a selected earlier action', () => {
    const { store, holder } = harness()
    const first = store.beginAction({ leaseId: 'lease-a', verb: 'click', actor: holder })
    store.completeAction({
      leaseId: 'lease-a',
      actionId: first.actionId,
      actor: holder,
      executed: true,
      surfaceVerification: 'unknown'
    })
    const second = store.beginAction({ leaseId: 'lease-a', verb: 'hover', actor: holder })
    store.completeAction({
      leaseId: 'lease-a',
      actionId: second.actionId,
      actor: holder,
      executed: true,
      surfaceVerification: 'unknown'
    })

    expect(
      store.recordObservation({
        chatId: 'chat-a',
        surfaceId: 'canvas-a',
        actionId: first.actionId,
        observer: holder
      })
    ).toMatchObject({ actionId: first.actionId, surfaceId: 'canvas-a' })
  })

  it('ends replaced sessions and filters reports by exact chat/surface', () => {
    const { store, holder, started, tick } = harness()
    tick()
    const replacement = store.start({
      leaseId: 'lease-b',
      surfaceId: 'canvas-a',
      surfaceKind: 'web',
      chatId: 'chat-a',
      holder,
      approvedAt: 950,
      expiresAt: 11_000,
      stepBudget: 2
    })
    expect(store.query({ chatId: 'chat-a', surfaceId: 'canvas-a' })).toMatchObject([
      { reportId: replacement.reportId, status: 'active' },
      { reportId: started.reportId, status: 'ended', endReason: 'replaced' }
    ])
    expect(store.query({ chatId: 'chat-b' })).toEqual([])
  })

  it('expires active reports and settles pending actions as indeterminate', () => {
    const { store, holder, tick } = harness()
    store.beginAction({ leaseId: 'lease-a', verb: 'click', actor: holder })
    tick(9_000)
    expect(store.query({ chatId: 'chat-a' })[0]).toMatchObject({
      status: 'ended',
      endReason: 'expired',
      counts: { total: 1, indeterminate: 1 },
      actions: [
        expect.objectContaining({
          status: 'indeterminate',
          executed: null,
          refusalCode: 'session_ended'
        })
      ]
    })
  })

  it('caps each session at the public maximum action count', () => {
    const { store, holder } = harness()
    for (let index = 0; index < APP_DRIVE_SESSION_REPORT_MAX_ACTIONS; index += 1) {
      store.beginAction({ leaseId: 'lease-a', verb: 'hover', actor: holder })
    }
    expect(() => store.beginAction({ leaseId: 'lease-a', verb: 'hover', actor: holder })).toThrow(
      'action bound is exhausted'
    )
  })
})
