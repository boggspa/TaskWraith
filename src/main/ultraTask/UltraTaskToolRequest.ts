import type { ProviderId } from '../store/types'
import type { DelegateWaveWorkerSpec } from '../SubThreadDelegateWave'
import { isEnsembleSeatProvider } from '../../shared/retiredProviders'
import { getStaticProviderModels } from '../providers/StaticProviderModels'
import { resolveSubThreadDelegationRunSettings } from '../SubThreadDelegationRunSettings'
import { isUltraTaskSupported } from './UltraTaskReasoningResolver'

/** `maxWorkers` is the legacy public name for the durable graph's independent
 * scout-stage count. The V1 graph admits two through six bounded scouts. */
export const ULTRA_TASK_MAX_EFFECTIVE_WORKERS = 6
export const ULTRA_TASK_DEFAULT_EFFECTIVE_WORKERS = 3

const DOCUMENTED_MAX_WORKERS = 64
const MODEL_MAX_LENGTH = 200
const DOCUMENTED_REASONING_OVERRIDES = new Set([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultracode'
])

export interface UltraTaskSignedRunContext {
  /** Main-verified provider for the active run, never a provider-authored arg. */
  provider: ProviderId
  /** Main-verified concrete model for the active run. Never infer a sentinel. */
  model?: string | null
  /** Configured providers the caller may target. Omit only in pure/unit callers. */
  allowedProviders?: readonly ProviderId[]
}

export interface ResolvedUltraTaskToolRequest {
  task: string
  provider: ProviderId
  model: string
  reasoningEffort?: string
  returnResult: true
  requestedMaxWorkers: number
  effectiveMaxWorkers: number
  scoutCount: number
  maxWorkersClamped: boolean
  notice?: string
  /** Presentation-only stage roster for the central approval preview. The
   * durable execution graph, not a provider-owned wave, performs the work. */
  approvalPreviewWorkers: DelegateWaveWorkerSpec[]
  /** @deprecated Composition-root compatibility until every approval preview
   * reads `approvalPreviewWorkers`; never pass this to the wave executor. */
  waveArgs: { workers: DelegateWaveWorkerSpec[] }
}

export interface UltraTaskToolModelOption {
  id: string
  label: string
  isDefault: boolean
  ultraTaskSupported: boolean
}

export type UltraTaskToolRequestResolution =
  | { ok: true; value: ResolvedUltraTaskToolRequest }
  | { ok: false; message: string; models?: UltraTaskToolModelOption[] }

function fail(
  message: string,
  models?: UltraTaskToolModelOption[]
): UltraTaskToolRequestResolution {
  return {
    ok: false,
    message: `ultra_task: ${message}`,
    ...(models?.length ? { models } : {})
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isConcreteModelId(value: string): boolean {
  const model = value.trim().toLowerCase()
  return Boolean(model) && model !== 'cli-default' && model !== 'default' && model !== 'custom'
}

function providerModelOptions(provider: ProviderId): UltraTaskToolModelOption[] {
  const models = getStaticProviderModels(provider, { includePreviewModels: true }) as Array<{
    id: string
    label?: string
    isDefault?: boolean
    disabled?: boolean
    ultraTaskSupported?: boolean
  }>
  return models
    .filter((candidate) => !candidate.disabled && isConcreteModelId(candidate.id))
    .map((candidate) => ({
      id: candidate.id,
      label: candidate.label?.trim() || candidate.id,
      isDefault: candidate.isDefault === true,
      ultraTaskSupported: candidate.ultraTaskSupported === true
    }))
    .sort(
      (left, right) =>
        Number(right.isDefault) - Number(left.isDefault) ||
        left.label.localeCompare(right.label) ||
        left.id.localeCompare(right.id)
    )
}

function modelOptionsMessage(models: readonly UltraTaskToolModelOption[]): string {
  if (models.length === 0) return 'No concrete models are currently listed for that provider.'
  const visible = models.slice(0, 24).map((model) => model.id)
  return `Available concrete models: ${visible.join(', ')}${
    models.length > visible.length ? `, … (${models.length - visible.length} more)` : ''
  }.`
}

function concreteCurrentModel(context: UltraTaskSignedRunContext): string | null {
  const model = typeof context.model === 'string' ? context.model.trim() : ''
  return isConcreteModelId(model) ? model : null
}

function parseProvider(
  value: unknown,
  context: UltraTaskSignedRunContext
): { ok: true; provider: ProviderId } | { ok: false; message: string } {
  const raw = value === undefined ? context.provider : value
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, message: 'provider must be a non-empty string when provided.' }
  }
  const providerValue = raw.trim().toLowerCase()
  if (!isEnsembleSeatProvider(providerValue)) {
    return { ok: false, message: `provider "${providerValue}" is not live-selectable.` }
  }
  const provider = providerValue as ProviderId
  const allowed = context.allowedProviders
  if (
    allowed &&
    provider !== context.provider &&
    !allowed.some((candidate) => candidate === provider)
  ) {
    return { ok: false, message: `provider "${provider}" is not configured for this run.` }
  }
  return { ok: true, provider }
}

