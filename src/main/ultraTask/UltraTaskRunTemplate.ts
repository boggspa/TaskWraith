import type {
  ChatWorkflowMode,
  PermissionPresetId,
  ProviderId,
  RunQueueRequestSnapshot
} from '../store/types'
import type { ExecutionEffect } from '../executionGraph/ExecutionGraphModel'
import { isConcreteUltraTaskModelId } from './UltraTaskCapabilityResolver'

export interface UltraTaskRunTemplateSeat {
  provider: ProviderId
  model: string
  reasoningEffort?: string
  runtimeProfileId?: string
}

export interface BuildUltraTaskRunTemplateRequestInput {
  prompt: string
  effect: Extract<ExecutionEffect, 'read_only' | 'workspace_write'>
  seat: UltraTaskRunTemplateSeat
  parentApprovalMode: string
  parentPermissionPresetId: PermissionPresetId
  parentWorkflowMode?: ChatWorkflowMode
}

function reasoningPatch(seat: UltraTaskRunTemplateSeat): Partial<RunQueueRequestSnapshot> {
  const effort = seat.reasoningEffort?.trim()
  if (!effort) return seat.provider === 'kimi' ? { kimiThinkingEnabled: true } : {}
  if (seat.provider === 'codex') return { codexReasoningEffort: effort }
  if (seat.provider === 'claude') return { claudeReasoningEffort: effort }
  if (seat.provider === 'kimi') {
    return { kimiReasoningEffort: effort, kimiThinkingEnabled: true }
  }
  if (seat.provider === 'grok') return { grokReasoningEffort: effort }
  if (seat.provider === 'muse') return { museReasoningEffort: effort }
  if (seat.provider === 'mistral') return { mistralReasoningEffort: effort }
  if (seat.provider === 'devin') return { devinReasoningEffort: effort }
  if (seat.provider === 'pi') return { piReasoningEffort: effort }
  if (seat.provider === 'ollama') return { ollamaReasoningEffort: effort }
  if (seat.provider === 'cursor') return { cursorReasoningEffort: effort }
  if (seat.provider === 'antigravity') return { antigravityReasoningEffort: effort }
  return {}
}

function durablePreset(
  effect: BuildUltraTaskRunTemplateRequestInput['effect'],
  parent: PermissionPresetId
): PermissionPresetId {
  if (effect === 'read_only') return 'read_only'
  return parent === 'full_access' ? 'workspace_write' : parent
}

/**
 * Build the frozen request stored in one UltraTask graph run template. No
 * parent transcript/session grants, picker consent, attachments, or run-bound
 * external grants cross this boundary; every stage receives only its explicit
 * provider/model/reasoning and its effect-derived durable permission posture.
 */
export function buildUltraTaskRunTemplateRequest(
  input: BuildUltraTaskRunTemplateRequestInput
): RunQueueRequestSnapshot {
  const prompt = input.prompt.trim()
  if (!prompt) throw new Error('UltraTask graph stage prompt is required.')
  if (!isConcreteUltraTaskModelId(input.seat.model)) {
    throw new Error('UltraTask graph stage requires an exact concrete model.')
  }
  const readOnly = input.effect === 'read_only'
  const approvalMode = readOnly ? 'plan' : input.parentApprovalMode.trim() || 'default'
  const permissionPresetId = durablePreset(input.effect, input.parentPermissionPresetId)
  return {
    scope: 'workspace',
    prompt,
    selectedModelType: input.seat.model,
    customModel: '',
    approvalMode,
    permissionPresetId,
    workflowMode: readOnly ? 'plan' : input.parentWorkflowMode === 'plan' ? 'plan' : 'normal',
    sessionTrust: false,
    imageAttachments: [],
    // Emitted only when non-empty. The run queue's snapshot normalizer maps an
    // empty grant list to `undefined` (dropped by JSON), and the graph dispatch
    // guard stable-stringifies this template against the queue row — so a
    // hard-coded `[]` here can never match its own queue request.
    ...(input.seat.runtimeProfileId?.trim()
      ? { runtimeProfileId: input.seat.runtimeProfileId.trim() }
      : {}),
    ...reasoningPatch(input.seat)
  }
}
