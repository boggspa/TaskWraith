import { describe, expect, it, vi } from 'vitest'
import type { ExecutionGraphDiagnosticsSnapshot } from '../../../main/ipc/executionGraphHandlers'
import {
  EXECUTION_GRAPH_NOTICE_ID_PREFIX,
  EXECUTION_GRAPH_NOTICE_MESSAGE_MAX_CHARS,
  clearExecutionGraphNoticeFailure,
  deriveExecutionGraphDiagnosticNotices,
  executionGraphDiagnosticAppNotifications
} from './executionGraphDiagnosticNotices'

const ORPHAN = 'ultratask-4aff240d-7ecb-47d7-a3af-10cecdd5255c'
const OTHER = 'ultratask-101f9551-5b65-434d-a866-6e0b39e5fb03'
const REFUSED = 'Execution ledger changed before append for "ultratask-4aff240d".'

function snapshot(
  overrides: Partial<ExecutionGraphDiagnosticsSnapshot> = {}
): ExecutionGraphDiagnosticsSnapshot {
  return {
    schemaVersion: 1,
    repositoryDiagnostics: [],
    recoveryDiagnostics: [],
    serviceDiagnostics: [],
    ...overrides
  }
}

function handlers() {
  return {
    openStack: vi.fn((_executionId: string): void => {}),
    retryRecovery: vi.fn((_executionId: string): void => {}),
    archiveStack: vi.fn((_executionId: string): void => {})
  }
}

describe('deriveExecutionGraphDiagnosticNotices', () => {
  it('derives nothing from no snapshot or an empty one', () => {
    expect(deriveExecutionGraphDiagnosticNotices(null)).toEqual([])
    expect(deriveExecutionGraphDiagnosticNotices(undefined)).toEqual([])
    expect(deriveExecutionGraphDiagnosticNotices(snapshot())).toEqual([])
  })

  it('makes one notice per service, repository and recovery diagnostic with its severity, stack and actions', () => {
    const notices = deriveExecutionGraphDiagnosticNotices(
      snapshot({
        serviceDiagnostics: [{ code: 'initialization_failed', message: 'Registry unreadable.' }],
        repositoryDiagnostics: [
          {
            code: 'execution_ledger_corrupt',
            executionId: OTHER,
            fileName: `execution-${OTHER}.jsonl`,
            message: 'Ledger hash is corrupt.'
          }
        ],
        recoveryDiagnostics: [{ executionId: ORPHAN, message: REFUSED }]
      })
    )

    expect(notices).toEqual([
      {
        id: expect.stringMatching(new RegExp(`^${EXECUTION_GRAPH_NOTICE_ID_PREFIX}[0-9a-f]{16}$`)),
        kind: 'service',
        severity: 'error',
        title: 'Stack service needs attention',
        message: 'Registry unreadable.',
        actions: []
      },
      {
        id: expect.stringMatching(new RegExp(`^${EXECUTION_GRAPH_NOTICE_ID_PREFIX}[0-9a-f]{16}$`)),
        kind: 'repository',
        severity: 'error',
        executionId: OTHER,
        title: 'Stack history is damaged',
        message: 'Ledger hash is corrupt.',
        actions: []
      },
      {
        id: expect.stringMatching(new RegExp(`^${EXECUTION_GRAPH_NOTICE_ID_PREFIX}[0-9a-f]{16}$`)),
        kind: 'recovery',
        severity: 'warning',
        executionId: ORPHAN,
        title: 'Stack recovery paused',
        message: REFUSED,
        actions: ['open-stack', 'retry-recovery', 'archive-stack']
      }
    ])
    expect(new Set(notices.map((notice) => notice.id)).size).toBe(3)
  })

  it('redacts and bounds the message', () => {
    const long = 'x'.repeat(EXECUTION_GRAPH_NOTICE_MESSAGE_MAX_CHARS + 50)
    const [notice] = deriveExecutionGraphDiagnosticNotices(
      snapshot({ recoveryDiagnostics: [{ executionId: ORPHAN, message: `token=abc ${long}` }] }),
      (value) => value.replace('token=abc', 'token=[redacted]')
    )
    expect(notice.message.startsWith('token=[redacted] ')).toBe(true)
    expect(notice.message).toHaveLength(EXECUTION_GRAPH_NOTICE_MESSAGE_MAX_CHARS)
  })

  it('collapses duplicates of the same stack and message, and keeps ids stable across launches', () => {
    const launch = () =>
      deriveExecutionGraphDiagnosticNotices(
        snapshot({
          recoveryDiagnostics: [
            { executionId: ORPHAN, message: REFUSED },
            { executionId: ORPHAN, message: REFUSED },
            { executionId: ORPHAN, message: 'A different refusal.' },
            { executionId: OTHER, message: REFUSED }
          ]
        })
      )
    const first = launch()
    const second = launch()

    expect(first).toHaveLength(3)
    expect(first.map((notice) => [notice.executionId, notice.message])).toEqual([
      [ORPHAN, REFUSED],
      [ORPHAN, 'A different refusal.'],
      [OTHER, REFUSED]
    ])
    expect(new Set(first.map((notice) => notice.id)).size).toBe(3)
    expect(second.map((notice) => notice.id)).toEqual(first.map((notice) => notice.id))
  })

  it('re-derives from a refreshed snapshot so a resolved diagnostic has no notice', () => {
    const before = deriveExecutionGraphDiagnosticNotices(
      snapshot({
        recoveryDiagnostics: [
          { executionId: ORPHAN, message: REFUSED },
          { executionId: OTHER, message: REFUSED }
        ]
      })
    )
    const after = deriveExecutionGraphDiagnosticNotices(
      snapshot({ recoveryDiagnostics: [{ executionId: OTHER, message: REFUSED }] })
    )
    expect(before).toHaveLength(2)
    expect(after.map((notice) => notice.executionId)).toEqual([OTHER])
    expect(after[0].id).toBe(before[1].id)
  })
})

