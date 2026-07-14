import { describe, expect, it, vi } from 'vitest'
import {
  authorizeAttachmentRecords,
  authorizeThenExpandAttachmentRecords,
  dispatchWithAuthorizedAttachmentPaths,
  resolveAuthorizedRendererAttachmentPaths
} from './RendererAttachmentAuthorization'

describe('RendererAttachmentAuthorization', () => {
  const canonicalize = (path: string) => `/real${path}`

  it('does not let a Test 1 popout resolve a Test 3 attachment receipt', () => {
    expect(() =>
      resolveAuthorizedRendererAttachmentPaths(
        ['/Test 3/secret.png'],
        ['/real/Test 1/allowed.png'],
        canonicalize
      )
    ).toThrow('Renderer is not authorized to use one or more attachments.')
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

  it('rejects an unauthorized PDF before expansion can touch the file', async () => {
    const expand = vi.fn(async () => [])

    await expect(
      authorizeThenExpandAttachmentRecords(
        [{ path: '/Test 3/secret.pdf' }],
        () => {
          throw new Error('not authorized')
        },
        expand
      )
    ).rejects.toThrow('not authorized')
    expect(expand).not.toHaveBeenCalled()
  })

  it('rejects a Test 3 immediate-run path before provider dispatch', async () => {
    const dispatch = vi.fn(async () => 'dispatched')

    await expect(
      dispatchWithAuthorizedAttachmentPaths(
        { imagePaths: ['/Test 3/secret.png'] },
        () => {
          throw new Error('Renderer is not authorized to use one or more attachments.')
        },
        dispatch
      )
    ).rejects.toThrow('Renderer is not authorized to use one or more attachments.')
    expect(dispatch).not.toHaveBeenCalled()
  })
})
