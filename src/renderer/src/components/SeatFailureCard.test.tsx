/**
 * SeatFailureCard tests.
 *
 * Load-bearing assertions: the failed-seat coda keeps its identity (seat
 * name in the title), the verbose stderr comes from the ALREADY-CAPTURED
 * run events (not a new capture path), and an empty capture says so in words
 * rather than rendering a confident empty box. No DOM — renderToStaticMarkup
 * per the HostStatusRow.test.tsx pattern; every decision lives in the pure
 * model.
 */

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { ChatMessage, RunEventRecord } from '../../../main/store/types'
import { SeatFailureCard, SeatFailureCardView } from './SeatFailureCard'
import {
  SEAT_FAILURE_DETAIL_MAX_CHARS,
  SEAT_FAILURE_EMPTY_DETAIL_NOTE,
  classifySeatFailureRemedy,
  describeSeatFailure,
  isFailedParticipantStatusMessage,
  seatFailureDetailFromRunEvents,
  seatFailureParticipantId,
  seatFailureProvider,
  seatFailureRemedyNote,
  seatFailureSeatLabel
} from './SeatFailureCardModel'

function statusMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'ensemble-status-run-1',
    role: 'system',
    content: 'Review 1 failed.',
    timestamp: '2026-09-19T00:45:00.000Z',
    runId: 'run-1',
    metadata: {
      kind: 'ensembleParticipantStatus',
      ensembleRoundId: 'round-1',
      ensembleParticipantId: 'p7',
      ensembleProvider: 'grok',
      ensembleRole: 'Review 1',
      ensembleStatus: 'failed'
    },
    ...overrides
  }
}

function runEvent(kind: string, payload: unknown, sequence: number): RunEventRecord {
  return {
    schemaVersion: 1,
    id: `evt-${sequence}`,
    sequence,
    runId: 'run-1',
    kind,
    phase: 'run',
    source: 'provider',
    timestamp: `2026-09-19T00:44:${String(sequence).padStart(2, '0')}.000Z`,
    payload
  } as unknown as RunEventRecord
}

describe('isFailedParticipantStatusMessage', () => {
  it('matches only the failed participant coda', () => {
    expect(isFailedParticipantStatusMessage(statusMessage())).toBe(true)
  })

  it('does not match yielded, skipped, or non-coda rows', () => {
    expect(
      isFailedParticipantStatusMessage(
        statusMessage({ metadata: { ...statusMessage().metadata, ensembleStatus: 'yielded' } })
      )
    ).toBe(false)
    expect(
      isFailedParticipantStatusMessage(statusMessage({ role: 'error' as ChatMessage['role'] }))
    ).toBe(false)
    expect(isFailedParticipantStatusMessage({ role: 'system', metadata: undefined })).toBe(false)
  })
})

describe('seatFailureSeatLabel', () => {
  it('prefers the seat role, then the provider label, then a generic noun', () => {
    expect(seatFailureSeatLabel(statusMessage())).toBe('Review 1')
    expect(
      seatFailureSeatLabel(
        statusMessage({ metadata: { ...statusMessage().metadata, ensembleRole: undefined } })
      )
    ).toBe('Grok')
    expect(seatFailureSeatLabel({ metadata: undefined })).toBe('A participant')
  })
})

describe('describeSeatFailure', () => {
  it('pairs the calm seat copy with the untouched status line', () => {
    const description = describeSeatFailure(statusMessage())
    expect(description.kind).toBe('seat-failed')
    expect(description.kicker).toBe('Participant error')
    expect(description.title).toBe("Review 1 couldn't finish this turn")
    expect(description.body).toContain('transcript is intact')
    expect(description.raw).toBe('Review 1 failed.')
  })

  it('takes its headline from the classified remedy, not the generic title', () => {
    expect(describeSeatFailure(statusMessage(), 'usage-limit').title).toBe(
      'Review 1 hit a usage limit'
    )
    expect(describeSeatFailure(statusMessage(), 'auth').title).toBe(
      'Review 1 needs you to sign in again'
    )
    expect(describeSeatFailure(statusMessage(), 'model-retired').title).toBe(
      'Review 1’s model was retired'
    )
    expect(describeSeatFailure(statusMessage(), 'dispatch').title).toBe('Review 1 couldn’t start')
    expect(describeSeatFailure(statusMessage(), 'network').title).toBe('Review 1 couldn’t connect')
  })

  it('classifies the dispatch-failure coda eagerly from the raw line', () => {
    const dispatchMsg = statusMessage({
      metadata: { ...statusMessage().metadata, ensembleRole: 'Codex' },
      content:
        'Codex failed. [participant-health] ⚠ Codex / Codex dispatch failed. Skipping for this round.'
    })
    expect(classifySeatFailureRemedy(dispatchMsg.content)).toBe('dispatch')
    expect(describeSeatFailure(dispatchMsg, 'dispatch').title).toBe('Codex couldn’t start')
  })
})

