/**
 * Composition-root hop: turn a Muse compaction signal into the shared
 * chat-card sinks. Extracted so `index.ts` stays a registration line and the
 * mapping can be tested without booting Electron.
 *
 * The pair is `appendContextCompactionMessageToChat` plus
 * `broadcastContextCompactionSignalProgress` — the same sinks Codex/Claude/Kimi
 * already use. Do not swap in `broadcastContextCompactionProgress`; that takes
 * a progress *event*, not a `ContextCompactionSignal`.
 */

import type { ContextCompactionSignal } from '../../shared/contextCompaction'

export type MuseContextCompactionCardInput = {
  chatId: string
  signal: ContextCompactionSignal
  appRunId: string
  participantId?: string
}

export type MuseContextCompactionCardSinks = {
  append: (
    chatId: string,
    signal: ContextCompactionSignal,
    idFallbackScope: string,
    extraMetadata?: Record<string, unknown>
  ) => unknown
  broadcast: (input: {
    chatId: string
    provider: 'muse'
    signal: ContextCompactionSignal
    cardMetadata?: Record<string, unknown>
  }) => void
}

export function deliverMuseContextCompactionCard(
  input: MuseContextCompactionCardInput,
  sinks: MuseContextCompactionCardSinks
): void {
  const cardMetadata = input.participantId
    ? { ensembleParticipantId: input.participantId }
    : undefined
  sinks.append(
    input.chatId,
    input.signal,
    `muse-${input.appRunId}-${input.signal.telemetry.eventUuid || 'compaction'}`,
    cardMetadata
  )
  sinks.broadcast({
    chatId: input.chatId,
    provider: 'muse',
    signal: input.signal,
    ...(cardMetadata ? { cardMetadata } : {})
  })
}
