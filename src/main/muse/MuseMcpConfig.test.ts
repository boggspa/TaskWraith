import { describe, expect, it } from 'vitest'
import {
  MUSE_TASKWRAITH_MCP_SERVER_NAME,
  buildMuseTaskWraithMcpSettings,
  mergeMuseMcpSettings,
  serializeMuseSettings
} from './MuseMcpConfig'
import { buildMuseSkillPinSettings } from './MuseSkillPin'

describe('Muse TaskWraith MCP settings', () => {
  it('creates one required, route-bound stdio server without widening settings', () => {
    const settings = buildMuseTaskWraithMcpSettings({
      command: '/Applications/TaskWraith.app/Contents/MacOS/TaskWraith',
      args: ['--taskwraith-gemini-mcp-bridge', '--taskwraith-mcp-route-from-env'],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        TASKWRAITH_PARENT_PROVIDER: 'muse',
        TASKWRAITH_RUN_ID: 'run-1'
      }
    })

    expect(settings).toEqual({
      mcp_servers: {
        [MUSE_TASKWRAITH_MCP_SERVER_NAME]: {
          transport: 'stdio',
          command: '/Applications/TaskWraith.app/Contents/MacOS/TaskWraith',
          args: ['--taskwraith-gemini-mcp-bridge', '--taskwraith-mcp-route-from-env'],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            TASKWRAITH_PARENT_PROVIDER: 'muse',
            TASKWRAITH_RUN_ID: 'run-1'
          },
          mode: 'required',
          enabled: true
        }
      }
    })
  })

  it('keeps the bundled-skill pin and serialises a valid isolated settings document', () => {
    const merged = mergeMuseMcpSettings(
      buildMuseSkillPinSettings('off'),
      buildMuseTaskWraithMcpSettings({ command: 'taskwraith', args: ['--bridge'], env: {} })
    )

    const parsed = JSON.parse(serializeMuseSettings(merged)) as Record<string, unknown>
    expect(parsed.schema_version).toBe(1)
    expect(parsed.skills).toBeDefined()
    expect(
      (parsed.mcp_servers as Record<string, unknown>)[MUSE_TASKWRAITH_MCP_SERVER_NAME]
    ).toBeDefined()
  })

  it('rejects malformed command, arguments, and environment data', () => {
    expect(() => buildMuseTaskWraithMcpSettings({ command: '', args: [], env: {} })).toThrow(
      /command/i
    )
    expect(() =>
      buildMuseTaskWraithMcpSettings({ command: 'taskwraith', args: [1] as never, env: {} })
    ).toThrow(/args/i)
    expect(() =>
      buildMuseTaskWraithMcpSettings({
        command: 'taskwraith',
        args: [],
        env: { 'not-valid': '1' }
      })
    ).toThrow(/env/i)
  })
})
