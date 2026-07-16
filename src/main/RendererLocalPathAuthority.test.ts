import { join, resolve } from 'node:path'
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
  // resolve()/join() keep these fixtures lexically canonical on every
  // platform; relative requests are resolved against them by the product.
  const workspacePath = resolve('/workspace')
  const linkOutPath = join(workspacePath, 'link-out')
  const secretRootPath = resolve('/private/secret')
  const attachmentPath = resolve('/private/selected/report.pdf')
  const canonicalizePath = (path: string): string => path.replace(linkOutPath, secretRootPath)

  it('resolves relative secondary paths inside the frozen workspace', () => {
    expect(
      resolveRendererLocalPath({
        requestedPath: 'reports/result.pdf',
        isMainRenderer: false,
        ownerWorkspacePath: workspacePath,
        canonicalizePath
      })
    ).toBe(join(workspacePath, 'reports', 'result.pdf'))
  })

  it('rejects traversal, sibling prefixes, and symlink escapes', () => {
    for (const requestedPath of [
      join('..', 'private', 'secret.txt'),
      resolve('/workspace-other/secret.txt'),
      join(linkOutPath, 'secret.txt')
    ]) {
      expect(() =>
        resolveRendererLocalPath({
          requestedPath,
          isMainRenderer: false,
          ownerWorkspacePath: workspacePath,
          canonicalizePath
        })
      ).toThrow(/outside its owned workspace/i)
    }
  })

  it('allows an exact renderer attachment outside the workspace', () => {
    expect(
      resolveRendererLocalPath({
        requestedPath: attachmentPath,
        isMainRenderer: false,
        authorizedAttachmentPaths: [attachmentPath],
        canonicalizePath
      })
    ).toBe(attachmentPath)
  })

  it('fails closed for a secondary renderer without workspace or attachment authority', () => {
    expect(() =>
      resolveRendererLocalPath({
        requestedPath: resolve('/private/secret.txt'),
        isMainRenderer: false,
        canonicalizePath
      })
    ).toThrow(/outside its owned workspace/i)
  })

  it('preserves main renderer authority while returning a canonical path', () => {
    expect(
      resolveRendererLocalPath({
        requestedPath: join(linkOutPath, 'report.pdf'),
        isMainRenderer: true,
        canonicalizePath
      })
    ).toBe(join(secretRootPath, 'report.pdf'))
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
