import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThreadIntrospectionSettingsPanel } from './ThreadIntrospectionSettingsPanel'

describe('ThreadIntrospectionSettingsPanel', () => {
  it('renders run toolbar, schedule section, and review panel shell', () => {
    const html = renderToStaticMarkup(<ThreadIntrospectionSettingsPanel />)
    expect(html).toContain('Daily retrospective')
    expect(html).toContain('Run introspection (24h)')
    expect(html).toContain('Automatic daily harvest')
    expect(html).toContain('Enable daily run')
    expect(html).toContain('Thread introspection')
    expect(html).toContain('IPC is not wired yet')
    expect(html).toContain('Daily scheduling is not available in this build yet')
    expect(html).toContain('Once per calendar day')
  })

  it('disables manual run and schedule toggle when APIs are unavailable', () => {
    const html = renderToStaticMarkup(<ThreadIntrospectionSettingsPanel workspaceId="ws-1" />)
    expect(html).toContain('disabled')
    expect(html).toContain('Waiting for Main IPC wiring')
    expect(html).toContain('read-only')
    expect(html).toContain('no skills or durable memory change until you approve them')
  })

  it('shows schedule IPC when preload exposes schedule handlers', () => {
    const previousApi = globalThis.window?.api
    globalThis.window = {
      ...(globalThis.window ?? {}),
      api: {
        getMemoryProposalPacks: async () => [],
        updateMemoryProposal: async () => null,
        runManualIntrospection: async () => ({
          pack: {
            schemaVersion: 1,
            id: 'pack-1',
            introspectionRunId: 'run-1',
            windowStart: '2026-07-04T20:00:00.000Z',
            windowEnd: '2026-07-05T20:00:00.000Z',
            evidenceItemCount: 0,
            createdAt: '2026-07-05T20:00:00.000Z',
            updatedAt: '2026-07-05T20:00:00.000Z',
            proposals: []
          },
          evidenceCount: 0,
          proposalCount: 0
        }),
        getIntrospectionSchedule: async () => ({
          enabled: true,
          workspaceId: 'ws-1',
          nextRunAt: '2026-07-06T08:00:00.000Z',
          lastRunAt: '2026-07-05T08:00:00.000Z'
        }),
        updateIntrospectionSchedule: async (partial) => ({
          enabled: partial.enabled ?? false,
          workspaceId: partial.workspaceId ?? null,
          nextRunAt: '2026-07-06T08:00:00.000Z',
          lastRunAt: '2026-07-05T08:00:00.000Z'
        })
      }
    } as unknown as Window & typeof globalThis

    try {
      const html = renderToStaticMarkup(
        <ThreadIntrospectionSettingsPanel workspaceId="ws-1" />
      )
      expect(html).not.toContain('Daily scheduling is not available in this build yet')
      expect(html).not.toContain('IPC is not wired yet')
    } finally {
      if (previousApi === undefined) {
        delete (globalThis.window as { api?: unknown }).api
      } else {
        globalThis.window.api = previousApi
      }
    }
  })
})