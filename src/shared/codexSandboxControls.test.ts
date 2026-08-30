import { describe, expect, it } from 'vitest'

import { resolveCodexSandboxControls } from './codexSandboxControls'

const roots = {
  readableRoots: ['/workspace', '/git-metadata'],
  writableRoots: ['/workspace', '/git-metadata']
} as const

describe('resolveCodexSandboxControls', () => {
  it('keeps Plan as the absolute read-only floor', () => {
    expect(
      resolveCodexSandboxControls({
        ...roots,
        planMode: true,
        fullAccessGranted: true,
        allowNativeWorkspaceWrite: true,
        networkAccess: true
      })
    ).toEqual({
      sandbox: 'read-only',
      sandboxPolicy: {
        type: 'readOnly',
        readableRoots: roots.readableRoots,
        networkAccess: false
      }
    })
  })

  it('returns the exact paired Full Access controls after verified consent', () => {
    expect(
      resolveCodexSandboxControls({
        ...roots,
        planMode: false,
        fullAccessGranted: true,
        allowNativeWorkspaceWrite: false,
        networkAccess: false
      })
    ).toEqual({
      sandbox: 'danger-full-access',
      sandboxPolicy: { type: 'dangerFullAccess' }
    })
  })

  it('preserves a broker-only read boundary below Full Access', () => {
    expect(
      resolveCodexSandboxControls({
        ...roots,
        planMode: false,
        fullAccessGranted: false,
        allowNativeWorkspaceWrite: false,
        networkAccess: true
      })
    ).toEqual({
      sandbox: 'read-only',
      sandboxPolicy: {
        type: 'readOnly',
        readableRoots: roots.readableRoots,
        networkAccess: false
      }
    })
  })

  it('projects adapter-owned roots and network policy for workspace writes', () => {
    expect(
      resolveCodexSandboxControls({
        ...roots,
        planMode: false,
        fullAccessGranted: false,
        allowNativeWorkspaceWrite: true,
        networkAccess: true
      })
    ).toEqual({
      sandbox: 'workspace-write',
      sandboxPolicy: {
        type: 'workspaceWrite',
        readableRoots: roots.readableRoots,
        writableRoots: roots.writableRoots,
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false
      }
    })
  })
})