describe('seatFailureParticipantId', () => {
  it('reads the roster id off the coda metadata', () => {
    expect(seatFailureParticipantId(statusMessage())).toBe('p7')
    expect(seatFailureParticipantId({ metadata: undefined })).toBeUndefined()
    expect(
      seatFailureParticipantId({
        metadata: { ...statusMessage().metadata, ensembleParticipantId: '  ' }
      })
    ).toBeUndefined()
  })
})

describe('seatFailureDetailFromRunEvents', () => {
  it('extracts stderr from provider_error events in sequence order', () => {
    const detail = seatFailureDetailFromRunEvents([
      runEvent('provider_error', { error: 'second line' }, 2),
      runEvent('provider_error', { error: 'first line' }, 1)
    ])
    expect(detail).not.toBeNull()
    expect(detail!.text).toBe('first line\nsecond line')
    expect(detail!.truncated).toBe(false)
  })

  it('falls back to provider_exit info when stderr stayed silent', () => {
    const detail = seatFailureDetailFromRunEvents([
      runEvent('provider_exit', 'exited with code 1', 3)
    ])
    expect(detail!.text).toBe('exited with code 1')
  })

  it('returns null when no event produced text', () => {
    expect(seatFailureDetailFromRunEvents([])).toBeNull()
    expect(seatFailureDetailFromRunEvents([runEvent('provider_error', {}, 1)])).toBeNull()
  })

  it('bounds a stderr flood to the tail', () => {
    const detail = seatFailureDetailFromRunEvents([
      runEvent('provider_error', { error: 'x'.repeat(SEAT_FAILURE_DETAIL_MAX_CHARS + 500) }, 1)
    ])
    expect(detail!.truncated).toBe(true)
    expect(detail!.text.length).toBe(SEAT_FAILURE_DETAIL_MAX_CHARS)
  })
})

describe('SeatFailureCardView', () => {
  const description = describeSeatFailure(statusMessage())

  it('renders the calm surface with the seat identity and copy action', () => {
    const html = renderToStaticMarkup(
      <SeatFailureCardView
        description={description}
        detailState="idle"
        detailEmpty={false}
        detailTruncated={false}
        onToggleDetails={() => undefined}
        onCopy={() => undefined}
        copied={false}
      />
    )
    expect(html).toContain('Review 1 couldn&#x27;t finish this turn')
    expect(html).toContain('Participant error')
    expect(html).toContain('Copy details')
    expect(html).toContain('Technical details')
    expect(html).not.toContain('Restart Host')
  })

  it('shows the loading state inside the open disclosure', () => {
    const html = renderToStaticMarkup(
      <SeatFailureCardView
        description={description}
        detailState="loading"
        detailEmpty={false}
        detailTruncated={false}
        detailsOpen
        onToggleDetails={() => undefined}
        onCopy={() => undefined}
        copied={false}
      />
    )
    expect(html).toContain('Loading captured output…')
  })

  it('shows the captured stderr inside the open disclosure', () => {
    const html = renderToStaticMarkup(
      <SeatFailureCardView
        description={description}
        detailState="ready"
        detailText={'TypeError: cannot read properties of undefined'}
        detailEmpty={false}
        detailTruncated={false}
        detailsOpen
        onToggleDetails={() => undefined}
        onCopy={() => undefined}
        copied={false}
      />
    )
    expect(html).toContain('TypeError: cannot read properties of undefined')
    expect(html).not.toContain(SEAT_FAILURE_EMPTY_DETAIL_NOTE)
  })

  it('says so in words when no output was captured, above the status line', () => {
    const html = renderToStaticMarkup(
      <SeatFailureCardView
        description={description}
        detailState="ready"
        detailEmpty
        detailTruncated={false}
        detailsOpen
        onToggleDetails={() => undefined}
        onCopy={() => undefined}
        copied={false}
      />
    )
    expect(html).toContain(SEAT_FAILURE_EMPTY_DETAIL_NOTE)
    expect(html).toContain('Review 1 failed.')
  })

  it('renders the Retry action only when a retry handler is supplied', () => {
    const withRetry = renderToStaticMarkup(
      <SeatFailureCardView
        description={description}
        detailState="idle"
        detailEmpty={false}
        detailTruncated={false}
        onRetry={() => undefined}
        onToggleDetails={() => undefined}
        onCopy={() => undefined}
        copied={false}
      />
    )
    expect(withRetry).toContain('Retry')

    const withoutRetry = renderToStaticMarkup(
      <SeatFailureCardView
        description={description}
        detailState="idle"
        detailEmpty={false}
        detailTruncated={false}
        onToggleDetails={() => undefined}
        onCopy={() => undefined}
        copied={false}
      />
    )
    expect(withoutRetry).not.toContain('Retry')
  })

  it('shows the retry outcome note in place of the question slot', () => {
    const html = renderToStaticMarkup(
      <SeatFailureCardView
        description={description}
        detailState="idle"
        detailEmpty={false}
        detailTruncated={false}
        onRetry={() => undefined}
        retryNote="Retry sent — a fresh round scoped to this seat is starting."
        onToggleDetails={() => undefined}
        onCopy={() => undefined}
        copied={false}
      />
    )
    expect(html).toContain('Retry sent — a fresh round scoped to this seat is starting.')
  })

  it('renders the auth remedy: note, login button, and no picker', () => {
    const html = renderToStaticMarkup(
      <SeatFailureCardView
        description={description}
        detailState="ready"
        detailEmpty={false}
        detailTruncated={false}
        remedyNote={seatFailureRemedyNote('auth', 'codex')}
        loginLabel="Log in to Codex"
        onLogin={() => undefined}
        onRetry={() => undefined}
        onToggleDetails={() => undefined}
        onCopy={() => undefined}
        copied={false}
      />
    )
    expect(html).toContain('sign-in problem')
    expect(html).toContain('Log in to Codex')
    expect(html).toContain('Retry')
  })

  it('renders the usage-limit remedy with the model swap slot', () => {
    const html = renderToStaticMarkup(
      <SeatFailureCardView
        description={description}
        detailState="ready"
        detailEmpty={false}
        detailTruncated={false}
        remedyNote={seatFailureRemedyNote('usage-limit', 'grok')}
        modelSwap={<button type="button">Model picker pill</button>}
        onRetry={() => undefined}
        onToggleDetails={() => undefined}
        onCopy={() => undefined}
        copied={false}
      />
    )
    expect(html).toContain('Grok hit a usage limit')
    expect(html).toContain('Model picker pill')
  })
})

