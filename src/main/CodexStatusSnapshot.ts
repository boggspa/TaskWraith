export interface CodexStatusSnapshotInput {
  version: unknown
  clientStarted: boolean
  accountStatus?: any
  rateLimitStatus?: any
  codexUsage?: any
  startupError?: string | null
}

export function buildCodexStatusSnapshot(input: CodexStatusSnapshotInput): any {
  if (input.startupError) {
    return {
      provider: 'codex',
      available: false,
      setupRequired: true,
      version: input.version,
      appServer: 'unavailable',
      authState: 'unknown',
      planType: null,
      account: null,
      requiresOpenaiAuth: false,
      rateLimits: null,
      rateLimitsByLimitId: null,
      codexUsage: input.codexUsage,
      error: input.startupError
    }
  }

  const accountStatus =
    input.accountStatus && typeof input.accountStatus === 'object' ? input.accountStatus : null
  const account = accountStatus?.account || null
  const accountError =
    typeof accountStatus?.error === 'string' && accountStatus.error.trim()
      ? accountStatus.error.trim()
      : null
  const accountReadSucceeded = Boolean(
    accountStatus &&
      !accountError &&
      (account || typeof accountStatus.requiresOpenaiAuth === 'boolean')
  )
  const requiresOpenaiAuth =
    accountReadSucceeded && !account && accountStatus.requiresOpenaiAuth === true
  const authState = account
    ? account.type
    : requiresOpenaiAuth
      ? 'missing'
      : accountReadSucceeded
        ? 'not-required'
        : 'unknown'
  return {
    provider: 'codex',
    available: true,
    ...(requiresOpenaiAuth
      ? {
          setupRequired: true,
          error:
            'TaskWraith Codex sign-in is required. Open Settings → Providers → Codex to sign in to the private TaskWraith Codex home.'
        }
      : {}),
    version: input.version,
    appServer: input.clientStarted ? 'started' : 'lazy',
    authState,
    planType: account?.planType || null,
    account,
    requiresOpenaiAuth,
    rateLimits: input.rateLimitStatus?.rateLimits || null,
    rateLimitsByLimitId: input.rateLimitStatus?.rateLimitsByLimitId || null,
    codexUsage: input.codexUsage,
    ...(!requiresOpenaiAuth && accountError ? { error: accountError } : {})
  }
}
