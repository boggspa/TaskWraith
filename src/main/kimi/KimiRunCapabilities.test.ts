import { describe, expect, it } from 'vitest'
import type { ChatRecord, EffectiveRunPermissions, RunEventRecord } from '../store/types'
import { createKimiGatewayReadiness } from './KimiGatewayReadiness'
import { KIMI_ACP_DENY_TOOLS } from './KimiAcpContainment'
import {
  createKimiRunCapabilityReceipt,
  formatKimiRunCapabilityReceipt,
  kimiAssignedRunScope,
  latestKimiRunCapabilityReceipt
} from './KimiRunCapabilities'

describe('Kimi capability evidence scope', () => {
  it('reports the intended native deny wall from the verified run posture', () => {
    const contained = createKimiRunCapabilityReceipt(
      { runId: 'run', chatId: 'chat', assignedScope: { kind: 'workspace', paths: [] } },
      createKimiGatewayReadiness().snapshot()
    )
    expect(contained.nativeTools.intendedDenied).toEqual([...KIMI_ACP_DENY_TOOLS])
    const lesser = createKimiRunCapabilityReceipt(
      {
        runId: 'run',
        chatId: 'chat',
        assignedScope: { kind: 'workspace', paths: [] },
        permissions: {
          presetId: 'full_workspace',
          readOnly: false,
          agenticServices: { shellCommands: 'allow' }
        } as unknown as EffectiveRunPermissions
      },
      createKimiGatewayReadiness().snapshot()
    )
    expect(lesser.nativeTools.intendedDenied).toEqual([...KIMI_ACP_DENY_TOOLS])
    const fullAccess = createKimiRunCapabilityReceipt(
      {
        runId: 'run',
        chatId: 'chat',
        assignedScope: { kind: 'workspace', paths: [] },
        permissions: {
          presetId: 'full_access',
          readOnly: false,
          agenticServices: { shellCommands: 'allow' }
        } as unknown as EffectiveRunPermissions
      },
      createKimiGatewayReadiness().snapshot()
    )
    expect(fullAccess.nativeTools.intendedDenied).toEqual([])
    expect(formatKimiRunCapabilityReceipt(fullAccess)).toContain(
      'Available provider-native tools are allowed'
    )
    expect(formatKimiRunCapabilityReceipt(fullAccess)).not.toContain(
      'rejects native Bash/Edit/Write'
    )
    expect(formatKimiRunCapabilityReceipt(contained)).toContain('rejects native Bash/Edit/Write')
  })

  it('keeps plan-mode capability evidence contained even if the preset is Full Access', () => {
    const receipt = createKimiRunCapabilityReceipt(
      {
        runId: 'run',
        assignedScope: { kind: 'workspace', paths: [] },
        approvalMode: 'plan',
        permissions: {
          presetId: 'full_access',
          readOnly: false,
          agenticServices: { shellCommands: 'allow' }
        } as unknown as EffectiveRunPermissions
      },
      createKimiGatewayReadiness().snapshot()
    )
    expect(receipt.nativeTools.intendedDenied).toEqual([...KIMI_ACP_DENY_TOOLS])
    expect(formatKimiRunCapabilityReceipt(receipt)).not.toContain(
      'This run has verified Full Access'
    )
  })

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
