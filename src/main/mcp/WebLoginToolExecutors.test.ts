import { describe, expect, it, vi } from 'vitest'

import {
  WEB_LOGIN_MCP_TOOL_NAMES,
  createWebLoginToolExecutors,
  isWebLoginMcpToolName
} from './WebLoginToolExecutors'
import type { WebSiteLogin } from '../../shared/webSiteLogin'

function site(overrides: Partial<WebSiteLogin> = {}): WebSiteLogin {
  return {
    id: 'example-com',
    label: 'Example',
    origin: 'https://example.com',
    extraOrigins: [],
    agentAccess: 'read',
    status: 'signed-in',
    createdAt: '2026-08-29T00:00:00.000Z',
    ...overrides
  }
}

function harness(sites: WebSiteLogin[] = [site()]): {
  execute: ReturnType<typeof createWebLoginToolExecutors>['executeWebLoginTool']
  openBoundCanvas: ReturnType<typeof vi.fn>
} {
  const openBoundCanvas = vi.fn(async () => ({ canvasId: 'canvas-1' }))
  const { executeWebLoginTool } = createWebLoginToolExecutors({
    listSites: () => sites,
    openBoundCanvas
  })
  return { execute: executeWebLoginTool, openBoundCanvas }
}

function payload(result: { structuredContent?: unknown }): Record<string, unknown> {
  return (result.structuredContent ?? {}) as Record<string, unknown>
}

describe('isWebLoginMcpToolName', () => {
  it('recognizes exactly the two verbs', () => {
    expect([...WEB_LOGIN_MCP_TOOL_NAMES]).toEqual(['web_login_list', 'web_login_open'])
    expect(isWebLoginMcpToolName('web_login_list')).toBe(true)
    expect(isWebLoginMcpToolName('canvas_open')).toBe(false)
    expect(isWebLoginMcpToolName(null)).toBe(false)
  })
})

describe('web_login_list', () => {
  it('OMITS sites the user has not opened to agents', async () => {
    // Listing is not acting, but it is reconnaissance: a site kept at no-agent
    // access should not tell a model it exists.
    const h = harness([
      site({ id: 'shown', agentAccess: 'read' }),
      site({ id: 'private-bank', agentAccess: 'off', label: 'Bank' })
    ])
    const result = await h.execute('web_login_list', {}, {}, 'claude')
    const sites = payload(result).sites as Array<{ siteId: string }>
    expect(sites.map((entry) => entry.siteId)).toEqual(['shown'])
    expect(result.text).not.toContain('private-bank')
    expect(result.text).not.toContain('Bank')
  })

  it('never projects a secret, a cookie or a partition name', async () => {
    const h = harness([site({ extraOrigins: ['https://idp.example.net'] })])
    const result = await h.execute('web_login_list', {}, {}, 'claude')
    expect(result.text).not.toMatch(/persist:/)
    expect(result.text).not.toMatch(/cookie/i)
    expect(result.text).not.toMatch(/partition/i)
    expect(result.text).not.toMatch(/createdAt|lastSignedInAt|lastVerifiedAt/)
  })

  it('projects what an agent actually needs to act', async () => {
    const h = harness([site({ extraOrigins: ['https://idp.example.net'] })])
    const sites = payload(await h.execute('web_login_list', {}, {}, 'claude')).sites as Array<
      Record<string, unknown>
    >
    expect(sites[0]).toEqual({
      siteId: 'example-com',
      label: 'Example',
      origin: 'https://example.com',
      extraOrigins: ['https://idp.example.net'],
      agentAccess: 'read',
      status: 'signed-in'
    })
  })

  it('returns an empty list rather than failing when nothing is shared', async () => {
    const h = harness([site({ agentAccess: 'off' })])
    const result = await h.execute('web_login_list', {}, {}, 'claude')
    expect(result.isError).toBeFalsy()
    expect(payload(result).sites).toEqual([])
  })
})

describe('web_login_open', () => {
  it('requires a siteId and points at where to get one', async () => {
    const h = harness()
    const result = await h.execute('web_login_open', {}, {}, 'claude')
    expect(result.isError).toBe(true)
    expect(result.text).toContain('web_login_list')
    expect(h.openBoundCanvas).not.toHaveBeenCalled()
  })

  it('binds the canvas to the named site and carries the run context', async () => {
    const h = harness()
    const result = await h.execute(
      'web_login_open',
      { siteId: 'example-com', url: 'https://example.com/orders' },
      { appChatId: 'chat-1', appRunId: 'run-1', workspacePath: '/w' },
      'claude'
    )
    expect(h.openBoundCanvas).toHaveBeenCalledWith({
      siteId: 'example-com',
      url: 'https://example.com/orders',
      context: { appChatId: 'chat-1', appRunId: 'run-1', workspacePath: '/w' },
      provider: 'claude'
    })
    expect(payload(result)).toMatchObject({ ok: true, canvasId: 'canvas-1', siteId: 'example-com' })
  })

  it('omits the url when none was asked for, so the site lands on its own origin', async () => {
    const h = harness()
    await h.execute('web_login_open', { siteId: 'example-com' }, {}, 'claude')
    expect(h.openBoundCanvas).toHaveBeenCalledWith(
      expect.not.objectContaining({ url: expect.anything() })
    )
  })

  it('surfaces a refused bind as a tool error rather than swallowing it', async () => {
    // The resolver fails closed on an unknown site or one the user has not
    // opened to agents; that refusal has to reach the model intact.
    const { executeWebLoginTool } = createWebLoginToolExecutors({
      listSites: () => [],
      openBoundCanvas: async () => {
        throw new Error('The saved login "gone" is not available to agents.')
      }
    })
    const result = await executeWebLoginTool('web_login_open', { siteId: 'gone' }, {}, 'claude')
    expect(result.isError).toBe(true)
    expect(result.text).toContain('not available to agents')
  })
})

describe('web_login_open re-authentication', () => {
  it('refuses an expired session by name, with no retry and no self-help', async () => {
    const openBoundCanvas = vi.fn(async () => ({ canvasId: 'canvas-1' }))
    const { executeWebLoginTool } = createWebLoginToolExecutors({
      listSites: () => [site()],
      openBoundCanvas,
      probeSite: async () => 'expired'
    })
    const result = await executeWebLoginTool(
      'web_login_open',
      { siteId: 'example-com' },
      {},
      'claude'
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('Do not retry')
    expect(result.text).toContain('Work > Logins')
    // The agent must not be told to sign in itself - it is structurally
    // forbidden from typing the credential.
    expect(result.text).toContain('do not attempt to sign in yourself')
    expect(openBoundCanvas).not.toHaveBeenCalled()
  })

  it('proceeds on a live or unverified session', async () => {
    for (const status of ['signed-in', 'unknown', 'never'] as const) {
      const openBoundCanvas = vi.fn(async () => ({ canvasId: 'canvas-1' }))
      const { executeWebLoginTool } = createWebLoginToolExecutors({
        listSites: () => [site()],
        openBoundCanvas,
        probeSite: async () => status
      })
      const result = await executeWebLoginTool(
        'web_login_open',
        { siteId: 'example-com' },
        {},
        'claude'
      )
      expect(result.isError).toBeFalsy()
      expect(openBoundCanvas).toHaveBeenCalled()
    }
  })

  it('proceeds when no probe is wired rather than blocking', async () => {
    const h = harness()
    const result = await h.execute('web_login_open', { siteId: 'example-com' }, {}, 'claude')
    expect(result.isError).toBeFalsy()
  })
})
