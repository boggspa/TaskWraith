import type { ChatRecord, ChatRun, ProviderId } from '../../../main/store/types'
import type { SeatChangeSeatState } from '../../../shared/seatChange'

export interface FleetWaveWorkerSeatInput {
  worker: Record<string, unknown>
  index: number
  child?: ChatRecord | null
}

const REASONING_METADATA_KEYS: Partial<Record<ProviderId, string>> = {
  codex: 'codexReasoningEffort',
  claude: 'claudeReasoningEffort',
  kimi: 'kimiReasoningEffort',
  grok: 'grokReasoningEffort',
  cursor: 'cursorReasoningEffort',
  ollama: 'ollamaReasoningEffort',
  pi: 'piReasoningEffort',
  mistral: 'mistralReasoningEffort',
  devin: 'devinReasoningEffort',
  muse: 'museReasoningEffort',
  antigravity: 'antigravityReasoningEffort'
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined
}

function waveRun(child: ChatRecord | null | undefined): ChatRun | undefined {
  // A wave always creates a fresh child, so its first run is the immutable
  // spawn-time choice. A later explicit recall must not rewrite this card.
  return child?.runs?.[0]
}

function metadataValue(
  key: string,
  worker: Record<string, unknown>,
  run: ChatRun | undefined,
  child: ChatRecord | null | undefined
): unknown {
  return worker[key] ?? run?.providerMetadata?.[key] ?? child?.providerMetadata?.[key]
}

function stageRole(value: unknown): SeatChangeSeatState['stageRole'] {
  const role = trimmed(value)
  if (role === 'scout') return 'scout'
  if (role === 'work' || role === 'worker') return 'worker'
  if (role === 'review' || role === 'reviewer') return 'reviewer'
  return undefined
}

function resolvedModel(
  worker: Record<string, unknown>,
  run: ChatRun | undefined,
  child: ChatRecord | null | undefined
): string {
  const requested =
    trimmed(worker.model) ||
    trimmed(run?.requestedModel) ||
    trimmed(child?.requestedModel) ||
    trimmed(run?.providerMetadata?.selectedModelType) ||
    trimmed(child?.providerMetadata?.selectedModelType)
  if (requested && requested !== 'cli-default' && requested !== 'default') return requested
  return trimmed(run?.actualModel) || trimmed(child?.lastActualModel) || requested
}

/**
 * Decode the exact choices that produced one delegate-wave child into the
 * shared transcript seat state. The projected card metadata wins when newer
 * records carry it; existing cards resolve from the durable child run.
 * Unknown fields stay absent rather than being presented as defaults.
 *
 * The permission tier is the one deliberate exception to "projection first":
 * the card's projection is a REQUEST, and only the child run's signed posture
 * records what the wave was allowed to do. A permission chip is a claim about
 * authority, so it reads the seal.
 */
export function fleetWaveSeatFromWorker({
  worker,
  index,
  child
}: FleetWaveWorkerSeatInput): SeatChangeSeatState | null {
  const run = waveRun(child)
  const provider = trimmed(worker.provider) || trimmed(run?.provider) || trimmed(child?.provider)
  const model = resolvedModel(worker, run, child)
  if (!provider || !model) return null

  const providerId = provider as ProviderId
  const reasoningKey = REASONING_METADATA_KEYS[providerId]
  const reasoningEffort =
    trimmed(worker.reasoningEffort) ||
    (reasoningKey ? trimmed(metadataValue(reasoningKey, worker, run, child)) : '') ||
    trimmed(metadataValue('reasoningEffort', worker, run, child))
  const thinkingValue = metadataValue('kimiThinkingEnabled', worker, run, child)
  const explicitThinking = worker.kimiThinking
  const thinkingEnabled =
    typeof explicitThinking === 'boolean'
      ? explicitThinking
      : typeof thinkingValue === 'boolean'
        ? thinkingValue
        : undefined
  // The SEAL first, then the card's projected request. Inverted until now, so a
  // worker asked for at spawn time with one tier kept wearing that tier even
  // after the child run was clamped to another — the card claimed authority the
  // wave never had. `worker.permissionPresetId` is what was requested; the run's
  // signed posture is what executed. Older cards whose child carries no posture
  // still fall back to the request, and a worker with neither stays chip-less.
  const permissionPresetId = run?.permissionPosture?.signaturePresent
    ? trimmed(run.permissionPosture.presetId)
    : trimmed(run?.permissionPosture?.presetId) || trimmed(worker.permissionPresetId)
  // Same precedence as the preset above, off the same seal: the signed posture
  // is what executed, the projected request is only what was asked for.
  // A signed posture is authoritative even when it reports ZERO grants:
  // `positiveInt` maps 0 to undefined, so a `??` chain would fall through and
  // badge the run with the roster's stale count. Presence of the posture, not
  // truthiness of its number, decides which source wins.
  const grantsCount = run?.permissionPosture
    ? positiveInt(run.permissionPosture.externalPathGrantCount)
    : positiveInt(worker.grantsCount)
  const label =
    trimmed(worker.label) ||
    trimmed(worker.title) ||
    trimmed(worker.role) ||
    `agent-${Math.max(1, index + 1)}`
  const workerStageRole = stageRole(worker.role)

  return {
    provider,
    model,
    role: label,
    seatNumber: Math.max(1, index + 1),
    ...(workerStageRole ? { stageRole: workerStageRole } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(thinkingEnabled === undefined ? {} : { thinkingEnabled }),
    ...(permissionPresetId ? { permissionPresetId } : {}),
    ...(grantsCount ? { grantsCount } : {})
  }
}
