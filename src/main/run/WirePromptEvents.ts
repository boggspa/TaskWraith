import { createHash } from 'crypto'
import type { ProviderId } from '../store/types'

/**
 * Wire-boundary prompt capture (Prompt Inspector "Wire" view).
 *
 * Dispatch code calls `emitWirePromptCapture` at a transport's FINAL launch
 * boundary — after every host-side transform (mode/tool/goal preambles,
 * broker receipts, image-attachment notes, resume-fallback selection) — with
 * the exact text handed to the transport. Captures ride the main-owned
 * durable run-event store as ordinary lifecycle/control events (payload
 * `type: 'wire_prompt'`), so they appear in run-event replay and the
 * Inspector Prompt tab joins them to the run's composed envelope.
 *
 * Transports whose wire text is byte-identical to the composed prompt
 * (Muse exec, AntiGravity argv, Codex app-server text items) deliberately
 * emit nothing: the composed envelope IS the wire truth there, and the
 * Prompt tab says exactly that when no capture exists.
 *
 * Privacy contract matches the envelope: digest + byte count + transform
 * names always; full text only while the user's raw-event storage setting
 * is on at capture time. Unconfigured (unit tests, early boot) it no-ops,
 * and a failed append never affects the dispatch it describes.
 */

export const WIRE_PROMPT_EVENT_PAYLOAD_TYPE = 'wire_prompt'

export interface WirePromptCaptureInput {
  appRunId?: string | null
  appChatId?: string | null
  provider: ProviderId
  /** Transport label, e.g. 'grok-acp', 'cursor-path-b', 'ollama-api'. */
  transport: string
  /** Which part of the dispatch this text is: 'user' | 'system' | 'kickoff' | 'argv' | … */
  part: string
  /** The exact wire text. Hashed always; stored only when raw events are on. */
  text: string
  /** Named host transforms applied after composition. */
  transforms?: string[]
  /** Ordinal dispatch attempt; defaults to 1. Retries/fallbacks pass 2+. */
  attempt?: number
}

export interface WirePromptCaptureDeps {
  /**
   * Bridge to the main-process durable run-event appender
   * (appendDurableRunEventForRoute with kind 'lifecycle', phase 'control').
   */
  appendForRoute: (
    provider: ProviderId,
    route: { appRunId?: string; appChatId?: string },
    summary: string,
    payload: Record<string, unknown>
  ) => void
  /** settings.storeRawEvents === true at capture time. */
  storeContent: () => boolean
}

let deps: WirePromptCaptureDeps | null = null

export function configureWirePromptCapture(next: WirePromptCaptureDeps | null): void {
  deps = next
}

export function buildWirePromptEventPayload(
  input: WirePromptCaptureInput,
  storeContent: boolean
): Record<string, unknown> {
  return {
    type: WIRE_PROMPT_EVENT_PAYLOAD_TYPE,
    transport: input.transport,
    part: input.part,
    attempt: input.attempt ?? 1,
    sha256: createHash('sha256').update(input.text, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(input.text, 'utf8'),
    ...(input.transforms && input.transforms.length > 0 ? { transforms: input.transforms } : {}),
    ...(storeContent ? { content: input.text } : {})
  }
}

export function emitWirePromptCapture(input: WirePromptCaptureInput): void {
  const active = deps
  if (!active) return
  if (!input.appRunId || typeof input.text !== 'string') return
  try {
    active.appendForRoute(
      input.provider,
      {
        appRunId: input.appRunId,
        ...(input.appChatId ? { appChatId: input.appChatId } : {})
      },
      `Wire prompt captured (${input.transport}, ${input.part})`,
      buildWirePromptEventPayload(input, active.storeContent())
    )
  } catch {
    // Capture is evidence, never control flow.
  }
}
