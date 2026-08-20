import { describe, expect, it, vi } from 'vitest'
import { SimulatorControllerLease } from './SimulatorControllerLease'
import { createLeaseEnforcingHostBackedDeviceOps } from './hostControlDeviceOps'
import type { SimulatorHostControl } from './SimulatorHostControl'
import type { SimctlResult } from './SimctlRunner'

const UDID = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'

type HostControlPick = Pick<
  SimulatorHostControl,
  'status' | 'boot' | 'install' | 'launch' | 'terminate'
>

describe('createLeaseEnforcingHostBackedDeviceOps', () => {
  it('acquires a pre-authorized run lease and routes mutate verbs through HostControl', async () => {
    const boot = vi.fn(async () => ({ ok: true as const, udid: UDID }))
    // Partial stub — only boot routing is asserted; cast keeps Pick<> satisfied.
    const hostControl = {
      status: vi.fn(async () => ({ bootedDevices: [{ udid: UDID }] })),
      boot,
      install: vi.fn(async () => ({ ok: true as const, udid: UDID })),
      launch: vi.fn(async () => ({ ok: true as const, udid: UDID })),
      terminate: vi.fn(async () => ({ ok: true as const, udid: UDID }))
    } as unknown as HostControlPick
    const lease = new SimulatorControllerLease({ createId: () => 'tok-device' })
    expect(
      lease.authorizeUserLease({
        chatId: 'chat-a',
        runId: 'run-1',
        provider: 'codex',
        surfaceId: `simulator:${UDID}:com.example.App`,
        verb: 'canvas_open_device',
        allowedVerbs: ['canvas_open_device'],
        target: { udid: UDID, bundleId: 'com.example.App' },
        approvedBy: 'user'
      }).ok
    ).toBe(true)
    const run = vi.fn(async (): Promise<SimctlResult> => ({ stdout: '', stderr: '' }))

    const ops = createLeaseEnforcingHostBackedDeviceOps({
      hostControl,
      controllerLease: lease,
      chatId: 'chat-a',
      runId: 'run-1',
      provider: 'codex',
      target: { udid: UDID, bundleId: 'com.example.App' },
      run
    })

    await ops.boot(UDID)
    expect(lease.peek('chat-a')?.tokenId).toBe('tok-device')
    expect(boot).toHaveBeenCalledWith(UDID, {
      chatId: 'chat-a',
      controllerTokenId: 'tok-device'
    })
  })

  it('fails closed without canonical chat/run before any host mutate', () => {
    const boot = vi.fn()
    const hostControl = {
      status: vi.fn(),
      boot,
      install: vi.fn(),
      launch: vi.fn(),
      terminate: vi.fn()
    } as unknown as HostControlPick
    const lease = new SimulatorControllerLease()
    expect(() =>
      createLeaseEnforcingHostBackedDeviceOps({
        hostControl,
        controllerLease: lease,
        chatId: ' chat-a',
        runId: 'run-1',
        provider: 'codex',
        target: { udid: UDID, bundleId: 'com.example.App' },
        run: async () => ({ stdout: '', stderr: '' })
      })
    ).toThrow(/canonical chatId/i)
    expect(boot).not.toHaveBeenCalled()
  })

  it('forwards ownerParticipantId into lease acquisition when present', async () => {
    const mint = vi.fn(
      (input: {
        chatId: string
        runId: string
        provider: string
        surfaceId: string
        verb: string
        ownerParticipantId?: string
      }) => ({
        ok: true as const,
        token: {
          tokenId: 'tok-seat',
          chatId: input.chatId,
          runId: input.runId,
          kind: 'run' as const,
          mintedAt: 1,
          updatedAt: 1,
          ...(input.ownerParticipantId ? { ownerParticipantId: input.ownerParticipantId } : {})
        }
      })
    )
    const hostControl = {
      status: vi.fn(async () => ({ bootedDevices: [] })),
      boot: vi.fn(async () => ({ ok: true as const, udid: UDID })),
      install: vi.fn(),
      launch: vi.fn(),
      terminate: vi.fn()
    } as unknown as HostControlPick

    const ops = createLeaseEnforcingHostBackedDeviceOps({
      hostControl,
      controllerLease: { mint },
      chatId: 'chat-a',
      runId: 'run-1',
      provider: 'codex',
      target: { udid: UDID, bundleId: 'com.example.App' },
      ownerParticipantId: 'seat-boss',
      run: async () => ({ stdout: '', stderr: '' })
    })

    await ops.boot(UDID)
    expect(mint).toHaveBeenCalledWith({
      chatId: 'chat-a',
      runId: 'run-1',
      provider: 'codex',
      surfaceId: `simulator:${UDID}:com.example.App`,
      verb: 'canvas_open_device',
      ownerParticipantId: 'seat-boss'
    })
  })
})
