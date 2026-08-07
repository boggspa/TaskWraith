/**
 * Honest View & Control gate for Simulator Canvas human gestures.
 *
 * App Drive / CanvasWindowDriver click+fill require observation refs, opaque
 * click receipts, and a run-owned native lease — too entangled for Slice 5.
 * This bridge:
 *  - reports whether a View & Control lease is present for the chat
 *  - refuses tap/type/scroll without that lease
 *  - records intent only when a lease is present (no silent desktop control)
 *
 * TODO(simulator-canvas): when lease wiring lands, forward recorded intents
 * through NativeWindowCoordinator / App Drive click|fill (and a scroll path
 * if one ships) for the attached Simulator window — never invent Full Access.
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

export type SimulatorControlProbe = (chatId: string) => {
  canControl: boolean
  hasObservation: boolean
}

export interface SimulatorInteractionBridgeDeps {
  /** Optional probe into NativeWindowCoordinator.statusForChat (or a test double). */
  getControlStatus?: SimulatorControlProbe
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

export class SimulatorInteractionBridge {
  private readonly getControlStatus: SimulatorControlProbe
  private readonly now: () => number
  private readonly recorded: SimulatorRecordedGesture[] = []

  constructor(deps: SimulatorInteractionBridgeDeps = {}) {
    this.getControlStatus =
      deps.getControlStatus ??
      (() => ({
        canControl: false,
        hasObservation: false
      }))
    this.now = deps.now ?? (() => Date.now())
  }

  interactionStatus(chatId: string): SimulatorInteractionStatus {
    const id = requireChatId(chatId)
    const probe = this.getControlStatus(id)
    if (probe.canControl) {
      return {
        canControl: true,
        reason: SIMULATOR_GESTURE_ACTUATION_DEFERRED,
        hasObservation: probe.hasObservation
      }
    }
    return {
      canControl: false,
      reason: probe.hasObservation
        ? SIMULATOR_VIEW_CONTROL_REQUIRED
        : SIMULATOR_PREVIEW_ONLY_BANNER,
      hasObservation: probe.hasObservation
    }
  }

  /** Test / diagnostics only — never a grant surface. */
  recordedGestures(): readonly SimulatorRecordedGesture[] {
    return this.recorded
  }

  clearRecordedGestures(): void {
    this.recorded.length = 0
  }

  tap(input: SimulatorTapGesture): SimulatorGestureResult {
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
    // TODO(simulator-canvas): forward to App Drive click at mapped window coords.
    return { ok: false, error: SIMULATOR_GESTURE_ACTUATION_DEFERRED, recorded: true }
  }

  type(input: SimulatorTypeGesture): SimulatorGestureResult {
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
    // TODO(simulator-canvas): forward to App Drive fill for the focused field.
    return { ok: false, error: SIMULATOR_GESTURE_ACTUATION_DEFERRED, recorded: true }
  }

  scroll(input: SimulatorScrollGesture): SimulatorGestureResult {
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
    // TODO(simulator-canvas): forward mapped scroll deltas once a native scroll verb exists.
    return { ok: false, error: SIMULATOR_GESTURE_ACTUATION_DEFERRED, recorded: true }
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
