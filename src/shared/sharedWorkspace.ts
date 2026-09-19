export interface SharedWorkspaceContribution {
  id: string
  generation: string
  provider: string
  chatId?: string
  participantId?: string
  paths: string[]
  editCount: number
  updatedAt: string
  state: 'ready' | 'changed' | 'interrupted'
  reason?: string
  /**
   * How the mutation was executed. Absent means 'broker': TaskWraith wrote the
   * file itself and the snapshot came from a pinned descriptor, so it provably
   * captures the bytes that were replaced. 'provider-native' means the
   * provider's own tool wrote it and TaskWraith read the file either side --
   * a weaker guarantee with no fence against a concurrent editor.
   */
  mutationOrigin?: 'broker' | 'provider-native'
}

export interface SharedWorkspaceContributionPreview extends SharedWorkspaceContribution {
  patch: string
  reversePatch: string
  recordIds: string[]
}

export interface SharedWorkspaceVerification {
  id: string
  command: string
  startedAt: string
  finishedAt: string
  state: 'passed' | 'failed' | 'changed' | 'unavailable'
  fingerprint: string | null
  reason?: string
}

export interface SharedWorkspaceOverview {
  contributions: SharedWorkspaceContribution[]
  truncated: boolean
  verification: SharedWorkspaceVerification | null
  coverage: string
}

export interface SharedWorkspaceActionRequest {
  id: string
  generation: string
  action: 'commit' | 'undo' | 'recover'
  message?: string
}

export interface SharedWorkspaceActionResult {
  ok: boolean
  error?: string
  commit?: string
  warning?: string
}
