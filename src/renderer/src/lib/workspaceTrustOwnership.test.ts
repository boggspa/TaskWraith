import { describe, expect, it } from 'vitest'
import { isCurrentWorkspaceTrustOwner } from './workspaceTrustOwnership'

describe('isCurrentWorkspaceTrustOwner', () => {
  it('accepts only the exact workspace and latest generation', () => {
    const owner = {
      generation: 4,
      workspaceId: 'test-2',
      workspacePath: '/Users/chrisizatt/Documents/Test 2'
    }

    expect(isCurrentWorkspaceTrustOwner(owner, owner)).toBe(true)
    expect(
      isCurrentWorkspaceTrustOwner(owner, {
        ...owner,
        generation: 5
      })
    ).toBe(false)
    expect(
      isCurrentWorkspaceTrustOwner(owner, {
        ...owner,
        workspaceId: 'test-3'
      })
    ).toBe(false)
    expect(
      isCurrentWorkspaceTrustOwner(owner, {
        ...owner,
        workspacePath: '/Users/chrisizatt/Documents/Test 3'
      })
    ).toBe(false)
  })

  it('rejects a late workspace A result after workspace B takes ownership', () => {
    const requestA = {
      generation: 7,
      workspaceId: 'test-2',
      workspacePath: '/Users/chrisizatt/Documents/Test 2'
    }
    const currentB = {
      generation: 8,
      workspaceId: 'test-3',
      workspacePath: '/Users/chrisizatt/Documents/Test 3'
    }

    expect(isCurrentWorkspaceTrustOwner(requestA, currentB)).toBe(false)
  })
})
