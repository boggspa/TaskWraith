import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createIdentityHandoffBootstrap,
  reconcileReleaseIdentityUpdateChannel
} from './IdentityHandoffBootstrap'
import {
  IDENTITY_HANDOFF_ID,
  IDENTITY_HANDOFF_STATE_DIR,
  type IdentityHandoffManifest
} from './IdentityHandoffService'
import { resolveInstanceLaunchPosture } from './InstanceLaunchPosture'

const roots: string[] = []
const bytes = Buffer.from('synthetic installer fixture; never executable or signed')
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex')
const fileName = 'TaskWraith-0.1.0-universal-mac.dmg'
const manifest: IdentityHandoffManifest = {
  schemaVersion: 1,
  handoffId: IDENTITY_HANDOFF_ID,
  prepared: true,
  sourceCommit: 'a'.repeat(40),
  source: {
    distributionIdentity: 'beta',
    appId: 'com.chrisizatt.taskwraith',
    version: '1.9.9',
    updateFeedChannel: 'latest'
  },
  target: {
    distributionIdentity: 'release',
    appId: 'com.taskwraith.desktop',
    version: '0.1.0',
    updateFeedChannel: 'release'
  },
  supportUrl: 'https://github.com/boggspa/TaskWraith/releases/tag/v0.1.0',
  artifacts: Object.fromEntries(
    [
      ['darwin-universal', 'darwin', 'universal', fileName, 'dmg'],
      ['win32-x64', 'win32', 'x64', 'TaskWraith-0.1.0-win-x64-setup.exe', 'nsis'],
      ['win32-arm64', 'win32', 'arm64', 'TaskWraith-0.1.0-win-arm64-setup.exe', 'nsis'],
      ['linux-x64', 'linux', 'x64', 'TaskWraith-0.1.0.AppImage', 'appimage']
    ].map(([key, platform, arch, name, launchKind]) => [
      key,
      {
        platform,
        arch,
        fileName: name,
        launchKind,
        size: bytes.length,
        sha256: hash(bytes),
        url: `https://github.com/boggspa/TaskWraith/releases/download/v0.1.0/${name}`,
        instructions: 'Synthetic unit fixture only.'
      }
    ])
  ) as IdentityHandoffManifest['artifacts']
}

afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function inventory(root: string, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {}
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) Object.assign(result, inventory(root, relative))
    else result[relative] = hash(readFileSync(join(root, relative)))
  }
  return result
}

