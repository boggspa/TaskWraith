import type { AgentApprovalAction } from './agentApprovalTypes'

export interface ApprovalActionPresentation {
  label: string
  title: string
}

function serviceSubject(serviceLabel: string | null | undefined): string | null {
  const normalized = serviceLabel?.trim()
  if (!normalized) return null
  return /^[A-Z][a-z]/.test(normalized)
    ? `${normalized.charAt(0).toLowerCase()}${normalized.slice(1)}`
    : normalized
}

/**
 * User-facing approval copy. `acceptForSession` is a historical protocol name:
 * TaskWraith attaches its normal grant to the active run and clears it when
 * that run finishes, so no surface should describe it as app-lifetime access.
 */
export function approvalActionPresentation(
  action: AgentApprovalAction,
  options: { serviceLabel?: string | null } = {}
): ApprovalActionPresentation {
  const service = serviceSubject(options.serviceLabel)

  switch (action) {
    case 'accept':
      return {
        label: 'Allow once',
        title: 'Allow only this approval request. Future similar requests will still ask.'
      }
    case 'acceptForSession':
      return {
        label: service
          ? `Allow all ${service} for this run`
          : 'Allow matching requests for this run',
        title: service
          ? `Allow all ${service} for the rest of this run. This grant ends when the run ends.`
          : 'Allow matching requests for the rest of this run. This grant ends when the run ends.'
      }
    case 'acceptForWorkspace':
      return {
        label: service
          ? `Allow all ${service} in this workspace`
          : 'Allow matching requests in this workspace',
        title: service
          ? `Allow all ${service} in this workspace. This broad grant persists until revoked in Approvals & Grants.`
          : 'Allow matching requests in this workspace. This broad grant persists until revoked in Approvals & Grants.'
      }
    case 'decline':
      return {
        label: 'Deny',
        title:
          'Deny this request and let the current run continue or fail according to the provider.'
      }
    case 'cancel':
      return {
        label: 'Cancel run',
        title: 'Cancel this pending approval request.'
      }
    case 'useProviderNative':
      return {
        label: 'Use Provider Native',
        title:
          'Use the provider CLI or SDK native approval flow for this request instead of TaskWraith handling it.'
      }
    case 'useTaskWraithSubthread':
      return {
        label: 'Use TaskWraith Sub-thread',
        title:
          'Move this work into a TaskWraith sub-thread so it can continue with isolated context and its own approval handling.'
      }
    case 'grantExternalPathRead':
      return {
        label: 'Grant read access',
        title: 'Grant read-only access to the detected external path for this request.'
      }
    case 'grantExternalPathEdit':
      return {
        label: 'Grant edit access',
        title: 'Grant edit access to the detected external path for this request.'
      }
    case 'declineExternalPath':
      return {
        label: 'Deny once',
        title:
          'Deny this external path request once. The agent may ask again if it still needs the path.'
      }
  }
}
