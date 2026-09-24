import { describe, expect, it, vi } from 'vitest'
import {
  authorizeAttachmentRecords,
  authorizeThenExpandAttachmentRecords,
  dispatchWithAuthorizedAttachmentPaths,
  resolveAuthorizedRendererAttachmentPaths
} from './RendererAttachmentAuthorization'

describe('RendererAttachmentAuthorization', () => {
  const canonicalize = (path: string) => `/real${path}`

  it('drops a Test 3 attachment receipt a Test 1 popout is not authorized for', () => {
    expect(
      resolveAuthorizedRendererAttachmentPaths(
        ['/Test 3/secret.png'],
        ['/real/Test 1/allowed.png'],
        canonicalize
      )
    ).toEqual([])
  })

  it('returns canonical paths so a symlink cannot be retargeted after authorization', () => {
    expect(
      resolveAuthorizedRendererAttachmentPaths(
        ['/Test 1/link.png'],
        ['/real/Test 1/allowed.png'],
        () => '/real/Test 1/allowed.png'
      )
    ).toEqual(['/real/Test 1/allowed.png'])
  })

  it('rewrites attachment records with only caller-authorized canonical paths', () => {
    expect(
      authorizeAttachmentRecords(
        [{ id: 'one', path: '/Test 1/allowed.png' }],
        () => ['/real/Test 1/allowed.png']
      )
    ).toEqual([{ id: 'one', path: '/real/Test 1/allowed.png' }])
  })

  it('drops an unauthorized PDF before expansion can touch the file', async () => {
    const expand = vi.fn(async () => [])

    await expect(
      authorizeThenExpandAttachmentRecords(
        [{ path: '/Test 3/secret.pdf' }],
        () => {
          throw new Error('not authorized')
        },
        expand
      )
    ).resolves.toEqual([])
    expect(expand).toHaveBeenCalledWith([])
  })

  it('drops a Test 3 immediate-run path before provider dispatch', async () => {
    const dispatch = vi.fn(async () => 'dispatched')

    await expect(
      dispatchWithAuthorizedAttachmentPaths(
        { imagePaths: ['/Test 3/secret.png'] },
        () => {
          throw new Error('Renderer is not authorized to use one or more attachments.')
        },
        dispatch
      )
    ).resolves.toBe('dispatched')
    expect(dispatch).toHaveBeenCalledWith({ imagePaths: [] })
  })

  it('keeps authorized paths and drops only the unauthorized ones', async () => {
    const dispatch = vi.fn(async () => 'dispatched')

    await expect(
      dispatchWithAuthorizedAttachmentPaths(
        { imagePaths: ['/Test 1/allowed.png', '/Test 3/secret.png'] },
        (paths) => paths.filter((path) => path.startsWith('/Test 1/')),
        dispatch
      )
    ).resolves.toBe('dispatched')
    expect(dispatch).toHaveBeenCalledWith({ imagePaths: ['/Test 1/allowed.png'] })
  })
})