describe('identity handoff opaque profile preservation', () => {
  it.each([32, 64])('retains an isolated Linux profile (%i)', async (length) => {
    vi.useFakeTimers()
    const appDataPath = mkdtempSync(join(tmpdir(), 'handoff-isolated-profile-'))
    roots.push(appDataPath)
    const selector = `--taskwraith-isolated-instance=${'a'.repeat(length)}`
    const launchPosture = resolveInstanceLaunchPosture({
      isPackaged: true,
      argv: ['TaskWraith', selector, '--remote-debugging-port=9222'],
      appDataPath
    })
    if (launchPosture.kind !== 'packaged-isolated') throw new Error('Invalid test posture')
    const userDataPath = launchPosture.userDataPath
    mkdirSync(userDataPath, { recursive: true })
    writeFileSync(join(userDataPath, 'chats.json'), 'opaque isolated chat fixture')
    const relaunch = vi.fn()
    const quit = vi.fn()
    const beta = createIdentityHandoffBootstrap({
      appPath: '/synthetic/app.asar',
      currentVersion: '1.9.9',
      userDataPath,
      manifest,
      platform: 'linux',
      arch: 'x64',
      launchPosture,
      relaunch,
      quit,
      fetcher: async () => {
        let sent = false
        return {
          ok: true,
          status: 200,
          url: 'https://objects.githubusercontent.com/synthetic',
          headers: { get: () => null },
          body: {
            getReader: () => ({
              read: async () =>
                sent ? { done: true } : ((sent = true), { done: false, value: bytes })
            })
          }
        }
      },
      readPackageText: () =>
        JSON.stringify({
          taskwraithDistributionIdentity: 'beta',
          taskwraithAppId: 'com.chrisizatt.taskwraith',
          taskwraithUpdateFeedChannel: 'latest'
        })
    })
    await expect(beta.service?.download()).resolves.toMatchObject({ phase: 'downloaded' })
    expect(beta.service?.launch()).toBe(true)
    expect(relaunch).toHaveBeenCalledExactlyOnceWith({
      execPath: expect.stringContaining('TaskWraith-0.1.0.AppImage'),
      args: ['--appimage-extract-and-run', selector]
    })
    const targetPosture = resolveInstanceLaunchPosture({
      isPackaged: true,
      argv: relaunch.mock.calls[0][0].args,
      appDataPath
    })
    expect(targetPosture).toEqual(launchPosture)
    expect(quit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(250)
    expect(quit).toHaveBeenCalledOnce()
    const release = createIdentityHandoffBootstrap({
      appPath: '/synthetic/release/app.asar',
      currentVersion: '0.1.0',
      userDataPath,
      manifest,
      platform: 'linux',
      arch: 'x64',
      fetcher: vi.fn(),
      quit: vi.fn(),
      readPackageText: () =>
        JSON.stringify({
          taskwraithDistributionIdentity: 'release',
          taskwraithAppId: 'com.taskwraith.desktop',
          taskwraithUpdateFeedChannel: 'release'
        })
    })
    expect(release.service?.snapshot()).toMatchObject({ phase: 'complete' })
    expect(readFileSync(join(userDataPath, 'chats.json'), 'utf8')).toBe(
      'opaque isolated chat fixture'
    )
  })

  it.each([false, true])(
    'preserves the profile through installer failure/retry=%s and target relaunch',
    async (failFirst) => {
      vi.useFakeTimers()
      const root = mkdtempSync(join(tmpdir(), 'handoff-preservation-'))
      roots.push(root)
      const opaquePaths = [
        'chats/chat.json',
        'journals/chat.jsonl',
        'pairing/identity.bin',
        'audit/key.bin',
        'secrets/encrypted.bin',
        'media/clip.bin',
        'canvas/artifact.bin',
        'Browser/Default/Preferences'
      ]
      for (const relative of opaquePaths) {
        mkdirSync(dirname(join(root, relative)), { recursive: true })
        writeFileSync(
          join(root, relative),
          Buffer.from(`opaque-preservation-fixture:${relative}\0\xff`, 'latin1')
        )
      }
      const settingsPath = join(root, 'settings.json')
      writeFileSync(
        settingsPath,
        JSON.stringify({
          updateChannel: 'nightly',
          unrelated: 'preserve',
          encryptedSecret: 'opaque'
        })
      )
      const before = inventory(root)
      const quit = vi.fn()
      const installer = vi.fn((): { ok: boolean; error?: string } => ({ ok: true }))
      if (failFirst) installer.mockImplementationOnce(() => ({ ok: false, error: 'stub refusal' }))
      const fetcher = vi.fn(async () => {
        let sent = false
        return {
          ok: true,
          status: 200,
          url: 'https://objects.githubusercontent.com/synthetic',
          headers: { get: () => null },
          body: {
            getReader: () => ({
              read: async () =>
                sent ? { done: true } : ((sent = true), { done: false, value: bytes })
            })
          }
        }
      })
      const bootstrap = (release: boolean) =>
        createIdentityHandoffBootstrap({
          appPath: '/synthetic/app.asar',
          currentVersion: release ? '0.1.0' : '1.9.9',
          userDataPath: root,
          manifest,
          platform: 'darwin',
          arch: 'arm64',
          fetcher,
          quit,
          launchInstaller: installer,
          readPackageText: () =>
            JSON.stringify({
              taskwraithDistributionIdentity: release ? 'release' : 'beta',
              taskwraithAppId: release ? 'com.taskwraith.desktop' : 'com.chrisizatt.taskwraith',
              taskwraithUpdateFeedChannel: release ? 'release' : 'latest'
            })
        })
      const source = bootstrap(false).service!
      expect((await source.download()).phase).toBe('downloaded')
      if (failFirst) {
        expect(source.launch()).toBe(false)
        expect(source.snapshot().errorCode).toBe('installer-launch-failed')
        expect(quit).not.toHaveBeenCalled()
        expect((await source.retry()).phase).toBe('downloaded')
      }
      expect(source.launch()).toBe(true)
      await vi.advanceTimersByTimeAsync(250)
      expect(quit).toHaveBeenCalledTimes(1)
      const target = bootstrap(true)
      expect(target.service!.snapshot().phase).toBe('complete')
      const readSettings = () => JSON.parse(readFileSync(settingsPath, 'utf8'))
      const normalize = vi.fn((channel: 'stable') =>
        writeFileSync(settingsPath, JSON.stringify({ ...readSettings(), updateChannel: channel }))
      )
      reconcileReleaseIdentityUpdateChannel(target, readSettings(), normalize, readSettings)
      expect(readSettings()).toEqual({
        updateChannel: 'stable',
        unrelated: 'preserve',
        encryptedSecret: 'opaque'
      })
      const after = inventory(root)
      expect(Object.keys(after).sort()).toEqual(
        [...Object.keys(before), `${IDENTITY_HANDOFF_STATE_DIR}/state.json`].sort()
      )
      for (const relative of opaquePaths) expect(after[relative]).toBe(before[relative])
      expect(readFileSync(join(root, IDENTITY_HANDOFF_STATE_DIR, 'state.json'), 'utf8')).toContain(
        '"phase": "complete"'
      )
      const relaunched = bootstrap(true)
      reconcileReleaseIdentityUpdateChannel(relaunched, readSettings(), normalize, readSettings)
      expect(inventory(root)).toEqual(after)
      expect(normalize).toHaveBeenCalledTimes(1)
      expect(installer).toHaveBeenCalledTimes(failFirst ? 2 : 1)
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  )
})
