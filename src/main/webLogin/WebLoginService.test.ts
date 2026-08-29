import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WebLoginService } from './WebLoginService'
import { WebSiteLoginStore } from './WebSiteLoginStore'
import { WebSiteProfileRegistry } from './WebSiteProfileRegistry'
import type { WebLoginSignInWindowController } from './WebLoginSignInWindow'
import type { WebSiteLogin } from '../../shared/webSiteLogin'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

function harness(
  overrides: {
    clearBrowsingData?: () => Promise<void>
    signIn?: WebLoginSignInWindowController['signIn']
    probe?: (input: {
      url: string
      partition: string
    }) => Promise<{ finalUrl: string; status: number }>
    onStatusChanged?: (site: WebSiteLogin) => void
  } = {}
): {
  service: WebLoginService
  store: WebSiteLoginStore
  order: string[]
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-web-login-svc-'))
  tempDirs.push(dir)
  const order: string[] = []
  const store = new WebSiteLoginStore({ userDataPath: dir })
  const realRemove = store.remove.bind(store)
  store.remove = (id: string): boolean => {
    order.push('remove-row')
    return realRemove(id)
  }
  const profiles = new WebSiteProfileRegistry({
    createProfile: (partition) => ({
      partition,
      activeSurfaceCount: 0,
      register: () => () => {},
      clearBrowsingData:
        overrides.clearBrowsingData ??
        (async () => {
          order.push('clear-partition')
        })
    })
  })
  const signInWindows = {
    signIn:
      overrides.signIn ??
      vi.fn(async (site) => ({ ok: true as const, siteId: site.id, suggestedOrigins: [] })),
    isOpen: () => false,
    closeAll: () => {}
  } as unknown as WebLoginSignInWindowController
  return {
    service: new WebLoginService({
      store,
      profiles,
      signInWindows,
      ...(overrides.probe ? { probe: overrides.probe } : {}),
      ...(overrides.onStatusChanged ? { onStatusChanged: overrides.onStatusChanged } : {})
    }),
    store,
    order
  }
}

describe('WebLoginService forget', () => {
  it('clears the partition BEFORE dropping the row', async () => {
    const h = harness()
    const id = h.service.add({ origin: 'https://example.com' }).site!.id
    expect((await h.service.forget(id)).ok).toBe(true)
    expect(h.order).toEqual(['clear-partition', 'remove-row'])
  })

  it('keeps the row when the clear fails, rather than orphaning a signed-in jar', async () => {
    const h = harness({
      clearBrowsingData: async () => {
        throw new Error('Close all Canvas Browser surfaces before clearing browsing data.')
      }
    })
    const id = h.service.add({ origin: 'https://example.com' }).site!.id
    const result = await h.service.forget(id)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/open browser canvases/i)
    expect(h.store.get(id)).not.toBeNull()
    expect(h.order).not.toContain('remove-row')
  })

  it('refuses an id that is not saved', async () => {
    const h = harness()
    expect((await h.service.forget('never-existed')).ok).toBe(false)
    expect(h.order).toEqual([])
  })
})

describe('WebLoginService signOut', () => {
  it('clears the partition and KEEPS the row', async () => {
    const h = harness()
    const id = h.service.add({ origin: 'https://example.com' }).site!.id
    h.store.setStatus(id, 'signed-in')
    expect((await h.service.signOut(id)).ok).toBe(true)
    expect(h.order).toEqual(['clear-partition'])
    expect(h.store.get(id)?.status).toBe('never')
  })

  it('leaves the status alone when the clear fails', async () => {
    const h = harness({
      clearBrowsingData: async () => {
        throw new Error('Close all Canvas Browser surfaces before clearing browsing data.')
      }
    })
    const id = h.service.add({ origin: 'https://example.com' }).site!.id
    h.store.setStatus(id, 'signed-in')
    expect((await h.service.signOut(id)).ok).toBe(false)
    expect(h.store.get(id)?.status).toBe('signed-in')
  })
})

describe('WebLoginService signIn', () => {
  it('records unknown, not signed-in — closing a window is not proof of a session', async () => {
    const h = harness()
    const id = h.service.add({ origin: 'https://example.com' }).site!.id
    const result = await h.service.signIn(id)
    expect(result.ok).toBe(true)
    expect(h.store.get(id)?.status).toBe('unknown')
  })

  it('passes the SSO suggestions through without applying them', async () => {
    const h = harness({
      signIn: (async (site) => ({
        ok: true as const,
        siteId: site.id,
        suggestedOrigins: ['https://sso.example.net']
      })) as WebLoginSignInWindowController['signIn']
    })
    const id = h.service.add({ origin: 'https://example.com' }).site!.id
    const result = await h.service.signIn(id)
    expect(result.suggestedOrigins).toEqual(['https://sso.example.net'])
    expect(h.store.get(id)?.extraOrigins).toEqual([])
  })

  it('explains an already-open window by name', async () => {
    const h = harness({
      signIn: (async (site) => ({
        ok: false as const,
        siteId: site.id,
        reason: 'alreadyOpen' as const
      })) as WebLoginSignInWindowController['signIn']
    })
    const id = h.service.add({ origin: 'https://example.com', label: 'Example' }).site!.id
    const result = await h.service.signIn(id)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/already open/i)
  })
})

