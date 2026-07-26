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
          // Says WHY a CLI login does not count. TaskWraith runs Codex against
          // its own CODEX_HOME under userData, so `codex login` in a terminal
          // authenticates ~/.codex and leaves this home untouched — and nothing
          // migrates auth between them (only session rollouts move). Users who
          // are signed in to the CLI, the web, and see their plan read the old
          // wording as a bug in TaskWraith, because it names the remedy without
          // naming the cause. The in-app button is not merely a convenience: it
          // is the only flow that sets CODEX_HOME before running the sign-in.
          error:
            'TaskWraith Codex sign-in is required. TaskWraith keeps its own private Codex home, separate from the ~/.codex one the codex CLI signs into — so signing in from a terminal does not sign in here. Use Settings → Providers → Codex → Sign in, which runs the sign-in against TaskWraith’s home.'
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
