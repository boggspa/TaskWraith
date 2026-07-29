export interface WorkspaceLockProcessTreeProbeInput {
  rootPid: number
  isolatedProcessGroup: boolean
}

export interface WorkspaceLockProcessTreeProbeDependencies {
  platform?: NodeJS.Platform
  signalProcessGroup?: (processGroupId: number, signal: 0) => void
  wait?: (delayMs: number) => Promise<void>
}

export interface WorkspaceLockProcessTreeProbeOptions {
  timeoutMs?: number
  pollIntervalMs?: number
}

const POSIX_PROCESS_GROUP_PLATFORMS = new Set<NodeJS.Platform>([
  'aix',
  'darwin',
  'freebsd',
  'linux',
  'openbsd',
  'sunos'
])

/**
 * Proves that a process group created solely for one workspace mutation has no
 * remaining members. A leader close alone is never accepted: hooks, plugins,
 * or provider tools may leave descendants behind.
 *
 * Windows needs a kernel Job Object (or an equivalent exact tree authority);
 * without one this probe deliberately returns false so the durable child claim
 * remains quarantined.
 */
export async function waitForWorkspaceLockProcessTreeExit(
  input: WorkspaceLockProcessTreeProbeInput,
  options: WorkspaceLockProcessTreeProbeOptions = {},
  dependencies: WorkspaceLockProcessTreeProbeDependencies = {}
): Promise<boolean> {
  if (!Number.isSafeInteger(input.rootPid) || input.rootPid <= 1) return false
  if (!input.isolatedProcessGroup) return false

  const platform = dependencies.platform ?? process.platform
  if (!POSIX_PROCESS_GROUP_PLATFORMS.has(platform)) return false

  const signalProcessGroup =
    dependencies.signalProcessGroup ??
    ((processGroupId: number, signal: 0) => process.kill(-processGroupId, signal))
  const wait =
    dependencies.wait ??
    ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)))
  const timeoutMs = Math.max(0, options.timeoutMs ?? 2_000)
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 50)
  const deadline = Date.now() + timeoutMs

  for (;;) {
    if (processGroupIsDefinitelyGone(input.rootPid, signalProcessGroup)) return true
    if (Date.now() >= deadline) return false
    await wait(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())))
  }
}

function processGroupIsDefinitelyGone(
  processGroupId: number,
  signalProcessGroup: (processGroupId: number, signal: 0) => void
): boolean {
  try {
    signalProcessGroup(processGroupId, 0)
    return false
  } catch (error) {
    return (
      Boolean(error) &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ESRCH'
    )
  }
}
