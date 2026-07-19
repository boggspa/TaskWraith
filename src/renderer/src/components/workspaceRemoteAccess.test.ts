import { describe, expect, it } from 'vitest'
import type { RemoteWorkspaceEntry } from '../../../shared/remoteWorkspaceDefaults'
import {
  buildAllowlistUpsertForSegment,
  deriveWorkspaceRemoteSegment,
  entryCanPublishExternally,
  entryHasFileCapabilities,
  resolveEntryCapabilities
} from './workspaceRemoteAccess'

function entry(overrides: Partial<RemoteWorkspaceEntry> = {}): RemoteWorkspaceEntry {
  return {
    workspaceId: 'ws-1',
    path: '/repo',
    mode: 'read-only',
    allowedProviders: ['gemini', 'codex', 'claude', 'kimi', 'grok', 'cursor', 'ollama'],
    allowedApprovalModes: ['default', 'plan'],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('deriveWorkspaceRemoteSegment', () => {
  it('maps missing / expired / mode states', () => {
    expect(deriveWorkspaceRemoteSegment(undefined)).toBe('off')
    expect(deriveWorkspaceRemoteSegment(entry({ mode: 'read-only' }))).toBe('read')
    expect(deriveWorkspaceRemoteSegment(entry({ mode: 'read-write' }))).toBe('read-write')
    // Expired entries still appear in list() — must read as off.
    expect(deriveWorkspaceRemoteSegment(entry({ mode: 'read-write', expiresAt: 50 }), 100)).toBe('off')
    expect(deriveWorkspaceRemoteSegment(entry({ mode: 'read-write', expiresAt: 200 }), 100)).toBe(
      'read-write'
    )
  })
})

describe('entryHasFileCapabilities', () => {
  it('is true only with the full file trio resolved', () => {
    expect(
      entryHasFileCapabilities(
        entry({ mode: 'read-write', capabilities: ['monitor', 'fileBrowse', 'fileRead', 'fileWrite'] })
      )
    ).toBe(true)
    // Legacy read-write (no explicit caps) resolves WITHOUT files.
    expect(entryHasFileCapabilities(entry({ mode: 'read-write', capabilities: undefined }))).toBe(false)
    expect(entryHasFileCapabilities(entry({ mode: 'read-only' }))).toBe(false)
    // Partial trio is not enough.
    expect(
      entryHasFileCapabilities(entry({ mode: 'read-write', capabilities: ['fileBrowse', 'fileRead'] }))
    ).toBe(false)
  })

  it('legacy read-write derives segment read-write but files OFF (no silent escalation)', () => {
    const legacy = entry({ mode: 'read-write', capabilities: undefined })
    expect(deriveWorkspaceRemoteSegment(legacy)).toBe('read-write')
    expect(entryHasFileCapabilities(legacy)).toBe(false)
    expect(resolveEntryCapabilities(legacy)).not.toContain('fileWrite')
  })
})

describe('entryCanPublishExternally', () => {
  it('requires the explicit externalPublish admin capability', () => {
    expect(
      entryCanPublishExternally(
        entry({
          mode: 'read-write',
          capabilities: ['monitor', 'fileBrowse', 'fileRead', 'fileWrite']
        })
      )
    ).toBe(false)
    expect(
      entryCanPublishExternally(
        entry({
          mode: 'read-write',
          capabilities: ['monitor', 'fileWrite', 'externalPublish']
        })
      )
    ).toBe(true)
    expect(entryCanPublishExternally(entry({ mode: 'read-write', capabilities: undefined }))).toBe(
      false
    )
  })
})

describe('buildAllowlistUpsertForSegment', () => {
  const ws = { id: 'ws-9', path: '/repo/nine' }

  it('first grant (no existing) uses full defaults', () => {
    const read = buildAllowlistUpsertForSegment(ws, 'read')
    expect(read).toEqual({
      workspaceId: 'ws-9',
      path: '/repo/nine',
      mode: 'read-only',
      capabilities: ['monitor', 'approve'],
      allowedProviders: ['codex', 'claude', 'kimi', 'grok', 'ollama'],
      allowedApprovalModes: ['default', 'plan']
    })
    expect(read.expiresAt).toBeUndefined()

    const rw = buildAllowlistUpsertForSegment(ws, 'read-write')
    expect(rw.mode).toBe('read-write')
    expect(rw.capabilities).toContain('fileWrite')
    expect(rw.capabilities).toContain('fileBrowse')
    expect(rw.capabilities).toContain('fileRead')
  })

  it('read-modify-write PRESERVES a narrowed entry on a mode flip', () => {
    const existing = entry({
      workspaceId: 'ws-9',
      path: '/repo/nine',
      mode: 'read-only',
      allowedProviders: ['claude'],
      allowedApprovalModes: ['plan'],
      expiresAt: 4102444800000,
      capabilities: ['monitor', 'approve']
    })
    const out = buildAllowlistUpsertForSegment(ws, 'read-write', existing)
    expect(out.mode).toBe('read-write')
    // Providers/approval/expiry are NOT widened or erased.
    expect(out.allowedProviders).toEqual(['claude'])
    expect(out.allowedApprovalModes).toEqual(['plan'])
    expect(out.expiresAt).toBe(4102444800000)
    expect(out.workspaceId).toBe('ws-9')
  })

  it('treats an EXPIRED existing entry as a fresh grant (no stale expiresAt, defaults restored)', () => {
    const expired = entry({
      workspaceId: 'ws-9',
      path: '/repo/nine',
      mode: 'read-write',
      allowedProviders: ['claude'],
      allowedApprovalModes: ['plan'],
      expiresAt: 50,
      capabilities: ['monitor', 'approve']
    })
    // now=100 > expiresAt=50 → the UI shows this as Off, so re-granting must NOT
    // copy the dead timestamp forward or keep the narrowed providers.
    const out = buildAllowlistUpsertForSegment({ id: 'ws-9', path: '/repo/nine' }, 'read', expired, 100)
    expect(out.expiresAt).toBeUndefined()
    expect(out.allowedProviders).toEqual(['codex', 'claude', 'kimi', 'grok', 'ollama'])
    expect(out.mode).toBe('read-only')
  })

  it('preserves admin caps (externalPublish/pin/yolo) across a mode flip', () => {
    const existing = entry({
      mode: 'read-write',
      capabilities: ['monitor', 'approve', 'answer', 'steer', 'externalPublish', 'pin', 'yolo']
    })
    const out = buildAllowlistUpsertForSegment(ws, 'read', existing)
    expect(out.mode).toBe('read-only')
    expect(out.capabilities).toContain('externalPublish')
    expect(out.capabilities).toContain('pin')
    expect(out.capabilities).toContain('yolo')
    // Read-only base is still present.
    expect(out.capabilities).toContain('monitor')
    expect(out.capabilities).toContain('approve')
    // But file caps are NOT added for a read target.
    expect(out.capabilities).not.toContain('fileWrite')
  })
})
