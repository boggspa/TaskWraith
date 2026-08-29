import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import { WebSiteLoginStore } from './WebSiteLoginStore'

/**
 * The store holds no secret, so the interesting assertions are the ones that
 * keep the catalogue honest: a new site grants nothing until the user says so,
 * one hand-edited row cannot brick the file, and two rows can never collapse
 * onto one cookie jar.
 */

const tempDirs: string[] = []

function store(now = () => new Date('2026-08-29T00:00:00.000Z')): WebSiteLoginStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-web-login-'))
  tempDirs.push(dir)
  return new WebSiteLoginStore({ userDataPath: dir, now })
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('WebSiteLoginStore', () => {
  it('starts empty and survives a missing file', () => {
    expect(store().list()).toEqual([])
  })

  it('adds a site with NO agent access, whatever the caller wants', () => {
    const subject = store()
    const result = subject.add({ origin: 'example.com' })
    expect(result.ok).toBe(true)
    expect(result.site?.agentAccess).toBe('off')
    expect(result.site?.status).toBe('never')
    expect(result.site?.origin).toBe('https://example.com')
    expect(result.site?.id).toBe('example-com')
  })

  it('defaults the label to the host and keeps a supplied one', () => {
    const subject = store()
    expect(subject.add({ origin: 'https://mail.example.com' }).site?.label).toBe('mail.example.com')
    expect(subject.add({ origin: 'https://shop.example.com', label: '  Shop  ' }).site?.label).toBe(
      'Shop'
    )
  })

  it('refuses a second row on the same origin, so two rows never share a jar', () => {
    const subject = store()
    expect(subject.add({ origin: 'https://example.com' }).ok).toBe(true)
    const second = subject.add({ origin: 'example.com/some/path' })
    expect(second.ok).toBe(false)
    expect(second.error).toMatch(/already saved/i)
    expect(subject.list()).toHaveLength(1)
  })

  it('treats a different port as a different site', () => {
    const subject = store()
    expect(subject.add({ origin: 'https://example.com' }).ok).toBe(true)
    const other = subject.add({ origin: 'https://example.com:8443' })
    expect(other.ok).toBe(true)
    expect(other.site?.id).not.toBe('example-com')
  })

  it('refuses a non-http(s) origin', () => {
    const result = store().add({ origin: 'file:///etc/passwd' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/site address/i)
  })

  it('promotes agent access only when asked, and rejects an unknown level', () => {
    const subject = store()
    const id = subject.add({ origin: 'https://example.com' }).site!.id
    expect(subject.update(id, { agentAccess: 'act' }).site?.agentAccess).toBe('act')
    const bad = subject.update(id, { agentAccess: 'root' as never })
    expect(bad.ok).toBe(false)
    expect(subject.get(id)?.agentAccess).toBe('act')
  })

  it('drops an extra origin that duplicates the site origin and caps the rest', () => {
    const subject = store()
    const id = subject.add({ origin: 'https://example.com' }).site!.id
    const updated = subject.update(id, {
      extraOrigins: ['https://example.com', 'https://idp.example.net', 'not a url']
    })
    expect(updated.site?.extraOrigins).toEqual(['https://idp.example.net'])
  })

  it('persists across instances', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-web-login-'))
    tempDirs.push(dir)
    new WebSiteLoginStore({ userDataPath: dir }).add({ origin: 'https://example.com' })
    expect(new WebSiteLoginStore({ userDataPath: dir }).list().map((s) => s.origin)).toEqual([
      'https://example.com'
    ])
  })

  it('drops one corrupt row instead of losing the whole catalogue', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-web-login-'))
    tempDirs.push(dir)
    const file = path.join(dir, 'web-site-logins.json')
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        sites: [
          {
            id: 'good',
            label: 'Good',
            origin: 'https://good.example',
            extraOrigins: [],
            agentAccess: 'read',
            status: 'signed-in',
            createdAt: '2026-08-29T00:00:00.000Z'
          },
          {
            id: 'BAD ID',
            label: 'Bad',
            origin: 'https://bad.example',
            extraOrigins: [],
            agentAccess: 'read',
            status: 'signed-in',
            createdAt: '2026-08-29T00:00:00.000Z'
          },
          {
            id: 'scheme',
            label: 'Scheme',
            origin: 'file:///x',
            extraOrigins: [],
            agentAccess: 'read',
            status: 'signed-in',
            createdAt: '2026-08-29T00:00:00.000Z'
          }
        ]
      })
    )
    expect(new WebSiteLoginStore({ userDataPath: dir }).list().map((s) => s.id)).toEqual(['good'])
  })

  it('falls back to an empty catalogue on unparseable JSON rather than throwing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-web-login-'))
    tempDirs.push(dir)
    fs.writeFileSync(path.join(dir, 'web-site-logins.json'), '{ not json')
    expect(new WebSiteLoginStore({ userDataPath: dir }).list()).toEqual([])
  })

  it('removes a site and reports whether it existed', () => {
    const subject = store()
    const id = subject.add({ origin: 'https://example.com' }).site!.id
    expect(subject.remove(id)).toBe(true)
    expect(subject.remove(id)).toBe(false)
    expect(subject.list()).toEqual([])
  })

  it('never re-issues a removed id, so a re-add cannot inherit the old cookie jar', () => {
    // The partition is derived from the id and the id from the host, so without
    // retirement, remove + re-add lands on the SAME persist: directory and the
    // "never signed in" row is still logged in.
    const subject = store()
    const first = subject.add({ origin: 'https://example.com' }).site!.id
    expect(subject.remove(first)).toBe(true)
    const second = subject.add({ origin: 'https://example.com' }).site!.id
    expect(second).not.toBe(first)
  })

  it('retires ids across store instances', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-web-login-'))
    tempDirs.push(dir)
    const first = new WebSiteLoginStore({ userDataPath: dir })
    const id = first.add({ origin: 'https://example.com' }).site!.id
    first.remove(id)
    const reopened = new WebSiteLoginStore({ userDataPath: dir })
    expect(reopened.add({ origin: 'https://example.com' }).site!.id).not.toBe(id)
  })

  it('stamps lastSignedInAt only when the status is signed-in', () => {
    const subject = store()
    const id = subject.add({ origin: 'https://example.com' }).site!.id
    expect(subject.setStatus(id, 'expired')?.lastSignedInAt).toBeUndefined()
    expect(subject.setStatus(id, 'signed-in')?.lastSignedInAt).toBe('2026-08-29T00:00:00.000Z')
  })

  it('writes the catalogue owner-readable only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-web-login-'))
    tempDirs.push(dir)
    new WebSiteLoginStore({ userDataPath: dir }).add({ origin: 'https://example.com' })
    const mode = fs.statSync(path.join(dir, 'web-site-logins.json')).mode & 0o777
    expect(mode).toBe(0o600)
  })
})
