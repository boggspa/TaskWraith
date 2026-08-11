/**
 * Mutating entrypoint for Simulator Canvas hybrid ownership (fork 2C).
 *
 * SimulatorHostService stays the simctl/lifecycle engine. This gate:
 * - rejects mutating verbs without a valid controller token for the chat
 * - updates chat-scoped session preview metadata on success
 * - leaves status / list / screenshot readable without a controller
 *
 * Prefer this over growing SimulatorHostService while lifecycle ownership lands
 * in parallel.
 */
import type { SimulatorHostActionResult } from '../../shared/simulatorCanvas'
import type {
  SimulatorHostService,
  SimulatorPasteboardDirection
} from './SimulatorHostService'
import type { SimulatorControllerLease } from './SimulatorControllerLease'
import type { SimulatorSessionStore } from './SimulatorSessionStore'

export interface SimulatorMutateControl {
  chatId: string
  controllerTokenId: string
}

export const SIMULATOR_CONTROLLER_REQUIRED =
  'Simulator control requires an active controller token for this chat.' as const

export interface SimulatorHostControlDeps {
  host: Pick<
    SimulatorHostService,
    | 'status'
    | 'openSimulatorApp'
    | 'listDevices'
    | 'boot'
    | 'install'
    | 'launch'
    | 'terminate'
    | 'screenshot'
    | 'pasteboardSync'
    | 'getOwnedSimulatorPid'
  >
  controllerLease: SimulatorControllerLease
  sessionStore: SimulatorSessionStore
}

function deny(error: string): SimulatorHostActionResult {
  return { ok: false, error }
}

export class SimulatorHostControl {
  private readonly host: SimulatorHostControlDeps['host']
  private readonly controllerLease: SimulatorControllerLease
  private readonly sessionStore: SimulatorSessionStore

  constructor(deps: SimulatorHostControlDeps) {
    this.host = deps.host
    this.controllerLease = deps.controllerLease
    this.sessionStore = deps.sessionStore
  }

  assertController(control: SimulatorMutateControl): SimulatorHostActionResult | null {
    const chatId = typeof control.chatId === 'string' ? control.chatId.trim() : ''
    const tokenId =
      typeof control.controllerTokenId === 'string' ? control.controllerTokenId.trim() : ''
    if (!chatId || chatId !== control.chatId || !tokenId || tokenId !== control.controllerTokenId) {
      return deny(SIMULATOR_CONTROLLER_REQUIRED)
    }
    if (!this.controllerLease.isValid({ chatId, tokenId })) {
      return deny(SIMULATOR_CONTROLLER_REQUIRED)
    }
    return null
  }

  status() {
    return this.host.status()
  }

  listDevices() {
    return this.host.listDevices()
  }

  /** Screenshot is chat-readable; records last-frame metadata when chatId is supplied. */
  async screenshot(udid: string, opts?: { chatId?: string }): Promise<SimulatorHostActionResult> {
    const result = await this.host.screenshot(udid)
    if (result.ok && result.frame && opts?.chatId) {
      const frame = result.frame
      const pointWidth =
        typeof frame.pointWidth === 'number' && frame.pointWidth > 0
          ? frame.pointWidth
          : Math.max(1, Math.round(frame.width / 2))
      const pointHeight =
        typeof frame.pointHeight === 'number' && frame.pointHeight > 0
          ? frame.pointHeight
          : Math.max(1, Math.round(frame.height / 2))
      this.sessionStore.upsert(opts.chatId, {
        udid: frame.udid,
        lastFrame: {
          width: frame.width,
          height: frame.height,
          pointWidth,
          pointHeight,
          capturedAt: frame.capturedAt,
          udid: frame.udid
        }
      })
    }
    return result
  }

  async openSimulatorApp(control: SimulatorMutateControl): Promise<SimulatorHostActionResult> {
    const denied = this.assertController(control)
    if (denied) return denied
    const result = await this.host.openSimulatorApp()
    if (result.ok) {
      this.sessionStore.upsert(control.chatId, {
        ...(result.udid ? { udid: result.udid } : {}),
        simulatorAppOpen: true,
        ownedSimulatorPid: this.host.getOwnedSimulatorPid()
      })
    }
    return result
  }

  async boot(udid: string, control: SimulatorMutateControl): Promise<SimulatorHostActionResult> {
    const denied = this.assertController(control)
    if (denied) return denied
    const result = await this.host.boot(udid)
    if (result.ok && result.udid) {
      this.sessionStore.upsert(control.chatId, { udid: result.udid })
    }
    return result
  }

  async install(
    udid: string,
    appPath: string,
    control: SimulatorMutateControl
  ): Promise<SimulatorHostActionResult> {
    const denied = this.assertController(control)
    if (denied) return denied
    const result = await this.host.install(udid, appPath)
    if (result.ok && result.udid) {
      this.sessionStore.upsert(control.chatId, { udid: result.udid })
    }
    return result
  }

  async launch(
    udid: string,
    bundleId: string,
    control: SimulatorMutateControl
  ): Promise<SimulatorHostActionResult> {
    const denied = this.assertController(control)
    if (denied) return denied
    const result = await this.host.launch(udid, bundleId)
    if (result.ok && result.udid) {
      this.sessionStore.upsert(control.chatId, { udid: result.udid })
    }
    return result
  }

  async terminate(
    udid: string,
    bundleId: string | undefined,
    control: SimulatorMutateControl
  ): Promise<SimulatorHostActionResult> {
    const denied = this.assertController(control)
    if (denied) return denied
    const result = await this.host.terminate(udid, bundleId)
    if (result.ok && result.udid) {
      this.sessionStore.upsert(control.chatId, { udid: result.udid })
    }
    return result
  }

  /** Pasteboard bridge (simctl pbsync) — controller-gated; content stays inside simctl. */
  async pasteboardSync(
    udid: string,
    direction: SimulatorPasteboardDirection,
    control: SimulatorMutateControl
  ): Promise<SimulatorHostActionResult> {
    const denied = this.assertController(control)
    if (denied) return denied
    return this.host.pasteboardSync(udid, direction)
  }
}
