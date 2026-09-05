import { describe, expect, it } from 'vitest'
import {
  isValidUserMcpRemoteUrl,
  normalizeKeyCommandBindings,
  normalizePluginResourceProvenance,
  normalizePluginReviewState,
  normalizeRuntimeProfileSecretRefs,
  normalizeUpdateChangelog,
  normalizeUserMcpServers,
  objectOrUndefined
} from './settingsNormalizers'

describe('objectOrUndefined', () => {
  it('keeps plain objects and rejects arrays, null and primitives', () => {
    const plain = { a: 1 }
    expect(objectOrUndefined(plain)).toBe(plain)
    expect(objectOrUndefined([] as unknown as object)).toBeUndefined()
    expect(objectOrUndefined([1, 2] as unknown as object)).toBeUndefined()
    expect(objectOrUndefined(null)).toBeUndefined()
    expect(objectOrUndefined(undefined)).toBeUndefined()
    expect(objectOrUndefined('nope' as unknown as object)).toBeUndefined()
  })
})

describe('normalizeKeyCommandBindings', () => {
  it('returns an empty map for non-record input', () => {
    expect(normalizeKeyCommandBindings(undefined)).toEqual({})
    expect(normalizeKeyCommandBindings(null as never)).toEqual({})
    expect(normalizeKeyCommandBindings([] as never)).toEqual({})
  })

  it('preserves an explicit null binding as a cleared shortcut', () => {
    expect(normalizeKeyCommandBindings({ send: null } as never)).toEqual({ send: null })
  })

  it('keeps only whitelisted modifiers and trims the key', () => {
    const result = normalizeKeyCommandBindings({
      send: { key: '  Enter  ', modifiers: ['primary', 'hyper', 'shift', 'alt', 7] }
    } as never)
    expect(result).toEqual({ send: { key: 'Enter', modifiers: ['primary', 'shift', 'alt'] } })
  })

  it('drops bindings with a blank key and non-object bindings', () => {
    expect(
      normalizeKeyCommandBindings({
        blank: { key: '   ' },
        missing: { modifiers: ['primary'] },
        bogus: 'nope'
      } as never)
    ).toEqual({})
  })

  it('defaults modifiers to an empty array when absent or not an array', () => {
    expect(
      normalizeKeyCommandBindings({ a: { key: 'K' }, b: { key: 'J', modifiers: 'x' } } as never)
    ).toEqual({ a: { key: 'K', modifiers: [] }, b: { key: 'J', modifiers: [] } })
  })
})

describe('isValidUserMcpRemoteUrl', () => {
  it('accepts only http and https', () => {
    expect(isValidUserMcpRemoteUrl('http://localhost:3000')).toBe(true)
    expect(isValidUserMcpRemoteUrl('https://example.com/mcp')).toBe(true)
    expect(isValidUserMcpRemoteUrl('ftp://example.com')).toBe(false)
    expect(isValidUserMcpRemoteUrl('file:///etc/passwd')).toBe(false)
  })

  it('returns false for unparseable input instead of throwing', () => {
    expect(isValidUserMcpRemoteUrl('not a url')).toBe(false)
    expect(isValidUserMcpRemoteUrl('')).toBe(false)
  })
})

describe('normalizeRuntimeProfileSecretRefs', () => {
  it('keeps valid env names, dedupes them, and drops invalid ones', () => {
    expect(
      normalizeRuntimeProfileSecretRefs({
        env: ['API_KEY', 'API_KEY', '_x1', '9BAD', 'has-dash', 42]
      })
    ).toEqual({ env: ['API_KEY', '_x1'] })
  })

  it('returns undefined when nothing valid survives', () => {
    expect(normalizeRuntimeProfileSecretRefs({ env: ['9BAD'] })).toBeUndefined()
    expect(normalizeRuntimeProfileSecretRefs({ env: 'API_KEY' })).toBeUndefined()
    expect(normalizeRuntimeProfileSecretRefs(null)).toBeUndefined()
  })

  it('caps the env list at 64 entries', () => {
    const env = Array.from({ length: 80 }, (_, i) => `VAR_${i}`)
    expect(normalizeRuntimeProfileSecretRefs({ env })?.env).toHaveLength(64)
  })
})

