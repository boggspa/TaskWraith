import { describe, expect, it, vi } from 'vitest'
import type { ChatRecord } from '../store/types'
import { createKimiGatewayReadiness } from './KimiGatewayReadiness'
import type { KimiHttpMcpBridgeHandle } from './KimiHttpMcpBridge'
import { createKimiRunRecovery } from './KimiRunRecovery'
import { createKimiRuntimeRecovery } from './KimiRuntimeRecovery'

describe('Kimi main runtime recovery wiring', () => {
  it('binds receipts to the exact lane and keeps blocked outcome available through settlement', async () => {
    const record = vi.fn()
    const readiness = createKimiGatewayReadiness()
    const runtime = createKimiRuntimeRecovery({
      runId: 'run',
      chatId: 'chat',
      payload: {
        workspace: '/workspace',
        ensembleRun: {
          roundId: 'round',
          participantId: 'worker',
          laneId: 'lane',
          provider: 'kimi',
          role: 'Work',
          order: 1
        }
      },
      gateway: { readiness } as KimiHttpMcpBridgeHandle,
      seatHome: '/unavailable-provider-record',
      startedAt: 200,
      getChat: (id) =>
        id === 'chat'
          ? ({
              ensemble: {
                activeRound: {
                  lanes: {
                    lane: {
                      runId: 'run',
                      participantId: 'worker',
                      intent: 'write',
                      approvedWriteScopes: [{ kind: 'path', path: 'src/owned.ts' }]
                    }
                  }
                }
              }
            } as unknown as ChatRecord)
          : null,
      record
    })
    expect(runtime.options.context.assignedScope.paths).toEqual([
      { kind: 'path', path: 'src/owned.ts' }
    ])
    const recovery = createKimiRunRecovery({ ...runtime.options, timeoutMs: 1 })
    expect(runtime.blockedReason()).toBeNull()
    await recovery.prepareSessionPrompt({
      sessionId: 'session',
      resumed: false,
      fallbackFromResume: false,
      prompt: 'work'
    })
    expect(runtime.blockedReason()).toContain('tools/list responses=0')
    expect(record.mock.calls.at(-1)?.[0]).toMatchObject({
      runId: 'run',
      participantId: 'worker',
      lifecycleSettled: false
    })
    recovery.beginClose(true)
    recovery.close()
    expect(record.mock.calls.at(-1)?.[0]).toMatchObject({
      outcome: 'blocked',
      lifecycleSettled: true
    })
    expect(runtime.blockedReason()).toContain('tools/list responses=0')
  })
})
