import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { registerApprovalLedgerHandlers } from './approvalLedgerHandlers'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function createDeps() {
  return {
    getApprovalLedger: vi.fn((filter = {}) => [{ id: 'ledger-1', filter }]),
    recordApprovalLedgerDecision: vi.fn(),
    randomUUID: vi.fn(() => 'uuid-123'),
    getNowIso: vi.fn(() => '2026-06-30T12:00:00.000Z')
  }
}

describe('registerApprovalLedgerHandlers', () => {
  it('registers approval ledger IPC channels', () => {
    registerApprovalLedgerHandlers(createDeps())

    expect(handlerFor('get-approval-ledger')).toBeTypeOf('function')
    expect(handlerFor('record-approval-elevation-ack')).toBeTypeOf('function')
  })

  it('routes approval ledger reads through deps and defaults empty filters', () => {
    const deps = createDeps()
    registerApprovalLedgerHandlers(deps)

    const handler = handlerFor('get-approval-ledger')

    expect(handler({}, { provider: 'codex' })).toEqual([{ id: 'ledger-1', filter: { provider: 'codex' } }])
    expect(deps.getApprovalLedger).toHaveBeenCalledWith({ provider: 'codex' })

    expect(handler({}, undefined)).toEqual([{ id: 'ledger-1', filter: {} }])
    expect(deps.getApprovalLedger).toHaveBeenLastCalledWith({})
  })

  it('records approval elevation acknowledgements with normalized ledger entries', () => {
    const deps = createDeps()
    registerApprovalLedgerHandlers(deps)

    handlerFor('record-approval-elevation-ack')({}, {
      provider: ' codex ',
      workspacePath: null,
      toMode: ' auto ',
      tier: '3'
    })

    expect(deps.getNowIso).toHaveBeenCalledOnce()
    expect(deps.randomUUID).toHaveBeenCalledOnce()
    expect(deps.recordApprovalLedgerDecision).toHaveBeenCalledTimes(1)

    const record = deps.recordApprovalLedgerDecision.mock.calls[0]?.[0]
    expect(record).toMatchObject({
      approvalId: 'approval-mode-elevation:uuid-123',
      provider: 'codex',
      method: 'approval/mode-elevation',
      title: 'Approval mode raised to auto',
      body: 'User acknowledged elevation to auto (Tier 3)',
      actions: [],
      status: 'approved',
      requestedAt: '2026-06-30T12:00:00.000Z',
      respondedAt: '2026-06-30T12:00:00.000Z',
      decision: 'accept',
      decisionSource: 'user',
      grantedScope: 'request',
      expiration: {
        mode: 'none',
        description: 'User acknowledged elevation to auto (Tier 3)'
      },
      metadata: {
        elevation: { toMode: 'auto', tier: 3 },
        intentNote: 'User acknowledged elevation to auto (Tier 3)'
      }
    })
    expect(record.workspacePath).toBeUndefined()
  })
})
