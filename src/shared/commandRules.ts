export interface ExactCommandRuleOfferView {
  offerId: string
  kind: 'brokered_shell_exact_argv'
  fingerprint: string
  cwdRelativePath: string
  executableName: string
  riskClass: 'host_exact_unsandboxed'
  scope: 'one_workspace_exact_argv'
}

/** Renderer-safe projection. HMAC signatures and executable hashes stay in main. */
export interface CommandRuleListItem {
  id: string
  workspaceId: string
  workspacePath: string
  cwdRelativePath: string
  executablePath: string
  argv: string[]
  fingerprint: string
  riskClass: 'host_exact_unsandboxed'
  createdAt: string
  updatedAt: string
}

export interface CommandRuleMutationResult {
  ok: boolean
  error?: string
  created?: boolean
  rule?: CommandRuleListItem
}
