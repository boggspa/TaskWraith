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
import { resolveAppDriveSurfaceDescriptor } from '../../shared/appDriveSurface'

export interface LeaseEnforcingHostBackedDeviceOpsInput {
  hostControl: Pick<SimulatorHostControl, 'status' | 'boot' | 'install' | 'launch' | 'terminate'>
  controllerLease: Pick<SimulatorControllerLease, 'mint'>
  chatId: string
  runId: string
  provider: string
  target: { udid: string; bundleId: string }
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
 * Acquire a pre-authorized run-scoped controller lease on first mutation, then
 * adapt HostControl into SimctlDeviceOps. This path cannot mint consent.
 */
export function createLeaseEnforcingHostBackedDeviceOps(
  input: LeaseEnforcingHostBackedDeviceOpsInput
): SimctlDeviceOps {
  const chatId = requireCanonicalId(input.chatId, 'chatId')
  const runId = requireCanonicalId(input.runId, 'runId')
  const provider = requireCanonicalId(input.provider, 'provider')
  let control: { chatId: string; controllerTokenId: string } | null = null
  const requireControl = () => {
    if (control) return control
    const surface = resolveAppDriveSurfaceDescriptor('canvas_open', {
      driver: 'device',
      udid: input.target.udid,
      bundleId: input.target.bundleId
    })
    if (!surface) throw new Error('Device Canvas could not resolve its simulator lease surface.')
    const acquired = input.controllerLease.mint({
      chatId,
      runId,
      provider,
      surfaceId: surface.surfaceId,
      verb: surface.verb,
      ...(input.ownerParticipantId ? { ownerParticipantId: input.ownerParticipantId } : {})
    })
    if (!acquired.ok) throw new Error(acquired.error)
    control = { chatId, controllerTokenId: acquired.token.tokenId }
    return control
  }
  return createHostBackedDeviceOps(
    {
      status: () => input.hostControl.status(),
      boot: (udid) => input.hostControl.boot(udid, requireControl()),
      install: (udid, appPath) => input.hostControl.install(udid, appPath, requireControl()),
      launch: (udid, bundleId) => input.hostControl.launch(udid, bundleId, requireControl()),
      terminate: (udid, bundleId) => input.hostControl.terminate(udid, bundleId, requireControl())
    },
    input.run
  )
}
