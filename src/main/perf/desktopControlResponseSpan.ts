/**
 * Desktop control_response span (Independent Threads Programme M1 S4, A1.2).
 *
 * §1.1 bounds control response (an Ensemble round cancel, an approval
 * decision, a question answer) under queue and checkpoint pressure. The
 * Host-native path already records one (`HostNodeDomainPorts`); the Desktop
 * path recorded none. This wraps a Desktop IPC handler so each call records
 * one span from main's ingress, the moment the handler is invoked, to the
 * authoritative result it returns, whether that is a success, a refusal or
 * a throw: each is the response the user waits for.
 *
 * What main cannot see stays out: the renderer's dispatch, IPC queueing
 * before the handler runs, and the render of the acknowledgement. The
 * harness measures end to end from the page; this span says how much of it
 * main spent. The reason names the action, in the harness's own control-action
 * vocabulary (`interferenceMatrix.cjs` CONTROL_ACTIONS), so the three are
 * never pooled.
 *
 * The sink is optional (`mainWorkSpanSink()` by default) and read on each
 * call. A call whose chat cannot be named records nothing, and neither does
 * one whose chat id is longer than any lane reader accepts: the ring keeps
 * what it records, so a renderer must not be able to park an unbounded id in
 * main's memory. A throwing sink, clock or chat lookup loses the measurement,
 * never the action, and the handler's own result (the same promise, for an
 * async handler) is returned untouched. A call records at most one span.
 */

import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { mainWorkSpanSink, type MainWorkSpanSink } from './mainWorkSpanSink'

export const DESKTOP_CONTROL_ACTIONS = ['cancel', 'approval_decision', 'question_answer'] as const
export type DesktopControlAction = (typeof DESKTOP_CONTROL_ACTIONS)[number]

export interface DesktopControlResponseOptions {
  /** Defaults to the process-wide main sink. */
  sink?: () => MainWorkSpanSink | undefined
  now?: () => number
}

function readClock(now: () => number): number | null {
  try {
    const value = now()
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
  } catch {
    return null
  }
}

/** The longest chat id a lane reader accepts (`perfWorkSpanHandle.ts`, the Host fold). */
const MAX_CHAT_ID_LENGTH = 256

function chatIdOf(chatOf: (...args: unknown[]) => unknown, args: unknown[]): string | null {
  try {
    const chatId = chatOf(...args)
    if (typeof chatId !== 'string') return null
    const trimmed = chatId.trim()
    return trimmed.length > 0 && trimmed.length <= MAX_CHAT_ID_LENGTH ? trimmed : null
  } catch {
    return null
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/**
 * Wrap an `ipcMain.handle` handler. `chatOf` names the chat from the
 * handler's arguments and runs before the handler, so a lookup that the
 * handler itself would invalidate (a pending approval it resolves) still
 * reads the chat. It reads them as `unknown`: nothing has checked what the
 * renderer sent, and the handler's parameter types are not a check.
 */
export function withDesktopControlResponseSpan<A extends unknown[], R>(
  action: DesktopControlAction,
  chatOf: (...args: unknown[]) => unknown,
  handler: (...args: A) => R,
  options: DesktopControlResponseOptions = {}
): (...args: A) => R {
  const readSink = options.sink ?? mainWorkSpanSink
  const now = options.now ?? Date.now
  return (...args: A): R => {
    let sink: MainWorkSpanSink | undefined
    try {
      sink = readSink()
    } catch {
      sink = undefined
    }
    const chatId = sink ? chatIdOf(chatOf, args) : null
    const startedAt = sink && chatId ? readClock(now) : null
    if (!sink || chatId === null || startedAt === null) return handler(...args)
    let emitted = false
    const emit = (): void => {
      // A thenable may call both of its callbacks; the call is one response.
      if (emitted) return
      emitted = true
      const endedAt = readClock(now)
      if (endedAt === null) return
      try {
        sink.record({
          chatId,
          kind: 'control_response',
          reason: action,
          startedAt,
          durationMs: Math.max(0, endedAt - startedAt)
        })
      } catch {
        // Instrumentation must never alter a control action's result.
      }
    }
    let result: R
    try {
      result = handler(...args)
    } catch (error) {
      emit()
      throw error
    }
    if (!isThenable(result)) {
      emit()
      return result
    }
    try {
      result.then(emit, emit)
    } catch {
      // A throwing then() loses the measurement, never the result.
    }
    return result
  }
}

/**
 * `ipcMain.handle` for a control channel, timed as `action`. Registrars call
 * it in place of `ipcMain.handle`, so a handler's body keeps its lines.
 */
export function handleDesktopControl<A extends unknown[], R>(
  ipc: Pick<IpcMain, 'handle'>,
  channel: string,
  action: DesktopControlAction,
  chatOf: (...args: unknown[]) => unknown,
  handler: (event: IpcMainInvokeEvent, ...args: A) => R,
  options: DesktopControlResponseOptions = {}
): void {
  ipc.handle(channel, withDesktopControlResponseSpan(action, chatOf, handler, options))
}

/**
 * As handleDesktopControl, for a channel whose first argument is the chat
 * id. Keeps a composition root's change to one line.
 */
export function handleChatControl<R>(
  ipc: Pick<IpcMain, 'handle'>,
  channel: string,
  action: DesktopControlAction,
  handler: (event: IpcMainInvokeEvent, chatId?: string) => R,
  options: DesktopControlResponseOptions = {}
): void {
  handleDesktopControl(ipc, channel, action, (_event, chatId) => chatId, handler, options)
}
