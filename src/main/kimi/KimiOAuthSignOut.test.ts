import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { signOutKimiOAuth } from './KimiOAuthSignOut'

// Only ever removes roots this suite created with mkdtemp.
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

const GLOBAL_SLOT = 'kimi-code-env-0e4f99c69cc27850'
const GLOBAL_CONFIG = [
  '[providers."managed:kimi-code"]',
  'type = "kimi"',
  'api_key = ""',
  '',
  '[providers."managed:kimi-code".oauth]',
  'storage = "file"',
  `key = "oauth/${GLOBAL_SLOT}"`
].join('\n')

async function kimiHome(config: string | null): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'tw-kimi-signout-'))
  roots.push(root)
  await fs.mkdir(join(root, 'credentials'), { mode: 0o700 })
  await fs.mkdir(join(root, 'oauth'), { mode: 0o700 })
  if (config !== null) await fs.writeFile(join(root, 'config.toml'), config)
  return root
}

async function exists(path: string): Promise<boolean> {
  return fs.lstat(path).then(
    () => true,
    () => false
  )
}

describe('signOutKimiOAuth', () => {
  it('removes only the OAuth slot config.toml binds the managed provider to', async () => {
    const home = await kimiHome(GLOBAL_CONFIG)
    const slot = join(home, 'credentials', `${GLOBAL_SLOT}.json`)
    const other = join(home, 'credentials', 'kimi-code.json')
    await fs.writeFile(slot, '{}', { mode: 0o600 })
    await fs.writeFile(other, '{}', { mode: 0o600 })
    await fs.writeFile(join(home, 'oauth', GLOBAL_SLOT), '')

    await expect(signOutKimiOAuth({ sourceHome: home })).resolves.toEqual({
      ok: true,
      removed: true,
      credentialFileName: `${GLOBAL_SLOT}.json`
    })
    expect(await exists(slot)).toBe(false)
    expect(await exists(other)).toBe(true)
    expect(await exists(join(home, 'config.toml'))).toBe(true)
    expect(await exists(join(home, 'oauth', GLOBAL_SLOT))).toBe(true)
  })

  it('signs out the default slot when config.toml names none', async () => {
    const home = await kimiHome(null)
    const slot = join(home, 'credentials', 'kimi-code.json')
    await fs.writeFile(slot, '{}', { mode: 0o600 })

    await expect(signOutKimiOAuth({ sourceHome: home })).resolves.toMatchObject({
      ok: true,
      removed: true,
      credentialFileName: 'kimi-code.json'
    })
    expect(await exists(slot)).toBe(false)
  })

  it('is idempotent when no token is stored', async () => {
    const home = await kimiHome(GLOBAL_CONFIG)
    await expect(signOutKimiOAuth({ sourceHome: home })).resolves.toEqual({
      ok: true,
      removed: false,
      credentialFileName: `${GLOBAL_SLOT}.json`
    })
  })

  it.skipIf(process.platform === 'win32')(
    'refuses to unlink a symlinked credential and leaves its target intact',
    async () => {
      const home = await kimiHome(GLOBAL_CONFIG)
      const target = join(home, 'elsewhere.json')
      await fs.writeFile(target, '{}', { mode: 0o600 })
      const slot = join(home, 'credentials', `${GLOBAL_SLOT}.json`)
      await fs.symlink(target, slot)

      await expect(signOutKimiOAuth({ sourceHome: home })).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/not a regular file/)
      })
      expect(await exists(slot)).toBe(true)
      expect(await exists(target)).toBe(true)
    }
  )

  it('refuses an unrecognised slot without removing anything', async () => {
    const home = await kimiHome('[providers."managed:kimi-code".oauth]\nkey = "oauth/../config"\n')
    await expect(signOutKimiOAuth({ sourceHome: home })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/does not recognise/)
    })
    expect(await exists(join(home, 'config.toml'))).toBe(true)
  })
})