describe('classifySeatFailureRemedy', () => {
  it('classifies from the captured stderr first, then the coda line', () => {
    expect(classifySeatFailureRemedy('HTTP error: 403 Forbidden')).toBe('auth')
    expect(classifySeatFailureRemedy('Codex failed.', '429 too many requests')).toBe('usage-limit')
    expect(classifySeatFailureRemedy(undefined, 'Review 1 failed.')).toBeNull()
  })
})

describe('seatFailureProvider', () => {
  it('reads the provider id off the coda metadata', () => {
    expect(seatFailureProvider(statusMessage())).toBe('grok')
    expect(seatFailureProvider({ metadata: undefined })).toBeUndefined()
  })
})

describe('SeatFailureCard', () => {
  it('renders the idle card without firing the fetch', () => {
    const client = { getRunEvents: vi.fn() }
    const html = renderToStaticMarkup(
      <SeatFailureCard
        message={statusMessage()}
        onCopy={() => undefined}
        runEventsClient={client}
      />
    )
    expect(html).toContain('Review 1 couldn&#x27;t finish this turn')
    expect(client.getRunEvents).not.toHaveBeenCalled()
  })

  it('offers Retry with the coda participant id and surfaces the outcome note', () => {
    const onRetryParticipant = vi.fn((_participantId: string): { ok: false; reason: string } => ({
      ok: false,
      reason: 'Retry: no chat is selected.'
    }))
    const html = renderToStaticMarkup(
      <SeatFailureCard
        message={statusMessage()}
        onCopy={() => undefined}
        onRetryParticipant={onRetryParticipant}
        runEventsClient={{ getRunEvents: vi.fn() }}
      />
    )
    expect(html).toContain('Retry')
  })

  it('omits Retry when the coda carries no participant id', () => {
    const html = renderToStaticMarkup(
      <SeatFailureCard
        message={statusMessage({
          metadata: { ...statusMessage().metadata, ensembleParticipantId: undefined }
        })}
        onCopy={() => undefined}
        onRetryParticipant={(_participantId: string) => ({
          ok: false as const,
          reason: 'Retry: no chat is selected.'
        })}
        runEventsClient={{ getRunEvents: vi.fn() }}
      />
    )
    expect(html).not.toContain('>Retry<')
  })
})
