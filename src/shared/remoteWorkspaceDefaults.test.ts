import { describe, expect, it } from 'vitest'
import {
  ADMIN_REMOTE_WORKSPACE_CAPABILITIES,
  APPROVAL_MODE_OPTIONS,
  FILE_REMOTE_WORKSPACE_CAPABILITIES,
  LEGACY_READ_WRITE_REMOTE_WORKSPACE_CAPABILITIES,
  PROVIDER_OPTIONS,
  READ_ONLY_REMOTE_WORKSPACE_CAPABILITIES,
  READ_WRITE_REMOTE_WORKSPACE_CAPABILITIES,
  capabilitiesForRemoteWorkspaceMode,
  isAdminRemoteWorkspaceCapability
} from './remoteWorkspaceDefaults'

// Drift guard: these MUST stay byte-identical to src/main/RemoteWorkspaceAllowlist.ts.
// If the main module's constants change, this test should fail and force an update.
describe('remoteWorkspaceDefaults', () => {
  it('mirrors the provider + approval-mode option lists', () => {
    expect([...PROVIDER_OPTIONS]).toEqual(['gemini', 'codex', 'claude', 'kimi', 'grok', 'cursor', 'ollama'])
    expect([...APPROVAL_MODE_OPTIONS]).toEqual(['default', 'plan'])
  })

  it('mirrors the capability sets exactly', () => {
    expect([...READ_ONLY_REMOTE_WORKSPACE_CAPABILITIES]).toEqual(['monitor', 'approve'])
    expect([...LEGACY_READ_WRITE_REMOTE_WORKSPACE_CAPABILITIES]).toEqual([
      'monitor',
      'approve',
      'answer',
      'cancel',
      'startTurn',
      'diffReview',
      'steer'
    ])
    expect([...FILE_REMOTE_WORKSPACE_CAPABILITIES]).toEqual(['fileBrowse', 'fileRead', 'fileWrite'])
    expect([...READ_WRITE_REMOTE_WORKSPACE_CAPABILITIES]).toEqual([
      'monitor',
      'approve',
      'answer',
      'cancel',
      'startTurn',
      'diffReview',
      'steer',
      'fileBrowse',
      'fileRead',
      'fileWrite'
    ])
    expect([...ADMIN_REMOTE_WORKSPACE_CAPABILITIES]).toEqual(['pin', 'yolo'])
  })

  it('Read/Write includes the file trio; Read and legacy read-write do NOT', () => {
    for (const cap of FILE_REMOTE_WORKSPACE_CAPABILITIES) {
      expect(READ_WRITE_REMOTE_WORKSPACE_CAPABILITIES).toContain(cap)
      expect(READ_ONLY_REMOTE_WORKSPACE_CAPABILITIES).not.toContain(cap)
      expect(LEGACY_READ_WRITE_REMOTE_WORKSPACE_CAPABILITIES).not.toContain(cap)
    }
  })

  it('materializes mode defaults', () => {
    expect([...capabilitiesForRemoteWorkspaceMode('read-only')]).toEqual([
      ...READ_ONLY_REMOTE_WORKSPACE_CAPABILITIES
    ])
    expect([...capabilitiesForRemoteWorkspaceMode('read-write')]).toEqual([
      ...READ_WRITE_REMOTE_WORKSPACE_CAPABILITIES
    ])
  })

  it('flags admin caps and excludes them from every mode default', () => {
    expect(isAdminRemoteWorkspaceCapability('pin')).toBe(true)
    expect(isAdminRemoteWorkspaceCapability('yolo')).toBe(true)
    expect(isAdminRemoteWorkspaceCapability('fileWrite')).toBe(false)
    expect(capabilitiesForRemoteWorkspaceMode('read-write')).not.toContain('pin')
    expect(capabilitiesForRemoteWorkspaceMode('read-write')).not.toContain('yolo')
  })
})
