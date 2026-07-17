import type { WorkflowRunTemplate } from './types'

/**
 * Runtime counterpart to the WorkflowRunTemplate type allowlist. The exhaustive
 * Record makes a template-field change fail typechecking until this trust
 * boundary is reviewed deliberately.
 */
const WORKFLOW_RUN_TEMPLATE_FIELDS: Record<keyof WorkflowRunTemplate, true> = {
  workspaceId: true,
  workspacePath: true,
  chatId: true,
  provider: true,
  prompt: true,
  displayPrompt: true,
  selectedModelType: true,
  customModel: true,
  approvalMode: true,
  permissionPresetId: true,
  workflowMode: true,
  sessionTrust: true,
  imageAttachments: true,
  externalPathGrants: true,
  geminiWorktree: true,
  codexReasoningEffort: true,
  codexServiceTier: true,
  claudeReasoningEffort: true,
  claudeFastMode: true,
  kimiFastMode: true,
  kimiReasoningEffort: true,
  kimiThinkingEnabled: true,
  grokReasoningEffort: true,
  cursorReasoningEffort: true,
  cursorFastMode: true,
  runtimeProfileId: true,
  geminiAuthProfileId: true,
  handoffSourceRunId: true,
  kind: true,
  ensembleSnapshot: true
}

const workflowRunTemplateFields = Object.keys(
  WORKFLOW_RUN_TEMPLATE_FIELDS
) as (keyof WorkflowRunTemplate)[]

export function pickWorkflowRunTemplateFields(
  value: Readonly<Record<string, unknown>>
): Partial<WorkflowRunTemplate> {
  const picked: Record<string, unknown> = {}
  for (const field of workflowRunTemplateFields) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      picked[field] = value[field]
    }
  }
  return picked as Partial<WorkflowRunTemplate>
}
