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
  const permissionPresetId =
    trimmed(worker.permissionPresetId) || trimmed(run?.permissionPosture?.presetId)
  const grantsCount =
    positiveInt(worker.grantsCount) ?? positiveInt(run?.permissionPosture?.externalPathGrantCount)
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
