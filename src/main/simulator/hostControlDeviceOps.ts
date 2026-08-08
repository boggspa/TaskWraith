/**
 * Lease-bound device ops for agent canvas_open(driver=device).
 *
 * Wraps SimulatorHostControl (controller-token gate), not the raw
 * SimulatorHostService. Human/tests may still inject raw SimctlDeviceOps via
 * createHostBackedDeviceOps(hostService, run) or createSimctlDeviceOps(run).
 */
import type { SimulatorControllerLease } from './SimulatorControllerLease'
import type { SimulatorHostControl } from './SimulatorHostControl'
import { createHostBackedDeviceOps, type SimctlDeviceOps, type SimctlRunner } from './SimctlRunner'

export interface LeaseEnforcingHostBackedDeviceOpsInput {
  hostControl: Pick<SimulatorHostControl, 'status' | 'boot' | 'install' | 'launch' | 'terminate'>
  controllerLease: Pick<SimulatorControllerLease, 'mint'>
  chatId: string
  runId: string
  ownerParticipantId?: string
  run: SimctlRunner
}

function requireCanonicalId(value: string, label: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed || trimmed !== value) {
    throw new Error(`Device Canvas requires canonical ${label} for simulator control.`)
  }
  return trimmed
}

/**
 * Mint a run-scoped controller lease, then adapt HostControl into SimctlDeviceOps
 * so boot/install/launch/terminate cannot bypass the lease gate.
 */
export function createLeaseEnforcingHostBackedDeviceOps(
  input: LeaseEnforcingHostBackedDeviceOpsInput
): SimctlDeviceOps {
  const chatId = requireCanonicalId(input.chatId, 'chatId')
  const runId = requireCanonicalId(input.runId, 'runId')
  const minted = input.controllerLease.mint({
    chatId,
    runId,
    ...(input.ownerParticipantId ? { ownerParticipantId: input.ownerParticipantId } : {})
  })
  if (!minted.ok) {
    throw new Error(minted.error)
  }
  const control = { chatId, controllerTokenId: minted.token.tokenId }
  return createHostBackedDeviceOps(
    {
      status: () => input.hostControl.status(),
      boot: (udid) => input.hostControl.boot(udid, control),
      install: (udid, appPath) => input.hostControl.install(udid, appPath, control),
      launch: (udid, bundleId) => input.hostControl.launch(udid, bundleId, control),
      terminate: (udid, bundleId) => input.hostControl.terminate(udid, bundleId, control)
    },
    input.run
  )
}
