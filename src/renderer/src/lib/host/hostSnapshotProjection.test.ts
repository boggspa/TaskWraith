/**
 * Wave 4.3a — Desktop projection mapper tests.
 *
 * These pin the three honesty rules from the arc goal. They are written to
 * fail loudly on the specific dishonest outcome, not merely to exercise the
 * mapper: "unavailable becomes 0" and "cached renders as live" are the two
 * failures that would silently mislead a user, so each has a direct test.
 */

import { describe, expect, it } from 'vitest'

import type { HostSnapshot } from '../../../../shared/hostProtocol'
import { projectHealth, projectHostSnapshot, projectUsage } from './hostSnapshotProjection'

function snapshot(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    protocolVersion: 1,
    projectionVersion: 1,
    generatedAt: '2026-08-06T12:00:00.000Z',
    generation: 3,
    cursor: 42,
    freshness: 'live',
    health: {
      hostStatus: 'ok',
      connectionPhase: 'live',
      supervised: true,
      freshness: 'live'
    },
    workspaces: [],
    threads: [],
    runs: [],
    missions: [],
    rounds: [],
    participants: [],
    providers: [],
    questions: [],
    approvals: [],
    schedules: [],
    usage: { availability: 'unavailable', confidence: 'unknown', band: 'unknown' },
    artifacts: [],
    warnings: [],
    recovery: {},
    ...overrides
  } as unknown as HostSnapshot
}

/* ------------------------------------------------------------------ */
/*  Rule 2 — unavailable is not zero                                  */
/* ------------------------------------------------------------------ */

