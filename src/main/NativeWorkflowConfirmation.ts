import { dialog, type BrowserWindow } from 'electron'
import type { WorkflowDefinition } from './store/types'
import type { UnattendedElevationLevel } from './UnattendedPostureGate'
import { coerceApprovalMode } from './RunPermissionPosture'

export interface NativeWorkflowConfirmationOptions {
  title: string
  message: string
  detail: string
  confirmLabel: string
}

function compact(value: unknown, maxLength = 180): string {
  const withoutControls = Array.from(String(value ?? ''), (character) => {
    const codePoint = character.codePointAt(0) || 0
    const unsafe =
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x061c ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    return unsafe ? ' ' : character
  }).join('')
  const normalized = withoutControls
    .replace(/\s+/g, ' ')
    .trim()
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized
}

export function describeWorkflowAuthorityForNativeConfirmation(
  workflow: WorkflowDefinition
): string {
  const trigger = workflow.trigger
  const schedule =
    trigger.kind === 'interval'
      ? `every ${Math.round((trigger.intervalMs || 60_000) / 60_000)} minute(s)`
      : trigger.kind === 'once'
        ? `once at ${compact(trigger.runAt)}`
        : trigger.kind === 'cron'
          ? `cron ${compact(trigger.cronExpression)}`
          : 'manual only'
  const grants = workflow.template.externalPathGrants || []
  const grantSummary = grants.length
    ? grants
        .slice(0, 3)
        .map((grant) => `${grant.access}: ${compact(grant.path, 100)}`)
        .join(', ') + (grants.length > 3 ? ` (+${grants.length - 3} more)` : '')
    : 'none'
  const ensembleSummary =
    workflow.template.kind === 'ensemble'
      ? `${workflow.template.ensembleSnapshot?.participants.length || 0} participant(s)`
      : 'single provider'
  const loopSummary = workflow.loop
    ? `up to ${workflow.loop.acceptance.maxIterations} iteration(s) / ${workflow.loop.limits.maxRuns} run(s)`
    : 'off'
  return [
    `Workflow: ${compact(workflow.name, 100)}`,
    `Workspace: ${compact(workflow.workspacePath)}`,
    `Chat: ${compact(workflow.template.chatId)}`,
    `Provider/model: ${workflow.template.provider} / ${compact(
      workflow.template.customModel || workflow.template.selectedModelType || 'default'
    )}`,
    `Prompt: ${compact(workflow.template.prompt)}`,
    `Schedule: ${schedule}`,
    `Approval: ${coerceApprovalMode(workflow.template.approvalMode) || 'default'}`,
    `Attachments: ${workflow.template.imageAttachments.length}`,
    `External access: ${grantSummary}`,
    `Ensemble: ${ensembleSummary}`,
    `Loop: ${loopSummary}`
  ].join('\n')
}

function permissionLabel(level: Exclude<UnattendedElevationLevel, 'safe'>): string {
  return level === 'full_access' ? 'Full Access' : 'Accept Edits'
}

export function buildWorkflowElevationConfirmationOptions(
  workflow: WorkflowDefinition,
  level: Exclude<UnattendedElevationLevel, 'safe'>
): NativeWorkflowConfirmationOptions {
  const label = permissionLabel(level)
  return {
    title: 'Authorize unattended workflow',
    message: `Authorize ${label} for this unattended workflow?`,
    detail:
      `${describeWorkflowAuthorityForNativeConfirmation(workflow)}\n\n` +
      'This authorizes the current workflow configuration only. Changing its schedule or ' +
      'execution authority revokes the authorization.',
    confirmLabel: `Allow ${label}`
  }
}

export function buildElevatedWorkflowRunNowConfirmationOptions(
  workflow: WorkflowDefinition,
  level: Exclude<UnattendedElevationLevel, 'safe'>
): NativeWorkflowConfirmationOptions {
  const label = permissionLabel(level)
  return {
    title: 'Run elevated workflow now',
    message: `Run this workflow now with ${label}?`,
    detail:
      `${describeWorkflowAuthorityForNativeConfirmation(workflow)}\n\n` +
      'This starts an elevated occurrence immediately, outside its normal schedule.',
    confirmLabel: 'Run Now'
  }
}

/** MAIN-native user intent gate. Absence/destruction of the owning window is a decline. */
export async function confirmNativeWorkflowAuthority(
  owner: BrowserWindow | null,
  options: NativeWorkflowConfirmationOptions
): Promise<boolean> {
  if (!owner || owner.isDestroyed()) return false
  const result = await dialog.showMessageBox(owner, {
    type: 'warning',
    title: options.title,
    message: options.message,
    detail: options.detail,
    buttons: ['Cancel', options.confirmLabel],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  return result.response === 1
}
