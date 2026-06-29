import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { AppStore } from './store'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-settings-test-${process.pid}`)

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  }
}))

describe('AppStore settings defaults', () => {
  beforeEach(() => {
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(userDataPath, { recursive: true })
  })

  it('defaults packaged update checks to the stable channel', () => {
    expect(AppStore.getSettings().updateChannel).toBe('stable')
  })

  it('defaults auto-update to enabled but preserves an explicit disable', () => {
    expect(AppStore.getSettings().autoUpdateEnabled).toBe(true)

    AppStore.updateSettings({ autoUpdateEnabled: false })

    expect(AppStore.getSettings().autoUpdateEnabled).toBe(false)
  })

  it('normalizes persisted changelog metadata on load', () => {
    AppStore.updateSettings({
      lastSeenChangelogVersion: ' 1.0.72 ',
      pendingUpdateChangelog: {
        version: ' 1.0.73 ',
        releaseName: ' TaskWraith 1.0.73 ',
        releaseDate: ' 2026-06-04T12:00:00.000Z ',
        releaseNotes: [{ version: ' 1.0.73 ', note: 'Updater UI.' }, { version: '', note: '' }]
      }
    })

    expect(AppStore.getSettings()).toMatchObject({
      lastSeenChangelogVersion: '1.0.72',
      pendingUpdateChangelog: {
        version: '1.0.73',
        releaseName: 'TaskWraith 1.0.73',
        releaseDate: '2026-06-04T12:00:00.000Z',
        releaseNotes: [{ version: '1.0.73', note: 'Updater UI.' }]
      }
    })
  })

  it('normalizes persisted user MCP remote URLs on load', () => {
    AppStore.updateSettings({
      userMcpServers: [
        {
          id: 'docs',
          name: ' docs ',
          enabled: true,
          transport: 'http',
          url: ' https://example.test/mcp ',
          pluginProvenance: {
            pluginId: 'demo-bundle',
            publisher: 'acme',
            version: '1.0.0',
            source: 'builtin',
            namespace: 'plugin.acme.demo-bundle',
            manifestHash: 'abc123',
            kind: 'mcpServer',
            objectId: 'docs',
            materializedAt: '2026-06-29T12:00:00.000Z'
          }
        },
        {
          id: 'bad',
          name: ' bad ',
          enabled: true,
          transport: 'http',
          url: ' ftp://example.test/mcp '
        }
      ]
    })

    expect(AppStore.getSettings().userMcpServers).toEqual([
      {
        id: 'docs',
        name: 'docs',
        enabled: true,
        transport: 'http',
        url: 'https://example.test/mcp',
        pluginProvenance: {
          pluginId: 'demo-bundle',
          publisher: 'acme',
          version: '1.0.0',
          source: 'builtin',
          namespace: 'plugin.acme.demo-bundle',
          manifestHash: 'abc123',
          kind: 'mcpServer',
          objectId: 'docs',
          materializedAt: '2026-06-29T12:00:00.000Z'
        }
      },
      {
        id: 'bad',
        name: 'bad',
        enabled: false,
        transport: 'http'
      }
    ])
  })
})
