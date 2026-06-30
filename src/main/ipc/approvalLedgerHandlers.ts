import { ipcMain } from 'electron'
import type { ApprovalLedgerFilter, ApprovalLedgerRequestInput, ProviderId } from '../store/types'

interface ApprovalElevationAckInput {
  provider: string
  workspacePath: string | null
  toMode: string
  tier: number
}

export interface ApprovalLedgerHandlersDeps {
  getApprovalLedger: (filter?: ApprovalLedgerFilter) => unknown
  recordApprovalLedgerDecision: (input: ApprovalLedgerRequestInput) => void
  randomUUID: () => string
  getNowIso: () => string
}

export function registerApprovalLedgerHandlers(deps: ApprovalLedgerHandlersDeps): void {
  ipcMain.handle('get-approval-ledger', (_, filter?: ApprovalLedgerFilter) =>
    deps.getApprovalLedger(filter || {})
  )

  // This is a terminal acknowledgement row, not a pending approval request.
  ipcMain.handle('record-approval-elevation-ack', (_, input: ApprovalElevationAckInput) => {
    const provider = (input?.provider || '').trim() as ProviderId
    const toMode = String(input?.toMode || '').trim()
    const tier = Number(input?.tier) || 0
    const now = deps.getNowIso()
    const note = `User acknowledged elevation to ${toMode} (Tier ${tier})`
    const record: ApprovalLedgerRequestInput = {
      approvalId: `approval-mode-elevation:${deps.randomUUID()}`,
      provider,
      method: 'approval/mode-elevation',
      title: `Approval mode raised to ${toMode}`,
      body: note,
      actions: [],
      status: 'approved',
      requestedAt: now,
      respondedAt: now,
      decision: 'accept',
      decisionSource: 'user',
      grantedScope: 'request',
      expiration: {
        mode: 'none',
        description: note
      },
      workspacePath: input?.workspacePath || undefined,
      metadata: {
        elevation: { toMode, tier },
        intentNote: note
      }
    }

    deps.recordApprovalLedgerDecision(record)
  })
}
