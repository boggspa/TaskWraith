import { describe, expect, it } from 'vitest'
import type { ChatRecord, RunEventRecord } from '../store/types'
import { createKimiGatewayReadiness } from './KimiGatewayReadiness'
import {
  createKimiRunCapabilityReceipt,
  kimiAssignedRunScope,
  latestKimiRunCapabilityReceipt
} from './KimiRunCapabilities'

describe('Kimi capability evidence scope', () => {
  it('uses only the exact run and participant lane scope', () => {
    const chat = {
      ensemble: {
        activeRound: {
          lanes: {
            lane: {
              runId: 'run',
              participantId: 'worker',
              intent: 'write',
              approvedWriteScopes: [
                { kind: 'path', path: 'src/owned.ts', reason: 'do not copy prose' }
              ]
            }
          }
        }
      }
    } as unknown as ChatRecord
    expect(kimiAssignedRunScope(chat, 'run', 'lane', 'worker')).toEqual({
      kind: 'lane',
      intent: 'write',
      paths: [{ kind: 'path', path: 'src/owned.ts' }]
    })
    expect(kimiAssignedRunScope(chat, 'other-run', 'lane', 'worker')).toEqual({
      kind: 'unknown',
      paths: []
    })
    expect(kimiAssignedRunScope(chat, 'run', 'lane', 'other-seat')).toEqual({
      kind: 'unknown',
      paths: []
    })
  })

  it('returns the latest main receipt without accepting provider prose or another run', () => {
    const receipt = createKimiRunCapabilityReceipt(
      { runId: 'run', chatId: 'chat', assignedScope: { kind: 'workspace', paths: [] } },
      createKimiGatewayReadiness().snapshot()
    )
    const row = {
      runId: 'run',
      chatId: 'chat',
      provider: 'kimi',
      source: 'main',
      kind: 'lifecycle',
      sequence: 1,
      payload: { type: 'kimi_capability_receipt', capabilityReceipt: receipt }
    } as RunEventRecord
    expect(latestKimiRunCapabilityReceipt([row], 'run', 'chat')).toEqual(receipt)
    expect(
      latestKimiRunCapabilityReceipt([{ ...row, source: 'provider' }], 'run', 'chat')
    ).toBeNull()
    expect(latestKimiRunCapabilityReceipt([row], 'different', 'chat')).toBeNull()
    expect(latestKimiRunCapabilityReceipt([row], 'run', 'different')).toBeNull()
    const latest = { ...receipt, phase: 'blocked' as const, blocker: 'missing tools' }
    const next = {
      ...row,
      sequence: 2,
      payload: { type: 'kimi_capability_receipt', capabilityReceipt: latest }
    }
    expect(latestKimiRunCapabilityReceipt([next, row], 'run', 'chat')).toEqual(latest)
  })
})