describe('WebLoginService liveness', () => {
  it('records signed-in when the probe settles on the site own origin', async () => {
    const h = harness({
      probe: async () => ({ finalUrl: 'https://example.com/account', status: 200 })
    })
    const id = h.service.add({ origin: 'https://example.com' }).site!.id
    expect(await h.service.probeLiveness(id)).toBe('signed-in')
    expect(h.store.get(id)?.status).toBe('signed-in')
  })

  it('records expired when the probe is bounced to the SSO hop', async () => {
    const h = harness({
      probe: async () => ({ finalUrl: 'https://sso.example-idp.com/authorize', status: 200 })
    })
    const id = h.service.add({ origin: 'https://example.com' }).site!.id
    h.service.update(id, { extraOrigins: ['https://sso.example-idp.com'] })
    expect(await h.service.probeLiveness(id)).toBe('expired')
  })

  it('probes the site OWN partition, not a shared one', async () => {
    const seen: string[] = []
    const h = harness({
      probe: async ({ partition }) => {
        seen.push(partition)
        return { finalUrl: 'https://example.com/', status: 200 }
      }
    })
    const id = h.service.add({ origin: 'https://example.com' }).site!.id
    await h.service.probeLiveness(id)
    expect(seen).toEqual(['persist:taskwraith-site-example-com'])
  })

  it('a thrown probe is UNKNOWN, never expired', async () => {
    // An offline laptop is not an expired session; a prompt that cries wolf is
    // one the user learns to dismiss.
    const h = harness({
      probe: async () => {
        throw new Error('ERR_INTERNET_DISCONNECTED')
      }
    })
    const id = h.service.add({ origin: 'https://example.com' }).site!.id
    expect(await h.service.probeLiveness(id)).toBe('unknown')
  })

  it('answers unknown with no probe configured, rather than guessing', async () => {
    const h = harness()
    const id = h.service.add({ origin: 'https://example.com' }).site!.id
    expect(await h.service.probeLiveness(id)).toBe('unknown')
  })

  it('sign-in takes its status from a real request, not from the window closing', async () => {
    const h = harness({
      probe: async () => ({ finalUrl: 'https://example.com/', status: 200 })
    })
    const id = h.service.add({ origin: 'https://example.com' }).site!.id
    const result = await h.service.signIn(id)
    expect(result.site?.status).toBe('signed-in')
  })

  it('sign-in that did not actually authenticate stays expired', async () => {
    const h = harness({ probe: async () => ({ finalUrl: 'https://example.com/', status: 401 }) })
    const id = h.service.add({ origin: 'https://example.com' }).site!.id
    expect((await h.service.signIn(id)).site?.status).toBe('expired')
  })

  it('probing a site that is gone is unknown, not a throw', async () => {
    const h = harness()
    expect(await h.service.probeLiveness('never-existed')).toBe('unknown')
  })
})

describe('WebLoginService status change events', () => {
  it('announces a site that has GONE expired', async () => {
    const seen: string[] = []
    const h = harness({
      probe: async () => ({ finalUrl: 'https://example.com/', status: 401 }),
      onStatusChanged: (site) => seen.push(`${site.id}:${site.status}`)
    })
    const id = h.service.add({ origin: 'https://example.com' }).site!.id
    h.store.setStatus(id, 'signed-in')
    await h.service.probeLiveness(id)
    expect(seen).toEqual(['example-com:expired'])
  })

  it('stays SILENT when nothing changed', async () => {
    // A surface that re-announces "still fine" is one the user stops reading,
    // which is the same failure as crying wolf.
    const seen: string[] = []
    const h = harness({
      probe: async () => ({ finalUrl: 'https://example.com/', status: 200 }),
      onStatusChanged: (site) => seen.push(site.id)
    })
    const id = h.service.add({ origin: 'https://example.com' }).site!.id
    await h.service.probeLiveness(id)
    seen.length = 0
    await h.service.probeLiveness(id)
    await h.service.probeLiveness(id)
    expect(seen).toEqual([])
  })

  it('announces recovery too, so a stale warning clears itself', async () => {
    const seen: string[] = []
    let status = 401
    const h = harness({
      probe: async () => ({ finalUrl: 'https://example.com/', status }),
      onStatusChanged: (site) => seen.push(`${site.id}:${site.status}`)
    })
    const id = h.service.add({ origin: 'https://example.com' }).site!.id
    h.store.setStatus(id, 'signed-in')
    await h.service.probeLiveness(id)
    status = 200
    await h.service.probeLiveness(id)
    expect(seen).toEqual(['example-com:expired', 'example-com:signed-in'])
  })
})
