import { describe, expect, it } from 'vitest'
import {
  EXTERNAL_PATH_GRANT_DISPATCH_PROVIDERS,
  assignExternalPathGrantOrder,
  canonicalizeExternalPathGrantMetadata,
  coalesceExternalPathGrants,
  collectExternalPathGrantsFromMetadata,
  isExternalPathGrantDispatchProvider,
  reorderExternalPathGrantsByPath
} from './ExternalPathGrants'
import type { ExternalPathGrant, ProviderId } from './types'

function grant(
  provider: ProviderId,
  path: string,
  access: 'read' | 'write' = 'read',
  id = `${provider}-${access}`
): ExternalPathGrant {
  return {
    id,
    provider,
    path,
    kind: 'file',
    access,
    duration: 'thisThread',
    issuedBy: 'main',
    signature: 'signed',
    createdAt: '2026-01-01T00:00:00.000Z'
  }
}

describe('ExternalPathGrants metadata helpers', () => {
  it('dispatches grants only to live providers and keeps unavailable ids historical-only', () => {
    expect([...EXTERNAL_PATH_GRANT_DISPATCH_PROVIDERS]).toEqual([
      'codex',
      'claude',
      'cursor',
      'grok',
      'kimi',
      'ollama'
    ])
    expect(isExternalPathGrantDispatchProvider('gemini')).toBe(false)
    expect(isExternalPathGrantDispatchProvider('cursor')).toBe(true)
  })

  it('reads canonical and legacy grant keys into one coalesced list', () => {
    const metadata = {
      externalPathGrants: [grant('gemini', '/tmp/a.txt')],
      codexExternalPathGrants: [grant('codex', '/tmp/b.txt')],
      claudeExternalPathGrants: [grant('claude', '/tmp/c.txt')],
      kimiExternalPathGrants: [grant('kimi', '/tmp/d.txt')]
    }

    expect(collectExternalPathGrantsFromMetadata(metadata).map((item) => item.provider)).toEqual([
      'gemini',
      'codex',
      'claude',
      'kimi'
    ])
  })

  it('dedupes by provider/path with write access winning over read', () => {
    const metadata = {
      geminiExternalPathGrants: [grant('gemini', '/tmp/a.txt', 'read', 'read-1')],
      kimiExternalPathGrants: [grant('gemini', '/tmp/a.txt', 'write', 'write-1')]
    }

    expect(collectExternalPathGrantsFromMetadata(metadata)).toMatchObject([
      { id: 'write-1', provider: 'gemini', path: '/tmp/a.txt', access: 'write' }
    ])
  })

  it('prefers an executable v2 grant over a same-access legacy duplicate', () => {
    const legacy = grant('codex', '/tmp/a.txt', 'write', 'legacy-write')
    const bound = {
      ...grant('codex', '/tmp/a.txt', 'write', 'bound-write'),
      bindingVersion: 2 as const,
      workspaceId: 'workspace-a',
      chatId: 'chat-a'
    }

    expect(coalesceExternalPathGrants([legacy, bound])).toMatchObject([
      {
        id: 'bound-write',
        bindingVersion: 2,
        workspaceId: 'workspace-a',
        chatId: 'chat-a'
      }
    ])
    expect(coalesceExternalPathGrants([bound, legacy])).toMatchObject([
      { id: 'bound-write', bindingVersion: 2 }
    ])
  })

  it('does not treat a thisRun v2 grant without an exact run id as executable', () => {
    const legacy = grant('codex', '/tmp/a.txt', 'write', 'legacy-write')
    const incomplete = {
      ...grant('codex', '/tmp/a.txt', 'write', 'incomplete-v2'),
      bindingVersion: 2 as const,
      workspaceId: 'workspace-a',
      chatId: 'chat-a',
      duration: 'thisRun' as const
    }

    expect(coalesceExternalPathGrants([legacy, incomplete])).toMatchObject([{ id: 'legacy-write' }])
  })

  it('preserves signed authority fields verbatim while coalescing', () => {
    const source = {
      ...grant('codex', ' /tmp/signed path ', 'write', 'bound-write'),
      bindingVersion: 2 as const,
      workspaceId: ' workspace-a ',
      chatId: ' chat-a ',
      appRunId: ' run-a ',
      duration: 'thisRun' as const,
      signature: 'signed-exactly'
    }

    expect(coalesceExternalPathGrants([source])[0]).toMatchObject(source)
  })

  it('keeps canonical entries ahead of legacy duplicates on re-migration', () => {
    const metadata = {
      externalPathGrants: [grant('gemini', '/tmp/a.txt', 'read', 'canonical-read')],
      geminiExternalPathGrants: [grant('gemini', '/tmp/a.txt', 'write', 'legacy-write')]
    }

    expect(canonicalizeExternalPathGrantMetadata(metadata).externalPathGrants).toMatchObject([
      { id: 'canonical-read', provider: 'gemini', path: '/tmp/a.txt', access: 'read' }
    ])
  })

  it('migrates an executable v2 duplicate out of a legacy metadata key', () => {
    const bound = {
      ...grant('codex', '/tmp/a.txt', 'read', 'bound-read'),
      bindingVersion: 2 as const,
      workspaceId: 'workspace-a',
      chatId: 'chat-a'
    }
    const metadata = {
      externalPathGrants: [grant('codex', '/tmp/a.txt', 'read', 'canonical-legacy')],
      codexExternalPathGrants: [bound]
    }

    expect(collectExternalPathGrantsFromMetadata(metadata)).toMatchObject([
      { id: 'bound-read', bindingVersion: 2, chatId: 'chat-a', workspaceId: 'workspace-a' }
    ])
  })

  it('writes canonical metadata only while preserving unrelated keys', () => {
    const metadata = canonicalizeExternalPathGrantMetadata(
      {
        geminiAuthProfileId: 'profile-1',
        codexExternalPathGrants: [grant('codex', '/tmp/old.txt')]
      },
      [grant('claude', '/tmp/new.txt', 'write')]
    )

    expect(metadata).toEqual({
      geminiAuthProfileId: 'profile-1',
      externalPathGrants: [expect.objectContaining({ provider: 'claude', path: '/tmp/new.txt' })]
    })
    expect(metadata).not.toHaveProperty('codexExternalPathGrants')
    expect(metadata).not.toHaveProperty('claudeExternalPathGrants')
    expect(metadata).not.toHaveProperty('geminiExternalPathGrants')
    expect(metadata).not.toHaveProperty('kimiExternalPathGrants')
  })
})

