import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { createPackage } = require('@electron/asar')
const { verifyInstalledWindows } = require('./verify-installed-windows.cjs')
const roots: string[] = []
const expected = {
  version: '0.1.0',
  appId: 'com.taskwraith.desktop',
  distributionIdentity: 'release',
  updateFeedChannel: 'release',
  config: {
    publish: [
      { provider: 'generic', url: 'https://taskwraith.dev/updates/release/', channel: 'release' }
    ]
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

async function fixture(overrides: Record<string, unknown> = {}, staleFeed = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-installed-identity-'))
  roots.push(root)
  const source = path.join(root, 'source')
  const resources = path.join(root, 'resources')
  fs.mkdirSync(source)
  fs.mkdirSync(resources)
  fs.writeFileSync(
    path.join(source, 'package.json'),
    JSON.stringify({
      version: expected.version,
      taskwraithAppId: expected.appId,
      taskwraithDistributionIdentity: expected.distributionIdentity,
      taskwraithUpdateFeedChannel: expected.updateFeedChannel,
      ...overrides
    })
  )
  await createPackage(source, path.join(resources, 'app.asar'))
  fs.writeFileSync(
    path.join(resources, 'app-update.yml'),
    staleFeed
      ? 'provider: github\nowner: boggspa\nrepo: TaskWraith\n'
      : 'provider: generic\nurl: https://taskwraith.dev/updates/release/\nchannel: release\n'
  )
  return root
}

describe('installed Windows identity', () => {
  it('reads the actual installed archive and update feed', async () => {
    const installDir = await fixture()
    expect(verifyInstalledWindows({ installDir, expected, productVersion: '0.1.0' })).toEqual({
      version: '0.1.0',
      appId: 'com.taskwraith.desktop',
      distribution: 'release',
      feed: 'release'
    })
  })

  it('rejects a no-op replacement that left the beta executable', async () => {
    const installDir = await fixture()
    expect(() => verifyInstalledWindows({ installDir, expected, productVersion: '1.9.9' })).toThrow(
      'executable version'
    )
  })

  it.each([
    { version: '1.9.9' },
    { taskwraithAppId: 'com.chrisizatt.taskwraith' },
    { taskwraithDistributionIdentity: 'beta' },
    { taskwraithUpdateFeedChannel: 'latest' }
  ])('rejects stale installed package metadata %j', async (overrides) => {
    const installDir = await fixture(overrides)
    expect(() => verifyInstalledWindows({ installDir, expected, productVersion: '0.1.0' })).toThrow(
      'does not match'
    )
  })

  it('rejects an installed public package still using beta discovery', async () => {
    const installDir = await fixture({}, true)
    expect(() => verifyInstalledWindows({ installDir, expected, productVersion: '0.1.0' })).toThrow(
      'update feed provider'
    )
  })
})
