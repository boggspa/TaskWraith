import type { AgenticServiceId, ProviderId } from '../../../main/store/types'
import type { ExactCommandRuleOfferView } from '../../../shared/commandRules'

type AgentApprovalAction =
  | 'accept'
  | 'acceptForSession'
  | 'acceptForWorkspace'
  | 'decline'
  | 'cancel'
  | 'useProviderNative'
  | 'useTaskWraithSubthread'
  // Slice 4 of the external-path-redesign arc. See the same union
  // in src/main/store/types.ts:84 — mirrored here because App.tsx
  // declares its own copy rather than importing the canonical
  // definition. A follow-up unification would import from types.ts.
  | 'grantExternalPathRead'
  | 'grantExternalPathEdit'
  | 'declineExternalPath'

interface AgentApprovalRequest {
  id: string
  provider: ProviderId
  service?: AgenticServiceId
  appRunId?: string
  appChatId?: string
  method: string
  title: string
  body: string
  preview?: any
  actions: AgentApprovalAction[]
}

const isNativeSubAgentPreferenceApproval = (request: AgentApprovalRequest | null): boolean =>
  Boolean(
    request?.actions?.includes('useProviderNative') ||
    request?.actions?.includes('useTaskWraithSubthread')
  )

const exactCommandRuleOfferForApproval = (
  request: AgentApprovalRequest | null | undefined
): ExactCommandRuleOfferView | null => {
  const offer = request?.preview?.exactCommandRuleOffer
  if (
    !offer ||
    typeof offer !== 'object' ||
    offer.kind !== 'brokered_shell_exact_argv' ||
    offer.riskClass !== 'host_exact_unsandboxed' ||
    offer.scope !== 'one_workspace_exact_argv' ||
    typeof offer.offerId !== 'string' ||
    !offer.offerId.trim() ||
    typeof offer.fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(offer.fingerprint) ||
    typeof offer.cwdRelativePath !== 'string' ||
    typeof offer.executableName !== 'string'
  ) {
    return null
  }
  return offer as ExactCommandRuleOfferView
}

export type { AgentApprovalAction, AgentApprovalRequest }
export { exactCommandRuleOfferForApproval, isNativeSubAgentPreferenceApproval }
