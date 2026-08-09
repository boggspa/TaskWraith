import type { IpcMain } from 'electron'
import type { SimulatorControlSetupService } from '../simulator/SimulatorControlSetupService'

export const SIMULATOR_CONTROL_SETUP_STATUS_CHANNEL = 'simulator-control:setup-status'
export const SIMULATOR_CONTROL_SETUP_CHANNEL = 'simulator-control:setup'

export interface SimulatorControlSetupHandlersDeps {
  getSetup: () => SimulatorControlSetupService
  isEnabled: () => boolean
}

export function registerSimulatorControlSetupHandlers(
  ipcMain: IpcMain,
  deps: SimulatorControlSetupHandlersDeps
): void {
  ipcMain.handle(SIMULATOR_CONTROL_SETUP_STATUS_CHANNEL, () =>
    deps.getSetup().status(deps.isEnabled())
  )
  ipcMain.handle(SIMULATOR_CONTROL_SETUP_CHANNEL, () => deps.getSetup().setup(deps.isEnabled()))
}
