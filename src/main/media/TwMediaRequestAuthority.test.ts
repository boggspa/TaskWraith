import { describe, expect, it, vi } from 'vitest'
import {
  createTwMediaRequestGate,
  isTwMediaRequestAuthorized,
  type TwMediaRequestAuthorityDeps,
  type TwMediaRequestDetails
} from './TwMediaRequestAuthority'

const SHA = 'abcdefabcdefabcdefabcdefabcdefabcdefabcdef'
const URL = `twmedia://asset/${SHA}.mp4`

function deps(
  authority: ReturnType<TwMediaRequestAuthorityDeps['resolveWebContentsAuthority']>,
  owns = false
): TwMediaRequestAuthorityDeps {
  return {
    resolveWebContentsAuthority: vi.fn(() => authority),
    owns: vi.fn(() => owns)
  }
}

describe('TwMediaRequestAuthority', () => {
  it('denies missing, unknown, and non-chat secondary webContents authority', () => {
    expect(
      isTwMediaRequestAuthorized({ url: URL, method: 'GET' }, deps({ kind: 'main' }))
    ).toBe(false)
    expect(
      isTwMediaRequestAuthorized(
        { url: URL, method: 'GET', webContentsId: 41 },
        deps(null)
      )
    ).toBe(false)
    expect(
      isTwMediaRequestAuthorized(
        { url: URL, method: 'GET', webContentsId: 41 },
        deps({ kind: 'workspace' } as never)
      )
    ).toBe(false)
  })

  it('allows explicit main authority without treating a renderer-provided chat id as proof', () => {
    const authority = deps({ kind: 'main' })

    expect(
      isTwMediaRequestAuthorized(
        { url: URL, method: 'GET', webContentsId: 1 },
        authority
      )
    ).toBe(true)
    expect(authority.owns).not.toHaveBeenCalled()
  })

  it('allows only the exact owning chat for a secondary renderer', () => {
    const authority = deps({ kind: 'chat', appChatId: 'chat-1' }, true)

    expect(
      isTwMediaRequestAuthorized(
        { url: URL, method: 'GET', webContentsId: 41 },
        authority
      )
    ).toBe(true)
    expect(authority.owns).toHaveBeenCalledWith({
      sha256: SHA,
      mimeType: 'video/mp4',
      appChatId: 'chat-1'
    })

    const denied = deps({ kind: 'chat', appChatId: 'chat-2' }, false)
    expect(
      isTwMediaRequestAuthorized(
        { url: URL, method: 'GET', webContentsId: 42 },
        denied
      )
    ).toBe(false)
  })

  it('keeps HEAD and ranged GET authorization identical after allow', () => {
    const authority = deps({ kind: 'chat', appChatId: 'chat-1' }, true)
    const ranged = {
      url: URL,
      method: 'GET',
      webContentsId: 41,
      requestHeaders: { Range: 'bytes=1024-' }
    }
    const before = structuredClone(ranged)

    expect(isTwMediaRequestAuthorized(ranged, authority)).toBe(true)
    expect(
      isTwMediaRequestAuthorized(
        { url: URL, method: 'HEAD', webContentsId: 41 },
        authority
      )
    ).toBe(true)
    expect(ranged).toEqual(before)
  })

  it('denies invalid assets and unsupported methods before ownership lookup', () => {
    const authority = deps({ kind: 'chat', appChatId: 'chat-1' }, true)

    expect(
      isTwMediaRequestAuthorized(
        { url: 'twmedia://asset/not-valid.mp4', method: 'GET', webContentsId: 41 },
        authority
      )
    ).toBe(false)
    expect(
      isTwMediaRequestAuthorized(
        { url: URL, method: 'POST', webContentsId: 41 },
        authority
      )
    ).toBe(false)
    expect(authority.owns).not.toHaveBeenCalled()
  })

  it('fails closed when trusted authority or ownership lookup throws', () => {
    const resolverFailure = deps(null)
    vi.mocked(resolverFailure.resolveWebContentsAuthority).mockImplementation(() => {
      throw new Error('window disappeared')
    })
    expect(
      isTwMediaRequestAuthorized(
        { url: URL, method: 'GET', webContentsId: 41 },
        resolverFailure
      )
    ).toBe(false)

    const ownershipFailure = deps({ kind: 'chat', appChatId: 'chat-1' })
    vi.mocked(ownershipFailure.owns).mockImplementation(() => {
      throw new Error('ledger unavailable')
    })
    expect(
      isTwMediaRequestAuthorized(
        { url: URL, method: 'GET', webContentsId: 41 },
        ownershipFailure
      )
    ).toBe(false)
  })

  it('produces an onBeforeRequest callback that only cancels denied requests', () => {
    const gate = createTwMediaRequestGate(deps({ kind: 'main' }))
    const callback = vi.fn()
    const details: TwMediaRequestDetails = { url: URL, method: 'HEAD', webContentsId: 1 }

    gate(details, callback)

    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith({ cancel: false })
  })
})
