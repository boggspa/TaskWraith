import { isAbsolute } from 'node:path'

export const GROK_USAGE_BINARY_OVERRIDE_ENV = 'TASKWRAITH_GROK_USAGE_BINARY_OVERRIDE'

interface GrokUsageBinaryLike {
  binaryPath: string | null
}

export interface GrokUsageProbeBinaryResolution {
  binaryPath: string | null
  source: 'override' | 'invalid_override' | 'discovered' | 'missing'
}

export async function resolveGrokUsageProbeBinary(options: {
  env: Readonly<Record<string, string | undefined>>
  resolveDefault: () => Promise<GrokUsageBinaryLike>
}): Promise<GrokUsageProbeBinaryResolution> {
  const configured = options.env[GROK_USAGE_BINARY_OVERRIDE_ENV]
  if (configured !== undefined) {
    const binaryPath = configured.trim()
    if (!binaryPath || !isAbsolute(binaryPath)) {
      return { binaryPath: null, source: 'invalid_override' }
    }
    return { binaryPath, source: 'override' }
  }

  const resolved = await options.resolveDefault()
  return {
    binaryPath: resolved.binaryPath,
    source: resolved.binaryPath ? 'discovered' : 'missing'
  }
}
