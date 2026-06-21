import { describe, expect, it } from 'vitest'
import type { LocalServerEntry } from '../../../main/localServers/types'
import { buildPreviewServerTargets } from './previewServerTargets'

function server(
  overrides: Partial<LocalServerEntry> & { omitPrimaryPort?: boolean }
): LocalServerEntry {
  const { omitPrimaryPort, ...entryOverrides } = overrides
  const entry: LocalServerEntry = {
    id: String(entryOverrides.pid ?? 1),
    pid: entryOverrides.pid ?? 1,
    name: entryOverrides.name ?? 'vite',
    command: entryOverrides.command ?? 'npm run dev',
    ports: entryOverrides.ports ?? [5173],
    origin: entryOverrides.origin ?? 'detected',
    ...entryOverrides
  }
  if (!omitPrimaryPort) {
    entry.primaryPort = entryOverrides.primaryPort ?? 5173
  }
  return entry
}

describe('buildPreviewServerTargets', () => {
  it('returns previewable servers for the current workspace', () => {
    const targets = buildPreviewServerTargets(
      [
        server({ id: 'a', pid: 10, workspacePath: '/repo/app', workspaceName: 'App' }),
        server({ id: 'b', pid: 11, workspacePath: '/repo/other', workspaceName: 'Other' })
      ],
      '/repo/app'
    )

    expect(targets).toHaveLength(1)
    expect(targets[0]).toMatchObject({
      id: 'a',
      label: 'vite :5173',
      subtitle: 'App · detected · pid 10',
      url: 'http://localhost:5173',
      port: 5173
    })
  })

  it('falls back to cwd when the detector did not stamp workspacePath', () => {
    const targets = buildPreviewServerTargets(
      [
        server({ id: 'inside', pid: 20, cwd: '/repo/app/packages/web' }),
        server({ id: 'outside', pid: 21, cwd: '/repo/application' })
      ],
      '/repo/app'
    )

    expect(targets.map((target) => target.id)).toEqual(['inside'])
  })

  it('filters servers without a primary port', () => {
    const targets = buildPreviewServerTargets(
      [
        server({
          id: 'no-port',
          pid: 30,
          workspacePath: '/repo/app',
          ports: [],
          omitPrimaryPort: true
        })
      ],
      '/repo/app'
    )

    expect(targets).toEqual([])
  })

  it('prefers exact workspace matches, agent-spawned servers, then lower ports', () => {
    const targets = buildPreviewServerTargets(
      [
        server({ id: 'cwd', pid: 40, cwd: '/repo/app', primaryPort: 3000, origin: 'agent-spawned' }),
        server({ id: 'detected', pid: 41, workspacePath: '/repo/app', primaryPort: 5173 }),
        server({
          id: 'agent',
          pid: 42,
          workspacePath: '/repo/app',
          primaryPort: 4000,
          origin: 'agent-spawned'
        })
      ],
      '/repo/app/'
    )

    expect(targets.map((target) => target.id)).toEqual(['agent', 'detected', 'cwd'])
  })
})