function parseModel(
  value: unknown,
  provider: ProviderId,
  context: UltraTaskSignedRunContext
):
  | { ok: true; model: string }
  | { ok: false; message: string; models: UltraTaskToolModelOption[] } {
  const models = providerModelOptions(provider)
  if (value !== undefined) {
    if (typeof value !== 'string' || !value.trim()) {
      return { ok: false, message: 'model must be a non-empty string when provided.', models }
    }
    const model = value.trim()
    if (!isConcreteModelId(model)) {
      return {
        ok: false,
        message:
          'model must be a concrete model id; cli-default, default, and custom cannot run UltraTask. ' +
          modelOptionsMessage(models),
        models
      }
    }
    if (model.length > MODEL_MAX_LENGTH) {
      return {
        ok: false,
        message: `model must be ${MODEL_MAX_LENGTH} characters or fewer.`,
        models
      }
    }
    return { ok: true, model }
  }

  const model = provider === context.provider ? concreteCurrentModel(context) : null
  return model
    ? { ok: true, model }
    : {
        ok: false,
        message:
          provider === context.provider
            ? 'the active run has no concrete model. Select a concrete model in the provider/model picker before calling ultra_task. ' +
              modelOptionsMessage(models)
            : `model is required when UltraTask targets ${provider}; TaskWraith will not silently select that provider's default. ` +
              modelOptionsMessage(models),
        models
      }
}

function parseBoolean(
  value: unknown,
  label: string,
  fallback: boolean
): { ok: true; value: boolean } | { ok: false; message: string } {
  if (value === undefined) return { ok: true, value: fallback }
  return typeof value === 'boolean'
    ? { ok: true, value }
    : { ok: false, message: `${label} must be a boolean when provided.` }
}

function parseMaxWorkers(value: unknown):
  | {
      ok: true
      requested: number
      effective: number
      clamped: boolean
    }
  | { ok: false; message: string } {
  const requested = value === undefined ? ULTRA_TASK_DEFAULT_EFFECTIVE_WORKERS : value
  if (
    typeof requested !== 'number' ||
    !Number.isInteger(requested) ||
    requested < 2 ||
    requested > DOCUMENTED_MAX_WORKERS
  ) {
    return {
      ok: false,
      message: `maxWorkers must be an integer from 2 to ${DOCUMENTED_MAX_WORKERS}.`
    }
  }
  return {
    ok: true,
    requested,
    effective: Math.min(requested, ULTRA_TASK_MAX_EFFECTIVE_WORKERS),
    clamped: requested > ULTRA_TASK_MAX_EFFECTIVE_WORKERS
  }
}

function workerWithControls(
  provider: ProviderId,
  model: string,
  reasoningEffort: string | undefined,
  kimiThinking: boolean | undefined,
  input: Pick<DelegateWaveWorkerSpec, 'prompt' | 'role' | 'label'>
): DelegateWaveWorkerSpec {
  return {
    provider,
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(typeof kimiThinking === 'boolean' ? { kimiThinking } : {}),
    ...input
  }
}

/**
 * Validate the public `ultra_task` request and bind its defaults to the active,
 * already-verified run identity. The provider/model never fall back to the old
 * `parentProvider + cli-default` guess.
 *
 * This resolves controls for the staged durable graph. It does not construct
 * or join a provider-owned wave.
 */