function g(
  provider: ProviderId,
  path: string,
  overrides: Partial<ExternalPathGrant> = {}
): ExternalPathGrant {
  return {
    id: `${provider}:${path}`,
    provider,
    path,
    kind: 'file',
    access: 'read',
    duration: 'thisThread',
    issuedBy: 'main',
    signature: 'signed',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

const byPathOrder = (grants: ExternalPathGrant[]): Array<[string, number | undefined]> =>
  grants.map((item) => [item.path, item.order])

const orderByKey = (grants: ExternalPathGrant[]): Record<string, number | undefined> =>
  Object.fromEntries(grants.map((item) => [`${item.provider}:${item.path}`, item.order]))

describe('ExternalPathGrants display order (1.0.6-EW66)', () => {
  it('assigns a stable order to grants that lack one, sequenced by createdAt', () => {
    const result = coalesceExternalPathGrants([
      g('gemini', '/tmp/b.txt', { createdAt: '2026-01-02T00:00:00.000Z' }),
      g('gemini', '/tmp/a.txt', { createdAt: '2026-01-01T00:00:00.000Z' })
    ])

    // Earlier createdAt wins slot 0; output is sorted by (order, path, provider).
    expect(byPathOrder(result)).toEqual([
      ['/tmp/a.txt', 0],
      ['/tmp/b.txt', 1]
    ])
  })

  it('writes the same order to every grant sharing a path (one per provider)', () => {
    const result = coalesceExternalPathGrants([
      g('gemini', '/tmp/shared.txt', { createdAt: '2026-01-01T00:00:00.000Z' }),
      g('codex', '/tmp/shared.txt', { createdAt: '2026-01-01T00:00:00.000Z' }),
      g('claude', '/tmp/other.txt', { createdAt: '2026-01-02T00:00:00.000Z' })
    ])

    const orders = orderByKey(result)
    expect(orders['gemini:/tmp/shared.txt']).toBe(0)
    expect(orders['codex:/tmp/shared.txt']).toBe(0)
    expect(orders['claude:/tmp/other.txt']).toBe(1)
  })

  it('preserves an existing explicit order and appends new paths after it', () => {
    const result = coalesceExternalPathGrants([
      g('gemini', '/tmp/a.txt', { order: 5, createdAt: '2026-01-01T00:00:00.000Z' }),
      g('gemini', '/tmp/b.txt', { createdAt: '2026-01-02T00:00:00.000Z' })
    ])

    const orders = orderByKey(result)
    expect(orders['gemini:/tmp/a.txt']).toBe(5)
    // Unordered path appends after the highest explicit order (5 + 1).
    expect(orders['gemini:/tmp/b.txt']).toBe(6)
  })

  it('collapses divergent orders for one path to the minimum seen', () => {
    const result = coalesceExternalPathGrants([
      g('gemini', '/tmp/a.txt', { order: 3, createdAt: '2026-01-01T00:00:00.000Z' }),
      g('codex', '/tmp/a.txt', { order: 1, createdAt: '2026-01-01T00:00:00.000Z' })
    ])

    // Both grants share the path, so the sticky (minimum) order wins for both.
    expect(result.every((item) => item.order === 1)).toBe(true)
  })

  it('is idempotent: re-coalescing an ordered list is a no-op', () => {
    const first = coalesceExternalPathGrants([
      g('gemini', '/tmp/b.txt', { createdAt: '2026-01-02T00:00:00.000Z' }),
      g('codex', '/tmp/a.txt', { createdAt: '2026-01-01T00:00:00.000Z' }),
      g('gemini', '/tmp/a.txt', { createdAt: '2026-01-01T00:00:00.000Z' })
    ])
    const second = coalesceExternalPathGrants(first)

    expect(second).toEqual(first)
  })

  it('assignExternalPathGrantOrder returns the input untouched when empty', () => {
    expect(assignExternalPathGrantOrder([])).toEqual([])
  })
})

describe('reorderExternalPathGrantsByPath (1.0.6-EW66)', () => {
  it('rewrites order to match the renderer-supplied path order', () => {
    const grants = [g('gemini', '/tmp/a.txt'), g('gemini', '/tmp/b.txt'), g('gemini', '/tmp/c.txt')]

    const result = reorderExternalPathGrantsByPath(grants, [
      '/tmp/c.txt',
      '/tmp/a.txt',
      '/tmp/b.txt'
    ])

    expect(byPathOrder(result)).toEqual([
      ['/tmp/c.txt', 0],
      ['/tmp/a.txt', 1],
      ['/tmp/b.txt', 2]
    ])
  })

  it('appends paths absent from the ordered list (stably, by path)', () => {
    const grants = [g('gemini', '/tmp/a.txt'), g('gemini', '/tmp/b.txt'), g('gemini', '/tmp/z.txt')]

    // Only z.txt is positioned; a + b are appended after it, sorted.
    const result = reorderExternalPathGrantsByPath(grants, ['/tmp/z.txt'])

    expect(byPathOrder(result)).toEqual([
      ['/tmp/z.txt', 0],
      ['/tmp/a.txt', 1],
      ['/tmp/b.txt', 2]
    ])
  })

  it('writes the same order to every grant sharing a path', () => {
    const grants = [g('gemini', '/tmp/a.txt'), g('codex', '/tmp/a.txt'), g('gemini', '/tmp/b.txt')]

    const result = reorderExternalPathGrantsByPath(grants, ['/tmp/b.txt', '/tmp/a.txt'])

    const orders = orderByKey(result)
    expect(orders['gemini:/tmp/b.txt']).toBe(0)
    expect(orders['gemini:/tmp/a.txt']).toBe(1)
    expect(orders['codex:/tmp/a.txt']).toBe(1)
  })
})
