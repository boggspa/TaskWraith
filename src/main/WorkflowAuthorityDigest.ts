import { createHash } from 'node:crypto'
import type {
  ScheduledTaskAttachmentRef,
  WorkflowDefinition,
  WorkflowRunTemplate
} from './store/types'
import { pickWorkflowRunTemplateFields } from './store/WorkflowRunTemplate'

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

function attachmentAuthority(
  attachment: ScheduledTaskAttachmentRef
): Record<string, unknown> {
  if ('persistenceVersion' in attachment && attachment.persistenceVersion === 1) {
    return {
      persistenceVersion: 1,
      id: attachment.id,
      name: attachment.name,
      sha256: attachment.sha256,
      mimeType: attachment.mimeType.toLowerCase(),
      byteLength: attachment.byteLength
    }
  }
  return { id: attachment.id, name: attachment.name, path: attachment.path }
}

export function workflowRunTemplateAuthority(
  template: WorkflowRunTemplate,
  canonicalPath: (value: string) => string
): Record<string, unknown> {
  // The picker is backed by Record<keyof WorkflowRunTemplate, true>, so adding
  // a future runnable field fails typechecking until this boundary is reviewed.
  const exhaustiveTemplate = pickWorkflowRunTemplateFields(
    template as unknown as Readonly<Record<string, unknown>>
  )
  return {
    ...exhaustiveTemplate,
    workspaceId: template.workspaceId,
    workspacePath: canonicalPath(template.workspacePath),
    chatId: template.chatId,
    provider: template.provider,
    prompt: template.prompt,
    displayPrompt: template.displayPrompt || template.prompt,
    selectedModelType: template.selectedModelType,
    customModel: template.customModel,
    approvalMode: template.approvalMode,
    permissionPresetId: template.permissionPresetId,
    // `workflowMode` was optional on legacy workflow templates, while
    // materialized ScheduledTasks have always canonicalized omission to
    // `normal`. Treat both spellings as one authority value; `plan` remains a
    // distinct, explicitly authorized posture.
    workflowMode: template.workflowMode === 'plan' ? 'plan' : 'normal',
    sessionTrust: template.sessionTrust,
    imageAttachments: template.imageAttachments.map(attachmentAuthority),
    externalPathGrants: template.externalPathGrants || [],
    geminiWorktree: template.geminiWorktree,
    codexReasoningEffort: template.codexReasoningEffort,
    codexServiceTier: template.codexServiceTier,
    claudeReasoningEffort: template.claudeReasoningEffort,
    claudeFastMode: template.claudeFastMode,
    kimiFastMode: template.kimiFastMode,
    kimiReasoningEffort: template.kimiReasoningEffort,
    kimiThinkingEnabled: template.kimiThinkingEnabled,
    grokReasoningEffort: template.grokReasoningEffort,
    museReasoningEffort: template.museReasoningEffort,
    cursorReasoningEffort: template.cursorReasoningEffort,
    cursorFastMode: template.cursorFastMode,
    runtimeProfileId: template.runtimeProfileId,
    geminiAuthProfileId: template.geminiAuthProfileId,
    handoffSourceRunId: template.handoffSourceRunId,
    kind: template.kind || 'single',
    ensembleSnapshot: template.ensembleSnapshot
  }
}

/**
 * Authority intentionally excludes display/projection state (name, enabled,
 * timestamps, history and summaries) while binding every field that can change
 * what an unattended occurrence runs, where it runs, or under which policy.
 */
export function workflowAuthorityEnvelope(
  workflow: WorkflowDefinition,
  canonicalPath: (value: string) => string
): Record<string, unknown> {
  return {
    workspaceId: workflow.workspaceId,
    workspacePath: canonicalPath(workflow.workspacePath),
    template: workflowRunTemplateAuthority(workflow.template, canonicalPath),
    trigger: workflow.trigger,
    missedRunPolicy: workflow.missedRunPolicy,
    concurrencyPolicy: workflow.concurrencyPolicy,
    limits: workflow.limits,
    loop: workflow.loop
  }
}

export function workflowAuthorityDigest(
  workflow: WorkflowDefinition,
  canonicalPath: (value: string) => string
): string {
  return createHash('sha256')
    .update(stableStringify(workflowAuthorityEnvelope(workflow, canonicalPath)))
    .digest('hex')
}
