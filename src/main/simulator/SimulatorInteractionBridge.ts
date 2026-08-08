/**
 * Honest View & Control / controller-lease gate for Simulator Canvas gestures.
 *
 * actuationReady is true only when:
 *   - the `idb` client is available on PATH, and
 *   - a SimulatorControllerLease is held for the chat (when the lease probe is wired)
 *
 * Without idb (or without a lease), tap/type/scroll record intent and stay deferred.
 * Never invents Full Access.
 */
import {
  SIMULATOR_GESTURE_ACTUATION_DEFERRED,
  SIMULATOR_PREVIEW_ONLY_BANNER,
  SIMULATOR_VIEW_CONTROL_REQUIRED,
  type SimulatorGestureResult,
  type SimulatorInteractionStatus,
  type SimulatorScrollGesture,
  type SimulatorTapGesture,
  type SimulatorTypeGesture
} from '../../shared/simulatorCanvas'
import type { IdbClient } from './IdbClient'

export type SimulatorControlProbe = (chatId: string) => {
  canControl: boolean
  hasObservation: boolean
}

export type SimulatorActuationTarget = {
  udid: string
  width: number
  height: number
}

export type SimulatorIdbSurface = Pick<IdbClient, 'isAvailable' | 'tap' | 'text' | 'swipe'>

export interface SimulatorInteractionBridgeDeps {
  /** Optional probe into NativeWindowCoordinator.statusForChat (or a test double). */
  getControlStatus?: SimulatorControlProbe
  /**
   * Controller lease probe (SimulatorControllerLease.peek). When omitted, actuation
   * gates on idb + canControl only — TODO(simulator-canvas): always wire lease&&idb
   * from the composition root.
   */
  hasControllerLease?: (chatId: string) => boolean
  idb?: SimulatorIdbSurface
  /** Session/frame target for normalizing bezel coords → device points. */
  getActuationTarget?: (chatId: string) => SimulatorActuationTarget | null
  now?: () => number
}

export type SimulatorRecordedGestureKind = 'tap' | 'type' | 'scroll'

export interface SimulatorRecordedGesture {
  kind: SimulatorRecordedGestureKind
  chatId: string
  at: number
  payload: SimulatorTapGesture | SimulatorTypeGesture | SimulatorScrollGesture
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(max, Math.max(min, value))
}

