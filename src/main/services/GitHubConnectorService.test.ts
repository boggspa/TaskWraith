import { describe, expect, it, vi } from 'vitest'

import { createGitHubConnectorService } from './GitHubConnectorService'

const COMMITS = JSON.stringify([{ sha: 'abc123def456abc123def456abc123def456abc1' }])

describe('GitHubConnectorService', () => {
  it('resolves availability plus the latest commit sha through gh', async () => {
    const execGhApi = vi.fn(async () => COMMITS)
    const service = createGitHubConnectorService({ execGhApi })
    await expect(
      service.probeReference('github://electron/electron/README.md@main')
    ).resolves.toEqual({
      status: 'ok',
      revision: 'abc123def456abc123def456abc123def456abc1'
    })
    expect(execGhApi).toHaveBeenCalledWith(
      'repos/electron/electron/commits?per_page=1&path=README.md&sha=main'
    )
  })

  it('treats gh 404s and empty commit lists as definitively missing', async () => {
    const notFound = createGitHubConnectorService({
      execGhApi: vi.fn(async () => {
        throw new Error('gh: Not Found (HTTP 404)')
      })
    })
    await expect(notFound.probeReference('github://a/b')).resolves.toEqual({ status: 'missing' })

    const emptyList = createGitHubConnectorService({ execGhApi: vi.fn(async () => '[]') })
    await expect(emptyList.probeReference('github://a/b/ghost.md')).resolves.toEqual({
      status: 'missing'
    })
  })

  it('falls back to the anonymous public API when gh is unavailable', async () => {
    const fetchPublicJson = vi.fn(async () => ({
      body: [{ sha: 'feedbeef' }]
    }))
    const service = createGitHubConnectorService({
      execGhApi: vi.fn(async () => {
        throw new Error('gh: command not found')
      }),
      fetchPublicJson
    })
    await expect(service.probeReference('github://a/b')).resolves.toEqual({
      status: 'ok',
      revision: 'feedbeef'
    })
    expect(fetchPublicJson).toHaveBeenCalledWith(
      'https://api.github.com/repos/a/b/commits?per_page=1'
    )
  })

  it('surfaces credential loss instead of mislabelling private resources as missing', async () => {
    const service = createGitHubConnectorService({
      execGhApi: vi.fn(async () => {
        throw new Error('gh: HTTP 401 Bad credentials')
      }),
      fetchPublicJson: vi.fn(async () => ({ notFound: true as const }))
    })
    await expect(service.probeReference('github://a/b')).rejects.toThrow(
      /Could not verify with GitHub credentials .*not publicly visible/
    )
  })

  it('reports missing when both lanes agree the resource does not exist', async () => {
    const service = createGitHubConnectorService({
      execGhApi: vi.fn(async () => {
        throw new Error('gh: Not Found (HTTP 404)')
      }),
      fetchPublicJson: vi.fn(async () => ({ notFound: true as const }))
    })
    await expect(service.probeReference('github://a/b')).resolves.toEqual({ status: 'missing' })
  })

  it('rejects malformed locators before any request', async () => {
    const execGhApi = vi.fn(async () => COMMITS)
    const service = createGitHubConnectorService({ execGhApi })
    await expect(service.probeReference('https://github.com/a/b')).rejects.toThrow(
      'Connector locator must be github://owner/repo[/path][@ref].'
    )
    expect(execGhApi).not.toHaveBeenCalled()
  })
})
