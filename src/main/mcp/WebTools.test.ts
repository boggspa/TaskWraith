import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertFetchTargetAllowed, executeWebMcpTool, isWebMcpToolName } from './WebTools'

// A resolver that pretends every host is a single public IP, so the existing
// behavior tests never touch real DNS.
const PUBLIC_RESOLVER = async () => ['93.184.216.34']

describe('WebTools', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('recognizes canonical web MCP tool names', () => {
    expect(isWebMcpToolName('web_search')).toBe(true)
    expect(isWebMcpToolName('web_fetch')).toBe(true)
    expect(isWebMcpToolName('workspace_search')).toBe(false)
  })

  it('fetches absolute http(s) URLs as read-only text', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '<html><body>Hello web</body></html>'
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await executeWebMcpTool(
      'web_fetch',
      { url: 'https://example.com' },
      { resolveHost: PUBLIC_RESOLVER }
    )

    expect(result.isError).toBe(false)
    expect(result.text).toContain('HTTP 200 OK for https://example.com')
    expect(result.text).toContain('Hello web')
    // Redirects are now followed MANUALLY so each hop can be SSRF-revalidated.
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({ redirect: 'manual' })
    )
  })

  it('strips HTML markup so web_fetch returns readable prose, not CSS/scripts', async () => {
    const html = [
      '<!doctype html><html><head><title>Cambridge Weather</title>',
      '<style>.x{color:red}</style><script>var a=1;</script></head>',
      '<body><h1>Today</h1><p>Sunny with highs of 21C.</p>',
      '<p>Light breeze in the afternoon.</p></body></html>'
    ].join('')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => 'text/html; charset=utf-8' },
        text: async () => html
      }))
    )

    const result = await executeWebMcpTool(
      'web_fetch',
      { url: 'https://example.com/weather' },
      { resolveHost: PUBLIC_RESOLVER }
    )

    expect(result.isError).toBe(false)
    expect(result.text).toContain('Title: Cambridge Weather')
    expect(result.text).toContain('Sunny with highs of 21C.')
    expect(result.text).toContain('Light breeze in the afternoon.')
    expect(result.text).not.toContain('color:red')
    expect(result.text).not.toContain('var a=1')
    expect(result.text).not.toContain('<p>')
  })

  it('passes non-HTML bodies (JSON) through verbatim for web_fetch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => 'application/json' },
        text: async () => '{"temp":21,"unit":"C"}'
      }))
    )

    const result = await executeWebMcpTool(
      'web_fetch',
      { url: 'https://api.example.com/w.json' },
      { resolveHost: PUBLIC_RESOLVER }
    )

    expect(result.isError).toBe(false)
    expect(result.text).toContain('{"temp":21,"unit":"C"}')
  })

  it('parses DuckDuckGo result links for web_search', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          '<a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com">Example &amp; Result</a>'
      }))
    )

    const result = await executeWebMcpTool(
      'web_search',
      { query: 'example' },
      { resolveHost: PUBLIC_RESOLVER }
    )

    expect(result.isError).toBe(false)
    expect(result.text).toContain('Top web results for "example"')
    expect(result.text).toContain('Example & Result')
    expect(result.text).toContain('https://example.com')
  })

  describe('SSRF guard (assertFetchTargetAllowed)', () => {
    const neverResolve = async () => {
      throw new Error('DNS should not be consulted for string-blocked hosts')
    }

    it('allows a public host that resolves to a public IP', async () => {
      const url = await assertFetchTargetAllowed('https://example.com/x', async () => [
        '93.184.216.34'
      ])
      expect(url.hostname).toBe('example.com')
    })

    it('blocks loopback by hostname string (before DNS)', async () => {
      await expect(assertFetchTargetAllowed('http://127.0.0.1/x', neverResolve)).rejects.toThrow(
        /host_loopback/
      )
      await expect(assertFetchTargetAllowed('http://localhost:3000/x', neverResolve)).rejects.toThrow(
        /host_loopback/
      )
    })

    it('blocks private LAN ranges by string', async () => {
      await expect(assertFetchTargetAllowed('http://10.0.0.5/x', neverResolve)).rejects.toThrow(
        /host_private/
      )
      await expect(assertFetchTargetAllowed('http://192.168.1.9/x', neverResolve)).rejects.toThrow(
        /host_private/
      )
    })

    it('blocks link-local + cloud-metadata (IP and DNS name)', async () => {
      await expect(
        assertFetchTargetAllowed('http://169.254.169.254/latest/meta-data/', neverResolve)
      ).rejects.toThrow(/host_linklocal/)
      await expect(
        assertFetchTargetAllowed('http://metadata.google.internal/x', neverResolve)
      ).rejects.toThrow(/host_linklocal/)
    })

    it('blocks non-http(s) schemes', async () => {
      await expect(assertFetchTargetAllowed('file:///etc/passwd', neverResolve)).rejects.toThrow(
        /non_http_scheme/
      )
    })

    it('blocks DNS-rebinding: a public hostname resolving to an internal IP', async () => {
      await expect(
        assertFetchTargetAllowed('https://totally-legit.example/x', async () => ['10.0.0.5'])
      ).rejects.toThrow(/resolved_private/)
      await expect(
        assertFetchTargetAllowed('https://sneaky.example/x', async () => [
          '93.184.216.34',
          '169.254.169.254'
        ])
      ).rejects.toThrow(/resolved_linklocal/)
    })
  })

  describe('SSRF guard (redirect re-validation)', () => {
    it('blocks a public URL that 302-redirects to a cloud-metadata endpoint', async () => {
      const fetchImpl = vi.fn(async (url: string) => {
        if (url === 'https://example.com/start') {
          return {
            status: 302,
            statusText: 'Found',
            headers: {
              get: (h: string) =>
                h.toLowerCase() === 'location' ? 'http://169.254.169.254/latest/meta-data/' : null
            },
            text: async () => ''
          } as unknown as Response
        }
        throw new Error('redirect target should never be fetched')
      })

      const result = await executeWebMcpTool(
        'web_fetch',
        { url: 'https://example.com/start' },
        { fetchImpl: fetchImpl as unknown as typeof fetch, resolveHost: PUBLIC_RESOLVER }
      )

      expect(result.isError).toBe(true)
      expect(result.text).toMatch(/non-public|host_linklocal/)
    })

    it('follows a redirect to another public host', async () => {
      const fetchImpl = vi.fn(async (url: string) => {
        if (url === 'https://a.example/start') {
          return {
            status: 301,
            statusText: 'Moved',
            headers: {
              get: (h: string) => (h.toLowerCase() === 'location' ? 'https://b.example/dest' : null)
            },
            text: async () => ''
          } as unknown as Response
        }
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: { get: () => 'text/plain' },
          text: async () => 'final body'
        } as unknown as Response
      })

      const result = await executeWebMcpTool(
        'web_fetch',
        { url: 'https://a.example/start' },
        { fetchImpl: fetchImpl as unknown as typeof fetch, resolveHost: PUBLIC_RESOLVER }
      )

      expect(result.isError).toBe(false)
      expect(result.text).toContain('final body')
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    })
  })
})