describe('executionGraphDiagnosticAppNotifications', () => {
  const recovery = () =>
    deriveExecutionGraphDiagnosticNotices(
      snapshot({ recoveryDiagnostics: [{ executionId: ORPHAN, message: REFUSED }] })
    )

  it('builds a dismissible warning card that names the stack and offers the three actions', () => {
    const [card] = executionGraphDiagnosticAppNotifications(recovery(), handlers())

    expect(card).toMatchObject({
      id: recovery()[0].id,
      kind: 'warning',
      title: 'Stack recovery paused',
      body: `Stack ${ORPHAN}: ${REFUSED}`,
      dismissible: true,
      actions: [
        { id: 'open-stack', label: 'Open stack' },
        { id: 'retry-recovery', label: 'Retry recovery' },
        { id: 'archive-stack', label: 'Archive stack', tone: 'danger' }
      ]
    })
  })

  it('dispatches each action to its handler with the stack id and ignores anything else', () => {
    const h = handlers()
    const [card] = executionGraphDiagnosticAppNotifications(recovery(), h)

    card.onAction?.('open-stack')
    card.onAction?.('retry-recovery')
    card.onAction?.('archive-stack')
    card.onAction?.('delete-ledger')

    expect(h.openStack).toHaveBeenCalledWith(ORPHAN)
    expect(h.retryRecovery).toHaveBeenCalledWith(ORPHAN)
    expect(h.archiveStack).toHaveBeenCalledWith(ORPHAN)
    expect(h.openStack).toHaveBeenCalledTimes(1)
    expect(h.retryRecovery).toHaveBeenCalledTimes(1)
    expect(h.archiveStack).toHaveBeenCalledTimes(1)
  })

  it('renders service failures as red cards with no actions and no stack label', () => {
    const [card] = executionGraphDiagnosticAppNotifications(
      deriveExecutionGraphDiagnosticNotices(
        snapshot({
          serviceDiagnostics: [
            { code: 'startup_recovery_failed', message: 'Owner index unavailable.' }
          ]
        })
      ),
      handlers()
    )
    expect(card).toMatchObject({ kind: 'error', body: 'Owner index unavailable.' })
    expect(card.actions).toBeUndefined()
    const h = handlers()
    executionGraphDiagnosticAppNotifications(recovery(), h)[0].onAction?.('open-stack')
    expect(() => card.onAction?.('open-stack')).not.toThrow()
  })

  it('appends the last refused action for that stack to its copy', () => {
    const failures = { [ORPHAN]: 'Archive refused: step "scout-1" still holds a live queue row.' }
    const [card] = executionGraphDiagnosticAppNotifications(recovery(), handlers(), failures)
    expect(card.body).toBe(
      `Stack ${ORPHAN}: ${REFUSED} Archive refused: step "scout-1" still holds a live queue row.`
    )
    expect(clearExecutionGraphNoticeFailure(failures, ORPHAN)).toEqual({})
    expect(clearExecutionGraphNoticeFailure(failures, OTHER)).toBe(failures)
  })
})
