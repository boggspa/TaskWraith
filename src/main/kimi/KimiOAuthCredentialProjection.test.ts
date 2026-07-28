import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareKimiOAuthCredentialProjection } from './KimiOAuthCredentialProjection'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function privateDirectory(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true, mode: 0o700 })
  await fs.chmod(path, 0o700)
}

async function privateFile(path: string, value: string): Promise<void> {
  await fs.writeFile(path, value, { encoding: 'utf8', mode: 0o600 })
  await fs.chmod(path, 0o600)
}

async function fixture(): Promise<{
  root: string
  sourceHome: string
  boundaryRoot: string
  homeA: string
  homeB: string
  credential: string
}> {
  const root = await fs.mkdtemp(join(tmpdir(), 'tw-kimi-oauth-projection-'))
  roots.push(root)
  await fs.chmod(root, 0o700)
  const sourceHome = join(root, 'source')
  const boundaryRoot = join(root, 'seats')
  const homeA = join(boundaryRoot, 'a')
  const homeB = join(boundaryRoot, 'b')
  const credential = join(sourceHome, 'credentials', 'kimi-code.json')
  await Promise.all([
    privateDirectory(join(sourceHome, 'credentials')),
    privateDirectory(join(sourceHome, 'oauth')),
    privateDirectory(homeA),
    privateDirectory(homeB)
  ])
  await Promise.all([
    privateFile(credential, JSON.stringify({ expires_at: 1_000, refresh_token: 'r0' })),
    privateFile(join(sourceHome, 'device_id'), 'device-1')
  ])
  return { root, sourceHome, boundaryRoot, homeA, homeB, credential }
}

describe('prepareKimiOAuthCredentialProjection', () => {
  it('lets independent seats share Kimi’s credential store and refresh lock', async () => {
    const f = await fixture()
    await Promise.all([
      prepareKimiOAuthCredentialProjection({
        sourceHome: f.sourceHome,
        boundaryRoot: f.boundaryRoot,
        isolatedHome: f.homeA
      }),
      prepareKimiOAuthCredentialProjection({
        sourceHome: f.sourceHome,
        boundaryRoot: f.boundaryRoot,
        isolatedHome: f.homeB
      })
    ])

    const [sourceCredentials, sourceOAuth, seatACredentials, seatBOAuth, device] =
      await Promise.all([
        fs.realpath(join(f.sourceHome, 'credentials')),
        fs.realpath(join(f.sourceHome, 'oauth')),
        fs.realpath(join(f.homeA, 'credentials')),
        fs.realpath(join(f.homeB, 'oauth')),
        fs.lstat(join(f.homeA, 'device_id'))
      ])
    expect(seatACredentials).toBe(sourceCredentials)
    expect(seatBOAuth).toBe(sourceOAuth)
    expect(device.isFile()).toBe(true)
    expect(device.isSymbolicLink()).toBe(false)

    // Kimi's file-backed token storage first mkdirs its credentials root; the
    // projection must remain a usable directory for that normal code path.
    await fs.mkdir(join(f.homeA, 'credentials'), { recursive: true })

    const rotated = JSON.stringify({ expires_at: 2_000, refresh_token: 'r1' })
    await fs.writeFile(join(f.homeA, 'credentials', 'kimi-code.json'), rotated, {
      encoding: 'utf8',
      mode: 0o600
    })
    await expect(fs.readFile(f.credential, 'utf8')).resolves.toBe(rotated)
    await expect(fs.readFile(join(f.homeB, 'credentials', 'kimi-code.json'), 'utf8')).resolves.toBe(
      rotated
    )

    const lockPath = join(f.homeA, 'oauth', 'kimi-code.lock')
    await fs.mkdir(lockPath, { mode: 0o700 })
    await expect(fs.lstat(join(f.sourceHome, 'oauth', 'kimi-code.lock'))).resolves.toBeDefined()
    await expect(fs.lstat(join(f.homeB, 'oauth', 'kimi-code.lock'))).resolves.toBeDefined()

    await fs.rm(f.homeA, { recursive: true, force: true })
    await expect(fs.readFile(f.credential, 'utf8')).resolves.toBe(rotated)
    await expect(fs.lstat(join(f.sourceHome, 'oauth', 'kimi-code.lock'))).resolves.toBeDefined()
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a credential symlink from the real Kimi home',
    async () => {
      const f = await fixture()
      const foreign = join(f.root, 'foreign-token.json')
      await privateFile(foreign, JSON.stringify({ expires_at: 1_000, refresh_token: 'foreign' }))
      await fs.unlink(f.credential)
      await fs.symlink(foreign, f.credential, 'file')

      await expect(
        prepareKimiOAuthCredentialProjection({
          sourceHome: f.sourceHome,
          boundaryRoot: f.boundaryRoot,
          isolatedHome: f.homeA
        })
      ).rejects.toThrow('Could not prepare shared Kimi OAuth credentials')
      await expect(fs.lstat(join(f.homeA, 'credentials'))).rejects.toThrow()
    }
  )
})
