import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { GenericProvider } = require('electron-updater/out/providers/GenericProvider')
const yaml = require('js-yaml')
const { RELEASE_FEED_BASE_URL } = require('./prepare-release-update-feed.cjs')

afterEach(() => vi.unstubAllEnvs())

describe('real electron-updater Release feed isolation', () => {
  it('validates actual builder inheritance without leftover GitHub publish metadata', async () => {
    const { getConfig, validateConfiguration } = require('app-builder-lib/out/util/config/config')
    const { DebugLogger } = require('builder-util')
    for (const name of ['electron-builder.release.yml', 'electron-builder.debut.yml']) {
      const config = await getConfig(process.cwd(), name)
      await validateConfiguration(config, new DebugLogger())
      expect(config.publish).toEqual([
        {
          provider: 'generic',
          url: RELEASE_FEED_BASE_URL,
          channel: 'release',
          useMultipleRangeRequest: false
        }
      ])
      expect(config.extraMetadata.taskwraithDistributionIdentity).toBe('release')
      expect(config.extraMetadata.taskwraithAppId).toBe('com.taskwraith.desktop')
      expect(config.extraMetadata.taskwraithUpdateFeedChannel).toBe('release')
      expect(config.extraMetadata.version).toBe(name.includes('debut') ? '0.1.0' : undefined)
    }
  })
  it.each([
    ['darwin', 'arm64', 'release', 'release-mac.yml', 'universal-mac.zip'],
    ['win32', 'x64', 'release-win-x64', 'release-win-x64.yml', 'win-x64-setup.exe'],
    ['win32', 'arm64', 'release-win-arm64', 'release-win-arm64.yml', 'win-arm64-setup.exe'],
    ['linux', 'x64', 'release', 'release-linux.yml', '.AppImage']
  ])(
    'discovers %s %s without consulting GitHub Latest and preserves immutable downloads',
    async (platform, arch, channel, filename, suffix) => {
      vi.stubEnv('TEST_UPDATER_ARCH', arch)
      const installerName = suffix.startsWith('.')
        ? `TaskWraith-0.1.1${suffix}`
        : `TaskWraith-0.1.1-${suffix}`
      const installer = `https://github.com/boggspa/TaskWraith/releases/download/v0.1.1/${installerName}`
      const request = vi.fn(async (options: { hostname: string; path: string }) => {
        expect(options.hostname).toBe('taskwraith.dev')
        expect(options.path).toBe(`/updates/release/${filename}`)
        return yaml.dump({
          version: '0.1.1',
          files: [{ url: installer, sha512: 'fixture', size: 100 }],
          path: installer,
          sha512: 'fixture'
        })
      })
      const provider = new GenericProvider(
        { provider: 'generic', url: RELEASE_FEED_BASE_URL, channel },
        { channel, isAddNoCacheQuery: false },
        { platform, isUseMultipleRangeRequest: false, executor: { request } }
      )
      const info = await provider.getLatestVersion()
      expect(info.version).toBe('0.1.1')
      expect(provider.resolveFiles(info)[0].url.href).toBe(installer)
      expect(request).toHaveBeenCalledTimes(1)
      expect(provider.isUseMultipleRangeRequest).toBe(false)
      if (platform !== 'linux') {
        expect(
          provider
            .getBlockMapFiles(new URL(installer), '0.1.0', '0.1.1')
            .map((url: URL) => url.href)
        ).toEqual([installer.replaceAll('0.1.1', '0.1.0') + '.blockmap', installer + '.blockmap'])
      }
    }
  )

  it('documents Linux arm64 protocol resolution only; packaging inventory does not ship it', () => {
    vi.stubEnv('TEST_UPDATER_ARCH', 'arm64')
    const provider = new GenericProvider(
      { provider: 'generic', url: RELEASE_FEED_BASE_URL, channel: 'release' },
      { channel: 'release' },
      { platform: 'linux', executor: {} }
    )
    expect(provider.channel).toBe('release-linux-arm64')
    const { releaseInventory } = require('./prepare-release-update-feed.cjs')
    expect(releaseInventory('0.1.0')).not.toHaveProperty('release-linux-arm64.yml')
  })

  it('keeps reusable Release config independent from the frozen beta and debut version', () => {
    const read = (name: string) =>
      yaml.load(fs.readFileSync(path.join(process.cwd(), name), 'utf8'))
    const release = read('electron-builder.release.yml')
    const debut = read('electron-builder.debut.yml')
    expect(release.publish).toEqual([
      {
        provider: 'generic',
        url: RELEASE_FEED_BASE_URL,
        channel: 'release',
        useMultipleRangeRequest: false
      }
    ])
    expect(release.appId).toBe('com.taskwraith.desktop')
    expect(release.extraMetadata).toEqual({
      taskwraithDistributionIdentity: 'release',
      taskwraithAppId: 'com.taskwraith.desktop',
      taskwraithUpdateFeedChannel: 'release'
    })
    expect(debut.extends).toBe('electron-builder.release.yml')
    expect(debut.extraMetadata).toEqual({ version: '0.1.0' })
    expect(read('electron-builder.yml').publish.provider).toBe('github')
  })
})