export function resolveUltraTaskToolRequest(
  args: unknown,
  context: UltraTaskSignedRunContext
): UltraTaskToolRequestResolution {
  if (!isRecord(args)) return fail('arguments must be an object.')

  const task = typeof args.task === 'string' ? args.task.trim() : ''
  if (!task) return fail('task is required.')

  const providerResult = parseProvider(args.provider, context)
  if (!providerResult.ok) return fail(providerResult.message)
  const provider = providerResult.provider

  const modelResult = parseModel(args.model, provider, context)
  if (!modelResult.ok) return fail(modelResult.message, modelResult.models)
  const model = modelResult.model

  const returnResult = parseBoolean(args.returnResult, 'returnResult', true)
  if (!returnResult.ok) return fail(returnResult.message)
  if (!returnResult.value) {
    return fail('returnResult=false is not supported; UltraTask waves always return their results.')
  }

  const enableFanout = parseBoolean(args.enableFanout, 'enableFanout', true)
  if (!enableFanout.ok) return fail(enableFanout.message)
  if (!enableFanout.value) {
    return fail(
      'enableFanout=false is not supported by the staged UltraTask graph; at least two scouts are required.'
    )
  }
  const enableReview = parseBoolean(args.enableReview, 'enableReview', true)
  if (!enableReview.ok) return fail(enableReview.message)
  if (!enableReview.value) {
    return fail(
      'enableReview=false is not supported by the staged UltraTask graph; independent review is required.'
    )
  }
  const maxWorkers = parseMaxWorkers(args.maxWorkers)
  if (!maxWorkers.ok) return fail(maxWorkers.message)

  if (args.reasoningEffort !== undefined) {
    if (typeof args.reasoningEffort !== 'string' || !args.reasoningEffort.trim()) {
      return fail('reasoningEffort must be a non-empty string when provided.')
    }
    const override = args.reasoningEffort.trim().toLowerCase()
    if (!DOCUMENTED_REASONING_OVERRIDES.has(override)) {
      return fail(
        `reasoningEffort="${override}" is not documented. Supported overrides: ${[
          ...DOCUMENTED_REASONING_OVERRIDES
        ].join(', ')}.`
      )
    }
  }
  if (!isUltraTaskSupported(provider, model)) {
    return fail(`${provider} model "${model}" does not support UltraTask.`)
  }

  const requestedReasoningEffort =
    // Preserve the synthetic token until the provider/model-aware delegation
    // resolver sees it. Its existing CLI normalizers then map to the real
    // ceiling (Pi max, Muse ultra, Grok 4.5 high, Ollama on, etc.); the older
    // generic UltraTask resolver's provider fallback was merely `high` and
    // silently under-ran several providers.
    args.reasoningEffort === undefined ? 'ultratask' : args.reasoningEffort
  const settings = resolveSubThreadDelegationRunSettings({
    provider,
    model,
    ...(requestedReasoningEffort === 'none' ? {} : { reasoningEffort: requestedReasoningEffort })
  })
  if (!settings.ok) return fail(settings.message.replace(/^delegate_to_subthread:\s*/, ''))

  const approvalPreviewWorkers: DelegateWaveWorkerSpec[] = [
    ...Array.from({ length: maxWorkers.effective }, (_entry, index) =>
      workerWithControls(
        provider,
        settings.requestedModel,
        settings.reasoningEffort,
        settings.kimiThinking,
        {
          role: 'scout',
          label: `Scout ${index + 1}`,
          prompt: `Investigate the assigned aspect of the UltraTask independently: ${task}`
        }
      )
    ),
    workerWithControls(
      provider,
      settings.requestedModel,
      settings.reasoningEffort,
      settings.kimiThinking,
      {
        role: 'worker',
        label: 'Primary Worker',
        prompt: task
      }
    ),
    workerWithControls(
      provider,
      settings.requestedModel,
      settings.reasoningEffort,
      settings.kimiThinking,
      {
        role: 'reviewer',
        label: 'Independent Reviewer',
        prompt: `Review the terminal worker artifact for the UltraTask: ${task}`
      }
    ),
    workerWithControls(
      provider,
      settings.requestedModel,
      settings.reasoningEffort,
      settings.kimiThinking,
      {
        role: 'worker',
        label: 'Synthesis',
        prompt: `Synthesize the worker artifact and reviewer verdict for the UltraTask: ${task}`
      }
    )
  ]

  const notices: string[] = []
  if (maxWorkers.clamped) {
    notices.push(
      `maxWorkers=${maxWorkers.requested} was capped at ${ULTRA_TASK_MAX_EFFECTIVE_WORKERS} durable scout stages.`
    )
  }
  const notice = notices.length > 0 ? notices.join(' ') : undefined
  return {
    ok: true,
    value: {
      task,
      provider,
      model: settings.requestedModel,
      ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
      returnResult: true,
      requestedMaxWorkers: maxWorkers.requested,
      effectiveMaxWorkers: maxWorkers.effective,
      scoutCount: maxWorkers.effective,
      maxWorkersClamped: maxWorkers.clamped,
      ...(notice ? { notice } : {}),
      approvalPreviewWorkers,
      waveArgs: { workers: approvalPreviewWorkers }
    }
  }
}
