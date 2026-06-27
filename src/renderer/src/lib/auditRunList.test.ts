import { afterEach, describe, expect, it } from 'vitest'
import type { AuditRunRecord } from '../../../main/store/types'
import {
  DISMISSED_AUDIT_RUNS_STORAGE_KEY,
  auditActionErrorMessage,
  readDismissedAuditRunIds,
  sortAuditRuns,
  upsertAuditRunList,
  writeDismissedAuditRunIds
} from './auditRunList'

const originalWindow = globalThis.window

function auditRun(overrides: Partial<AuditRunRecord> = {}): AuditRunRecord {
  return {
    schemaVersion: 1,
    id: 'audit-1',
    mode: 'quick',
    chatId: 'chat-1',
    workspacePath: '/repo',
    status: 'completed',
    phases: [],
    dimensions: [],
    participants: [],
    findings: [],
    verdicts: [],
    gates: [],
    budget: { maxAgents: 12, spentAgents: 1, spentTokens: 0, truncated: false },
    createdAt: '2026-06-13T18:00:00.000Z',
    updatedAt: '2026-06-13T18:00:00.000Z',
    ...overrides
  }
}

function installMockStorage(initial: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(initial))
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
        setItem: (key: string, value: string) => {
          store.set(key, value)
        }
      }
    }
  })
  return store
}

afterEach(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow
  })
})

describe('audit run list helpers', () => {
  it('sorts by the freshest available audit timestamp without mutating input', () => {
    const oldRun = auditRun({ id: 'old', updatedAt: '2026-06-13T18:00:00.000Z' })
    const endedRun = auditRun({
      id: 'ended',
      updatedAt: undefined,
      endedAt: '2026-06-13T20:00:00.000Z'
    })
    const createdRun = auditRun({
      id: 'created',
      updatedAt: undefined,
      createdAt: '2026-06-13T19:00:00.000Z'
    })
    const runs = [oldRun, endedRun, createdRun]

    expect(sortAuditRuns(runs).map((run) => run.id)).toEqual(['ended', 'created', 'old'])
    expect(runs.map((run) => run.id)).toEqual(['old', 'ended', 'created'])
  })

  it('upserts a run, replaces older copies, and caps the newest list at 30', () => {
    const runs = Array.from({ length: 31 }, (_, index) =>
      auditRun({
        id: `audit-${index}`,
        updatedAt: `2026-06-13T18:${String(index).padStart(2, '0')}:00.000Z`
      })
    )

    const updated = upsertAuditRunList(
      runs,
      auditRun({ id: 'audit-1', updatedAt: '2026-06-13T20:00:00.000Z' })
    )

    expect(updated).toHaveLength(30)
    expect(updated[0].id).toBe('audit-1')
    expect(updated.filter((run) => run.id === 'audit-1')).toHaveLength(1)
  })

  it('normalizes audit action error messages', () => {
    expect(auditActionErrorMessage('Fallback.', new Error(' Nope. '))).toBe('Nope.')
    expect(auditActionErrorMessage('Fallback.', ' Also nope. ')).toBe('Also nope.')
    expect(auditActionErrorMessage('Fallback.', new Error('   '))).toBe('Fallback.')
    expect(auditActionErrorMessage('Fallback.', null)).toBe('Fallback.')
  })

  it('reads dismissed audit ids from localStorage and filters invalid entries', () => {
    installMockStorage({
      [DISMISSED_AUDIT_RUNS_STORAGE_KEY]: JSON.stringify(['audit-1', 2, 'audit-2'])
    })

    expect([...readDismissedAuditRunIds()]).toEqual(['audit-1', 'audit-2'])
  })

  it('returns an empty dismissed id set when storage is unavailable or malformed', () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: undefined })
    expect(readDismissedAuditRunIds()).toEqual(new Set())

    installMockStorage({ [DISMISSED_AUDIT_RUNS_STORAGE_KEY]: '{' })
    expect(readDismissedAuditRunIds()).toEqual(new Set())
  })

  it('writes the last 100 dismissed audit ids to localStorage', () => {
    const store = installMockStorage()
    const ids = new Set(Array.from({ length: 105 }, (_, index) => `audit-${index}`))

    writeDismissedAuditRunIds(ids)

    const stored = JSON.parse(store.get(DISMISSED_AUDIT_RUNS_STORAGE_KEY) || '[]')
    expect(stored).toHaveLength(100)
    expect(stored[0]).toBe('audit-5')
    expect(stored[99]).toBe('audit-104')
  })
})