function requireChatId(chatId: unknown): string {
  if (typeof chatId !== 'string' || !chatId.trim() || chatId.trim() !== chatId) {
    throw new Error('Simulator Canvas chatId is invalid.')
  }
  return chatId
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Simulator Canvas ${label} is invalid.`)
  }
  return value
}

function toDevicePoint(norm: number, extent: number): number {
  return Math.round(clamp01(norm) * Math.max(0, extent))
}

export class SimulatorInteractionBridge {
  private readonly getControlStatus: SimulatorControlProbe
  private readonly hasControllerLease: ((chatId: string) => boolean) | null
  private readonly idb: SimulatorIdbSurface | null
  private readonly getActuationTarget: ((chatId: string) => SimulatorActuationTarget | null) | null
  private readonly now: () => number
  private readonly recorded: SimulatorRecordedGesture[] = []

  constructor(deps: SimulatorInteractionBridgeDeps = {}) {
    this.getControlStatus =
      deps.getControlStatus ??
      (() => ({
        canControl: false,
        hasObservation: false
      }))
    this.hasControllerLease = deps.hasControllerLease ?? null
    this.idb = deps.idb ?? null
    this.getActuationTarget = deps.getActuationTarget ?? null
    this.now = deps.now ?? (() => Date.now())
  }

  private idbAvailable(): boolean {
    return Boolean(this.idb?.isAvailable())
  }

  private controllerLeaseHeld(chatId: string): boolean {
    if (this.hasControllerLease) return Boolean(this.hasControllerLease(chatId))
    // TODO(simulator-canvas): composition root should always inject hasControllerLease
    // so actuationReady is lease&&idb rather than canControl&&idb.
    return false
  }

  interactionStatus(chatId: string): SimulatorInteractionStatus {
    const id = requireChatId(chatId)
    const probe = this.getControlStatus(id)
    const leaseHeld = this.hasControllerLease ? this.controllerLeaseHeld(id) : probe.canControl
    const idbAvailable = this.idbAvailable()
    const canControl = probe.canControl || leaseHeld
    const actuationReady = Boolean(leaseHeld && idbAvailable)

    if (!canControl) {
      return {
        canControl: false,
        actuationReady: false,
        reason: probe.hasObservation
          ? SIMULATOR_VIEW_CONTROL_REQUIRED
          : SIMULATOR_PREVIEW_ONLY_BANNER,
        hasObservation: probe.hasObservation,
        idbAvailable,
        controllerLeaseHeld: leaseHeld
      }
    }

    return {
      canControl: true,
      actuationReady,
      reason: actuationReady
        ? 'Simulator Canvas can drive the device via idb.'
        : SIMULATOR_GESTURE_ACTUATION_DEFERRED,
      hasObservation: probe.hasObservation,
      idbAvailable,
      controllerLeaseHeld: leaseHeld
    }
  }

  /** Test / diagnostics only — never a grant surface. */
  recordedGestures(): readonly SimulatorRecordedGesture[] {
    return this.recorded
  }

  clearRecordedGestures(): void {
    this.recorded.length = 0
  }

  async tap(input: SimulatorTapGesture): Promise<SimulatorGestureResult> {
    const chatId = requireChatId(input.chatId)
    const status = this.interactionStatus(chatId)
    if (!status.canControl) {
      return { ok: false, error: SIMULATOR_VIEW_CONTROL_REQUIRED }
    }
    const gesture: SimulatorTapGesture = {
      chatId,
      x: clamp01(requireFiniteNumber(input.x, 'x')),
      y: clamp01(requireFiniteNumber(input.y, 'y'))
    }
    this.record('tap', gesture)
    if (!status.actuationReady || !this.idb) {
      return { ok: false, error: SIMULATOR_GESTURE_ACTUATION_DEFERRED, recorded: true }
    }
    const target = this.getActuationTarget?.(chatId) ?? null
    if (!target) {
      return { ok: false, error: SIMULATOR_GESTURE_ACTUATION_DEFERRED, recorded: true }
    }
    const result = await this.idb.tap(
      target.udid,
      toDevicePoint(gesture.x, target.width),
      toDevicePoint(gesture.y, target.height)
    )
    return result.ok
      ? { ok: true, recorded: true }
      : { ok: false, error: result.error || SIMULATOR_GESTURE_ACTUATION_DEFERRED, recorded: true }
  }

  async type(input: SimulatorTypeGesture): Promise<SimulatorGestureResult> {
    const chatId = requireChatId(input.chatId)
    const status = this.interactionStatus(chatId)
    if (!status.canControl) {
      return { ok: false, error: SIMULATOR_VIEW_CONTROL_REQUIRED }
    }
    if (typeof input.text !== 'string') {
      throw new Error('Simulator Canvas text is invalid.')
    }
    const gesture: SimulatorTypeGesture = { chatId, text: input.text }
    this.record('type', gesture)
    if (!status.actuationReady || !this.idb) {
      return { ok: false, error: SIMULATOR_GESTURE_ACTUATION_DEFERRED, recorded: true }
    }
    const target = this.getActuationTarget?.(chatId) ?? null
    if (!target) {
      return { ok: false, error: SIMULATOR_GESTURE_ACTUATION_DEFERRED, recorded: true }
    }
    const result = await this.idb.text(target.udid, gesture.text)
    return result.ok
      ? { ok: true, recorded: true }
      : { ok: false, error: result.error || SIMULATOR_GESTURE_ACTUATION_DEFERRED, recorded: true }
  }

  async scroll(input: SimulatorScrollGesture): Promise<SimulatorGestureResult> {
    const chatId = requireChatId(input.chatId)
    const status = this.interactionStatus(chatId)
    if (!status.canControl) {
      return { ok: false, error: SIMULATOR_VIEW_CONTROL_REQUIRED }
    }
    const gesture: SimulatorScrollGesture = {
      chatId,
      x: clamp01(requireFiniteNumber(input.x, 'x')),
      y: clamp01(requireFiniteNumber(input.y, 'y')),
      deltaX: requireFiniteNumber(input.deltaX, 'deltaX'),
      deltaY: requireFiniteNumber(input.deltaY, 'deltaY')
    }
    this.record('scroll', gesture)
    if (!status.actuationReady || !this.idb) {
      return { ok: false, error: SIMULATOR_GESTURE_ACTUATION_DEFERRED, recorded: true }
    }
    const target = this.getActuationTarget?.(chatId) ?? null
    if (!target) {
      return { ok: false, error: SIMULATOR_GESTURE_ACTUATION_DEFERRED, recorded: true }
    }
    const startX = toDevicePoint(gesture.x, target.width)
    const startY = toDevicePoint(gesture.y, target.height)
    const endX = Math.round(clamp(startX - gesture.deltaX, 0, target.width))
    const endY = Math.round(clamp(startY - gesture.deltaY, 0, target.height))
    const result = await this.idb.swipe(target.udid, startX, startY, endX, endY)
    return result.ok
      ? { ok: true, recorded: true }
      : { ok: false, error: result.error || SIMULATOR_GESTURE_ACTUATION_DEFERRED, recorded: true }
  }

  private record(
    kind: SimulatorRecordedGestureKind,
    payload: SimulatorTapGesture | SimulatorTypeGesture | SimulatorScrollGesture
  ): void {
    this.recorded.push({
      kind,
      chatId: payload.chatId,
      at: this.now(),
      payload
    })
  }
}