describe('normalizePluginResourceProvenance', () => {
  const complete = {
    pluginId: ' plug ',
    publisher: 'acme',
    version: '1.0.0',
    source: 'marketplace',
    namespace: 'ns',
    manifestHash: 'abc123',
    kind: 'mcpServer',
    objectId: 'obj-1',
    materializedAt: '2026-01-01T00:00:00Z'
  }

  it('trims fields and accepts a fully populated record', () => {
    expect(normalizePluginResourceProvenance(complete)).toEqual({ ...complete, pluginId: 'plug' })
  })

  it('rejects an unknown source or kind', () => {
    expect(normalizePluginResourceProvenance({ ...complete, source: 'sideload' })).toBeUndefined()
    expect(normalizePluginResourceProvenance({ ...complete, kind: 'mystery' })).toBeUndefined()
  })

  it('requires every field — a single blank collapses the record', () => {
    for (const key of Object.keys(complete)) {
      expect(normalizePluginResourceProvenance({ ...complete, [key]: '  ' })).toBeUndefined()
    }
    expect(normalizePluginResourceProvenance(null)).toBeUndefined()
  })
})

describe('normalizePluginReviewState', () => {
  it('accepts a whitelisted status and reason and omits a blank reviewedAt', () => {
    expect(
      normalizePluginReviewState({
        status: 'pending',
        reason: 'new-plugin-resource',
        manifestHash: ' h1 ',
        reviewedAt: '   '
      })
    ).toEqual({ status: 'pending', reason: 'new-plugin-resource', manifestHash: 'h1' })
  })

  it('carries reviewedAt through when present', () => {
    expect(
      normalizePluginReviewState({
        status: 'accepted',
        reason: 'manifest-update',
        manifestHash: 'h2',
        reviewedAt: '2026-02-02'
      })
    ).toEqual({
      status: 'accepted',
      reason: 'manifest-update',
      manifestHash: 'h2',
      reviewedAt: '2026-02-02'
    })
  })

  it('rejects an unknown status, unknown reason, or missing manifest hash', () => {
    const base = { status: 'pending', reason: 'manifest-update', manifestHash: 'h' }
    expect(normalizePluginReviewState({ ...base, status: 'rejected' })).toBeUndefined()
    expect(normalizePluginReviewState({ ...base, reason: 'because' })).toBeUndefined()
    expect(normalizePluginReviewState({ ...base, manifestHash: '' })).toBeUndefined()
  })
})

