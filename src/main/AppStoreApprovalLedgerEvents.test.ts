import fs from 'fs'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppStore } from './store'
import type { AgentApprovalAction } from './store/types'

const userDataPath = vi.hoisted(
  () => `/tmp/taskwraith-app-store-approval-events-test-${process.pid}`
)

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  }
}))

const legacyPath = join(userDataPath, 'approval-ledger.json')
const snapshotPath = join(userDataPath, 'approval-ledger-v2.snapshot.json')
const eventsPath = join(userDataPath, 'approval-ledger-v2.events.jsonl')
const originalEventFlag = process.env.TASKWRAITH_APPROVAL_LEDGER_EVENTS

function request(approvalId: string, requestedAt?: string) {
  return {
    approvalId,
    provider: 'codex' as const,
    service: 'shellCommands' as const,
    method: 'codex-mcp/run_shell_command',
    title: `Approve ${approvalId}`,
    actions: ['accept', 'decline'] as AgentApprovalAction[],
    ...(requestedAt ? { requestedAt } : {})
  }
}

beforeEach(() => {
  delete process.env.TASKWRAITH_APPROVAL_LEDGER_EVENTS
  fs.rmSync(userDataPath, { recursive: true, force: true })
  AppStore.resetTransientDeletionGuardsForTests()
})

afterAll(() => {
  fs.rmSync(userDataPath, { recursive: true, force: true })
  if (originalEventFlag === undefined) delete process.env.TASKWRAITH_APPROVAL_LEDGER_EVENTS
  else process.env.TASKWRAITH_APPROVAL_LEDGER_EVENTS = originalEventFlag
  AppStore.resetApprovalLedgerEventStoreForTests()
})

describe('AppStore approval ledger event persistence', () => {
  it('is lazy and default-on, with cached reads and record-sized hot events', () => {
    expect(fs.existsSync(snapshotPath)).toBe(false)
    expect(fs.existsSync(eventsPath)).toBe(false)

    AppStore.recordApprovalRequest(request('approval-1'))
    const afterPut = fs.statSync(eventsPath).size
    const snapshotBeforeReads = fs.readFileSync(snapshotPath, 'utf8')

    expect(fs.existsSync(legacyPath)).toBe(false)
    expect(AppStore.getApprovalLedger({ approvalId: 'approval-1' })).toHaveLength(1)
    expect(AppStore.getApprovalLedger({ approvalId: 'approval-1' })).toHaveLength(1)
    expect(fs.statSync(eventsPath).size).toBe(afterPut)
    expect(fs.readFileSync(snapshotPath, 'utf8')).toBe(snapshotBeforeReads)

    expect(AppStore.resolveApprovalRequest('approval-1', 'accept')?.status).toBe('approved')
    expect(fs.statSync(eventsPath).size).toBeGreaterThan(afterPut)
    expect(AppStore.resolveApprovalRequest('approval-1', 'decline')).toBeNull()
    expect(AppStore.getApprovalLedgerEventStoreStatsForTests()).toMatchObject({
      appends: 2,
      sequence: 2
    })
  })

  it('replays the cached projection after the process-local store is reset', () => {
    AppStore.recordApprovalRequest(request('approval-replay'))
    AppStore.resolveApprovalRequest('approval-replay', 'decline')
    AppStore.resetApprovalLedgerEventStoreForTests()

    expect(AppStore.getApprovalLedger({ approvalId: 'approval-replay' })[0]).toMatchObject({
      status: 'denied',
      decision: 'decline'
    })
    expect(AppStore.getApprovalLedgerEventStoreStatsForTests()).toMatchObject({
      replayedEvents: 2,
      sequence: 2
    })
  })

  it('recovers an elapsed pending deadline before accepting a late decision', () => {
    AppStore.recordApprovalRequest(request('approval-expired', '2020-01-01T00:00:00.000Z'))

    expect(AppStore.resolveApprovalRequest('approval-expired', 'accept')).toBeNull()
    expect(
      AppStore.getApprovalLedger({ approvalId: 'approval-expired', includeExpired: true })[0]
    ).toMatchObject({ status: 'expired' })
    expect(fs.readFileSync(eventsPath, 'utf8')).not.toContain('replace_projection')
    expect(fs.readFileSync(eventsPath, 'utf8')).toContain('pending_timeout')
  })

  it('compacts only at the coarse event threshold', () => {
    for (let index = 0; index < 255; index += 1) {
      AppStore.recordApprovalRequest(request(`approval-${index}`))
    }
    expect(fs.existsSync(legacyPath)).toBe(false)
    expect(fs.statSync(eventsPath).size).toBeGreaterThan(0)

    AppStore.recordApprovalRequest(request('approval-255'))

    expect(fs.existsSync(legacyPath)).toBe(true)
    expect(fs.readFileSync(eventsPath, 'utf8')).toBe('')
    expect(AppStore.getApprovalLedgerEventStoreStatsForTests()).toMatchObject({
      appends: 256,
      compactions: 1,
      sequence: 256
    })
  })

  it('keeps the v1 array store byte-compatible behind the escape flag', () => {
    process.env.TASKWRAITH_APPROVAL_LEDGER_EVENTS = '0'
    AppStore.resetApprovalLedgerEventStoreForTests()

    AppStore.recordApprovalRequest(request('legacy-only'))

    const parsed = JSON.parse(fs.readFileSync(legacyPath, 'utf8'))
    expect(fs.readFileSync(legacyPath, 'utf8')).toBe(JSON.stringify(parsed, null, 2))
    expect(fs.existsSync(snapshotPath)).toBe(false)
    expect(fs.existsSync(eventsPath)).toBe(false)
    expect(AppStore.getApprovalLedgerEventStoreStatsForTests()).toBeNull()
  })

  it('purges v2 authority files during a global clear even under the v1 escape', () => {
    AppStore.recordApprovalRequest(request('before-rollback'))
    AppStore.compactApprovalLedgerEventStoreForTests()
    process.env.TASKWRAITH_APPROVAL_LEDGER_EVENTS = '0'
    AppStore.resetApprovalLedgerEventStoreForTests()

    AppStore.clearChats()

    expect(fs.existsSync(legacyPath)).toBe(false)
    expect(fs.existsSync(snapshotPath)).toBe(false)
    expect(fs.existsSync(eventsPath)).toBe(false)
  })
})
