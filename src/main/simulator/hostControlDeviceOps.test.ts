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
  it('mints a run lease and routes mutate verbs through HostControl (not raw host)', async () => {
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
    const run = vi.fn(async (): Promise<SimctlResult> => ({ stdout: '', stderr: '' }))

    const ops = createLeaseEnforcingHostBackedDeviceOps({
      hostControl,
      controllerLease: lease,
      chatId: 'chat-a',
      runId: 'run-1',
      run
    })

    expect(lease.peek('chat-a')?.tokenId).toBe('tok-device')
    await ops.boot(UDID)
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
        run: async () => ({ stdout: '', stderr: '' })
      })
    ).toThrow(/canonical chatId/i)
    expect(boot).not.toHaveBeenCalled()
  })

  it('forwards ownerParticipantId into lease.mint when present', () => {
    const mint = vi.fn((input: { chatId: string; runId: string; ownerParticipantId?: string }) => ({
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
    }))
    const hostControl = {
      status: vi.fn(async () => ({ bootedDevices: [] })),
      boot: vi.fn(),
      install: vi.fn(),
      launch: vi.fn(),
      terminate: vi.fn()
    } as unknown as HostControlPick

    createLeaseEnforcingHostBackedDeviceOps({
      hostControl,
      controllerLease: { mint },
      chatId: 'chat-a',
      runId: 'run-1',
      ownerParticipantId: 'seat-boss',
      run: async () => ({ stdout: '', stderr: '' })
    })

    expect(mint).toHaveBeenCalledWith({
      chatId: 'chat-a',
      runId: 'run-1',
      ownerParticipantId: 'seat-boss'
    })
  })
})
