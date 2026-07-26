import { withCodexCodeModeHostEnv } from '../CodexCodeModeHost'
import { withTaskWraithCodexHomeEnv } from './CodexHome'
import {
  createCliSpawnPlan,
  createResolvedProviderEnv,
  type CliProviderRuntimeDependencies
} from '../providers/CliProviderRuntime'
import type { RuntimeProfile } from '../store/types'
import {
  collectUserMcpProviderEnv,
  type UserMcpLaunchServer
} from '../UserMcpServers'

export interface CodexAppServerMcpLaunchFacts {
  readonly enabled: boolean
  readonly parentProvider: 'codex'
  readonly userMcpServers?: readonly UserMcpLaunchServer[]
}

export interface CodexAppServerProcessLaunchPlan {
  readonly transport: 'app-server'
  readonly startupCompatibility: 'configured' | 'force-fast-service-tier'
  readonly command: string
  readonly args: readonly string[]
  readonly shell: boolean
  readonly env: Readonly<Record<string, string>>
}

export interface CodexAppServerProcessLaunchPlanInput {
  readonly binaryPath: string
  readonly codexHome: string
  readonly mcpConfigArgs: readonly string[]
  readonly mcp: CodexAppServerMcpLaunchFacts
  readonly runtimeProfile: RuntimeProfile | null
  readonly forceFastServiceTier?: boolean
  readonly cliRuntimeDeps?: CliProviderRuntimeDependencies
  /**
   * Test seam for the optional code-mode companion. Production and seal
   * evidence intentionally use the same default resolver.
   */
  readonly withCodeModeHostEnv?: (
    env: Record<string, string>,
    binaryPath: string
  ) => Promise<Record<string, string>>
}

export function buildCodexFastServiceTierCompatibilityArgs(): string[] {
  return ['-c', 'service_tier="fast"']
}

/**
 * Build the exact immutable process plan consumed by Codex app-server spawn.
 *
 * Runtime-profile env is resolved here rather than by the caller. This keeps
 * profile identity, secret refs, user-MCP provider env, private CODEX_HOME and
 * the optional code-mode companion in one authority path shared by production
 * dispatch and scheduled-launch evidence.
 */
export async function buildCodexAppServerProcessLaunchPlan(
  input: CodexAppServerProcessLaunchPlanInput
): Promise<CodexAppServerProcessLaunchPlan> {
  const args = [
    ...(input.forceFastServiceTier ? buildCodexFastServiceTierCompatibilityArgs() : []),
    ...input.mcpConfigArgs,
    'app-server'
  ]
  const launchEnv = withTaskWraithCodexHomeEnv(
    {
      ...collectUserMcpProviderEnv(input.mcp.userMcpServers),
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      ...(input.mcp.enabled
        ? { TASKWRAITH_PARENT_PROVIDER: input.mcp.parentProvider }
        : {}),
      ...(input.runtimeProfile?.id
        ? { TASKWRAITH_RUNTIME_PROFILE_ID: input.runtimeProfile.id }
        : {})
    },
    input.codexHome
  )
  const resolvedEnv = createResolvedProviderEnv(
    launchEnv,
    input.binaryPath,
    input.cliRuntimeDeps,
    input.runtimeProfile
  )
  const withCodeModeHostEnv = input.withCodeModeHostEnv ?? withCodexCodeModeHostEnv
  const env = await withCodeModeHostEnv(resolvedEnv, input.binaryPath)
  const spawnPlan = createCliSpawnPlan(input.binaryPath, args)

  return Object.freeze({
    transport: 'app-server' as const,
    startupCompatibility: input.forceFastServiceTier
      ? ('force-fast-service-tier' as const)
      : ('configured' as const),
    command: spawnPlan.command,
    args: Object.freeze([...spawnPlan.args]),
    shell: spawnPlan.shell,
    env: Object.freeze({ ...env })
  })
}