describe('normalizeUserMcpServers', () => {
  it('returns an empty array for non-array input', () => {
    expect(normalizeUserMcpServers(null)).toEqual([])
    expect(normalizeUserMcpServers({ id: 'a' })).toEqual([])
  })

  it('drops entries without an id or name and dedupes by id', () => {
    const result = normalizeUserMcpServers([
      { id: 'a', name: 'First', command: 'run' },
      { id: 'a', name: 'Duplicate', command: 'run' },
      { id: '', name: 'No id' },
      { id: 'b', name: '   ' }
    ])
    expect(result.map((server) => server.id)).toEqual(['a'])
    expect(result[0].name).toBe('First')
  })

  it('defaults transport to stdio and only enables when the transport can actually run', () => {
    const [stdioNoCommand, stdioWithCommand, httpNoUrl] = normalizeUserMcpServers([
      { id: 'a', name: 'A', enabled: true },
      { id: 'b', name: 'B', enabled: true, command: 'serve' },
      { id: 'c', name: 'C', enabled: true, transport: 'http' }
    ])
    expect(stdioNoCommand.transport).toBe('stdio')
    expect(stdioNoCommand.enabled).toBe(false)
    expect(stdioWithCommand.enabled).toBe(true)
    expect(httpNoUrl.transport).toBe('http')
    expect(httpNoUrl.enabled).toBe(false)
  })

  it('keeps only a valid remote url', () => {
    const [good, bad] = normalizeUserMcpServers([
      { id: 'a', name: 'A', transport: 'http', url: 'https://example.com', enabled: true },
      { id: 'b', name: 'B', transport: 'http', url: 'ftp://example.com', enabled: true }
    ])
    expect(good.url).toBe('https://example.com')
    expect(good.enabled).toBe(true)
    expect(bad.url).toBeUndefined()
    expect(bad.enabled).toBe(false)
  })

  it('filters env and header keys by their distinct character rules', () => {
    const [server] = normalizeUserMcpServers([
      {
        id: 'a',
        name: 'A',
        command: 'serve',
        env: { GOOD_ONE: 'v', 'bad-key': 'v', OK2: 7 },
        headers: { 'X-Trace': 'v', 'bad header': 'v' }
      }
    ])
    expect(server.env).toEqual({ GOOD_ONE: 'v' })
    expect(server.headers).toEqual({ 'X-Trace': 'v' })
  })

  it('splits secret refs into env and header buckets and omits empty ones', () => {
    const [withEnvOnly] = normalizeUserMcpServers([
      {
        id: 'a',
        name: 'A',
        command: 'serve',
        secretRefs: { env: ['TOKEN', 'TOKEN'], headers: ['bad header'] }
      }
    ])
    expect(withEnvOnly.secretRefs).toEqual({ env: ['TOKEN'] })

    const [withNone] = normalizeUserMcpServers([
      { id: 'b', name: 'B', command: 'serve', secretRefs: { env: ['9bad'] } }
    ])
    expect(withNone.secretRefs).toBeUndefined()
  })

  it('accepts a bearer token env var only when it is a valid identifier', () => {
    const [ok, notOk] = normalizeUserMcpServers([
      { id: 'a', name: 'A', command: 'serve', bearerTokenEnvVar: ' TOKEN ' },
      { id: 'b', name: 'B', command: 'serve', bearerTokenEnvVar: 'not-valid' }
    ])
    expect(ok.bearerTokenEnvVar).toBe('TOKEN')
    expect(notOk.bearerTokenEnvVar).toBeUndefined()
  })

  it('caps the server list at 64 entries', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ id: `id-${i}`, name: `N${i}` }))
    expect(normalizeUserMcpServers(many)).toHaveLength(64)
  })
})

describe('normalizeUpdateChangelog', () => {
  it('requires a non-blank version', () => {
    expect(normalizeUpdateChangelog({ version: '   ' })).toBeUndefined()
    expect(normalizeUpdateChangelog({ releaseName: 'x' })).toBeUndefined()
    expect(normalizeUpdateChangelog(null)).toBeUndefined()
  })

  it('trims the version and optional presentation fields', () => {
    expect(
      normalizeUpdateChangelog({
        version: ' 1.2.3 ',
        releaseName: ' Big ',
        releaseDate: ' 2026-01-01 '
      })
    ).toEqual({ version: '1.2.3', releaseName: 'Big', releaseDate: '2026-01-01' })
  })

  it('passes a string releaseNotes through untouched', () => {
    expect(normalizeUpdateChangelog({ version: '1', releaseNotes: '  raw notes  ' })).toEqual({
      version: '1',
      releaseNotes: '  raw notes  '
    })
  })

  it('normalizes an array of notes and drops entries without a version', () => {
    expect(
      normalizeUpdateChangelog({
        version: '1',
        releaseNotes: [
          { version: ' 1.0 ', note: 'first' },
          { version: '', note: 'dropped' },
          { note: 'no version' },
          { version: '0.9' }
        ]
      })
    ).toEqual({
      version: '1',
      releaseNotes: [
        { version: '1.0', note: 'first' },
        { version: '0.9', note: null }
      ]
    })
  })

  it('omits releaseNotes entirely when no array entry survives', () => {
    expect(normalizeUpdateChangelog({ version: '1', releaseNotes: [{ note: 'orphan' }] })).toEqual({
      version: '1'
    })
  })
})
