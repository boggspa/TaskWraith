import type { AgenticServiceId, AgentApprovalAction } from './store/types'
export const AGENTIC_SERVICE_LABELS: Record<AgenticServiceId, string> = {
  shellCommands: 'Shell commands',
  fileChanges: 'File changes',
  externalPublish: 'External publishing',
  mcpTools: 'Tool calls',
  subThreadDelegation: 'Sub-thread delegation',
  canvasInteraction: 'Canvas interaction',
  crossThreadRead: 'Cross-thread read',
  mediaEditing: 'Media editing',
  mediaRecording: 'Media recording',
  canvasEval: 'Canvas eval'
}

export function agenticServiceBlockedMessage(service: AgenticServiceId): string {
  return `${AGENTIC_SERVICE_LABELS[service]} blocked by TaskWraith settings.`
}

export function agenticServiceDisabledMessage(service: AgenticServiceId): string {
  if (
    service === 'subThreadDelegation' ||
    service === 'externalPublish' ||
    service === 'canvasInteraction' ||
    service === 'crossThreadRead' ||
    service === 'mediaEditing' ||
    service === 'mediaRecording' ||
    service === 'canvasEval'
  ) {
    return `${AGENTIC_SERVICE_LABELS[service]} is disabled in TaskWraith settings.`
  }
  return `${AGENTIC_SERVICE_LABELS[service]} are disabled in TaskWraith settings.`
}

export const AGENTIC_SERVICE_IDS = new Set<AgenticServiceId>([
  'shellCommands',
  'fileChanges',
  'externalPublish',
  'mcpTools',
  'subThreadDelegation',
  'canvasInteraction',
  'crossThreadRead',
  'mediaEditing',
  'mediaRecording',
  'canvasEval'
])

export function assertAgenticServiceId(value: unknown): AgenticServiceId {
  if (typeof value === 'string' && AGENTIC_SERVICE_IDS.has(value as AgenticServiceId)) {
    return value as AgenticServiceId
  }
  throw new Error('Unknown agentic service id.')
}

export function approvalActionsForPolicy(
  policy: string,
  workspacePath?: string,
  service?: AgenticServiceId
): AgentApprovalAction[] {
  if (
    service === 'canvasEval' ||
    service === 'mediaRecording'
  ) {
    return ['accept', 'decline', 'cancel']
  }
  const actions: AgentApprovalAction[] = ['accept']
  if (policy === 'workspace' && workspacePath) {
    actions.push('acceptForWorkspace')
  }
  actions.push('acceptForSession', 'decline')
  return actions
}
