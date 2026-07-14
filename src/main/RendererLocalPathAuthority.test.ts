import { describe, expect, it, vi } from 'vitest'
import {
  assertSecondaryRendererLocalOpenIsPassive,
  resolveAuthorizedRendererLocalPath,
  resolveRendererLocalPath,
  type LocalOpenTargetInspection
} from './RendererLocalPathAuthority'

const passiveFile: LocalOpenTargetInspection = {
  kind: 'file',
  mode: 0o644,
  prefix: new Uint8Array([0x50, 0x4e, 0x47])
}

describe('resolveAuthorizedRendererLocalPath', () => {
  it('returns the canonical path supplied by the caller authorizer', async () => {
    const event = { sender: { id: 41 } } as never
    const authorize = vi.fn(() => '/canonical/workspace/report.pdf')

    await expect(
      resolveAuthorizedRendererLocalPath(authorize, event, {
        operation: 'open',
        requestedPath: '../report.pdf'
      })
    ).resolves.toBe('/canonical/workspace/report.pdf')
    expect(authorize).toHaveBeenCalledWith(event, {
      operation: 'open',
      requestedPath: '../report.pdf'
    })
  })

  it('fails closed when no authorizer is wired or it returns an empty path', async () => {
    await expect(
      resolveAuthorizedRendererLocalPath(undefined, {} as never, {
        operation: 'reveal',
        requestedPath: '/tmp/report.pdf'
      })
    ).rejects.toThrow(/not configured/i)
    await expect(
      resolveAuthorizedRendererLocalPath(async () => '   ', {} as never, {
        operation: 'file-icon',
        requestedPath: '/tmp/report.pdf'
      })
    ).rejects.toThrow(/empty path/i)
  })
})

describe('resolveRendererLocalPath', () => {
  const canonicalizePath = (path: string): string => {
    const resolved = path.replace('/workspace/link-out', '/private/secret')
    return resolved.replace(/\/+/g, '/')
  }

  it('resolves relative secondary paths inside the frozen workspace', () => {
    expect(
      resolveRendererLocalPath({
        requestedPath: 'reports/result.pdf',
        isMainRenderer: false,
        ownerWorkspacePath: '/workspace',
        canonicalizePath
      })
    ).toBe('/workspace/reports/result.pdf')
  })

  it('rejects traversal, sibling prefixes, and symlink escapes', () => {
    for (const requestedPath of [
      '../private/secret.txt',
      '/workspace-other/secret.txt',
      '/workspace/link-out/secret.txt'
    ]) {
      expect(() =>
        resolveRendererLocalPath({
          requestedPath,
          isMainRenderer: false,
          ownerWorkspacePath: '/workspace',
          canonicalizePath
        })
      ).toThrow(/outside its owned workspace/i)
    }
  })

  it('allows an exact renderer attachment outside the workspace', () => {
    expect(
      resolveRendererLocalPath({
        requestedPath: '/private/selected/report.pdf',
        isMainRenderer: false,
        authorizedAttachmentPaths: ['/private/selected/report.pdf'],
        canonicalizePath
      })
    ).toBe('/private/selected/report.pdf')
  })

  it('fails closed for a secondary renderer without workspace or attachment authority', () => {
    expect(() =>
      resolveRendererLocalPath({
        requestedPath: '/private/secret.txt',
        isMainRenderer: false,
        canonicalizePath
      })
    ).toThrow(/outside its owned workspace/i)
  })

  it('preserves main renderer authority while returning a canonical path', () => {
    expect(
      resolveRendererLocalPath({
        requestedPath: '/workspace/link-out/report.pdf',
        isMainRenderer: true,
        canonicalizePath
      })
    ).toBe('/private/secret/report.pdf')
  })
})

describe('assertSecondaryRendererLocalOpenIsPassive', () => {
  it('allows ordinary secondary-renderer documents and images', async () => {
    const inspect = vi.fn(async () => passiveFile)

    await expect(
      assertSecondaryRendererLocalOpenIsPassive('/workspace/report.pdf', {
        isMainRenderer: false,
        inspect
      })
    ).resolves.toBeUndefined()
    await expect(
      assertSecondaryRendererLocalOpenIsPassive('/workspace/screenshot.png', {
        isMainRenderer: false,
        inspect
      })
    ).resolves.toBeUndefined()
  })

  it('rejects app bundles and command/script targets before inspection', async () => {
    const inspect = vi.fn(async () => passiveFile)

    await expect(
      assertSecondaryRendererLocalOpenIsPassive('/workspace/Tool.app', {
        isMainRenderer: false,
        inspect
      })
    ).rejects.toThrow(/executable or active/i)
    await expect(
      assertSecondaryRendererLocalOpenIsPassive('/workspace/run.command', {
        isMainRenderer: false,
        inspect
      })
    ).rejects.toThrow(/executable or active/i)
    expect(inspect).not.toHaveBeenCalled()
  })

  it('rejects symlinks, executable mode bits, shebangs, and native binaries', async () => {
    const assertRejected = async (inspection: LocalOpenTargetInspection): Promise<void> => {
      await expect(
        assertSecondaryRendererLocalOpenIsPassive('/workspace/target', {
          isMainRenderer: false,
          inspect: async () => inspection
        })
      ).rejects.toThrow(/symbolic-link|executable or active/i)
    }

    await assertRejected({ kind: 'symlink', mode: 0o777, prefix: new Uint8Array() })
    await assertRejected({ kind: 'file', mode: 0o755, prefix: new Uint8Array() })
    await assertRejected({ kind: 'file', mode: 0o644, prefix: new Uint8Array([0x23, 0x21]) })
    await assertRejected({
      kind: 'file',
      mode: 0o644,
      prefix: new Uint8Array([0x7f, 0x45, 0x4c, 0x46])
    })
  })

  it('preserves main-renderer open behavior without filesystem inspection', async () => {
    const inspect = vi.fn(async () => {
      throw new Error('must not inspect')
    })

    await expect(
      assertSecondaryRendererLocalOpenIsPassive('/Applications/Tool.app', {
        isMainRenderer: true,
        inspect
      })
    ).resolves.toBeUndefined()
    expect(inspect).not.toHaveBeenCalled()
  })
})
