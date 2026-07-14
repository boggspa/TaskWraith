import { describe, expect, it } from 'vitest'
import { AttachmentCapabilityRegistry } from './AttachmentCapabilityRegistry'

describe('AttachmentCapabilityRegistry', () => {
  it('does not let one secondary renderer inherit another renderer attachment', () => {
    const registry = new AttachmentCapabilityRegistry()
    registry.authorizeRendererPath(101, '/tmp/Test 1/one.png')

    expect(registry.isAuthorizedForRenderer(101, '/tmp/Test 1/one.png')).toBe(true)
    expect(registry.isAuthorizedForRenderer(303, '/tmp/Test 1/one.png')).toBe(false)
    expect(registry.getAuthorizedPathsForRenderer(303)).toEqual([])
  })

  it('keeps main-process attachment authority out of secondary renderers', () => {
    const registry = new AttachmentCapabilityRegistry()
    registry.authorizeMainPath('/tmp/taskwraith-remote-attachments/remote.png')

    expect(
      registry.isAuthorizedForRenderer(101, '/tmp/taskwraith-remote-attachments/remote.png')
    ).toBe(false)
    expect(
      registry.isAuthorizedForRenderer(101, '/tmp/taskwraith-remote-attachments/remote.png', {
        includeMainAuthority: true
      })
    ).toBe(true)
  })

  it('revokes receipts when a renderer is destroyed and bounds each principal independently', () => {
    const registry = new AttachmentCapabilityRegistry(2)
    registry.authorizeRendererPath(101, '/tmp/one.png')
    registry.authorizeRendererPath(101, '/tmp/two.png')
    registry.authorizeRendererPath(303, '/tmp/other.png')
    registry.authorizeRendererPath(101, '/tmp/three.png')

    expect(registry.getAuthorizedPathsForRenderer(101)).toEqual(['/tmp/two.png', '/tmp/three.png'])
    expect(registry.getAuthorizedPathsForRenderer(303)).toEqual(['/tmp/other.png'])

    registry.revokeRenderer(101)
    expect(registry.getAuthorizedPathsForRenderer(101)).toEqual([])
    expect(registry.getAuthorizedPathsForRenderer(303)).toEqual(['/tmp/other.png'])
  })
})
