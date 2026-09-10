/**
 * Muse routinely opens a turn by calling a tool, leaving the transcript on a
 * bare activity header with no prose behind it. The launch-prompt guidance in
 * `MuseLongTurnProgress` asks for an opening sentence, but a prompt is a
 * request the model may decline — and when it declines there is no signal and
 * no recovery.
 *
 * This gate is the mechanical half. It watches the live MSP item stream and
 * reports the single moment worth acting on: a tool call opening while the turn
 * has produced no assistant prose. The caller answers that with `turn/steer`,
 * which lands as a `steered` user message mid-turn, so the model narrates and
 * keeps working rather than being asked again next turn.
 *
 * Pure and transport-free: the policy is decided here and proven without a live
 * host, while the client owns only the wire call.
 */

/**
 * One sentence, and explicitly not a stop signal. A steer arrives as a user
 * message, which a model can easily read as a new instruction that supersedes
 * the task — the last clause exists to prevent exactly that.
 */
export const MUSE_ANNOUNCE_STEER_TEXT = [
  'TaskWraith progress visibility (host guidance): you began tool work without telling the user what you are doing.',
  'Write one short sentence naming the action you are taking right now, then continue the same work in this turn.',
  'This is not a new request, a question, or a reason to stop: do not restate the task, do not ask for permission, and do not treat it as the final answer.'
].join(' ')

/**
 * Mirrors the native-slash-dispatch contract the launch steers keep: a prompt
 * beginning with `/` is a Muse command, not a task, and must reach the provider
 * untouched. Steering one would inject prose into a native dispatch.
 */
export function museAnnounceSteerAppliesToPrompt(prompt: string): boolean {
  return !/^\s*\//.test(prompt)
}

export type MuseAnnounceSteerPhase = 'started' | 'updated' | 'completed'

export interface MuseAnnounceSteerObservation {
  /** MSP `ItemKind`; an open enum, so unknown kinds are simply not triggers. */
  readonly kind: string
  readonly phase: MuseAnnounceSteerPhase
}

export interface MuseAnnounceSteerGate {
  /** True exactly once per gate, on the first unannounced tool call. */
  observeItem(input: MuseAnnounceSteerObservation): boolean
}

/**
 * One gate per turn — the caller builds it alongside the turn it watches, so
 * there is no reset to get wrong and no way for a late frame to re-arm a steer
 * the turn has already spent.
 *
 * @param enabled pass false to disable the gate for the whole turn (a native
 * slash dispatch, or a caller that owns announcement another way). A disabled
 * gate always answers false.
 */
export function createMuseAnnounceSteerGate(enabled = true): MuseAnnounceSteerGate {
  let sawProse = false
  let steered = false
  return {
    observeItem: ({ kind, phase }) => {
      // Any agentMessage frame means prose is on its way to the transcript,
      // including the `started` frame that precedes the first text delta. The
      // gate must close on `started`, not on `completed`: a tool call opening
      // while prose is still streaming is announced work, not silent work.
      if (kind === 'agentMessage') {
        sawProse = true
        return false
      }
      if (!enabled || steered || sawProse) return false
      if (kind !== 'toolCall' || phase !== 'started') return false
      steered = true
      return true
    }
  }
}
