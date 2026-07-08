import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { LocalServerEntry } from '../../../main/localServers/types'
import { useLocalServers } from '../hooks/useLocalServers'
import { LocalServersSection } from './LocalServersSection'

vi.mock('../hooks/useLocalServers', () => ({
  useLocalServers: vi.fn()
}))

const mockUseLocalServers = vi.mocked(useLocalServers)

function server(overrides: Partial<LocalServerEntry> = {}): LocalServerEntry {
  return {
    id: '5173',
    pid: 5173,
    name: 'vite',
    command: 'npm run dev',
    ports: [5173],
    primaryPort: 5173,
    workspaceName: 'TaskWraith',
    origin: 'detected',
    ...overrides
  }
}

describe('LocalServersSection', () => {
  it('starts collapsed when local servers are present', () => {
    mockUseLocalServers.mockReturnValue({
      snapshot: null,
      servers: [server()],
      busy: false,
      refresh: vi.fn(),
      stop: vi.fn(),
      stopAll: vi.fn()
    })

    const html = renderToStaticMarkup(<LocalServersSection />)

    expect(html).toContain('Local Servers')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('title="Expand Local Servers"')
    expect(html).toContain('sidebar-local-servers-count')
    expect(html).not.toContain('sidebar-local-servers-list')
  })
})