describe('projectUsage · unavailable is not zero', () => {
  it('returns undefined numbers, never 0, when usage is unavailable', () => {
    const usage = projectUsage({
      availability: 'unavailable',
      confidence: 'unknown',
      band: 'unknown'
    } as never)

    expect(usage.availability).toBe('unavailable')
    // The whole point: a 0 here would read as "nothing was spent", which is a
    // different and false claim from "we do not know".
    expect(usage.costUsd).toBeUndefined()
    expect(usage.tokens).toBeUndefined()
    expect(usage.costUsd).not.toBe(0)
    expect(usage.tokens).not.toBe(0)
  })

  it('treats a missing usage object as unavailable rather than empty', () => {
    expect(projectUsage(undefined).availability).toBe('unavailable')
  })

  it('passes through real numbers when Host actually measured them', () => {
    const usage = projectUsage({
      availability: 'available',
      confidence: 'high',
      band: 'known',
      costUsd: 1.25,
      tokens: 4096
    } as never)

    expect(usage.costUsd).toBe(1.25)
    expect(usage.tokens).toBe(4096)
  })

  it('drops non-finite numbers rather than emitting NaN/Infinity', () => {
    const usage = projectUsage({
      availability: 'available',
      confidence: 'high',
      band: 'known',
      costUsd: Number.NaN,
      tokens: Number.POSITIVE_INFINITY
    } as never)

    expect(usage.costUsd).toBeUndefined()
    expect(usage.tokens).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ */
/*  Rule 1 — cached is not live                                       */
/* ------------------------------------------------------------------ */

describe('projectHostSnapshot · cached is not live', () => {
  it('labels a freshly fetched snapshot live', () => {
    expect(projectHostSnapshot(snapshot(), 'live').freshness).toBe('live')
  })

  it('cannot be upgraded to live when HOST says the projection was cached', () => {
    // Enforced invariant, not a convention: even though the caller claims
    // 'live', Host's own cached marker wins.
    const result = projectHostSnapshot(snapshot({ freshness: 'cached' }), 'live')
    expect(result.freshness).toBe('cached')
  })

  it('cannot be upgraded to live when Host HEALTH was cached', () => {
    const result = projectHostSnapshot(
      snapshot({
        health: {
          hostStatus: 'ok',
          connectionPhase: 'live',
          supervised: true,
          freshness: 'cached'
        }
      }),
      'live'
    )
    expect(result.freshness).toBe('cached')
  })

  it('honours a caller-declared cached replay', () => {
    expect(projectHostSnapshot(snapshot(), 'cached').freshness).toBe('cached')
  })
})

/* ------------------------------------------------------------------ */
/*  Rule 3 — health is Host's, not the client's                       */
/* ------------------------------------------------------------------ */

describe('projectHealth · connection state is not run state', () => {
  it('carries Host status and supervision verbatim', () => {
    const health = projectHealth({
      hostStatus: 'degraded',
      connectionPhase: 'live',
      supervised: true,
      freshness: 'live',
      detail: 'donor slow'
    })

    expect(health.hostStatus).toBe('degraded')
    expect(health.supervised).toBe(true)
    expect(health.detail).toBe('donor slow')
  })

  it('exposes no client-connectivity field that could be mistaken for Host health', () => {
    const health = projectHealth({
      hostStatus: 'ok',
      connectionPhase: 'connecting',
      supervised: true,
      freshness: 'live'
    })

    // connectionPhase is deliberately NOT projected: it is transport state and
    // would invite a view to paint "connecting" as a degraded Host.
    expect(Object.keys(health).sort()).toEqual(['hostStatus', 'supervised'])
  })
})

/* ------------------------------------------------------------------ */
/*  Bounded projection                                                */
/* ------------------------------------------------------------------ */

describe('projectHostSnapshot · bounded content', () => {
  it('projects threads with preview flags and no transcript bodies', () => {
    const result = projectHostSnapshot(
      snapshot({
        threads: [
          {
            id: 't1',
            workspaceId: 'w1',
            title: 'Thread one',
            chatKind: 'ensemble',
            archived: false,
            pinned: true,
            updatedAt: 123,
            messageCount: 7,
            latestPreview: 'hello',
            previewTruncated: true,
            providerId: 'claude'
          }
        ] as never
      }),
      'live'
    )

    const thread = result.threads[0]
    expect(thread.id).toBe('t1')
    expect(thread.chatKind).toBe('ensemble')
    expect(thread.preview).toBe('hello')
    expect(thread.previewTruncated).toBe(true)
    expect(thread.providerId).toBe('claude')
    // No body-bearing field may appear on the row.
    expect(Object.keys(thread)).not.toContain('messages')
    expect(Object.keys(thread)).not.toContain('transcript')
  })

  it('reports family sizes as counts, never the rows themselves', () => {
    const result = projectHostSnapshot(
      snapshot({
        runs: [{}, {}] as never,
        approvals: [{}] as never
      }),
      'live'
    )

    expect(result.counts.runs).toBe(2)
    expect(result.counts.approvals).toBe(1)
    expect(result.counts.missions).toBe(0)
  })

  it('carries generation and cursor for later delta resumption', () => {
    const result = projectHostSnapshot(snapshot(), 'live')
    expect(result.generation).toBe(3)
    expect(result.cursor).toBe(42)
  })
})

/* ------------------------------------------------------------------ */
/*  Wave 5a — the providers family Host already sends                 */
/* ------------------------------------------------------------------ */

describe('projectHostSnapshot · providers', () => {
  it('projects the provider family that already arrives on the wire', () => {
    const projected = projectHostSnapshot(
      snapshot({
        providers: [
          {
            providerId: 'claude',
            displayProvider: 'Claude',
            shortCode: 'CL',
            available: true,
            modelId: 'opus-5',
            modelLabel: 'Opus 5'
          },
          {
            providerId: 'codex',
            displayProvider: 'Codex',
            shortCode: 'CX',
            available: false,
            note: 'not admitted'
          }
        ]
      }),
      'live'
    )

    expect(projected.providers).toHaveLength(2)
    expect(projected.providers[0]).toMatchObject({
      providerId: 'claude',
      displayProvider: 'Claude',
      shortCode: 'CL',
      available: true,
      modelId: 'opus-5',
      modelLabel: 'Opus 5'
    })
    expect(projected.providers[1]).toMatchObject({
      providerId: 'codex',
      available: false,
      note: 'not admitted'
    })
  })

  it('carries the availability note but never a credential-shaped field', () => {
    const projected = projectHostSnapshot(
      snapshot({
        providers: [
          {
            providerId: 'claude',
            displayProvider: 'Claude',
            shortCode: 'CL',
            available: false,
            note: 'no API key configured',
            apiKey: 'sk-must-never-cross',
            token: 'must-never-cross'
          }
        ]
      } as never),
      'live'
    )
    const row = projected.providers[0] as unknown as Record<string, unknown>
    expect(row.note).toBe('no API key configured')
    // The wire type says "never credentials"; the projection must not become
    // the place a secret leaks by structural spread.
    for (const key of ['apiKey', 'token', 'secret', 'credential']) {
      expect(row[key]).toBeUndefined()
    }
  })

  it('projects an empty provider list as a real empty answer', () => {
    const projected = projectHostSnapshot(snapshot({ providers: [] }), 'live')
    expect(projected.providers).toEqual([])
  })
})

/* ------------------------------------------------------------------ */
/*  Wave 5d — warning CODES reach the view model                      */
/* ------------------------------------------------------------------ */

describe('projectHostSnapshot · warning codes', () => {
  it('projects warning codes so a view can match on code, never on prose', () => {
    const projected = projectHostSnapshot(
      snapshot({
        warnings: [
          {
            warningId: 'provider_source_not_ready:providers',
            severity: 'info',
            code: 'provider_source_not_ready',
            message: 'provider discovery has not completed',
            at: 1
          }
        ]
      } as never),
      'live'
    )
    expect(projected.warningCodes).toContain('provider_source_not_ready')
  })

  it('projects an empty code list when Host reports no warnings', () => {
    const projected = projectHostSnapshot(snapshot({ warnings: [] }), 'live')
    expect(projected.warningCodes).toEqual([])
  })

  it('still counts warnings as well as naming them', () => {
    const projected = projectHostSnapshot(
      snapshot({
        warnings: [
          { warningId: 'a', severity: 'info', code: 'a', message: 'm', at: 1 },
          { warningId: 'b', severity: 'warning', code: 'b', message: 'm', at: 1 }
        ]
      } as never),
      'live'
    )
    expect(projected.counts.warnings).toBe(2)
    expect(projected.warningCodes).toEqual(['a', 'b'])
  })
})

/* ------------------------------------------------------------------ */
/*  Wave 5f — approval ROWS, not just a count                         */
/* ------------------------------------------------------------------ */

const approvalRow = (overrides: Record<string, unknown> = {}): never =>
  ({
    approvalId: 'chal-1',
    commandId: 'cmd-1',
    status: 'pending',
    actionKind: 'agent.run',
    createdAt: 10,
    summary: 'Deferred agent.run',
    ...overrides
  }) as never

describe('projectHostSnapshot · approvals', () => {
  it('projects the approval rows Host already sends, not only their count', () => {
    const projected = projectHostSnapshot(
      snapshot({
        approvals: [approvalRow(), approvalRow({ approvalId: 'chal-2', commandId: 'cmd-2' })]
      } as never),
      'live'
    )

    expect(projected.approvals).toHaveLength(2)
    expect(projected.approvals[0]).toMatchObject({
      approvalId: 'chal-1',
      commandId: 'cmd-1',
      status: 'pending',
      actionKind: 'agent.run',
      createdAt: 10
    })
  })

  it('keeps the existing count alongside the rows — additive, nothing removed', () => {
    const projected = projectHostSnapshot(snapshot({ approvals: [approvalRow()] } as never), 'live')
    expect(projected.counts.approvals).toBe(1)
    expect(projected.approvals).toHaveLength(1)
  })

  it('allowlists fields and does NOT carry the summary prose across the boundary', () => {
    const projected = projectHostSnapshot(
      snapshot({
        approvals: [
          approvalRow({
            summary: 'Deferred write to /Users/someone/secrets.txt',
            decisionSource: 'user',
            decidedAt: 99
          })
        ]
      } as never),
      'live'
    )
    const row = projected.approvals[0] as unknown as Record<string, unknown>
    // The leaf needs identity + kind + status. It does not render prose, so
    // prose does not cross. Same discipline as projectProvider in 5a.
    expect(row.summary).toBeUndefined()
    // Decided rows never reach the wire today, so projecting decision fields
    // would imply a capability Host does not have.
    expect(row.decidedAt).toBeUndefined()
    expect(row.decisionSource).toBeUndefined()
  })

  it('projects an empty approvals family as a real empty list', () => {
    const projected = projectHostSnapshot(snapshot({ approvals: [] }), 'live')
    expect(projected.approvals).toEqual([])
  })
})

/* ------------------------------------------------------------------ */
/*  Wave Track3 — question ROWS, not just a count                     */
/* ------------------------------------------------------------------ */

const questionRow = (overrides: Record<string, unknown> = {}): never =>
  ({
    questionId: 'q-1',
    threadId: 't-1',
    status: 'open',
    promptPreview: 'Continue?',
    askedAt: 20,
    ...overrides
  }) as never

describe('projectHostSnapshot · questions', () => {
  it('projects the question rows Host already sends, not only their count', () => {
    const projected = projectHostSnapshot(
      snapshot({
        questions: [
          questionRow(),
          questionRow({
            questionId: 'q-2',
            status: 'answered',
            answeredAt: 30,
            receiptId: 'rcpt-2'
          })
        ]
      } as never),
      'live'
    )

    expect(projected.questions).toHaveLength(2)
    expect(projected.questions[0]).toMatchObject({
      questionId: 'q-1',
      threadId: 't-1',
      status: 'open',
      promptPreview: 'Continue?',
      askedAt: 20
    })
    expect(projected.questions[1]).toMatchObject({
      questionId: 'q-2',
      status: 'answered',
      answeredAt: 30,
      receiptId: 'rcpt-2'
    })
  })

  it('keeps the existing count alongside the rows — additive, nothing removed', () => {
    const projected = projectHostSnapshot(snapshot({ questions: [questionRow()] } as never), 'live')
    expect(projected.counts.questions).toBe(1)
    expect(projected.questions).toHaveLength(1)
  })

  it('allowlists fields and does NOT carry an answer body across the boundary', () => {
    const projected = projectHostSnapshot(
      snapshot({
        questions: [
          questionRow({
            answerText: 'yes, proceed with the write',
            answerBody: 'must-never-cross',
            options: ['yes', 'no']
          })
        ]
      } as never),
      'live'
    )
    const row = projected.questions[0] as unknown as Record<string, unknown>
    expect(row.answerText).toBeUndefined()
    expect(row.answerBody).toBeUndefined()
    expect(row.options).toBeUndefined()
  })

  it('projects an empty questions family as a real empty list', () => {
    const projected = projectHostSnapshot(snapshot({ questions: [] }), 'live')
    expect(projected.questions).toEqual([])
    expect(projected.counts.questions).toBe(0)
  })
})
