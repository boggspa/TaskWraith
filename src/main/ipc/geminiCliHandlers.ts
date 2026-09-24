/**
 * Gemini CLI IPC — version probe, capability discovery, MCP-bridge install/
 * status/enable, and session listing.
 *
 * Extracted from `src/main/index.ts` as a behavior-preserving move: the same
 * channels, the same main-renderer authority checks, the same refusal and
 * fallback shapes ('unknown' on a failed version probe, a swallowed repair
 * error before capability reads).
 *
 * Collaborators that live in the composition root are injected. Module-level
 * imports the root already owned (`resolveCliProviderBinary`, `createCliEnv`,
 * `GEMINI_CAPABILITY_KINDS`) are imported directly here, matching the
 * established `src/main/ipc/` pattern.
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import {
  GEMINI_CAPABILITY_KINDS,
  type GeminiCapabilitiesState,
  type GeminiCapabilityKind,
  type GeminiCapabilitySection
} from '../geminiCapabilityTypes'
import { createCliEnv, resolveCliProviderBinary } from '../providers/CliProviderRuntime'
import type { GeminiMcpBridgeStatus, GeminiSessionListResult } from '../store/types'

type RendererSenderEvent = Pick<IpcMainInvokeEvent, 'sender'>

export interface GeminiMcpBridgeStatusOptions {
  autoRepairIfEnabled?: boolean
  cwd?: string
  allowSessionTrustBypass?: boolean
}

export interface GeminiCliHandlersDeps {
  assertMainRendererSender: (event: RendererSenderEvent) => void
  resolveCapabilityWorkspace: (workspace?: string) => Promise<string | undefined>
  repairKnownStaleGeminiMcpBridgeConfigs: (cwd?: string) => Promise<void>
  readGeminiCapabilitySection: (
    kind: GeminiCapabilityKind,
    cwd?: string
  ) => Promise<GeminiCapabilitySection>
  getGeminiMcpBridgeStatus: (
    options?: GeminiMcpBridgeStatusOptions
  ) => Promise<GeminiMcpBridgeStatus>
  installGeminiMcpBridge: (cwd?: string) => Promise<GeminiMcpBridgeStatus>
  setGeminiMcpBridgeEnabled: (enabled: boolean) => Promise<GeminiMcpBridgeStatus>
  listGeminiSessions: () => Promise<GeminiSessionListResult>
}

export function registerGeminiCliHandlers(deps: GeminiCliHandlersDeps): void {
  // Gemini Version
  ipcMain.handle('get-gemini-version', async () => {
    const resolved = await resolveCliProviderBinary('gemini')
    if (!resolved.binaryPath) return 'unknown'
    const geminiBinaryPath = resolved.binaryPath

    return new Promise((resolve) => {
      const proc: ChildProcess = spawn(geminiBinaryPath, ['--version'], {
        shell: false,
        env: createCliEnv({ FORCE_COLOR: '0', NO_COLOR: '1' }, geminiBinaryPath)
      })
      let stdout = ''
      proc.stdout?.on('data', (data) => {
        stdout += data.toString()
      })
      proc.on('close', (code) => {
        if (code !== 0 || !stdout.trim()) resolve('unknown')
        else resolve(stdout.trim())
      })
      proc.on('error', () => {
        resolve('unknown')
      })
    })
  })

  ipcMain.handle(
    'get-gemini-capabilities',
    async (event, workspace?: string): Promise<GeminiCapabilitiesState> => {
      deps.assertMainRendererSender(event)
      const capabilityWorkspace = await deps.resolveCapabilityWorkspace(workspace)
      await deps.repairKnownStaleGeminiMcpBridgeConfigs(capabilityWorkspace).catch(() => {})
      const capabilitySections = await Promise.all(
        GEMINI_CAPABILITY_KINDS.map((kind) =>
          deps.readGeminiCapabilitySection(kind, capabilityWorkspace)
        )
      )

      return {
        refreshedAt: new Date().toISOString(),
        workspace: capabilityWorkspace,
        sections: capabilitySections.reduce(
          (acc, section) => {
            acc[section.kind] = section
            return acc
          },
          {} as Record<GeminiCapabilityKind, GeminiCapabilitySection>
        )
      }
    }
  )

  ipcMain.handle('get-gemini-mcp-bridge-status', async () =>
    deps.getGeminiMcpBridgeStatus({ autoRepairIfEnabled: true })
  )
  ipcMain.handle('install-gemini-mcp-bridge', async (event) => {
    deps.assertMainRendererSender(event)
    return deps.installGeminiMcpBridge()
  })
  ipcMain.handle('set-gemini-mcp-bridge-enabled', async (event, enabled: boolean) => {
    deps.assertMainRendererSender(event)
    return deps.setGeminiMcpBridgeEnabled(Boolean(enabled))
  })

  ipcMain.handle('list-gemini-sessions', async (event) => {
    deps.assertMainRendererSender(event)
    return deps.listGeminiSessions()
  })
}
