import type { AgentRunPayload } from '../run/AgentRunTypes'
import type { ChatRecord } from '../store/types'
import type { KimiHttpMcpBridgeHandle } from './KimiHttpMcpBridge'
import { kimiAssignedRunScope, type KimiRunCapabilityReceipt } from './KimiRunCapabilities'
import type { KimiRunRecoveryOptions } from './KimiRunRecovery'
import { readKimiProviderToolSnapshot } from './KimiProviderToolSnapshot'
import { kimiRunCapabilityCache } from './KimiRunCapabilityStore'

export function createKimiRuntimeRecovery(input: {
  runId: string
  chatId?: string
  payload: Pick<AgentRunPayload, 'ensembleRun' | 'workspace' | 'effectivePermissions'>
  gateway: KimiHttpMcpBridgeHandle
  seatHome: string
  startedAt: number
  getChat: (chatId: string) => ChatRecord | null
  record: (receipt: KimiRunCapabilityReceipt) => void
}): { options: KimiRunRecoveryOptions; blockedReason: () => string | null } {
  let latest: KimiRunCapabilityReceipt | null = null
  const participantId = input.payload.ensembleRun?.participantId
  const laneId = input.payload.ensembleRun?.laneId
  const chat = input.chatId ? input.getChat(input.chatId) : null
  return {
    options: {
      context: {
        runId: input.runId,
        chatId: input.chatId,
        participantId,
        laneId,
        workspacePath: input.payload.workspace,
        permissions: input.payload.effectivePermissions,
        assignedScope: kimiAssignedRunScope(chat, input.runId, laneId, participantId)
      },
      gateway: input.gateway,
      onReceipt: (receipt) => {
        latest = receipt
        kimiRunCapabilityCache.put(receipt)
        input.record(receipt)
      },
      readToolSnapshot: (sessionId) =>
        readKimiProviderToolSnapshot({
          seatHome: input.seatHome,
          sessionId,
          runStartedAt: input.startedAt
        })
    },
    blockedReason: () =>
      latest?.outcome === 'blocked'
        ? latest.blocker || 'Kimi could not confirm its required broker tools.'
        : null
  }
}
