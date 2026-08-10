import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../shared/collaboration/ChannelAgentReviewGate', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../shared/collaboration/ChannelAgentReviewGate')>()
  return { ...actual, channelAgentParticipationEnabled: () => false }
})

import {
  CHANNEL_AGENT_REVIEW_ID,
  CHANNEL_AGENT_REVIEW_REQUIRED_CODE
} from '../../shared/collaboration/ChannelAgentReviewGate'
import { generateIdentityKeyPair } from '../../shared/e2ee/keys'
import type { TransportSocketFactory } from '../remote/RemoteTransportClient'
import type { ChannelAgentIdentitySafeStorage } from './ChannelAgentIdentityStore'
import {
  channelProductionDataPaths,
  createChannelProductionService,
  type ChannelProductionAgentExecutionOptions,
  type ChannelProductionService
} from './ChannelProductionService'

const roots = new Set<string>()
const services = new Set<ChannelProductionService>()

const safeStorage: ChannelAgentIdentitySafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plaintext) => Buffer.from(plaintext, 'utf8'),
  decryptString: (ciphertext) => ciphertext.toString('utf8'),
  getSelectedStorageBackend: () => 'keychain'
}

const socketFactory: TransportSocketFactory = () => ({
  send: () => undefined,
  close: () => undefined
})

function temporaryUserData(): string {
  const root = mkdtempSync(join(tmpdir(), 'taskwraith-channel-agent-production-gate-'))
  roots.add(root)
  return root
}

function executionPorts(): {
  options: ChannelProductionAgentExecutionOptions
  calls: readonly ReturnType<typeof vi.fn>[]
} {
  const getChat = vi.fn()
  const resolveWorkspacePrincipal = vi.fn()
  const getSettings = vi.fn()
  const providerAllowed = vi.fn()
  const composeMainOwnedChannelAgentRun = vi.fn()
  const dispatch = vi.fn()
  const subscribeRunEvents = vi.fn()
  const subscribeRunSessions = vi.fn()
  const claimRunAudience = vi.fn()
  const reconcileRun = vi.fn()
  return {
    options: {
      getChat,
      resolveWorkspacePrincipal,
      getSettings,
      providerAllowed,
      composeMainOwnedChannelAgentRun,
      dispatch,
      subscribeRunEvents,
      subscribeRunSessions,
      claimRunAudience,
      reconcileRun
    } as unknown as ChannelProductionAgentExecutionOptions,
    calls: [
      getChat,
      resolveWorkspacePrincipal,
      getSettings,
      providerAllowed,
      composeMainOwnedChannelAgentRun,
      dispatch,
      subscribeRunEvents,
      subscribeRunSessions,
      claimRunAudience,
      reconcileRun
    ]
  }
}

afterEach(async () => {
  await Promise.all([...services].map((service) => service.stop().catch(() => undefined)))
  services.clear()
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

describe('ChannelProductionService injected closed agent execution gate', () => {
  it('attaches the production composition while every external execution port stays inert', async () => {
    const userDataPath = temporaryUserData()
    const identity = generateIdentityKeyPair()
    const execution = executionPorts()
    const service = createChannelProductionService({
      userDataPath,
      loadIdentity: () => identity,
      safeStorage,
      relay: {
        hostRelayUrl: () => 'ws://127.0.0.1:8787',
        inviteRelayUrls: () => []
      },
      socketFactory,
      agentExecution: execution.options,
      now: () => 1_700_000_000_000
    })
    services.add(service)
    service.start()
    service.startAgentExecution()
    const channel = service.createChannel({
      chatId: 'chat-agent-production-gate',
      title: 'Agent production gate',
      ownerDisplayName: 'Host'
    })
    const enrolled = await service.enrollAgent({
      channelId: channel.channelId,
      seat: {
        agentSeatId: 'pooled-agent-production-gate',
        displayName: 'Build Agent'
      },
      operationId: 'enroll-agent-production-gate'
    })

    const content = `Inspect this exact durable record <@${enrolled.member.memberId}>.`
    const appended = await service.appendHost({
      channelId: channel.channelId,
      clientMessageId: 'client-agent-production-gate',
      content
    })
    await vi.waitFor(() => {
      expect(
        service
          .listAudit({ channelId: channel.channelId })
          .some(
            (event) =>
              event.kind === 'agent.dispatch.blocked' &&
              event.memberId === enrolled.member.memberId &&
              event.code === CHANNEL_AGENT_REVIEW_REQUIRED_CODE &&
              event.detail === CHANNEL_AGENT_REVIEW_ID &&
              event.contentHash === appended.record.contentHash
          )
      ).toBe(true)
    })

    for (const call of execution.calls) expect(call).not.toHaveBeenCalled()
    expect(existsSync(channelProductionDataPaths(userDataPath).agentDispatchJournal)).toBe(false)
    expect(JSON.stringify(service.listAudit({ channelId: channel.channelId }))).not.toContain(
      content
    )
  })

  it('rejects a partial execution attachment before claiming the production root', () => {
    expect(() =>
      createChannelProductionService({
        userDataPath: temporaryUserData(),
        loadIdentity: generateIdentityKeyPair,
        safeStorage,
        relay: {
          hostRelayUrl: () => 'ws://127.0.0.1:8787',
          inviteRelayUrls: () => []
        },
        agentExecution: { getChat: vi.fn() } as unknown as ChannelProductionAgentExecutionOptions
      })
    ).toThrowError('ChannelProductionService agent execution ports are unavailable')
  })
})
