export interface NativeProcessIdentityDaemon {
  request(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown>
}

export interface NativeProcessIdentityResolverOptions {
  readonly daemon: NativeProcessIdentityDaemon
  readonly platform?: NodeJS.Platform
  readonly timeoutMs?: number
}

/**
 * Builds the launch-time PID birth-receipt resolver used by LaunchManager.
 *
 * The native daemon is the authority for proc_bsdinfo. Any missing, extra, or
 * inconsistent response field leaves the launch usable but view-only.
 */
export function createNativeProcessStartedAtResolver(
  options: NativeProcessIdentityResolverOptions
): (pid: number) => Promise<string | null> {
  const platform = options.platform ?? process.platform
  const timeoutMs = options.timeoutMs ?? 2_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('Native process-identity timeout must be a positive integer.')
  }

  return async (pid: number): Promise<string | null> => {
    if (platform !== 'darwin' || !Number.isSafeInteger(pid) || pid <= 1) return null
    try {
      const response = await options.daemon.request(
        'nativeWindow.processIdentity',
        { pid },
        { timeoutMs }
      )
      if (!isRecord(response) || Object.keys(response).length !== 4 || response.pid !== pid) {
        return null
      }
      const launchTimeMicros = response.launchTimeMicros
      if (
        response.source !== 'procBSDInfo' ||
        !Number.isSafeInteger(launchTimeMicros) ||
        Number(launchTimeMicros) <= 0 ||
        response.processStartedAt !== `procBSDInfo:${launchTimeMicros}`
      ) {
        return null
      }
      return response.processStartedAt
    } catch {
      return null
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
